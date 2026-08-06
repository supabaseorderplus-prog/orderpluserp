import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, getUserFromToken, resolveCompanyScope } from "@/lib/supabase-server";

type DbError = { code?: string; message?: string } | null | undefined;

interface VisitRow {
  id: string;
  party_id: string;
  party_name: string;
  party_code: string | null;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  check_in_time: string | null;
  check_out_time: string | null;
  is_within_geofence: boolean | null;
  deviation_meters: number | null;
  notes: string | null;
  source: "checkin" | "manual";
}

// Manual logs without a check-in within this window of an existing geofenced
// visit to the same party are treated as the same visit and skipped.
const DEDUPE_WINDOW_MS = 30 * 60 * 1000;

function isSchemaGap(error: DbError): boolean {
  if (!error) return false;
  const msg = String(error.message || "").toLowerCase();
  return (
    error.code === "42P01" || // undefined_table
    error.code === "42703" || // undefined_column
    error.code === "PGRST200" ||
    error.code === "PGRST204" ||
    error.code === "PGRST205" ||
    msg.includes("does not exist") ||
    msg.includes("schema cache") ||
    msg.includes("could not find")
  );
}

function timeMs(iso: string | null): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : null;
}

// GET /api/v1/tracking/visits?salesman_id=xxx&date=2026-06-06
// Returns the parties a field user visited on a given date, merging two sources:
//   1. party_visits      — geofenced check-ins (verified "was on-site")
//   2. party_visit_logs  — manual visit logs filed per-party (self-reported)
// Each row is tagged with `source` so the UI can distinguish verified from
// manual. Used by the live-tracking detail panel.
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const salesmanId = searchParams.get("salesman_id");
    const date = searchParams.get("date") || new Date().toISOString().split("T")[0];

    if (!salesmanId) {
      return NextResponse.json({ error: "salesman_id required" }, { status: 400 });
    }

    const authUser = await getUserFromToken(req);
    const companyId = await resolveCompanyScope(req, authUser);
    if (!companyId) {
      return NextResponse.json({ error: "Unauthorized: no company scope" }, { status: 403 });
    }

    // ── 1. Geofenced check-ins ────────────────────────────────────────────────
    // Fall back through column variants so a missing optional column never
    // zeroes out the whole list.
    const visitSelects = [
      "id, party_id, route_id, visit_date, check_in_time, check_out_time, check_in_lat, check_in_lng, is_within_geofence, deviation_meters, notes, company_id",
      "id, party_id, route_id, visit_date, check_in_time, check_out_time, is_within_geofence, deviation_meters, notes",
      "id, party_id, visit_date, check_in_time, check_out_time",
      "id, party_id, visit_date, check_in_time",
    ];

    let checkins: Record<string, unknown>[] = [];
    let lastErr: DbError = null;
    let checkinsOk = false;
    for (const cols of visitSelects) {
      const q = await supabaseAdmin
        .from("party_visits")
        .select(cols)
        .eq("salesman_id", salesmanId)
        .eq("visit_date", date)
        .order("check_in_time", { ascending: true });

      if (!q.error) {
        checkins = (q.data as unknown as Record<string, unknown>[]) ?? [];
        checkinsOk = true;
        break;
      }
      lastErr = q.error;
      if (!isSchemaGap(q.error)) break;
    }
    if (!checkinsOk && lastErr && !isSchemaGap(lastErr)) {
      console.error("[tracking/visits] check-in query error:", lastErr.message, lastErr.code);
    }

    // Company isolation: keep rows tagged to this company; tolerate legacy rows
    // where company_id was never set (the salesman is already company-scoped at
    // the dashboard level).
    const scopedCheckins = checkins.filter((v) => {
      const cid = v.company_id;
      return cid == null || cid === companyId;
    });

    // ── 2. Manual visit logs ──────────────────────────────────────────────────
    // visit_date is a full timestamp; bound it to the requested calendar day
    // (UTC) so it lines up with how party_visits derives its date string.
    const dayStart = `${date}T00:00:00.000Z`;
    const dayEnd = new Date(new Date(`${date}T00:00:00.000Z`).getTime() + 24 * 60 * 60 * 1000).toISOString();

    let manualLogs: Record<string, unknown>[] = [];
    const logSelects = [
      "id, party_id, visited_by, visit_date, notes",
      "id, party_id, visited_by, visit_date",
    ];
    for (const cols of logSelects) {
      const q = await supabaseAdmin
        .from("party_visit_logs")
        .select(cols)
        .eq("visited_by", salesmanId)
        .gte("visit_date", dayStart)
        .lt("visit_date", dayEnd)
        .order("visit_date", { ascending: true });

      if (!q.error) {
        manualLogs = (q.data as unknown as Record<string, unknown>[]) ?? [];
        break;
      }
      if (!isSchemaGap(q.error)) {
        console.warn("[tracking/visits] manual log query error:", q.error.message);
        break;
      }
      // schema gap (e.g. table missing) — treat as no manual logs
    }

    // ── Party lookup (covers both sources) ────────────────────────────────────
    const partyIds = [
      ...new Set(
        [
          ...scopedCheckins.map((v) => v.party_id as string),
          ...manualLogs.map((l) => l.party_id as string),
        ].filter(Boolean)
      ),
    ];
    const partyMap: Record<string, Record<string, unknown>> = {};
    if (partyIds.length > 0) {
      const partySelects = [
        "id, name, party_code, address_line1, city, latitude, longitude",
        "id, name, party_code, city, latitude, longitude",
        "id, name, party_code, city",
        "id, name, party_code",
        "id, name",
      ];
      for (const cols of partySelects) {
        const { data, error } = await supabaseAdmin
          .from("parties")
          .select(cols)
          .in("id", partyIds);
        if (!error) {
          for (const p of (data || []) as unknown as Record<string, unknown>[]) {
            partyMap[p.id as string] = p;
          }
          break;
        }
        if (!isSchemaGap(error)) {
          console.warn("[tracking/visits] party lookup error:", error.message);
          break;
        }
      }
    }

    const buildParty = (partyId: string) => {
      const p = partyMap[partyId] || null;
      return {
        party_name: (p?.name as string) || "Unknown Party",
        party_code: (p?.party_code as string) || null,
        address: [p?.address_line1, p?.city].filter(Boolean).join(", ") || null,
        latitude: (p?.latitude as number) ?? null,
        longitude: (p?.longitude as number) ?? null,
      };
    };

    // ── Map check-ins ─────────────────────────────────────────────────────────
    const checkinRows: VisitRow[] = scopedCheckins.map((v) => {
      const party = buildParty(v.party_id as string);
      return {
        id: v.id as string,
        party_id: v.party_id as string,
        ...party,
        latitude: party.latitude ?? (v.check_in_lat as number) ?? null,
        longitude: party.longitude ?? (v.check_in_lng as number) ?? null,
        check_in_time: (v.check_in_time as string) ?? null,
        check_out_time: (v.check_out_time as string) ?? null,
        is_within_geofence: (v.is_within_geofence as boolean) ?? null,
        deviation_meters: (v.deviation_meters as number) ?? null,
        notes: (v.notes as string) ?? null,
        source: "checkin",
      };
    });

    // ── Map manual logs, skipping those that duplicate a check-in ─────────────
    const checkinIndex = checkinRows
      .map((c) => ({ party_id: c.party_id, t: timeMs(c.check_in_time) }))
      .filter((c) => c.t != null) as { party_id: string; t: number }[];

    const manualRows: VisitRow[] = [];
    for (const log of manualLogs) {
      const partyId = log.party_id as string;
      const logT = timeMs(log.visit_date as string);
      const duplicatesCheckin =
        logT != null &&
        checkinIndex.some(
          (c) => c.party_id === partyId && Math.abs(c.t - logT) <= DEDUPE_WINDOW_MS
        );
      if (duplicatesCheckin) continue;

      const party = buildParty(partyId);
      manualRows.push({
        id: log.id as string,
        party_id: partyId,
        ...party,
        check_in_time: (log.visit_date as string) ?? null,
        check_out_time: null,
        is_within_geofence: null,
        deviation_meters: null,
        notes: (log.notes as string) ?? null,
        source: "manual",
      });
    }

    // ── Merge + sort by visit time ────────────────────────────────────────────
    const merged = [...checkinRows, ...manualRows].sort((a, b) => {
      const ta = timeMs(a.check_in_time) ?? 0;
      const tb = timeMs(b.check_in_time) ?? 0;
      return ta - tb;
    });

    return NextResponse.json({ data: merged });
  } catch (err) {
    console.error("[tracking/visits] crash:", err);
    return NextResponse.json({ data: [] });
  }
}
