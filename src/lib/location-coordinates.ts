export type Coordinates = {
  latitude: number;
  longitude: number;
};

export const REQUIRED_PARTY_LOCATION_MESSAGE =
  "GPS location is required. Use Current Location or enter both latitude and longitude.";

export type RequiredCoordinatesResult =
  | { success: true; coordinates: Coordinates }
  | { success: false; message: string };

function parseCoordinate(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Convert a runtime/API coordinate pair without turning null into 0. */
export function normalizeCoordinates(
  latitude: unknown,
  longitude: unknown
): Coordinates | null {
  const lat = parseCoordinate(latitude);
  const lng = parseCoordinate(longitude);

  if (lat == null || lng == null) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;

  // 0,0 is the conventional "missing GPS fix" sentinel (Null Island). It can
  // be produced accidentally by Number(null), and must never become a marker.
  if (lat === 0 && lng === 0) return null;

  return { latitude: lat, longitude: lng };
}

/** Validate the mandatory GPS pair used when creating a party. */
export function validateRequiredCoordinates(
  latitude: unknown,
  longitude: unknown
): RequiredCoordinatesResult {
  const latitudeMissing = latitude == null || String(latitude).trim() === "";
  const longitudeMissing = longitude == null || String(longitude).trim() === "";

  if (latitudeMissing || longitudeMissing) {
    return { success: false, message: REQUIRED_PARTY_LOCATION_MESSAGE };
  }

  const coordinates = normalizeCoordinates(latitude, longitude);
  if (!coordinates) {
    return {
      success: false,
      message: "Invalid GPS coordinates. Please enter a valid latitude and longitude.",
    };
  }

  return {
    success: true,
    coordinates: {
      latitude: Number(coordinates.latitude.toFixed(6)),
      longitude: Number(coordinates.longitude.toFixed(6)),
    },
  };
}
