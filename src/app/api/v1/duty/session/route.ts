import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, getUserFromToken, resolveCompanyScope } from "@/lib/supabase-server";
import { normalizeCoordinates } from "@/lib/location-coordinates";
import { istToday } from "@/lib/datetime";
import { canEndDuty, encodeSessionRouteRun, parseSessionRouteRun, previousSessionNotes, remainingStopIds, type DutyRouteRunState } from "@/lib/duty-signoff";
import { encodeDutyOdometerEvidence, parseDutyOdometerEvidence, validateOdometerProgress } from "@/lib/odometer-reading";
import { attachOdometerPhotoUrls } from "@/lib/odometer-photo-server";

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

function isOdometerSchemaGap(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  return error.code === "42703" || /odometer_(km|photo|ocr|distance)/i.test(error.message || "");
}

async function withOdometerEvidence(row: Record<string, unknown> | null) {
  if (!row) return null;
  const evidence = parseDutyOdometerEvidence(previousSessionNotes(row.notes as string | null | undefined));
  const hydrated = evidence ? {
    ...row,
    start_odometer_km: row.start_odometer_km ?? evidence.start.reading,
    end_odometer_km: row.end_odometer_km ?? evidence.end?.reading ?? null,
    odometer_distance_km: row.odometer_distance_km ?? evidence.distance_km,
    start_odometer_photo_path: row.start_odometer_photo_path ?? evidence.start.photo_path,
    end_odometer_photo_path: row.end_odometer_photo_path ?? evidence.end?.photo_path ?? null,
    start_odometer_ocr_confidence: row.start_odometer_ocr_confidence ?? evidence.start.confidence,
    end_odometer_ocr_confidence: row.end_odometer_ocr_confidence ?? evidence.end?.confidence ?? null,
  } : row;
  return attachOdometerPhotoUrls(hydrated);
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
    return NextResponse.json({ data: await withOdometerEvidence(data as Record<string, unknown> | null) });
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
    const {
      latitude,
      longitude,
      notes,
      start_odometer_km,
      start_odometer_photo_path,
      start_odometer_ocr_confidence,
    } = body;
    const today = istToday();
    const now = new Date().toISOString();

    const startKm = Number(start_odometer_km);
    const startConfidence = Number(start_odometer_ocr_confidence);
    const expectedPhotoPrefix = `${salesmanId}/${today}/start-`;
    if (!Number.isFinite(startKm) || startKm < 0 || !Number.isFinite(startConfidence) || startConfidence < 25 ||
        typeof start_odometer_photo_path !== "string" || !start_odometer_photo_path.startsWith(expectedPhotoPrefix)) {
      return NextResponse.json({ error: "A verified start odometer photo is required before duty can begin." }, { status: 422 });
    }

    const existing = await supabaseAdmin.from("salesman_day_sessions").select("id,status")
      .eq("salesman_id", salesmanId).eq("date", today).maybeSingle();
    if (existing.error) return NextResponse.json({ error: existing.error.message }, { status: 500 });
    if (existing.data) return NextResponse.json({ error: "Today’s duty has already been started." }, { status: 409 });

    const evidenceNotes = encodeDutyOdometerEvidence({
      start: {
        reading: startKm,
        confidence: startConfidence,
        photo_path: start_odometer_photo_path,
        captured_at: now,
      },
      end: null,
      distance_km: null,
    }, notes ?? null);
    const baseInsert = {
      salesman_id: salesmanId,
      date: today,
      check_in_time: now,
      check_in_lat: latitude ?? null,
      check_in_lng: longitude ?? null,
      status: "active",
      notes: evidenceNotes,
    };
    let insertResult = await supabaseAdmin
      .from("salesman_day_sessions")
      .upsert({
        ...baseInsert,
        start_odometer_km: startKm,
        start_odometer_photo_path,
        start_odometer_ocr_confidence: startConfidence,
      })
      .select()
      .single();

    if (isOdometerSchemaGap(insertResult.error)) {
      insertResult = await supabaseAdmin
        .from("salesman_day_sessions")
        .upsert(baseInsert)
        .select()
        .single();
    }
    const { data, error } = insertResult;

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
    return NextResponse.json({ data: await withOdometerEvidence(data as Record<string, unknown>) });
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
    const {
      latitude,
      longitude,
      total_distance_km,
      total_stops,
      status,
      notes,
      end_odometer_km,
      end_odometer_photo_path,
      end_odometer_ocr_confidence,
    } = body;
    const today = istToday();
    let verifiedOdometerDistance: number | null = null;
    let evidenceNotes: string | null = null;

    if (status === "checked_out") {
      const sessionResult = await supabaseAdmin.from("salesman_day_sessions").select("*")
        .eq("salesman_id", salesmanId).eq("date", today).maybeSingle();
      if (sessionResult.error) {
        return NextResponse.json({ error: sessionResult.error.message || "Could not verify today's route" }, { status: 500 });
      }
      if (!sessionResult.data || sessionResult.data.status !== "active") {
        return NextResponse.json({ error: "No active session found for today" }, { status: 404 });
      }

      const existingEvidence = parseDutyOdometerEvidence(previousSessionNotes(sessionResult.data.notes as string | null | undefined));
      const startKm = Number(sessionResult.data.start_odometer_km ?? existingEvidence?.start.reading);
      const endKm = Number(end_odometer_km);
      const endConfidence = Number(end_odometer_ocr_confidence);
      const expectedPhotoPrefix = `${salesmanId}/${today}/end-`;
      const progressError = validateOdometerProgress(startKm, endKm);
      if (progressError || !Number.isFinite(endConfidence) || endConfidence < 25 ||
          typeof end_odometer_photo_path !== "string" || !end_odometer_photo_path.startsWith(expectedPhotoPrefix)) {
        return NextResponse.json({
          error: progressError || "A verified end odometer photo is required before duty can end.",
        }, { status: 422 });
      }
      verifiedOdometerDistance = Math.round((endKm - startKm) * 10) / 10;

      const sessionRun = parseSessionRouteRun(sessionResult.data?.notes as string | null | undefined);
      const startEvidence = existingEvidence?.start || {
        reading: startKm,
        confidence: Number(sessionResult.data.start_odometer_ocr_confidence || 100),
        photo_path: String(sessionResult.data.start_odometer_photo_path || "legacy-verified-photo"),
        captured_at: String(sessionResult.data.check_in_time || new Date().toISOString()),
      };
      const encodedEvidence = encodeDutyOdometerEvidence({
        start: startEvidence,
        end: {
          reading: endKm,
          confidence: endConfidence,
          photo_path: end_odometer_photo_path,
          captured_at: new Date().toISOString(),
        },
        distance_km: verifiedOdometerDistance,
      }, previousSessionNotes(sessionResult.data.notes as string | null | undefined));
      evidenceNotes = sessionRun ? encodeSessionRouteRun(sessionRun, encodedEvidence) : encodedEvidence;
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
    if (verifiedOdometerDistance != null) {
      updates.end_odometer_km = Number(end_odometer_km);
      updates.end_odometer_photo_path = end_odometer_photo_path;
      updates.end_odometer_ocr_confidence = Number(end_odometer_ocr_confidence);
      updates.odometer_distance_km = verifiedOdometerDistance;
      updates.total_distance_km = verifiedOdometerDistance;
    } else if (total_distance_km != null) {
      updates.total_distance_km = total_distance_km;
    }
    if (total_stops != null) updates.total_stops = total_stops;
    if (status) updates.status = status;
    if (evidenceNotes) updates.notes = evidenceNotes;
    else if (notes) updates.notes = notes;

    let updateResult = await supabaseAdmin
      .from("salesman_day_sessions")
      .update(updates)
      .eq("salesman_id", salesmanId)
      .eq("date", today)
      .select()
      .maybeSingle();

    if (isOdometerSchemaGap(updateResult.error)) {
      const fallbackUpdates = { ...updates };
      delete fallbackUpdates.end_odometer_km;
      delete fallbackUpdates.end_odometer_photo_path;
      delete fallbackUpdates.end_odometer_ocr_confidence;
      delete fallbackUpdates.odometer_distance_km;
      updateResult = await supabaseAdmin
        .from("salesman_day_sessions")
        .update(fallbackUpdates)
        .eq("salesman_id", salesmanId)
        .eq("date", today)
        .select()
        .maybeSingle();
    }
    const { data, error } = updateResult;

    if (error) {
      console.error("duty/session PATCH db error:", error.message, error.code);
      return NextResponse.json({ error: error.message || error.code || "DB error" }, { status: 500 });
    }
    if (!data) return NextResponse.json({ error: "No active session found for today" }, { status: 404 });
    return NextResponse.json({ data: await withOdometerEvidence(data as Record<string, unknown>) });
  } catch (err) {
    console.error("duty/session PATCH crash:", errMsg(err));
    return safeErr(err, 500);
  }
}
