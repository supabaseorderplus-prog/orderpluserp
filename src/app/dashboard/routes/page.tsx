"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, getUser, getModulePermission } from "@/lib/api";
import { getAndroidNativePlugin } from "@/lib/capacitor-native-plugin";
import {
  Loader2, MapPin, Route as RouteIcon, Plus, X, Trash2, Edit2, Navigation, Map,
  AlertCircle, Crosshair, Play, ShieldCheck, Radio, CheckCircle2, LockKeyhole,
  Clock3, LocateFixed, NotebookPen, ExternalLink, WifiOff, Sparkles,
} from "lucide-react";
import {
  haversineMeters,
  optimizeRouteWithRoadNetwork,
  type OptimizedRoute,
} from "@/lib/route-optimization";

// ── Inline Leaflet map for the Route Map tab ──────────────────────────────────
interface RouteMapParty {
  latitude?: number | string | null;
  longitude?: number | string | null;
  name?: string | null;
}
interface RouteMapStop {
  id?: string;
  stop_order?: number | null;
  parties: RouteMapParty | null;
}
interface RouteMapPoint {
  latitude: number;
  longitude: number;
  label?: string | null;
}

function toCoordinate(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function getStopPoint(stop: RouteMapStop): RouteMapPoint | null {
  const latitude = toCoordinate(stop.parties?.latitude);
  const longitude = toCoordinate(stop.parties?.longitude);
  if (latitude === null || longitude === null) return null;
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;
  return { latitude, longitude, label: stop.parties?.name || null };
}

function hasStopCoordinates(stop: RouteMapStop): boolean {
  return getStopPoint(stop) !== null;
}

function RouteMapView({
  stops,
  origin,
  geometry,
  visitedStopIds = [],
  activeStopId = null,
}: {
  stops: RouteMapStop[];
  origin?: RouteMapPoint | null;
  geometry?: [number, number][];
  visitedStopIds?: string[];
  activeStopId?: string | null;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<unknown>(null);

  useEffect(() => {
    const stopPoints = stops.map(getStopPoint).filter((point): point is RouteMapPoint => Boolean(point));
    if (!containerRef.current || stopPoints.length === 0) return;

    let L: typeof import("leaflet");
    let map: import("leaflet").Map;
    let resizeObserver: ResizeObserver | null = null;
    let cancelled = false;

    import("leaflet").then((mod) => {
      if (cancelled || !containerRef.current) return;
      L = mod.default ?? mod;
      if (mapRef.current) {
        (mapRef.current as import("leaflet").Map).remove();
        mapRef.current = null;
      }

      map = L.map(containerRef.current!, { zoomControl: true, attributionControl: false });
      mapRef.current = map;

      resizeObserver = new ResizeObserver(() => {
        if (!cancelled) map.invalidateSize({ pan: false });
      });
      resizeObserver.observe(containerRef.current!);

      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
      }).addTo(map);

      const latlngs: [number, number][] = [];

      if (origin) {
        latlngs.push([origin.latitude, origin.longitude]);

        const originIcon = L.divIcon({
          html: `<div style="position:relative;width:30px;height:30px">
            <div style="position:absolute;inset:0;border-radius:50%;background:rgba(14,165,233,0.22);animation:route-ping 1.5s cubic-bezier(0,0,0.2,1) infinite"></div>
            <div style="position:absolute;inset:4px;border-radius:50%;background:#0ea5e9;border:2.5px solid white;box-shadow:0 2px 10px rgba(14,165,233,0.45);display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:800;color:white;font-family:system-ui">S</div>
          </div>`,
          className: "",
          iconSize: [30, 30],
          iconAnchor: [15, 15],
        });

        L.marker([origin.latitude, origin.longitude], { icon: originIcon })
          .addTo(map)
          .bindPopup(`<div style="font-size:12px;font-weight:700;min-width:110px">Salesman location</div>`);
      }

      stops.forEach((stop, idx) => {
        const point = getStopPoint(stop);
        if (!point) return;

        latlngs.push([point.latitude, point.longitude]);

        const isVisited = Boolean(stop.id && visitedStopIds.includes(stop.id));
        const isActive = stop.id === activeStopId;
        const color = isVisited ? "#10b981" : isActive ? "#f59e0b" : "#64748b";

        const icon = L.divIcon({
          html: `<div style="width:${isActive ? 32 : 26}px;height:${isActive ? 32 : 26}px;border-radius:50%;background:${color};border:3px solid white;box-shadow:0 3px 12px rgba(0,0,0,0.3);display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:800;color:white;font-family:monospace">${isVisited ? "✓" : idx + 1}</div>`,
          className: "",
          iconSize: [isActive ? 32 : 26, isActive ? 32 : 26],
          iconAnchor: [isActive ? 16 : 13, isActive ? 16 : 13],
        });

        L.marker([point.latitude, point.longitude], { icon })
          .addTo(map)
          .bindPopup(`<div style="font-size:12px;font-weight:600;min-width:100px">${point.label || `Stop ${idx + 1}`}</div>`);

        if (isActive) {
          L.circle([point.latitude, point.longitude], {
            radius: 100,
            color: "#f59e0b",
            weight: 2,
            dashArray: "6 6",
            fillColor: "#f59e0b",
            fillOpacity: 0.08,
          }).addTo(map);
        }
      });

      const line = geometry && geometry.length > 1 ? geometry : latlngs;
      if (line.length > 1) {
        L.polyline(line, { color: "rgba(37,99,235,0.18)", weight: 12, opacity: 1, lineCap: "round", lineJoin: "round" }).addTo(map);
        L.polyline(line, { color: "#2563eb", weight: 5, opacity: 0.92, lineCap: "round", lineJoin: "round" }).addTo(map);
        L.polyline(line, { color: "#fff", weight: 2, opacity: 0.9, dashArray: "2 14", className: "route-flow" }).addTo(map);
      }

      if (latlngs.length > 0) {
        map.fitBounds(L.latLngBounds(latlngs), { padding: [32, 32] });
      }

      requestAnimationFrame(() => {
        if (!cancelled) map.invalidateSize({ pan: false });
      });
    });

    return () => {
      cancelled = true;
      resizeObserver?.disconnect();
      if (mapRef.current) {
        (mapRef.current as import("leaflet").Map).remove();
        mapRef.current = null;
      }
    };
  }, [stops, origin, geometry, visitedStopIds, activeStopId]);

  return (
    <div className="relative h-full min-h-[300px] w-full flex-1">
      <style>{`
        @import url("https://unpkg.com/leaflet@1.9.4/dist/leaflet.css");
        @keyframes route-ping {
          75%, 100% { transform: scale(2.15); opacity: 0; }
        }
        @keyframes route-flow { to { stroke-dashoffset: -120; } }
        path.route-flow { animation: route-flow 3s linear infinite; }
        .leaflet-container { background: #f8fafc !important; }
        .leaflet-control-zoom { border: 1px solid #e4e4e7 !important; border-radius: 8px !important; overflow: hidden; }
        .leaflet-control-zoom a { background: #fff !important; color: #3f3f46 !important; border-color: #e4e4e7 !important; }
        .leaflet-popup-content-wrapper { border-radius: 10px !important; border: 1px solid #e4e4e7 !important; box-shadow: 0 8px 22px rgba(15,23,42,0.14) !important; }
        .leaflet-popup-content { margin: 10px 28px 10px 12px !important; }
      `}</style>
      <div ref={containerRef} style={{ position: "absolute", inset: 0 }} />
    </div>
  );
}
// ─────────────────────────────────────────────────────────────────────────────

interface RouteData {
  id: string;
  name: string;
  code: string;
  salesman: { name: string } | null;
  stops: number;
  isActive: boolean;
}

interface Salesman { id: string; name: string; }
interface Group {
  id: string;
  name: string;
  code: string | null;
  salesman_id: string | null;
  salesman_name: string | null;
  member_count: number;
  member_ids: string[];
}

// A route's weekday is stored in the route `code` field (e.g. "MON"). One day per route.
const WEEKDAYS = [
  { value: "MON", short: "Mon", label: "Monday" },
  { value: "TUE", short: "Tue", label: "Tuesday" },
  { value: "WED", short: "Wed", label: "Wednesday" },
  { value: "THU", short: "Thu", label: "Thursday" },
  { value: "FRI", short: "Fri", label: "Friday" },
  { value: "SAT", short: "Sat", label: "Saturday" },
  { value: "SUN", short: "Sun", label: "Sunday" },
] as const;

// Map a stored code → full weekday name. Legacy routes whose code was a free-form
// code (e.g. "RT-001") fall through and render their raw value unchanged.
function dayLabel(code: string | null | undefined): string {
  if (!code) return "";
  return WEEKDAYS.find(d => d.value === code.toUpperCase())?.label ?? code;
}
interface Party {
  id: string; name: string; party_code: string;
  latitude?: number | null; longitude?: number | null;
  address_line1?: string | null; city?: string | null;
  parent_party_id?: string | null;
  party_types?: { name: string } | null;
}
interface RouteStop { id: string; stop_order: number; notes: string | null; party_id: string; parties: Party | null; }
interface SalesmanDownlineUser { id: string; assigned_party_id?: string | null; }

interface DutySession {
  id: string;
  status: "active" | "checked_out";
  check_in_time: string;
  check_out_time: string | null;
  total_distance_km: number;
  total_stops: number;
}

interface RouteRunVisit {
  stop_id: string;
  party_id: string;
  visited_at: string;
  latitude: number;
  longitude: number;
  distance_m: number;
  notes: string;
}

interface RouteRun {
  id: string;
  route_id: string;
  status: "active" | "completed";
  ordered_stop_ids: string[];
  visits: RouteRunVisit[];
  total_stops: number;
  active_stop_id: string | null;
  started_at: string;
  completed_at: string | null;
}

interface DutySignoffQueueItem {
  run_id: string;
  salesman_id: string;
  salesman_name: string;
  route_id: string;
  route_name: string;
  work_date: string;
  total_stops: number;
  visited_stops: number;
  remaining_stops: number;
  remaining_parties: Array<{ stop_id: string; party_id: string; name: string }>;
  request: {
    id: string;
    status: "pending" | "approved" | "rejected";
    reason: string;
    requested_at: string;
    decision_note: string | null;
  };
}

interface OptimizableStop extends RouteStop {
  latitude: number;
  longitude: number;
}

interface RoutePlan {
  stops: RouteStop[];
  distanceMeters: number;
  durationSeconds: number;
  geometry: [number, number][];
  source: "road-network" | "distance-fallback";
  missingStopIds: string[];
}

const s: React.CSSProperties = { transform: "none", filter: "none", WebkitTextStroke: "0", background: "none", boxShadow: "none", display: "block", padding: 0 };

function getErrorMessage(err: unknown, fallback: string) {
  return err instanceof Error && err.message ? err.message : fallback;
}

function formatRouteDuration(seconds: number) {
  const minutes = Math.max(1, Math.round(seconds / 60));
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function formatDutyTime(iso: string) {
  return new Date(iso).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true });
}

function currentPosition(): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("Location is not available on this device"));
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      timeout: 15_000,
      maximumAge: 5_000,
    });
  });
}

type RouteNativeLocationPlugin = {
  requestBackgroundPermission: () => Promise<{ granted: boolean }>;
  requestReliabilityPermissions: () => Promise<{
    batteryOptimizationDisabled: boolean;
    backgroundLocationGranted: boolean;
    notificationsGranted: boolean;
  }>;
  startTracking: (input: {
    authToken: string;
    refreshToken: string;
    companyId: string;
    userId: string;
    resumeActiveDuty?: boolean;
  }) => Promise<void>;
  isTracking: () => Promise<{ active: boolean }>;
  getGpsStatus: () => Promise<{
    locationServicesEnabled: boolean;
    fineLocationGranted: boolean;
    trackingActive: boolean;
  }>;
  openLocationSettings: () => Promise<{ opened: boolean }>;
  stopTracking: () => Promise<void>;
};

async function startPersistentAndroidTracking(
  userId: string,
  { resumeActiveDuty = false }: { resumeActiveDuty?: boolean } = {},
) {
  if (typeof window === "undefined") return false;
  const plugin = getAndroidNativePlugin<RouteNativeLocationPlugin>("BackgroundLocation");
  if (!plugin) return false;
  const authToken = localStorage.getItem("accessToken") || "";
  if (!authToken || !userId) return false;
  const gpsStatus = await plugin.getGpsStatus();
  if (!gpsStatus.locationServicesEnabled && !resumeActiveDuty) {
    await plugin.openLocationSettings().catch(() => ({ opened: false }));
    throw new Error("GPS is turned off. Turn it on in your phone settings before starting duty.");
  }
  if (!resumeActiveDuty) {
    try { await plugin.requestBackgroundPermission(); } catch {}
    try { await plugin.requestReliabilityPermissions(); } catch {}
  }
  const status = await plugin.isTracking().catch(() => ({ active: false }));
  if (!status.active) {
    await plugin.startTracking({
      authToken,
      refreshToken: localStorage.getItem("refreshToken") || "",
      companyId: localStorage.getItem("activeCompanyId") || "",
      userId,
      resumeActiveDuty,
    });
  }
  return true;
}

function notifyDutyServiceWorker(type: "DUTY_START" | "DUTY_END") {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.ready.then((registration) => {
    registration.active?.postMessage({
      type,
      token: localStorage.getItem("accessToken") || "",
      baseUrl: window.location.origin,
    });
  }).catch(() => {});
}

function SalesmanRoutesExperience({ routes, loading }: { routes: RouteData[]; loading: boolean }) {
  const user = getUser();
  const [duty, setDuty] = useState<DutySession | null>(null);
  const [run, setRun] = useState<RouteRun | null>(null);
  const [fieldLoading, setFieldLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState("");
  const [selectedRoute, setSelectedRoute] = useState<RouteData | null>(null);
  const [stops, setStops] = useState<RouteStop[]>([]);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [planLoading, setPlanLoading] = useState(false);
  const [plan, setPlan] = useState<RoutePlan | null>(null);
  const [location, setLocation] = useState<(RouteMapPoint & { accuracy?: number }) | null>(null);
  const [locationError, setLocationError] = useState("");
  const [nativeProtected, setNativeProtected] = useState(false);
  const [noteStop, setNoteStop] = useState<RouteStop | null>(null);
  const [visitNote, setVisitNote] = useState("");
  const [visitSaving, setVisitSaving] = useState(false);
  const lastPingRef = useRef(0);

  const isOnDuty = duty?.status === "active";
  const visitedIds = useMemo(() => (run?.visits || []).map((visit) => visit.stop_id), [run?.visits]);

  const loadFieldState = useCallback(async () => {
    try {
      const result = await api<{ data: { duty: DutySession | null; run: RouteRun | null } }>(
        "/api/v1/duty/route-run",
        { noCache: true, suppressErrorLog: true },
      );
      setDuty(result.data.duty);
      setRun(result.data.run);
    } catch (error) {
      setFieldError(getErrorMessage(error, "Could not load today's field status"));
    } finally {
      setFieldLoading(false);
    }
  }, []);

  useEffect(() => { void loadFieldState(); }, [loadFieldState]);

  const postLocation = useCallback((pos: GeolocationPosition, force = false) => {
    const next = {
      latitude: pos.coords.latitude,
      longitude: pos.coords.longitude,
      accuracy: pos.coords.accuracy,
      label: "Live salesman location",
    };
    setLocation(next);
    setLocationError("");
    const now = Date.now();
    if (!force && now - lastPingRef.current < 10_000) return;
    lastPingRef.current = now;
    void api("/api/v1/duty/location", {
      method: "POST",
      body: {
        latitude: next.latitude,
        longitude: next.longitude,
        accuracy: next.accuracy,
        speed: pos.coords.speed ?? null,
        heading: pos.coords.heading ?? null,
        activity: "route_tracking",
        queued_at: new Date().toISOString(),
      },
      suppressErrorLog: true,
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!isOnDuty || !navigator.geolocation) return;
    notifyDutyServiceWorker("DUTY_START");
    void startPersistentAndroidTracking(
      user?.id || "",
      { resumeActiveDuty: true },
    ).then(setNativeProtected).catch(() => {});
    const watch = navigator.geolocation.watchPosition(
      (position) => postLocation(position),
      (error) => setLocationError(error.code === error.PERMISSION_DENIED
        ? "Location permission is required while duty is active."
        : "Waiting for a stable GPS signal…"),
      { enableHighAccuracy: true, maximumAge: 5_000, timeout: 15_000 },
    );
    return () => navigator.geolocation.clearWatch(watch);
  }, [isOnDuty, postLocation, user?.id]);

  async function ensureFreshLocation() {
    const position = await currentPosition();
    postLocation(position, true);
    return {
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
      label: "Live salesman location",
      accuracy: position.coords.accuracy,
    };
  }

  async function startDuty() {
    setActionLoading("duty");
    setFieldError("");
    let nativeStarted = false;
    try {
      nativeStarted = await startPersistentAndroidTracking(user?.id || "");
      const origin = await ensureFreshLocation();
      const result = await api<{ data: DutySession }>("/api/v1/duty/session", {
        method: "POST",
        body: { latitude: origin.latitude, longitude: origin.longitude },
      });
      setDuty(result.data);
      notifyDutyServiceWorker("DUTY_START");
      setNativeProtected(nativeStarted);
    } catch (error) {
      if (nativeStarted) {
        const plugin = getAndroidNativePlugin<RouteNativeLocationPlugin>("BackgroundLocation");
        await plugin?.stopTracking().catch(() => {});
      }
      setFieldError(getErrorMessage(error, "Allow precise location access before starting duty."));
    } finally {
      setActionLoading(null);
    }
  }

  async function buildPlan(route: RouteData, shouldStart: boolean) {
    setSelectedRoute(route);
    setWorkspaceOpen(true);
    setPlanLoading(true);
    setPlan(null);
    setFieldError("");
    try {
      const result = await api<{ data: RouteStop[] }>(`/api/v1/tracking/routes/stops?route_id=${route.id}`);
      const rawStops = (result.data || []).sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));
      setStops(rawStops);
      const origin = location || await ensureFreshLocation();
      const mappable = rawStops.flatMap((stop) => {
        const point = getStopPoint(stop);
        return point ? [{ ...stop, id: stop.id, latitude: point.latitude, longitude: point.longitude }] : [];
      });
      if (mappable.length === 0) throw new Error("This route has no parties to visit.");

      const mappableIds = new Set(mappable.map((stop) => stop.id));
      const missingStops = rawStops.filter((stop) => !mappableIds.has(stop.id));

      let optimized: OptimizedRoute<OptimizableStop>;
      if (run?.route_id === route.id && run.ordered_stop_ids.length > 0) {
        const order = new globalThis.Map(run.ordered_stop_ids.map((id, index) => [id, index]));
        const ordered = [...mappable].sort((a, b) => (order.get(a.id) ?? 999) - (order.get(b.id) ?? 999));
        const distance = ordered.reduce((total, stop, index) => {
          const previous = index === 0 ? origin : ordered[index - 1];
          return total + haversineMeters(previous, stop);
        }, 0);
        optimized = {
          stops: ordered,
          distanceMeters: distance,
          durationSeconds: Math.round(distance / 8.33),
          geometry: [origin, ...ordered].map((point) => [point.latitude, point.longitude]),
          source: "distance-fallback",
        };
      } else {
        optimized = await optimizeRouteWithRoadNetwork(origin, mappable);
      }
      const fullOrder = run?.route_id === route.id && run.ordered_stop_ids.length > 0
        ? [...rawStops].sort((a, b) => {
            const aIndex = run.ordered_stop_ids.indexOf(a.id);
            const bIndex = run.ordered_stop_ids.indexOf(b.id);
            return (aIndex < 0 ? 999 : aIndex) - (bIndex < 0 ? 999 : bIndex);
          })
        : [...optimized.stops, ...missingStops];
      const preparedPlan: RoutePlan = {
        ...optimized,
        stops: fullOrder,
        missingStopIds: missingStops.map((stop) => stop.id),
      };
      setPlan(preparedPlan);
      setStops(fullOrder);

      if (shouldStart) {
        await api("/api/v1/duty/location", {
          method: "POST",
          body: { latitude: origin.latitude, longitude: origin.longitude, accuracy: origin.accuracy ?? null, activity: "route_start" },
          suppressErrorLog: true,
        });
        const started = await api<{ data: RouteRun }>("/api/v1/duty/route-run", {
          method: "POST",
          body: { action: "start", route_id: route.id, ordered_stop_ids: fullOrder.map((stop) => stop.id) },
        });
        setRun(started.data);
      }
    } catch (error) {
      setFieldError(getErrorMessage(error, "Route plan could not be prepared"));
    } finally {
      setPlanLoading(false);
      setActionLoading(null);
    }
  }

  function handleRouteAction(route: RouteData) {
    if (!isOnDuty) return;
    if (run && run.route_id !== route.id) return;
    setActionLoading(route.id);
    void buildPlan(route, !run);
  }

  async function saveVisit() {
    if (!noteStop || !location) return;
    setVisitSaving(true);
    setFieldError("");
    try {
      const fresh = await ensureFreshLocation();
      await api("/api/v1/duty/location", {
        method: "POST",
        body: { latitude: fresh.latitude, longitude: fresh.longitude, accuracy: fresh.accuracy, activity: "party_visit" },
        suppressErrorLog: true,
      });
      const result = await api<{ data: RouteRun }>("/api/v1/duty/route-run", {
        method: "POST",
        body: { action: "visit", stop_id: noteStop.id, notes: visitNote },
      });
      setRun(result.data);
      setNoteStop(null);
      setVisitNote("");
    } catch (error) {
      setFieldError(getErrorMessage(error, "Visit could not be verified"));
    } finally {
      setVisitSaving(false);
    }
  }

  function rememberChosenStop(stop: RouteStop) {
    if (!run || visitedIds.includes(stop.id)) return;
    setRun((current) => current ? { ...current, active_stop_id: stop.id } : current);
    void api<{ data: RouteRun }>("/api/v1/duty/route-run", {
      method: "POST",
      body: { action: "select_stop", stop_id: stop.id },
      suppressErrorLog: true,
    }).then((result) => setRun(result.data)).catch((error) => {
      setFieldError(getErrorMessage(error, "Could not save the selected party"));
      void loadFieldState();
    });
  }

  const activeRoute = run ? routes.find((route) => route.id === run.route_id) || null : null;
  const displayedRoutes = useMemo(() => {
    if (!run?.route_id) return routes;
    const lockedRoute = routes.find((route) => route.id === run.route_id);
    if (!lockedRoute) return routes;
    return [lockedRoute, ...routes.filter((route) => route.id !== run.route_id)];
  }, [routes, run?.route_id]);
  const displayStops = plan?.stops || stops;
  const smartSuggestedStop = displayStops.find((stop) => !visitedIds.includes(stop.id)) || null;
  const chosenStop = displayStops.find((stop) => stop.id === run?.active_stop_id && !visitedIds.includes(stop.id)) || smartSuggestedStop;
  const chosenPoint = chosenStop ? getStopPoint(chosenStop) : null;
  const progress = run?.total_stops ? Math.round((visitedIds.length / run.total_stops) * 100) : 0;
  const navigateUrl = location && chosenPoint
    ? `https://www.google.com/maps/dir/?api=1&origin=${location.latitude},${location.longitude}&destination=${chosenPoint.latitude},${chosenPoint.longitude}&travelmode=driving&dir_action=navigate`
    : null;

  function navigationUrlFor(stop: RouteStop) {
    const point = getStopPoint(stop);
    if (!point) return null;
    const origin = location ? `&origin=${location.latitude},${location.longitude}` : "";
    return `https://www.google.com/maps/dir/?api=1${origin}&destination=${point.latitude},${point.longitude}&travelmode=driving&dir_action=navigate`;
  }

  return (
    <div className="space-y-5" style={{ fontFamily: "'Inter','system-ui',sans-serif" }}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="mb-1 flex items-center gap-2 text-[0.65rem] font-bold uppercase tracking-[0.16em] text-blue-600">
            <Navigation className="h-3.5 w-3.5" /> Field route control
          </div>
          <h1 className="text-2xl font-bold text-zinc-950">Today&apos;s Routes</h1>
          <p className="mt-1 text-sm text-zinc-500">Start duty, lock one route, then complete GPS-verified party visits.</p>
        </div>
        {isOnDuty && (
          <div className="hidden items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-bold text-emerald-700 sm:flex">
            <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-500" /> Live tracking
          </div>
        )}
      </div>

      <section className={`overflow-hidden rounded-2xl border ${isOnDuty ? "border-emerald-200 bg-gradient-to-br from-emerald-50 to-white" : "border-amber-200 bg-gradient-to-br from-amber-50 to-white"}`}>
        <div className="grid gap-4 p-4 sm:grid-cols-[1fr_auto] sm:items-center sm:p-5">
          <div className="flex items-start gap-3">
            <div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${isOnDuty ? "bg-emerald-600 text-white" : "bg-amber-500 text-zinc-950"}`}>
              {isOnDuty ? <Radio className="h-5 w-5" /> : <ShieldCheck className="h-5 w-5" />}
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="font-bold text-zinc-950" style={{ fontSize: "1rem", lineHeight: 1.4 }}>{isOnDuty ? "Duty active — location protected" : "Start duty to unlock routes"}</h2>
                {fieldLoading && <Loader2 className="h-3.5 w-3.5 animate-spin text-zinc-400" />}
              </div>
              <p className="mt-1 max-w-2xl text-xs leading-relaxed text-zinc-600">
                {isOnDuty
                  ? `${nativeProtected ? "Android foreground tracking remains active when the app is closed." : "GPS is recording continuously while duty is active."} Admin can see the same live trail, speed, and verified visits.`
                  : "Precise GPS is required. Once duty starts, location updates are recorded for the admin and the selected route is locked for today."}
              </p>
              {isOnDuty && duty?.check_in_time && (
                <div className="mt-2 flex flex-wrap items-center gap-3 text-[0.68rem] font-semibold text-zinc-500">
                  <span className="flex items-center gap-1"><Clock3 className="h-3 w-3" /> Started {formatDutyTime(duty.check_in_time)}</span>
                  <span className="flex items-center gap-1"><LocateFixed className="h-3 w-3" /> {location ? `GPS ±${Math.round(location.accuracy || 0)} m` : "Acquiring GPS"}</span>
                  <span className="flex items-center gap-1"><ShieldCheck className="h-3 w-3" /> Admin visible</span>
                </div>
              )}
            </div>
          </div>
          {!isOnDuty && (
            <button
              onClick={startDuty}
              disabled={actionLoading === "duty" || fieldLoading}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-zinc-950 px-5 py-3 text-sm font-bold text-white shadow-lg shadow-zinc-950/15 transition hover:bg-zinc-800 disabled:opacity-50 sm:w-auto"
            >
              {actionLoading === "duty" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4 fill-current" />}
              Start Duty
            </button>
          )}
        </div>
        {run && (
          <div className="border-t border-emerald-200/70 bg-emerald-600 px-4 py-3 text-white sm:px-5">
            <div className="flex items-center justify-between gap-3 text-xs">
              <span className="flex min-w-0 items-center gap-2 font-bold"><LockKeyhole className="h-3.5 w-3.5 shrink-0" /> <span className="truncate">Locked today: {activeRoute?.name || "Selected route"}</span></span>
              <span className="shrink-0 font-bold">{visitedIds.length}/{run.total_stops} visited</span>
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/20"><div className="h-full rounded-full bg-white transition-all" style={{ width: `${progress}%` }} /></div>
          </div>
        )}
      </section>

      {(fieldError || locationError) && (
        <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-xs font-medium text-red-700">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{fieldError || locationError}</span>
          <button onClick={() => { setFieldError(""); setLocationError(""); }} className="ml-auto text-red-400 hover:text-red-700"><X className="h-4 w-4" /></button>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-20"><Loader2 className="h-7 w-7 animate-spin text-blue-600" /></div>
      ) : routes.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-zinc-300 py-16 text-center text-zinc-500">
          <RouteIcon className="mx-auto mb-3 h-9 w-9 opacity-30" /> No routes assigned to you.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {displayedRoutes.map((route) => {
            const isLockedRoute = run?.route_id === route.id;
            const lockedElsewhere = Boolean(run && !isLockedRoute);
            return (
              <article key={route.id} className={`relative overflow-hidden rounded-2xl border bg-white p-5 shadow-sm transition ${isLockedRoute ? "border-emerald-300 ring-2 ring-emerald-100" : "border-zinc-200 hover:-translate-y-0.5 hover:border-blue-200 hover:shadow-md"}`}>
                {isLockedRoute && <div className="absolute right-0 top-0 rounded-bl-xl bg-emerald-600 px-3 py-1.5 text-[0.6rem] font-bold uppercase tracking-wider text-white">Today&apos;s route</div>}
                <div className="flex items-start gap-3 pr-16">
                  <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${isLockedRoute ? "bg-emerald-100 text-emerald-700" : "bg-blue-50 text-blue-600"}`}><RouteIcon className="h-5 w-5" /></div>
                  <div className="min-w-0">
                    <h3 className="font-bold leading-snug text-zinc-950">{route.name}</h3>
                    <div className="mt-1 flex items-center gap-2 text-[0.68rem] font-semibold text-zinc-500">
                      <span>{dayLabel(route.code)}</span><span>•</span><span>{route.stops} stops</span>
                    </div>
                  </div>
                </div>
                <div className="mt-4 grid grid-cols-2 gap-2 rounded-xl bg-zinc-50 p-3 text-xs">
                  <div><div className="text-[0.6rem] font-bold uppercase tracking-wider text-zinc-400">Salesman</div><div className="mt-0.5 truncate font-semibold text-zinc-700">{route.salesman?.name || user?.name || "Assigned"}</div></div>
                  <div><div className="text-[0.6rem] font-bold uppercase tracking-wider text-zinc-400">Status</div><div className="mt-0.5 font-semibold text-emerald-600">{route.isActive ? "Ready" : "Inactive"}</div></div>
                </div>
                <button
                  onClick={() => handleRouteAction(route)}
                  disabled={!isOnDuty || lockedElsewhere || !route.isActive || actionLoading === route.id}
                  className={`mt-4 flex w-full items-center justify-center gap-2 rounded-xl py-2.5 text-xs font-bold transition ${isLockedRoute ? "bg-emerald-600 text-white hover:bg-emerald-500" : "bg-blue-600 text-white hover:bg-blue-500"} disabled:cursor-not-allowed disabled:bg-zinc-100 disabled:text-zinc-400`}
                >
                  {actionLoading === route.id ? <Loader2 className="h-4 w-4 animate-spin" /> : isLockedRoute ? <Navigation className="h-4 w-4" /> : lockedElsewhere ? <LockKeyhole className="h-4 w-4" /> : !isOnDuty ? <ShieldCheck className="h-4 w-4" /> : <Play className="h-4 w-4 fill-current" />}
                  {isLockedRoute ? "Continue Today’s Route" : lockedElsewhere ? "Locked to another route" : !isOnDuty ? "Start duty first" : "Start Today’s Route"}
                </button>
                {isOnDuty && !run && (
                  <button onClick={() => void buildPlan(route, false)} className="mt-2 w-full text-center text-[0.68rem] font-bold text-blue-600 hover:text-blue-800">Preview optimized plan</button>
                )}
              </article>
            );
          })}
        </div>
      )}

      {workspaceOpen && selectedRoute && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-zinc-950/70 p-0 backdrop-blur-sm sm:items-center sm:p-4" onClick={() => setWorkspaceOpen(false)}>
          <div className="flex h-[94dvh] w-full max-w-6xl flex-col overflow-hidden rounded-t-2xl bg-[#f7f8fa] shadow-2xl sm:h-[88vh] sm:rounded-2xl" onClick={(event) => event.stopPropagation()}>
            <header className="flex items-center justify-between gap-3 border-b border-zinc-200 bg-white px-4 py-3 sm:px-5">
              <div className="flex min-w-0 items-center gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-blue-600 text-white"><Navigation className="h-5 w-5" /></div>
                <div className="min-w-0"><h2 className="truncate font-bold text-zinc-950" style={{ fontSize: "0.95rem", lineHeight: 1.3 }}>{selectedRoute.name}</h2><p className="mt-0.5 text-[0.68rem] font-semibold text-zinc-500">{run?.route_id === selectedRoute.id ? "Locked field route · live navigation" : "Optimized route preview"}</p></div>
              </div>
              <button onClick={() => setWorkspaceOpen(false)} className="rounded-lg p-2 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"><X className="h-5 w-5" /></button>
            </header>

            {planLoading ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-3 text-zinc-500"><Loader2 className="h-7 w-7 animate-spin text-blue-600" /><span className="text-sm font-semibold">Calculating the fastest practical sequence…</span></div>
            ) : plan ? (
              <>
                {plan.missingStopIds.length > 0 && (
                  <div className="shrink-0 border-b border-amber-200 bg-amber-50 px-4 py-2.5 text-[0.68rem] font-semibold leading-relaxed text-amber-800">
                    {plan.missingStopIds.length} {plan.missingStopIds.length === 1 ? "party has" : "parties have"} no saved GPS location. The route can start and those parties are placed at the end, but the admin must add their coordinates before a GPS-verified visit can be completed.
                  </div>
                )}
                <div className="grid shrink-0 grid-cols-3 border-b border-zinc-200 bg-white text-center">
                  <div className="border-r border-zinc-100 px-2 py-2.5"><div className="text-[0.58rem] font-bold uppercase tracking-wider text-zinc-400">Progress</div><div className="mt-0.5 text-sm font-bold text-zinc-900">{visitedIds.length}/{displayStops.length}</div></div>
                  <div className="border-r border-zinc-100 px-2 py-2.5"><div className="text-[0.58rem] font-bold uppercase tracking-wider text-zinc-400">Suggested drive</div><div className="mt-0.5 text-sm font-bold text-zinc-900">{(plan.distanceMeters / 1000).toFixed(1)} km</div></div>
                  <div className="px-2 py-2.5"><div className="text-[0.58rem] font-bold uppercase tracking-wider text-zinc-400">Est. travel</div><div className="mt-0.5 text-sm font-bold text-zinc-900">{formatRouteDuration(plan.durationSeconds)}</div></div>
                </div>
                <div className="grid min-h-0 flex-1 lg:grid-cols-[370px_1fr]">
                  <aside className="order-2 flex min-h-0 flex-col border-t border-zinc-200 bg-white lg:order-1 lg:border-r lg:border-t-0">
                    <div className="border-b border-zinc-100 px-4 py-3">
                      <div className="flex items-center justify-between gap-3"><div className="flex items-center gap-2 text-xs font-bold text-zinc-900"><Sparkles className="h-4 w-4 text-blue-600" /> Smart order <span className="font-semibold text-zinc-400">(optional)</span></div><span className="text-[0.62rem] font-semibold text-zinc-400">{plan.source === "road-network" ? "Road-time optimized" : "Distance optimized"}</span></div>
                      {run && <p className="mt-1.5 text-[0.64rem] leading-relaxed text-zinc-500">Choose any remaining party. The suggested order helps with travel time, but it never locks your next visit.</p>}
                    </div>
                    <div className="flex-1 overflow-y-auto p-3">
                      <div className="space-y-2">
                        {displayStops.map((stop, index) => {
                          const point = getStopPoint(stop);
                          const visited = (run?.visits || []).find((visit) => visit.stop_id === stop.id);
                          const isChosen = chosenStop?.id === stop.id;
                          const isSmartSuggestion = smartSuggestedStop?.id === stop.id;
                          const distance = location && point ? haversineMeters(location, point) : null;
                          const eligible = Boolean(run && distance != null && distance <= 100);
                          const stopNavigateUrl = navigationUrlFor(stop);
                          return (
                            <div key={stop.id} className={`rounded-xl border p-3 transition ${visited ? "border-emerald-200 bg-emerald-50/70" : isChosen ? "border-blue-300 bg-blue-50 ring-1 ring-blue-100" : "border-zinc-200 bg-white"}`}>
                              <div className="flex items-start gap-3">
                                <div className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[0.65rem] font-black ${visited ? "bg-emerald-600 text-white" : isChosen ? "bg-blue-600 text-white" : "bg-zinc-100 text-zinc-500"}`}>{visited ? <CheckCircle2 className="h-4 w-4" /> : index + 1}</div>
                                <div className="min-w-0 flex-1"><div className="flex min-w-0 items-center gap-1.5"><div className="truncate text-xs font-bold text-zinc-900">{stop.parties?.name || "Unknown party"}</div>{!visited && isChosen && <span className="shrink-0 rounded bg-blue-100 px-1.5 py-0.5 text-[0.52rem] font-bold uppercase tracking-wide text-blue-700">Chosen next</span>}{!visited && isSmartSuggestion && !isChosen && <span className="shrink-0 rounded bg-amber-100 px-1.5 py-0.5 text-[0.52rem] font-bold uppercase tracking-wide text-amber-700">Suggested</span>}</div><div className="mt-0.5 truncate text-[0.62rem] text-zinc-500">{[stop.parties?.address_line1, stop.parties?.city].filter(Boolean).join(", ") || stop.parties?.party_code}</div></div>
                                {distance != null && !visited && <span className={`shrink-0 text-[0.62rem] font-bold ${distance <= 100 ? "text-emerald-600" : "text-zinc-400"}`}>{distance < 1000 ? `${Math.round(distance)} m` : `${(distance / 1000).toFixed(1)} km`}</span>}
                              </div>
                              {visited ? (
                                <div className="mt-2 rounded-lg bg-white/70 px-2.5 py-2 text-[0.65rem] leading-relaxed text-zinc-600"><span className="font-bold text-emerald-700">Visited on-site · {visited.distance_m} m</span><div className="mt-0.5">{visited.notes}</div></div>
                              ) : run && !point ? (
                                <div className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg bg-amber-50 py-2 text-[0.68rem] font-bold text-amber-700">
                                  <MapPin className="h-3.5 w-3.5" /> Party GPS missing — admin update required
                                </div>
                              ) : run ? (
                                <div className="mt-2 grid grid-cols-2 gap-2">
                                  {stopNavigateUrl && <a href={stopNavigateUrl} target="_blank" rel="noopener noreferrer" onClick={() => rememberChosenStop(stop)} className="flex items-center justify-center gap-1.5 rounded-lg bg-blue-600 px-2 py-2 text-[0.66rem] font-bold text-white hover:bg-blue-500"><Navigation className="h-3.5 w-3.5" /> Choose & Navigate</a>}
                                  <button onClick={() => { if (eligible) { rememberChosenStop(stop); setNoteStop(stop); setVisitNote(""); } }} disabled={!eligible} className={`flex items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-[0.66rem] font-bold ${eligible ? "bg-emerald-600 text-white hover:bg-emerald-500" : "cursor-not-allowed bg-zinc-100 text-zinc-400"} ${stopNavigateUrl ? "" : "col-span-2"}`}>
                                    {eligible ? <NotebookPen className="h-3.5 w-3.5" /> : <LocateFixed className="h-3.5 w-3.5" />}
                                    {eligible ? "Mark Visited" : distance != null ? `${Math.round(distance)} m away` : "GPS required"}
                                  </button>
                                </div>
                              ) : null}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </aside>
                  <section className="relative order-1 flex min-h-[42vh] flex-col overflow-hidden bg-zinc-100 lg:order-2 lg:min-h-0">
                    <RouteMapView stops={displayStops} origin={location} geometry={plan.geometry} visitedStopIds={visitedIds} activeStopId={chosenStop?.id || null} />
                    <div className="pointer-events-none absolute left-3 top-3 z-[800] flex flex-wrap gap-2">
                      <div className="rounded-xl border border-white/70 bg-white/95 px-3 py-2 shadow-lg backdrop-blur"><div className="flex items-center gap-1.5 text-[0.65rem] font-bold text-emerald-700"><Radio className="h-3 w-3" /> Live GPS</div><div className="mt-0.5 text-[0.58rem] text-zinc-500">Visible to admin</div></div>
                      {chosenStop && <div className="rounded-xl border border-white/70 bg-white/95 px-3 py-2 shadow-lg backdrop-blur"><div className="text-[0.58rem] font-bold uppercase tracking-wider text-zinc-400">Chosen next</div><div className="mt-0.5 max-w-[170px] truncate text-[0.68rem] font-bold text-zinc-900">{chosenStop.parties?.name}</div></div>}
                    </div>
                  </section>
                </div>
                <footer className="shrink-0 border-t border-zinc-200 bg-white p-3 sm:px-4">
                  {run?.route_id === selectedRoute.id ? (
                    chosenStop && navigateUrl ? <a href={navigateUrl} target="_blank" rel="noopener noreferrer" className="flex w-full items-center justify-center gap-2 rounded-xl bg-blue-600 py-3 text-sm font-bold text-white shadow-lg shadow-blue-600/20 hover:bg-blue-500"><Navigation className="h-4 w-4" /> Navigate to {chosenStop.parties?.name || "Chosen Party"} <ExternalLink className="h-3.5 w-3.5" /></a>
                    : <div className="flex items-center justify-center gap-2 rounded-xl bg-emerald-50 py-3 text-sm font-bold text-emerald-700"><CheckCircle2 className="h-4 w-4" /> Route completed — all parties verified</div>
                  ) : (
                    <button onClick={() => { setActionLoading(selectedRoute.id); void buildPlan(selectedRoute, true); }} disabled={!isOnDuty} className="flex w-full items-center justify-center gap-2 rounded-xl bg-blue-600 py-3 text-sm font-bold text-white hover:bg-blue-500 disabled:bg-zinc-200 disabled:text-zinc-400"><LockKeyhole className="h-4 w-4" /> Lock & Start Today&apos;s Route</button>
                  )}
                </footer>
              </>
            ) : (
              <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center text-zinc-500"><WifiOff className="h-8 w-8 opacity-30" /><p className="text-sm">The route plan is not available yet.</p></div>
            )}
          </div>
        </div>
      )}

      {noteStop && (
        <div className="fixed inset-0 z-[70] flex items-end justify-center bg-zinc-950/60 p-0 backdrop-blur-sm sm:items-center sm:p-4" onClick={() => setNoteStop(null)}>
          <div className="w-full max-w-md rounded-t-2xl bg-white p-5 shadow-2xl sm:rounded-2xl" onClick={(event) => event.stopPropagation()}>
            <div className="flex items-start justify-between gap-3"><div><div className="text-[0.62rem] font-bold uppercase tracking-wider text-emerald-600">GPS verified · within 100 m</div><h3 className="mt-1 text-lg font-bold text-zinc-950">{noteStop.parties?.name}</h3></div><button onClick={() => setNoteStop(null)} className="p-1 text-zinc-400"><X className="h-5 w-5" /></button></div>
            <label className="mt-4 block text-xs font-bold text-zinc-700">Visit notes <span className="text-red-500">*</span></label>
            <textarea value={visitNote} onChange={(event) => setVisitNote(event.target.value)} rows={4} autoFocus placeholder="What was discussed? Add order interest, payment follow-up, stock need, or next action…" className="mt-2 w-full resize-none rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-3 text-sm text-zinc-900 outline-none focus:border-emerald-400 focus:ring-2 focus:ring-emerald-100" />
            <p className="mt-2 text-[0.65rem] leading-relaxed text-zinc-500">This note and the verified coordinates will be visible to the admin immediately.</p>
            <button onClick={saveVisit} disabled={visitSaving || visitNote.trim().length < 3} className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-600 py-3 text-sm font-bold text-white hover:bg-emerald-500 disabled:bg-zinc-200 disabled:text-zinc-400">{visitSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />} Confirm Party Visited</button>
          </div>
        </div>
      )}
    </div>
  );
}

function DutySignoffApprovals() {
  const [requests, setRequests] = useState<DutySignoffQueueItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [decisionNotes, setDecisionNotes] = useState<Record<string, string>>({});

  const loadRequests = useCallback(async () => {
    try {
      const result = await api<{ data: DutySignoffQueueItem[] }>("/api/v1/duty/signoff?status=pending", {
        noCache: true,
        suppressErrorLog: true,
      });
      setRequests(result.data || []);
      setError("");
    } catch (requestError) {
      setError(getErrorMessage(requestError, "Could not load duty sign-off requests"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadRequests();
    const timer = window.setInterval(() => void loadRequests(), 20_000);
    return () => window.clearInterval(timer);
  }, [loadRequests]);

  async function decide(item: DutySignoffQueueItem, action: "approve" | "reject") {
    const note = (decisionNotes[item.run_id] || "").trim();
    if (action === "reject" && !note) {
      setError("Add a decision note before rejecting a sign-off request.");
      return;
    }
    setBusyId(item.run_id);
    setError("");
    try {
      await api("/api/v1/duty/signoff", {
        method: "PATCH",
        body: { run_id: item.run_id, action, decision_note: note || null },
      });
      setRequests((current) => current.filter((request) => request.run_id !== item.run_id));
      setDecisionNotes((current) => {
        const next = { ...current };
        delete next[item.run_id];
        return next;
      });
    } catch (requestError) {
      setError(getErrorMessage(requestError, "Could not update the sign-off request"));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="mb-6 overflow-hidden rounded-2xl border border-amber-200 bg-gradient-to-br from-amber-50 via-white to-white shadow-sm">
      <div className="flex items-center justify-between gap-4 border-b border-amber-100 px-5 py-4">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-500 text-zinc-950"><ShieldCheck className="h-5 w-5" /></div>
          <div className="min-w-0"><h2 className="text-sm font-bold text-zinc-950">Duty sign-off approvals</h2><p className="mt-0.5 text-[0.68rem] text-zinc-500">Review salesmen who need to end duty before completing every party.</p></div>
        </div>
        <span className={`rounded-full px-2.5 py-1 text-[0.65rem] font-bold ${requests.length ? "bg-amber-500 text-zinc-950" : "bg-emerald-100 text-emerald-700"}`}>{loading ? "Checking…" : requests.length ? `${requests.length} pending` : "All clear"}</span>
      </div>

      {error && <div className="flex items-center gap-2 border-b border-red-100 bg-red-50 px-5 py-2.5 text-xs font-semibold text-red-700"><AlertCircle className="h-4 w-4 shrink-0" /> {error}</div>}

      {!loading && requests.length === 0 ? (
        <div className="flex items-center gap-2 px-5 py-4 text-xs font-semibold text-emerald-700"><CheckCircle2 className="h-4 w-4" /> No incomplete-route sign-off requests are waiting.</div>
      ) : (
        <div className="grid gap-3 p-4 xl:grid-cols-2">
          {requests.map((item) => (
            <article key={item.run_id} className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0"><div className="text-[0.6rem] font-bold uppercase tracking-[0.12em] text-amber-600">Approval required</div><h3 className="mt-1 truncate text-sm font-bold text-zinc-950">{item.salesman_name}</h3><p className="mt-0.5 truncate text-[0.68rem] font-semibold text-zinc-500">{item.route_name} · {item.work_date}</p></div>
                <div className="shrink-0 rounded-lg bg-red-50 px-3 py-2 text-center"><div className="text-base font-black text-red-600">{item.remaining_stops}</div><div className="text-[0.55rem] font-bold uppercase tracking-wide text-red-500">left</div></div>
              </div>
              <div className="mt-3 grid grid-cols-2 overflow-hidden rounded-lg border border-zinc-100 bg-zinc-50 text-center"><div className="border-r border-zinc-100 py-2"><div className="text-xs font-bold text-zinc-900">{item.visited_stops}/{item.total_stops}</div><div className="text-[0.58rem] text-zinc-500">Parties visited</div></div><div className="py-2"><div className="text-xs font-bold text-zinc-900">{new Date(item.request.requested_at).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true })}</div><div className="text-[0.58rem] text-zinc-500">Requested at</div></div></div>
              {item.remaining_parties.length > 0 && <div className="mt-3 flex flex-wrap gap-1.5">{item.remaining_parties.map((party) => <span key={party.stop_id} className="rounded-full border border-red-100 bg-red-50 px-2 py-1 text-[0.6rem] font-semibold text-red-700">Not visited: {party.name}</span>)}</div>}
              <div className="mt-3 rounded-lg border border-amber-100 bg-amber-50 px-3 py-2.5"><div className="text-[0.58rem] font-bold uppercase tracking-wide text-amber-700">Salesman&apos;s reason</div><p className="mt-1 text-xs leading-relaxed text-zinc-700">{item.request.reason}</p></div>
              <textarea value={decisionNotes[item.run_id] || ""} onChange={(event) => setDecisionNotes((current) => ({ ...current, [item.run_id]: event.target.value }))} rows={2} placeholder="Decision note (required when rejecting)" className="mt-3 w-full resize-none rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-zinc-900 outline-none focus:border-amber-400 focus:ring-2 focus:ring-amber-100" />
              <div className="mt-3 grid grid-cols-2 gap-2">
                <button onClick={() => void decide(item, "reject")} disabled={busyId === item.run_id} className="flex items-center justify-center gap-1.5 rounded-lg border border-red-200 bg-red-50 py-2.5 text-xs font-bold text-red-700 hover:bg-red-100 disabled:opacity-50"><X className="h-3.5 w-3.5" /> Reject</button>
                <button onClick={() => void decide(item, "approve")} disabled={busyId === item.run_id} className="flex items-center justify-center gap-1.5 rounded-lg bg-emerald-600 py-2.5 text-xs font-bold text-white hover:bg-emerald-500 disabled:opacity-50">{busyId === item.run_id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />} Approve Sign-off</button>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

export default function RoutesPage() {
  const [routes, setRoutes] = useState<RouteData[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [salesmen, setSalesmen] = useState<Salesman[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [editingRoute, setEditingRoute] = useState<RouteData | null>(null);
  const [editForm, setEditForm] = useState({ name: "", assigned_user_id: "", is_active: true });
  const [editFormPartySearch, setEditFormPartySearch] = useState("");
  const [editFormPartyDropOpen, setEditFormPartyDropOpen] = useState(false);
  const [editSelectedParties, setEditSelectedParties] = useState<Party[]>([]);
  const [editSalesmanParties, setEditSalesmanParties] = useState<Party[] | null>(null);
  const [editSalesmanPartiesLoading, setEditSalesmanPartiesLoading] = useState(false);
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState("");
  const isSuperAdmin = getUser()?.role === "SUPER_ADMIN";
  const isSalesman = getUser()?.role === "SALESMAN";

  // Permissions
  const [perms, setPerms] = useState({ can_view: true, can_create: false, can_edit: false, can_delete: false });
  useEffect(() => { getModulePermission("routes").then(setPerms); }, []);

  // View Route modal state (salesman view)
  const [showViewRouteModal, setShowViewRouteModal] = useState(false);
  const [viewRoute, setViewRoute] = useState<RouteData | null>(null);
  const [viewRouteStops, setViewRouteStops] = useState<RouteStop[]>([]);
  const [viewRouteLoading, setViewRouteLoading] = useState(false);
  const [viewRouteTab, setViewRouteTab] = useState<"parties" | "map">("parties");
  const [routeOrigin, setRouteOrigin] = useState<RouteMapPoint | null>(null);
  const [routeOriginLoading, setRouteOriginLoading] = useState(false);
  const [routeOriginError, setRouteOriginError] = useState("");
  const [routeOriginRequested, setRouteOriginRequested] = useState(false);

  async function openViewRouteModal(route: RouteData) {
    setViewRoute(route);
    setViewRouteStops([]);
    setViewRouteLoading(true);
    setViewRouteTab("parties");
    setRouteOrigin(null);
    setRouteOriginError("");
    setRouteOriginRequested(false);
    setRouteOriginLoading(false);
    setShowViewRouteModal(true);
    requestRouteOrigin(true);
    try {
      const res = await api<{ data: RouteStop[] }>(`/api/v1/tracking/routes/stops?route_id=${route.id}`);
      setViewRouteStops((res.data || []).sort((a, b) => (a.stop_order ?? 0) - (b.stop_order ?? 0)));
    } catch { setViewRouteStops([]); }
    setViewRouteLoading(false);
  }

  function requestRouteOrigin(force = false) {
    if (!force && (routeOrigin || routeOriginLoading || routeOriginRequested)) return;
    setRouteOriginRequested(true);
    setRouteOriginError("");

    if (!navigator.geolocation) {
      setRouteOriginError("Location is not available on this device.");
      return;
    }

    setRouteOriginLoading(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const latitude = Number(pos.coords.latitude.toFixed(6));
        const longitude = Number(pos.coords.longitude.toFixed(6));
        setRouteOrigin({ latitude, longitude, label: "Salesman location" });
        setRouteOriginLoading(false);
      },
      () => {
        setRouteOriginError("Allow location access to start navigation from the salesman location.");
        setRouteOriginLoading(false);
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 },
    );
  }

  function buildGoogleMapsUrl(stops: RouteStop[], origin?: RouteMapPoint | null): string | null {
    const geoStops = stops.filter(hasStopCoordinates);
    if (geoStops.length === 0) return null;
    const firstPoint = getStopPoint(geoStops[0]);
    if (!firstPoint) return null;

    if (origin) {
      const dest = getStopPoint(geoStops[geoStops.length - 1]);
      if (!dest) return null;
      const waypoints = geoStops
        .slice(0, -1)
        .map(getStopPoint)
        .filter((point): point is RouteMapPoint => Boolean(point))
        .map(point => `${point.latitude},${point.longitude}`)
        .join('|');
      const base = `https://www.google.com/maps/dir/?api=1&origin=${origin.latitude},${origin.longitude}&destination=${dest.latitude},${dest.longitude}&travelmode=driving`;
      return waypoints ? `${base}&waypoints=${waypoints}` : base;
    }

    if (geoStops.length === 1) {
      return `https://www.google.com/maps/search/?api=1&query=${firstPoint.latitude},${firstPoint.longitude}`;
    }

    const fallbackOriginParty = geoStops[0].parties!;
    const dest = geoStops[geoStops.length - 1].parties!;
    const waypoints = geoStops.slice(1, -1)
      .map(getStopPoint)
      .filter((point): point is RouteMapPoint => Boolean(point))
      .map(point => `${point.latitude},${point.longitude}`)
      .join('|');
    const originPoint = getStopPoint({ parties: fallbackOriginParty });
    const destPoint = getStopPoint({ parties: dest });
    if (!originPoint || !destPoint) return null;
    const base = `https://www.google.com/maps/dir/?api=1&origin=${originPoint.latitude},${originPoint.longitude}&destination=${destPoint.latitude},${destPoint.longitude}&travelmode=driving`;
    return waypoints ? `${base}&waypoints=${waypoints}` : base;
  }

  // Stop management state
  const [showStopModal, setShowStopModal] = useState(false);
  const [activeRoute, setActiveRoute] = useState<RouteData | null>(null);
  const [routeStops, setRouteStops] = useState<RouteStop[]>([]);
  const [stopsLoading, setStopsLoading] = useState(false);
  const [parties, setParties] = useState<Party[]>([]);
  const [stopParties, setStopParties] = useState<Party[]>([]);
  const [stopPartiesLoading, setStopPartiesLoading] = useState(false);
  const [stopPartySearch, setStopPartySearch] = useState("");
  const [stopSaving, setStopSaving] = useState(false);
  const [stopError, setStopError] = useState("");
  const [stopDropOpen, setStopDropOpen] = useState(false);
  const [selectedStopParties, setSelectedStopParties] = useState<Party[]>([]);

  const [form, setForm] = useState<{ name: string; day: string; group_id: string }>({
    name: "",
    day: "",
    group_id: "",
  });
  const [groups, setGroups] = useState<Group[]>([]);
  const [groupsLoading, setGroupsLoading] = useState(false);
  const [groupDropOpen, setGroupDropOpen] = useState(false);
  // Tracks the last auto-generated route name so we only overwrite it until the
  // user types their own. Reset whenever the create modal opens.
  const autoNameRef = useRef("");
  const selectedGroup = groups.find(g => g.id === form.group_id) ?? null;

  async function loadRoutes() {
    try {
      const res = await api<{ data: RouteData[] }>("/api/v1/tracking/routes");
      setRoutes(res.data || []);
    } catch { setRoutes([]); }
    setLoading(false);
  }

  async function loadGroups() {
    setGroupsLoading(true);
    try {
      const res = await api<{ data: Group[] }>("/api/v1/groups");
      setGroups(res.data || []);
    } catch { setGroups([]); }
    setGroupsLoading(false);
  }

  useEffect(() => {
    loadRoutes();
    loadGroups();
    api<{ data: Salesman[] }>("/api/v1/users?role=SALESMAN&limit=200").then(r => setSalesmen(r.data || [])).catch(() => {});
    api<{ data: Party[] }>("/api/v1/parties?limit=500&fields=id,name,party_code").then(r => setParties(r.data || [])).catch(() => {});
  }, []);

  function openModal() {
    setForm({ name: "", day: "", group_id: "" });
    autoNameRef.current = "";
    setError("");
    setGroupDropOpen(false);
    loadGroups();
    setShowModal(true);
  }

  // Prefill an editable "<group> — <day>" route name until the user types their own.
  function applyAutoName(next: { name: string; day: string; group_id: string }) {
    const userEditedName = next.name.trim() !== "" && next.name !== autoNameRef.current;
    const group = groups.find(g => g.id === next.group_id);
    if (!userEditedName && group && next.day) {
      const auto = `${group.name} — ${dayLabel(next.day)}`;
      autoNameRef.current = auto;
      return { ...next, name: auto };
    }
    return next;
  }

  function selectDay(day: string) {
    setForm(f => applyAutoName({ ...f, day }));
  }

  function handleGroupChange(groupId: string) {
    setForm(f => applyAutoName({ ...f, group_id: groupId }));
  }

  async function openStopModal(route: RouteData) {
    setActiveRoute(route);
    setStopPartySearch(""); setStopError(""); setStopDropOpen(false); setSelectedStopParties([]);
    setShowStopModal(true);
    setStopsLoading(true);
    setStopPartiesLoading(true);
    const [stopsRes] = await Promise.allSettled([
      api<{ data: RouteStop[] }>(`/api/v1/tracking/routes/stops?route_id=${route.id}`),
      api<{ data: Party[] }>("/api/v1/parties?limit=1000&fields=id,name,party_code&route_planning=1")
        .then(r => setStopParties(r.data || []))
        .catch(() => { if (parties.length > 0) setStopParties(parties); }),
    ]);
    setStopPartiesLoading(false);
    if (stopsRes.status === "fulfilled") setRouteStops(stopsRes.value.data || []);
    else setRouteStops([]);
    setStopsLoading(false);
  }

  async function handleAddStop(e: React.FormEvent) {
    e.preventDefault();
    if (selectedStopParties.length === 0) { setStopError("Please select at least one party"); return; }
    setStopSaving(true); setStopError("");
    try {
      const nextOrder = routeStops.length + 1;
      await Promise.all(
        selectedStopParties.map((p, i) =>
          api("/api/v1/tracking/routes/stops", { method: "POST", body: { route_id: activeRoute!.id, party_id: p.id, stop_order: nextOrder + i } })
        )
      );
      const res = await api<{ data: RouteStop[] }>(`/api/v1/tracking/routes/stops?route_id=${activeRoute!.id}`);
      setRouteStops(res.data || []);
      setSelectedStopParties([]); setStopPartySearch("");
      loadRoutes();
    } catch (err: unknown) { setStopError(getErrorMessage(err, "Failed to add stops")); }
    setStopSaving(false);
  }

  async function handleDeleteStop(stopId: string) {
    await api(`/api/v1/tracking/routes/stops?id=${stopId}`, { method: "DELETE" });
    setRouteStops(prev => prev.filter(s => s.id !== stopId));
    loadRoutes();
  }

  async function handleDeleteRoute(id: string, name: string) {
    if (!confirm(`Delete route "${name}"? This will also remove all its stops.`)) return;
    setDeletingId(id);
    try {
      await api(`/api/v1/tracking/routes?id=${id}`, { method: "DELETE" });
      setRoutes(prev => prev.filter(r => r.id !== id));
    } catch (err: unknown) {
      alert(getErrorMessage(err, "Failed to delete route"));
    }
    setDeletingId(null);
  }

  async function openEditModal(route: RouteData) {
    setEditingRoute(route);
    setEditForm({ name: route.name, assigned_user_id: route.salesman ? "" : "", is_active: route.isActive });
    setEditSelectedParties([]);
    setEditFormPartySearch("");
    setEditFormPartyDropOpen(false);
    setEditSalesmanParties(null);
    setEditSalesmanPartiesLoading(false);
    setEditError("");

    // Load existing stops for this route
    try {
      const res = await api<{ data: RouteStop[] }>(`/api/v1/tracking/routes/stops?route_id=${route.id}`);
      setEditSelectedParties((res.data || []).map(s => s.parties!).filter(Boolean));
    } catch { setEditSelectedParties([]); }
  }

  async function handleEditSalesmanChange(userId: string) {
    setEditForm(f => ({ ...f, assigned_user_id: userId }));
    setEditSelectedParties([]);
    setEditFormPartySearch("");
    if (!userId) { setEditSalesmanParties(null); return; }
    setEditSalesmanPartiesLoading(true);
    try {
      const res = await api<{ data: { salesmen: SalesmanDownlineUser[]; allParties: Party[]; salesmanToParties: Record<string, string[]> } }>("/api/v1/salesman-downline");
      const allParties: Party[] = res.data.allParties;
      const salesmanToParties: Record<string, string[]> = res.data.salesmanToParties ?? {};
      const assignedPartyIds = new Set<string>(salesmanToParties[userId] ?? []);
      const salesman = res.data.salesmen.find((s) => s.id === userId);
      const collect = (parentId: string) => {
        allParties.filter(p => p.parent_party_id === parentId).forEach(c => {
          if (!assignedPartyIds.has(c.id)) { assignedPartyIds.add(c.id); collect(c.id); }
        });
      };
      if (salesman?.assigned_party_id) {
        assignedPartyIds.add(salesman.assigned_party_id);
        collect(salesman.assigned_party_id);
      }
      setEditSalesmanParties(allParties.filter(p => assignedPartyIds.has(p.id)));
    } catch { setEditSalesmanParties([]); }
    setEditSalesmanPartiesLoading(false);
  }

  async function handleEditSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!editForm.name.trim()) { setEditError("Route name is required"); return; }
    setEditSaving(true);
    setEditError("");
    try {
      await api(`/api/v1/tracking/routes?id=${editingRoute!.id}`, {
        method: "PUT",
        body: editForm,
      });
      setEditingRoute(null);
      setLoading(true);
      await loadRoutes();
    } catch (err: unknown) {
      setEditError(getErrorMessage(err, "Failed to update route"));
    }
    setEditSaving(false);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.day) { setError("Please pick a day"); return; }
    if (!form.group_id) { setError("Please select a group"); return; }
    if (!form.name.trim()) { setError("Route name is required"); return; }
    const group = groups.find(g => g.id === form.group_id);
    if (!group) { setError("Selected group could not be found — try reloading"); return; }
    setSaving(true);
    setError("");
    try {
      // The route is assigned to the group's salesman, with the weekday in `code`.
      const res = await api<{ data: { id: string } }>("/api/v1/tracking/routes", {
        method: "POST",
        body: {
          name: form.name.trim(),
          code: form.day,
          group_id: group.id,
          assigned_user_id: group.salesman_id ?? "",
          is_active: true,
        },
      });
      const routeId = res.data?.id;
      // Snapshot the group's current members as route stops (existing mechanism).
      if (routeId && group.member_ids.length > 0) {
        await Promise.all(
          group.member_ids.map((partyId, i) =>
            api("/api/v1/tracking/routes/stops", { method: "POST", body: { route_id: routeId, party_id: partyId, stop_order: i + 1 } })
          )
        );
      }
      setShowModal(false);
      setLoading(true);
      await loadRoutes();
    } catch (err: unknown) {
      setError(getErrorMessage(err, "Failed to create route"));
    }
    setSaving(false);
  }

  if (isSalesman) {
    return <SalesmanRoutesExperience routes={routes} loading={loading} />;
  }

  return (
    <div style={{ fontFamily: "'Inter','system-ui',sans-serif" }}>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900 mb-1" style={{ ...s, fontSize: "1.5rem", marginBottom: "0.25rem" }}>Routes</h1>
            <p className="text-zinc-600" style={{ fontSize: "0.8rem" }}>Beat routes and coverage plans</p>
          </div>
          {perms.can_create && (
          <button
            onClick={openModal}
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-amber-500 hover:bg-amber-400 text-black font-semibold transition-all"
            style={{ fontSize: "0.82rem" }}
          >
            <Plus className="w-4 h-4" />
            Create Route
          </button>
          )}
      </div>

      <DutySignoffApprovals />

      {loading ? (
        <div className="flex items-center justify-center py-20"><Loader2 className="w-8 h-8 text-amber-500 animate-spin" /></div>
      ) : routes.length === 0 ? (
        <div className="text-center py-20 text-zinc-500">
          <RouteIcon className="w-12 h-12 mx-auto mb-4 opacity-30" />
          <p style={{ fontSize: "0.875rem" }}>No routes configured</p>
          <p className="mt-2" style={{ fontSize: "0.75rem" }}>Click &quot;Create Route&quot; to add your first beat route.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {routes.map((route) => (
            <div key={route.id} className="rounded-xl border border-black/[0.06] bg-black/[0.02] p-5 hover:bg-black/[0.04] transition-all">
              <div className="flex items-start justify-between mb-3">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-cyan-500/10 flex items-center justify-center">
                    <RouteIcon className="w-5 h-5 text-cyan-400" />
                  </div>
                  <div>
                    <h3 className="text-zinc-900 font-medium" style={{ fontSize: "0.85rem" }}>{route.name}</h3>
                    {route.code && (
                      <span className="inline-block mt-0.5 px-2 py-0.5 rounded-md bg-cyan-500/10 text-cyan-600 font-medium" style={{ fontSize: "0.62rem" }}>{dayLabel(route.code)}</span>
                    )}
                  </div>
                </div>
                    <span className={`px-2 py-0.5 rounded text-xs ${route.isActive ? "bg-emerald-500/20 text-emerald-400" : "bg-zinc-500/20 text-zinc-500"}`} style={{ fontSize: "0.6rem" }}>
                      {route.isActive ? "Active" : "Inactive"}
                    </span>
                    {(isSuperAdmin || perms.can_delete) && (
                      <button
                        onClick={() => handleDeleteRoute(route.id, route.name)}
                        disabled={deletingId === route.id}
                        className="ml-1 p-1 rounded-lg text-zinc-600 hover:text-red-400 hover:bg-red-500/10 transition-all disabled:opacity-40"
                        title="Delete route"
                      >
                        {deletingId === route.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                      </button>
                    )}
                    {(isSuperAdmin || perms.can_edit) && (
                      <button
                        onClick={() => openEditModal(route)}
                        className="ml-1 p-1 rounded-lg text-zinc-600 hover:text-amber-400 hover:bg-amber-500/10 transition-all"
                        title="Edit route"
                      >
                        <Edit2 className="w-3.5 h-3.5" />
                      </button>
                    )}
              </div>
              <div className="space-y-1.5 mt-3">
                {route.salesman && <div className="flex justify-between"><span className="text-zinc-500" style={{ fontSize: "0.7rem" }}>Salesman</span><span className="text-zinc-700" style={{ fontSize: "0.7rem" }}>{route.salesman.name}</span></div>}
                <div className="flex justify-between"><span className="text-zinc-500" style={{ fontSize: "0.7rem" }}>Stops</span><span className="text-zinc-700" style={{ fontSize: "0.7rem" }}>{route.stops}</span></div>
              </div>
              {isSalesman ? (
                <button
                  onClick={() => openViewRouteModal(route)}
                  className="mt-4 w-full flex items-center justify-center gap-1.5 py-1.5 rounded-lg border border-cyan-500/20 bg-cyan-500/5 hover:bg-cyan-500/10 text-cyan-400 hover:text-cyan-300 transition-all"
                  style={{ fontSize: "0.75rem" }}
                >
                  <Navigation className="w-3.5 h-3.5" />
                  View Route
                </button>
              ) : (
                <button
                  onClick={() => openStopModal(route)}
                  className="mt-4 w-full flex items-center justify-center gap-1.5 py-1.5 rounded-lg border border-cyan-500/20 bg-cyan-500/5 hover:bg-cyan-500/10 text-cyan-400 hover:text-cyan-300 transition-all"
                  style={{ fontSize: "0.75rem" }}
                >
                  <MapPin className="w-3.5 h-3.5" />
                  Manage Stops
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Create Route Modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.7)", backdropFilter: "blur(4px)" }}>
          <div className="w-full max-w-lg rounded-2xl border border-black/[0.08] bg-white shadow-2xl flex flex-col max-h-[92vh]" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-6 py-4 border-b border-black/[0.06]">
              <h2 className="text-zinc-900 font-bold" style={{ fontSize: "1rem" }}>Create Route</h2>
              <button onClick={() => setShowModal(false)} className="text-zinc-500 hover:text-zinc-900 transition-colors">
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSubmit} className="flex flex-col flex-1 overflow-hidden">
              <div className="overflow-y-auto flex-1 px-6 py-4 space-y-4">
                {/* Day selector */}
                <div>
                  <label className="block text-zinc-600 mb-1.5" style={{ fontSize: "0.75rem" }}>Day *</label>
                  <div className="grid grid-cols-7 gap-1.5">
                    {WEEKDAYS.map(d => (
                      <button
                        key={d.value}
                        type="button"
                        onClick={() => selectDay(d.value)}
                        className={`py-2 rounded-lg border text-center transition-all ${form.day === d.value ? "border-amber-500 bg-amber-500/10 text-amber-600 font-semibold" : "border-black/[0.08] bg-black/[0.04] text-zinc-600 hover:border-black/20 hover:text-zinc-900"}`}
                        style={{ fontSize: "0.72rem" }}
                      >
                        {d.short}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Group selector */}
                <div>
                  <label className="block text-zinc-600 mb-1" style={{ fontSize: "0.75rem" }}>Group *</label>
                  {/* Custom dropdown: native <select> popups are browser-sized and can't be
                      capped, so this scroll container shows exactly 5 rows then scrolls. */}
                  <div className="relative">
                    <button
                      type="button"
                      onClick={() => setGroupDropOpen(o => !o)}
                      onBlur={() => setTimeout(() => setGroupDropOpen(false), 150)}
                      className="w-full flex items-center justify-between gap-2 bg-zinc-50 border border-black/[0.08] rounded-lg px-3 py-2 text-left outline-none focus:border-amber-500/50"
                      style={{ fontSize: "0.82rem" }}
                    >
                      <span className={`truncate ${selectedGroup ? "text-zinc-900" : "text-zinc-400"}`}>
                        {groupsLoading
                          ? "Loading groups..."
                          : selectedGroup
                            ? `${selectedGroup.name} (${selectedGroup.member_count} ${selectedGroup.member_count === 1 ? "party" : "parties"})`
                            : "— Select Group —"}
                      </span>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={`shrink-0 text-zinc-400 transition-transform ${groupDropOpen ? "rotate-180" : ""}`}><path d="M6 9l6 6 6-6" /></svg>
                    </button>
                    {groupDropOpen && groups.length > 0 && (
                      <div
                        className="absolute z-20 w-full mt-1 rounded-lg border border-black/[0.08] bg-white shadow-xl overflow-y-auto"
                        style={{ maxHeight: "calc(5 * 2.5rem)" }}
                      >
                        <button
                          type="button"
                          onClick={() => { handleGroupChange(""); setGroupDropOpen(false); }}
                          className="w-full flex items-center px-3 text-left text-zinc-400 hover:bg-zinc-50"
                          style={{ fontSize: "0.82rem", height: "2.5rem" }}
                        >
                          — Select Group —
                        </button>
                        {groups.map(g => (
                          <button
                            key={g.id}
                            type="button"
                            onClick={() => { handleGroupChange(g.id); setGroupDropOpen(false); }}
                            className={`w-full flex items-center px-3 text-left hover:bg-amber-50 ${g.id === form.group_id ? "bg-amber-50 text-amber-700" : "text-zinc-900"}`}
                            style={{ fontSize: "0.82rem", height: "2.5rem" }}
                          >
                            <span className="truncate">{g.name} ({g.member_count} {g.member_count === 1 ? "party" : "parties"})</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  {!groupsLoading && groups.length === 0 && (
                    <p className="mt-1.5 text-zinc-500" style={{ fontSize: "0.7rem" }}>No groups yet — create one under Groups first.</p>
                  )}
                  {selectedGroup && (
                    <p className="mt-1.5 text-zinc-500" style={{ fontSize: "0.7rem" }}>
                      {selectedGroup.salesman_name
                        ? <>Salesman: <span className="text-zinc-700">{selectedGroup.salesman_name}</span> · {selectedGroup.member_count} {selectedGroup.member_count === 1 ? "party" : "parties"}</>
                        : <span className="text-amber-600">This group has no salesman assigned</span>}
                    </p>
                  )}
                </div>

                {/* Route name */}
                <div>
                  <label className="block text-zinc-600 mb-1" style={{ fontSize: "0.75rem" }}>Route Name *</label>
                  <input
                    type="text"
                    value={form.name}
                    onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                    placeholder="e.g. North Group — Monday"
                    className="w-full bg-black/[0.04] border border-black/[0.08] rounded-lg px-3 py-2 text-zinc-900 placeholder-zinc-600 outline-none focus:border-amber-500/50"
                    style={{ fontSize: "0.82rem" }}
                  />
                </div>

                {error && <p className="text-red-400" style={{ fontSize: "0.75rem" }}>{error}</p>}
              </div>

              <div className="px-6 py-4 border-t border-black/[0.06] flex gap-3">
                <button type="button" onClick={() => setShowModal(false)} className="flex-1 py-2 rounded-xl border border-black/[0.08] text-zinc-600 hover:text-zinc-900 hover:border-black/20 transition-all" style={{ fontSize: "0.82rem" }}>
                  Cancel
                </button>
                <button type="submit" disabled={saving} className="flex-1 py-2 rounded-xl bg-amber-500 hover:bg-amber-400 text-black font-semibold transition-all disabled:opacity-50 flex items-center justify-center gap-2" style={{ fontSize: "0.82rem" }}>
                  {saving && <Loader2 className="w-4 h-4 animate-spin" />}
                  {saving ? "Creating..." : `Create Route${selectedGroup ? ` · ${selectedGroup.member_count} stops` : ""}`}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Edit Route Modal */}
      {editingRoute && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.7)", backdropFilter: "blur(4px)" }}>
          <div className="w-full max-w-lg rounded-2xl border border-black/[0.08] bg-white shadow-2xl flex flex-col max-h-[92vh]" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-6 py-4 border-b border-black/[0.06]">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-amber-500/10 flex items-center justify-center">
                  <Edit2 className="w-4 h-4 text-amber-400" />
                </div>
                <div>
                  <h2 className="text-zinc-900 font-bold" style={{ fontSize: "1rem" }}>Edit Route</h2>
                  <p className="text-zinc-500" style={{ fontSize: "0.7rem" }}>{editingRoute.name}</p>
                </div>
              </div>
              <button onClick={() => setEditingRoute(null)} className="text-zinc-500 hover:text-zinc-900 transition-colors">
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleEditSubmit} className="flex flex-col flex-1 overflow-hidden">
              <div className="overflow-y-auto flex-1 px-6 py-4 space-y-4">
                <div>
                  <label className="block text-zinc-600 mb-1" style={{ fontSize: "0.75rem" }}>Route Name *</label>
                  <input
                    type="text"
                    value={editForm.name}
                    onChange={e => setEditForm(f => ({ ...f, name: e.target.value }))}
                    placeholder="e.g. North Zone Beat 1"
                    className="w-full bg-black/[0.04] border border-black/[0.08] rounded-lg px-3 py-2 text-zinc-900 placeholder-zinc-600 outline-none focus:border-amber-500/50"
                    style={{ fontSize: "0.82rem" }}
                  />
                </div>

                <div>
                  <label className="block text-zinc-600 mb-1" style={{ fontSize: "0.75rem" }}>Assigned Salesman</label>
                  <select
                    value={editForm.assigned_user_id}
                    onChange={e => handleEditSalesmanChange(e.target.value)}
                    className="w-full bg-zinc-50 border border-black/[0.08] rounded-lg px-3 py-2 text-zinc-900 outline-none focus:border-amber-500/50"
                    style={{ fontSize: "0.82rem" }}
                  >
                    <option value="">— Select Salesman —</option>
                    {salesmen.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </div>

                {/* Party picker for edit */}
                <div>
                  <label className="block text-zinc-600 mb-1" style={{ fontSize: "0.75rem" }}>
                    Parties <span className="text-zinc-600">({editSelectedParties.length} selected)</span>
                    {editForm.assigned_user_id && editSalesmanParties !== null && (
                      <span className="ml-2 text-amber-500/60">· showing {editSalesmanParties.length} downline parties</span>
                    )}
                  </label>

                  {editSelectedParties.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mb-2">
                      {editSelectedParties.map(p => (
                        <span key={p.id} className="flex items-center gap-1 px-2 py-0.5 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-300" style={{ fontSize: "0.72rem" }}>
                          {p.name}
                          <button
                            type="button"
                            onClick={() => setEditSelectedParties(prev => prev.filter(x => x.id !== p.id))}
                            className="text-amber-500/60 hover:text-amber-300 transition-colors ml-0.5"
                          >
                            <X className="w-3 h-3" />
                          </button>
                        </span>
                      ))}
                    </div>
                  )}

                  <div className="relative">
                    {editSalesmanPartiesLoading ? (
                      <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-black/[0.08] bg-black/[0.04] text-zinc-500" style={{ fontSize: "0.82rem" }}>
                        <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading downline parties...
                      </div>
                    ) : (
                      <>
                        <input
                          type="text"
                          value={editFormPartySearch}
                          onChange={e => { setEditFormPartySearch(e.target.value); setEditFormPartyDropOpen(true); }}
                          onFocus={() => setEditFormPartyDropOpen(true)}
                          onBlur={() => setTimeout(() => setEditFormPartyDropOpen(false), 150)}
                          placeholder={editForm.assigned_user_id ? (editSalesmanParties?.length === 0 ? "No downline parties found" : "Search downline parties...") : "Select a salesman first..."}
                          disabled={!editForm.assigned_user_id || editSalesmanParties?.length === 0}
                          className="w-full bg-black/[0.04] border border-black/[0.08] rounded-lg px-3 py-2 text-zinc-900 placeholder-zinc-600 outline-none focus:border-amber-500/50 disabled:opacity-40 disabled:cursor-not-allowed"
                          style={{ fontSize: "0.82rem" }}
                        />
                        {editFormPartyDropOpen && editForm.assigned_user_id && editSalesmanParties && editSalesmanParties.length > 0 && (
                          <div className="absolute z-20 w-full mt-1 rounded-lg border border-black/[0.08] bg-zinc-50 shadow-xl max-h-44 overflow-y-auto">
                            {(() => {
                              const filtered = editSalesmanParties
                                .filter(p => !editSelectedParties.some(s => s.id === p.id))
                                .filter(p => !editFormPartySearch || p.name.toLowerCase().includes(editFormPartySearch.toLowerCase()) || p.party_code?.toLowerCase().includes(editFormPartySearch.toLowerCase()))
                                .slice(0, 40);
                              return filtered.length > 0 ? filtered.map(p => (
                                <button
                                  key={p.id}
                                  type="button"
                                  onMouseDown={() => {
                                    setEditSelectedParties(prev => [...prev, p]);
                                    setEditFormPartySearch("");
                                  }}
                                  className="w-full flex items-center justify-between px-3 py-2 hover:bg-black/[0.06] text-left transition-colors"
                                >
                                  <span className="text-zinc-900" style={{ fontSize: "0.82rem" }}>{p.name}</span>
                                  <span className="text-zinc-500 font-mono" style={{ fontSize: "0.68rem" }}>{p.party_code}</span>
                                </button>
                              )) : (
                                <div className="px-3 py-3 text-zinc-500 text-center" style={{ fontSize: "0.78rem" }}>
                                  {editFormPartySearch ? "No parties found" : "All parties already selected"}
                                </div>
                              );
                            })()}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  <label className="text-zinc-600" style={{ fontSize: "0.75rem" }}>Status</label>
                  <button
                    type="button"
                    onClick={() => setEditForm(f => ({ ...f, is_active: !f.is_active }))}
                    className="relative inline-flex w-12 h-6 rounded-full focus:outline-none flex-shrink-0"
                    style={{
                      backgroundColor: editForm.is_active ? "#f59e0b" : "#3f3f46",
                      boxShadow: editForm.is_active ? "0 0 12px rgba(245,158,11,0.5)" : "none",
                      transition: "background-color 0.3s ease, box-shadow 0.3s ease",
                    }}
                  >
                    <span
                      className="absolute top-1 left-1 w-4 h-4 bg-white rounded-full shadow-md"
                      style={{
                        transform: editForm.is_active ? "translateX(1.5rem)" : "translateX(0)",
                        transition: "transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1)",
                        willChange: "transform",
                      }}
                    />
                  </button>
                  <span className="text-zinc-700" style={{ fontSize: "0.75rem" }}>{editForm.is_active ? "Active" : "Inactive"}</span>
                </div>

                {editError && <p className="text-red-400" style={{ fontSize: "0.75rem" }}>{editError}</p>}
              </div>

              <div className="px-6 py-4 border-t border-black/[0.06] flex gap-3">
                <button type="button" onClick={() => setEditingRoute(null)} className="flex-1 py-2 rounded-xl border border-black/[0.08] text-zinc-600 hover:text-zinc-900 hover:border-black/20 transition-all" style={{ fontSize: "0.82rem" }}>
                  Cancel
                </button>
                <button type="submit" disabled={editSaving} className="flex-1 py-2 rounded-xl bg-amber-500 hover:bg-amber-400 text-black font-semibold transition-all disabled:opacity-50 flex items-center justify-center gap-2" style={{ fontSize: "0.82rem" }}>
                  {editSaving && <Loader2 className="w-4 h-4 animate-spin" />}
                  {editSaving ? "Saving..." : "Save Changes"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

        {/* Manage Stops Modal */}
        {showStopModal && activeRoute && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.75)", backdropFilter: "blur(4px)" }} onClick={() => setStopDropOpen(false)}>
            <div className="w-full max-w-lg rounded-2xl border border-black/[0.08] bg-white shadow-2xl flex flex-col max-h-[90vh]" onClick={e => e.stopPropagation()}>

              {/* Header */}
              <div className="flex items-center justify-between px-6 py-4 border-b border-black/[0.06]">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-lg bg-cyan-500/10 flex items-center justify-center">
                    <MapPin className="w-4 h-4 text-cyan-400" />
                  </div>
                  <div>
                    <h2 className="text-zinc-900 font-bold" style={{ fontSize: "0.95rem" }}>Manage Stops</h2>
                    <p className="text-zinc-500" style={{ fontSize: "0.7rem" }}>{activeRoute.name} · {routeStops.length} stop{routeStops.length !== 1 ? "s" : ""}</p>
                  </div>
                </div>
                <button onClick={() => setShowStopModal(false)} className="text-zinc-500 hover:text-zinc-900 transition-colors">
                  <X className="w-5 h-5" />
                </button>
              </div>

              {/* Add parties form */}
              <form onSubmit={handleAddStop} className="px-6 py-4 border-b border-black/[0.06] space-y-3">
                <p className="text-zinc-600 font-medium" style={{ fontSize: "0.75rem" }}>Add Parties to Route</p>

                {selectedStopParties.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {selectedStopParties.map(p => (
                      <span key={p.id} className="flex items-center gap-1 px-2 py-0.5 rounded-lg bg-cyan-500/10 border border-cyan-500/20 text-cyan-300" style={{ fontSize: "0.72rem" }}>
                        {p.name}
                        <button type="button" onClick={() => setSelectedStopParties(prev => prev.filter(x => x.id !== p.id))} className="text-cyan-500/60 hover:text-cyan-300 transition-colors ml-0.5">
                          <X className="w-3 h-3" />
                        </button>
                      </span>
                    ))}
                  </div>
                )}

                <div className="relative">
                  {stopPartiesLoading ? (
                    <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-black/[0.08] bg-black/[0.04] text-zinc-500" style={{ fontSize: "0.82rem" }}>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading parties...
                    </div>
                  ) : (
                    <>
                      <input
                        type="text"
                        value={stopPartySearch}
                        onChange={e => { setStopPartySearch(e.target.value); setStopDropOpen(true); }}
                        onFocus={() => setStopDropOpen(true)}
                        onBlur={() => setTimeout(() => setStopDropOpen(false), 150)}
                        placeholder="Search and add parties..."
                        className="w-full bg-black/[0.04] border border-black/[0.08] rounded-lg px-3 py-2 text-zinc-900 placeholder-zinc-600 outline-none focus:border-cyan-500/50"
                        style={{ fontSize: "0.82rem" }}
                      />
                      {stopDropOpen && (
                        <div className="absolute z-10 w-full mt-1 rounded-lg border border-black/[0.08] bg-zinc-50 shadow-xl max-h-44 overflow-y-auto">
                          {(() => {
                            const alreadyAdded = new Set([...routeStops.map(rs => rs.party_id), ...selectedStopParties.map(p => p.id)]);
                            const searchList = stopParties.length > 0 ? stopParties : parties;
                            const filtered = searchList
                              .filter(p => !alreadyAdded.has(p.id))
                              .filter(p => !stopPartySearch || p.name.toLowerCase().includes(stopPartySearch.toLowerCase()) || p.party_code?.toLowerCase().includes(stopPartySearch.toLowerCase()))
                              .slice(0, 40);
                            return filtered.length > 0 ? filtered.map(p => (
                              <button key={p.id} type="button" onMouseDown={() => { setSelectedStopParties(prev => [...prev, p]); setStopPartySearch(""); }} className="w-full flex items-center justify-between px-3 py-2 hover:bg-black/[0.06] text-left transition-colors">
                                <span className="text-zinc-900" style={{ fontSize: "0.82rem" }}>{p.name}</span>
                                <span className="text-zinc-500 font-mono" style={{ fontSize: "0.68rem" }}>{p.party_code}</span>
                              </button>
                            )) : (
                              <div className="px-3 py-3 text-zinc-500 text-center" style={{ fontSize: "0.78rem" }}>
                                {stopPartySearch ? "No parties found" : "Type to search parties"}
                              </div>
                            );
                          })()}
                        </div>
                      )}
                    </>
                  )}
                </div>

                {stopError && <p className="text-red-400" style={{ fontSize: "0.72rem" }}>{stopError}</p>}

                <button
                  type="submit"
                  disabled={stopSaving || selectedStopParties.length === 0}
                  className="w-full py-2 rounded-xl bg-cyan-600 hover:bg-cyan-500 text-zinc-900 font-semibold transition-all disabled:opacity-40 flex items-center justify-center gap-2"
                  style={{ fontSize: "0.82rem" }}
                >
                  {stopSaving
                    ? <><Loader2 className="w-4 h-4 animate-spin" /> Adding...</>
                    : <><Plus className="w-4 h-4" />{selectedStopParties.length > 0 ? `Add ${selectedStopParties.length} Stop${selectedStopParties.length > 1 ? "s" : ""}` : "Add Stops"}</>}
                </button>
              </form>

              {/* Stops list */}
              <div className="flex-1 overflow-y-auto px-6 py-4">
                {stopsLoading ? (
                  <div className="flex items-center justify-center py-8"><Loader2 className="w-5 h-5 text-cyan-400 animate-spin" /></div>
                ) : routeStops.length === 0 ? (
                  <div className="text-center py-8 text-zinc-600">
                    <MapPin className="w-8 h-8 mx-auto mb-2 opacity-30" />
                    <p style={{ fontSize: "0.78rem" }}>No stops added yet</p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {routeStops.map((stop, i) => (
                      <div key={stop.id} className="flex items-center gap-3 px-3 py-2.5 rounded-lg border border-black/[0.05] bg-black/[0.02] hover:bg-black/[0.04] transition-all group">
                        <div className="w-6 h-6 rounded-full bg-cyan-500/10 flex items-center justify-center flex-shrink-0">
                          <span className="text-cyan-400 font-mono font-bold" style={{ fontSize: "0.65rem" }}>{i + 1}</span>
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-zinc-900 truncate" style={{ fontSize: "0.82rem" }}>{stop.parties?.name || "Unknown Party"}</p>
                          <div className="flex items-center gap-2">
                            {stop.parties?.party_code && <span className="text-zinc-500 font-mono" style={{ fontSize: "0.65rem" }}>{stop.parties.party_code}</span>}
                            {stop.parties?.party_types?.name && <span className="text-zinc-600" style={{ fontSize: "0.65rem" }}>· {stop.parties.party_types.name}</span>}
                            {stop.notes && <span className="text-zinc-500" style={{ fontSize: "0.65rem" }}>· {stop.notes}</span>}
                          </div>
                        </div>
                        <button onClick={() => handleDeleteStop(stop.id)} className="opacity-0 group-hover:opacity-100 text-zinc-600 hover:text-red-400 transition-all">
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

            </div>
          </div>
        )}

      {/* ── View Route Modal (salesman) ── */}
      {showViewRouteModal && viewRoute && (() => {
        const geoStops = viewRouteStops.filter(hasStopCoordinates);
        const mapsUrl = buildGoogleMapsUrl(viewRouteStops, routeOrigin);
        return (
          <div
            className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4"
            style={{ background: "rgba(0,0,0,0.75)", backdropFilter: "blur(4px)" }}
            onClick={() => setShowViewRouteModal(false)}
          >
            <div
              className="w-full sm:max-w-lg rounded-t-2xl sm:rounded-2xl border border-black/[0.08] bg-white shadow-2xl flex flex-col"
              style={{ maxHeight: "92vh" }}
              onClick={e => e.stopPropagation()}
            >
              {/* Header */}
              <div className="flex items-center justify-between px-5 py-4 border-b border-black/[0.06]">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-xl bg-cyan-500/10 flex items-center justify-center flex-shrink-0">
                    <RouteIcon className="w-4 h-4 text-cyan-400" />
                  </div>
                  <div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <h2 className="text-zinc-900 font-bold leading-tight" style={{ fontSize: "0.95rem" }}>{viewRoute.name}</h2>
                      {viewRoute.code && (
                        <span className="px-2 py-0.5 rounded-md bg-cyan-500/10 text-cyan-600 font-medium" style={{ fontSize: "0.62rem" }}>{dayLabel(viewRoute.code)}</span>
                      )}
                    </div>
                    {viewRoute.salesman && (
                      <p className="text-zinc-500 mt-0.5" style={{ fontSize: "0.68rem" }}>
                        {viewRoute.salesman.name} · <span className="font-medium">{viewRoute.stops} stops</span>
                      </p>
                    )}
                  </div>
                </div>
                <button onClick={() => setShowViewRouteModal(false)} className="text-zinc-400 hover:text-zinc-700 transition-colors p-1">
                  <X className="w-5 h-5" />
                </button>
              </div>

              {/* Tab switcher */}
              <div className="flex border-b border-black/[0.06]">
                {(["parties", "map"] as const).map((tab) => (
                  <button
                    key={tab}
                    onClick={() => {
                      setViewRouteTab(tab);
                      if (tab === "map") requestRouteOrigin();
                    }}
                    className={`flex-1 flex items-center justify-center gap-2 py-3 text-sm font-medium transition-all border-b-2 ${
                      viewRouteTab === tab
                        ? "border-cyan-500 text-cyan-600 bg-cyan-500/5"
                        : "border-transparent text-zinc-400 hover:text-zinc-600 hover:bg-black/[0.02]"
                    }`}
                    style={{ fontSize: "0.82rem" }}
                  >
                    {tab === "parties" ? (
                      <><MapPin className="w-3.5 h-3.5" /> Party List</>
                    ) : (
                      <><Map className="w-3.5 h-3.5" /> Route Map</>
                    )}
                  </button>
                ))}
              </div>

              {/* ── Tab: Parties ── */}
              {viewRouteTab === "parties" && (
                <div className="flex-1 overflow-y-auto">
                  {viewRouteLoading ? (
                    <div className="flex items-center justify-center py-14">
                      <Loader2 className="w-5 h-5 text-cyan-400 animate-spin" />
                    </div>
                  ) : viewRouteStops.length === 0 ? (
                    <div className="text-center py-14 text-zinc-400">
                      <MapPin className="w-8 h-8 mx-auto mb-2 opacity-30" />
                      <p style={{ fontSize: "0.8rem" }}>No stops added to this route yet</p>
                    </div>
                  ) : (
                    <div className="divide-y divide-black/[0.04]">
                      {viewRouteStops.map((stop, idx) => {
                        const p = stop.parties;
                        const stopPoint = getStopPoint(stop);
                        const hasGps = Boolean(stopPoint);
                        return (
                          <div key={stop.id} className="flex items-start gap-3 px-5 py-3.5">
                            <div className="flex-shrink-0 w-6 h-6 rounded-full bg-cyan-500/10 flex items-center justify-center mt-0.5">
                              <span className="text-cyan-500 font-bold font-mono" style={{ fontSize: "0.6rem" }}>{idx + 1}</span>
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="text-zinc-900 font-medium truncate" style={{ fontSize: "0.83rem" }}>
                                  {p?.name || "Unknown Party"}
                                </span>
                                {p?.party_types?.name && (
                                  <span className="px-1.5 py-0.5 rounded bg-zinc-100 text-zinc-500 flex-shrink-0" style={{ fontSize: "0.6rem" }}>
                                    {p.party_types.name}
                                  </span>
                                )}
                              </div>
                              {p?.party_code && (
                                <span className="text-zinc-400 font-mono block" style={{ fontSize: "0.65rem" }}>{p.party_code}</span>
                              )}
                              {(p?.address_line1 || p?.city) && (
                                <p className="text-zinc-400 mt-0.5 truncate" style={{ fontSize: "0.67rem" }}>
                                  {[p.address_line1, p.city].filter(Boolean).join(", ")}
                                </p>
                              )}
                            </div>
                            {hasGps ? (
                              <a
                                href={`https://www.google.com/maps/search/?api=1&query=${stopPoint!.latitude},${stopPoint!.longitude}`}
                                target="_blank" rel="noopener noreferrer"
                                className="flex-shrink-0 p-1.5 rounded-lg text-emerald-400 hover:bg-emerald-500/10 transition-all mt-0.5"
                                title="View on map"
                                onClick={e => e.stopPropagation()}
                              >
                                <Map className="w-3.5 h-3.5" />
                              </a>
                            ) : (
                              <div className="flex-shrink-0 p-1.5 mt-0.5" title="No GPS set">
                                <AlertCircle className="w-3.5 h-3.5 text-amber-300" />
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              {/* ── Tab: Route Map ── */}
              {viewRouteTab === "map" && (
                <div className="flex-1 flex flex-col min-h-0">
                  {viewRouteLoading ? (
                    <div className="flex items-center justify-center flex-1 py-14">
                      <Loader2 className="w-5 h-5 text-cyan-400 animate-spin" />
                    </div>
                  ) : geoStops.length === 0 ? (
                    <div className="flex flex-col items-center justify-center flex-1 py-14 text-zinc-400 gap-3">
                      <Map className="w-10 h-10 opacity-20" />
                      <p style={{ fontSize: "0.82rem" }}>No GPS coordinates set for any stop</p>
                      <p className="text-zinc-300" style={{ fontSize: "0.72rem" }}>Set GPS on parties to enable map view</p>
                    </div>
                  ) : (
                    <>
                      {/* Inline Leaflet map */}
                      <RouteMapView stops={geoStops} origin={routeOrigin} />

                      {(routeOriginLoading || routeOriginError || routeOrigin) && (
                        <div className="px-4 py-2 border-t border-black/[0.05] flex items-center justify-between gap-3">
                          <div className="flex items-center gap-2 min-w-0 text-zinc-500" style={{ fontSize: "0.68rem" }}>
                            {routeOriginLoading ? (
                              <Loader2 className="w-3.5 h-3.5 animate-spin text-cyan-500 flex-shrink-0" />
                            ) : routeOrigin ? (
                              <Crosshair className="w-3.5 h-3.5 text-cyan-500 flex-shrink-0" />
                            ) : (
                              <AlertCircle className="w-3.5 h-3.5 text-amber-400 flex-shrink-0" />
                            )}
                            <span className="truncate">
                              {routeOriginLoading
                                ? "Getting salesman location..."
                                : routeOrigin
                                  ? "Navigation starts from salesman location"
                                  : routeOriginError}
                            </span>
                          </div>
                          {routeOriginError && (
                            <button
                              type="button"
                              onClick={() => requestRouteOrigin(true)}
                              className="flex-shrink-0 px-2 py-1 rounded-lg border border-cyan-500/20 text-cyan-500 hover:bg-cyan-500/10 transition-all"
                              style={{ fontSize: "0.66rem" }}
                            >
                              Retry
                            </button>
                          )}
                        </div>
                      )}

                      {/* Stop sequence legend */}
                      <div className="px-4 py-3 border-t border-black/[0.05] overflow-x-auto">
                        <div className="flex gap-2 min-w-max">
                          {geoStops.map((stop, idx) => (
                            <div key={stop.id} className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-black/[0.03] border border-black/[0.06] flex-shrink-0">
                              <div className="w-4 h-4 rounded-full bg-cyan-500 flex items-center justify-center flex-shrink-0">
                                <span className="text-white font-bold" style={{ fontSize: "0.52rem" }}>{idx + 1}</span>
                              </div>
                              <span className="text-zinc-700" style={{ fontSize: "0.67rem", maxWidth: "80px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                {stop.parties?.name || "?"}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>

                      {geoStops.length < viewRouteStops.length && (
                        <p className="px-4 pb-2 text-amber-500 text-center" style={{ fontSize: "0.67rem" }}>
                          {viewRouteStops.length - geoStops.length} stop{viewRouteStops.length - geoStops.length !== 1 ? "s" : ""} without GPS not shown on map
                        </p>
                      )}
                    </>
                  )}
                </div>
              )}

              {/* Footer — always visible Navigate button */}
              <div className="px-5 py-4 border-t border-black/[0.06]">
                {mapsUrl ? (
                  <div className="space-y-1.5">
                    {geoStops.length < viewRouteStops.length && (
                      <p className="text-amber-500 text-center" style={{ fontSize: "0.67rem" }}>
                        {viewRouteStops.length - geoStops.length} stop{viewRouteStops.length - geoStops.length !== 1 ? "s" : ""} without GPS will be skipped
                      </p>
                    )}
                    {routeOriginLoading ? (
                      <div className="flex items-center justify-center gap-2 w-full py-3 rounded-xl bg-cyan-500/70 text-white font-semibold" style={{ fontSize: "0.85rem" }}>
                        <Loader2 className="w-4 h-4 animate-spin" />
                        Getting Salesman Location...
                      </div>
                    ) : (
                      <a
                        href={mapsUrl}
                        target="_blank" rel="noopener noreferrer"
                        className="flex items-center justify-center gap-2 w-full py-3 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-white font-semibold transition-all"
                        style={{ fontSize: "0.85rem", textDecoration: "none" }}
                      >
                        <Navigation className="w-4 h-4" />
                        {routeOrigin ? "Navigate From Salesman Location" : "Navigate Party Sequence in Google Maps"}
                      </a>
                    )}
                  </div>
                ) : !viewRouteLoading ? (
                  <div className="flex items-center justify-center gap-2 py-3 rounded-xl bg-zinc-100 text-zinc-400" style={{ fontSize: "0.82rem" }}>
                    <AlertCircle className="w-4 h-4" />
                    Set GPS on parties to enable navigation
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
