export const SESSION_ROUTE_RUN_PREFIX = "ORDERPLUS_ROUTE_RUN_V1:";

export type DutySignoffStatus = "pending" | "approved" | "rejected";

export interface DutySignoffRequest {
  id: string;
  status: DutySignoffStatus;
  reason: string;
  remaining_stop_ids: string[];
  requested_at: string;
  decided_at: string | null;
  decided_by: string | null;
  decided_by_name: string | null;
  decision_note: string | null;
}

export interface DutyRouteVisit {
  stop_id: string;
  party_id: string;
  visited_at: string;
  latitude: number;
  longitude: number;
  distance_m: number;
  notes: string;
}

export interface DutyRouteRunState {
  id: string;
  salesman_id: string;
  company_id: string | null;
  route_id: string;
  work_date: string;
  status: "active" | "completed";
  ordered_stop_ids: string[];
  visits: DutyRouteVisit[];
  total_stops: number;
  active_stop_id: string | null;
  signoff_request: DutySignoffRequest | null;
  started_at: string;
  completed_at: string | null;
  updated_at: string;
}

interface SessionRouteRunEnvelope {
  version: 1;
  run: DutyRouteRunState;
  previous_notes: string | null;
}

export function parseSessionRouteRun(notes: string | null | undefined): DutyRouteRunState | null {
  if (!notes?.startsWith(SESSION_ROUTE_RUN_PREFIX)) return null;
  try {
    const envelope = JSON.parse(notes.slice(SESSION_ROUTE_RUN_PREFIX.length)) as SessionRouteRunEnvelope;
    const run = envelope?.run;
    if (!run?.id || !run.route_id || !Array.isArray(run.ordered_stop_ids) || !Array.isArray(run.visits)) return null;
    return {
      ...run,
      active_stop_id: run.active_stop_id || null,
      signoff_request: run.signoff_request || null,
    };
  } catch {
    return null;
  }
}

export function previousSessionNotes(notes: string | null | undefined): string | null {
  if (!notes?.startsWith(SESSION_ROUTE_RUN_PREFIX)) return notes || null;
  try {
    const envelope = JSON.parse(notes.slice(SESSION_ROUTE_RUN_PREFIX.length)) as SessionRouteRunEnvelope;
    return envelope.previous_notes || null;
  } catch {
    return null;
  }
}

export function encodeSessionRouteRun(run: DutyRouteRunState, currentNotes: string | null | undefined): string {
  const envelope: SessionRouteRunEnvelope = {
    version: 1,
    run,
    previous_notes: previousSessionNotes(currentNotes),
  };
  return `${SESSION_ROUTE_RUN_PREFIX}${JSON.stringify(envelope)}`;
}

export function remainingStopIds(run: Pick<DutyRouteRunState, "ordered_stop_ids" | "visits">): string[] {
  const visited = new Set((run.visits || []).map((visit) => visit.stop_id));
  return (run.ordered_stop_ids || []).filter((stopId) => !visited.has(stopId));
}

export function canEndDuty(run: Pick<DutyRouteRunState, "ordered_stop_ids" | "visits" | "signoff_request"> | null): boolean {
  if (!run || remainingStopIds(run).length === 0) return true;
  return run.signoff_request?.status === "approved";
}

export function nextUnvisitedStopId(
  run: Pick<DutyRouteRunState, "ordered_stop_ids" | "visits" | "active_stop_id">,
): string | null {
  const remaining = remainingStopIds(run);
  if (run.active_stop_id && remaining.includes(run.active_stop_id)) return run.active_stop_id;
  return remaining[0] || null;
}
