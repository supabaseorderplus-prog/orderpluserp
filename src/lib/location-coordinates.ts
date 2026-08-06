export type Coordinates = {
  latitude: number;
  longitude: number;
};

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
