"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import dynamic from "next/dynamic";
import { api } from "@/lib/api";
import { normalizeCoordinates } from "@/lib/location-coordinates";
import { belongsToSelectedTrackingUser, newestTrackingLocation } from "@/lib/tracking-map-visibility";
import { buildVerifiedTrail } from "@/lib/tracking-integrity";
import { istToday } from "@/lib/datetime";
import { TrackingAnalysisPanel } from "@/components/TrackingAnalysisPanel";
import {
  getMqttClient,
  LOCATION_TOPIC_PREFIX,
  type MqttLocationPayload,
  disconnectMqtt,
} from "@/lib/mqtt-client";
import {
  ArrowLeft,
  Calendar,
  Clock,
  RefreshCw,
  Route,
  Search,
  Users,
  CheckCircle,
  XCircle,
  Zap,
  AppWindow,
  Store,
  MapPin,
  ShieldCheck,
  ShieldAlert,
  ClipboardList,
  BarChart3,
} from "lucide-react";

const LiveMultiMap = dynamic(() => import("@/components/LiveMultiMap"), {
  ssr: false,
  loading: () => (
    <div className="flex items-center justify-center h-full bg-zinc-50">
      <RefreshCw className="w-6 h-6 text-amber-400 animate-spin" />
    </div>
  ),
});

// ── Types ─────────────────────────────────────────────────────────────────────
interface Territory {
  name: string;
}
interface Salesman {
  id: string;
  name: string;
  email: string;
  employee_code: string | null;
  phone: string | null;
  territory_id?: string | null;
  territories?: Territory | null;
  role?: string;
  session: DaySession | null;
  latest_location: LocationLog | null;
  gps_health: GpsHealth | null;
}
interface GpsHealth {
  gps_enabled: boolean;
  permission_granted: boolean;
  service_active: boolean;
  location_available: boolean;
  last_location_at: string | null;
  status_updated_at: string;
  device_platform: string | null;
}
interface LocationLog {
  id?: string;
  salesman_id?: string;
  latitude: number;
  longitude: number;
  accuracy?: number;
  battery_level?: number;
  speed?: number;
  heading?: number;
  address?: string;
  place_name?: string;
  road?: string;
  suburb?: string;
  city?: string;
  activity?: string;
  note?: string;
  recorded_at: string;
}
interface DaySession {
  id: string;
  salesman_id: string;
  date: string;
  check_in_time: string | null;
  check_out_time: string | null;
  check_in_lat: number | null;
  check_in_lng: number | null;
  total_distance_km: number;
  total_stops: number;
  status: string;
  notes: string | null;
  start_odometer_km?: number | null;
  end_odometer_km?: number | null;
  odometer_distance_km?: number | null;
  start_odometer_photo_url?: string | null;
  end_odometer_photo_url?: string | null;
}
interface PartyVisit {
  id: string;
  party_id: string;
  party_name: string;
  party_code: string | null;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  check_in_time: string | null;
  check_out_time: string | null;
  is_within_geofence: boolean | null;
  deviation_meters: number | null;
  notes: string | null;
  source: "checkin" | "manual";
}
interface RouteRunSummary {
  id: string;
  route_id: string;
  route_name?: string | null;
  status: "active" | "completed";
  total_stops: number;
  ordered_stop_ids: string[];
  visits: Array<{ stop_id: string; party_id: string; notes: string; visited_at: string; distance_m: number }>;
  started_at: string;
  completed_at: string | null;
}
interface PlannedRouteStop {
  id: string;
  party_id: string;
  stop_order: number;
  parties: {
    name?: string;
    party_code?: string | null;
    latitude?: number | null;
    longitude?: number | null;
    address_line1?: string | null;
    city?: string | null;
  } | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

// Human-readable place for a location ping: geocoded name → address →
// road/suburb/city → raw coordinates as a last resort.
function locLabel(log: LocationLog): string {
  return (
    log.place_name ||
    log.address ||
    (log.road ? [log.road, log.suburb, log.city].filter(Boolean).join(", ") : null) ||
    `${log.latitude.toFixed(4)}, ${log.longitude.toFixed(4)}`
  );
}

// Trail ping recorded closest in time to a given moment — used to label the
// check-in / check-out events with where they physically happened, since the
// session row itself carries no place name.
function nearestTrailLog(trail: LocationLog[], iso: string | null): LocationLog | null {
  if (!iso || trail.length === 0) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  let best: LocationLog | null = null;
  let bestGap = Infinity;
  for (const log of trail) {
    const lt = new Date(log.recorded_at).getTime();
    if (!Number.isFinite(lt)) continue;
    const gap = Math.abs(lt - t);
    if (gap < bestGap) {
      bestGap = gap;
      best = log;
    }
  }
  return best;
}

function fmtDurationHr(start: string | null, end: string | null): string {
  if (!start) return "0";
  const s = new Date(start).getTime();
  const e = end ? new Date(end).getTime() : Date.now();
  const mins = Math.floor((e - s) / 60000);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function pingGapMinutes(loc: LocationLog | null): number | null {
  if (!loc?.recorded_at) return null;
  return (Date.now() - new Date(loc.recorded_at).getTime()) / 60000;
}

function isAppKilled(s: Salesman): boolean {
  if (s.session?.status !== "active") return false;
  if (s.gps_health && (!s.gps_health.gps_enabled || !s.gps_health.permission_granted)) return true;
  const gap = pingGapMinutes(s.latest_location);
  return gap === null || gap > 1.5;
}

function gpsProblemLabel(s: Salesman): string | null {
  if (s.session?.status !== "active") return null;
  if (s.gps_health && !s.gps_health.permission_granted) return "Location permission off";
  if (s.gps_health && !s.gps_health.gps_enabled) return "GPS off";
  const gap = pingGapMinutes(s.latest_location);
  if (gap === null) return "Waiting for GPS";
  if (gap > 1.5) return `No GPS ${Math.max(2, Math.floor(gap))}m`;
  return null;
}

function appKilledLabel(s: Salesman): string {
  const problem = gpsProblemLabel(s);
  if (problem === "GPS off") return "GPS is turned off on this device. The salesman has been notified to turn it on.";
  if (problem === "Location permission off") return "Location permission is disabled. The salesman must enable precise location access.";
  const gap = pingGapMinutes(s.latest_location);
  if (gap === null) return "Waiting for first GPS update";
  const seconds = Math.floor(gap * 60);
  if (seconds < 60) return `No GPS update for ${seconds}s — checking device GPS/network`;
  const mins = Math.floor(gap);
  if (mins < 60) return `No GPS update for ${mins}m — checking device connection`;
  const hrs = Math.floor(mins / 60);
  return `No GPS update for ${hrs}h ${mins % 60}m — check device GPS/network`;
}

function initials(name: string): string {
  return name
    .split(" ")
    .map((n) => n[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function TrackingPage() {
  const [salesmen, setSalesmen] = useState<Salesman[]>([]);
  const [selectedDate, setSelectedDate] = useState(
    istToday()
  );
  const [selected, setSelected] = useState<Salesman | null>(null);
  const [trail, setTrail] = useState<LocationLog[]>([]);
  const [visits, setVisits] = useState<PartyVisit[]>([]);
  const [routeRun, setRouteRun] = useState<RouteRunSummary | null>(null);
  const [plannedStops, setPlannedStops] = useState<PlannedRouteStop[]>([]);
  const [loading, setLoading] = useState(true);
  const [trailLoading, setTrailLoading] = useState(false);
  const [visitsLoading, setVisitsLoading] = useState(false);
  const [filter, setFilter] = useState<"live" | "active" | "offline" | "all">(
    "all"
  );
  const [search, setSearch] = useState("");
  const [liveLocations, setLiveLocations] = useState<
    Record<string, LocationLog>
  >({});
  const [mqttConnected, setMqttConnected] = useState(false);
  const [viewMode, setViewMode] = useState<"live" | "analysis">("live");
  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const trailCursorRef = useRef<string | null>(null);
  const selectedId = selected?.id ?? null;
  const selectedStatus = selected?.session?.status ?? null;
  const selectedIdRef = useRef<string | null>(selectedId);
  selectedIdRef.current = selectedId;
  const selectedDateRef = useRef(selectedDate);
  selectedDateRef.current = selectedDate;

  const fetchSalesmen = useCallback(async (date: string, silent = false) => {
    if (!silent) setLoading(true);
    try {
      const json = await api<{ data: Salesman[] }>(
        `/api/v1/tracking/salesmen?date=${date}`
      );
      setSalesmen(json.data || []);
    } catch {
      setSalesmen([]);
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  const fetchTrail = useCallback(async (
    id: string,
    date: string,
    silent = false,
    incremental = false,
  ) => {
    if (!silent) setTrailLoading(true);
    try {
      const cursor = incremental ? trailCursorRef.current : null;
      const after = cursor ? `&after=${encodeURIComponent(cursor)}` : "";
      const json = await api<{ data: LocationLog[] }>(
        `/api/v1/tracking/location?salesman_id=${id}&date=${date}&limit=1000${after}`
      );
      if (selectedIdRef.current === id) {
        const incoming = json.data || [];
        if (incremental && cursor) {
          setTrail((current) => {
            const byId = new Map(current.map((row) => [row.id || `${row.recorded_at}:${row.latitude}:${row.longitude}`, row]));
            for (const row of incoming) {
              byId.set(row.id || `${row.recorded_at}:${row.latitude}:${row.longitude}`, row);
            }
            return [...byId.values()].sort(
              (a, b) => new Date(a.recorded_at).getTime() - new Date(b.recorded_at).getTime(),
            );
          });
        } else {
          setTrail(incoming);
        }
        const newest = incoming[incoming.length - 1]?.recorded_at;
        if (newest) trailCursorRef.current = newest;
      }
    } catch {
      if (selectedIdRef.current === id && !incremental) setTrail([]);
    } finally {
      if (!silent) setTrailLoading(false);
    }
  }, []);

  const fetchVisits = useCallback(async (id: string, date: string, silent = false) => {
    if (!silent) setVisitsLoading(true);
    try {
      const json = await api<{ data: PartyVisit[] }>(
        `/api/v1/tracking/visits?salesman_id=${id}&date=${date}`
      );
      setVisits(json.data || []);
    } catch {
      setVisits([]);
    } finally {
      if (!silent) setVisitsLoading(false);
    }
  }, []);

  const fetchRouteRun = useCallback(async (id: string, date: string) => {
    try {
      const json = await api<{ data: { run: RouteRunSummary | null } }>(
        `/api/v1/duty/route-run?salesman_id=${id}&date=${date}`,
        { noCache: true, suppressErrorLog: true },
      );
      if (selectedIdRef.current !== id) return;
      const run = json.data.run || null;
      setRouteRun(run);
      if (!run?.route_id) {
        setPlannedStops([]);
        return;
      }
      const stopsJson = await api<{ data: PlannedRouteStop[] }>(
        `/api/v1/tracking/routes/stops?route_id=${encodeURIComponent(run.route_id)}`,
        { noCache: true, suppressErrorLog: true },
      );
      if (selectedIdRef.current !== id) return;
      const order = new Map(run.ordered_stop_ids?.map((stopId, index) => [stopId, index]) || []);
      setPlannedStops((stopsJson.data || [])
        .filter((stop) => order.has(stop.id))
        .sort((a, b) => (order.get(a.id) ?? 9999) - (order.get(b.id) ?? 9999)));
    } catch {
      if (selectedIdRef.current === id) {
        setRouteRun(null);
        setPlannedStops([]);
      }
    }
  }, []);

  // Auto-refresh live status frequently. Native Android background pings are
  // written directly to the API, so polling keeps the map current even when the
  // WebView/MQTT client is closed.
  useEffect(() => {
    setLiveLocations({});
    fetchSalesmen(selectedDate);
    intervalRef.current = setInterval(
      () => {
        if (typeof document !== "undefined" && document.hidden) return;
        fetchSalesmen(selectedDate, true); // silent — no map overlay on background polls
      },
      3000
    );
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [fetchSalesmen, selectedDate]);

  // Fetch trail + party visits when selected user changes
  useEffect(() => {
    trailCursorRef.current = null;
    if (selectedId) {
      fetchTrail(selectedId, selectedDate);
      fetchVisits(selectedId, selectedDate);
      fetchRouteRun(selectedId, selectedDate);
    } else {
      setTrail([]);
      setVisits([]);
      setRouteRun(null);
      setPlannedStops([]);
    }
  }, [selectedId, selectedDate, fetchTrail, fetchVisits, fetchRouteRun]);

  // Keep selected salesman in sync with fresh data from polling
  useEffect(() => {
    if (!selected) return;
    const fresh = salesmen.find((s) => s.id === selected.id);
    if (fresh) setSelected(fresh);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [salesmen]);

  // Keep the selected user's route line + visited parties moving point-by-point
  // while duty is active.
  useEffect(() => {
    if (!selectedId || selectedStatus !== "active") return;
    const timer = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      fetchTrail(selectedId, selectedDate, true, true);
      fetchVisits(selectedId, selectedDate, true);
      fetchRouteRun(selectedId, selectedDate);
    }, 3000);
    return () => clearInterval(timer);
  }, [selectedId, selectedStatus, selectedDate, fetchTrail, fetchVisits, fetchRouteRun]);

  // MQTT: real-time location updates
  useEffect(() => {
    const client = getMqttClient();
    client.on("connect", () => setMqttConnected(true));
    client.on("disconnect", () => setMqttConnected(false));
    client.on("offline", () => setMqttConnected(false));
    client.on("reconnect", () => setMqttConnected(false));

    client.subscribe(`${LOCATION_TOPIC_PREFIX}/+`, { qos: 0 });

    client.on("message", (topic: string, payload: Buffer) => {
      if (!topic.startsWith(LOCATION_TOPIC_PREFIX)) return;
      try {
        const data: MqttLocationPayload = JSON.parse(payload.toString());
        if (selectedDateRef.current !== istToday()) return;
        const coordinates = normalizeCoordinates(data.latitude, data.longitude);
        if (!data.salesman_id || !coordinates) return;

        const loc: LocationLog = {
          salesman_id: data.salesman_id,
          ...coordinates,
          accuracy: data.accuracy ?? undefined,
          speed: data.speed ?? undefined,
          heading: data.heading ?? undefined,
          battery_level: data.battery_level ?? undefined,
          recorded_at: data.recorded_at,
        };

        setLiveLocations((prev) => ({
          ...prev,
          [data.salesman_id]: newestTrackingLocation(prev[data.salesman_id], loc) ?? loc,
        }));
        setSalesmen((prev) =>
          prev.map((s) =>
            s.id === data.salesman_id
              ? { ...s, latest_location: newestTrackingLocation(s.latest_location, loc) }
              : s
          )
        );
        setSelected((prev) => {
          if (!prev || prev.id !== data.salesman_id) return prev;
          return { ...prev, latest_location: newestTrackingLocation(prev.latest_location, loc) };
        });
        if (belongsToSelectedTrackingUser(selectedIdRef.current, data.salesman_id)) {
          setTrail((prev) => {
            const last = prev[prev.length - 1];
            if (last && newestTrackingLocation(last, loc) !== loc) return prev;
            if (
              last &&
              last.latitude === loc.latitude &&
              last.longitude === loc.longitude
            )
              return prev;
            return [...prev, loc];
          });
        }
      } catch {
        // ignore malformed
      }
    });

    return () => {
      client.unsubscribe(`${LOCATION_TOPIC_PREFIX}/+`);
      disconnectMqtt();
    };
  }, []);

  // ── Computed values ────────────────────────────────────────────────────────
  const now = Date.now();

  function isLive(s: Salesman): boolean {
    const loc = newestTrackingLocation(liveLocations[s.id], s.latest_location);
    if (!loc) return false;
    return now - new Date(loc.recorded_at).getTime() < 30 * 60 * 1000;
  }

  const stats = {
    live: salesmen.filter(isLive).length,
    active: salesmen.filter((s) => s.session?.status === "active").length,
    offline: salesmen.filter((s) => !s.session || gpsProblemLabel(s) !== null).length,
    total: salesmen.length,
  };

  // Users to show on the map — all with known locations
  const userPins = salesmen.flatMap((s) => {
    const loc = newestTrackingLocation(liveLocations[s.id], s.latest_location);
    const coordinates = loc
      ? normalizeCoordinates(loc.latitude, loc.longitude)
      : null;
    if (!loc || !coordinates) return [];
    return {
      id: s.id,
      name: s.name,
      ...coordinates,
      isActive: s.session?.status === "active",
      accuracy: loc.accuracy,
      address: loc.address,
      place_name: loc.place_name,
      road: loc.road,
      suburb: loc.suburb,
      city: loc.city,
      recorded_at: loc.recorded_at,
    };
  });

  // Filtered sidebar user list
  const filteredSalesmen = salesmen.filter((s) => {
    if (
      search &&
      !s.name.toLowerCase().includes(search.toLowerCase())
    )
      return false;
    if (filter === "live") return isLive(s);
    if (filter === "active") return s.session?.status === "active";
    if (filter === "offline") return !s.session || gpsProblemLabel(s) !== null;
    return true;
  });

  // Build one verified trail for distance, map and timeline. This deliberately
  // excludes stationary jitter, poor fixes, impossible jumps and straight lines
  // across signal gaps.
  const verifiedTrail = buildVerifiedTrail(trail);

  // Trail for map (only for selected user)
  const mapTrail =
    selected && verifiedTrail.points.length > 0
      ? verifiedTrail.points.flatMap((t) => {
          const coordinates = normalizeCoordinates(t.latitude, t.longitude);
          if (!coordinates) return [];
          return [{
            ...coordinates,
            recorded_at: t.recorded_at,
            activity: t.activity,
            speed: t.speed,
            accuracy: t.accuracy,
            address: t.address,
            place_name: t.place_name,
            road: t.road,
            suburb: t.suburb,
            city: t.city,
            break_before: t.break_before,
          }];
        })
      : [];

  const trailDistKm = verifiedTrail.distanceKm;

  const routePartyPins = plannedStops.flatMap((stop, index) => {
    const party = stop.parties;
    const coordinates = party
      ? normalizeCoordinates(party.latitude, party.longitude)
      : null;
    if (!party || !coordinates) return [];
    return [{
      id: stop.id,
      partyId: stop.party_id,
      name: party.name || `Party ${index + 1}`,
      code: party.party_code || null,
      address: [party.address_line1, party.city].filter(Boolean).join(", ") || null,
      ...coordinates,
      order: index + 1,
      visited: Boolean(routeRun?.visits.some((visit) => visit.stop_id === stop.id)),
    }];
  });
  const gpsProblems = salesmen.filter((salesman) => gpsProblemLabel(salesman) !== null);

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    // Bleed out of the dashboard padding to fill the viewport
    <div
      className="-m-4 -mb-24 lg:-m-6 lg:-mb-6 flex flex-col"
      style={{ height: "calc(100vh - 56px)" }}
    >
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div
        className="shrink-0 flex flex-col sm:flex-row sm:items-center gap-3 px-4 py-3 border-b border-black/[0.06] bg-white"
        style={{ minHeight: 60 }}
      >
        {/* Title + MQTT badge */}
        <div className="flex items-center gap-3">
          <h1 className="text-zinc-900 text-base font-bold">{viewMode === "live" ? "Live Location" : "Tracking Analysis"}</h1>
          {viewMode === "live" && <div
            className={`flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-[0.6rem] font-medium ${
              mqttConnected
                ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-500"
                : "bg-zinc-500/10 border-zinc-500/20 text-zinc-500"
            }`}
          >
            <span
              className={`w-1.5 h-1.5 rounded-full ${
                mqttConnected ? "bg-emerald-400 animate-pulse" : "bg-zinc-400"
              }`}
            />
            {mqttConnected ? "Live" : "Connecting…"}
          </div>}
        </div>

        <div className="flex items-center rounded-lg border border-zinc-200 bg-zinc-50 p-0.5 sm:ml-2">
          <button type="button" onClick={() => setViewMode("live")} className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-semibold transition ${viewMode === "live" ? "bg-white text-blue-600 shadow-sm" : "text-zinc-500"}`}>
            <MapPin className="h-3.5 w-3.5" /> Live
          </button>
          <button type="button" onClick={() => setViewMode("analysis")} className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-semibold transition ${viewMode === "analysis" ? "bg-white text-blue-600 shadow-sm" : "text-zinc-500"}`}>
            <BarChart3 className="h-3.5 w-3.5" /> Visit Report
          </button>
        </div>

        {/* Filter tabs */}
        {viewMode === "live" && <div className="flex items-center gap-1 flex-wrap sm:ml-4">
          {(
            [
              {
                key: "live" as const,
                label: "Live",
                count: stats.live,
                icon: "●" as string | null,
                activeColor: "bg-blue-500/10 text-blue-600 border-blue-500/20",
                dot: "bg-blue-500 animate-pulse" as string | undefined,
                hint: "last 30 mins" as string | undefined,
              },
              {
                key: "active" as const,
                label: "Active",
                count: stats.active,
                icon: "✓" as string | null,
                activeColor:
                  "bg-emerald-500/10 text-emerald-600 border-emerald-500/20",
                dot: "bg-emerald-500" as string | undefined,
                hint: undefined as string | undefined,
              },
              {
                key: "offline" as const,
                label: "Offline",
                count: stats.offline,
                icon: "✗" as string | null,
                activeColor: "bg-zinc-200 text-zinc-600 border-zinc-300",
                dot: "bg-zinc-400" as string | undefined,
                hint: undefined as string | undefined,
              },
              {
                key: "all" as const,
                label: "All",
                count: stats.total,
                icon: null as string | null,
                activeColor:
                  "bg-amber-500/10 text-amber-600 border-amber-500/20",
                dot: undefined as string | undefined,
                hint: undefined as string | undefined,
              },
            ]
          ).map((f) => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={`flex items-center gap-1.5 px-3 py-1 rounded-full border text-xs font-medium transition-all ${
                filter === f.key
                  ? f.activeColor
                  : "border-black/[0.06] text-zinc-500 hover:text-zinc-900 hover:bg-black/[0.04]"
              }`}
              style={{ cursor: "pointer", fontFamily: "inherit" }}
            >
              {f.dot && filter === f.key && (
                <span className={`w-1.5 h-1.5 rounded-full ${f.dot} shrink-0`} />
              )}
              {f.icon && !f.dot && (
                <span className="text-[0.7rem]">{f.icon}</span>
              )}
              <span className="font-semibold">{f.count}</span>
              <span>{f.label}</span>
              {f.hint && filter === f.key && (
                <span className="text-[0.6rem] opacity-70">{f.hint}</span>
              )}
            </button>
          ))}
        </div>}

        {/* Date picker */}
        {viewMode === "live" && <div className="flex items-center gap-2 sm:ml-auto">
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-black/[0.04] border border-black/[0.08] text-sm">
            <Calendar className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
            <input
              type="date"
              value={selectedDate}
              max={istToday()}
              onChange={(e) => {
                setSelectedDate(e.target.value);
                setSelected(null);
              }}
              className="bg-transparent text-zinc-900 outline-none text-xs"
            />
          </div>
          <button
            onClick={() => fetchSalesmen(selectedDate)}
            className="p-1.5 rounded-lg text-zinc-600 hover:text-zinc-900 hover:bg-black/[0.04] border border-black/[0.08] transition-all"
            style={{ cursor: "pointer", background: "none" }}
            title="Refresh"
          >
            <RefreshCw
              className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`}
            />
          </button>
        </div>}
      </div>

      {viewMode === "live" && gpsProblems.length > 0 && (
        <div className="flex shrink-0 items-center gap-2 border-b border-red-200 bg-red-50 px-4 py-2 text-xs text-red-700">
          <ShieldAlert className="h-4 w-4 shrink-0" />
          <span className="font-semibold">GPS attention:</span>
          <div className="flex min-w-0 flex-1 gap-2 overflow-x-auto">
            {gpsProblems.map((salesman) => (
              <button
                key={salesman.id}
                type="button"
                onClick={() => setSelected(salesman)}
                className="shrink-0 rounded-full border border-red-200 bg-white px-2.5 py-1 font-semibold text-red-700 hover:bg-red-100"
              >
                {salesman.name} · {gpsProblemLabel(salesman)}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── Split content ─────────────────────────────────────────────────── */}
      {viewMode === "analysis" ? (
        <TrackingAnalysisPanel salesmen={salesmen.map(({ id, name }) => ({ id, name }))} />
      ) : (
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden lg:flex-row">
        {/* ── Map ─────────────────────────────────────────────────────────── */}
        <div className="relative min-h-[48vh] flex-1 overflow-hidden">
          <LiveMultiMap
            users={userPins}
            selectedUserId={selected?.id ?? null}
            trail={mapTrail}
            routeStops={routePartyPins}
            routeStopTotal={routeRun?.total_stops ?? plannedStops.length}
            onUserClick={(id) => {
              const s = salesmen.find((sm) => sm.id === id);
              if (s) setSelected(s);
            }}
          />
          {loading && salesmen.length === 0 && (
            <div className="absolute inset-0 flex items-center justify-center bg-white/60 backdrop-blur-sm z-[1100]">
              <RefreshCw className="w-6 h-6 text-amber-400 animate-spin" />
            </div>
          )}
        </div>

        {/* ── Sidebar ──────────────────────────────────────────────────────── */}
        <div
          className="flex h-[46vh] w-full shrink-0 flex-col overflow-hidden border-t border-black/[0.06] bg-white lg:h-auto lg:w-[370px] lg:border-l lg:border-t-0 xl:w-[400px]"
        >
          {selected ? (
            // ── Detail panel ───────────────────────────────────────────────
            <div className="flex flex-col h-full overflow-hidden">
              {/* Blue header */}
              <div className="shrink-0 flex items-center gap-3 px-4 py-3 bg-blue-600 text-white">
                <button
                  onClick={() => {
                    setSelected(null);
                    setTrail([]);
                  }}
                  className="p-1 rounded-lg hover:bg-white/20 transition-colors shrink-0"
                  style={{ background: "none", border: "none", cursor: "pointer" }}
                >
                  <ArrowLeft className="w-4 h-4" />
                </button>
                <div className="flex-1 min-w-0">
                  <div className="font-bold text-sm truncate">{selected.name}</div>
                  {selected.territories?.name && (
                    <div className="text-blue-200 text-[0.65rem] truncate">
                      {selected.territories.name}
                    </div>
                  )}
                </div>
                <div
                  className={`px-2 py-0.5 rounded-full text-[0.6rem] font-medium shrink-0 ${
                    gpsProblemLabel(selected)
                      ? "bg-red-400/20 text-red-50 border border-red-300/30"
                      : selected.session?.status === "active"
                      ? "bg-emerald-400/20 text-emerald-100 border border-emerald-400/30"
                      : selected.session
                      ? "bg-white/20 text-blue-100 border border-white/20"
                      : "bg-white/10 text-blue-200 border border-white/10"
                  }`}
                >
                  {gpsProblemLabel(selected)
                    ? gpsProblemLabel(selected)
                    : selected.session?.status === "active"
                    ? "Active"
                    : selected.session
                    ? "Checked Out"
                    : "Offline"}
                </div>
              </div>

              {/* At-a-glance stats */}
              <div className="shrink-0 border-b border-black/[0.06] bg-zinc-50/70 p-3">
                <div className="grid grid-cols-2 gap-2.5">
                  <div className="flex items-center gap-3 rounded-xl border border-black/[0.06] bg-white p-3 shadow-sm">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-blue-50 text-blue-600">
                      <Route className="h-4 w-4" />
                    </div>
                    <div className="min-w-0">
                      <div className="text-lg font-bold leading-none text-zinc-900">{trailDistKm.toFixed(2)}</div>
                      <div className="mt-1 text-[0.58rem] font-semibold uppercase tracking-wide text-zinc-400">Distance · km</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 rounded-xl border border-black/[0.06] bg-white p-3 shadow-sm">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-amber-50 text-amber-600">
                      <Clock className="h-4 w-4" />
                    </div>
                    <div className="min-w-0">
                      <div className="text-lg font-bold leading-none text-zinc-900">
                        {fmtDurationHr(selected.session?.check_in_time ?? null, selected.session?.check_out_time ?? null)}
                      </div>
                      <div className="mt-1 text-[0.58rem] font-semibold uppercase tracking-wide text-zinc-400">Time on duty</div>
                    </div>
                  </div>
                </div>
                <div className="mt-2 flex items-center justify-between gap-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2">
                  <div className="flex items-center gap-1.5 text-[0.62rem] font-bold text-emerald-700">
                    <ShieldCheck className="h-3.5 w-3.5" /> Verified movement only
                  </div>
                  {verifiedTrail.rejected > 0 && (
                    <div className="text-right text-[0.58rem] font-semibold text-emerald-600">{verifiedTrail.rejected} noisy pings removed</div>
                  )}
                </div>
                {selected.session?.start_odometer_km != null && (
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white">
                      {selected.session.start_odometer_photo_url && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={selected.session.start_odometer_photo_url} alt="Start odometer evidence" className="h-20 w-full bg-zinc-900 object-cover" />
                      )}
                      <div className="px-2.5 py-2"><div className="text-[0.58rem] font-bold uppercase tracking-wide text-zinc-400">Start odometer</div><div className="mt-0.5 text-sm font-black tabular-nums text-zinc-900">{Number(selected.session.start_odometer_km).toLocaleString("en-IN")} km</div></div>
                    </div>
                    <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white">
                      {selected.session.end_odometer_photo_url ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={selected.session.end_odometer_photo_url} alt="End odometer evidence" className="h-20 w-full bg-zinc-900 object-cover" />
                      ) : <div className="flex h-20 items-center justify-center bg-zinc-100 text-[0.62rem] font-semibold text-zinc-400">Duty still active</div>}
                      <div className="px-2.5 py-2"><div className="text-[0.58rem] font-bold uppercase tracking-wide text-zinc-400">End odometer</div><div className="mt-0.5 text-sm font-black tabular-nums text-zinc-900">{selected.session.end_odometer_km == null ? "Pending" : `${Number(selected.session.end_odometer_km).toLocaleString("en-IN")} km`}</div></div>
                    </div>
                  </div>
                )}
              </div>

              {/* Locked route progress */}
              {routeRun && (
                <div className="shrink-0 border-b border-blue-200 bg-gradient-to-r from-blue-50 to-indigo-50 px-4 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 text-[0.62rem] font-bold uppercase tracking-wider text-blue-600">
                        <Route className="h-3.5 w-3.5" /> Locked field route
                      </div>
                      <div className="mt-1 text-xs font-bold leading-snug text-zinc-900">
                        {routeRun.route_name || "Today’s selected route"}
                      </div>
                    </div>
                    <div className={`shrink-0 rounded-full px-2 py-1 text-[0.6rem] font-bold ${routeRun.status === "completed" ? "bg-emerald-100 text-emerald-700" : "bg-blue-100 text-blue-700"}`}>
                      {routeRun.visits.length}/{routeRun.total_stops} visited
                    </div>
                  </div>
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-blue-100">
                    <div
                      className={`h-full rounded-full transition-all ${routeRun.status === "completed" ? "bg-emerald-500" : "bg-blue-600"}`}
                      style={{ width: `${routeRun.total_stops ? Math.round((routeRun.visits.length / routeRun.total_stops) * 100) : 0}%` }}
                    />
                  </div>
                  <div className="mt-1.5 flex items-center justify-between text-[0.58rem] font-semibold text-zinc-500">
                    <span>Started {fmtTime(routeRun.started_at)}</span>
                    <span>{routeRun.status === "completed" ? `Completed ${fmtTime(routeRun.completed_at)}` : "Live in progress"}</span>
                  </div>
                </div>
              )}

              {/* App-killed warning */}
              {isAppKilled(selected) && (
                <div className="shrink-0 flex items-start gap-2 px-4 py-2.5 border-b border-red-500/20 bg-red-500/5">
                  <AppWindow className="w-3.5 h-3.5 text-red-400 shrink-0 mt-0.5" />
                  <span className="text-red-400 text-[0.65rem] font-medium">
                    {appKilledLabel(selected)}
                  </span>
                </div>
              )}

              {/* Parties visited */}
              <div className="shrink-0 border-b border-black/[0.06]">
                <div className="flex items-center justify-between px-4 py-3">
                  <div className="flex items-center gap-2">
                    <Store className="w-4 h-4 text-blue-600" />
                    <span className="text-zinc-900 text-sm font-semibold">
                      Parties Visited
                    </span>
                  </div>
                  <span className="px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-600 text-[0.65rem] font-semibold">
                    {visits.length}
                  </span>
                </div>

                <div className="max-h-48 overflow-y-auto px-4 pb-3 space-y-2">
                  {visitsLoading && visits.length === 0 ? (
                    <div className="flex items-center justify-center py-4">
                      <RefreshCw className="w-4 h-4 text-amber-400 animate-spin" />
                    </div>
                  ) : visits.length === 0 ? (
                    <div className="flex items-center gap-2 rounded-lg border border-dashed border-zinc-200 bg-zinc-50 px-3 py-2.5 text-zinc-500">
                      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-white text-zinc-400 shadow-sm">
                        <Store className="h-3.5 w-3.5" />
                      </div>
                      <div>
                        <p className="text-[0.68rem] font-semibold text-zinc-600">No visits completed yet</p>
                        <p className="text-[0.56rem] text-zinc-400">Verified party visits will appear here.</p>
                      </div>
                    </div>
                  ) : (
                    visits.map((v, i) => {
                      const within = v.is_within_geofence;
                      return (
                        <div
                          key={v.id}
                          className="flex items-start gap-2.5 p-2 rounded-lg border border-black/[0.05] bg-black/[0.015] hover:bg-black/[0.03] transition-colors"
                        >
                          <div className="shrink-0 w-7 h-7 rounded-lg bg-blue-600/10 text-blue-600 flex items-center justify-center text-[0.65rem] font-bold">
                            {i + 1}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="text-zinc-900 text-xs font-semibold truncate">
                              {v.party_name}
                            </div>
                            {(v.address || v.party_code) && (
                              <div className="flex items-center gap-1 text-zinc-500 text-[0.6rem] mt-0.5">
                                <MapPin className="w-2.5 h-2.5 shrink-0" />
                                <span className="truncate">
                                  {v.address || v.party_code}
                                </span>
                              </div>
                            )}
                            <div className="flex items-center gap-2 mt-1 flex-wrap">
                              {v.source === "manual" ? (
                                <span className="text-zinc-600 text-[0.6rem]">
                                  Logged {fmtTime(v.check_in_time)}
                                </span>
                              ) : (
                                <>
                                  <span className="text-zinc-600 text-[0.6rem]">
                                    In {fmtTime(v.check_in_time)}
                                    {v.check_out_time
                                      ? ` · Out ${fmtTime(v.check_out_time)}`
                                      : ""}
                                  </span>
                                  {v.check_in_time && (
                                    <span className="text-zinc-400 text-[0.6rem]">
                                      {fmtDurationHr(
                                        v.check_in_time,
                                        v.check_out_time
                                      )}
                                    </span>
                                  )}
                                </>
                              )}
                            </div>
                            {v.notes && (
                              <div className="mt-1.5 rounded-md bg-white px-2 py-1.5 text-[0.62rem] leading-relaxed text-zinc-600 ring-1 ring-black/[0.05]">
                                <span className="font-bold text-zinc-700">Note: </span>{v.notes}
                              </div>
                            )}
                          </div>
                          {v.source === "manual" ? (
                            <div className="shrink-0 flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[0.55rem] font-medium bg-indigo-500/10 text-indigo-600">
                              <ClipboardList className="w-2.5 h-2.5" />
                              Manual
                            </div>
                          ) : within != null ? (
                            <div
                              className={`shrink-0 flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[0.55rem] font-medium ${
                                within
                                  ? "bg-emerald-500/10 text-emerald-600"
                                  : "bg-amber-500/10 text-amber-600"
                              }`}
                            >
                              {within ? (
                                <ShieldCheck className="w-2.5 h-2.5" />
                              ) : (
                                <ShieldAlert className="w-2.5 h-2.5" />
                              )}
                              {within
                                ? "On-site"
                                : v.deviation_meters
                                ? `${v.deviation_meters}m off`
                                : "Off-site"}
                            </div>
                          ) : null}
                        </div>
                      );
                    })
                  )}
                </div>
              </div>

              {/* Timeline header */}
              <div className="shrink-0 flex items-center justify-between px-4 py-3 border-b border-black/[0.06]">
                <span className="text-zinc-900 text-sm font-semibold">
                  Activity Timeline
                </span>
                <div className="flex items-center gap-2 text-zinc-500 text-xs">
                  <Calendar className="w-3.5 h-3.5" />
                  <span>{fmtDate(selectedDate)}</span>
                </div>
              </div>

              {/* Timeline entries */}
              <div className="flex-1 space-y-2.5 overflow-y-auto bg-zinc-50/60 px-4 py-3">
                {trailLoading ? (
                  <div className="flex items-center justify-center py-8">
                    <RefreshCw className="w-5 h-5 text-amber-400 animate-spin" />
                  </div>
                ) : (
                  <>
                    {/* Check-out event (most recent, shown first) */}
                    {selected.session?.check_out_time &&
                      verifiedTrail.points.length === 0 &&
                      ((checkOutTime: string) => {
                        const log = nearestTrailLog(verifiedTrail.points, checkOutTime);
                        const place = log ? locLabel(log) : null;
                        return (
                          <div className="flex items-start gap-3">
                            <div className="w-2.5 h-2.5 rounded-full bg-red-400 shrink-0 mt-1" />
                            <div className="flex-1 min-w-0">
                              <div className="text-sm text-zinc-700 font-medium">
                                User checked out
                              </div>
                              {place && (
                                <div className="flex items-center gap-1 text-zinc-500 text-[0.65rem] mt-0.5">
                                  <MapPin className="w-2.5 h-2.5 shrink-0" />
                                  <span className="truncate">{place}</span>
                                </div>
                              )}
                            </div>
                            <span className="text-xs text-zinc-500 shrink-0">
                              {fmtTime(checkOutTime)}
                            </span>
                          </div>
                        );
                      })(selected.session.check_out_time)}

                    {/* Location trail events (newest first) */}
                    {[...verifiedTrail.points].reverse().slice(0, 2).map((log, ri) => {
                      const i = verifiedTrail.points.length - 1 - ri;
                      const isLast = i === verifiedTrail.points.length - 1;
                      const label = locLabel(log);
                      const coordinateLabel = `${log.latitude.toFixed(6)}, ${log.longitude.toFixed(6)}`;
                      const hasPlace = label !== `${log.latitude.toFixed(4)}, ${log.longitude.toFixed(4)}`;
                      return (
                        <div key={log.id || i} className="flex items-start gap-3 rounded-xl border border-emerald-200/80 bg-emerald-50/70 p-3 shadow-sm">
                          <div className="mt-1 h-2 w-2 shrink-0 rounded-full bg-emerald-500 ring-4 ring-emerald-100" />
                          <div className="flex-1 min-w-0">
                            <div className="text-xs font-semibold text-zinc-800">
                              {hasPlace ? label : isLast ? "Current verified position" : log.break_before ? "GPS signal resumed" : "Movement recorded"}
                            </div>
                            <div className="mt-0.5 font-mono text-[0.58rem] text-zinc-500">
                              {coordinateLabel}
                            </div>
                            <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[0.56rem] text-zinc-400">
                              {log.accuracy ? <span>±{Math.round(log.accuracy)}m accuracy</span> : null}
                              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-1.5 py-0.5 font-semibold text-emerald-700">
                                <ShieldCheck className="h-2.5 w-2.5" />
                                signal verified
                              </span>
                            </div>
                            {log.activity && log.activity !== "moving" && (
                              <div className="text-[0.6rem] text-zinc-500 capitalize">
                                {log.activity}
                              </div>
                            )}
                          </div>
                          <span className="text-[0.65rem] text-zinc-500 shrink-0">
                            {fmtTime(log.recorded_at)}
                          </span>
                        </div>
                      );
                    })}

                    {/* Check-in event (oldest, shown last) */}
                    {selected.session?.check_in_time &&
                      !selected.session.check_out_time &&
                      verifiedTrail.points.length === 0 &&
                      ((checkInTime: string) => {
                        const log = nearestTrailLog(verifiedTrail.points, checkInTime);
                        const place = log ? locLabel(log) : null;
                        return (
                          <div className="flex items-start gap-3">
                            <div className="w-2.5 h-2.5 rounded-full bg-blue-500 shrink-0 mt-1" />
                            <div className="flex-1 min-w-0">
                              <div className="text-sm text-zinc-700 font-medium">
                                User checked in
                              </div>
                              {place && (
                                <div className="flex items-center gap-1 text-zinc-500 text-[0.65rem] mt-0.5">
                                  <MapPin className="w-2.5 h-2.5 shrink-0" />
                                  <span className="truncate">{place}</span>
                                </div>
                              )}
                            </div>
                            <span className="text-xs text-zinc-500 shrink-0">
                              {fmtTime(checkInTime)}
                            </span>
                          </div>
                        );
                      })(selected.session.check_in_time)}

                    {/* Empty state */}
                    {!selected.session && (
                      <div className="flex flex-col items-center justify-center py-10 text-zinc-500">
                        <XCircle className="w-8 h-8 mb-2 opacity-30" />
                        <p className="text-xs">No activity on this date</p>
                      </div>
                    )}

                    {selected.session &&
                      !selected.session.check_in_time &&
                      verifiedTrail.points.length === 0 && (
                        <div className="text-center text-zinc-500 text-xs py-6">
                          No location data recorded
                        </div>
                      )}
                  </>
                )}
              </div>
            </div>
          ) : (
            // ── User list ─────────────────────────────────────────────────
            <div className="flex flex-col h-full overflow-hidden">
              {/* List header */}
              <div className="shrink-0 px-4 pt-4 pb-3 border-b border-black/[0.06]">
                <div className="flex items-center gap-2 mb-3">
                  <Users className="w-4 h-4 text-zinc-600" />
                  <h2 className="text-zinc-900 font-semibold text-sm">Users</h2>
                  <span className="ml-auto text-zinc-500 text-xs">
                    {filteredSalesmen.length} shown
                  </span>
                </div>
                {/* Search */}
                <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-black/[0.08] bg-black/[0.02]">
                  <Search className="w-3.5 h-3.5 text-zinc-400 shrink-0" />
                  <input
                    type="text"
                    placeholder="Search user"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    className="flex-1 bg-transparent text-sm text-zinc-900 outline-none placeholder:text-zinc-400"
                  />
                </div>
              </div>

              {/* User list */}
              <div className="flex-1 overflow-y-auto">
                {loading && salesmen.length === 0 ? (
                  <div className="flex items-center justify-center py-10">
                    <RefreshCw className="w-5 h-5 text-amber-400 animate-spin" />
                  </div>
                ) : filteredSalesmen.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-10 text-zinc-500">
                    <Users className="w-8 h-8 mb-2 opacity-30" />
                    <p className="text-xs">No users found</p>
                  </div>
                ) : (
                  filteredSalesmen.map((s) => {
                    const loc = liveLocations[s.id] || s.latest_location;
                    const isActive = s.session?.status === "active";
                    const hasLoc = !!loc;
                    const gpsProblem = gpsProblemLabel(s);

                    return (
                      <button
                        key={s.id}
                        onClick={() => setSelected(s)}
                        className="w-full flex items-center gap-3 px-4 py-3 border-b border-black/[0.04] hover:bg-black/[0.02] transition-colors text-left group"
                        style={{ cursor: "pointer", fontFamily: "inherit" }}
                      >
                        {/* Avatar */}
                        <div className="relative shrink-0">
                          <div
                            className={`w-10 h-10 rounded-full flex items-center justify-center text-xs font-bold text-white ${
                              gpsProblem ? "bg-red-500" : isActive ? "bg-blue-600" : "bg-zinc-400"
                            }`}
                          >
                            {initials(s.name)}
                          </div>
                          {isActive && (
                            <span className={`absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-white ${gpsProblem ? "bg-red-500" : "bg-emerald-400"}`} />
                          )}
                          {hasLoc && !isActive && (
                            <span className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full bg-zinc-300 border-2 border-white" />
                          )}
                        </div>

                        {/* Name */}
                        <div className="flex-1 min-w-0">
                          <div className="text-zinc-900 text-sm font-medium truncate group-hover:text-blue-600 transition-colors">
                            {s.name}
                          </div>
                          {s.territories?.name && (
                            <div className="text-zinc-500 text-[0.65rem] truncate">
                              {s.territories.name}
                            </div>
                          )}
                        </div>

                        {/* Right: last ping time or status */}
                        <div className="text-right shrink-0">
                          {gpsProblem ? (
                            <span className="rounded-full bg-red-50 px-2 py-1 text-[0.62rem] font-bold text-red-600">
                              {gpsProblem}
                            </span>
                          ) : loc ? (
                            <span className="text-xs text-zinc-600 font-medium">
                              {fmtTime(loc.recorded_at)}
                            </span>
                          ) : (
                            <span className="text-[0.65rem] text-zinc-400">
                              Offline
                            </span>
                          )}
                        </div>
                      </button>
                    );
                  })
                )}
              </div>

              {/* Footer stats */}
              <div className="shrink-0 border-t border-black/[0.06] px-4 py-3 bg-black/[0.01]">
                <div className="flex items-center justify-between text-[0.65rem] text-zinc-500">
                  <div className="flex items-center gap-3">
                    <span className="flex items-center gap-1">
                      <Zap className="w-3 h-3 text-emerald-500" />
                      {stats.active} active
                    </span>
                    <span className="flex items-center gap-1">
                      <CheckCircle className="w-3 h-3 text-zinc-400" />
                      {stats.total - stats.active - stats.offline} checked out
                    </span>
                    <span className="flex items-center gap-1">
                      <XCircle className="w-3 h-3 text-red-400" />
                      {stats.offline} offline
                    </span>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
      )}
    </div>
  );
}
