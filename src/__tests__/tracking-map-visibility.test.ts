import { describe, expect, it } from "vitest";
import {
  belongsToSelectedTrackingUser,
  getVisibleTrackingUsers,
  newestTrackingLocation,
} from "@/lib/tracking-map-visibility";

const users = [
  { id: "gopal", name: "Gopal Das" },
  { id: "jiten", name: "Jiten Roy" },
  { id: "sahil", name: "Sahil Islam" },
];

describe("getVisibleTrackingUsers", () => {
  it("shows the whole team in overview mode", () => {
    expect(getVisibleTrackingUsers(users, null)).toEqual(users);
  });

  it("shows only the opened salesman's marker in timeline mode", () => {
    expect(getVisibleTrackingUsers(users, "gopal")).toEqual([
      { id: "gopal", name: "Gopal Das" },
    ]);
  });

  it("does not fall back to other users when the selected id has no pin", () => {
    expect(getVisibleTrackingUsers(users, "missing")).toEqual([]);
  });

  it("adds realtime trail points only for the opened salesman", () => {
    expect(belongsToSelectedTrackingUser("gopal", "gopal")).toBe(true);
    expect(belongsToSelectedTrackingUser("gopal", "jiten")).toBe(false);
    expect(belongsToSelectedTrackingUser(null, "gopal")).toBe(false);
  });

  it("keeps the freshest location when messages arrive out of order", () => {
    const older = { recorded_at: "2026-07-08T05:00:00.000Z", latitude: 1 };
    const newer = { recorded_at: "2026-07-08T05:01:00.000Z", latitude: 2 };
    expect(newestTrackingLocation(older, newer)).toBe(newer);
    expect(newestTrackingLocation(newer, older)).toBe(newer);
  });
});
