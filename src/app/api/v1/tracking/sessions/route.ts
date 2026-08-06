import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, getUserFromToken, resolveCompanyScope } from "@/lib/supabase-server";
import { normalizeCoordinates } from "@/lib/location-coordinates";
import { istToday } from "@/lib/datetime";

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
    console.error("[tracking/sessions POST] check-in location insert error:", error.message, error.code);
  }
}

// GET /api/v1/tracking/sessions?salesman_id=xxx&date=2026-03-02
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const salesman_id = searchParams.get("salesman_id");
    const date = searchParams.get("date") || istToday();

    const authUser = await getUserFromToken(req);
    const companyId = await resolveCompanyScope(req, authUser);

    let query = supabaseAdmin
      .from("salesman_day_sessions")
      .select("*, users(id, name, email)")
      .order("date", { ascending: false });

    if (companyId) query = query.eq("company_id", companyId);
    if (salesman_id) query = query.eq("salesman_id", salesman_id);
    if (date) query = query.eq("date", date);

    const { data, error } = await query;
    if (error) {
      console.error("[tracking/sessions GET] db error:", error.message);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({ data: data ?? [] });
  } catch (err) {
    console.error("[tracking/sessions GET] crash:", errMsg(err));
    return NextResponse.json({ error: errMsg(err) || "Internal server error" }, { status: 500 });
  }
}

// POST /api/v1/tracking/sessions — check-in
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const { salesman_id, latitude, longitude, notes } = body;

    if (!salesman_id) {
      return NextResponse.json({ error: "salesman_id required" }, { status: 400 });
    }

    const authUser = await getUserFromToken(req);
    const companyId = await resolveCompanyScope(req, authUser);
    const today = istToday();
    const now = new Date().toISOString();

    const { data, error } = await supabaseAdmin
      .from("salesman_day_sessions")
      .upsert({
        salesman_id,
        date: today,
        check_in_time: now,
        check_in_lat: latitude ?? null,
        check_in_lng: longitude ?? null,
        status: "active",
        notes: notes ?? null,
        company_id: companyId ?? null,
      }, { onConflict: "salesman_id,date" })
      .select()
      .maybeSingle();

    if (error) {
      console.error("[tracking/sessions POST] db error:", error.message);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    await insertCheckInLocation({
      salesmanId: salesman_id,
      latitude,
      longitude,
      companyId,
      recordedAt: String(data?.check_in_time || now),
    });
    return NextResponse.json({ data: data ?? null });
  } catch (err) {
    console.error("[tracking/sessions POST] crash:", errMsg(err));
    return NextResponse.json({ error: errMsg(err) || "Internal server error" }, { status: 500 });
  }
}

// PATCH /api/v1/tracking/sessions — check-out or update stats
export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const { salesman_id, latitude, longitude, total_distance_km, total_stops, status, notes } = body;

    if (!salesman_id) {
      return NextResponse.json({ error: "salesman_id required" }, { status: 400 });
    }

    const authUser = await getUserFromToken(req);
    await resolveCompanyScope(req, authUser);
    const today = istToday();

    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (latitude != null) {
      updates.check_out_lat = latitude;
      updates.check_out_lng = longitude;
      updates.check_out_time = new Date().toISOString();
    }
    if (total_distance_km != null) updates.total_distance_km = total_distance_km;
    if (total_stops != null) updates.total_stops = total_stops;
    if (status) updates.status = status;
    if (notes) updates.notes = notes;

    const { data, error } = await supabaseAdmin
      .from("salesman_day_sessions")
      .update(updates)
      .eq("salesman_id", salesman_id)
      .eq("date", today)
      .select()
      .maybeSingle();

    if (error) {
      console.error("[tracking/sessions PATCH] db error:", error.message);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    if (!data) return NextResponse.json({ error: "No session found for today" }, { status: 404 });
    return NextResponse.json({ data });
  } catch (err) {
    console.error("[tracking/sessions PATCH] crash:", errMsg(err));
    return NextResponse.json({ error: errMsg(err) || "Internal server error" }, { status: 500 });
  }
}
