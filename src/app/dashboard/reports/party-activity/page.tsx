"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import {
  Activity,
  ArrowLeft,
  Download,
  Gauge,
  IndianRupee,
  Layers,
  Loader2,
  RefreshCw,
  Search,
  Users,
} from "lucide-react";

const s: React.CSSProperties = {
  transform: "none",
  filter: "none",
  WebkitTextStroke: "0",
  background: "none",
  boxShadow: "none",
  display: "block",
  padding: 0,
};

type ActivityTier = "ACTIVE" | "SLOWING" | "AT_RISK" | "CRITICAL" | "DORMANT";

interface PartyActivityRow {
  id: string;
  name: string;
  code: string | null;
  type: string | null;
  groupId: string | null;
  groupName: string | null;
  salesmanId: string | null;
  salesmanName: string | null;
  lastOrderDate: string | null;
  lastPaymentDate: string | null;
  lastActivityDate: string | null;
  daysSinceActivity: number | null;
  orderCount28d: number;
  orderValue28d: number;
  paymentCount28d: number;
  paymentValue28d: number;
  activityPct: number;
  tier: ActivityTier;
}

interface PartyActivityReport {
  generatedAt: string;
  windowDays: number;
  rows: PartyActivityRow[];
  summary: {
    totalParties: number;
    activeParties: number;
    dormantParties: number;
    avgActivityPct: number;
    orderCount28d: number;
    orderValue28d: number;
    paymentValue28d: number;
    byTier: Record<ActivityTier, number>;
  };
}

const TIER_META: Record<ActivityTier, { label: string; badge: string; bar: string; dot: string }> = {
  ACTIVE: { label: "Active", badge: "bg-emerald-500/10 text-emerald-600", bar: "bg-emerald-500", dot: "bg-emerald-500" },
  SLOWING: { label: "Slowing", badge: "bg-lime-500/10 text-lime-600", bar: "bg-lime-500", dot: "bg-lime-500" },
  AT_RISK: { label: "At Risk", badge: "bg-amber-500/10 text-amber-600", bar: "bg-amber-500", dot: "bg-amber-500" },
  CRITICAL: { label: "Critical", badge: "bg-orange-500/10 text-orange-600", bar: "bg-orange-500", dot: "bg-orange-500" },
  DORMANT: { label: "Dormant", badge: "bg-red-500/10 text-red-600", bar: "bg-red-400", dot: "bg-red-400" },
};

const TIER_FILTERS: ("ALL" | ActivityTier)[] = ["ALL", "ACTIVE", "SLOWING", "AT_RISK", "CRITICAL", "DORMANT"];

function formatCurrency(amount: number): string {
  if (amount >= 10000000) return `₹${(amount / 10000000).toFixed(2)} Cr`;
  if (amount >= 100000) return `₹${(amount / 100000).toFixed(2)} L`;
  if (amount >= 1000) return `₹${(amount / 1000).toFixed(1)}K`;
  return `₹${Math.round(amount)}`;
}

function relativeTime(iso: string | null): string {
  if (!iso) return "Never";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "Never";
  const days = Math.floor((Date.now() - t) / 86400000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

export default function PartyActivityReportPage() {
  const [report, setReport] = useState<PartyActivityReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [tier, setTier] = useState<"ALL" | ActivityTier>("ALL");
  const [typeFilter, setTypeFilter] = useState<string>("ALL");
  const [groupFilter, setGroupFilter] = useState<string>("ALL");

  async function load(isRefresh = false) {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const res = await api<{ data: PartyActivityReport }>("/api/v1/reports/party-activity");
      setReport(res.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load report");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  const partyTypes = useMemo(() => {
    const set = new Set<string>();
    for (const r of report?.rows || []) if (r.type) set.add(r.type);
    return [...set].sort();
  }, [report]);

  // Group filter options: real group names plus an explicit "Ungrouped" bucket.
  const groupOptions = useMemo(() => {
    const set = new Set<string>();
    let hasUngrouped = false;
    for (const r of report?.rows || []) {
      if (r.groupName) set.add(r.groupName);
      else hasUngrouped = true;
    }
    return { names: [...set].sort(), hasUngrouped };
  }, [report]);

  const filtered = useMemo(() => {
    const rows = report?.rows || [];
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (tier !== "ALL" && r.tier !== tier) return false;
      if (typeFilter !== "ALL" && r.type !== typeFilter) return false;
      if (groupFilter === "__UNGROUPED__" && r.groupName) return false;
      if (groupFilter !== "ALL" && groupFilter !== "__UNGROUPED__" && r.groupName !== groupFilter) return false;
      if (q && !(`${r.name} ${r.code ?? ""} ${r.groupName ?? ""} ${r.salesmanName ?? ""}`.toLowerCase().includes(q)))
        return false;
      return true;
    });
  }, [report, search, tier, typeFilter, groupFilter]);

  function exportCsv() {
    const rows = filtered;
    if (rows.length === 0) return;
    const header = [
      "Party",
      "Code",
      "Type",
      "Group",
      "Group Salesman",
      "Status",
      "Activity %",
      "Last Activity",
      "Days Since",
      "Orders (28d)",
      "Order Value (28d)",
      "Payments (28d)",
      "Collected (28d)",
    ];
    const escape = (v: string) => `"${v.replace(/"/g, '""')}"`;
    const lines = rows.map((r) =>
      [
        escape(r.name),
        escape(r.code ?? ""),
        escape(r.type ?? ""),
        escape(r.groupName ?? "Ungrouped"),
        escape(r.salesmanName ?? ""),
        escape(TIER_META[r.tier].label),
        r.activityPct,
        escape(r.lastActivityDate ? new Date(r.lastActivityDate).toLocaleDateString("en-IN") : "Never"),
        r.daysSinceActivity ?? "",
        r.orderCount28d,
        r.orderValue28d,
        r.paymentCount28d,
        r.paymentValue28d,
      ].join(","),
    );
    const csv = [header.join(","), ...lines].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `party-activity-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const summary = report?.summary;

  const kpis = summary
    ? [
        { label: "Parties", value: String(summary.totalParties), icon: Users, color: "text-zinc-700", bg: "bg-zinc-500/10" },
        { label: "Active (7d)", value: String(summary.activeParties), icon: Activity, color: "text-emerald-600", bg: "bg-emerald-500/10" },
        { label: "Dormant", value: String(summary.dormantParties), icon: Activity, color: "text-red-600", bg: "bg-red-500/10" },
        { label: "Avg Activity", value: `${summary.avgActivityPct}%`, icon: Gauge, color: "text-amber-600", bg: "bg-amber-500/10" },
        { label: "Orders (28d)", value: formatCurrency(summary.orderValue28d), icon: IndianRupee, color: "text-blue-600", bg: "bg-blue-500/10" },
        { label: "Collected (28d)", value: formatCurrency(summary.paymentValue28d), icon: IndianRupee, color: "text-teal-600", bg: "bg-teal-500/10" },
      ]
    : [];

  return (
    <div style={{ fontFamily: "'Inter','system-ui',sans-serif" }}>
      {/* Header */}
      <div className="flex items-start justify-between gap-3 mb-5">
        <div className="min-w-0">
          <Link
            href="/dashboard/reports"
            className="inline-flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-800 transition-colors mb-1.5"
            style={{ fontSize: "0.72rem" }}
          >
            <ArrowLeft className="w-3.5 h-3.5" /> Reports
          </Link>
          <h1 className="text-2xl font-bold text-zinc-900" style={{ ...s, fontSize: "1.4rem" }}>
            Party Activity & Order Report
          </h1>
          <p className="text-sm text-zinc-500 mt-1" style={{ ...s, fontSize: "0.8rem", marginTop: "0.2rem" }}>
            Engagement scored over a rolling {report?.windowDays ?? 28}-day window — orders placed and payments collected.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => load(true)}
            disabled={refreshing}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium text-zinc-600 hover:text-zinc-900 hover:bg-black/5 transition-all disabled:opacity-50"
            style={{ background: "none", border: "1px solid rgba(0,0,0,0.08)", cursor: "pointer" }}
          >
            <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? "animate-spin" : ""}`} />
            <span className="hidden sm:inline">Refresh</span>
          </button>
          <button
            onClick={exportCsv}
            disabled={filtered.length === 0}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold text-amber-700 transition-all disabled:opacity-40"
            style={{ background: "rgba(245,158,11,0.12)", border: "1px solid rgba(245,158,11,0.3)", cursor: "pointer" }}
          >
            <Download className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Export CSV</span>
          </button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-24">
          <Loader2 className="w-8 h-8 text-amber-500 animate-spin" />
        </div>
      ) : error ? (
        <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-6 text-center">
          <p className="text-sm text-red-600">{error}</p>
          <button
            onClick={() => load()}
            className="mt-3 text-xs font-medium text-zinc-700 underline"
            style={{ background: "none", border: "none", cursor: "pointer" }}
          >
            Try again
          </button>
        </div>
      ) : (
        <>
          {/* KPI row */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-6">
            {kpis.map((kpi) => {
              const Icon = kpi.icon;
              return (
                <div key={kpi.label} className="rounded-xl border border-black/[0.06] bg-black/[0.02] p-3.5">
                  <div className={`w-8 h-8 rounded-lg ${kpi.bg} flex items-center justify-center mb-2`}>
                    <Icon className={`w-4 h-4 ${kpi.color}`} />
                  </div>
                  <div className="text-lg font-bold text-zinc-900 tabular-nums" style={{ ...s, fontSize: "1.05rem" }}>
                    {kpi.value}
                  </div>
                  <div className="text-zinc-500" style={{ ...s, fontSize: "0.65rem", marginTop: "0.1rem" }}>
                    {kpi.label}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Filters */}
          <div className="flex flex-col sm:flex-row sm:items-center gap-3 mb-4">
            <div className="relative flex-1 min-w-0">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-400" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search party name or code…"
                className="w-full pl-9 pr-3 py-2 rounded-lg text-sm text-zinc-900 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-amber-500/30"
                style={{ background: "rgba(0,0,0,0.03)", border: "1px solid rgba(0,0,0,0.08)" }}
              />
            </div>
            {partyTypes.length > 0 && (
              <select
                value={typeFilter}
                onChange={(e) => setTypeFilter(e.target.value)}
                className="px-3 py-2 rounded-lg text-sm text-zinc-700 focus:outline-none focus:ring-2 focus:ring-amber-500/30"
                style={{ background: "rgba(0,0,0,0.03)", border: "1px solid rgba(0,0,0,0.08)" }}
              >
                <option value="ALL">All types</option>
                {partyTypes.map((t) => (
                  <option key={t} value={t}>
                    {t.replace(/_/g, " ")}
                  </option>
                ))}
              </select>
            )}
            {(groupOptions.names.length > 0 || groupOptions.hasUngrouped) && (
              <select
                value={groupFilter}
                onChange={(e) => setGroupFilter(e.target.value)}
                className="px-3 py-2 rounded-lg text-sm text-zinc-700 focus:outline-none focus:ring-2 focus:ring-amber-500/30"
                style={{ background: "rgba(0,0,0,0.03)", border: "1px solid rgba(0,0,0,0.08)" }}
              >
                <option value="ALL">All groups</option>
                {groupOptions.names.map((g) => (
                  <option key={g} value={g}>
                    {g}
                  </option>
                ))}
                {groupOptions.hasUngrouped && <option value="__UNGROUPED__">Ungrouped</option>}
              </select>
            )}
          </div>

          {/* Tier chips */}
          <div className="flex flex-wrap gap-2 mb-5">
            {TIER_FILTERS.map((t) => {
              const count =
                t === "ALL" ? report?.summary.totalParties ?? 0 : report?.summary.byTier[t] ?? 0;
              const isActive = tier === t;
              const meta = t === "ALL" ? null : TIER_META[t];
              return (
                <button
                  key={t}
                  onClick={() => setTier(t)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-all ${
                    isActive ? "bg-zinc-900 text-white" : "bg-black/[0.04] text-zinc-600 hover:bg-black/[0.07]"
                  }`}
                  style={{ border: "none", cursor: "pointer" }}
                >
                  {meta && <span className={`w-2 h-2 rounded-full ${meta.dot}`} />}
                  <span>{t === "ALL" ? "All" : meta!.label}</span>
                  <span className={isActive ? "text-white/70" : "text-zinc-400"}>{count}</span>
                </button>
              );
            })}
          </div>

          {/* Results */}
          {filtered.length === 0 ? (
            <div className="rounded-xl border border-black/[0.06] bg-black/[0.02] p-12 text-center">
              <p className="text-sm text-zinc-500">No parties match the current filters.</p>
            </div>
          ) : (
            <>
              {/* Desktop table */}
              <div className="hidden lg:block rounded-xl border border-black/[0.06] bg-black/[0.02] overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-black/[0.06] text-left">
                      <th className="px-4 py-3 font-semibold text-zinc-500 text-xs uppercase tracking-wide">Party</th>
                      <th className="px-4 py-3 font-semibold text-zinc-500 text-xs uppercase tracking-wide">Group / Salesman</th>
                      <th className="px-4 py-3 font-semibold text-zinc-500 text-xs uppercase tracking-wide w-[20%]">Activity</th>
                      <th className="px-4 py-3 font-semibold text-zinc-500 text-xs uppercase tracking-wide">Last seen</th>
                      <th className="px-4 py-3 font-semibold text-zinc-500 text-xs uppercase tracking-wide text-right">Orders (28d)</th>
                      <th className="px-4 py-3 font-semibold text-zinc-500 text-xs uppercase tracking-wide text-right">Collected (28d)</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-black/[0.04]">
                    {filtered.map((r) => {
                      const meta = TIER_META[r.tier];
                      return (
                        <tr key={r.id} className="hover:bg-black/[0.02] transition-colors">
                          <td className="px-4 py-3">
                            <div className="font-medium text-zinc-900">{r.name}</div>
                            <div className="text-xs text-zinc-400 mt-0.5">
                              {r.code || "—"}
                              {r.type ? ` · ${r.type.replace(/_/g, " ")}` : ""}
                            </div>
                          </td>
                          <td className="px-4 py-3">
                            {r.groupName ? (
                              <>
                                <div className="flex items-center gap-1.5 text-zinc-800">
                                  <Layers className="w-3.5 h-3.5 text-zinc-400 shrink-0" />
                                  <span className="font-medium truncate max-w-[160px]">{r.groupName}</span>
                                </div>
                                <div className="text-xs text-zinc-400 mt-0.5 pl-5 truncate max-w-[160px]">
                                  {r.salesmanName || "No salesman"}
                                </div>
                              </>
                            ) : (
                              <span className="text-xs text-zinc-400">Ungrouped</span>
                            )}
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-2">
                              <div className="flex-1 h-1.5 rounded-full bg-black/[0.06] overflow-hidden">
                                <div className={`h-full rounded-full ${meta.bar}`} style={{ width: `${r.activityPct}%` }} />
                              </div>
                              <span className="text-xs font-semibold text-zinc-700 tabular-nums w-9 text-right">{r.activityPct}%</span>
                              <span className={`px-2 py-0.5 rounded-full text-[0.6rem] font-bold ${meta.badge}`}>{meta.label}</span>
                            </div>
                          </td>
                          <td className="px-4 py-3 text-zinc-600">{relativeTime(r.lastActivityDate)}</td>
                          <td className="px-4 py-3 text-right">
                            <div className="font-medium text-zinc-900 tabular-nums">{formatCurrency(r.orderValue28d)}</div>
                            <div className="text-xs text-zinc-400">{r.orderCount28d} orders</div>
                          </td>
                          <td className="px-4 py-3 text-right">
                            <div className="font-medium text-zinc-900 tabular-nums">{formatCurrency(r.paymentValue28d)}</div>
                            <div className="text-xs text-zinc-400">{r.paymentCount28d} payments</div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Mobile cards */}
              <div className="lg:hidden space-y-2.5">
                {filtered.map((r) => {
                  const meta = TIER_META[r.tier];
                  return (
                    <div key={r.id} className="rounded-xl border border-black/[0.06] bg-black/[0.02] p-3.5">
                      <div className="flex items-start justify-between gap-2 mb-2.5">
                        <div className="min-w-0">
                          <div className="font-medium text-zinc-900 truncate" style={{ fontSize: "0.88rem" }}>
                            {r.name}
                          </div>
                          <div className="text-xs text-zinc-400 mt-0.5">
                            {r.code || "—"}
                            {r.type ? ` · ${r.type.replace(/_/g, " ")}` : ""}
                          </div>
                        </div>
                        <span className={`px-2 py-0.5 rounded-full text-[0.6rem] font-bold shrink-0 ${meta.badge}`}>{meta.label}</span>
                      </div>
                      <div className="flex items-center gap-1.5 mb-2.5 text-xs text-zinc-500">
                        <Layers className="w-3.5 h-3.5 text-zinc-400 shrink-0" />
                        {r.groupName ? (
                          <span className="truncate">
                            <span className="text-zinc-700 font-medium">{r.groupName}</span>
                            <span className="text-zinc-400"> · {r.salesmanName || "No salesman"}</span>
                          </span>
                        ) : (
                          <span className="text-zinc-400">Ungrouped</span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 mb-3">
                        <div className="flex-1 h-1.5 rounded-full bg-black/[0.06] overflow-hidden">
                          <div className={`h-full rounded-full ${meta.bar}`} style={{ width: `${r.activityPct}%` }} />
                        </div>
                        <span className="text-xs font-semibold text-zinc-700 tabular-nums">{r.activityPct}%</span>
                        <span className="text-[0.65rem] text-zinc-400">{relativeTime(r.lastActivityDate)}</span>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <div className="rounded-lg bg-black/[0.03] px-2.5 py-1.5">
                          <div className="text-[0.6rem] text-zinc-400 uppercase tracking-wide">Orders 28d</div>
                          <div className="text-sm font-semibold text-zinc-900 tabular-nums">
                            {formatCurrency(r.orderValue28d)}
                            <span className="text-[0.6rem] font-normal text-zinc-400 ml-1">{r.orderCount28d}</span>
                          </div>
                        </div>
                        <div className="rounded-lg bg-black/[0.03] px-2.5 py-1.5">
                          <div className="text-[0.6rem] text-zinc-400 uppercase tracking-wide">Collected 28d</div>
                          <div className="text-sm font-semibold text-zinc-900 tabular-nums">
                            {formatCurrency(r.paymentValue28d)}
                            <span className="text-[0.6rem] font-normal text-zinc-400 ml-1">{r.paymentCount28d}</span>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              <p className="text-xs text-zinc-400 mt-4 text-center" style={{ fontSize: "0.68rem" }}>
                Showing {filtered.length} of {report?.summary.totalParties ?? 0} parties · 100% = active within 7 days,
                falling 25% every 7 days without an order or payment.
              </p>
            </>
          )}
        </>
      )}
    </div>
  );
}
