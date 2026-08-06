import { describe, expect, it } from "vitest";
import { gpsAdminEvent } from "@/lib/gps-notification-policy";

describe("GPS admin notification policy", () => {
  it("alerts immediately when an on-duty salesman loses GPS", () => {
    expect(gpsAdminEvent({
      onDuty: true,
      current: { gps_enabled: false, permission_granted: true, service_active: true },
      previous: { gps_enabled: true, permission_granted: true, service_active: true },
      previousAgeMs: 10_000,
    })).toBe("lost");
  });

  it("does not flood the admin on every 45-second heartbeat", () => {
    expect(gpsAdminEvent({
      onDuty: true,
      current: { gps_enabled: false, permission_granted: true, service_active: true },
      previous: { gps_enabled: false, permission_granted: true, service_active: true },
      previousAgeMs: 45_000,
    })).toBeNull();
  });

  it("treats a stale prior outage as a new duty incident", () => {
    expect(gpsAdminEvent({
      onDuty: true,
      current: { gps_enabled: false, permission_granted: true, service_active: true },
      previous: { gps_enabled: false, permission_granted: true, service_active: true },
      previousAgeMs: 121_000,
    })).toBe("lost");
  });

  it("notifies recovery and ignores off-duty health changes", () => {
    expect(gpsAdminEvent({
      onDuty: true,
      current: { gps_enabled: true, permission_granted: true, service_active: true },
      previous: { gps_enabled: false, permission_granted: true, service_active: true },
      previousAgeMs: 45_000,
    })).toBe("restored");
    expect(gpsAdminEvent({
      onDuty: false,
      current: { gps_enabled: false, permission_granted: false, service_active: false },
      previous: null,
      previousAgeMs: Number.POSITIVE_INFINITY,
    })).toBeNull();
  });
});
