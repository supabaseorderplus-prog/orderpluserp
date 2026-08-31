"use client";

import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import {
  BarChart3,
  CalendarRange,
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  MapPinned,
  Navigation,
  RefreshCw,
  Route,
  ShieldCheck,
  Store,
  TrendingUp,
  UserRound,
  XCircle,
} from "lucide-react";

interface SalesmanOption { id: string; name: string }
interface RouteOption { id: string; name: string; code?: string; salesman_id: string | null; stops: number }
interface PartyPerformance {
  stop_id: string;
  party_id: string;
  stop_order: number;
  party_name: string;
  party_code: string | null;
  address: string | null;
  visits: number;
  visit_days: number;
  last_visited_at: string | null;
  visit_rate: number;
  visited: boolean;
}
interface DistanceDay {
  date: string;
  distance_km: number;
  tracked: boolean;
  status: string | null;
  check_in_time: string | null;
  check_out_time: string | null;
}
interface DistanceSummary {
  total_km: number;
  tracked_days: number;
  average_km: number;
  selected_date: string;
  selected_date_km: number;
  selected_date_status: string | null;
  selected_date_check_in: string | null;
  selected_date_check_out: string | null;
  selected_date_source: "verified_gps" | "duty_session";
  selected_date_odometer: {
    start_km: number;
    end_km: number | null;
    distance_km: number | null;
    start_photo_url: string | null;
    end_photo_url: string | null;
  } | null;
  accepted_points: number;
  rejected_points: number;
  truncated: boolean;
  daily: DistanceDay[];
}
interface Analysis {
  period_days: number;
  from_date: string;
  to_date: string;
  route_selected: boolean;
  distance_summary: DistanceSummary;
  route_days: number;
  completed_days: number;
  total_visits: number;
  unique_parties_visited: number;
  completion_rate: number;
  party_performance: PartyPerformance[];
  daily: Array<{ date: string; visits: number; total_stops: number; completion_percent: number; completed: boolean }>;
}

function shortDate(value: string) {
  return new Date(`${value}T00:00:00`).toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
}

function dateTime(value: string | null) {
  if (!value) return "Never";
  return new Date(value).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

function todayInIndia() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function longDate(value: string) {
  return new Date(`${value}T00:00:00`).toLocaleDateString("en-IN", {
    weekday: "short",
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function distance(value: number) {
  return Number(value || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function dutyStatus(value: string | null) {
  if (value === "active") return "On duty";
  if (value === "checked_out" || value === "completed") return "Duty completed";
  return "No duty session";
}

export function TrackingAnalysisPanel({ salesmen }: { salesmen: SalesmanOption[] }) {
  const [salesmanId, setSalesmanId] = useState("");
  const [routeId, setRouteId] = useState("");
  const [routes, setRoutes] = useState<RouteOption[]>([]);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [selectedDate, setSelectedDate] = useState(todayInIndia);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api<{ data: RouteOption[] }>("/api/v1/tracking/routes", { noCache: true, suppressErrorLog: true })
      .then((result) => setRoutes(result.data || []))
      .catch(() => setRoutes([]));
  }, []);

  const salesmanRoutes = useMemo(
    () => routes.filter((route) => route.salesman_id === salesmanId),
    [routes, salesmanId],
  );

  useEffect(() => {
    setRouteId("");
    setAnalysis(null);
    setError("");
    setSelectedDate(todayInIndia());
  }, [salesmanId]);

  useEffect(() => {
    if (!salesmanId) return;
    setLoading(true);
    setError("");
    const routeQuery = routeId ? `&route_id=${encodeURIComponent(routeId)}` : "";
    api<{ data: Analysis }>(`/api/v1/tracking/analysis?salesman_id=${encodeURIComponent(salesmanId)}${routeQuery}&days=30&date=${encodeURIComponent(selectedDate)}`, {
      noCache: true,
      suppressErrorLog: true,
    })
      .then((result) => setAnalysis(result.data))
      .catch((reason) => {
        setAnalysis(null);
        setError(reason instanceof Error ? reason.message : "Could not load this visit report.");
      })
      .finally(() => setLoading(false));
  }, [salesmanId, routeId, selectedDate]);

  const maxDailyDistance = Math.max(
    1,
    ...(analysis?.distance_summary.daily.map((day) => day.distance_km) || [0]),
  );

  return (
    <div className="flex-1 overflow-y-auto bg-zinc-50 px-4 py-5 lg:px-6">
      <div className="mx-auto max-w-7xl space-y-5">
        <section className="overflow-hidden rounded-2xl border border-blue-100 bg-gradient-to-br from-white via-white to-blue-50 shadow-sm">
          <div className="flex flex-col gap-4 p-5 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.14em] text-blue-600">
                <BarChart3 className="h-4 w-4" /> 30-day tracking analysis
              </div>
              <h2 className="mt-2 text-xl font-bold text-zinc-900">Salesman visit report</h2>
              <p className="mt-1 max-w-xl text-sm text-zinc-500">Select a salesman to review verified daily distance. Choose a route as well for party coverage and visit completion.</p>
            </div>

            <div className="grid w-full gap-3 sm:grid-cols-2 lg:w-[600px]">
              <label className="block">
                <span className="mb-1.5 flex items-center gap-1.5 text-[0.68rem] font-bold uppercase tracking-wide text-zinc-500"><UserRound className="h-3.5 w-3.5" /> Salesman</span>
                <div className="relative">
                  <select value={salesmanId} onChange={(event) => setSalesmanId(event.target.value)} className="h-11 w-full appearance-none rounded-xl border border-zinc-200 bg-white px-3 pr-9 text-sm font-semibold text-zinc-800 outline-none focus:border-blue-400">
                    <option value="">Select salesman</option>
                    {salesmen.map((salesman) => <option key={salesman.id} value={salesman.id}>{salesman.name}</option>)}
                  </select>
                  <ChevronDown className="pointer-events-none absolute right-3 top-3.5 h-4 w-4 text-zinc-400" />
                </div>
              </label>
              <label className="block">
                <span className="mb-1.5 flex items-center gap-1.5 text-[0.68rem] font-bold uppercase tracking-wide text-zinc-500"><Route className="h-3.5 w-3.5" /> Route</span>
                <div className="relative">
                  <select disabled={!salesmanId} value={routeId} onChange={(event) => setRouteId(event.target.value)} className="h-11 w-full appearance-none rounded-xl border border-zinc-200 bg-white px-3 pr-9 text-sm font-semibold text-zinc-800 outline-none disabled:cursor-not-allowed disabled:bg-zinc-100 disabled:text-zinc-400 focus:border-blue-400">
                    <option value="">{!salesmanId ? "Select salesman first" : salesmanRoutes.length ? "Select route" : "No route assigned"}</option>
                    {salesmanRoutes.map((route) => <option key={route.id} value={route.id}>{route.name} · {route.stops} stops</option>)}
                  </select>
                  <ChevronDown className="pointer-events-none absolute right-3 top-3.5 h-4 w-4 text-zinc-400" />
                </div>
              </label>
            </div>
          </div>
        </section>

        {loading && (
          <div className="flex min-h-64 items-center justify-center rounded-2xl border border-zinc-200 bg-white">
            <RefreshCw className="h-6 w-6 animate-spin text-blue-600" />
          </div>
        )}

        {error && <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm font-medium text-red-700">{error}</div>}

        {!loading && analysis && (
          <>
            <section className="overflow-hidden rounded-2xl bg-zinc-950 text-white shadow-xl shadow-zinc-300/40">
              <div className="grid lg:grid-cols-[1fr_1.15fr]">
                <div className="relative overflow-hidden border-b border-white/10 p-5 sm:p-6 lg:border-b-0 lg:border-r">
                  <div className="absolute -right-16 -top-20 h-56 w-56 rounded-full bg-blue-500/20 blur-3xl" />
                  <div className="relative">
                    <div className="flex items-center gap-2 text-[0.68rem] font-bold uppercase tracking-[0.16em] text-blue-300">
                      <Navigation className="h-4 w-4" /> Verified distance · past 30 days
                    </div>
                    <div className="mt-4 flex items-end gap-2">
                      <span className="text-4xl font-black tracking-tight sm:text-5xl">{distance(analysis.distance_summary.total_km)}</span>
                      <span className="mb-1 text-sm font-bold uppercase tracking-wider text-zinc-400">km</span>
                    </div>
                    <div className="mt-5 grid grid-cols-2 gap-3">
                      <div className="rounded-xl border border-white/10 bg-white/[0.06] p-3">
                        <div className="text-xl font-bold">{analysis.distance_summary.tracked_days}</div>
                        <div className="mt-0.5 text-[0.65rem] font-semibold uppercase tracking-wide text-zinc-400">Duty days tracked</div>
                      </div>
                      <div className="rounded-xl border border-white/10 bg-white/[0.06] p-3">
                        <div className="text-xl font-bold">{distance(analysis.distance_summary.average_km)} km</div>
                        <div className="mt-0.5 text-[0.65rem] font-semibold uppercase tracking-wide text-zinc-400">Average per duty day</div>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="bg-gradient-to-br from-zinc-900 to-zinc-950 p-5 sm:p-6">
                  <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <div className="flex items-center gap-2 text-[0.68rem] font-bold uppercase tracking-[0.14em] text-emerald-300">
                        <ShieldCheck className="h-4 w-4" /> Selected day · verified GPS
                      </div>
                      <div className="mt-3 flex items-end gap-2">
                        <span className="text-3xl font-black tracking-tight">{distance(analysis.distance_summary.selected_date_km)}</span>
                        <span className="mb-1 text-xs font-bold uppercase tracking-wide text-zinc-400">km clocked</span>
                      </div>
                      <p className="mt-1 text-sm text-zinc-400">{longDate(analysis.distance_summary.selected_date)}</p>
                    </div>
                    <label className="block rounded-xl border border-white/10 bg-white/[0.06] p-2.5">
                      <span className="mb-1 flex items-center gap-1.5 text-[0.62rem] font-bold uppercase tracking-wide text-zinc-400"><CalendarRange className="h-3.5 w-3.5" /> Choose date</span>
                      <input
                        type="date"
                        min={analysis.from_date}
                        max={analysis.to_date}
                        value={selectedDate}
                        onChange={(event) => setSelectedDate(event.target.value)}
                        className="h-9 rounded-lg border border-white/10 bg-zinc-800 px-2.5 text-sm font-semibold text-white outline-none focus:border-blue-400"
                      />
                    </label>
                  </div>
                  <div className="mt-5 flex flex-wrap gap-2 text-[0.68rem] font-semibold">
                    <span className="rounded-full bg-emerald-400/10 px-2.5 py-1 text-emerald-300">{analysis.distance_summary.accepted_points} verified points</span>
                    {analysis.distance_summary.rejected_points > 0 && <span className="rounded-full bg-amber-400/10 px-2.5 py-1 text-amber-300">{analysis.distance_summary.rejected_points} noisy points removed</span>}
                    <span className="rounded-full bg-white/[0.07] px-2.5 py-1 text-zinc-300">{dutyStatus(analysis.distance_summary.selected_date_status)}</span>
                  </div>
                  {analysis.distance_summary.selected_date_odometer && (
                    <div className="mt-5 grid grid-cols-2 gap-3">
                      {([
                        {
                          label: "Start odometer",
                          km: analysis.distance_summary.selected_date_odometer.start_km,
                          url: analysis.distance_summary.selected_date_odometer.start_photo_url,
                        },
                        {
                          label: "End odometer",
                          km: analysis.distance_summary.selected_date_odometer.end_km,
                          url: analysis.distance_summary.selected_date_odometer.end_photo_url,
                        },
                      ] as const).map((item) => (
                        <div key={item.label} className="overflow-hidden rounded-xl border border-white/10 bg-white/[0.06]">
                          {item.url ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={item.url} alt={`${item.label} evidence`} className="h-28 w-full bg-black object-cover" />
                          ) : <div className="flex h-28 items-center justify-center bg-black/30 text-xs font-semibold text-zinc-500">{item.km == null ? "Not captured yet" : "Photo unavailable"}</div>}
                          <div className="p-3"><div className="text-[0.62rem] font-bold uppercase tracking-wide text-zinc-500">{item.label}</div><div className="mt-1 text-lg font-black tabular-nums text-white">{item.km == null ? "Pending" : `${Number(item.km).toLocaleString("en-IN")} km`}</div></div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              <div className="border-t border-white/10 bg-white/[0.035] px-4 py-4 sm:px-6">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2 text-xs font-bold text-zinc-200"><TrendingUp className="h-4 w-4 text-blue-300" /> Daily distance</div>
                  <div className="text-[0.65rem] text-zinc-500">Click any day to inspect it</div>
                </div>
                <div className="overflow-x-auto pb-1">
                  <div className="flex h-28 min-w-[820px] items-end gap-1.5">
                    {analysis.distance_summary.daily.map((day) => {
                      const isSelected = day.date === analysis.distance_summary.selected_date;
                      const barHeight = day.distance_km > 0
                        ? Math.max(8, Math.round((day.distance_km / maxDailyDistance) * 72))
                        : 3;
                      return (
                        <button
                          type="button"
                          key={day.date}
                          onClick={() => setSelectedDate(day.date)}
                          className={`group flex h-full min-w-5 flex-1 flex-col items-center justify-end rounded-md px-0.5 pb-1 transition ${isSelected ? "bg-blue-500/15" : "hover:bg-white/[0.06]"}`}
                          aria-label={`${longDate(day.date)}: ${distance(day.distance_km)} km`}
                          title={`${shortDate(day.date)} · ${distance(day.distance_km)} km`}
                        >
                          {isSelected && <span className="mb-1 text-[0.58rem] font-bold text-blue-300">{distance(day.distance_km)}</span>}
                          <span className={`w-full max-w-4 rounded-t-sm transition-all ${isSelected ? "bg-blue-400" : day.distance_km > 0 ? "bg-emerald-400/70 group-hover:bg-emerald-300" : "bg-zinc-700"}`} style={{ height: barHeight }} />
                          <span className={`mt-1 text-[0.52rem] ${isSelected ? "font-bold text-blue-300" : "text-zinc-600"}`}>{day.date.slice(8)}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            </section>

            {analysis.route_selected ? <>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {[
                { label: "Route days", value: analysis.route_days, detail: `${analysis.completed_days} completed`, icon: CalendarDays, iconClass: "bg-blue-50 text-blue-600" },
                { label: "Party visits", value: analysis.total_visits, detail: `${analysis.unique_parties_visited} unique parties`, icon: Store, iconClass: "bg-emerald-50 text-emerald-600" },
                { label: "Completion", value: `${analysis.completion_rate}%`, detail: "Across all route days", icon: CheckCircle2, iconClass: "bg-amber-50 text-amber-600" },
                { label: "Parties covered", value: `${analysis.party_performance.filter((party) => party.visited).length}/${analysis.party_performance.length}`, detail: "Visited at least once", icon: MapPinned, iconClass: "bg-violet-50 text-violet-600" },
              ].map((card) => (
                <div key={card.label} className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm">
                  <div className={`flex h-9 w-9 items-center justify-center rounded-xl ${card.iconClass}`}><card.icon className="h-4 w-4" /></div>
                  <div className="mt-3 text-2xl font-bold text-zinc-900">{card.value}</div>
                  <div className="mt-1 text-xs font-bold uppercase tracking-wide text-zinc-500">{card.label}</div>
                  <div className="mt-1 text-xs text-zinc-400">{card.detail}</div>
                </div>
              ))}
            </div>

            <div className="grid gap-5 xl:grid-cols-[0.9fr_1.5fr]">
              <section className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="font-bold text-zinc-900">Recent route days</h3>
                    <p className="text-xs text-zinc-500">Visit completion for the last 30 days</p>
                  </div>
                  <span className="rounded-full bg-blue-50 px-2.5 py-1 text-xs font-bold text-blue-600">{analysis.daily.length} days</span>
                </div>
                <div className="mt-5 space-y-3">
                  {analysis.daily.length === 0 ? <p className="py-10 text-center text-sm text-zinc-400">No route history in this period.</p> : analysis.daily.slice(0, 10).map((day) => (
                    <div key={day.date}>
                      <div className="mb-1.5 flex items-center justify-between text-xs">
                        <span className="font-semibold text-zinc-700">{shortDate(day.date)}</span>
                        <span className="text-zinc-500">{day.visits}/{day.total_stops} visits · <b className="text-zinc-700">{day.completion_percent}%</b></span>
                      </div>
                      <div className="h-2 overflow-hidden rounded-full bg-zinc-100"><div className={`h-full rounded-full ${day.completed ? "bg-emerald-500" : "bg-blue-500"}`} style={{ width: `${day.completion_percent}%` }} /></div>
                    </div>
                  ))}
                </div>
              </section>

              <section className="overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-sm">
                <div className="border-b border-zinc-100 px-5 py-4">
                  <h3 className="font-bold text-zinc-900">Party visit performance</h3>
                  <p className="text-xs text-zinc-500">Coverage and repeat-visit frequency by stop</p>
                </div>
                <div className="max-h-[520px] overflow-auto">
                  <table className="w-full min-w-[700px] text-left">
                    <thead className="sticky top-0 bg-zinc-50 text-[0.65rem] uppercase tracking-wide text-zinc-500"><tr><th className="px-5 py-3">Party</th><th className="px-4 py-3">Status</th><th className="px-4 py-3">Visits</th><th className="px-4 py-3">Route-day rate</th><th className="px-5 py-3">Last visit</th></tr></thead>
                    <tbody className="divide-y divide-zinc-100">
                      {analysis.party_performance.map((party) => (
                        <tr key={party.stop_id} className="hover:bg-zinc-50/70">
                          <td className="px-5 py-3"><div className="flex items-center gap-3"><span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-50 text-xs font-bold text-blue-600">{party.stop_order}</span><div><div className="text-sm font-semibold text-zinc-900">{party.party_name}</div><div className="max-w-[250px] truncate text-xs text-zinc-400">{party.address || party.party_code || "No address"}</div></div></div></td>
                          <td className="px-4 py-3">{party.visited ? <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-bold text-emerald-700"><CheckCircle2 className="h-3.5 w-3.5" /> Visited</span> : <span className="inline-flex items-center gap-1 rounded-full bg-red-50 px-2.5 py-1 text-xs font-bold text-red-600"><XCircle className="h-3.5 w-3.5" /> Not visited</span>}</td>
                          <td className="px-4 py-3 text-sm font-bold text-zinc-800">{party.visits}<span className="ml-1 text-xs font-normal text-zinc-400">({party.visit_days} days)</span></td>
                          <td className="px-4 py-3"><div className="flex items-center gap-2"><div className="h-1.5 w-16 overflow-hidden rounded-full bg-zinc-100"><div className="h-full rounded-full bg-blue-500" style={{ width: `${party.visit_rate}%` }} /></div><span className="text-xs font-semibold text-zinc-600">{party.visit_rate}%</span></div></td>
                          <td className="px-5 py-3 text-xs text-zinc-500">{dateTime(party.last_visited_at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            </div>
            </> : (
              <div className="flex min-h-40 flex-col items-center justify-center rounded-2xl border border-dashed border-blue-200 bg-blue-50/50 px-5 text-center">
                <Route className="h-8 w-8 text-blue-300" />
                <h3 className="mt-2 font-bold text-zinc-800">Select a route for visit analysis</h3>
                <p className="mt-1 max-w-md text-sm text-zinc-500">The distance report above covers this salesman across all duty routes. Selecting a route adds party visits, coverage and completion history.</p>
              </div>
            )}
          </>
        )}

        {!loading && !analysis && !error && (
          <div className="flex min-h-72 flex-col items-center justify-center rounded-2xl border border-dashed border-zinc-300 bg-white text-center">
            <MapPinned className="h-10 w-10 text-zinc-300" />
            <h3 className="mt-3 font-bold text-zinc-700">Choose a salesman</h3>
            <p className="mt-1 text-sm text-zinc-400">Their verified 30-day distance and daily calendar will appear here.</p>
          </div>
        )}
      </div>
    </div>
  );
}
