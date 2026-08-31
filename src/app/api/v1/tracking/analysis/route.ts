import { NextRequest, NextResponse } from "next/server";
import { getPartyDescendants, getUserFromToken, resolveCompanyScope, supabaseAdmin } from "@/lib/supabase-server";
import { istToday } from "@/lib/datetime";
import { buildVerifiedTrail, type TrackingPoint } from "@/lib/tracking-integrity";
import { previousSessionNotes } from "@/lib/duty-signoff";
import { parseDutyOdometerEvidence } from "@/lib/odometer-reading";
import { createOdometerPhotoSignedUrl } from "@/lib/odometer-photo-server";

type Visit = {
  stop_id?: string;
  party_id?: string;
  visited_at?: string;
  distance_m?: number;
  notes?: string;
};

type Run = {
  id: string;
  route_id: string;
  work_date: string;
  status: string;
  visits: Visit[] | null;
  total_stops: number | null;
  started_at: string | null;
  completed_at: string | null;
};

type DaySession = {
  id: string;
  date: string;
  status: string | null;
  total_distance_km: number | null;
  check_in_time: string | null;
  check_out_time: string | null;
  notes: string | null;
};

type LocationRow = {
  latitude: number | string;
  longitude: number | string;
  accuracy?: number | string | null;
  speed?: number | string | null;
  recorded_at: string;
};

const SESSION_ROUTE_RUN_PREFIX = "ORDERPLUS_ROUTE_RUN_V1:";

function parseSessionRun(notes: unknown): Run | null {
  if (typeof notes !== "string" || !notes.startsWith(SESSION_ROUTE_RUN_PREFIX)) return null;
  try {
    const envelope = JSON.parse(notes.slice(SESSION_ROUTE_RUN_PREFIX.length)) as { run?: Run };
    return envelope.run?.id && envelope.run.route_id ? envelope.run : null;
  } catch {
    return null;
  }
}

function dateDaysAgo(days: number, today = istToday()) {
  const [year, month, day] = today.split("-").map(Number);
  const value = new Date(Date.UTC(year, month - 1, day));
  value.setUTCDate(value.getUTCDate() - (days - 1));
  return value.toISOString().slice(0, 10);
}

function dateRange(fromDate: string, toDate: string) {
  const dates: string[] = [];
  const cursor = new Date(`${fromDate}T00:00:00.000Z`);
  const end = new Date(`${toDate}T00:00:00.000Z`);
  while (cursor <= end) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

function istDayBounds(date: string) {
  const [year, month, day] = date.split("-").map(Number);
  const offsetMs = 5.5 * 60 * 60 * 1000;
  return {
    start: new Date(Date.UTC(year, month - 1, day) - offsetMs).toISOString(),
    end: new Date(Date.UTC(year, month - 1, day, 23, 59, 59, 999) - offsetMs).toISOString(),
  };
}

async function verifiedDistanceForDay(salesmanId: string, date: string) {
  const { start, end } = istDayBounds(date);
  const pageSize = 1000;
  const maxRows = 12_000;
  const rows: LocationRow[] = [];
  let columns = "latitude, longitude, accuracy, speed, recorded_at";

  for (let offset = 0; offset < maxRows; offset += pageSize) {
    const runQuery = (selectColumns: string) => supabaseAdmin
      .from("salesman_location_logs")
      .select(selectColumns)
      .eq("salesman_id", salesmanId)
      .gte("recorded_at", start)
      .lte("recorded_at", end)
      .order("recorded_at", { ascending: true })
      .range(offset, offset + pageSize - 1);

    let result = await runQuery(columns);
    if (offset === 0 && result.error && ["42703", "PGRST204"].includes(result.error.code || "")) {
      columns = "latitude, longitude, accuracy, recorded_at";
      result = await runQuery(columns);
    }
    if (result.error) throw result.error;

    const page = (result.data || []) as unknown as LocationRow[];
    rows.push(...page);
    if (page.length < pageSize) break;
  }

  const points = rows.flatMap((row): TrackingPoint[] => {
    const latitude = Number(row.latitude);
    const longitude = Number(row.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return [];
    return [{
      latitude,
      longitude,
      accuracy: row.accuracy == null ? null : Number(row.accuracy),
      speed: row.speed == null ? null : Number(row.speed),
      recorded_at: row.recorded_at,
    }];
  });
  const verified = buildVerifiedTrail(points);
  return {
    distanceKm: verified.distanceKm,
    acceptedPoints: verified.points.length,
    rejectedPoints: verified.rejected,
    hasLogs: points.length > 0,
    truncated: rows.length >= maxRows,
  };
}

async function verifiedDistancesForDates(salesmanId: string, dates: string[]) {
  const results = new Map<string, Awaited<ReturnType<typeof verifiedDistanceForDay>>>();
  // Keep database pressure bounded while still avoiding a slow 30-request
  // waterfall for salesmen who worked every day in the reporting period.
  for (let index = 0; index < dates.length; index += 5) {
    const batch = dates.slice(index, index + 5);
    const batchResults = await Promise.all(
      batch.map(async (date) => [date, await verifiedDistanceForDay(salesmanId, date)] as const),
    );
    for (const [date, result] of batchResults) results.set(date, result);
  }
  return results;
}

async function salesmanBelongsToCompany(salesmanId: string, companyId: string) {
  const descendants = await getPartyDescendants(companyId).catch(() => []);
  const partyIds = [...new Set([companyId, ...descendants.map((party) => party.id)])];
  for (const table of ["users", "app_users"] as const) {
    const { data } = await supabaseAdmin.from(table).select("id, party_id").eq("id", salesmanId).maybeSingle();
    if (data) return !data.party_id || partyIds.includes(data.party_id);
  }
  return false;
}

export async function GET(req: NextRequest) {
  try {
    const caller = await getUserFromToken(req);
    if (!caller) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const companyId = await resolveCompanyScope(req, caller);
    if (!companyId) return NextResponse.json({ error: "No company selected" }, { status: 403 });

    const salesmanId = req.nextUrl.searchParams.get("salesman_id") || "";
    const routeId = req.nextUrl.searchParams.get("route_id") || "";
    const requestedDays = Number(req.nextUrl.searchParams.get("days") || 30);
    const days = Math.min(90, Math.max(1, Number.isFinite(requestedDays) ? Math.floor(requestedDays) : 30));
    if (!salesmanId) {
      return NextResponse.json({ error: "salesman_id is required" }, { status: 400 });
    }
    if (!await salesmanBelongsToCompany(salesmanId, companyId)) {
      return NextResponse.json({ error: "Salesman is outside this company" }, { status: 403 });
    }

    const today = istToday();
    const fromDate = dateDaysAgo(days, today);
    const requestedDate = req.nextUrl.searchParams.get("date") || today;
    const selectedDate = /^\d{4}-\d{2}-\d{2}$/.test(requestedDate) && requestedDate >= fromDate && requestedDate <= today
      ? requestedDate
      : today;

    let runs: Run[] = [];
    if (routeId) {
      const runsResult = await supabaseAdmin
        .from("salesman_route_runs")
        .select("id, route_id, work_date, status, visits, total_stops, started_at, completed_at")
        .eq("salesman_id", salesmanId)
        .eq("route_id", routeId)
        .gte("work_date", fromDate)
        .lte("work_date", today)
        .order("work_date", { ascending: false });
      runs = ((runsResult.data as Run[] | null) || []);
    }
    // Older installations persist the locked route safely inside the day
    // session notes when the dedicated route-run table is unavailable.
    const sessionResult = await supabaseAdmin
      .from("salesman_day_sessions")
      .select("id, date, status, total_distance_km, check_in_time, check_out_time, notes")
      .eq("salesman_id", salesmanId)
      .gte("date", fromDate)
      .lte("date", today)
      .order("date", { ascending: false });
    if (sessionResult.error) throw sessionResult.error;
    const sessions = ((sessionResult.data as DaySession[] | null) || []);
    const fallbackRuns = sessions
      .map((session) => parseSessionRun(session.notes))
      .filter((run): run is Run => Boolean(routeId && run && run.route_id === routeId));
    const runsByDate = new Map<string, Run>();
    for (const run of [...fallbackRuns, ...runs]) runsByDate.set(run.work_date, run);
    runs = [...runsByDate.values()].sort((a, b) => b.work_date.localeCompare(a.work_date));

    const selectedSession = sessions.find((session) => session.date === selectedDate);
    const selectedOdometer = parseDutyOdometerEvidence(previousSessionNotes(selectedSession?.notes));
    const [startOdometerPhotoUrl, endOdometerPhotoUrl] = selectedOdometer
      ? await Promise.all([
          createOdometerPhotoSignedUrl(selectedOdometer.start.photo_path),
          createOdometerPhotoSignedUrl(selectedOdometer.end?.photo_path),
        ])
      : [null, null];
    const datesToVerify = [...new Set([...sessions.map((session) => session.date), selectedDate])];
    const verifiedByDate = await verifiedDistancesForDates(salesmanId, datesToVerify);
    const verifiedSelectedDay = verifiedByDate.get(selectedDate) || {
      distanceKm: 0,
      acceptedPoints: 0,
      rejectedPoints: 0,
      hasLogs: false,
      truncated: false,
    };
    const selectedStoredDistance = Math.max(0, Number(selectedSession?.total_distance_km || 0));
    const selectedDistanceKm = verifiedSelectedDay.hasLogs
      ? verifiedSelectedDay.distanceKm
      : selectedStoredDistance;
    const sessionMap = new Map(sessions.map((session) => [session.date, session]));
    const distanceDaily = dateRange(fromDate, today).map((date) => {
      const session = sessionMap.get(date);
      const storedDistance = Math.max(0, Number(session?.total_distance_km || 0));
      const verifiedDay = verifiedByDate.get(date);
      const verifiedDistance = verifiedDay?.hasLogs ? verifiedDay.distanceKm : storedDistance;
      return {
        date,
        distance_km: Number(verifiedDistance.toFixed(3)),
        tracked: Boolean(session),
        status: session?.status || null,
        check_in_time: session?.check_in_time || null,
        check_out_time: session?.check_out_time || null,
      };
    });
    const verifiedTotalKm = sessions.reduce(
      (sum, session) => {
        const verifiedDay = verifiedByDate.get(session.date);
        const distanceKm = verifiedDay?.hasLogs
          ? verifiedDay.distanceKm
          : Math.max(0, Number(session.total_distance_km || 0));
        return sum + distanceKm;
      },
      0,
    );
    const trackedDays = sessions.length;

    const stopsResult = routeId
      ? await supabaseAdmin.from("route_stops").select("*").eq("route_id", routeId)
      : { data: [] };
    const stops = ((stopsResult.data as Record<string, unknown>[] | null) || []).map((row, index) => ({
      id: String(row.id),
      party_id: String(row.retailer_id ?? row.party_id ?? row.store_id ?? row.outlet_id ?? ""),
      stop_order: Math.max(1, Number(row.stop_order ?? row.sequence ?? row.order_num ?? row.position) || index + 1),
    })).filter((stop) => stop.party_id);
    const partyIds = [...new Set(stops.map((stop) => stop.party_id))];
    const partyResult = partyIds.length
      ? await supabaseAdmin.from("parties").select("id, name, party_code, address_line1, city").in("id", partyIds)
      : { data: [] };
    const partyMap = new Map(((partyResult.data as Record<string, unknown>[] | null) || []).map((party) => [String(party.id), party]));

    const visits = runs.flatMap((run) => (Array.isArray(run.visits) ? run.visits : []).map((visit) => ({ ...visit, work_date: run.work_date })));
    const daily = runs.map((run) => {
      const visitCount = Array.isArray(run.visits) ? run.visits.length : 0;
      const totalStops = Number(run.total_stops || stops.length || 0);
      return {
        date: run.work_date,
        visits: visitCount,
        total_stops: totalStops,
        completion_percent: totalStops ? Math.min(100, Math.round((visitCount / totalStops) * 100)) : 0,
        completed: run.status === "completed",
      };
    });

    const party_performance = stops
      .sort((a, b) => a.stop_order - b.stop_order)
      .map((stop) => {
        const partyVisits = visits.filter((visit) => visit.party_id === stop.party_id || visit.stop_id === stop.id);
        const uniqueDays = new Set(partyVisits.map((visit) => visit.work_date));
        const last = [...partyVisits].sort((a, b) => new Date(b.visited_at || b.work_date).getTime() - new Date(a.visited_at || a.work_date).getTime())[0];
        const party = partyMap.get(stop.party_id) || {};
        return {
          stop_id: stop.id,
          party_id: stop.party_id,
          stop_order: stop.stop_order,
          party_name: String(party.name || `Party ${stop.stop_order}`),
          party_code: party.party_code || null,
          address: [party.address_line1, party.city].filter(Boolean).join(", ") || null,
          visits: partyVisits.length,
          visit_days: uniqueDays.size,
          last_visited_at: last?.visited_at || null,
          visit_rate: runs.length ? Math.round((uniqueDays.size / runs.length) * 100) : 0,
          visited: partyVisits.length > 0,
        };
      });

    const uniqueParties = new Set(visits.map((visit) => visit.party_id).filter(Boolean));
    const completedDays = daily.filter((day) => day.completed).length;
    const possibleVisits = daily.reduce((sum, day) => sum + day.total_stops, 0);
    return NextResponse.json({
      data: {
        period_days: days,
        from_date: fromDate,
        to_date: today,
        route_selected: Boolean(routeId),
        distance_summary: {
          total_km: Number(verifiedTotalKm.toFixed(3)),
          tracked_days: trackedDays,
          average_km: Number((trackedDays ? verifiedTotalKm / trackedDays : 0).toFixed(3)),
          selected_date: selectedDate,
          selected_date_km: Number(selectedDistanceKm.toFixed(3)),
          selected_date_status: selectedSession?.status || null,
          selected_date_check_in: selectedSession?.check_in_time || null,
          selected_date_check_out: selectedSession?.check_out_time || null,
          selected_date_source: verifiedSelectedDay.hasLogs ? "verified_gps" : "duty_session",
          selected_date_odometer: selectedOdometer ? {
            start_km: selectedOdometer.start.reading,
            end_km: selectedOdometer.end?.reading ?? null,
            distance_km: selectedOdometer.distance_km,
            start_photo_url: startOdometerPhotoUrl,
            end_photo_url: endOdometerPhotoUrl,
          } : null,
          accepted_points: verifiedSelectedDay.acceptedPoints,
          rejected_points: verifiedSelectedDay.rejectedPoints,
          truncated: verifiedSelectedDay.truncated,
          daily: distanceDaily,
        },
        route_days: runs.length,
        completed_days: completedDays,
        total_visits: visits.length,
        unique_parties_visited: uniqueParties.size,
        completion_rate: possibleVisits ? Math.round((visits.length / possibleVisits) * 100) : 0,
        party_performance,
        daily,
      },
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to build tracking analysis" }, { status: 500 });
  }
}
