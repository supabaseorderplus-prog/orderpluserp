"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { api } from "@/lib/api";
import { formatIstDate, formatIstTime } from "@/lib/datetime";
import {
  downloadWalletStatementPdf,
  type StatementRow,
  type StatementMeta,
} from "@/lib/wallet-statement-pdf";
import {
  PRESETS,
  rangeForPreset,
  TX_FILTERS,
  isTransferRow,
  matchesTxFilter,
  type PresetKey,
  type TxFilterKey,
} from "@/lib/wallet-statement-view";
import {
  ArrowLeft,
  ArrowDownLeft,
  ArrowUpRight,
  CalendarRange,
  Download,
  Filter,
  Inbox,
  Loader2,
  ShieldCheck,
  TrendingDown,
  TrendingUp,
  Wallet,
} from "lucide-react";

const ROLE_LABELS: Record<string, string> = {
  SUPER_ADMIN: "Super Admin",
  ADMIN: "Admin",
  ACCOUNTS_MANAGER: "Financier / Accountant",
  SALES_MANAGER: "Sales Manager",
  TERRITORY_MANAGER: "Territory Manager",
  SALESMAN: "Salesman",
};
const roleLabel = (r: string) => ROLE_LABELS[r] || (r ? r.replace(/_/g, " ") : "");

const fmt = (n: number) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(n || 0);
const fmt2 = (n: number) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n || 0);

const initials = (name: string) =>
  (name || "?").trim().split(/\s+/).slice(0, 2).map((p) => p.charAt(0).toUpperCase()).join("") || "?";

interface HistoryResponse {
  success: boolean;
  data: StatementRow[];
  meta: StatementMeta | null;
  message?: string;
}

export default function ExpandedWalletStatementPage() {
  const params = useParams<{ userId: string }>();
  const searchParams = useSearchParams();
  const userId = params.userId;

  const queryName = searchParams.get("name") || "User";
  const queryRole = searchParams.get("role") || "";
  const queryBal = searchParams.get("bal");
  const currentBalance = queryBal != null && queryBal !== "" ? Number(queryBal) : null;

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [rows, setRows] = useState<StatementRow[]>([]);
  const [meta, setMeta] = useState<StatementMeta | null>(null);
  const [downloading, setDownloading] = useState(false);

  // Initialise the filters from the query so an "Expand" click lands on the exact
  // same view the drawer was showing.
  const initialFrom = searchParams.get("from") || "";
  const initialTo = searchParams.get("to") || "";
  const [preset, setPreset] = useState<PresetKey>(initialFrom || initialTo ? "custom" : "all");
  const [customFrom, setCustomFrom] = useState(initialFrom);
  const [customTo, setCustomTo] = useState(initialTo);
  const [txFilter, setTxFilter] = useState<TxFilterKey>((searchParams.get("txf") as TxFilterKey) || "all");

  const activeRange = useMemo(() => {
    if (preset === "custom") return { from: customFrom || null, to: customTo || null };
    return rangeForPreset(preset);
  }, [preset, customFrom, customTo]);

  const load = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    setError("");
    try {
      const qs = new URLSearchParams({ user_id: userId });
      if (activeRange.from) qs.set("from", activeRange.from);
      if (activeRange.to) qs.set("to", activeRange.to);
      const res = await api<HistoryResponse>(`/api/v1/wallets/history?${qs.toString()}`);
      setRows(res.data || []);
      setMeta(res.meta || null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load wallet history");
      setRows([]);
      setMeta(null);
    } finally {
      setLoading(false);
    }
  }, [userId, activeRange.from, activeRange.to]);

  useEffect(() => {
    if (userId) load();
  }, [userId, load]);

  const visibleRows = useMemo(() => rows.filter((r) => matchesTxFilter(r, txFilter)), [rows, txFilter]);
  const totalCredit = visibleRows.reduce((s, r) => s + r.credit, 0);
  const totalDebit = visibleRows.reduce((s, r) => s + r.debit, 0);
  const opening = meta?.opening_balance ?? 0;
  const hasDateFilter = Boolean(activeRange.from || activeRange.to);
  const headlineFallback = !hasDateFilter && currentBalance != null ? currentBalance : 0;
  const closing = meta?.closing_balance ?? rows[0]?.balance ?? headlineFallback;
  const customInvalid = preset === "custom" && customFrom && customTo && customFrom > customTo;

  const displayName = meta?.user_name || queryName;
  const displayRole = meta?.role_name || queryRole;

  const handleDownload = useCallback(() => {
    if (!meta) return;
    const visible = rows.filter((r) => matchesTxFilter(r, txFilter));
    if (visible.length === 0) return;
    setDownloading(true);
    try {
      downloadWalletStatementPdf(visible, {
        ...meta,
        user_name: meta.user_name || queryName,
        role_name: meta.role_name || queryRole,
        total_credit: visible.reduce((s, r) => s + r.credit, 0),
        total_debit: visible.reduce((s, r) => s + r.debit, 0),
        count: visible.length,
      });
    } finally {
      setTimeout(() => setDownloading(false), 600);
    }
  }, [meta, rows, txFilter, queryName, queryRole]);

  return (
    <div className="space-y-5" style={{ fontFamily: "'Inter','system-ui',sans-serif" }}>
      {/* ── Page header ─────────────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3 min-w-0">
          <Link href="/dashboard/wallets" className="p-2 rounded-lg border border-black/10 text-zinc-500 hover:text-zinc-900 hover:bg-black/[0.03]">
            <ArrowLeft className="w-4 h-4" />
          </Link>
          <div className="min-w-0">
            <h1 className="text-zinc-900 font-bold truncate" style={{ fontSize: "1.45rem" }}>Wallet Statement</h1>
            <p className="text-zinc-500 truncate" style={{ fontSize: "0.82rem" }}>Full-window view · {displayName}</p>
          </div>
        </div>
        <button
          onClick={handleDownload}
          disabled={loading || downloading || visibleRows.length === 0}
          className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl font-semibold transition-all disabled:opacity-40 disabled:cursor-not-allowed"
          style={{ background: "#f59e0b", color: "#18181b", fontSize: "0.8rem", border: "none", cursor: "pointer", boxShadow: "0 8px 22px rgba(245,158,11,0.3)" }}
        >
          {downloading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
          Download PDF
        </button>
      </div>

      {/* ── Account hero ────────────────────────────────────────────── */}
      <div className="relative overflow-hidden rounded-2xl text-white" style={{ background: "linear-gradient(135deg,#18181b 0%,#27272a 60%,#3f1d04 150%)" }}>
        <div className="absolute -right-12 -top-14 h-44 w-44 rounded-full blur-3xl" style={{ background: "rgba(245,158,11,0.22)" }} />
        <div className="relative px-6 py-6 flex items-center gap-4 flex-wrap">
          <div className="w-14 h-14 rounded-2xl flex items-center justify-center font-bold shrink-0" style={{ background: "rgba(245,158,11,0.18)", color: "#fcd34d", fontSize: "1.05rem", boxShadow: "inset 0 0 0 1px rgba(252,211,77,0.25)" }}>
            {initials(displayName)}
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="font-bold tracking-tight truncate" style={{ fontSize: "1.3rem" }}>{displayName}</h2>
            <div className="flex items-center gap-2 mt-0.5 flex-wrap" style={{ color: "rgba(255,255,255,0.72)", fontSize: "0.74rem" }}>
              {displayRole && <span className="inline-flex items-center gap-1"><ShieldCheck className="w-3 h-3" />{roleLabel(displayRole)}</span>}
              {meta?.company_name && <><span className="opacity-40">·</span><span className="truncate">{meta.company_name}</span></>}
            </div>
          </div>
          <div className="text-right">
            <div style={{ color: "rgba(255,255,255,0.55)", fontSize: "0.58rem", textTransform: "uppercase", letterSpacing: "0.14em" }}>
              {hasDateFilter ? "Closing Balance (period)" : "Current Wallet Balance"}
            </div>
            <div className="font-mono font-bold tracking-tight" style={{ fontSize: "2rem", lineHeight: 1.1, marginTop: 2 }}>{fmt2(closing)}</div>
          </div>
        </div>
      </div>

      {/* ── Filter bar ──────────────────────────────────────────────── */}
      <div className="rounded-2xl border border-black/[0.06] bg-white px-5 py-4">
        <div className="flex items-center gap-1.5 flex-wrap">
          <CalendarRange className="w-3.5 h-3.5 text-zinc-400 mr-0.5" />
          {PRESETS.map((p) => (
            <button
              key={p.key}
              onClick={() => setPreset(p.key)}
              className="px-2.5 py-1 rounded-lg font-semibold transition-all"
              style={{
                fontSize: "0.72rem",
                cursor: "pointer",
                border: "1px solid",
                borderColor: preset === p.key ? "#18181b" : "rgba(0,0,0,0.08)",
                background: preset === p.key ? "#18181b" : "#fff",
                color: preset === p.key ? "#fff" : "#52525b",
              }}
            >
              {p.label}
            </button>
          ))}
        </div>
        {preset === "custom" && (
          <div className="flex items-center gap-2 mt-2.5 flex-wrap">
            <input
              type="date"
              value={customFrom}
              max={customTo || undefined}
              onChange={(e) => setCustomFrom(e.target.value)}
              className="rounded-lg border border-black/10 px-2.5 py-1.5 text-zinc-700 focus:outline-none focus:border-zinc-900"
              style={{ fontSize: "0.76rem" }}
            />
            <span className="text-zinc-400" style={{ fontSize: "0.76rem" }}>to</span>
            <input
              type="date"
              value={customTo}
              min={customFrom || undefined}
              onChange={(e) => setCustomTo(e.target.value)}
              className="rounded-lg border border-black/10 px-2.5 py-1.5 text-zinc-700 focus:outline-none focus:border-zinc-900"
              style={{ fontSize: "0.76rem" }}
            />
            {customInvalid && <span className="text-red-500" style={{ fontSize: "0.72rem" }}>End date is before start date</span>}
          </div>
        )}

        {/* Transaction type filter — collections vs transfers */}
        <div className="flex items-center gap-1.5 flex-wrap mt-3 pt-3 border-t border-black/[0.05]">
          <Filter className="w-3.5 h-3.5 text-zinc-400 mr-0.5" />
          {TX_FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => setTxFilter(f.key)}
              className="px-2.5 py-1 rounded-lg font-semibold transition-all"
              style={{
                fontSize: "0.72rem",
                cursor: "pointer",
                border: "1px solid",
                borderColor: txFilter === f.key ? "#b45309" : "rgba(0,0,0,0.08)",
                background: txFilter === f.key ? "#fffbeb" : "#fff",
                color: txFilter === f.key ? "#b45309" : "#52525b",
              }}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {/* ── Summary cards ───────────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: "Opening", value: fmt2(opening), color: "#18181b", icon: <Wallet className="w-3.5 h-3.5" /> },
          { label: txFilter === "transfer" ? "Transfers In" : "Credit", value: fmt2(totalCredit), color: "#059669", icon: <TrendingUp className="w-3.5 h-3.5" /> },
          { label: txFilter === "transfer" ? "Transfers Out" : "Debit", value: fmt2(totalDebit), color: "#dc2626", icon: <TrendingDown className="w-3.5 h-3.5" /> },
          { label: "Closing", value: fmt2(closing), color: "#b45309", icon: <Wallet className="w-3.5 h-3.5" /> },
        ].map((c) => (
          <div key={c.label} className="rounded-xl border border-black/[0.06] bg-white px-4 py-3">
            <div className="flex items-center gap-1.5 text-zinc-400" style={{ fontSize: "0.6rem", textTransform: "uppercase", letterSpacing: "0.1em" }}>
              <span style={{ color: c.color }}>{c.icon}</span>{c.label}
            </div>
            <div className="font-mono font-bold mt-1 truncate" style={{ fontSize: "1.05rem", color: c.color }}>{c.value}</div>
          </div>
        ))}
      </div>

      {/* ── Ledger ──────────────────────────────────────────────────── */}
      {loading ? (
        <div className="py-20 text-center text-zinc-500">
          <Loader2 className="w-6 h-6 animate-spin mx-auto mb-3 text-amber-500" />
          <p style={{ fontSize: "0.85rem" }}>Loading statement…</p>
        </div>
      ) : error ? (
        <div className="p-4 rounded-xl bg-red-500/10 border border-red-500/20 text-red-600" style={{ fontSize: "0.82rem" }}>{error}</div>
      ) : visibleRows.length === 0 ? (
        <div className="py-20 text-center">
          <div className="w-14 h-14 rounded-2xl bg-zinc-100 flex items-center justify-center mx-auto mb-3">
            <Inbox className="w-7 h-7 text-zinc-300" />
          </div>
          {txFilter !== "all" && rows.length > 0 ? (
            <>
              <p className="text-zinc-600 font-medium" style={{ fontSize: "0.88rem" }}>No {txFilter === "transfer" ? "transfers" : "collections"} in this period</p>
              <p className="text-zinc-400 mt-1" style={{ fontSize: "0.76rem" }}>Switch the type filter back to “All types”.</p>
            </>
          ) : (
            <>
              <p className="text-zinc-600 font-medium" style={{ fontSize: "0.88rem" }}>No transactions in this period</p>
              <p className="text-zinc-400 mt-1" style={{ fontSize: "0.76rem" }}>Try a wider date range or “All time”.</p>
            </>
          )}
        </div>
      ) : (
        <div className="rounded-2xl border border-black/[0.06] bg-white overflow-hidden shadow-[0_8px_30px_rgba(0,0,0,0.04)]">
          <div className="overflow-x-auto">
            <table className="w-full" style={{ borderCollapse: "collapse", minWidth: 720 }}>
              <thead>
                <tr className="bg-zinc-50 border-b border-black/[0.06] text-zinc-400" style={{ fontSize: "0.6rem", textTransform: "uppercase", letterSpacing: "0.1em" }}>
                  <th className="text-left font-bold px-4 py-3">Date</th>
                  <th className="text-left font-bold px-4 py-3">Particulars</th>
                  <th className="text-left font-bold px-4 py-3">Type</th>
                  <th className="text-left font-bold px-4 py-3">Mode</th>
                  <th className="text-right font-bold px-4 py-3">Credit</th>
                  <th className="text-right font-bold px-4 py-3">Debit</th>
                  <th className="text-right font-bold px-4 py-3">Balance</th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((r) => {
                  const isCredit = r.credit > 0;
                  const transfer = isTransferRow(r);
                  return (
                    <tr key={r.id} className="border-b border-black/[0.04] hover:bg-zinc-50/70 transition-colors">
                      <td className="px-4 py-3 text-zinc-500 whitespace-nowrap" style={{ fontSize: "0.72rem" }}>
                        {formatIstDate(r.date)}<span className="block text-zinc-400" style={{ fontSize: "0.66rem" }}>{formatIstTime(r.created_at)}</span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-start gap-2.5 min-w-0">
                          <div className="w-6 h-6 rounded-lg flex items-center justify-center shrink-0 mt-0.5" style={{ background: isCredit ? "rgba(5,150,105,0.10)" : "rgba(220,38,38,0.10)", color: isCredit ? "#059669" : "#dc2626" }}>
                            {isCredit ? <ArrowDownLeft className="w-3.5 h-3.5" /> : <ArrowUpRight className="w-3.5 h-3.5" />}
                          </div>
                          <div className="min-w-0">
                            <div className="text-zinc-900 font-medium" style={{ fontSize: "0.8rem" }}>{r.description || "Wallet entry"}</div>
                            {r.party_name && (
                              <div className="text-zinc-500 truncate" style={{ fontSize: "0.7rem" }}>{r.party_name}{r.party_code ? ` (${r.party_code})` : ""}</div>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className="px-2 py-0.5 rounded-full font-semibold"
                          style={{
                            fontSize: "0.62rem",
                            background: transfer ? "rgba(180,83,9,0.10)" : "rgba(5,150,105,0.10)",
                            color: transfer ? "#b45309" : "#059669",
                          }}
                        >
                          {transfer ? "Transfer" : "Collection"}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-zinc-500 uppercase" style={{ fontSize: "0.7rem" }}>{r.payment_mode}</td>
                      <td className="px-4 py-3 text-right font-mono" style={{ fontSize: "0.78rem", color: "#059669" }}>{r.credit > 0 ? `+${fmt2(r.credit)}` : "—"}</td>
                      <td className="px-4 py-3 text-right font-mono" style={{ fontSize: "0.78rem", color: "#dc2626" }}>{r.debit > 0 ? `−${fmt2(r.debit)}` : "—"}</td>
                      <td className="px-4 py-3 text-right font-mono font-semibold text-zinc-700" style={{ fontSize: "0.78rem" }}>{fmt2(r.balance)}</td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="bg-zinc-900 text-white">
                  <td className="px-4 py-3 font-semibold" style={{ fontSize: "0.76rem" }} colSpan={4}>
                    {txFilter === "all" ? "Closing Balance" : txFilter === "transfer" ? "Transfers total" : "Collections total"}
                  </td>
                  <td className="px-4 py-3 text-right font-mono font-bold" style={{ fontSize: "0.76rem", color: "#34d399" }}>+{fmt(totalCredit)}</td>
                  <td className="px-4 py-3 text-right font-mono font-bold" style={{ fontSize: "0.76rem", color: "#f87171" }}>−{fmt(totalDebit)}</td>
                  <td className="px-4 py-3 text-right font-mono font-bold" style={{ fontSize: "0.82rem", color: "#fcd34d" }}>{fmt2(closing)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {!loading && !error && visibleRows.length > 0 && (
        <p className="text-center text-zinc-400" style={{ fontSize: "0.68rem" }}>
          Showing {visibleRows.length}{txFilter !== "all" ? ` of ${rows.length}` : ""} transaction{visibleRows.length === 1 ? "" : "s"} · Encrypted, read-only PDF export
        </p>
      )}
    </div>
  );
}
