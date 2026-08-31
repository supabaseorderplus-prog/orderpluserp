import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, getUserFromToken, resolveCompanyScope, getPartyDescendants } from "@/lib/supabase-server";
import { IN_FILTER_MAX_IDS, fetchAllInChunks } from "@/lib/supabase-in-chunks";
import { normalizeCoordinates } from "@/lib/location-coordinates";
import { istToday } from "@/lib/datetime";
import { previousSessionNotes } from "@/lib/duty-signoff";
import { parseDutyOdometerEvidence } from "@/lib/odometer-reading";
import { attachOdometerPhotoUrls } from "@/lib/odometer-photo-server";

type SupabaseError = { code?: string; message?: string } | null | undefined;

type SalesmanRow = { id: string; name: string; email: string | null; phone: string | null; party_id: string | null };

function isMissingUsersTable(err: SupabaseError): boolean {
  return !!err && (err.code === "PGRST205" || !!err.message?.includes("Could not find the table 'public.users'"));
}

function sessionLocationFallback(session: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!session) return null;

  const isActive = session.status === "active";
  const lat = isActive ? session.check_in_lat : (session.check_out_lat ?? session.check_in_lat);
  const lng = isActive ? session.check_in_lng : (session.check_out_lng ?? session.check_in_lng);
  const recordedAt = isActive ? session.check_in_time : (session.check_out_time ?? session.check_in_time);

  const coordinates = normalizeCoordinates(lat, lng);
  if (!coordinates || !recordedAt) return null;

  return {
    id: `${session.id || session.salesman_id}-session-location`,
    salesman_id: session.salesman_id,
    ...coordinates,
    accuracy: null,
    battery_level: null,
    recorded_at: recordedAt,
    activity: isActive ? "check_in" : "checked_out",
    note: isActive ? "Duty check-in location" : "Duty checkout location",
  };
}

async function hydrateOdometerSession(row: Record<string, unknown>) {
  const evidence = parseDutyOdometerEvidence(previousSessionNotes(row.notes as string | null | undefined));
  const hydrated = evidence ? {
    ...row,
    start_odometer_km: row.start_odometer_km ?? evidence.start.reading,
    end_odometer_km: row.end_odometer_km ?? evidence.end?.reading ?? null,
    odometer_distance_km: row.odometer_distance_km ?? evidence.distance_km,
    start_odometer_photo_path: row.start_odometer_photo_path ?? evidence.start.photo_path,
    end_odometer_photo_path: row.end_odometer_photo_path ?? evidence.end?.photo_path ?? null,
  } : row;
  return attachOdometerPhotoUrls(hydrated);
}

async function fetchSalesmenFromTable(
  table: "users" | "app_users",
  roleId: string,
  partyIds: string[]
): Promise<{ data: SalesmanRow[] | null; error: SupabaseError }> {
  const buildQuery = (chunk: string[] | null) => {
    let q = supabaseAdmin
      .from(table)
      .select("id, name, email, phone, party_id")
      .eq("role_id", roleId)
      .eq("status", "ACTIVE")
      .order("name");
    if (chunk) q = q.in("party_id", chunk) as typeof q;
    return q;
  };

  // Large company trees overflow PostgREST's URL header limit when passed to a
  // single .in() filter (the request dies with "Bad Request" before reaching the
  // DB), which silently emptied the salesmen list for big companies. Split the
  // scope into chunked queries and merge. Merged chunks lose the per-query
  // ORDER BY, so re-sort by name.
  if (partyIds.length > IN_FILTER_MAX_IDS) {
    const { data, error } = await fetchAllInChunks<SalesmanRow>(partyIds, (chunk) => buildQuery(chunk));
    const sorted = data
      ? [...data].sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")))
      : null;
    return { data: sorted, error };
  }

  const res = await buildQuery(partyIds.length > 0 ? partyIds : null);
  return { data: (res.data as SalesmanRow[] | null) ?? null, error: res.error };
}

// GET /api/v1/tracking/salesmen — list salesmen for the caller's company only
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const date = searchParams.get("date") || istToday();

    const authUser = await getUserFromToken(req);
    const companyId = await resolveCompanyScope(req, authUser);

    if (!companyId) {
      return NextResponse.json({ error: "Unauthorized: no company scope" }, { status: 403 });
    }

    // Build party hierarchy for company scoping. Use the BFS helper rather than
    // the raw get_party_descendants RPC: the RPC truncates at 1000 rows, which
    // dropped whole sub-trees (and the salesmen under them) for large companies.
    let companyPartyIds: string[] = [];
    try {
      const tree = await getPartyDescendants(companyId);
      companyPartyIds = tree.map((r) => r.id);
    } catch {
      companyPartyIds = [];
    }
    if (!companyPartyIds.includes(companyId)) companyPartyIds.push(companyId);

    // Get SALESMAN role id
    const { data: roleData } = await supabaseAdmin
      .from("roles")
      .select("id")
      .eq("name", "SALESMAN")
      .maybeSingle();

    if (!roleData?.id) {
      return NextResponse.json({ data: [] });
    }

    // Query users — fall back to app_users if users table is missing
    let { data: salesmenList, error: salesmenErr } = await fetchSalesmenFromTable("users", roleData.id, companyPartyIds);

    if (isMissingUsersTable(salesmenErr)) {
      const retry = await fetchSalesmenFromTable("app_users", roleData.id, companyPartyIds);
      salesmenList = retry.data;
      salesmenErr = retry.error;
    }

    if (salesmenErr) {
      console.error("[tracking/salesmen] users query error:", salesmenErr.message, salesmenErr.code);
      return NextResponse.json({ data: [] });
    }

    const salesmanIds = (salesmenList || []).map((s) => s.id);

    let gpsHealthBySalesman = new Map<string, Record<string, unknown>>();
    if (salesmanIds.length > 0) {
      const { data: healthRows } = await supabaseAdmin
        .from("salesman_tracking_health")
        .select("salesman_id, gps_enabled, permission_granted, service_active, location_available, last_location_at, status_updated_at, device_platform")
        .in("salesman_id", salesmanIds);
      gpsHealthBySalesman = new Map(
        ((healthRows as Record<string, unknown>[] | null) || []).map((row) => [String(row.salesman_id), row]),
      );
    }

    // Fetch day sessions
    let sessions: Record<string, unknown>[] = [];
    if (salesmanIds.length > 0) {
      const { data: sessionRows, error: sessionErr } = await supabaseAdmin
        .from("salesman_day_sessions")
        .select("*")
        .eq("date", date)
        .in("salesman_id", salesmanIds);
      if (sessionErr) {
        console.error("[tracking/salesmen] sessions query error:", sessionErr.message, sessionErr.code);
      }
      sessions = await Promise.all(
        ((sessionRows as Record<string, unknown>[] | null) ?? []).map(hydrateOdometerSession),
      );
    }

    const [dy, dm, dd] = date.split("-").map(Number);
    const startIST = new Date(Date.UTC(dy, dm - 1, dd, 0, 0, 0, 0) - 5.5 * 60 * 60 * 1000);
    const endIST = new Date(Date.UTC(dy, dm - 1, dd, 23, 59, 59, 999) - 5.5 * 60 * 60 * 1000);

    const salesmenWithStatus = await Promise.all(
      (salesmenList || []).map(async (s) => {
        try {
          const session = sessions.find((sess) => sess.salesman_id === s.id) ?? null;

          const { data: latestRows } = await supabaseAdmin
            .from("salesman_location_logs")
            .select("id, salesman_id, latitude, longitude, accuracy, battery_level, speed, heading, activity, note, recorded_at")
            .eq("salesman_id", s.id)
            .gte("recorded_at", startIST.toISOString())
            .lte("recorded_at", endIST.toISOString())
            .order("recorded_at", { ascending: false })
            .limit(1);
          const latestLoc = (latestRows ?? []).find((row) =>
            normalizeCoordinates(row.latitude, row.longitude)
          ) ?? null;
          const latestCoordinates = latestLoc
            ? normalizeCoordinates(latestLoc.latitude, latestLoc.longitude)
            : null;

          const computed_distance_km = (session?.total_distance_km as number) ?? 0;

          return {
            id: s.id,
            name: s.name,
            email: s.email,
            phone: s.phone ?? null,
            party_id: s.party_id ?? null,
            territories: null,
            session: session ? { ...session, total_distance_km: computed_distance_km } : null,
            latest_location: latestLoc && latestCoordinates
              ? { ...latestLoc, ...latestCoordinates }
              : sessionLocationFallback(session),
            gps_health: gpsHealthBySalesman.get(s.id) || null,
          };
        } catch (perSalesmanErr) {
          console.error(`[tracking/salesmen] error for salesman ${s.id}:`, perSalesmanErr);
          return { id: s.id, name: s.name, email: s.email, phone: s.phone ?? null, party_id: s.party_id ?? null, territories: null, session: null, latest_location: null, gps_health: gpsHealthBySalesman.get(s.id) || null };
        }
      })
    );

    return NextResponse.json({ data: salesmenWithStatus });
  } catch (err) {
    console.error("[tracking/salesmen] crash:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 }
    );
  }
}
