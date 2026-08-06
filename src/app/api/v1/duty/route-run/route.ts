import { NextRequest, NextResponse } from "next/server";
import { istToday } from "@/lib/datetime";
import { normalizeCoordinates } from "@/lib/location-coordinates";
import { getUserFromToken, resolveCompanyScope, supabaseAdmin, type AuthUser } from "@/lib/supabase-server";
import {
  encodeSessionRouteRun,
  nextUnvisitedStopId,
  parseSessionRouteRun,
  type DutyRouteRunState,
  type DutyRouteVisit,
} from "@/lib/duty-signoff";

const GEOFENCE_METERS = 100;
const MAX_LOCATION_AGE_MS = 15_000;

type DbError = { code?: string; message?: string } | null | undefined;
type RouteRun = DutyRouteRunState;

type DutySession = {
  id: string;
  salesman_id: string;
  date: string;
  status: string;
  notes?: string | null;
};

async function saveSessionRouteRun(duty: DutySession, run: RouteRun) {
  return supabaseAdmin
    .from("salesman_day_sessions")
    .update({ notes: encodeSessionRouteRun(run, duty.notes), updated_at: run.updated_at })
    .eq("id", duty.id)
    .eq("salesman_id", duty.salesman_id)
    .eq("date", duty.date);
}

function isSchemaGap(error: DbError): boolean {
  if (!error) return false;
  const message = String(error.message || "").toLowerCase();
  return ["42P01", "42703", "PGRST200", "PGRST204", "PGRST205"].includes(error.code || "") ||
    message.includes("does not exist") || message.includes("schema cache") || message.includes("could not find");
}

async function ensureRouteRunTable(): Promise<boolean> {
  const { error } = await supabaseAdmin.rpc("exec_sql", {
    sql: `
      CREATE TABLE IF NOT EXISTS public.salesman_route_runs (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        salesman_id uuid NOT NULL,
        company_id uuid,
        route_id uuid NOT NULL,
        work_date date NOT NULL,
        status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed')),
        ordered_stop_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
        visits jsonb NOT NULL DEFAULT '[]'::jsonb,
        total_stops integer NOT NULL DEFAULT 0,
        active_stop_id uuid,
        signoff_request jsonb,
        started_at timestamptz NOT NULL DEFAULT now(),
        completed_at timestamptz,
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (salesman_id, work_date)
      );
      ALTER TABLE public.salesman_route_runs
        ADD COLUMN IF NOT EXISTS active_stop_id uuid,
        ADD COLUMN IF NOT EXISTS signoff_request jsonb;
      CREATE INDEX IF NOT EXISTS idx_salesman_route_runs_company_date
        ON public.salesman_route_runs(company_id, work_date);
      ALTER TABLE public.salesman_route_runs ENABLE ROW LEVEL SECURITY;
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_policies
          WHERE tablename = 'salesman_route_runs' AND policyname = 'service_role_all'
        ) THEN
          CREATE POLICY service_role_all ON public.salesman_route_runs
            FOR ALL TO service_role USING (true) WITH CHECK (true);
        END IF;
      END $$;
      NOTIFY pgrst, 'reload schema';
    `,
  });
  return !error;
}

function salesmanIds(user: AuthUser): string[] {
  return [...new Set([user.app_user_id, user.id].filter((id): id is string => Boolean(id)))];
}

async function getDutySession(id: string, date: string) {
  return supabaseAdmin
    .from("salesman_day_sessions")
    .select("*")
    .eq("salesman_id", id)
    .eq("date", date)
    .maybeSingle();
}

async function readRun(id: string, date: string) {
  let result = await supabaseAdmin
    .from("salesman_route_runs")
    .select("*")
    .eq("salesman_id", id)
    .eq("work_date", date)
    .maybeSingle();
  if (result.error && isSchemaGap(result.error) && await ensureRouteRunTable()) {
    result = await supabaseAdmin
      .from("salesman_route_runs")
      .select("*")
      .eq("salesman_id", id)
      .eq("work_date", date)
      .maybeSingle();
  }
  return result;
}

async function findDutyAndRun(ids: string[], date: string) {
  for (const id of ids) {
    const [duty, run] = await Promise.all([getDutySession(id, date), readRun(id, date)]);
    const dutyData = duty.data as DutySession | null;
    const sessionRun = parseSessionRouteRun(dutyData?.notes);
    const tableRun = run.data as RouteRun | null;
    const sessionIsNewer = Boolean(tableRun && sessionRun && new Date(sessionRun.updated_at).getTime() > new Date(tableRun.updated_at).getTime());
    const routeRun = sessionIsNewer ? sessionRun : tableRun
      ? {
          ...tableRun,
          active_stop_id: tableRun.active_stop_id || sessionRun?.active_stop_id || null,
          signoff_request: tableRun.signoff_request || sessionRun?.signoff_request || null,
        }
      : sessionRun;
    if (dutyData || routeRun) return { salesmanId: id, duty: dutyData, run: routeRun };
  }
  return { salesmanId: ids[0], duty: null, run: null };
}

async function resolveStopParty(routeId: string, stopId: string): Promise<string | null> {
  for (const column of ["party_id", "retailer_id", "store_id", "outlet_id"] as const) {
    const result = await supabaseAdmin
      .from("route_stops")
      .select(`id, ${column}`)
      .eq("id", stopId)
      .eq("route_id", routeId)
      .maybeSingle();
    if (!result.error) return ((result.data as unknown as Record<string, unknown> | null)?.[column] as string | null) || null;
    if (!isSchemaGap(result.error)) return null;
  }
  return null;
}

async function routeBelongsToSalesman(routeId: string, ids: string[]): Promise<boolean> {
  for (const column of ["salesman_id", "assigned_user_id"] as const) {
    const result = await supabaseAdmin.from("routes").select(`id, ${column}`).eq("id", routeId).maybeSingle();
    if (!result.error && result.data) {
      const assigned = (result.data as unknown as Record<string, unknown>)[column] as string | null;
      return !assigned || ids.includes(assigned);
    }
    if (!isSchemaGap(result.error)) return false;
  }
  return false;
}

function distanceMeters(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }) {
  const radius = 6_371_000;
  const dLat = ((b.latitude - a.latitude) * Math.PI) / 180;
  const dLng = ((b.longitude - a.longitude) * Math.PI) / 180;
  const lat1 = (a.latitude * Math.PI) / 180;
  const lat2 = (b.latitude * Math.PI) / 180;
  const value = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return radius * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

async function trustedLatestLocation(salesmanId: string) {
  const { data, error } = await supabaseAdmin
    .from("salesman_location_logs")
    .select("latitude, longitude, recorded_at")
    .eq("salesman_id", salesmanId)
    .order("recorded_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  const coordinates = normalizeCoordinates(data.latitude, data.longitude);
  if (!coordinates) return null;
  const recordedAt = new Date(data.recorded_at).getTime();
  if (!Number.isFinite(recordedAt) || Date.now() - recordedAt > MAX_LOCATION_AGE_MS) return null;
  return { ...coordinates, recorded_at: data.recorded_at as string };
}

async function recordAdminVisibleVisit(input: {
  user: AuthUser;
  salesmanId: string;
  companyId: string | null;
  routeId: string;
  partyId: string;
  location: { latitude: number; longitude: number };
  distance: number;
  notes: string;
  now: string;
  date: string;
}) {
  const full: Record<string, unknown> = {
    salesman_id: input.salesmanId,
    party_id: input.partyId,
    route_id: input.routeId,
    visit_date: input.date,
    check_in_time: input.now,
    check_out_time: input.now,
    check_in_lat: input.location.latitude,
    check_in_lng: input.location.longitude,
    is_within_geofence: true,
    deviation_meters: Math.round(input.distance),
    notes: input.notes,
    ...(input.companyId ? { company_id: input.companyId } : {}),
  };
  let visit = await supabaseAdmin.from("party_visits").insert(full);
  if (visit.error && isSchemaGap(visit.error)) {
    visit = await supabaseAdmin.from("party_visits").insert({
      salesman_id: input.salesmanId,
      party_id: input.partyId,
      route_id: input.routeId,
      visit_date: input.date,
      check_in_time: input.now,
    });
  }
  if (visit.error && !isSchemaGap(visit.error)) {
    console.warn("[route-run] party_visits mirror failed:", visit.error.message);
  }

  const manual = await supabaseAdmin.from("party_visit_logs").insert({
    party_id: input.partyId,
    visited_by: input.salesmanId,
    visited_by_name: input.user.name || "Salesman",
    visit_date: input.now,
    notes: input.notes,
  });
  if (manual.error && !isSchemaGap(manual.error)) {
    console.warn("[route-run] party_visit_logs mirror failed:", manual.error.message);
  }
}

export async function GET(req: NextRequest) {
  const user = await getUserFromToken(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const requestedId = req.nextUrl.searchParams.get("salesman_id");
  const date = req.nextUrl.searchParams.get("date") || istToday();
  const ownIds = salesmanIds(user);
  const isSalesman = user.role === "SALESMAN";
  const ids = isSalesman || !requestedId ? ownIds : [requestedId];
  const state = await findDutyAndRun(ids, date);

  if (!isSalesman && state.run) {
    const companyId = await resolveCompanyScope(req, user);
    if (companyId && state.run.company_id && state.run.company_id !== companyId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  let routeName: string | null = null;
  if (state.run?.route_id) {
    const route = await supabaseAdmin.from("routes").select("name").eq("id", state.run.route_id).maybeSingle();
    routeName = (route.data?.name as string | undefined) || null;
  }

  return NextResponse.json({
    data: {
      duty: state.duty || null,
      run: state.run ? { ...state.run, route_name: routeName } : null,
      geofence_meters: GEOFENCE_METERS,
    },
  });
}

export async function POST(req: NextRequest) {
  try {
    const user = await getUserFromToken(req);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (user.role !== "SALESMAN") {
      return NextResponse.json({ error: "Only salesmen can start or update a field route" }, { status: 403 });
    }

    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    const action = body.action;
    const date = istToday();
    const ids = salesmanIds(user);
    const state = await findDutyAndRun(ids, date);
    const salesmanId = state.salesmanId;

    if (!state.duty || state.duty.status !== "active") {
      return NextResponse.json({ error: "Start duty before selecting or updating a route" }, { status: 409 });
    }

    if (action === "start") {
      const routeId = String(body.route_id || "");
      const orderedStopIds = Array.isArray(body.ordered_stop_ids)
        ? [...new Set(body.ordered_stop_ids.map(String).filter(Boolean))]
        : [];
      if (!routeId || orderedStopIds.length === 0) {
        return NextResponse.json({ error: "A route with at least one stop is required" }, { status: 400 });
      }
      if (state.run) {
        if (state.run.route_id !== routeId) {
          return NextResponse.json({ error: "Today is already locked to another route", data: state.run }, { status: 409 });
        }
        return NextResponse.json({ data: state.run });
      }
      if (!await routeBelongsToSalesman(routeId, ids)) {
        return NextResponse.json({ error: "This route is not assigned to you" }, { status: 403 });
      }

      const validStopIds: string[] = [];
      for (const stopId of orderedStopIds) {
        if (await resolveStopParty(routeId, stopId)) validStopIds.push(stopId);
      }
      if (validStopIds.length !== orderedStopIds.length) {
        return NextResponse.json({ error: "One or more selected stops do not belong to this route" }, { status: 400 });
      }

      const companyId = await resolveCompanyScope(req, user) || user.party_id || null;
      let insert = await supabaseAdmin.from("salesman_route_runs").insert({
        salesman_id: salesmanId,
        company_id: companyId,
        route_id: routeId,
        work_date: date,
        ordered_stop_ids: validStopIds,
        total_stops: validStopIds.length,
        active_stop_id: validStopIds[0],
        status: "active",
      }).select("*").single();
      if (insert.error && isSchemaGap(insert.error) && await ensureRouteRunTable()) {
        insert = await supabaseAdmin.from("salesman_route_runs").insert({
          salesman_id: salesmanId,
          company_id: companyId,
          route_id: routeId,
          work_date: date,
          ordered_stop_ids: validStopIds,
          total_stops: validStopIds.length,
          active_stop_id: validStopIds[0],
          status: "active",
        }).select("*").single();
      }
      if (insert.error && isSchemaGap(insert.error)) {
        const now = new Date().toISOString();
        const fallbackRun: RouteRun = {
          id: `session-${state.duty.id}`,
          salesman_id: salesmanId,
          company_id: companyId,
          route_id: routeId,
          work_date: date,
          status: "active",
          ordered_stop_ids: validStopIds,
          visits: [],
          total_stops: validStopIds.length,
          active_stop_id: validStopIds[0],
          signoff_request: null,
          started_at: now,
          completed_at: null,
          updated_at: now,
        };
        const saved = await saveSessionRouteRun(state.duty as DutySession, fallbackRun);
        if (saved.error) throw saved.error;
        return NextResponse.json({ data: fallbackRun }, { status: 201 });
      }
      if (insert.error?.code === "23505") {
        const current = await readRun(salesmanId, date);
        return NextResponse.json({ error: "Today is already locked to a route", data: current.data }, { status: 409 });
      }
      if (insert.error) throw insert.error;
      return NextResponse.json({ data: insert.data }, { status: 201 });
    }

    if (action === "select_stop") {
      if (!state.run) return NextResponse.json({ error: "Start today's route first" }, { status: 409 });
      if (state.run.status !== "active") return NextResponse.json({ error: "Today's route is already complete" }, { status: 409 });

      const stopId = String(body.stop_id || "");
      if (!stopId || !state.run.ordered_stop_ids.includes(stopId)) {
        return NextResponse.json({ error: "This party is not part of today's locked route" }, { status: 400 });
      }
      if ((state.run.visits || []).some((visit) => visit.stop_id === stopId)) {
        return NextResponse.json({ error: "This party has already been visited" }, { status: 409 });
      }

      const now = new Date().toISOString();
      const update = await supabaseAdmin.from("salesman_route_runs").update({
        active_stop_id: stopId,
        updated_at: now,
      }).eq("id", state.run.id).eq("salesman_id", salesmanId).select("*").single();
      let updatedRun = update.data as RouteRun | null;
      if ((update.error && isSchemaGap(update.error)) || (!update.error && !update.data && state.run.id.startsWith("session-"))) {
        await ensureRouteRunTable();
        const retry = !state.run.id.startsWith("session-")
          ? await supabaseAdmin.from("salesman_route_runs").update({ active_stop_id: stopId, updated_at: now })
              .eq("id", state.run.id).eq("salesman_id", salesmanId).select("*").single()
          : null;
        if (retry?.data) {
          updatedRun = retry.data as RouteRun;
        } else {
          const fallbackRun: RouteRun = { ...state.run, active_stop_id: stopId, updated_at: now };
          const saved = await saveSessionRouteRun(state.duty as DutySession, fallbackRun);
          if (saved.error) throw saved.error;
          updatedRun = fallbackRun;
        }
      } else if (update.error) {
        throw update.error;
      }
      return NextResponse.json({ data: updatedRun });
    }

    if (action === "visit") {
      if (!state.run) return NextResponse.json({ error: "Start today's route first" }, { status: 409 });
      if (state.run.status !== "active") return NextResponse.json({ error: "Today's route is already complete" }, { status: 409 });

      const stopId = String(body.stop_id || "");
      const notes = String(body.notes || "").trim();
      if (!stopId || !state.run.ordered_stop_ids.includes(stopId)) {
        return NextResponse.json({ error: "This party is not part of today's locked route" }, { status: 400 });
      }
      if (notes.length < 3) {
        return NextResponse.json({ error: "Add a short visit note before marking this party visited" }, { status: 400 });
      }
      const existing = (state.run.visits || []).find((visit) => visit.stop_id === stopId);
      if (existing) return NextResponse.json({ data: state.run });

      const partyId = await resolveStopParty(state.run.route_id, stopId);
      if (!partyId) return NextResponse.json({ error: "Party could not be resolved for this stop" }, { status: 404 });
      const party = await supabaseAdmin.from("parties").select("id, latitude, longitude").eq("id", partyId).maybeSingle();
      const partyCoordinates = normalizeCoordinates(party.data?.latitude, party.data?.longitude);
      if (!partyCoordinates) {
        return NextResponse.json({ error: "This party has no verified GPS coordinates" }, { status: 422 });
      }

      const latest = await trustedLatestLocation(salesmanId);
      if (!latest) {
        return NextResponse.json({ error: "Waiting for a fresh trusted GPS update. Keep location enabled and try again." }, { status: 422 });
      }
      const distance = distanceMeters(latest, partyCoordinates);
      if (distance > GEOFENCE_METERS) {
        return NextResponse.json({
          error: `Move within ${GEOFENCE_METERS} m of the party before marking visited`,
          distance_meters: Math.round(distance),
        }, { status: 422 });
      }

      const now = new Date().toISOString();
      const visit: DutyRouteVisit = {
        stop_id: stopId,
        party_id: partyId,
        visited_at: now,
        latitude: latest.latitude,
        longitude: latest.longitude,
        distance_m: Math.round(distance),
        notes,
      };
      const visits = [...(state.run.visits || []), visit];
      const completed = visits.length >= state.run.total_stops;
      const nextStatus: RouteRun["status"] = completed ? "completed" : "active";
      const activeStopId = completed ? null : nextUnvisitedStopId({ ...state.run, visits, active_stop_id: null });
      const updatePayload = {
        visits,
        status: nextStatus,
        active_stop_id: activeStopId,
        completed_at: completed ? now : null,
        updated_at: now,
      };
      const update = await supabaseAdmin.from("salesman_route_runs").update(updatePayload)
        .eq("id", state.run.id).eq("salesman_id", salesmanId).select("*").single();
      let updatedRun = update.data as RouteRun | null;
      if ((update.error && isSchemaGap(update.error)) || (!update.error && !update.data && state.run.id.startsWith("session-"))) {
        await ensureRouteRunTable();
        const retry = !state.run.id.startsWith("session-")
          ? await supabaseAdmin.from("salesman_route_runs").update(updatePayload)
              .eq("id", state.run.id).eq("salesman_id", salesmanId).select("*").single()
          : null;
        if (retry?.data) {
          updatedRun = retry.data as RouteRun;
        } else {
          const fallbackRun: RouteRun = { ...state.run, ...updatePayload };
          const saved = await saveSessionRouteRun(state.duty as DutySession, fallbackRun);
          if (saved.error) throw saved.error;
          updatedRun = fallbackRun;
        }
      } else if (update.error) {
        throw update.error;
      }

      await Promise.all([
        recordAdminVisibleVisit({
          user,
          salesmanId,
          companyId: state.run.company_id,
          routeId: state.run.route_id,
          partyId,
          location: latest,
          distance,
          notes,
          now,
          date,
        }),
        supabaseAdmin.from("salesman_day_sessions").update({ total_stops: visits.length, updated_at: now })
          .eq("salesman_id", salesmanId).eq("date", date),
      ]);

      return NextResponse.json({ data: updatedRun });
    }

    return NextResponse.json({ error: "Unsupported action" }, { status: 400 });
  } catch (error) {
    console.error("[route-run] error:", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Route update failed" }, { status: 500 });
  }
}
