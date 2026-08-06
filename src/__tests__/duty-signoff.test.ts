import { describe, expect, it } from "vitest";
import { canEndDuty, nextUnvisitedStopId, remainingStopIds, type DutyRouteRunState } from "@/lib/duty-signoff";

function run(overrides: Partial<DutyRouteRunState> = {}): DutyRouteRunState {
  return {
    id: "run-1",
    salesman_id: "salesman-1",
    company_id: "company-1",
    route_id: "route-1",
    work_date: "2026-08-02",
    status: "active",
    ordered_stop_ids: ["1", "2", "3", "4", "5"],
    visits: [],
    total_stops: 5,
    active_stop_id: null,
    signoff_request: null,
    started_at: "2026-08-02T09:00:00.000Z",
    completed_at: null,
    updated_at: "2026-08-02T09:00:00.000Z",
    ...overrides,
  };
}

describe("duty sign-off rules", () => {
  it("allows the salesman to choose any remaining stop", () => {
    const value = run({
      active_stop_id: "5",
      visits: [{ stop_id: "1" } as DutyRouteRunState["visits"][number]],
    });
    expect(nextUnvisitedStopId(value)).toBe("5");
  });

  it("falls back to the smart suggestion after the chosen stop is visited", () => {
    const value = run({
      active_stop_id: "5",
      visits: [
        { stop_id: "1" } as DutyRouteRunState["visits"][number],
        { stop_id: "5" } as DutyRouteRunState["visits"][number],
      ],
    });
    expect(nextUnvisitedStopId(value)).toBe("2");
  });

  it("blocks an incomplete route until an admin approves sign-off", () => {
    const value = run({
      visits: ["1", "2", "3", "4"].map((stop_id) => ({ stop_id }) as DutyRouteRunState["visits"][number]),
    });
    expect(remainingStopIds(value)).toEqual(["5"]);
    expect(canEndDuty(value)).toBe(false);
    expect(canEndDuty({
      ...value,
      signoff_request: {
        id: "request-1",
        status: "approved",
        reason: "Party was closed despite two attempts.",
        remaining_stop_ids: ["5"],
        requested_at: "2026-08-02T17:00:00.000Z",
        decided_at: "2026-08-02T17:05:00.000Z",
        decided_by: "admin-1",
        decided_by_name: "Admin",
        decision_note: "Approved after phone confirmation.",
      },
    })).toBe(true);
  });

  it("allows normal sign-off after every party is visited", () => {
    const value = run({
      visits: ["1", "2", "3", "4", "5"].map((stop_id) => ({ stop_id }) as DutyRouteRunState["visits"][number]),
    });
    expect(canEndDuty(value)).toBe(true);
  });
});
