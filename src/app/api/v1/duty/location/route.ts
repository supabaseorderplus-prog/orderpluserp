import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, getUserFromToken, resolveCompanyScope } from "@/lib/supabase-server";
import { normalizeCoordinates } from "@/lib/location-coordinates";
import { istToday } from "@/lib/datetime";
import { evaluateTrackingSegment, MAX_ACCEPTABLE_ACCURACY_M } from "@/lib/tracking-integrity";

interface NominatimResult {
  display_name?: string;
  address?: {
    amenity?: string;
    shop?: string;
    building?: string;
    road?: string;
    suburb?: string;
    neighbourhood?: string;
    city?: string;
    town?: string;
    village?: string;
    state?: string;
    country?: string;
    postcode?: string;
  };
}

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

const isSchemaGap = (code: string | null | undefined) =>
  code === "42703" || code === "PGRST204" || code === "PGRST200";

/** Reverse-geocode using Nominatim (free, no key needed). */
async function reverseGeocode(lat: number, lng: number): Promise<{
  address: string;
  place_name: string | null;
  road: string | null;
  suburb: string | null;
  city: string | null;
}> {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&addressdetails=1&zoom=18`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(url, {
      headers: { "User-Agent": "HomeTech-SalesApp/1.0 (contact@hometech.in)" },
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));
    if (!res.ok) throw new Error("nominatim error");

    const data: NominatimResult = await res.json();
    const a = data.address || {};

    const place_name = a.shop || a.amenity || a.building || null;
    const road = a.road || null;
    const suburb = a.suburb || a.neighbourhood || null;
    const city = a.city || a.town || a.village || null;

    const parts: string[] = [];
    if (place_name) parts.push(place_name);
    if (road)       parts.push(road);
    if (suburb)     parts.push(suburb);
    if (city)       parts.push(city);
    const address = parts.length > 0
      ? parts.join(", ")
      : (data.display_name?.split(",").slice(0, 3).join(", ") ?? `${lat.toFixed(4)}, ${lng.toFixed(4)}`);

    return { address, place_name, road, suburb, city };
  } catch {
    return {
      address:    `${lat.toFixed(4)}, ${lng.toFixed(4)}`,
      place_name: null,
      road:       null,
      suburb:     null,
      city:       null,
    };
  }
}

// POST /api/v1/duty/location — salesman pings their location (token-authenticated)
export async function POST(req: NextRequest) {
  try {
    const caller = await getUserFromToken(req);
    if (!caller) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    // Use app_user_id (public.users FK) consistent with duty/session
    const salesmanId = caller.app_user_id || caller.id;

    const companyId = await resolveCompanyScope(req, caller);

    const body = await req.json().catch(() => ({}));
    const { latitude, longitude, accuracy, battery_level, speed, heading, activity, note, recorded_at, queued_at } = body;

    if (latitude == null || longitude == null) {
      return NextResponse.json({ error: "latitude and longitude required" }, { status: 400 });
    }
    const coordinates = normalizeCoordinates(latitude, longitude);
    if (!coordinates) {
      return NextResponse.json({ error: "valid latitude and longitude required" }, { status: 400 });
    }
    const safeLatitude = coordinates.latitude;
    const safeLongitude = coordinates.longitude;

    const clientRecordedAt = typeof recorded_at === "string"
      ? recorded_at
      : typeof queued_at === "string"
        ? queued_at
        : null;
    const parsedRecordedAt = clientRecordedAt ? new Date(clientRecordedAt) : null;
    const safeRecordedAt = parsedRecordedAt && Number.isFinite(parsedRecordedAt.getTime())
      ? parsedRecordedAt.toISOString()
      : new Date().toISOString();
    const recordedTime = new Date(safeRecordedAt).getTime();
    const isHistoricalUpload = Date.now() - recordedTime > 15_000;

    // One indexed lookup supports live-point coalescing and incremental distance.
    const { data: recentPings } = await supabaseAdmin
      .from("salesman_location_logs")
      .select("id, latitude, longitude, accuracy, recorded_at")
      .eq("salesman_id", salesmanId)
      .order("recorded_at", { ascending: false })
      .limit(1);
    const previous = recentPings?.[0] ?? null;
    const previousCoordinates = previous
      ? normalizeCoordinates(previous.latitude, previous.longitude)
      : null;
    const previousTime = previous?.recorded_at
      ? new Date(previous.recorded_at).getTime()
      : Number.NaN;
    const numericAccuracy = accuracy == null ? null : Number(accuracy);
    if (Number.isFinite(numericAccuracy) && Number(numericAccuracy) > MAX_ACCEPTABLE_ACCURACY_M) {
      return NextResponse.json({ data: previous, ignored: true, reason: "poor_accuracy" });
    }
    const segmentDecision = previous && previousCoordinates && Number.isFinite(previousTime)
      ? evaluateTrackingSegment(
          {
            ...previousCoordinates,
            accuracy: previous.accuracy == null ? null : Number(previous.accuracy),
            recorded_at: previous.recorded_at,
          },
          {
            latitude: safeLatitude,
            longitude: safeLongitude,
            accuracy: numericAccuracy,
            speed: speed == null ? null : Number(speed),
            recorded_at: safeRecordedAt,
          },
        )
      : null;

    if (segmentDecision && ["implausible", "stale", "poor_accuracy"].includes(segmentDecision.reason)) {
      return NextResponse.json({ data: previous, ignored: true, reason: segmentDecision.reason });
    }

    // A stationary device must still look live to the admin. Refresh the latest
    // row instead of returning "skipped", which previously left a stale timestamp.
    const canCoalesce = Boolean(
      previous?.id &&
      !isHistoricalUpload &&
      Number.isFinite(previousTime) &&
      recordedTime >= previousTime &&
      segmentDecision?.reason === "stationary",
    );
    if (canCoalesce && previous) {
      const baseUpdate: Record<string, unknown> = {
        // Preserve the last verified coordinate. Updating it with every tiny
        // jitter makes a stationary marker visibly wander across the map.
        accuracy: accuracy ?? null,
        battery_level: battery_level ?? null,
        recorded_at: safeRecordedAt,
      };
      const extendedUpdate = {
        ...baseUpdate,
        speed: speed ?? null,
        heading: heading ?? null,
        activity: "stationary",
      };
      let updateResult = await supabaseAdmin
        .from("salesman_location_logs")
        .update(extendedUpdate)
        .eq("id", previous.id)
        .select()
        .single();
      if (updateResult.error && (isSchemaGap(updateResult.error.code) || updateResult.error.message?.includes("column"))) {
        updateResult = await supabaseAdmin
          .from("salesman_location_logs")
          .update(baseUpdate)
          .eq("id", previous.id)
          .select()
          .single();
      }
      if (!updateResult.error) {
        return NextResponse.json({ data: updateResult.data, coalesced: true });
      }
    }

    const continuousActivity = !activity || activity === "moving" || activity === "route_tracking";
    const geo = continuousActivity
      ? { address: null, place_name: null, road: null, suburb: null, city: null }
      : await reverseGeocode(safeLatitude, safeLongitude);

    // Base columns — guaranteed to exist per the initial migration
    const baseInsert: Record<string, unknown> = {
      salesman_id:   salesmanId,
      latitude:      safeLatitude,
      longitude:     safeLongitude,
      accuracy:      accuracy      ?? null,
      battery_level: battery_level ?? null,
      recorded_at:   safeRecordedAt,
    };

    // Extended columns added in later migrations — include only if values are present;
    // a column-not-found error triggers an automatic retry with base columns only.
    const extendedInsert: Record<string, unknown> = {
      ...baseInsert,
      speed:      speed      ?? null,
      heading:    heading    ?? null,
      address:    geo.address,
      place_name: geo.place_name,
      road:       geo.road,
      suburb:     geo.suburb,
      city:       geo.city,
      activity:   activity   || "moving",
      note:       note       ?? null,
    };
    if (companyId) extendedInsert.company_id = companyId;

    let insertResult = await supabaseAdmin
      .from("salesman_location_logs")
      .insert(extendedInsert)
      .select()
      .single();

    // Retry with base-only columns so pings always land before the extended
    // tracking migration has been applied.
    if (insertResult.error && (isSchemaGap(insertResult.error.code) || insertResult.error.message?.includes("column"))) {
      insertResult = await supabaseAdmin
        .from("salesman_location_logs")
        .insert(baseInsert)
        .select()
        .single();
    }

    const { data, error } = insertResult;

    if (error) {
      console.error("duty/location POST insert error:", error.message, error.code);
      return NextResponse.json({ error: error.message || error.code || "DB insert error" }, { status: 500 });
    }

    // Increment the active session in constant time. Historical offline uploads
    // stay in the trail but do not corrupt the current running total.
    try {
      const validSegment = !isHistoricalUpload &&
        segmentDecision?.accepted === true &&
        segmentDecision.countsDistance;

      if (validSegment) {
        const today = istToday();
        const { data: activeSession } = await supabaseAdmin
          .from("salesman_day_sessions")
          .select("id, total_distance_km")
          .eq("salesman_id", salesmanId)
          .eq("date", today)
          .eq("status", "active")
          .maybeSingle();
        if (activeSession) {
          const nextDistance = Number(activeSession.total_distance_km || 0) + segmentDecision.distanceM / 1000;
          await supabaseAdmin
            .from("salesman_day_sessions")
            .update({
              total_distance_km: Number(nextDistance.toFixed(3)),
              updated_at: new Date().toISOString(),
            })
            .eq("id", activeSession.id);
        }
      }
    } catch (distErr) {
      // Distance update failure is non-fatal — location was already logged
      console.error("duty/location distance update error:", errMsg(distErr));
    }

    return NextResponse.json({ data });
  } catch (err) {
    console.error("duty/location POST crash:", errMsg(err));
    return NextResponse.json({ error: errMsg(err) || "Internal server error" }, { status: 500 });
  }
}
