import { NextRequest, NextResponse } from "next/server";
import { istToday } from "@/lib/datetime";
import {
  encodeSessionRouteRun,
  parseSessionRouteRun,
  remainingStopIds,
  SESSION_ROUTE_RUN_PREFIX,
  type DutyRouteRunState,
  type DutySignoffRequest,
} from "@/lib/duty-signoff";
import { getUserFromToken, hasModulePermission, resolveCompanyScope, supabaseAdmin, type AuthUser } from "@/lib/supabase-server";

type DbError = { code?: string; message?: string } | null | undefined;
type DutySessionRow = { id: string; salesman_id: string; date: string; notes: string | null; status: string };
let signoffColumnsReady = false;

function isSchemaGap(error: DbError): boolean {
  if (!error) return false;
  const message = String(error.message || "").toLowerCase();
  return ["42P01", "42703", "PGRST200", "PGRST204", "PGRST205"].includes(error.code || "") ||
    message.includes("does not exist") || message.includes("schema cache") || message.includes("could not find");
}

function salesmanIds(user: AuthUser): string[] {
  return [...new Set([user.app_user_id, user.id].filter((id): id is string => Boolean(id)))];
}

async function ensureSignoffColumns() {
  if (signoffColumnsReady) return;
  const { error } = await supabaseAdmin.rpc("exec_sql", {
    sql: `
      ALTER TABLE public.salesman_route_runs
        ADD COLUMN IF NOT EXISTS active_stop_id uuid,
        ADD COLUMN IF NOT EXISTS signoff_request jsonb;
      NOTIFY pgrst, 'reload schema';
    `,
  });
  if (!error) signoffColumnsReady = true;
}

async function loadDuty(id: string, date: string) {
  return supabaseAdmin.from("salesman_day_sessions").select("*")
    .eq("salesman_id", id).eq("date", date).maybeSingle();
}

async function loadRunForSalesman(ids: string[], date: string) {
  for (const id of ids) {
    const [runResult, dutyResult] = await Promise.all([
      supabaseAdmin.from("salesman_route_runs").select("*")
        .eq("salesman_id", id).eq("work_date", date).maybeSingle(),
      loadDuty(id, date),
    ]);
    const duty = dutyResult.data as DutySessionRow | null;
    const sessionRun = parseSessionRouteRun(duty?.notes);
    const tableRun = runResult.data as DutyRouteRunState | null;
    const sessionIsNewer = Boolean(tableRun && sessionRun && new Date(sessionRun.updated_at).getTime() > new Date(tableRun.updated_at).getTime());
    const run = sessionIsNewer ? sessionRun : tableRun
      ? {
          ...tableRun,
          active_stop_id: tableRun.active_stop_id || sessionRun?.active_stop_id || null,
          signoff_request: tableRun.signoff_request || sessionRun?.signoff_request || null,
        }
      : sessionRun;
    if (run || duty) return { run, duty, salesmanId: id };
  }
  return { run: null, duty: null, salesmanId: ids[0] };
}

async function saveRunSignoff(run: DutyRouteRunState, duty: DutySessionRow | null, signoff: DutySignoffRequest) {
  const now = new Date().toISOString();
  if (!run.id.startsWith("session-")) {
    await ensureSignoffColumns();
    const updated = await supabaseAdmin.from("salesman_route_runs")
      .update({ signoff_request: signoff, updated_at: now })
      .eq("id", run.id).select("*").single();
    if (!updated.error && updated.data) return updated.data as DutyRouteRunState;
    if (!isSchemaGap(updated.error)) throw updated.error;
  }

  if (!duty) throw new Error("Today's duty session could not be found");
  const fallbackRun: DutyRouteRunState = { ...run, signoff_request: signoff, updated_at: now };
  const saved = await supabaseAdmin.from("salesman_day_sessions")
    .update({ notes: encodeSessionRouteRun(fallbackRun, duty.notes), updated_at: now })
    .eq("id", duty.id).eq("salesman_id", duty.salesman_id).eq("date", duty.date);
  if (saved.error) throw saved.error;
  return fallbackRun;
}

async function resolveStopParties(routeId: string, stopIds: string[]) {
  if (stopIds.length === 0) return [];

  const partyByStop = new Map<string, string>();
  for (const column of ["party_id", "retailer_id", "store_id", "outlet_id"] as const) {
    const result = await supabaseAdmin.from("route_stops").select(`id, ${column}`)
      .eq("route_id", routeId).in("id", stopIds);
    if (!result.error) {
      for (const row of (result.data || []) as unknown as Array<Record<string, unknown>>) {
        const partyId = String(row[column] || "");
        if (partyId) partyByStop.set(String(row.id), partyId);
      }
      break;
    }
    if (!isSchemaGap(result.error)) break;
  }

  const partyIds = [...new Set(partyByStop.values())];
  if (partyIds.length === 0) return [];
  const parties = await supabaseAdmin.from("parties").select("id,name").in("id", partyIds);
  const partyNames = new Map(((parties.data || []) as Array<{ id: string; name: string | null }>).map((party) => [party.id, party.name]));

  return stopIds.flatMap((stopId) => {
    const partyId = partyByStop.get(stopId);
    return partyId ? [{ stop_id: stopId, party_id: partyId, name: String(partyNames.get(partyId) || "Party") }] : [];
  });
}

async function presentQueue(runs: DutyRouteRunState[]) {
  const salesmanIdList = [...new Set(runs.map((run) => run.salesman_id))];
  const routeIdList = [...new Set(runs.map((run) => run.route_id))];
  const [users, appUsers, routes] = await Promise.all([
    salesmanIdList.length
      ? supabaseAdmin.from("users").select("id,name").in("id", salesmanIdList)
      : Promise.resolve({ data: [] }),
    salesmanIdList.length
      ? supabaseAdmin.from("app_users").select("id,name").in("id", salesmanIdList)
      : Promise.resolve({ data: [] }),
    routeIdList.length
      ? supabaseAdmin.from("routes").select("id,name").in("id", routeIdList)
      : Promise.resolve({ data: [] }),
  ]);
  const userRows = [
    ...((users.data || []) as Array<{ id: string; name: string | null }>),
    ...((appUsers.data || []) as Array<{ id: string; name: string | null }>),
  ];
  const userNames = new Map(userRows.map((row) => [row.id, row.name]));
  const unresolvedIds = salesmanIdList.filter((id) => !userNames.get(id));
  await Promise.all(unresolvedIds.map(async (id) => {
    const { data } = await supabaseAdmin.auth.admin.getUserById(id);
    const authUser = data?.user;
    if (!authUser) return;
    const metadata = authUser.user_metadata || {};
    const name = String(metadata.full_name || metadata.name || metadata.display_name || authUser.email?.split("@")[0] || "").trim();
    if (name) userNames.set(id, name);
  }));
  const routeNames = new Map(((routes.data || []) as Array<{ id: string; name: string | null }>).map((row) => [row.id, row.name]));

  return Promise.all(runs.map(async (run) => {
    const request = run.signoff_request!;
    const remaining = request.remaining_stop_ids?.length ? request.remaining_stop_ids : remainingStopIds(run);
    return {
      run_id: run.id,
      salesman_id: run.salesman_id,
      salesman_name: userNames.get(run.salesman_id) || "Salesman",
      route_id: run.route_id,
      route_name: routeNames.get(run.route_id) || "Selected route",
      work_date: run.work_date,
      total_stops: run.total_stops,
      visited_stops: run.visits.length,
      remaining_stops: remaining.length,
      remaining_parties: await resolveStopParties(run.route_id, remaining),
      request,
    };
  }));
}

// Admin queue for incomplete-route sign-off requests.
export async function GET(req: NextRequest) {
  try {
    const user = await getUserFromToken(req);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const [canView, canApprove] = await Promise.all([
      hasModulePermission(user, "approval_requests", "can_view"),
      hasModulePermission(user, "approval_requests", "can_approve"),
    ]);
    if (!canView) {
      return NextResponse.json({ error: "You do not have access to approval requests" }, { status: 403 });
    }

    const companyId = await resolveCompanyScope(req, user) || (user.role === "ADMIN" ? user.party_id : null);
    let query = supabaseAdmin.from("salesman_route_runs").select("*")
      .not("signoff_request", "is", null).order("updated_at", { ascending: false }).limit(100);
    if (companyId) query = query.eq("company_id", companyId);
    const result = await query;
    const tableRuns = result.error && isSchemaGap(result.error) ? [] : (result.data || []) as DutyRouteRunState[];
    if (result.error && !isSchemaGap(result.error)) throw result.error;

    const sessions = await supabaseAdmin.from("salesman_day_sessions").select("*")
      .like("notes", `${SESSION_ROUTE_RUN_PREFIX}%`).order("updated_at", { ascending: false }).limit(200);
    const sessionRuns = ((sessions.data || []) as DutySessionRow[])
      .map((session) => parseSessionRouteRun(session.notes))
      .filter((run): run is DutyRouteRunState => Boolean(run?.signoff_request));
    const byId = new Map<string, DutyRouteRunState>();
    [...sessionRuns, ...tableRuns].forEach((run) => {
      if ((!companyId || run.company_id === companyId) && run.signoff_request) {
        const current = byId.get(run.id);
        if (!current || new Date(run.updated_at).getTime() >= new Date(current.updated_at).getTime()) byId.set(run.id, run);
      }
    });
    const status = req.nextUrl.searchParams.get("status") || "pending";
    const runs = [...byId.values()].filter((run) => status === "all" || run.signoff_request?.status === status);
    return NextResponse.json({ data: await presentQueue(runs), meta: { can_approve: canApprove } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not load sign-off requests" }, { status: 500 });
  }
}

// Salesman submits or resubmits a reason for an incomplete route.
export async function POST(req: NextRequest) {
  try {
    const user = await getUserFromToken(req);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (user.role !== "SALESMAN") {
      return NextResponse.json({ error: "Only salesmen can request early duty sign-off" }, { status: 403 });
    }
    const body = await req.json().catch(() => ({}));
    const reason = String(body.reason || "").trim().slice(0, 1000);
    if (reason.length < 10) {
      return NextResponse.json({ error: "Explain why the remaining party could not be visited (at least 10 characters)" }, { status: 400 });
    }
    const state = await loadRunForSalesman(salesmanIds(user), istToday());
    if (!state.duty || state.duty.status !== "active") {
      return NextResponse.json({ error: "No active duty session was found" }, { status: 409 });
    }
    if (!state.run) return NextResponse.json({ error: "Select today's route before requesting sign-off" }, { status: 409 });
    const remaining = remainingStopIds(state.run);
    if (remaining.length === 0) {
      return NextResponse.json({ error: "All route parties are complete. You can end duty normally." }, { status: 409 });
    }
    if (state.run.signoff_request?.status === "approved") {
      return NextResponse.json({ data: state.run, message: "Sign-off is already approved" });
    }

    const now = new Date().toISOString();
    const request: DutySignoffRequest = {
      id: state.run.signoff_request?.id || crypto.randomUUID(),
      status: "pending",
      reason,
      remaining_stop_ids: remaining,
      requested_at: now,
      decided_at: null,
      decided_by: null,
      decided_by_name: null,
      decision_note: null,
    };
    const updated = await saveRunSignoff(state.run, state.duty, request);
    return NextResponse.json({ data: updated, message: "Sign-off request sent to the admin" }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not request sign-off" }, { status: 500 });
  }
}

// Admin approves or rejects an incomplete-route sign-off request.
export async function PATCH(req: NextRequest) {
  try {
    const user = await getUserFromToken(req);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!await hasModulePermission(user, "approval_requests", "can_approve")) {
      return NextResponse.json({ error: "You do not have permission to decide approval requests" }, { status: 403 });
    }
    const body = await req.json().catch(() => ({}));
    const runId = String(body.run_id || "");
    const action = String(body.action || "").toLowerCase();
    const decisionNote = String(body.decision_note || "").trim().slice(0, 1000) || null;
    if (!runId || !["approve", "reject"].includes(action)) {
      return NextResponse.json({ error: "A request and valid decision are required" }, { status: 400 });
    }
    if (action === "reject" && !decisionNote) {
      return NextResponse.json({ error: "Add a reason before rejecting the request" }, { status: 400 });
    }

    let run: DutyRouteRunState | null = null;
    let duty: DutySessionRow | null = null;
    if (runId.startsWith("session-")) {
      const sessionId = runId.slice("session-".length);
      const result = await supabaseAdmin.from("salesman_day_sessions").select("*").eq("id", sessionId).maybeSingle();
      duty = result.data as DutySessionRow | null;
      run = parseSessionRouteRun(duty?.notes);
    } else {
      const result = await supabaseAdmin.from("salesman_route_runs").select("*").eq("id", runId).maybeSingle();
      run = result.data as DutyRouteRunState | null;
      if (run) {
        const dutyResult = await loadDuty(run.salesman_id, run.work_date);
        duty = dutyResult.data as DutySessionRow | null;
        const sessionRun = parseSessionRouteRun(duty?.notes);
        if (!run.signoff_request && sessionRun?.signoff_request) run = { ...run, signoff_request: sessionRun.signoff_request };
      }
    }
    if (!run?.signoff_request) return NextResponse.json({ error: "Sign-off request not found" }, { status: 404 });
    if (run.signoff_request.status !== "pending") {
      return NextResponse.json({ error: `This request is already ${run.signoff_request.status}` }, { status: 409 });
    }
    const companyId = await resolveCompanyScope(req, user) || (user.role === "ADMIN" ? user.party_id : null);
    if (companyId && run.company_id && companyId !== run.company_id) {
      return NextResponse.json({ error: "This request is outside your company" }, { status: 403 });
    }

    const now = new Date().toISOString();
    const request: DutySignoffRequest = {
      ...run.signoff_request,
      status: action === "approve" ? "approved" : "rejected",
      decided_at: now,
      decided_by: user.app_user_id || user.id,
      decided_by_name: user.name || "Admin",
      decision_note: decisionNote,
    };
    const updated = await saveRunSignoff(run, duty, request);
    return NextResponse.json({ data: updated, message: `Sign-off ${request.status}` });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not update sign-off request" }, { status: 500 });
  }
}
