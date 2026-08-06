"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { formatIstDate, formatIstTime } from "@/lib/datetime";
import {
  downloadWalletStatementPdf,
  type StatementRow,
  type StatementMeta,
} from "@/lib/wallet-statement-pdf";
import {
  X,
  Loader2,
  Download,
  ArrowDownLeft,
  ArrowUpRight,
  CalendarRange,
  ShieldCheck,
  Wallet,
  Inbox,
  TrendingUp,
  TrendingDown,
  Filter,
  Maximize2,
} from "lucide-react";
import {
  PRESETS,
  rangeForPreset,
  TX_FILTERS,
  matchesTxFilter,
  type PresetKey,
  type TxFilterKey,
} from "@/lib/wallet-statement-view";

const ROLE_LABELS: Record<string, string> = {
  SUPER_ADMIN: "Super Admin",
  ADMIN: "Admin",
  ACCOUNTS_MANAGER: "Financier / Accountant",
  SALES_MANAGER: "Sales Manager",
  TERRITORY_MANAGER: "Territory Manager",
  SALESMAN: "Salesman",
};
const roleLabel = (r: string) => ROLE_LABELS[r] || r.replace(/_/g, " ");

const fmt = (n: number) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(n || 0);
const fmt2 = (n: number) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n || 0);

const initials = (name: string) =>
  (name || "?").trim().split(/\s+/).slice(0, 2).map((p) => p.charAt(0).toUpperCase()).join("") || "?";

export interface WalletHistoryDrawerProps {
  open: boolean;
  onClose: () => void;
  userId: string | null;
  userName: string;
  roleName: string;
  /**
   * Live wallet balance already known by the board that opens this drawer.
   * Used to paint the "Current Wallet Balance" headline instantly while the
   * full statement (a slow, multi-round-trip endpoint) loads in the background.
   */
  currentBalance?: number | null;
}

interface HistoryResponse {
  success: boolean;
  data: StatementRow[];
  meta: StatementMeta | null;
  message?: string;
}

export default function WalletHistoryDrawer({ open, onClose, userId, userName, roleName, currentBalance }: WalletHistoryDrawerProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [rows, setRows] = useState<StatementRow[]>([]);
  const [meta, setMeta] = useState<StatementMeta | null>(null);
  const [preset, setPreset] = useState<PresetKey>("all");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [txFilter, setTxFilter] = useState<TxFilterKey>("all");
  const [downloading, setDownloading] = useState(false);

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

  // Reset to "all" each time the drawer opens for a (possibly new) user, and
  // drop any prior user's rows/meta so a stale balance never flashes.
  useEffect(() => {
    if (open) {
      setPreset("all");
      setCustomFrom("");
      setCustomTo("");
      setTxFilter("all");
      setRows([]);
      setMeta(null);
      setError("");
    }
  }, [open, userId]);

  useEffect(() => {
    if (open && userId) load();
  }, [open, userId, load]);

  const handleDownload = useCallback(() => {
    if (!meta) return;
    const visible = rows.filter((r) => matchesTxFilter(r, txFilter));
    if (visible.length === 0) return;
    setDownloading(true);
    try {
      // Download what the user is looking at: when a type filter is active the
      // PDF's credit/debit totals must reflect the filtered subset.
      downloadWalletStatementPdf(visible, {
        ...meta,
        user_name: meta.user_name || userName,
        role_name: meta.role_name || roleName,
        total_credit: visible.reduce((s, r) => s + r.credit, 0),
        total_debit: visible.reduce((s, r) => s + r.debit, 0),
        count: visible.length,
      });
    } finally {
      setTimeout(() => setDownloading(false), 600);
    }
  }, [meta, rows, txFilter, userName, roleName]);

  // Open the same statement (with the active filters) as a full-window page.
  const handleExpand = useCallback(() => {
    if (!userId) return;
    const qs = new URLSearchParams();
    qs.set("name", meta?.user_name || userName || "");
    qs.set("role", meta?.role_name || roleName || "");
    if (activeRange.from) qs.set("from", activeRange.from);
    if (activeRange.to) qs.set("to", activeRange.to);
    if (txFilter !== "all") qs.set("txf", txFilter);
    if (currentBalance != null) qs.set("bal", String(currentBalance));
    window.open(`/dashboard/wallet-statement/user/${userId}?${qs.toString()}`, "_blank", "noopener,noreferrer");
  }, [userId, meta, userName, roleName, activeRange.from, activeRange.to, txFilter, currentBalance]);

  if (!open) return null;

  const visibleRows = rows.filter((r) => matchesTxFilter(r, txFilter));
  const totalCredit = visibleRows.reduce((s, r) => s + r.credit, 0);
  const totalDebit = visibleRows.reduce((s, r) => s + r.debit, 0);
  const opening = meta?.opening_balance ?? 0;

  // Headline balance: for the unfiltered "Current Wallet Balance" view, paint the
  // board's already-known balance immediately (statement endpoint is slow), then
  // let the server's authoritative closing balance take over once it arrives.
  const hasDateFilter = Boolean(activeRange.from || activeRange.to);
  const headlineFallback = !hasDateFilter && currentBalance != null ? currentBalance : 0;
  const closing = meta?.closing_balance ?? rows[0]?.balance ?? headlineFallback;
  const customInvalid = preset === "custom" && customFrom && customTo && customFrom > customTo;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 backdrop-blur-[3px] flex justify-end"
      style={{ fontFamily: "'Inter','system-ui',sans-serif" }}
      onClick={onClose}
    >
      <div
        className="h-full w-full max-w-2xl bg-zinc-50 shadow-2xl flex flex-col animate-[slideIn_.25s_cubic-bezier(0.16,1,0.3,1)]"
        onClick={(e) => e.stopPropagation()}
      >
        <style>{`@keyframes slideIn{from{transform:translateX(24px);opacity:.4}to{transform:translateX(0);opacity:1}}`}</style>

        {/* ── Header ───────────────────────────────────────────────── */}
        <div className="relative overflow-hidden shrink-0 text-white" style={{ background: "linear-gradient(135deg,#18181b 0%,#27272a 60%,#3f1d04 140%)" }}>
          <div className="absolute -right-10 -top-12 h-40 w-40 rounded-full blur-3xl" style={{ background: "rgba(245,158,11,0.22)" }} />
          <div className="absolute left-1/3 -bottom-16 h-32 w-32 rounded-full blur-3xl" style={{ background: "rgba(245,158,11,0.10)" }} />
          <div className="relative px-6 pt-5 pb-5">
            <div className="flex items-start justify-between">
              <div className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1" style={{ background: "rgba(255,255,255,0.12)", fontSize: "0.6rem", fontWeight: 700, letterSpacing: "0.12em" }}>
                <Wallet className="w-3 h-3" /> WALLET STATEMENT
              </div>
              <div className="flex items-center gap-1">
                <button
                  onClick={handleExpand}
                  disabled={!userId}
                  className="inline-flex items-center gap-1.5 px-2.5 py-2 rounded-lg hover:bg-white/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  style={{ background: "none", border: "none", cursor: "pointer", color: "#fff", fontSize: "0.68rem", fontWeight: 600 }}
                  aria-label="Open statement in a new window"
                  title="Open in a new window"
                >
                  <Maximize2 className="w-4 h-4" /> Expand
                </button>
                <button
                  onClick={onClose}
                  className="p-2 rounded-lg hover:bg-white/10 transition-colors"
                  style={{ background: "none", border: "none", cursor: "pointer", color: "#fff" }}
                  aria-label="Close"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            <div className="flex items-center gap-3.5 mt-4">
              <div className="w-12 h-12 rounded-2xl flex items-center justify-center font-bold shrink-0" style={{ background: "rgba(245,158,11,0.18)", color: "#fcd34d", fontSize: "1rem", boxShadow: "inset 0 0 0 1px rgba(252,211,77,0.25)" }}>
                {initials(meta?.user_name || userName)}
              </div>
              <div className="min-w-0">
                <h3 className="font-bold tracking-tight truncate" style={{ fontSize: "1.2rem" }}>{meta?.user_name || userName}</h3>
                <div className="flex items-center gap-2 mt-0.5 flex-wrap" style={{ color: "rgba(255,255,255,0.72)", fontSize: "0.72rem" }}>
                  <span className="inline-flex items-center gap-1"><ShieldCheck className="w-3 h-3" />{roleLabel(meta?.role_name || roleName)}</span>
                  {meta?.company_name && <><span className="opacity-40">·</span><span className="truncate">{meta.company_name}</span></>}
                </div>
              </div>
            </div>

            {/* Closing balance headline */}
            <div className="mt-4 flex items-end justify-between gap-3 flex-wrap">
              <div>
                <div style={{ color: "rgba(255,255,255,0.55)", fontSize: "0.58rem", textTransform: "uppercase", letterSpacing: "0.14em" }}>
                  {activeRange.from || activeRange.to ? "Closing Balance (period)" : "Current Wallet Balance"}
                </div>
                <div className="font-mono font-bold tracking-tight" style={{ fontSize: "1.8rem", lineHeight: 1.1, marginTop: 2 }}>{fmt2(closing)}</div>
              </div>
              <button
                onClick={handleDownload}
                disabled={loading || downloading || visibleRows.length === 0}
                className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl font-semibold transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                style={{ background: "#f59e0b", color: "#18181b", fontSize: "0.78rem", border: "none", cursor: "pointer", boxShadow: "0 8px 22px rgba(245,158,11,0.35)" }}
              >
                {downloading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                Download PDF
              </button>
            </div>
          </div>
        </div>

        {/* ── Filter bar ───────────────────────────────────────────── */}
        <div className="shrink-0 bg-white border-b border-black/[0.06] px-6 py-3">
          <div className="flex items-center gap-1.5 flex-wrap">
            <CalendarRange className="w-3.5 h-3.5 text-zinc-400 mr-0.5" />
            {PRESETS.map((p) => (
              <button
                key={p.key}
                onClick={() => setPreset(p.key)}
                className="px-2.5 py-1 rounded-lg font-semibold transition-all"
                style={{
                  fontSize: "0.7rem",
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
                style={{ fontSize: "0.74rem" }}
              />
              <span className="text-zinc-400" style={{ fontSize: "0.74rem" }}>to</span>
              <input
                type="date"
                value={customTo}
                min={customFrom || undefined}
                onChange={(e) => setCustomTo(e.target.value)}
                className="rounded-lg border border-black/10 px-2.5 py-1.5 text-zinc-700 focus:outline-none focus:border-zinc-900"
                style={{ fontSize: "0.74rem" }}
              />
              {customInvalid && <span className="text-red-500" style={{ fontSize: "0.7rem" }}>End date is before start date</span>}
            </div>
          )}

          {/* Transaction type filter — collections vs transfers */}
          <div className="flex items-center gap-1.5 flex-wrap mt-2.5 pt-2.5 border-t border-black/[0.05]">
            <Filter className="w-3.5 h-3.5 text-zinc-400 mr-0.5" />
            {TX_FILTERS.map((f) => (
              <button
                key={f.key}
                onClick={() => setTxFilter(f.key)}
                className="px-2.5 py-1 rounded-lg font-semibold transition-all"
                style={{
                  fontSize: "0.7rem",
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

        {/* ── Summary cards ────────────────────────────────────────── */}
        <div className="shrink-0 grid grid-cols-3 gap-2.5 px-6 py-3 bg-white border-b border-black/[0.06]">
          {[
            { label: "Opening", value: fmt(opening), color: "#18181b", icon: <Wallet className="w-3 h-3" /> },
            { label: "Credit", value: fmt(totalCredit), color: "#059669", icon: <TrendingUp className="w-3 h-3" /> },
            { label: "Debit", value: fmt(totalDebit), color: "#dc2626", icon: <TrendingDown className="w-3 h-3" /> },
          ].map((c) => (
            <div key={c.label} className="rounded-xl border border-black/[0.05] bg-zinc-50/80 px-3 py-2">
              <div className="flex items-center gap-1 text-zinc-400" style={{ fontSize: "0.56rem", textTransform: "uppercase", letterSpacing: "0.1em" }}>
                <span style={{ color: c.color }}>{c.icon}</span>{c.label}
              </div>
              <div className="font-mono font-bold mt-0.5 truncate" style={{ fontSize: "0.92rem", color: c.color }}>{c.value}</div>
            </div>
          ))}
        </div>

        {/* ── Ledger ───────────────────────────────────────────────── */}
        <div className="flex-1 overflow-auto px-6 py-4">
          {loading && (
            <div className="py-16 text-center text-zinc-500">
              <Loader2 className="w-6 h-6 animate-spin mx-auto mb-3 text-amber-500" />
              <p style={{ fontSize: "0.82rem" }}>Loading statement…</p>
            </div>
          )}

          {!loading && error && (
            <div className="p-3.5 rounded-xl bg-red-500/10 border border-red-500/20 text-red-600" style={{ fontSize: "0.8rem" }}>{error}</div>
          )}

          {!loading && !error && visibleRows.length === 0 && (
            <div className="py-16 text-center">
              <div className="w-14 h-14 rounded-2xl bg-zinc-100 flex items-center justify-center mx-auto mb-3">
                <Inbox className="w-7 h-7 text-zinc-300" />
              </div>
              {txFilter !== "all" && rows.length > 0 ? (
                <>
                  <p className="text-zinc-600 font-medium" style={{ fontSize: "0.86rem" }}>No {txFilter === "transfer" ? "transfers" : "collections"} in this period</p>
                  <p className="text-zinc-400 mt-1" style={{ fontSize: "0.74rem" }}>Switch the type filter back to “All types”.</p>
                </>
              ) : (
                <>
                  <p className="text-zinc-600 font-medium" style={{ fontSize: "0.86rem" }}>No transactions in this period</p>
                  <p className="text-zinc-400 mt-1" style={{ fontSize: "0.74rem" }}>Try a wider date range or “All time”.</p>
                </>
              )}
            </div>
          )}

          {!loading && !error && visibleRows.length > 0 && (
            <div className="rounded-2xl border border-black/[0.06] bg-white overflow-hidden shadow-[0_8px_30px_rgba(0,0,0,0.05)]">
              {/* column header */}
              <div className="hidden sm:grid grid-cols-[1fr_auto_auto] gap-3 px-4 py-2.5 bg-zinc-50 border-b border-black/[0.06] text-zinc-400" style={{ fontSize: "0.58rem", textTransform: "uppercase", letterSpacing: "0.1em", fontWeight: 700 }}>
                <span>Particulars</span>
                <span className="text-right w-28">Credit / Debit</span>
                <span className="text-right w-24">Balance</span>
              </div>
              <div className="divide-y divide-black/[0.05]">
                {visibleRows.map((r) => {
                  const isCredit = r.credit > 0;
                  return (
                    <div key={r.id} className="grid grid-cols-[1fr_auto] sm:grid-cols-[1fr_auto_auto] gap-3 px-4 py-3 hover:bg-zinc-50/70 transition-colors">
                      <div className="flex items-start gap-2.5 min-w-0">
                        <div
                          className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0 mt-0.5"
                          style={{ background: isCredit ? "rgba(5,150,105,0.10)" : "rgba(220,38,38,0.10)", color: isCredit ? "#059669" : "#dc2626" }}
                        >
                          {isCredit ? <ArrowDownLeft className="w-3.5 h-3.5" /> : <ArrowUpRight className="w-3.5 h-3.5" />}
                        </div>
                        <div className="min-w-0">
                          <div className="text-zinc-900 font-medium truncate" style={{ fontSize: "0.8rem" }}>{r.description || "Wallet entry"}</div>
                          <div className="text-zinc-500 truncate" style={{ fontSize: "0.7rem", marginTop: 1 }}>
                            {r.party_name ? `${r.party_name}${r.party_code ? ` (${r.party_code})` : ""} · ` : ""}
                            <span className="uppercase">{r.payment_mode}</span>
                          </div>
                          <div className="text-zinc-400" style={{ fontSize: "0.66rem", marginTop: 2 }}>
                            {formatIstDate(r.date)} · {formatIstTime(r.created_at)}
                          </div>
                        </div>
                      </div>
                      <div className="text-right self-center">
                        <div className="font-mono font-bold" style={{ fontSize: "0.82rem", color: isCredit ? "#059669" : "#dc2626" }}>
                          {isCredit ? "+" : "−"}{fmt2(isCredit ? r.credit : r.debit)}
                        </div>
                      </div>
                      <div className="hidden sm:block text-right self-center w-24">
                        <div className="font-mono font-semibold text-zinc-700" style={{ fontSize: "0.78rem" }}>{fmt2(r.balance)}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
              {/* footer total */}
              <div className="grid grid-cols-[1fr_auto] sm:grid-cols-[1fr_auto_auto] gap-3 px-4 py-3 bg-zinc-900 text-white">
                <span className="font-semibold self-center" style={{ fontSize: "0.74rem" }}>
                  {txFilter === "all" ? "Closing Balance" : txFilter === "transfer" ? "Transfers total" : "Collections total"}
                </span>
                <span className="text-right self-center font-mono" style={{ fontSize: "0.7rem", color: "rgba(255,255,255,0.5)" }}>
                  <span className="text-emerald-400">+{fmt(totalCredit)}</span> / <span className="text-red-400">−{fmt(totalDebit)}</span>
                </span>
                <span className="hidden sm:block text-right self-center font-mono font-bold w-24" style={{ fontSize: "0.82rem", color: "#fcd34d" }}>{fmt2(closing)}</span>
              </div>
            </div>
          )}

          {!loading && !error && visibleRows.length > 0 && (
            <p className="text-center text-zinc-400 mt-4" style={{ fontSize: "0.66rem" }}>
              Showing {visibleRows.length}{txFilter !== "all" ? ` of ${rows.length}` : ""} transaction{visibleRows.length === 1 ? "" : "s"} · Encrypted, read-only PDF export
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
