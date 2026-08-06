export type GpsHealthSnapshot = {
  gps_enabled: boolean;
  permission_granted: boolean;
  service_active?: boolean | null;
};

export type GpsAdminEvent = "lost" | "restored" | null;

/** Decides whether a company admin should receive a new GPS incident event. */
export function gpsAdminEvent(input: {
  onDuty: boolean;
  current: GpsHealthSnapshot;
  previous: GpsHealthSnapshot | null;
  previousAgeMs: number;
}): GpsAdminEvent {
  if (!input.onDuty) return null;
  const currentUnavailable = !input.current.gps_enabled || !input.current.permission_granted;
  const previousUnavailable = input.previous
    ? !input.previous.gps_enabled || !input.previous.permission_granted
    : false;

  if (currentUnavailable && (
    !previousUnavailable || input.previous?.service_active !== true || input.previousAgeMs > 120_000
  )) return "lost";

  if (!currentUnavailable && previousUnavailable && input.previousAgeMs <= 120_000) return "restored";
  return null;
}
