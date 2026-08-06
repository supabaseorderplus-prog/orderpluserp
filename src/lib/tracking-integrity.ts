export interface TrackingPoint {
  latitude: number;
  longitude: number;
  recorded_at: string;
  accuracy?: number | null;
  speed?: number | null;
  [key: string]: unknown;
}

export type VerifiedTrackingPoint<T extends TrackingPoint> = T & {
  break_before?: boolean;
};

export const MAX_ACCEPTABLE_ACCURACY_M = 60;
export const MAX_CONTINUOUS_GAP_MS = 90_000;
export const MAX_PLAUSIBLE_SPEED_MPS = 55;
const MIN_MOVEMENT_M = 12;

export function trackingDistanceMeters(
  a: Pick<TrackingPoint, "latitude" | "longitude">,
  b: Pick<TrackingPoint, "latitude" | "longitude">,
): number {
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

function safeAccuracy(value: number | null | undefined): number {
  return Number.isFinite(value) && Number(value) > 0 ? Number(value) : 25;
}

export function movementNoiseRadiusMeters(
  previous: Pick<TrackingPoint, "accuracy">,
  current: Pick<TrackingPoint, "accuracy">,
): number {
  return Math.max(
    MIN_MOVEMENT_M,
    Math.min(
      100,
      safeAccuracy(previous.accuracy) + safeAccuracy(current.accuracy) + 10,
    ),
  );
}

export type SegmentDecision = {
  accepted: boolean;
  countsDistance: boolean;
  breakBefore: boolean;
  distanceM: number;
  reason: "movement" | "stationary" | "poor_accuracy" | "signal_gap" | "implausible" | "stale";
};

export function evaluateTrackingSegment(
  previous: TrackingPoint,
  current: TrackingPoint,
): SegmentDecision {
  const currentAccuracy = safeAccuracy(current.accuracy);
  const distanceM = trackingDistanceMeters(previous, current);
  if (currentAccuracy > MAX_ACCEPTABLE_ACCURACY_M) {
    return { accepted: false, countsDistance: false, breakBefore: false, distanceM, reason: "poor_accuracy" };
  }

  const previousTime = new Date(previous.recorded_at).getTime();
  const currentTime = new Date(current.recorded_at).getTime();
  const gapMs = currentTime - previousTime;
  if (!Number.isFinite(gapMs) || gapMs <= 0) {
    return { accepted: false, countsDistance: false, breakBefore: false, distanceM, reason: "stale" };
  }

  // Never invent a straight journey while the device supplied no continuous
  // fixes. The new point becomes the start of a new verified segment.
  if (gapMs > MAX_CONTINUOUS_GAP_MS) {
    return { accepted: true, countsDistance: false, breakBefore: true, distanceM, reason: "signal_gap" };
  }

  const noiseRadiusM = movementNoiseRadiusMeters(previous, current);
  const reportedSpeed = Number(current.speed);
  // Android's fused provider derives speed across multiple sensor inputs and is
  // more trustworthy than a single displaced coordinate. A near-zero reported
  // speed means the device is stationary, even if one fix wanders substantially.
  if (Number.isFinite(reportedSpeed) && reportedSpeed < 1.2 && distanceM < 500) {
    return { accepted: false, countsDistance: false, breakBefore: false, distanceM, reason: "stationary" };
  }
  // Older rows may not contain fused-provider speed. In that case require a
  // clearly established displacement from the stable anchor before declaring
  // movement; this collapses the familiar stationary "GPS scribble" cloud.
  if (!Number.isFinite(reportedSpeed) && distanceM < 150) {
    return { accepted: false, countsDistance: false, breakBefore: false, distanceM, reason: "stationary" };
  }
  if (distanceM < noiseRadiusM && (!Number.isFinite(reportedSpeed) || reportedSpeed < 1.2)) {
    return { accepted: false, countsDistance: false, breakBefore: false, distanceM, reason: "stationary" };
  }

  const derivedSpeedMps = distanceM / (gapMs / 1000);
  if (derivedSpeedMps > MAX_PLAUSIBLE_SPEED_MPS) {
    return { accepted: false, countsDistance: false, breakBefore: false, distanceM, reason: "implausible" };
  }

  return { accepted: true, countsDistance: true, breakBefore: false, distanceM, reason: "movement" };
}

export function buildVerifiedTrail<T extends TrackingPoint>(rawPoints: T[]): {
  points: VerifiedTrackingPoint<T>[];
  distanceKm: number;
  rejected: number;
} {
  const valid = rawPoints
    .filter((point) =>
      Number.isFinite(point.latitude) &&
      Number.isFinite(point.longitude) &&
      Number.isFinite(new Date(point.recorded_at).getTime()) &&
      safeAccuracy(point.accuracy) <= MAX_ACCEPTABLE_ACCURACY_M,
    )
    .sort((a, b) => new Date(a.recorded_at).getTime() - new Date(b.recorded_at).getTime());

  if (valid.length === 0) return { points: [], distanceKm: 0, rejected: rawPoints.length };

  const points: VerifiedTrackingPoint<T>[] = [{ ...valid[0] }];
  let anchor = valid[0];
  let distanceM = 0;
  let rejected = rawPoints.length - valid.length;

  for (const current of valid.slice(1)) {
    const decision = evaluateTrackingSegment(anchor, current);
    if (!decision.accepted) {
      rejected += 1;
      continue;
    }
    points.push({ ...current, ...(decision.breakBefore ? { break_before: true } : {}) });
    if (decision.countsDistance) distanceM += decision.distanceM;
    anchor = current;
  }

  // A burst of fixes that scribbles around a small area and returns close to its
  // start is another characteristic stationary-GPS failure. Collapse only short
  // closed clouds; genuine continuous travel that progresses away is preserved.
  const segments: VerifiedTrackingPoint<T>[][] = [];
  for (const point of points) {
    if (segments.length === 0 || point.break_before) segments.push([]);
    segments[segments.length - 1].push(point);
  }
  const collapsed: VerifiedTrackingPoint<T>[] = [];
  for (const segment of segments) {
    let segmentDistanceM = 0;
    let maxFromStartM = 0;
    for (let i = 1; i < segment.length; i++) {
      segmentDistanceM += trackingDistanceMeters(segment[i - 1], segment[i]);
      maxFromStartM = Math.max(maxFromStartM, trackingDistanceMeters(segment[0], segment[i]));
    }
    const durationMs = segment.length > 1
      ? new Date(segment[segment.length - 1].recorded_at).getTime() - new Date(segment[0].recorded_at).getTime()
      : 0;
    const endDisplacementM = segment.length > 1
      ? trackingDistanceMeters(segment[0], segment[segment.length - 1])
      : 0;
    const isClosedJitterCloud =
      segment.length >= 4 &&
      durationMs <= 5 * 60_000 &&
      segmentDistanceM <= 750 &&
      maxFromStartM <= 200 &&
      endDisplacementM <= Math.max(60, maxFromStartM * 0.7);
    if (isClosedJitterCloud) {
      collapsed.push(segment[0]);
      rejected += segment.length - 1;
    } else {
      collapsed.push(...segment);
    }
  }

  distanceM = 0;
  for (let i = 1; i < collapsed.length; i++) {
    if (!collapsed[i].break_before) distanceM += trackingDistanceMeters(collapsed[i - 1], collapsed[i]);
  }
  return { points: collapsed, distanceKm: distanceM / 1000, rejected };
}
