import { describe, expect, it } from "vitest";
import { buildVerifiedTrail, evaluateTrackingSegment } from "@/lib/tracking-integrity";

const p = (latitude: number, longitude: number, seconds: number, accuracy = 5) => ({
  latitude,
  longitude,
  accuracy,
  recorded_at: new Date(Date.UTC(2026, 7, 2, 3, 30, seconds)).toISOString(),
});

describe("tracking integrity", () => {
  it("does not count ordinary stationary GPS jitter", () => {
    const trail = buildVerifiedTrail([
      p(25.472, 87.9468, 0),
      p(25.47202, 87.94679, 5),
      p(25.47198, 87.94682, 10),
      p(25.47201, 87.94681, 15),
    ]);
    expect(trail.distanceKm).toBe(0);
    expect(trail.points).toHaveLength(1);
  });

  it("rejects a kilometre-scale jump arriving within seconds", () => {
    const decision = evaluateTrackingSegment(
      p(25.472, 87.9468, 0),
      p(25.49, 87.96, 5),
    );
    expect(decision.accepted).toBe(false);
    expect(decision.reason).toBe("implausible");
  });

  it("trusts a stationary sensor reading over a displaced coordinate", () => {
    const decision = evaluateTrackingSegment(
      p(25.472, 87.9468, 0, 4),
      { ...p(25.473, 87.9478, 5, 4), speed: 0.2 },
    );
    expect(decision.accepted).toBe(false);
    expect(decision.reason).toBe("stationary");
  });

  it("collapses a bounded legacy jitter cloud when speed was not recorded", () => {
    const trail = buildVerifiedTrail([
      p(25.4720, 87.9468, 0, 25),
      p(25.4727, 87.9472, 10, 25),
      p(25.4716, 87.9471, 20, 25),
      p(25.4721, 87.9467, 30, 4),
    ]);
    expect(trail.distanceKm).toBe(0);
    expect(trail.points).toHaveLength(1);
  });

  it("collapses a short closed GPS scribble even when fixes report false speed", () => {
    const trail = buildVerifiedTrail([
      p(25.4720, 87.9468, 0, 4),
      { ...p(25.4727, 87.9472, 10, 4), speed: 8 },
      { ...p(25.4715, 87.9474, 20, 4), speed: 8 },
      { ...p(25.4718, 87.9465, 30, 4), speed: 8 },
      { ...p(25.4721, 87.94675, 40, 4), speed: 8 },
    ]);
    expect(trail.distanceKm).toBe(0);
    expect(trail.points).toHaveLength(1);
  });

  it("starts a new segment after a signal gap without inventing distance", () => {
    const start = { ...p(25.472, 87.9468, 0), recorded_at: "2026-08-02T03:30:00.000Z" };
    const resumed = { ...p(25.482, 87.9568, 0), recorded_at: "2026-08-02T03:40:00.000Z" };
    const trail = buildVerifiedTrail([start, resumed]);
    expect(trail.distanceKm).toBe(0);
    expect(trail.points[1].break_before).toBe(true);
  });

  it("counts continuous, plausible movement", () => {
    const trail = buildVerifiedTrail([
      p(25.472, 87.9468, 0),
      { ...p(25.4722, 87.9468, 10), speed: 2.2 },
      { ...p(25.4724, 87.9468, 20), speed: 2.2 },
    ]);
    expect(trail.points).toHaveLength(3);
    expect(trail.distanceKm).toBeGreaterThan(0.04);
    expect(trail.distanceKm).toBeLessThan(0.05);
  });
});
