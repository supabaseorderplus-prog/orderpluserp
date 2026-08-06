import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, getUserFromToken, resolveCompanyScope } from "@/lib/supabase-server";
import { normalizeCoordinates } from "@/lib/location-coordinates";
import { istToday } from "@/lib/datetime";
import { canEndDuty, parseSessionRouteRun, remainingStopIds, type DutyRouteRunState } from "@/lib/duty-signoff";

function errMsg(err: unknown): string {
  try {
    if (err instanceof Error) return err.message || err.toString() || "Unknown error";
    if (err && typeof err === "object") {
      const e = err as Record<string, unknown>;
      const msg = e.message || e.code || e.error;
      if (msg) return String(msg);
      try { return JSON.stringify(e); } catch { return "[non-serializable error]"; }
    }
    return String(err) || "Unknown error";
  } catch {
    return "Unknown error";
  }
}

function safeErr(err: unknown, status: number): NextResponse {
  const message = errMsg(err);
  return NextResponse.json({ error: message || "Internal server error" }, { status });
}

async function insertCheckInLocation(input: {
  salesmanId: string;
  latitude: unknown;
  longitude: unknown;
  companyId: string | null;
  recordedAt: string;
}) {
  const coordinates = normalizeCoordinates(input.latitude, input.longitude);
  if (!coordinates) return;

  const insertData: Record<string, unknown> = {
    salesman_id: input.salesmanId,
    ...coordinates,
    accuracy: null,
    battery_level: null,
    activity: "check_in",
    note: "Duty check-in location",
    recorded_at: input.recordedAt,
  };
  if (input.companyId) insertData.company_id = input.companyId;

  let { error } = await supabaseAdmin
    .from("salesman_location_logs")
    .insert(insertData);

  if (error && (error.code === "42703" || error.message?.includes("company_id"))) {
    delete insertData.company_id;
    const retry = await supabaseAdmin
      .from("salesman_location_logs")
      .insert(insertData);
    error = retry.error;
  }

  if (error) {
    console.error("duty/session check-in location insert error:", error.message, error.code);
  }
}

// GET /api/v1/duty/session — fetch today's session for the calling user
export async function GET(req: NextRequest) {
  try {
    const caller = await getUserFromToken(req);
    if (!caller) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const salesmanId = caller.app_user_id || caller.id;
    const today = istToday();

    const { data, error } = await supabaseAdmin
      .from("salesman_day_sessions")
      .select("*")
      .eq("salesman_id", salesmanId)
      .eq("date", today)
      .maybeSingle();

    if (error) {
      console.error("duty/session GET db error:", error.message, error.code);
      return NextResponse.json({ error: error.message || error.code || "DB error" }, { status: 500 });
    }
    return NextResponse.json({ data: data ?? null });
  } catch (err) {
    console.error("duty/session GET crash:", errMsg(err));
    return safeErr(err, 500);
  }
}

// POST /api/v1/duty/session — check in (start duty)
export async function POST(req: NextRequest) {
  try {
    const caller = await getUserFromToken(req);
    if (!caller) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const salesmanId = caller.app_user_id || caller.id;
    const companyId = await resolveCompanyScope(req, caller) || caller.party_id || null;
    const body = await req.json().catch(() => ({}));
    const { latitude, longitude, notes } = body;
    const today = istToday();
    const now = new Date().toISOString();

    const { data, error } = await supabaseAdmin
      .from("salesman_day_sessions")
      .upsert({
        salesman_id: salesmanId,
        date: today,
        check_in_time: now,
        check_in_lat: latitude ?? null,
        check_in_lng: longitude ?? null,
        status: "active",
        notes: notes ?? null,
      }, { onConflict: "salesman_id,date" })
      .select()
      .single();

    if (error) {
      console.error("duty/session POST db error:", error.message, error.code);
      return NextResponse.json({ error: error.message || error.code || "DB error" }, { status: 500 });
    }
    await insertCheckInLocation({
      salesmanId,
      latitude,
      longitude,
      companyId,
      recordedAt: String(data.check_in_time || now),
    });
    return NextResponse.json({ data });
  } catch (err) {
    console.error("duty/session POST crash:", errMsg(err));
    return safeErr(err, 500);
  }
}

// PATCH /api/v1/duty/session — check out or update stats
export async function PATCH(req: NextRequest) {
  try {
    const caller = await getUserFromToken(req);
    if (!caller) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const salesmanId = caller.app_user_id || caller.id;
    const body = await req.json().catch(() => ({}));
    const { latitude, longitude, total_distance_km, total_stops, status, notes } = body;
    const today = istToday();

    if (status === "checked_out") {
      const sessionResult = await supabaseAdmin.from("salesman_day_sessions").select("*")
        .eq("salesman_id", salesmanId).eq("date", today).maybeSingle();
      if (sessionResult.error) {
        return NextResponse.json({ error: sessionResult.error.message || "Could not verify today's route" }, { status: 500 });
      }
      const sessionRun = parseSessionRouteRun(sessionResult.data?.notes as string | null | undefined);
      const runResult = await supabaseAdmin.from("salesman_route_runs").select("*")
        .eq("salesman_id", salesmanId).eq("work_date", today).maybeSingle();
      const tableRun = runResult.data as DutyRouteRunState | null;
      const sessionIsNewer = Boolean(tableRun && sessionRun && new Date(sessionRun.updated_at).getTime() > new Date(tableRun.updated_at).getTime());
      const routeRun = sessionIsNewer ? sessionRun : tableRun
        ? { ...tableRun, signoff_request: tableRun.signoff_request || sessionRun?.signoff_request || null }
        : sessionRun;

      if (!canEndDuty(routeRun)) {
        const remaining = routeRun ? remainingStopIds(routeRun) : [];
        return NextResponse.json({
          error: "Admin approval is required before ending duty with unvisited route parties.",
          code: "INCOMPLETE_ROUTE_APPROVAL_REQUIRED",
          remaining_stops: remaining.length,
          remaining_stop_ids: remaining,
          signoff_request: routeRun?.signoff_request || null,
        }, { status: 409 });
      }
    }

    const now = new Date().toISOString();
    const updates: Record<string, unknown> = { updated_at: now };
    if (status === "checked_out") updates.check_out_time = now;
    if (latitude != null) {
      updates.check_out_lat = latitude;
      updates.check_out_lng = longitude;
    }
    if (total_distance_km != null) updates.total_distance_km = total_distance_km;
    if (total_stops != null) updates.total_stops = total_stops;
    if (status) updates.status = status;
    if (notes) updates.notes = notes;

    const { data, error } = await supabaseAdmin
      .from("salesman_day_sessions")
      .update(updates)
      .eq("salesman_id", salesmanId)
      .eq("date", today)
      .select()
      .maybeSingle();

    if (error) {
      console.error("duty/session PATCH db error:", error.message, error.code);
      return NextResponse.json({ error: error.message || error.code || "DB error" }, { status: 500 });
    }
    if (!data) return NextResponse.json({ error: "No active session found for today" }, { status: 404 });
    return NextResponse.json({ data });
  } catch (err) {
    console.error("duty/session PATCH crash:", errMsg(err));
    return safeErr(err, 500);
  }
}
