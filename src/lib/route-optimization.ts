export interface RouteCoordinate {
  id: string;
  latitude: number;
  longitude: number;
}

export interface RouteOrigin {
  latitude: number;
  longitude: number;
}

export interface OptimizedRoute<T extends RouteCoordinate> {
  stops: T[];
  distanceMeters: number;
  durationSeconds: number;
  geometry: [number, number][];
  source: "road-network" | "distance-fallback";
}

export function haversineMeters(a: RouteOrigin, b: RouteOrigin): number {
  const radius = 6_371_000;
  const dLat = ((b.latitude - a.latitude) * Math.PI) / 180;
  const dLng = ((b.longitude - a.longitude) * Math.PI) / 180;
  const lat1 = (a.latitude * Math.PI) / 180;
  const lat2 = (b.latitude * Math.PI) / 180;
  const value =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return radius * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

function pathDistance(origin: RouteOrigin, stops: RouteCoordinate[]): number {
  let total = 0;
  let cursor = origin;
  for (const stop of stops) {
    total += haversineMeters(cursor, stop);
    cursor = stop;
  }
  return total;
}

/**
 * Fast, deterministic fallback for offline use. It starts with nearest-neighbour
 * ordering and then applies a small 2-opt pass to remove obvious crossings.
 */
export function optimizeStopsByDistance<T extends RouteCoordinate>(
  origin: RouteOrigin,
  stops: T[],
): T[] {
  if (stops.length < 2) return [...stops];

  const remaining = [...stops];
  const ordered: T[] = [];
  let cursor: RouteOrigin = origin;

  while (remaining.length > 0) {
    let bestIndex = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    remaining.forEach((stop, index) => {
      const distance = haversineMeters(cursor, stop);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    });
    const [next] = remaining.splice(bestIndex, 1);
    ordered.push(next);
    cursor = next;
  }

  let improved = true;
  let passes = 0;
  while (improved && passes < 4) {
    improved = false;
    passes += 1;
    for (let i = 0; i < ordered.length - 1; i += 1) {
      for (let j = i + 1; j < ordered.length; j += 1) {
        const candidate = [
          ...ordered.slice(0, i),
          ...ordered.slice(i, j + 1).reverse(),
          ...ordered.slice(j + 1),
        ];
        if (pathDistance(origin, candidate) + 1 < pathDistance(origin, ordered)) {
          ordered.splice(0, ordered.length, ...candidate);
          improved = true;
        }
      }
    }
  }

  return ordered;
}

export async function optimizeRouteWithRoadNetwork<T extends RouteCoordinate>(
  origin: RouteOrigin,
  stops: T[],
  signal?: AbortSignal,
): Promise<OptimizedRoute<T>> {
  const fallbackStops = optimizeStopsByDistance(origin, stops);
  const fallbackDistance = pathDistance(origin, fallbackStops);
  const fallback: OptimizedRoute<T> = {
    stops: fallbackStops,
    distanceMeters: fallbackDistance,
    durationSeconds: Math.round(fallbackDistance / 8.33),
    geometry: [origin, ...fallbackStops].map((point) => [point.latitude, point.longitude]),
    source: "distance-fallback",
  };

  if (stops.length === 0 || typeof fetch === "undefined") return fallback;

  const points = [origin, ...stops];
  const coordinates = points.map((point) => `${point.longitude},${point.latitude}`).join(";");
  const url =
    `https://router.project-osrm.org/trip/v1/driving/${coordinates}` +
    "?source=first&roundtrip=false&overview=full&geometries=geojson&steps=false";

  try {
    const response = await fetch(url, { signal });
    if (!response.ok) return fallback;
    const result = await response.json() as {
      code?: string;
      waypoints?: Array<{ waypoint_index?: number }>;
      trips?: Array<{
        distance?: number;
        duration?: number;
        geometry?: { coordinates?: [number, number][] };
      }>;
    };
    const trip = result.trips?.[0];
    if (result.code !== "Ok" || !trip || !result.waypoints) return fallback;

    const ordered = stops
      .map((stop, index) => ({ stop, order: result.waypoints?.[index + 1]?.waypoint_index ?? index + 1 }))
      .sort((a, b) => a.order - b.order)
      .map((entry) => entry.stop);
    const geometry = (trip.geometry?.coordinates || []).map(
      ([longitude, latitude]) => [latitude, longitude] as [number, number],
    );

    return {
      stops: ordered,
      distanceMeters: Number(trip.distance || fallbackDistance),
      durationSeconds: Number(trip.duration || fallback.durationSeconds),
      geometry: geometry.length > 1 ? geometry : fallback.geometry,
      source: "road-network",
    };
  } catch {
    return fallback;
  }
}

