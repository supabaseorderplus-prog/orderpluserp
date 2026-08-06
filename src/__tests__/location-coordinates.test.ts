import { describe, expect, it } from "vitest";
import { normalizeCoordinates } from "@/lib/location-coordinates";

describe("normalizeCoordinates", () => {
  it("does not turn missing coordinates into Null Island", () => {
    expect(normalizeCoordinates(null, null)).toBeNull();
    expect(normalizeCoordinates(undefined, undefined)).toBeNull();
    expect(normalizeCoordinates("", "")).toBeNull();
    expect(normalizeCoordinates(0, 0)).toBeNull();
    expect(normalizeCoordinates("0", "0")).toBeNull();
  });

  it("accepts finite numeric coordinates and numeric database strings", () => {
    expect(normalizeCoordinates(22.5726, 88.3639)).toEqual({ latitude: 22.5726, longitude: 88.3639 });
    expect(normalizeCoordinates("22.5726", "88.3639")).toEqual({ latitude: 22.5726, longitude: 88.3639 });
  });

  it("rejects coordinates outside geographic bounds", () => {
    expect(normalizeCoordinates(91, 88)).toBeNull();
    expect(normalizeCoordinates(22, 181)).toBeNull();
  });
});
