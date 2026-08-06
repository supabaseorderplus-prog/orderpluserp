"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { api, getUser } from "@/lib/api";
import { publishLocation, disconnectMqtt } from "@/lib/mqtt-client";
import { evaluateTrackingSegment, MAX_ACCEPTABLE_ACCURACY_M } from "@/lib/tracking-integrity";
import type { SalesmanGpsStatus } from "@/components/SalesmanGpsGuardian";
import { getAndroidNativePlugin } from "@/lib/capacitor-native-plugin";
import Link from "next/link";
import {
  MapPin, FileText, Building2, IndianRupee,
  Play, Square, Loader2, Navigation, CheckCircle2,
  TrendingUp, AlertTriangle,
  Banknote, ClipboardList, Network, Activity, Users, WifiOff,
  Gift, Target, RefreshCw,
} from "lucide-react";

// ── Capacitor Android native background-location plugin ───────────────────────
// The Capacitor WebView injects window.Capacitor at runtime; no npm import needed.
interface BGLocationPlugin {
  startTracking: (opts: {
    authToken: string;
    refreshToken: string;
    companyId: string;
    userId: string;
    resumeActiveDuty?: boolean;
  }) => Promise<void>;
  stopTracking: () => Promise<void>;
  isTracking: () => Promise<{ active: boolean }>;
  getGpsStatus: () => Promise<GpsStatus>;
  openLocationSettings: () => Promise<{ opened: boolean }>;
  openNotificationSettings: () => Promise<{ opened: boolean }>;
  showGpsOffWarning: () => Promise<void>;
  requestBackgroundPermission: () => Promise<{ granted: boolean }>;
  requestReliabilityPermissions: () => Promise<{
    batteryOptimizationDisabled: boolean;
    backgroundLocationGranted: boolean;
    notificationsGranted: boolean;
  }>;
}
type GpsStatus = SalesmanGpsStatus;
interface RemoteGpsHealth {
  gps_enabled: boolean;
  permission_granted: boolean;
  service_active: boolean;
  location_available: boolean;
  status_updated_at: string;
  device_platform: string | null;
  stale: boolean;
  age_ms: number | null;
}
/** Returns the native plugin when running inside the Capacitor Android shell, else null. */
function getNativeBGLocation(): BGLocationPlugin | null {
  return getAndroidNativePlugin<BGLocationPlugin>("BackgroundLocation");
}

async function startNativeTrackingIfAvailable(
  userId: string,
  { resumeActiveDuty = false }: { resumeActiveDuty?: boolean } = {},
) {
  const bgPlugin = getNativeBGLocation();
  if (!bgPlugin) return false;

  const authToken = localStorage.getItem("accessToken") || "";
  const refreshToken = localStorage.getItem("refreshToken") || "";
  const companyId = localStorage.getItem("activeCompanyId") || "";
  if (!authToken || !userId) return false;

  const initialStatus = await bgPlugin.getGpsStatus();
  if (!initialStatus.locationServicesEnabled && !resumeActiveDuty) {
    await bgPlugin.openLocationSettings().catch(() => ({ opened: false }));
    throw new Error("GPS is turned off. Turn it on in your phone settings before starting duty.");
  }

  if (!resumeActiveDuty) {
    try {
      await bgPlugin.requestBackgroundPermission();
    } catch {
      // Foreground service can still run while the notification is active.
    }
    try {
      await bgPlugin.requestReliabilityPermissions();
    } catch {
      // Some managed/OEM devices do not expose a battery-exemption dialog.
    }
  }

  await bgPlugin.startTracking({ authToken, refreshToken, companyId, userId, resumeActiveDuty });
  return true;
}

function preciseCurrentPosition(): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("This device cannot provide a GPS location."));
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      timeout: 15_000,
      maximumAge: 0,
    });
  });
}

interface MyScheme {
  id: string;
  name: string;
  scheme_type: string;
  end_date: string;
  target_value: number | null;
  reward_description: string | null;
  progress: {
    current_value: number;
    target_value: number;
    progress_percent: number;
    is_achieved: boolean;
  };
}

interface SalesmanStats {
  todaySales: number;
  mtdSales: number;
  outstanding: number;
  totalParties: number;
  recentInvoices: {
    id: string; invoice_number: string; invoice_date: string;
    grand_total: number; payment_status: string; party_name: string;
  }[];
}

interface DutySession {
  id: string;
  status: "active" | "checked_out";
  check_in_time: string;
  check_out_time: string | null;
  total_distance_km: number;
  total_stops: number;
}

interface ActiveRouteVisit {
  stop_id: string;
}

interface ActiveRouteRun {
  route_id: string;
  route_name: string | null;
  status: "active" | "completed";
  ordered_stop_ids: string[];
  visits: ActiveRouteVisit[];
  total_stops: number;
  active_stop_id: string | null;
  signoff_request: {
    id: string;
    status: "pending" | "approved" | "rejected";
    reason: string;
    remaining_stop_ids: string[];
    requested_at: string;
    decided_at: string | null;
    decided_by_name: string | null;
    decision_note: string | null;
  } | null;
}

interface ActiveRouteStop {
  id: string;
  stop_order: number;
  parties: {
    name?: string | null;
    party_code?: string | null;
    address_line1?: string | null;
    city?: string | null;
  } | null;
}

function formatINR(n: number) {
  if (n >= 10000000) return `${(n / 10000000).toFixed(2)} Cr`;
  if (n >= 100000) return `${(n / 100000).toFixed(2)} L`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return n.toLocaleString("en-IN");
}

function fmtTime(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true });
}

function fmtDuration(start: string | null, end: string | null) {
  if (!start) return "—";
  const ms = (end ? new Date(end).getTime() : Date.now()) - new Date(start).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

// ── IndexedDB offline ping queue ──────────────────────────────────────────────
const IDB_NAME = "hometech-duty";
const IDB_STORE = "ping-queue";

function openIDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE, { autoIncrement: true });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function queuePingOffline(ping: Record<string, unknown>): Promise<void> {
  try {
    const db = await openIDB();
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).add(ping);
    await new Promise<void>((res, rej) => {
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
    db.close();
  } catch {}
}

async function drainOfflineQueue(): Promise<number> {
  let drained = 0;
  try {
    const db = await openIDB();
    const tx = db.transaction(IDB_STORE, "readwrite");
    const store = tx.objectStore(IDB_STORE);
    const all: { key: IDBValidKey; value: Record<string, unknown> }[] = await new Promise((res, rej) => {
      const results: { key: IDBValidKey; value: Record<string, unknown> }[] = [];
      const req = store.openCursor();
      req.onsuccess = (e) => {
        const c = (e.target as IDBRequest<IDBCursorWithValue | null>).result;
        if (c) { results.push({ key: c.key, value: c.value as Record<string, unknown> }); c.continue(); }
        else res(results);
      };
      req.onerror = () => rej(req.error);
    });
    db.close();

    for (const { key, value } of all) {
      try {
        const resp = await api<{ success: boolean }>("/api/v1/duty/location", {
          method: "POST",
          body: value,
        });
        if (resp.success) {
          const db2 = await openIDB();
          const tx2 = db2.transaction(IDB_STORE, "readwrite");
          tx2.objectStore(IDB_STORE).delete(key);
          await new Promise<void>((res) => { tx2.oncomplete = () => res(); });
          db2.close();
          drained++;
        }
      } catch { break; }
    }
  } catch {}
  return drained;
}

// ─────────────────────────────────────────────────────────────────────────────

const statusCfg: Record<string, { label: string; color: string; bg: string }> = {
  PAID:    { label: "Paid",    color: "text-emerald-400", bg: "bg-emerald-500/10" },
  PARTIAL: { label: "Partial", color: "text-amber-400",   bg: "bg-amber-500/10"  },
  UNPAID:  { label: "Unpaid",  color: "text-red-400",     bg: "bg-red-500/10"    },
};

export default function SalesmanDashboard() {
  const user = getUser();
  const [stats, setStats]               = useState<SalesmanStats | null>(null);
  const [session, setSession]           = useState<DutySession | null>(null);
  const [dutyLoading, setDutyLoading]   = useState(false);
  const [statsLoading, setStatsLoading] = useState(true);
  const [locationError, setLocationError] = useState("");
  const [elapsed, setElapsed]           = useState("—");
  const [liveDistance, setLiveDistance] = useState(0);
  const [pings, setPings]               = useState(0);
  const [isOffline, setIsOffline]       = useState(false);
  const [queuedPings, setQueuedPings]   = useState(0);
  const [mySchemes, setMySchemes]       = useState<MyScheme[]>([]);
  const [schemesLoading, setSchemesLoading] = useState(true);
  const [recalculating, setRecalculating] = useState(false);
  const [showEndDutyConfirm, setShowEndDutyConfirm] = useState(false);
  const [endDutyReason, setEndDutyReason] = useState("");
  const [activeRouteRun, setActiveRouteRun] = useState<ActiveRouteRun | null>(null);
  const [activeRouteStops, setActiveRouteStops] = useState<ActiveRouteStop[]>([]);
  const [gpsStatus, setGpsStatus] = useState<GpsStatus | null>(null);
  const [remoteGpsHealth, setRemoteGpsHealth] = useState<RemoteGpsHealth | null>(null);

  const tickRef            = useRef<ReturnType<typeof setInterval> | null>(null);
  const watchIdRef         = useRef<number | null>(null);
  const watchIdCoarseRef   = useRef<number | null>(null);
  const lastPosRef         = useRef<{ lat: number; lng: number; accuracy: number; recordedAt: string } | null>(null);
  const distanceRef        = useRef(0);
  const lastPingRef        = useRef<number>(0);
  const batteryRef         = useRef<number | null>(null);
  const wakeLockRef        = useRef<WakeLockSentinel | null>(null);
  const sessionActiveRef   = useRef(false); // track duty state without re-renders
  // The dashboard-level guardian runs across every salesman page. This view
  // listens to its status so the duty card can display the corrective action.
  useEffect(() => {
    const onStatus = (event: Event) => {
      const nextStatus = (event as CustomEvent<GpsStatus>).detail;
      setGpsStatus(nextStatus);
      if (nextStatus.locationServicesEnabled && nextStatus.fineLocationGranted) {
        setLocationError("");
      }
    };
    window.addEventListener("hometech:gps-status", onStatus);
    getNativeBGLocation()?.getGpsStatus().then(setGpsStatus).catch(() => {});
    return () => {
      window.removeEventListener("hometech:gps-status", onStatus);
    };
  }, []);

  useEffect(() => {
    if (session?.status !== "active") return;
    let cancelled = false;
    const loadHealth = () => {
      api<{ data: RemoteGpsHealth | null }>("/api/v1/duty/gps-health", {
        noCache: true,
        suppressErrorLog: true,
      })
        .then((result) => {
          if (!cancelled) setRemoteGpsHealth(result.data);
        })
        .catch(() => {});
    };
    loadHealth();
    const timer = window.setInterval(loadHealth, 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [session?.status]);

  // ── Battery ────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (typeof window === "undefined") return;
    const nav = navigator as Navigator & { getBattery?: () => Promise<{ level: number; addEventListener: (e: string, cb: () => void) => void }> };
    if (!nav.getBattery) return;
    nav.getBattery().then((battery) => {
      batteryRef.current = Math.round(battery.level * 100);
      battery.addEventListener("levelchange", () => {
        batteryRef.current = Math.round(battery.level * 100);
      });
    }).catch(() => {});
  }, []);

  // ── Wake Lock ──────────────────────────────────────────────────────────────
  const acquireWakeLock = useCallback(async () => {
    if (typeof window === "undefined" || !("wakeLock" in navigator)) return;
    try {
      const wl = await (navigator as Navigator & {
        wakeLock: { request: (type: string) => Promise<WakeLockSentinel> }
      }).wakeLock.request("screen");
      wakeLockRef.current = wl;
      wl.addEventListener("release", () => {
        wakeLockRef.current = null;
        // Re-acquire automatically if still on duty
        if (sessionActiveRef.current) acquireWakeLock();
      });
    } catch { /* not supported or denied — silently continue */ }
  }, []);

  const releaseWakeLock = useCallback(() => {
    wakeLockRef.current?.release().catch(() => {});
    wakeLockRef.current = null;
  }, []);

  // Re-acquire when tab becomes visible again (wake lock is auto-released on hide)
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible" && sessionActiveRef.current && wakeLockRef.current === null) {
        acquireWakeLock();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [acquireWakeLock]);

  // ── Online / Offline detection + queue drain ───────────────────────────────
  useEffect(() => {
    const onOnline = () => {
      setIsOffline(false);
      if (!sessionActiveRef.current) return;
      drainOfflineQueue().then((n) => {
        if (n > 0) {
          setPings((p) => p + n);
          setQueuedPings(0);
        }
      });
    };
    const onOffline = () => setIsOffline(true);

    setIsOffline(!navigator.onLine);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);

  // ── Fetch personal stats ───────────────────────────────────────────────────
  const fetchStats = useCallback(async () => {
    try {
      const res = await api<{ success: boolean; data: SalesmanStats }>("/api/v1/analytics/dashboard");
      setStats(res.data);
    } catch {}
    setStatsLoading(false);
  }, []);

  // ── Fetch today's session ──────────────────────────────────────────────────
  const fetchSession = useCallback(async () => {
    try {
      const res = await api<{ data: DutySession | null }>("/api/v1/duty/session");
      if (res.data) {
        setSession(res.data);
        const dbDist = res.data.total_distance_km || 0;
        distanceRef.current = dbDist;
        setLiveDistance(dbDist);
      }
    } catch {}
  }, []);

  const fetchActiveRoute = useCallback(async () => {
    try {
      const result = await api<{ data: { run: ActiveRouteRun | null } }>(
        "/api/v1/duty/route-run",
        { noCache: true, suppressErrorLog: true },
      );
      const run = result.data.run;
      setActiveRouteRun(run);
      if (!run?.route_id) {
        setActiveRouteStops([]);
        return;
      }

      try {
        const stopsResult = await api<{ data: ActiveRouteStop[] }>(
          `/api/v1/tracking/routes/stops?route_id=${run.route_id}`,
          { noCache: true, suppressErrorLog: true },
        );
        const order = new Map(run.ordered_stop_ids.map((id, index) => [id, index]));
        setActiveRouteStops([...(stopsResult.data || [])].sort((a, b) => {
          const aIndex = order.get(a.id);
          const bIndex = order.get(b.id);
          return (aIndex ?? a.stop_order ?? 999) - (bIndex ?? b.stop_order ?? 999);
        }));
      } catch {
        // Keep the route header/progress visible even if stop details are delayed.
        setActiveRouteStops([]);
      }
    } catch {
      setActiveRouteRun(null);
      setActiveRouteStops([]);
    }
  }, []);

  useEffect(() => {
    fetchStats();
    fetchSession();
    fetchActiveRoute();
    api<{ success: boolean; data: MyScheme[] }>("/api/v1/schemes/my")
      .then((r) => setMySchemes(r.data || []))
      .catch(() => setMySchemes([]))
      .finally(() => setSchemesLoading(false));
  }, [fetchStats, fetchSession, fetchActiveRoute]);

  // The web API and native foreground service share one Supabase session. When
  // the WebView rotates that session, immediately give the fresh credentials to
  // the native service so background uploads never get stuck behind a stale JWT.
  useEffect(() => {
    const syncNativeAuth = () => {
      const bgPlugin = getNativeBGLocation();
      if (!bgPlugin) return;
      bgPlugin.isTracking()
        .then(({ active }) => {
          if (active) return startNativeTrackingIfAvailable(
            user?.id || "",
            { resumeActiveDuty: true },
          );
        })
        .catch(() => {});
    };
    window.addEventListener("hometech:auth-refreshed", syncNativeAuth);
    return () => window.removeEventListener("hometech:auth-refreshed", syncNativeAuth);
  }, [user?.id]);

  const handleRecalculateSchemes = async () => {
    setRecalculating(true);
    try {
      await api("/api/v1/schemes/my", { method: "POST" });
      const r = await api<{ success: boolean; data: MyScheme[] }>("/api/v1/schemes/my");
      setMySchemes(r.data || []);
    } catch {
      // silent — progress will just show stale data
    } finally {
      setRecalculating(false);
    }
  };

  // ── Elapsed timer ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (tickRef.current) clearInterval(tickRef.current);
    if (session?.status === "active" && session.check_in_time) {
      const tick = () => setElapsed(fmtDuration(session.check_in_time, null));
      tick();
      tickRef.current = setInterval(tick, 15000);
    } else {
      setElapsed(fmtDuration(session?.check_in_time ?? null, session?.check_out_time ?? null));
    }
    return () => { if (tickRef.current) clearInterval(tickRef.current); };
  }, [session]);

  // ── Register SW message handler ────────────────────────────────────────────
  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;
    const handler = (event: MessageEvent) => {
      const { data } = event;
      if (!data) return;
      if (data.type === "GET_LOCATION" && event.ports[0]) {
        const port = event.ports[0];
        if (!navigator.geolocation) { port.postMessage(null); return; }
        navigator.geolocation.getCurrentPosition(
          (pos) => port.postMessage({
            latitude: pos.coords.latitude, longitude: pos.coords.longitude,
            accuracy: pos.coords.accuracy, speed: pos.coords.speed, heading: pos.coords.heading,
          }),
          () => port.postMessage(null),
          { timeout: 8000, maximumAge: 5000 }
        );
      }
    };
    navigator.serviceWorker.addEventListener("message", handler);
    return () => navigator.serviceWorker.removeEventListener("message", handler);
  }, []);

  // ── Notify SW ──────────────────────────────────────────────────────────────
  const notifySW = useCallback((type: "DUTY_START" | "DUTY_END") => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;
    const token = localStorage.getItem("accessToken") || "";
    const baseUrl = window.location.origin;
    navigator.serviceWorker.ready.then((reg) => {
      reg.active?.postMessage({ type, token, baseUrl });
    });
  }, []);

  // ── Stop watchPosition ─────────────────────────────────────────────────────
  const stopWatchPosition = useCallback(() => {
    if (watchIdRef.current != null) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
    if (watchIdCoarseRef.current != null) {
      navigator.geolocation.clearWatch(watchIdCoarseRef.current);
      watchIdCoarseRef.current = null;
    }
    lastPosRef.current = null;
    sessionActiveRef.current = false;
    releaseWakeLock();
  }, [releaseWakeLock]);

  // ── Start watchPosition — dual GPS (satellite) + cell/WiFi ────────────────
  const startWatchPosition = useCallback(() => {
    if (!navigator.geolocation) return;

    sessionActiveRef.current = true;
    acquireWakeLock();

    // Clear any existing watchers first
    if (watchIdRef.current != null) navigator.geolocation.clearWatch(watchIdRef.current);
    if (watchIdCoarseRef.current != null) navigator.geolocation.clearWatch(watchIdCoarseRef.current);

    // Shared handler — both sources call this; best accuracy wins
    const onPosition = (pos: GeolocationPosition) => {
      const { latitude, longitude, accuracy, speed, heading } = pos.coords;
      const prev = lastPosRef.current;

      const recordedAt = new Date(pos.timestamp || Date.now()).toISOString();
      if (accuracy <= MAX_ACCEPTABLE_ACCURACY_M) {
        if (prev) {
          const decision = evaluateTrackingSegment(
            { latitude: prev.lat, longitude: prev.lng, accuracy: prev.accuracy, recorded_at: prev.recordedAt },
            { latitude, longitude, accuracy, speed, recorded_at: recordedAt },
          );
          if (decision.accepted) {
            if (decision.countsDistance) distanceRef.current += decision.distanceM / 1000;
            setLiveDistance(parseFloat(distanceRef.current.toFixed(2)));
            lastPosRef.current = { lat: latitude, lng: longitude, accuracy, recordedAt };
          }
        } else {
          lastPosRef.current = { lat: latitude, lng: longitude, accuracy, recordedAt };
        }
      }

      // Browser fallback cadence. Android uses the native foreground service,
      // which continues at the same cadence after the WebView is removed.
      const now = Date.now();
      if (now - lastPingRef.current < 10_000) return;
      lastPingRef.current = now;

      const ping = {
        salesman_id: user?.id || "",
        latitude, longitude, accuracy,
        speed: speed ?? null,
        heading: heading ?? null,
        battery_level: batteryRef.current,
        total_distance_km: distanceRef.current,
        queued_at: new Date().toISOString(),
      };

      const nativeBG = getNativeBGLocation();

      // Helper: send the ping to the API (or queue offline)
      const postPing = () => {
        if (navigator.onLine) {
          api("/api/v1/duty/location", { method: "POST", body: ping })
            .then(() => setPings((p) => p + 1))
            .catch(() => {
              queuePingOffline(ping);
              setQueuedPings((q) => q + 1);
            });
        } else {
          queuePingOffline(ping).then(() => setQueuedPings((q) => q + 1));
        }
      };

      if (navigator.onLine) {
        // Always publish to MQTT for the live tracking dashboard
        publishLocation({
          salesman_id: ping.salesman_id,
          latitude: ping.latitude,
          longitude: ping.longitude,
          accuracy: ping.accuracy,
          speed: ping.speed,
          heading: ping.heading,
          battery_level: ping.battery_level,
          recorded_at: new Date().toISOString(),
        });
      }

      if (!nativeBG) {
        // Web browser (no native plugin): web JS is the only pinger
        postPing();
      } else {
        // Android native: the foreground service pings every 10 s when alive.
        // Check if it's still running; if not, fall back to web JS and restart it.
        nativeBG.isTracking()
          .then(({ active }) => {
            if (!active) {
              postPing();
              // Service was killed — restart it so background tracking resumes
              startNativeTrackingIfAvailable(
                user?.id || "",
                { resumeActiveDuty: true },
              ).catch(() => {});
            }
            // If active: native service is already posting — no web JS duplicate needed
          })
          .catch(() => {
            // isTracking() threw — assume service is dead, post via web JS
            postPing();
          });
      }
    };

    const onError = (err: GeolocationPositionError) => {
      if (err.code === err.PERMISSION_DENIED) {
        setLocationError("GPS is off or location access is blocked. Turn on GPS and allow precise location.");
      }
    };

    // Watcher 1: HIGH ACCURACY — true GPS satellite fix (works with no internet)
    watchIdRef.current = navigator.geolocation.watchPosition(
      onPosition, onError,
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
    );

    // Watcher 2: LOW ACCURACY — cell towers + WiFi (faster first fix, fallback)
    watchIdCoarseRef.current = navigator.geolocation.watchPosition(
      onPosition, () => {},
      { enableHighAccuracy: false, maximumAge: 10000, timeout: 10000 }
    );
  }, [acquireWakeLock, user?.id]);

  // ── Re-attach watcher if page reloaded while active ───────────────────────
  useEffect(() => {
    if (session?.status === "active") {
      distanceRef.current = session.total_distance_km || 0;
      setLiveDistance(distanceRef.current);
      startWatchPosition();
      notifySW("DUTY_START");
      // Ensure native service is running on Android (may have stopped if phone rebooted)
      const bgPlugin = getNativeBGLocation();
      if (bgPlugin) {
        bgPlugin.isTracking().then(({ active }) => {
          if (!active) {
            startNativeTrackingIfAvailable(
              user?.id || "",
              { resumeActiveDuty: true },
            )
              .then(() => bgPlugin.getGpsStatus().then(setGpsStatus))
              .catch((error) => {
                setLocationError(error instanceof Error
                  ? error.message
                  : "Background GPS monitoring could not be restarted.");
              });
          }
        }).catch(() => {});
      }
    }
    return () => {
      stopWatchPosition();
      disconnectMqtt();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.id]);

  // ── Start duty ─────────────────────────────────────────────────────────────
  const startDuty = async () => {
    setLocationError("");
    setDutyLoading(true);

    let nativeStarted = false;
    try {
      nativeStarted = await startNativeTrackingIfAvailable(user?.id || "");
      const position = await preciseCurrentPosition();
      const res = await api<{ data: DutySession }>("/api/v1/duty/session", {
        method: "POST",
        body: { latitude: position.coords.latitude, longitude: position.coords.longitude },
      });
      setSession(res.data);
      distanceRef.current = 0;
      setLiveDistance(0);
      lastPosRef.current = null;
      startWatchPosition();
      notifySW("DUTY_START");
    } catch (error) {
      if (nativeStarted) await getNativeBGLocation()?.stopTracking().catch(() => {});
      const message = error instanceof Error ? error.message : "";
      setLocationError(message || "Precise GPS permission and Location Services are required before starting duty.");
    } finally {
      setDutyLoading(false);
    }
  };

  // ── End duty ───────────────────────────────────────────────────────────────
  const endDuty = () => {
    setEndDutyReason(activeRouteRun?.signoff_request?.reason || "");
    setShowEndDutyConfirm(true);
    void fetchActiveRoute();
  };

  const confirmEndDuty = async () => {
    setDutyLoading(true);
    setLocationError("");
    try {
      const position = await preciseCurrentPosition().catch(() => null);
      const res = await api<{ data: DutySession }>("/api/v1/duty/session", {
        method: "PATCH",
        body: {
          latitude: position?.coords.latitude ?? null,
          longitude: position?.coords.longitude ?? null,
          status: "checked_out",
          total_distance_km: distanceRef.current,
        },
      });
      setSession(res.data);
      setShowEndDutyConfirm(false);
      stopWatchPosition();
      notifySW("DUTY_END");
      await getNativeBGLocation()?.stopTracking().catch(() => {});
    } catch (error) {
      setLocationError(error instanceof Error ? error.message : "Failed to end duty. Try again.");
    } finally {
      setDutyLoading(false);
    }
  };

  const requestDutySignoff = async () => {
    setDutyLoading(true);
    setLocationError("");
    try {
      const result = await api<{ data: ActiveRouteRun }>("/api/v1/duty/signoff", {
        method: "POST",
        body: { reason: endDutyReason },
      });
      setActiveRouteRun(result.data);
    } catch (error) {
      setLocationError(error instanceof Error ? error.message : "Could not send the sign-off request.");
    } finally {
      setDutyLoading(false);
    }
  };

  useEffect(() => {
    if (!showEndDutyConfirm || activeRouteRun?.signoff_request?.status !== "pending") return;
    const timer = window.setInterval(() => void fetchActiveRoute(), 10_000);
    return () => window.clearInterval(timer);
  }, [showEndDutyConfirm, activeRouteRun?.signoff_request?.status, fetchActiveRoute]);

  const isOnDuty = session?.status === "active";
  const nativeGpsAvailable = Boolean(getNativeBGLocation());
  const remoteAndroidHealth = remoteGpsHealth?.device_platform === "android" ? remoteGpsHealth : null;
  const localGpsProblem = nativeGpsAvailable && Boolean(gpsStatus) && (
    !gpsStatus?.locationServicesEnabled ||
    !gpsStatus?.fineLocationGranted ||
    !gpsStatus?.trackingActive ||
    !gpsStatus?.notificationsGranted
  );
  const remoteGpsProblem = !nativeGpsAvailable && Boolean(remoteAndroidHealth) && (
    remoteAndroidHealth?.stale ||
    !remoteAndroidHealth?.gps_enabled ||
    !remoteAndroidHealth?.permission_granted ||
    !remoteAndroidHealth?.service_active
  );
  const gpsProblem = isOnDuty && (localGpsProblem || remoteGpsProblem);
  const gpsProblemMessage = nativeGpsAvailable
    ? !gpsStatus?.locationServicesEnabled
      ? "GPS is off. Turn it on to continue verified duty tracking and restore native alerts."
      : !gpsStatus?.fineLocationGranted
        ? "Precise location permission is blocked. Allow it to continue duty tracking."
        : !gpsStatus?.notificationsGranted
          ? "Android notifications are blocked. Allow notifications to receive GPS warnings."
          : "Android background GPS monitoring stopped. The app is restarting it now."
    : remoteAndroidHealth?.stale || !remoteAndroidHealth?.service_active
      ? "The Android tracking service is not reporting. Open the phone app and allow Location and Notifications."
      : "The Android phone reports that GPS is off or location permission is blocked.";
  const trackingHealthy = !isOffline && (
    nativeGpsAvailable
      ? Boolean(gpsStatus?.locationServicesEnabled && gpsStatus.fineLocationGranted &&
          gpsStatus.trackingActive && gpsStatus.notificationsGranted)
      : remoteAndroidHealth
        ? !remoteAndroidHealth.stale && remoteAndroidHealth.gps_enabled &&
          remoteAndroidHealth.permission_granted && remoteAndroidHealth.service_active
        : !locationError
  );
  const visitedRouteStopIds = new Set((activeRouteRun?.visits || []).map((visit) => visit.stop_id));
  const nextRouteStop = activeRouteStops.find((stop) => stop.id === activeRouteRun?.active_stop_id && !visitedRouteStopIds.has(stop.id))
    || activeRouteStops.find((stop) => !visitedRouteStopIds.has(stop.id))
    || null;
  const routeTotalStops = activeRouteRun?.total_stops || activeRouteStops.length;
  const routeVisitedStops = activeRouteRun?.visits.length || 0;
  const routeProgress = routeTotalStops > 0
    ? Math.min(100, Math.round((routeVisitedStops / routeTotalStops) * 100))
    : 0;
  const today = new Date().toLocaleDateString("en-IN", {
    weekday: "long", day: "numeric", month: "short", year: "numeric",
  });

  // Resolve a display name: skip values that are purely numeric (phone stored as name)
  const rawName = user?.name?.trim() || "";
  const nameIsPhone = /^\d{7,}$/.test(rawName.replace(/[\s\-().+]/g, ""));
  const displayFirstName = nameIsPhone || !rawName
    ? ((user as unknown as Record<string, string>)?.party_name?.split(" ")[0] || "Salesman")
    : rawName.split(" ")[0];

  return (
    <div style={{ fontFamily: "'Inter', 'system-ui', sans-serif" }}>

      {/* ── Header ── */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-zinc-900 mb-1">
            Good {new Date().getHours() < 12 ? "Morning" : new Date().getHours() < 17 ? "Afternoon" : "Evening"},{" "}
            {displayFirstName}
          </h1>
          <p className="text-zinc-500 text-xs">{today}</p>
        </div>
        <div className="flex items-center gap-2">
          {isOffline && (
            <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-amber-500/10 text-amber-400 text-xs border border-amber-500/20">
              <WifiOff className="w-3 h-3" />
              Offline
            </span>
          )}
          {isOnDuty && (
            <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-emerald-500/10 text-emerald-400 text-xs border border-emerald-500/20">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
              On Duty
            </span>
          )}
        </div>
      </div>

      {/* ── Duty Card ── */}
      <div className={`rounded-2xl border p-5 mb-6 transition-all ${
        isOnDuty
          ? "border-emerald-500/30 bg-gradient-to-br from-emerald-500/10 to-emerald-500/5"
          : "border-black/[0.08] bg-black/[0.02]"
      }`}>
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-zinc-900 font-semibold text-base">
              {isOnDuty ? "Duty in Progress" : session?.status === "checked_out" ? "Duty Ended" : "Start Your Duty"}
            </h2>
            <p className="text-zinc-500 text-xs mt-0.5">
              {isOnDuty
                ? isOffline
                  ? `No internet · ${queuedPings} ping${queuedPings !== 1 ? "s" : ""} queued offline`
                  : getNativeBGLocation()
                    ? "Native Android tracking — active even when app is closed"
                    : `Dual GPS + cell tracking · ${pings} pings sent`
                : session?.status === "checked_out"
                ? "Today's duty is complete"
                : "Tap the button below to begin your shift"}
            </p>
          </div>
          <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${isOnDuty ? "bg-emerald-500/20" : "bg-black/[0.06]"}`}>
            {isOnDuty
              ? <Navigation className="w-5 h-5 text-emerald-400 animate-pulse" />
              : <MapPin className="w-5 h-5 text-zinc-600" />}
          </div>
        </div>

        {/* Session stats */}
        {session && (
          <div className="grid grid-cols-3 gap-2 mb-4">
            {[
              { label: "Check In", value: fmtTime(session.check_in_time) },
              { label: "Duration", value: elapsed },
              { label: "Distance", value: `${liveDistance.toFixed(1)} km` },
            ].map((s) => (
              <div key={s.label} className="rounded-xl bg-black/[0.04] border border-black/[0.06] py-2 px-3 text-center">
                <div className="text-zinc-900 text-sm font-semibold">{s.value}</div>
                <div className="text-zinc-500 text-[0.6rem] mt-0.5">{s.label}</div>
              </div>
            ))}
          </div>
        )}

        {/* Active route summary — shown only while duty is active and a route is locked. */}
        {isOnDuty && activeRouteRun && (
          <div className="mb-4 overflow-hidden rounded-xl border border-blue-200 bg-white shadow-sm">
            <div className="border-b border-blue-100 bg-gradient-to-r from-blue-50 to-emerald-50 px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-600 text-white">
                    <Navigation className="h-4 w-4" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-[0.58rem] font-bold uppercase tracking-[0.14em] text-blue-600">Today&apos;s active route</div>
                    <div className="truncate text-sm font-bold text-zinc-900">{activeRouteRun.route_name || "Selected field route"}</div>
                  </div>
                </div>
                <span className="shrink-0 rounded-full bg-emerald-100 px-2.5 py-1 text-[0.62rem] font-bold text-emerald-700">
                  {routeVisitedStops}/{routeTotalStops} visited
                </span>
              </div>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-blue-100">
                <div className="h-full rounded-full bg-blue-600 transition-all" style={{ width: `${routeProgress}%` }} />
              </div>
            </div>

            <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <div className="text-[0.58rem] font-bold uppercase tracking-wider text-zinc-400">
                  {nextRouteStop ? "Chosen next party" : "Route status"}
                </div>
                <div className="mt-0.5 truncate text-xs font-bold text-zinc-800">
                  {nextRouteStop?.parties?.name || (routeVisitedStops >= routeTotalStops ? "All parties completed" : "Open route to view stop details")}
                </div>
                {nextRouteStop && (
                  <div className="mt-0.5 truncate text-[0.62rem] text-zinc-500">
                    {[nextRouteStop.parties?.address_line1, nextRouteStop.parties?.city]
                      .filter(Boolean)
                      .join(", ") || nextRouteStop.parties?.party_code || "Party location available in route view"}
                  </div>
                )}
              </div>
              <Link
                href="/dashboard/routes"
                className="flex shrink-0 items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-xs font-bold text-white shadow-sm transition hover:bg-blue-500"
              >
                <Navigation className="h-3.5 w-3.5" /> View Full Route
              </Link>
            </div>
          </div>
        )}

        {/* Live GPS indicator */}
        {gpsProblem && (
          <div className="mb-4 flex items-center justify-between gap-3 rounded-xl border border-red-300 bg-red-50 px-3 py-2.5">
            <div className="flex min-w-0 items-center gap-2">
              <AlertTriangle className="h-4 w-4 shrink-0 text-red-600" />
              <p className="text-xs font-semibold text-red-700">
                {gpsProblemMessage}
              </p>
            </div>
            {nativeGpsAvailable && (
              <button
                type="button"
                onClick={() => {
                  const plugin = getNativeBGLocation();
                  if (!plugin) return;
                  if (!gpsStatus?.locationServicesEnabled) {
                    plugin.openLocationSettings().catch(() => {});
                    return;
                  }
                  if (!gpsStatus?.notificationsGranted) {
                    plugin.openNotificationSettings().catch(() => {});
                    return;
                  }
                  startNativeTrackingIfAvailable(
                    user?.id || "",
                    { resumeActiveDuty: true },
                  ).then(() => plugin.getGpsStatus().then(setGpsStatus)).catch(() => {});
                }}
                className="shrink-0 rounded-lg bg-red-600 px-3 py-2 text-[0.65rem] font-bold text-white"
              >
                {!gpsStatus?.locationServicesEnabled
                  ? "Turn on GPS"
                  : !gpsStatus?.notificationsGranted
                    ? "Allow notifications"
                    : "Restore tracking"}
              </button>
            )}
          </div>
        )}

        {isOnDuty && trackingHealthy && (
          <div className="flex items-center gap-2 rounded-xl bg-emerald-500/5 border border-emerald-500/20 px-3 py-2 mb-4">
            <Activity className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
            <p className="text-emerald-400 text-xs">
              {getNativeBGLocation()
                ? "Native Android GPS active — tracking continues even if you close the app"
                : "GPS + cellular tracking active — location saved even without internet"}
            </p>
          </div>
        )}

        {/* Offline queued pings indicator */}
        {isOnDuty && isOffline && (
          <div className="flex items-center gap-2 rounded-xl bg-amber-500/5 border border-amber-500/20 px-3 py-2 mb-4">
            <WifiOff className="w-3.5 h-3.5 text-amber-400 shrink-0" />
            <p className="text-amber-400 text-xs">
              No internet — {queuedPings} location{queuedPings !== 1 ? "s" : ""} saved. Will upload automatically when reconnected.
            </p>
          </div>
        )}

        {locationError && !gpsProblem && !remoteAndroidHealth && (
          <p className="text-red-400 text-xs mb-3 flex items-center gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5" />{locationError}
          </p>
        )}

        {/* Action button */}
        {session?.status !== "checked_out" && (
          <button
            onClick={isOnDuty ? endDuty : startDuty}
            disabled={dutyLoading}
            className={`w-full flex items-center justify-center gap-2.5 py-3 rounded-xl font-semibold text-sm transition-all ${
              isOnDuty
                ? "bg-red-500/20 text-red-400 border border-red-500/30 hover:bg-red-500/30"
                : "bg-emerald-500 text-zinc-900 hover:bg-emerald-400"
            }`}
            style={{ cursor: "pointer", fontFamily: "inherit" }}
          >
            {dutyLoading
              ? <Loader2 className="w-4 h-4 animate-spin" />
              : isOnDuty
              ? <><Square className="w-4 h-4" /> End Duty</>
              : <><Play className="w-4 h-4" /> Start Duty</>}
          </button>
        )}

        {session?.status === "checked_out" && (
          <div className="space-y-2">
            <div className="flex items-center justify-center gap-2 py-2 text-zinc-500 text-sm">
              <CheckCircle2 className="w-4 h-4 text-emerald-500" />
              Checked out at {fmtTime(session.check_out_time)}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-xl bg-black/[0.04] border border-black/[0.06] py-2 px-3 text-center">
                <div className="text-zinc-900 text-sm font-semibold">{fmtDuration(session.check_in_time, session.check_out_time)}</div>
                <div className="text-zinc-500 text-[0.6rem] mt-0.5">Total Duration</div>
              </div>
              <div className="rounded-xl bg-black/[0.04] border border-black/[0.06] py-2 px-3 text-center">
                <div className="text-zinc-900 text-sm font-semibold">{(session.total_distance_km || 0).toFixed(1)} km</div>
                <div className="text-zinc-500 text-[0.6rem] mt-0.5">Total Distance</div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ── Personal KPIs ── */}
      {statsLoading ? (
        <div className="grid grid-cols-2 gap-3 mb-6">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="rounded-xl border border-black/[0.06] bg-black/[0.02] p-4 animate-pulse h-20" />
          ))}
        </div>
      ) : stats && (
        <div className="grid grid-cols-2 gap-3 mb-6">
          {[
            { label: "Today's Billing", value: `₹${formatINR(stats.todaySales)}`, icon: IndianRupee, color: "text-emerald-400", bg: "from-emerald-500/20 to-emerald-500/5" },
            { label: "MTD Sales",       value: `₹${formatINR(stats.mtdSales)}`,   icon: TrendingUp,  color: "text-amber-400",   bg: "from-amber-500/20 to-amber-500/5"   },
            { label: "Outstanding",     value: `₹${formatINR(stats.outstanding)}`, icon: Banknote,   color: "text-red-400",     bg: "from-red-500/20 to-red-500/5"       },
            { label: "My Parties",      value: stats.totalParties,                 icon: Building2,  color: "text-blue-400",    bg: "from-blue-500/20 to-blue-500/5"     },
          ].map((kpi) => {
            const Icon = kpi.icon;
            return (
              <div key={kpi.label} className={`rounded-xl border border-black/[0.06] bg-gradient-to-br ${kpi.bg} p-4`}>
                <div className="flex items-center gap-2 mb-2">
                  <Icon className={`w-4 h-4 ${kpi.color}`} />
                  <span className="text-zinc-500 text-xs">{kpi.label}</span>
                </div>
                <div className="text-zinc-900 font-bold text-lg">{kpi.value}</div>
              </div>
            );
          })}
        </div>
      )}

      {/* ── My Active Schemes ── */}
      {!schemesLoading && mySchemes.length > 0 && (
        <div className="mb-6">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Gift className="w-4 h-4 text-amber-500" />
              <h3 className="text-sm font-semibold text-zinc-900">My Active Schemes</h3>
            </div>
            <button
              onClick={handleRecalculateSchemes}
              disabled={recalculating}
              className="flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-600 transition-colors disabled:opacity-50"
              title="Recalculate progress from payments"
            >
              <RefreshCw className={`w-3 h-3 ${recalculating ? "animate-spin" : ""}`} />
              {recalculating ? "Updating…" : "Sync"}
            </button>
          </div>
          <div className="space-y-3">
            {mySchemes.map((scheme) => {
              const pct = Math.min(100, Number(scheme.progress.progress_percent));
              const days = Math.max(0, Math.ceil((new Date(scheme.end_date).getTime() - Date.now()) / 86400000));
              const curVal = Number(scheme.progress.current_value);
              const tgtVal = Number(scheme.progress.target_value) || Number(scheme.target_value) || 1;
              return (
                <div key={scheme.id} className="rounded-xl border border-black/[0.06] bg-white p-4">
                  <div className="flex items-center justify-between mb-1.5">
                    <div className="flex items-center gap-2">
                      <Target className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                      <span className="text-zinc-900 font-medium text-sm">{scheme.name}</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      {scheme.progress.is_achieved ? (
                        <span className="flex items-center gap-0.5 px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-600" style={{ fontSize: "0.6rem" }}>
                          <CheckCircle2 className="w-2.5 h-2.5" /> Done!
                        </span>
                      ) : (
                        <span className="text-zinc-400" style={{ fontSize: "0.65rem" }}>{days}d left</span>
                      )}
                    </div>
                  </div>

                  {scheme.reward_description && (
                    <p className="text-zinc-400 mb-2 ml-5.5" style={{ fontSize: "0.65rem", marginLeft: "1.375rem" }}>
                      {scheme.reward_description}
                    </p>
                  )}

                  <div className="w-full h-2 rounded-full bg-black/[0.06] overflow-hidden mb-1.5">
                    <div
                      className={`h-full rounded-full transition-all duration-500 ${
                        scheme.progress.is_achieved ? "bg-emerald-500" : pct >= 75 ? "bg-amber-500" : "bg-blue-500"
                      }`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>

                  <div className="flex justify-between items-center">
                    <span className="text-zinc-500 text-xs">
                      ₹{curVal >= 100000 ? `${(curVal / 100000).toFixed(2)}L` : curVal.toLocaleString("en-IN")}
                    </span>
                    <span className="font-semibold" style={{
                      fontSize: "0.7rem",
                      color: scheme.progress.is_achieved ? "#10b981" : pct >= 75 ? "#f59e0b" : "#6b7280",
                    }}>
                      {pct.toFixed(0)}%
                    </span>
                    <span className="text-zinc-400 text-xs">
                      Target: ₹{tgtVal >= 100000 ? `${(tgtVal / 100000).toFixed(2)}L` : tgtVal.toLocaleString("en-IN")}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Quick Actions ── */}
      <div className="grid grid-cols-3 gap-3 mb-6">
        {[
          { label: "New Invoice", icon: ClipboardList, href: "/dashboard/invoices/new", color: "text-emerald-400" },
          { label: "My Parties",  icon: Building2,     href: "/dashboard/parties",      color: "text-blue-400"   },
          { label: "My Downline", icon: Network,       href: "/dashboard/downline",     color: "text-violet-400" },
          { label: "Payments",    icon: Banknote,      href: "/dashboard/payments",     color: "text-amber-400"  },
          { label: "Ledgers",     icon: FileText,      href: "/dashboard/ledgers",      color: "text-cyan-400"   },
          { label: "Rankings",    icon: Users,         href: "/dashboard/rankings",     color: "text-pink-400"   },
        ].map((a) => {
          const Icon = a.icon;
          return (
            <Link
              key={a.label}
              href={a.href}
              className="flex flex-col items-center gap-1.5 p-3 rounded-xl border border-black/[0.06] bg-black/[0.02] hover:bg-black/[0.04] hover:border-black/[0.1] transition-all text-center group"
              style={{ textDecoration: "none" }}
            >
              <Icon className={`w-4 h-4 ${a.color} group-hover:scale-110 transition-transform`} />
              <span className="text-[0.65rem] text-zinc-600 group-hover:text-zinc-800 transition-colors leading-tight">{a.label}</span>
            </Link>
          );
        })}
      </div>

      {/* ── Recent Invoices ── */}
      {stats && stats.recentInvoices.length > 0 && (
        <div className="rounded-xl border border-black/[0.06] bg-black/[0.02] overflow-hidden">
          <div className="flex items-center justify-between px-5 py-3.5 border-b border-black/[0.06]">
            <h3 className="text-sm font-semibold text-zinc-900">Recent Invoices</h3>
            <Link href="/dashboard/invoices/new" className="text-xs text-amber-400 hover:text-amber-300" style={{ textDecoration: "none" }}>
              New Invoice
            </Link>
          </div>
          <div className="divide-y divide-black/[0.04]">
            {stats.recentInvoices.slice(0, 5).map((inv) => {
              const st = statusCfg[inv.payment_status] || statusCfg.UNPAID;
              return (
                <div key={inv.id} className="flex items-center justify-between px-5 py-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-7 h-7 rounded-lg bg-black/[0.04] flex items-center justify-center shrink-0">
                      <FileText className="w-3 h-3 text-zinc-500" />
                    </div>
                    <div className="min-w-0">
                      <div className="text-xs font-medium text-zinc-900 truncate">{inv.invoice_number || "Draft"}</div>
                      <div className="text-[0.65rem] text-zinc-500 truncate">{inv.party_name}</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className={`px-2 py-0.5 rounded text-[0.6rem] font-medium ${st.bg} ${st.color}`}>{st.label}</span>
                    <span className="text-xs font-medium text-zinc-900 tabular-nums">₹{Number(inv.grand_total || 0).toLocaleString("en-IN")}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── End Duty Confirmation Modal ── */}
      {showEndDutyConfirm && (() => {
        const checkInTime = session?.check_in_time ? new Date(session.check_in_time) : null;
        const durationMs = checkInTime ? Date.now() - checkInTime.getTime() : 0;
        const totalMins = Math.floor(durationMs / 60000);
        const hrs = Math.floor(totalMins / 60);
        const mins = totalMins % 60;
        const durationLabel = hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;
        const kmLabel = `${liveDistance.toFixed(1)} km`;
        const routeIncomplete = Boolean(activeRouteRun && routeVisitedStops < routeTotalStops);
        const signoff = activeRouteRun?.signoff_request || null;
        const approvalGranted = routeIncomplete && signoff?.status === "approved";
        const approvalPending = routeIncomplete && signoff?.status === "pending";
        const approvalRejected = routeIncomplete && signoff?.status === "rejected";

        return (
          <div
            className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 backdrop-blur-sm p-4"
            onClick={() => setShowEndDutyConfirm(false)}
          >
            <div
              className="bg-white rounded-2xl w-full max-w-sm overflow-hidden mb-2"
              style={{ border: "1px solid rgba(0,0,0,0.08)" }}
              onClick={e => e.stopPropagation()}
            >
              <div className="flex items-center gap-3 px-5 pt-5 pb-4">
                <div className={`w-11 h-11 rounded-xl border flex items-center justify-center shrink-0 ${routeIncomplete && !approvalGranted ? "bg-amber-500/10 border-amber-500/20" : "bg-red-500/10 border-red-500/20"}`}>
                  {routeIncomplete && !approvalGranted ? <AlertTriangle className="w-5 h-5 text-amber-500" /> : <Square className="w-5 h-5 text-red-400" />}
                </div>
                <div>
                  <h3 className="text-zinc-900 font-bold" style={{ fontSize: "1rem" }}>{routeIncomplete && !approvalGranted ? "Admin approval required" : "End Duty?"}</h3>
                  <p className="text-zinc-500" style={{ fontSize: "0.75rem", margin: 0 }}>
                    {routeIncomplete && !approvalGranted
                      ? `${routeTotalStops - routeVisitedStops} ${routeTotalStops - routeVisitedStops === 1 ? "party is" : "parties are"} still unvisited on today's route.`
                      : approvalGranted
                        ? "Admin approved this incomplete-route sign-off."
                        : "Every route party is complete. Your session can now be closed."}
                  </p>
                </div>
              </div>

              {/* Session summary */}
              <div className="mx-5 mb-4 rounded-xl overflow-hidden" style={{ border: "1px solid rgba(0,0,0,0.07)" }}>
                <div className="grid grid-cols-2 divide-x divide-black/[0.06]">
                  <div className="flex flex-col items-center py-4 px-3 bg-black/[0.02]">
                    <Navigation className="w-4 h-4 text-zinc-400 mb-1.5" />
                    <span className="text-zinc-900 font-bold tabular-nums" style={{ fontSize: "1.35rem" }}>{kmLabel}</span>
                    <span className="text-zinc-400 font-medium mt-0.5" style={{ fontSize: "0.65rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>Distance Clocked</span>
                  </div>
                  <div className="flex flex-col items-center py-4 px-3 bg-black/[0.02]">
                    <Activity className="w-4 h-4 text-zinc-400 mb-1.5" />
                    <span className="text-zinc-900 font-bold tabular-nums" style={{ fontSize: "1.35rem" }}>{durationLabel}</span>
                    <span className="text-zinc-400 font-medium mt-0.5" style={{ fontSize: "0.65rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>Time on Duty</span>
                  </div>
                </div>
                {checkInTime && (
                  <div className="flex items-center justify-between px-4 py-2.5 border-t border-black/[0.05]">
                    <span className="text-zinc-400" style={{ fontSize: "0.7rem" }}>Checked in at</span>
                    <span className="text-zinc-700 font-medium font-mono" style={{ fontSize: "0.72rem" }}>
                      {fmtTime(session!.check_in_time)}
                    </span>
                  </div>
                )}
                {activeRouteRun && (
                  <div className="flex items-center justify-between px-4 py-2.5 border-t border-black/[0.05]">
                    <span className="text-zinc-400" style={{ fontSize: "0.7rem" }}>Route coverage</span>
                    <span className={`font-bold ${routeIncomplete ? "text-amber-600" : "text-emerald-600"}`} style={{ fontSize: "0.72rem" }}>{routeVisitedStops}/{routeTotalStops} parties visited</span>
                  </div>
                )}
              </div>

              {routeIncomplete && (
                <div className="mx-5 mb-4 space-y-3">
                  {approvalPending && (
                    <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-3">
                      <div className="flex items-center gap-2 text-xs font-bold text-amber-800"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Waiting for admin approval</div>
                      <p className="mt-1.5 text-[0.68rem] leading-relaxed text-amber-700">Keep duty active and GPS tracking on. This screen refreshes automatically when the admin decides.</p>
                      <button type="button" onClick={() => void fetchActiveRoute()} className="mt-2 flex items-center gap-1.5 text-[0.65rem] font-bold text-amber-800"><RefreshCw className="h-3 w-3" /> Check approval now</button>
                    </div>
                  )}
                  {approvalRejected && (
                    <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-3 text-xs text-red-700">
                      <div className="font-bold">Previous request rejected</div>
                      <p className="mt-1 leading-relaxed">{signoff?.decision_note || "The admin asked you to complete the remaining route parties."}</p>
                    </div>
                  )}
                  {approvalGranted && (
                    <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-3 text-xs text-emerald-700">
                      <div className="flex items-center gap-2 font-bold"><CheckCircle2 className="h-4 w-4" /> Approved by {signoff?.decided_by_name || "admin"}</div>
                      {signoff?.decision_note && <p className="mt-1 leading-relaxed">{signoff.decision_note}</p>}
                    </div>
                  )}
                  {!approvalPending && !approvalGranted && (
                    <div>
                      <label className="block text-xs font-bold text-zinc-700">Why couldn&apos;t you visit the remaining {routeTotalStops - routeVisitedStops === 1 ? "party" : "parties"}? <span className="text-red-500">*</span></label>
                      <textarea value={endDutyReason} onChange={(event) => setEndDutyReason(event.target.value)} rows={4} placeholder="Example: Shop was closed after two attempts; owner confirmed by phone that it will reopen tomorrow." className="mt-2 w-full resize-none rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-3 text-sm text-zinc-900 outline-none focus:border-amber-400 focus:ring-2 focus:ring-amber-100" />
                      <p className="mt-1.5 text-[0.65rem] leading-relaxed text-zinc-500">Your duty stays active until the admin approves. You can continue visiting parties while the request is pending.</p>
                    </div>
                  )}
                </div>
              )}

              {/* Actions */}
              <div className="flex gap-3 px-5 pb-5">
                <button
                  onClick={() => setShowEndDutyConfirm(false)}
                  className="flex-1 py-2.5 rounded-xl border border-black/[0.08] text-zinc-600 font-medium hover:bg-black/[0.04] transition-all"
                  style={{ fontSize: "0.85rem", fontFamily: "inherit", background: "none", cursor: "pointer" }}
                >
                  Cancel
                </button>
                {routeIncomplete && !approvalGranted ? (
                  <button
                    onClick={approvalPending ? () => void fetchActiveRoute() : requestDutySignoff}
                    disabled={dutyLoading || (!approvalPending && endDutyReason.trim().length < 10)}
                    className="flex-1 py-2.5 rounded-xl bg-amber-500 text-zinc-950 font-semibold hover:bg-amber-400 transition-all flex items-center justify-center gap-2 disabled:bg-zinc-200 disabled:text-zinc-400"
                    style={{ fontSize: "0.85rem", fontFamily: "inherit", border: "none", cursor: "pointer" }}
                  >
                    {dutyLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : approvalPending ? <RefreshCw className="w-3.5 h-3.5" /> : <AlertTriangle className="w-3.5 h-3.5" />}
                    {approvalPending ? "Check Status" : approvalRejected ? "Resubmit Request" : "Request Approval"}
                  </button>
                ) : (
                  <button
                    onClick={confirmEndDuty}
                    disabled={dutyLoading}
                    className="flex-1 py-2.5 rounded-xl bg-red-500 text-white font-semibold hover:bg-red-600 transition-all flex items-center justify-center gap-2 disabled:opacity-50"
                    style={{ fontSize: "0.85rem", fontFamily: "inherit", border: "none", cursor: "pointer" }}
                  >
                    {dutyLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Square className="w-3.5 h-3.5" />} {approvalGranted ? "End Duty (Approved)" : "Yes, End Duty"}
                  </button>
                )}
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
