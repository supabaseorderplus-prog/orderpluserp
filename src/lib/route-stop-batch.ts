export type PreparedRouteStopIds = {
  validIds: string[];
  skippedIds: string[];
};

/**
 * Keep the group's original stop order, remove duplicate IDs, and separate
 * deleted/stale party references before writing route stops.
 */
export function prepareRouteStopIds(
  requestedIds: unknown,
  existingIds: Iterable<string>,
): PreparedRouteStopIds {
  const existing = new Set(existingIds);
  const seen = new Set<string>();
  const validIds: string[] = [];
  const skippedIds: string[] = [];

  for (const value of Array.isArray(requestedIds) ? requestedIds : []) {
    const id = typeof value === 'string' ? value.trim() : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    if (existing.has(id)) validIds.push(id);
    else skippedIds.push(id);
  }

  return { validIds, skippedIds };
}
