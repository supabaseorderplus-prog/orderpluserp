import { describe, expect, it } from "vitest";
import {
  normalizeCoordinates,
  REQUIRED_PARTY_LOCATION_MESSAGE,
  validateRequiredCoordinates,
} from "@/lib/location-coordinates";

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

describe("validateRequiredCoordinates", () => {
  it("requires both latitude and longitude", () => {
    expect(validateRequiredCoordinates("", "")).toEqual({
      success: false,
      message: REQUIRED_PARTY_LOCATION_MESSAGE,
    });
    expect(validateRequiredCoordinates("22.5726", null)).toEqual({
      success: false,
      message: REQUIRED_PARTY_LOCATION_MESSAGE,
    });
  });

  it("rejects invalid and out-of-range coordinates", () => {
    expect(validateRequiredCoordinates("north", "88.3639").success).toBe(false);
    expect(validateRequiredCoordinates("91", "88.3639").success).toBe(false);
    expect(validateRequiredCoordinates("0", "0").success).toBe(false);
  });

  it("returns a normalized required coordinate pair", () => {
    expect(validateRequiredCoordinates("22.57261234", "88.36389249")).toEqual({
      success: true,
      coordinates: { latitude: 22.572612, longitude: 88.363892 },
    });
  });
});
