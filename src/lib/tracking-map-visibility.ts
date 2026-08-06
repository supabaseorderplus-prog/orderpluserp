type MapUser = { id: string };
type TimedLocation = { recorded_at?: string | null };

/**
 * The overview shows the whole team, while an opened timeline is a strict
 * single-salesman view. Keep this invariant outside the Leaflet rendering loop
 * so unrelated markers can never leak into a selected person's timeline.
 */
export function getVisibleTrackingUsers<T extends MapUser>(
  users: T[],
  selectedUserId?: string | null
): T[] {
  if (!selectedUserId) return users;
  return users.filter((user) => user.id === selectedUserId);
}

/** Only the open salesman's realtime pings belong in the visible trail. */
export function belongsToSelectedTrackingUser(
  selectedUserId: string | null | undefined,
  incomingUserId: string | null | undefined
): boolean {
  return Boolean(selectedUserId && incomingUserId && selectedUserId === incomingUserId);
}

/** Prefer the freshest point so a delayed MQTT message cannot replace newer DB data. */
export function newestTrackingLocation<T extends TimedLocation>(
  first: T | null | undefined,
  second: T | null | undefined
): T | null {
  if (!first) return second ?? null;
  if (!second) return first;

  const firstTime = first.recorded_at ? new Date(first.recorded_at).getTime() : Number.NaN;
  const secondTime = second.recorded_at ? new Date(second.recorded_at).getTime() : Number.NaN;
  if (!Number.isFinite(firstTime)) return second;
  if (!Number.isFinite(secondTime)) return first;
  return secondTime > firstTime ? second : first;
}
