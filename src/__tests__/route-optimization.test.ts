import { describe, expect, it } from "vitest";
import { haversineMeters, optimizeStopsByDistance } from "@/lib/route-optimization";

describe("route optimization", () => {
  it("computes realistic geofence distances", () => {
    expect(haversineMeters({ latitude: 26, longitude: 88 }, { latitude: 26.0009, longitude: 88 }))
      .toBeGreaterThan(99);
  });

  it("places the nearest stop first without dropping stops", () => {
    const stops = [
      { id: "far", latitude: 26.03, longitude: 88 },
      { id: "near", latitude: 26.001, longitude: 88 },
      { id: "middle", latitude: 26.01, longitude: 88 },
    ];
    const result = optimizeStopsByDistance({ latitude: 26, longitude: 88 }, stops);
    expect(result.map((stop) => stop.id)).toEqual(["near", "middle", "far"]);
  });
});

