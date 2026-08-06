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

// GET /api/v1/tracking/location?salesman_id=xxx&date=2026-03-02&limit=500
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const salesman_id = searchParams.get("salesman_id");
    const date = searchParams.get("date") || istToday();
    const limit = parseInt(searchParams.get("limit") || "500");
    const after = searchParams.get("after");

    if (!salesman_id) {
      return NextResponse.json({ error: "salesman_id required" }, { status: 400 });
    }

    const [y, m, d] = date.split("-").map(Number);
    const startIST = new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0) - 5.5 * 60 * 60 * 1000);
    const endIST   = new Date(Date.UTC(y, m - 1, d, 23, 59, 59, 999) - 5.5 * 60 * 60 * 1000);

    const runQuery = async (columns: string) => {
      let query = supabaseAdmin
        .from("salesman_location_logs")
        .select(columns)
        .eq("salesman_id", salesman_id)
        .gte("recorded_at", startIST.toISOString())
        .lte("recorded_at", endIST.toISOString());
      if (after) {
        const parsedAfter = new Date(after);
        if (Number.isFinite(parsedAfter.getTime())) query = query.gt("recorded_at", parsedAfter.toISOString());
      }
      return after
        ? query.order("recorded_at", { ascending: true }).limit(limit)
        : query.order("recorded_at", { ascending: false }).limit(limit);
    };

    // Include human-readable place and movement metadata when the extended
    // tracking migration exists, while retaining compatibility with old schemas.
    const selectTiers = [
      "id, salesman_id, latitude, longitude, accuracy, battery_level, speed, heading, address, place_name, road, suburb, city, activity, note, recorded_at",
      "id, salesman_id, latitude, longitude, accuracy, battery_level, speed, heading, address, activity, note, recorded_at",
      "id, salesman_id, latitude, longitude, accuracy, battery_level, speed, heading, activity, recorded_at",
      "id, salesman_id, latitude, longitude, accuracy, battery_level, speed, heading, recorded_at",
      "id, salesman_id, latitude, longitude, accuracy, battery_level, recorded_at",
    ];
    let result = await runQuery(selectTiers[0]);
    for (const columns of selectTiers.slice(1)) {
      if (!result.error || !["42703", "PGRST204"].includes(result.error.code || "")) break;
      result = await runQuery(columns);
    }
    const { data, error } = result;

    if (error) {
      console.error("[tracking/location GET] db error:", error.message, error.code);
      return NextResponse.json({ data: [] });
    }

    // Deduplicate — skip pings within 5s of prev with same coords
    const rows = after ? (data ?? []) : [...(data ?? [])].reverse();
    const deduped: typeof rows = [];
    for (const row of rows) {
      const prev = deduped[deduped.length - 1];
      if (
        prev &&
        Math.abs(new Date(row.recorded_at).getTime() - new Date(prev.recorded_at).getTime()) < 5000 &&
        Math.abs(Number(row.latitude)  - Number(prev.latitude))  < 0.00001 &&
        Math.abs(Number(row.longitude) - Number(prev.longitude)) < 0.00001
      ) continue;
      deduped.push(row);
    }

    return NextResponse.json({ data: deduped });
  } catch (err) {
    console.error("[tracking/location GET] crash:", errMsg(err));
    return NextResponse.json({ error: errMsg(err) || "Internal server error" }, { status: 500 });
  }
}

// POST /api/v1/tracking/location — salesman app pings location
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const { salesman_id, latitude, longitude, accuracy, battery_level, speed, heading, address, activity, note } = body;

    if (!salesman_id || latitude == null || longitude == null) {
      return NextResponse.json({ error: "salesman_id, latitude, longitude required" }, { status: 400 });
    }
    const coordinates = normalizeCoordinates(latitude, longitude);
    if (!coordinates) {
      return NextResponse.json({ error: "valid latitude and longitude required" }, { status: 400 });
    }

    const authUser = await getUserFromToken(req);
    const companyId = await resolveCompanyScope(req, authUser);

    const insertData: Record<string, unknown> = {
      salesman_id,
      ...coordinates,
      accuracy: accuracy ?? null,
      battery_level: battery_level ?? null,
      speed: speed ?? null,
      heading: heading ?? null,
      address: address ?? null,
      activity: activity || "moving",
      note: note ?? null,
    };

    if (companyId) insertData.company_id = companyId;

    const { data, error } = await supabaseAdmin
      .from("salesman_location_logs")
      .insert(insertData)
      .select()
      .maybeSingle();

    if (error) {
      console.error("[tracking/location POST] db error:", error.message);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({ data: data ?? null });
  } catch (err) {
    console.error("[tracking/location POST] crash:", errMsg(err));
    return NextResponse.json({ error: errMsg(err) || "Internal server error" }, { status: 500 });
  }
}
