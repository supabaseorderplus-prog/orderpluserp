"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import dynamic from "next/dynamic";
import { api } from "@/lib/api";
import {
  MapPin, Clock, Navigation, Activity,
  Calendar, RefreshCw, Eye, TrendingUp,
  CheckCircle, XCircle, AlertCircle, Zap, Route,
  ArrowLeft, Truck, Package,
} from "lucide-react";

const LeafletTrailMap = dynamic(() => import("@/components/LeafletTrailMap"), {
  ssr: false,
  loading: () => (
    <div className="flex items-center justify-center h-[420px]">
      <RefreshCw className="w-6 h-6 text-sky-400 animate-spin" />
    </div>
  ),
});

// ── Types ──────────────────────────────────────────────────────────────────────
interface Driver {
  id: string;
  name: string;
  email: string;
  employee_code: string | null;
  phone: string | null;
  active_lot?: { lot_number: string; destination: string } | null;
  session: DaySession | null;
  latest_location: LocationLog | null;
}
interface LocationLog {
  id?: string;
  latitude: number;
  longitude: number;
  accuracy?: number;
  battery_level?: number;
  speed?: number;
  heading?: number;
  address?: string;
  activity?: string;
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
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function calcTrailDistance(trail: { latitude: number; longitude: number }[]) {
  let total = 0;
  for (let i = 1; i < trail.length; i++) {
    total += haversineKm(
      trail[i - 1].latitude, trail[i - 1].longitude,
      trail[i].latitude, trail[i].longitude
    );
  }
  return total;
}

function fmtTime(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true });
}
function fmtDuration(start: string | null, end: string | null) {
  if (!start) return "—";
  const s = new Date(start).getTime();
  const e = end ? new Date(end).getTime() : Date.now();
  const mins = Math.floor((e - s) / 60000);
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

function driverStatusColor(d: Driver) {
  if (!d.session) return "bg-zinc-50 text-zinc-600 border-zinc-700";
  if (d.session.status === "active") return "bg-sky-500/10 text-sky-400 border-sky-500/20";
  if (d.session.status === "checked_out") return "bg-zinc-700/40 text-zinc-600 border-zinc-700";
  return "bg-amber-500/10 text-amber-400 border-amber-500/20";
}
function driverStatusLabel(d: Driver) {
  if (!d.session) return "Offline";
  if (d.session.status === "active") return "On Duty";
  if (d.session.status === "checked_out") return "Duty Ended";
  return "Idle";
}

// ── Main Page ──────────────────────────────────────────────────────────────────
export default function VanTrackingPage() {
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [selectedDate, setSelectedDate] = useState(new Date().toISOString().split("T")[0]);
  const [selected, setSelected] = useState<Driver | null>(null);
  const [trail, setTrail] = useState<LocationLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [trailLoading, setTrailLoading] = useState(false);
  const [lastRefresh, setLastRefresh] = useState(new Date());
  const [filter, setFilter] = useState<"all" | "active" | "offline">("all");
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  const fetchDrivers = useCallback(async (date: string) => {
    setLoading(true);
    try {
      const json = await api<{ data: Driver[] }>(`/api/v1/tracking/drivers?date=${date}`);
      setDrivers(json.data || []);
      setLastRefresh(new Date());
    } catch { setDrivers([]); }
    setLoading(false);
  }, []);

  const fetchTrail = useCallback(async (driverId: string, date: string) => {
    setTrailLoading(true);
    const json = await api<{ data: LocationLog[] }>(`/api/v1/tracking/location?salesman_id=${driverId}&date=${date}&limit=1000`);
    setTrail(json.data || []);
    setTrailLoading(false);
  }, []);

  // Initial load + auto-refresh every 30s
  useEffect(() => {
    fetchDrivers(selectedDate);
    // Skip the refresh while the tab is hidden — a backgrounded map is still a
    // full driver + location fetch every 30s otherwise.
    intervalRef.current = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      fetchDrivers(selectedDate);
    }, 30000);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [fetchDrivers, selectedDate]);

  // Refresh trail when selected driver changes
  useEffect(() => {
    if (selected) fetchTrail(selected.id, selectedDate);
    else setTrail([]);
  }, [selected, selectedDate, fetchTrail]);

  const stats = {
    total: drivers.length,
    active: drivers.filter(d => d.session?.status === "active").length,
    checkedOut: drivers.filter(d => d.session?.status === "checked_out").length,
    offline: drivers.filter(d => !d.session).length,
  };

  const filteredDrivers = drivers.filter(d => {
    if (filter === "active") return d.session?.status === "active";
    if (filter === "offline") return !d.session;
    return true;
  });

  // ── Detail view ──────────────────────────────────────────────────────────────
  if (selected) {
    const sess = selected.session;

    let liveSpeedKmh: number | null = null;
    if (trail.length >= 2) {
      const a = trail[trail.length - 2];
      const b = trail[trail.length - 1];
      const distKm = haversineKm(a.latitude, a.longitude, b.latitude, b.longitude);
      const dtMs = new Date(b.recorded_at).getTime() - new Date(a.recorded_at).getTime();
      if (dtMs > 0) {
        const kmh = distKm / (dtMs / 3600000);
        liveSpeedKmh = kmh > 1 ? kmh : null;
      }
    } else if (selected.latest_location?.speed != null && selected.latest_location.speed > 0.3) {
      liveSpeedKmh = selected.latest_location.speed * 3.6;
    }
    const isMoving = liveSpeedKmh !== null && liveSpeedKmh > 1;

    return (
      <div className="min-h-screen space-y-4">
        {/* Header */}
        <div className="flex items-center gap-3">
          <button
            onClick={() => setSelected(null)}
            className="p-2 rounded-lg text-zinc-600 hover:text-zinc-900 transition-all"
            style={{ background: "rgba(17,17,24,0.05)", border: "1px solid rgba(17,17,24,0.08)", cursor: "pointer" }}
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div className="flex items-center gap-3 flex-1">
            <div className="w-10 h-10 rounded-full bg-gradient-to-br from-sky-500 to-sky-700 flex items-center justify-center shrink-0">
              <span className="text-white font-bold text-sm">{selected.name.split(" ").map(n => n[0]).join("").slice(0, 2).toUpperCase()}</span>
            </div>
            <div>
              <h1 className="text-zinc-900 font-semibold text-base leading-tight">{selected.name}</h1>
              <p className="text-zinc-500 text-xs">{selected.employee_code || selected.phone || selected.email}</p>
            </div>
          </div>
          {isMoving && (
            <div className="flex items-center gap-1.5 px-3 py-1 rounded-full border border-sky-500/30 bg-sky-500/10 animate-pulse">
              <span className="w-1.5 h-1.5 rounded-full bg-sky-400 shrink-0" />
              <span className="text-sky-400 text-xs font-semibold whitespace-nowrap">
                ⚡ {liveSpeedKmh!.toFixed(1)} km/h
              </span>
            </div>
          )}
          <div className={`px-3 py-1 rounded-full text-xs font-medium border ${driverStatusColor(selected)}`}>
            {driverStatusLabel(selected)}
          </div>
          <button
            onClick={() => fetchTrail(selected.id, selectedDate)}
            className="p-2 rounded-lg text-zinc-600 hover:text-zinc-900 hover:bg-black/5 transition-all"
            style={{ background: "none", border: "1px solid rgba(17,17,24,0.08)", cursor: "pointer" }}
          >
            <RefreshCw className={`w-4 h-4 ${trailLoading ? "animate-spin" : ""}`} />
          </button>
        </div>

        {/* Active lot banner */}
        {selected.active_lot && (
          <div className="flex items-center gap-3 rounded-xl border border-sky-500/20 bg-sky-500/5 px-4 py-3">
            <Package className="w-4 h-4 text-sky-400 shrink-0" />
            <div>
              <span className="text-sky-400 font-semibold text-sm">{selected.active_lot.lot_number}</span>
              {selected.active_lot.destination && (
                <span className="text-zinc-500 text-sm ml-2">→ {selected.active_lot.destination}</span>
              )}
            </div>
          </div>
        )}

        {/* Stats row */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { label: "Started", value: fmtTime(sess?.check_in_time || null), icon: Clock, color: "text-emerald-400" },
            { label: "Ended", value: fmtTime(sess?.check_out_time || null), icon: Clock, color: "text-red-400" },
            { label: "Duration", value: fmtDuration(sess?.check_in_time || null, sess?.check_out_time || null), icon: Activity, color: "text-sky-400" },
            { label: "Distance", value: trail.length > 1 ? `${calcTrailDistance(trail).toFixed(2)} km` : sess ? `${sess.total_distance_km.toFixed(2)} km` : "—", icon: Route, color: "text-violet-400" },
          ].map((stat) => (
            <div key={stat.label} className="rounded-xl p-3 border border-black/[0.06] bg-black/[0.02]">
              <div className="flex items-center gap-2 mb-1">
                <stat.icon className={`w-3.5 h-3.5 ${stat.color}`} />
                <span className="text-zinc-500 text-xs">{stat.label}</span>
              </div>
              <div className="text-zinc-900 font-semibold text-base">{stat.value}</div>
            </div>
          ))}
        </div>

        {/* Map */}
        <div className="rounded-xl border border-black/[0.06] bg-black/[0.02] overflow-hidden" style={{ minHeight: 360 }}>
          {trailLoading ? (
            <div className="flex items-center justify-center h-[360px]">
              <RefreshCw className="w-6 h-6 text-sky-400 animate-spin" />
            </div>
          ) : (
            <LeafletTrailMap
              trail={trail}
              salesman={{ id: selected.id, name: selected.name }}
              fallbackLat={selected.latest_location?.latitude ?? 20.5937}
              fallbackLng={selected.latest_location?.longitude ?? 78.9629}
              liveLocation={selected.latest_location ?? null}
              weather={null}
            />
          )}
        </div>

        {/* Timeline */}
        {trail.length > 0 && (
          <div className="rounded-xl border border-black/[0.06] bg-black/[0.02] p-4">
            <h3 className="text-zinc-900 text-sm font-semibold mb-3 flex items-center gap-2">
              <Clock className="w-4 h-4 text-sky-400" />
              Movement Timeline
              <span className="ml-auto text-zinc-500 text-xs font-normal">{trail.length} pings</span>
            </h3>
            <div className="relative space-y-0 max-h-64 overflow-y-auto pr-1">
              {trail.map((log, i, arr) => {
                const isLast = i === arr.length - 1;
                const isFirst = i === 0;
                return (
                  <div key={log.id || i} className="flex items-start gap-3 pb-3 relative">
                    <div className="flex flex-col items-center shrink-0">
                      <div className={`w-2.5 h-2.5 rounded-full mt-1 shrink-0 ${
                        isFirst ? "bg-emerald-400" : isLast ? "bg-sky-400" : "bg-zinc-600"
                      }`} />
                      {i < arr.length - 1 && <div className="w-px bg-zinc-50 mt-1" style={{ height: 24 }} />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs text-zinc-600">{fmtTime(log.recorded_at)}</span>
                        {log.address && (
                          <span className={`text-xs font-medium truncate ${isLast ? "text-sky-300" : "text-zinc-800"}`}>
                            {log.address}
                          </span>
                        )}
                      </div>
                      {log.speed != null && log.speed > 0.5 && (
                        <p className="text-[0.6rem] text-zinc-600 mt-0.5">⚡ {(log.speed * 3.6).toFixed(1)} km/h</p>
                      )}
                    </div>
                    {log.battery_level != null && (
                      <span className="text-[0.6rem] text-zinc-600 shrink-0">🔋{log.battery_level}%</span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    );
  }

  // ── List view ────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="flex-1">
          <div className="flex items-center gap-2.5 mb-0.5">
            <div className="w-8 h-8 rounded-lg bg-sky-500/10 border border-sky-500/20 flex items-center justify-center shrink-0">
              <Truck className="w-4 h-4 text-sky-400" />
            </div>
            <h1 className="text-zinc-900 text-xl font-bold">Van Tracking</h1>
          </div>
          <p className="text-zinc-500 text-sm ml-10">Live driver locations &amp; delivery movement</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-black/[0.04] border border-black/[0.08]">
            <Calendar className="w-4 h-4 text-zinc-600 shrink-0" />
            <input
              type="date"
              value={selectedDate}
              max={new Date().toISOString().split("T")[0]}
              onChange={e => setSelectedDate(e.target.value)}
              className="bg-transparent text-sm text-zinc-900 outline-none"
            />
          </div>
          <button
            onClick={() => fetchDrivers(selectedDate)}
            className="flex items-center gap-2 px-3 py-2 rounded-lg bg-black/[0.04] border border-black/[0.08] text-zinc-600 hover:text-zinc-900 transition-all text-sm"
            style={{ cursor: "pointer" }}
          >
            <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
            <span className="hidden sm:inline">Refresh</span>
          </button>
        </div>
      </div>

      <p className="text-zinc-600 text-xs -mt-2">Auto-refreshes every 30s · Last updated {lastRefresh.toLocaleTimeString()}</p>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: "Total Drivers", value: stats.total, icon: Truck, color: "from-zinc-100 to-zinc-200", dot: "" },
          { label: "On Duty", value: stats.active, icon: Zap, color: "from-sky-600/20 to-sky-700/10", dot: "bg-sky-400" },
          { label: "Duty Ended", value: stats.checkedOut, icon: CheckCircle, color: "from-zinc-100/50 to-zinc-200/30", dot: "bg-zinc-400" },
          { label: "Offline", value: stats.offline, icon: XCircle, color: "from-red-600/10 to-red-700/5", dot: "bg-red-400" },
        ].map(s => (
          <div key={s.label} className={`rounded-xl p-4 bg-gradient-to-br ${s.color} border border-black/[0.06]`}>
            <div className="flex items-center justify-between mb-2">
              <s.icon className="w-4 h-4 text-zinc-600" />
              {s.dot && <span className={`w-2 h-2 rounded-full ${s.dot}`} />}
            </div>
            <div className="text-zinc-900 text-2xl font-bold">{s.value}</div>
            <div className="text-zinc-500 text-xs mt-0.5">{s.label}</div>
          </div>
        ))}
      </div>

      {/* Filter */}
      <div className="flex items-center gap-1 p-1 rounded-lg bg-black/[0.03] border border-black/[0.06] w-fit">
        {(["all", "active", "offline"] as const).map(f => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all ${filter === f ? "bg-sky-500/20 text-sky-400" : "text-zinc-500 hover:text-zinc-900"}`}
            style={{ cursor: "pointer", background: filter === f ? "rgba(14,165,233,0.15)" : "none", border: "none", fontFamily: "inherit" }}
          >
            {f === "all" ? `All (${stats.total})` : f === "active" ? `On Duty (${stats.active})` : `Offline (${stats.offline})`}
          </button>
        ))}
      </div>

      {/* Driver cards */}
      {loading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="rounded-xl border border-black/[0.06] bg-black/[0.02] p-4 animate-pulse">
              <div className="flex items-center gap-3 mb-3">
                <div className="w-10 h-10 rounded-full bg-zinc-100" />
                <div className="flex-1 space-y-2">
                  <div className="h-3 bg-zinc-100 rounded w-2/3" />
                  <div className="h-2 bg-zinc-100 rounded w-1/2" />
                </div>
              </div>
              <div className="h-20 bg-zinc-100 rounded-lg" />
            </div>
          ))}
        </div>
      ) : filteredDrivers.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-zinc-600">
          <Truck className="w-12 h-12 mb-3 opacity-20" />
          <p className="text-sm font-medium">No drivers found for this date</p>
          <p className="text-xs mt-1 text-zinc-500">
            {filter !== "all"
              ? `No ${filter === "active" ? "on-duty" : "offline"} drivers. Try "All" filter.`
              : "Create a DRIVER user and have them start duty from the Driver Duty page."}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredDrivers.map(d => {
            const sess = d.session;
            const loc = d.latest_location;
            const isActive = sess?.status === "active";
            return (
              <button
                key={d.id}
                onClick={() => setSelected(d)}
                className="text-left rounded-xl border border-black/[0.06] hover:border-sky-500/30 bg-black/[0.02] hover:bg-sky-500/[0.02] transition-all p-4 group"
                style={{ cursor: "pointer", fontFamily: "inherit" }}
              >
                {/* Top row */}
                <div className="flex items-start gap-3 mb-3">
                  <div className="relative shrink-0">
                    <div className="w-10 h-10 rounded-full bg-gradient-to-br from-sky-500 to-sky-700 flex items-center justify-center">
                      <span className="text-white font-bold text-sm">{d.name.split(" ").map(n => n[0]).join("").slice(0, 2).toUpperCase()}</span>
                    </div>
                    {isActive && (
                      <span className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full bg-sky-400 border-2 border-white animate-pulse" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-zinc-900 text-sm font-semibold truncate">{d.name}</div>
                    <div className="text-zinc-500 text-xs truncate">{d.employee_code || d.phone || d.email}</div>
                  </div>
                  <span className={`px-2 py-0.5 rounded-full text-[0.6rem] font-medium border shrink-0 ${driverStatusColor(d)}`}>
                    {driverStatusLabel(d)}
                  </span>
                </div>

                {/* Active delivery lot */}
                {d.active_lot && (
                  <div className="mb-2 flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-sky-500/5 border border-sky-500/20">
                    <Package className="w-3 h-3 text-sky-400 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <span className="text-sky-400 font-semibold text-xs">{d.active_lot.lot_number}</span>
                      {d.active_lot.destination && (
                        <span className="text-zinc-500 text-xs ml-1.5 truncate">→ {d.active_lot.destination}</span>
                      )}
                    </div>
                  </div>
                )}

                {/* Session info */}
                {sess ? (
                  <div className="space-y-1.5">
                    <div className="grid grid-cols-3 gap-1 text-center">
                      <div className="rounded-lg bg-black/[0.03] py-1.5 px-1">
                        <div className="text-zinc-900 text-xs font-medium">{fmtTime(sess.check_in_time)}</div>
                        <div className="text-zinc-600 text-[0.6rem]">Started</div>
                      </div>
                      <div className="rounded-lg bg-black/[0.03] py-1.5 px-1">
                        <div className="text-sky-400 text-xs font-medium">{fmtDuration(sess.check_in_time, sess.check_out_time)}</div>
                        <div className="text-zinc-600 text-[0.6rem]">Duration</div>
                      </div>
                      <div className="rounded-lg bg-black/[0.03] py-1.5 px-1">
                        <div className="text-zinc-900 text-xs font-medium">{sess.total_distance_km.toFixed(1)} km</div>
                        <div className="text-zinc-600 text-[0.6rem]">Distance</div>
                      </div>
                    </div>
                    {loc && (
                      <div className="flex items-start gap-2 text-xs text-zinc-500 mt-1">
                        <Navigation className="w-3 h-3 text-sky-400 shrink-0 mt-0.5" />
                        <span className="truncate">{loc.address || `${loc.latitude.toFixed(4)}, ${loc.longitude.toFixed(4)}`}</span>
                        {loc.battery_level != null && (
                          <span className="shrink-0 text-zinc-600">🔋{loc.battery_level}%</span>
                        )}
                      </div>
                    )}
                    {loc && (
                      <div className="text-[0.6rem] text-zinc-600">
                        Last ping: {fmtTime(loc.recorded_at)}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="flex items-center justify-center py-4 text-zinc-600 text-xs gap-2">
                    <AlertCircle className="w-3.5 h-3.5" /> No duty today
                  </div>
                )}

                <div className="mt-3 flex items-center gap-1 text-zinc-600 group-hover:text-sky-400 text-xs transition-colors">
                  <Eye className="w-3 h-3" />
                  <span>View trail &amp; map</span>
                  <TrendingUp className="w-3 h-3 ml-auto" />
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
