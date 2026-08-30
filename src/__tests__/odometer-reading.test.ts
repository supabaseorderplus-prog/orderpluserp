import { describe, expect, it } from "vitest";
import {
  encodeDutyOdometerEvidence,
  extractOdometerReading,
  parseDutyOdometerEvidence,
  validateOdometerProgress,
} from "@/lib/odometer-reading";

describe("extractOdometerReading", () => {
  it("extracts a plain odometer reading", () => {
    expect(extractOdometerReading("ODO 125430 km").reading).toBe(125430);
  });

  it("keeps one decimal digit", () => {
    expect(extractOdometerReading("52,418.7").reading).toBe(52418.7);
  });

  it("treats grouping commas as thousands separators", () => {
    expect(extractOdometerReading("125,430").reading).toBe(125430);
  });

  it("rejects equally strong conflicting readings", () => {
    expect(extractOdometerReading("12345 67890").reason).toBe("ambiguous");
  });

  it("rejects short dashboard noise", () => {
    expect(extractOdometerReading("0 km/h 24 C").reason).toBe("not_found");
  });
});

describe("validateOdometerProgress", () => {
  it("accepts a realistic forward reading", () => {
    expect(validateOdometerProgress(125430, 125518)).toBeNull();
  });

  it("rejects a lower end reading", () => {
    expect(validateOdometerProgress(125430, 125400)).toContain("lower");
  });

  it("rejects an implausible daily distance", () => {
    expect(validateOdometerProgress(1000, 2600)).toContain("1,500");
  });
});

describe("duty odometer evidence fallback", () => {
  it("round-trips readings while preserving previous notes", () => {
    const encoded = encodeDutyOdometerEvidence({
      start: { reading: 1000, confidence: 91, photo_path: "user/day/start.jpg", captured_at: "2026-08-30T08:00:00Z" },
      end: { reading: 1088.5, confidence: 89, photo_path: "user/day/end.jpg", captured_at: "2026-08-30T17:00:00Z" },
      distance_km: 88.5,
    }, "original note");
    const parsed = parseDutyOdometerEvidence(encoded);
    expect(parsed?.distance_km).toBe(88.5);
    expect(parsed?.previous_notes).toBe("original note");
  });
});
