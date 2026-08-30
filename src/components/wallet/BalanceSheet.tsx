"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Banknote, Building2, CalendarDays, Download, Layers, Plus, Receipt, Tag,
  TrendingDown, TrendingUp, Wallet, Users, ArrowRight, BookOpen, Loader2, ShieldCheck,
  Filter, Hash,
} from "lucide-react";
import { api } from "@/lib/api";
import { formatDayKey, istToday, shiftDayKey, dayKeyRange } from "@/lib/datetime";
import { downloadBalanceSheetPdf } from "@/lib/balance-sheet-pdf";
import type { FinanceWallet } from "./InternalFinances";

/* ────────────────────────────── types ────────────────────────────── */

interface CollectorRow {
  user_id: string;
  name: string;
  cash: number;
  bank: number;
  coupon: number;
  total: number;
  count: number;
}

interface CollectionPayment {
  id: string;
  collector_id: string;
  collector_name: string;
  party_id: string | null;
  party_name: string;
  payment_number: string | null;
  reference_number: string | null;
  payment_mode: string;
  bucket: "cash" | "bank" | "coupon";
  amount: number;
  payment_date: string;
}

interface DayMovement {
  date: string;
  cash: number;
  bank: number;
  coupon: number;
  collection: number;
  expense: number;
}

interface ExpenseRow {
  id: string;
  user_name: string;
  category: string;
  bucket: string;
  amount: number;
  created_at: string;
  note: string | null;
}

interface BalanceSheetData {
  range: { from: string; to: string; today: string };
  collection: {
    cash: number; bank: number; coupon: number; total: number; count: number;
    byCollector: CollectorRow[];
    list: CollectionPayment[];
  };
  expense: {
    total: number; count: number;
    byCategory: { category: string; amount: number }[];
    byUser: { user_id: string; name: string; amount: number }[];
    list: ExpenseRow[];
  };
  days: DayMovement[];
}

interface DayLedger extends DayMovement {
  opening: number;
  closing: number;
}

interface BalanceSheetProps {
  wallets: FinanceWallet[];
  onAddExpense?: () => void;
  expenseActionLabel?: string;
  onViewExpenseRequests?: () => void;
  /** Bumped by the page after an expense is added/removed, to force a refetch. */
  reloadToken: number;
}

/* ────────────────────────────── helpers ──────────────────────────── */

const fmt = (n: number) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(n);

const categoryHue: Record<string, string> = {
  Travel: "#0891b2", Fuel: "#d97706", Food: "#16a34a", Office: "#6366f1",
  Salary: "#db2777", Rent: "#9333ea", Utilities: "#0ea5e9", Maintenance: "#ca8a04",
  Marketing: "#e11d48", Misc: "#64748b",
};
const hueFor = (c: string) => categoryHue[c] || "#64748b";

const initials = (name: string) =>
  name.trim().split(/\s+/).slice(0, 2).map((p) => p.charAt(0).toUpperCase()).join("") || "?";

const bucketIcon: Record<string, React.ReactNode> = {
  cash: <Banknote className="w-3 h-3 text-emerald-500" />,
  bank: <Building2 className="w-3 h-3 text-blue-500" />,
  coupon: <Tag className="w-3 h-3 text-violet-500" />,
};

type PresetKey = "today" | "2day" | "month" | "custom";

/* ────────────────────────────── stat card ─────────────────────────── */

interface StatCardProps { icon: React.ReactNode; label: string; value: string; accent: string; sub?: string; }
function StatCard({ icon, label, value, accent, sub }: StatCardProps) {
  return (
    <div className="rounded-2xl border border-black/[0.06] bg-white p-4 shadow-[0_8px_28px_rgba(0,0,0,0.04)]">
      <div className="flex items-center gap-2">
        <div className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0" style={{ background: `${accent}1a`, color: accent }}>
          {icon}
        </div>
        <span className="text-zinc-400" style={{ fontSize: "0.62rem", textTransform: "uppercase", letterSpacing: "0.1em", fontWeight: 600 }}>
          {label}
        </span>
      </div>
      <div className="font-mono font-bold text-zinc-900 mt-2.5 truncate" style={{ fontSize: "1.45rem", lineHeight: 1.1 }}>
        {value}
      </div>
      {sub && <div className="text-zinc-400 mt-0.5" style={{ fontSize: "0.66rem" }}>{sub}</div>}
    </div>
  );
}

/* ────────────────────── per-day cash-book column card ─────────────── */

function DayCard({ day, isLatest }: { day: DayLedger; isLatest: boolean }) {
  const net = day.collection - day.expense;
  return (
    <div className="rounded-2xl border border-black/[0.06] bg-white shadow-[0_8px_28px_rgba(0,0,0,0.04)] overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-black/[0.05] bg-zinc-50/70">
        <span className="font-semibold text-zinc-800" style={{ fontSize: "0.82rem" }}>{formatDayKey(day.date)}</span>
        {isLatest && (
          <span className="rounded-full bg-emerald-100 text-emerald-700 px-2 py-0.5 font-semibold" style={{ fontSize: "0.56rem" }}>
            Today · Live
          </span>
        )}
      </div>
      <div className="px-4 py-3 space-y-2.5">
        <Row label="Opening balance" value={fmt(day.opening)} muted />
        <Row label="+ Collection" value={fmt(day.collection)} accent="#059669" />
        <div className="pl-3 flex flex-wrap gap-x-3 gap-y-0.5" style={{ fontSize: "0.66rem" }}>
          <span className="text-zinc-400">Cash {fmt(day.cash)}</span>
          <span className="text-zinc-400">Bank {fmt(day.bank)}</span>
          <span className="text-zinc-400">Coupon {fmt(day.coupon)}</span>
        </div>
        <Row label="− Expense" value={fmt(day.expense)} accent="#e11d48" />
        <div className="border-t border-dashed border-black/[0.08] pt-2.5 flex items-center justify-between">
          <span className="font-semibold text-zinc-900" style={{ fontSize: "0.78rem" }}>Closing balance</span>
          <span className="font-mono font-bold text-zinc-900" style={{ fontSize: "1.05rem" }}>{fmt(day.closing)}</span>
        </div>
        <div className="text-right text-zinc-400" style={{ fontSize: "0.62rem" }}>
          Net movement {net >= 0 ? "+" : ""}{fmt(net)}
        </div>
      </div>
    </div>
  );
}

function Row({ label, value, accent, muted }: { label: string; value: string; accent?: string; muted?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span style={{ fontSize: "0.74rem", color: muted ? "#a1a1aa" : "#52525b", fontWeight: 500 }}>{label}</span>
      <span className="font-mono" style={{ fontSize: "0.82rem", fontWeight: 600, color: accent || "#27272a" }}>{value}</span>
    </div>
  );
}

function SectionTitle({ icon, iconClassName, title, count }: { icon: React.ReactNode; iconClassName: string; title: string; count?: number }) {
  return (
    <div className="mb-3 flex items-center gap-2 px-1">
      <div className={`rounded-lg border border-black/5 p-2 shadow-sm ${iconClassName}`}>
        {icon}
      </div>
      <h3 className="text-base font-semibold tracking-tight text-zinc-900">{title}</h3>
      {typeof count === "number" && (
        <span className="inline-flex items-center rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-600">{count}</span>
      )}
    </div>
  );
}

function DayLedgerTable({ dayLedger }: { dayLedger: DayLedger[] }) {
  return (
    <div className="overflow-hidden rounded-xl border border-black/[0.06] bg-white shadow-[0_8px_24px_rgba(0,0,0,0.04)]">
      <div className="overflow-x-auto">
        <table className="w-full" style={{ fontSize: "0.78rem" }}>
          <thead>
            <tr className="bg-zinc-50/80 text-zinc-400" style={{ fontSize: "0.62rem", textTransform: "uppercase", letterSpacing: "0.08em" }}>
              <th className="px-4 py-2.5 text-left font-semibold">Date</th>
              <th className="px-4 py-2.5 text-right font-semibold">Opening</th>
              <th className="px-4 py-2.5 text-right font-semibold">Collection</th>
              <th className="px-4 py-2.5 text-right font-semibold">Expense</th>
              <th className="px-4 py-2.5 text-right font-semibold">Closing</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-black/[0.04]">
            {dayLedger.map((d) => (
              <tr key={d.date} className="hover:bg-zinc-50/60">
                <td className="px-4 py-2.5 font-medium text-zinc-700">{formatDayKey(d.date)}</td>
                <td className="px-4 py-2.5 text-right font-mono text-zinc-500">{fmt(d.opening)}</td>
                <td className="px-4 py-2.5 text-right font-mono text-emerald-600">{fmt(d.collection)}</td>
                <td className="px-4 py-2.5 text-right font-mono text-rose-600">{fmt(d.expense)}</td>
                <td className="px-4 py-2.5 text-right font-mono font-bold text-zinc-900">{fmt(d.closing)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ExpenseCategoryPanel({ data, catMax }: { data: BalanceSheetData | null; catMax: number }) {
  return (
    <section>
      <SectionTitle icon={<Layers className="w-4 h-4" />} iconClassName="bg-amber-500/10 text-amber-600" title="Expense by Category" />
      <div className="space-y-3 rounded-xl border border-black/[0.06] bg-white p-4 shadow-[0_8px_24px_rgba(0,0,0,0.04)]">
        {!data || data.expense.byCategory.length === 0 ? (
          <p className="py-4 text-center text-zinc-400" style={{ fontSize: "0.78rem" }}>No spend in this period</p>
        ) : (
          data.expense.byCategory.map(({ category, amount }) => (
            <div key={category}>
              <div className="mb-1 flex items-center justify-between">
                <span className="text-zinc-700" style={{ fontSize: "0.74rem", fontWeight: 600 }}>{category}</span>
                <span className="font-mono text-zinc-500" style={{ fontSize: "0.72rem" }}>{fmt(amount)}</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-zinc-100">
                <div className="h-full rounded-full transition-all" style={{ width: `${Math.max(4, (amount / catMax) * 100)}%`, background: hueFor(category) }} />
              </div>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

function SpentByPersonPanel({ data }: { data: BalanceSheetData | null }) {
  return (
    <section>
      <SectionTitle icon={<TrendingDown className="w-4 h-4" />} iconClassName="bg-zinc-900 text-rose-300" title="Spent by Person" />
      <div className="rounded-xl border border-black/[0.06] bg-white p-2 shadow-[0_8px_24px_rgba(0,0,0,0.04)]">
        {!data || data.expense.byUser.length === 0 ? (
          <p className="py-6 text-center text-zinc-400" style={{ fontSize: "0.78rem" }}>No spend in this period</p>
        ) : (
          data.expense.byUser.map((u) => (
            <div key={u.user_id} className="flex items-center gap-3 rounded-lg px-2.5 py-2 hover:bg-zinc-50">
              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-zinc-100 font-semibold text-zinc-500" style={{ fontSize: "0.66rem" }}>
                {initials(u.name)}
              </div>
              <span className="min-w-0 flex-1 truncate text-zinc-800" style={{ fontSize: "0.8rem", fontWeight: 500 }}>{u.name}</span>
              <span className="shrink-0 font-mono font-semibold text-rose-600" style={{ fontSize: "0.78rem" }}>{fmt(u.amount)}</span>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

/* ────────────────────────────── page ──────────────────────────────── */

export default function BalanceSheet({ wallets, onAddExpense, expenseActionLabel = "Request Expense", onViewExpenseRequests, reloadToken }: BalanceSheetProps) {
  const today = istToday();
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [preset, setPreset] = useState<PresetKey>("today");
  const [data, setData] = useState<BalanceSheetData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [collectorFilter, setCollectorFilter] = useState("all");

  // Live treasury (sum of every wallet) — anchors the latest day's closing balance.
  const treasuryTotal = useMemo(
    () => wallets.reduce((s, w) => s + (w.balance || 0), 0),
    [wallets],
  );

  const applyPreset = useCallback((key: PresetKey) => {
    setPreset(key);
    const t = istToday();
    if (key === "today") { setFrom(t); setTo(t); }
    else if (key === "2day") { setFrom(shiftDayKey(t, -1)); setTo(t); }
    else if (key === "month") { setFrom(`${t.slice(0, 7)}-01`); setTo(t); }
  }, []);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await api<{ success: boolean } & BalanceSheetData>(
        `/api/v1/admin/balance-sheet?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      );
      setData(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load balance sheet");
    } finally {
      setLoading(false);
    }
  }, [from, to]);

  useEffect(() => { fetchData(); }, [fetchData, reloadToken]);

  // Back-walk opening/closing from the live treasury through every day in range.
  const dayLedger = useMemo<DayLedger[]>(() => {
    if (!data) return [];
    const moveByDay: Record<string, DayMovement> = {};
    for (const d of data.days) moveByDay[d.date] = d;

    // Contiguous days from range start through today (closing anchor lives at today).
    const walkDays = dayKeyRange(from, data.range.today);
    const closingByDay: Record<string, number> = {};
    const openingByDay: Record<string, number> = {};
    let runningClosing = treasuryTotal; // closing of the most-recent (today) day
    for (let i = walkDays.length - 1; i >= 0; i--) {
      const d = walkDays[i];
      const mv = moveByDay[d] || { date: d, cash: 0, bank: 0, coupon: 0, collection: 0, expense: 0 };
      closingByDay[d] = runningClosing;
      const opening = runningClosing - (mv.collection - mv.expense);
      openingByDay[d] = opening;
      runningClosing = opening; // becomes the previous day's closing
    }

    return dayKeyRange(from, to).map((d) => {
      const mv = moveByDay[d] || { date: d, cash: 0, bank: 0, coupon: 0, collection: 0, expense: 0 };
      return { ...mv, opening: openingByDay[d] ?? 0, closing: closingByDay[d] ?? 0 };
    });
  }, [data, from, to, treasuryTotal]);

  const rangeOpening = dayLedger.length ? dayLedger[0].opening : 0;
  const rangeClosing = dayLedger.length ? dayLedger[dayLedger.length - 1].closing : 0;
  const collTotal = data?.collection.total ?? 0;
  const expTotal = data?.expense.total ?? 0;
  const catMax = useMemo(
    () => (data?.expense.byCategory || []).reduce((m, c) => Math.max(m, c.amount), 0) || 1,
    [data],
  );
  const dayCount = dayLedger.length;
  const useTable = dayCount > 4; // many days → compact table instead of column cards
  const isTodayOnly = from === today && to === today;
  const filteredCollections = useMemo(
    () => (data?.collection.list || []).filter((payment) =>
      collectorFilter === "all" || payment.collector_id === collectorFilter,
    ),
    [collectorFilter, data],
  );
  const filteredCollectionTotal = useMemo(
    () => filteredCollections.reduce((sum, payment) => sum + payment.amount, 0),
    [filteredCollections],
  );

  const exportPdf = useCallback(() => {
    if (!data) return;
    downloadBalanceSheetPdf(
      {
        from,
        to,
        generated_at: new Date().toISOString(),
        opening: rangeOpening,
        closing: rangeClosing,
        collectionTotal: data.collection.total,
        expenseTotal: data.expense.total,
        collectionCash: data.collection.cash,
        collectionBank: data.collection.bank,
        collectionCoupon: data.collection.coupon,
      },
      {
        days: dayLedger.map((d) => ({
          date: d.date,
          opening: d.opening,
          collection: d.collection,
          expense: d.expense,
          closing: d.closing,
          cash: d.cash,
          bank: d.bank,
          coupon: d.coupon,
        })),
        byCollector: data.collection.byCollector.map((c) => ({
          name: c.name, cash: c.cash, bank: c.bank, coupon: c.coupon, total: c.total, count: c.count,
        })),
        byCategory: data.expense.byCategory,
        byUser: data.expense.byUser.map((u) => ({ name: u.name, amount: u.amount })),
      },
    );
  }, [data, dayLedger, from, to, rangeOpening, rangeClosing]);

  return (
    <div className="space-y-4">
      {/* ─── Header + controls ─── */}
      <div className="relative overflow-hidden rounded-xl border border-black/[0.06] bg-gradient-to-br from-white via-emerald-50/50 to-cyan-50/30 p-5 shadow-[0_10px_30px_rgba(0,0,0,0.04)]">
        <div className="absolute -right-12 -top-12 h-40 w-40 rounded-full bg-emerald-300/20 blur-3xl" />
        <div className="relative flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <div className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200/70 bg-white/70 px-2.5 py-1 text-emerald-700" style={{ fontSize: "0.62rem", fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase" }}>
              <BookOpen className="w-3 h-3" /> Cash Book
            </div>
            <h2 className="text-zinc-900 font-semibold tracking-tight mt-2" style={{ fontSize: "1.3rem" }}>
              Balance Sheet
            </h2>
            <p className="text-zinc-600" style={{ fontSize: "0.82rem", margin: 0 }}>
              Daily opening, collection, expenses and closing balance for this company.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <button
              onClick={exportPdf}
              disabled={!data || loading}
              className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-white text-zinc-700 font-semibold border border-zinc-200 hover:bg-zinc-50 hover:border-zinc-300 transition-all disabled:opacity-50"
              style={{ fontSize: "0.82rem", cursor: "pointer", fontFamily: "inherit" }}
            >
              <Download className="w-4 h-4" /> Export PDF
            </button>
            {onViewExpenseRequests && (
              <button
                onClick={onViewExpenseRequests}
                className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-amber-50 text-amber-700 font-semibold border border-amber-200 hover:bg-amber-100 hover:border-amber-300 transition-all"
                style={{ fontSize: "0.82rem", cursor: "pointer", fontFamily: "inherit" }}
              >
                <ShieldCheck className="w-4 h-4" /> Requested Expenses
              </button>
            )}
            {onAddExpense && (
              <button
                onClick={onAddExpense}
                className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-rose-600 text-white font-semibold hover:bg-rose-700 transition-all shadow-lg shadow-rose-600/20"
                style={{ fontSize: "0.82rem", cursor: "pointer", fontFamily: "inherit", border: "none" }}
              >
                <Plus className="w-4 h-4" /> {expenseActionLabel}
              </button>
            )}
          </div>
        </div>

        {/* date controls */}
        <div className="relative mt-4 flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-xl border border-black/[0.06] bg-white p-1 shadow-sm">
            {([["today", "Today"], ["2day", "Today + Yesterday"], ["month", "This Month"]] as [PresetKey, string][]).map(([key, label]) => (
              <button
                key={key}
                onClick={() => applyPreset(key)}
                className={`px-3 py-1.5 rounded-lg font-semibold transition-all ${preset === key ? "bg-zinc-900 text-white" : "text-zinc-500 hover:text-zinc-800"}`}
                style={{ fontSize: "0.72rem", cursor: "pointer", fontFamily: "inherit", border: "none" }}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="inline-flex items-center gap-1.5 rounded-xl border border-black/[0.06] bg-white px-2.5 py-1.5 shadow-sm">
            <CalendarDays className="w-3.5 h-3.5 text-zinc-400" />
            <input
              type="date"
              value={from}
              max={to}
              onChange={(e) => { setFrom(e.target.value); setPreset("custom"); }}
              className="bg-transparent outline-none text-zinc-700"
              style={{ fontSize: "0.74rem", fontFamily: "inherit" }}
            />
            <ArrowRight className="w-3.5 h-3.5 text-zinc-300" />
            <input
              type="date"
              value={to}
              min={from}
              max={today}
              onChange={(e) => { setTo(e.target.value); setPreset("custom"); }}
              className="bg-transparent outline-none text-zinc-700"
              style={{ fontSize: "0.74rem", fontFamily: "inherit" }}
            />
          </div>
          {loading && <Loader2 className="w-4 h-4 text-emerald-500 animate-spin" />}
        </div>
      </div>

      {error && (
        <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-600" style={{ fontSize: "0.78rem" }}>
          {error}
        </div>
      )}

      {/* ─── Summary cards ─── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard icon={<Wallet className="w-4 h-4" />} label="Opening Balance" value={fmt(rangeOpening)} accent="#0891b2" sub={formatDayKey(from)} />
        <StatCard icon={<TrendingUp className="w-4 h-4" />} label={isTodayOnly ? "Today's Collection" : "Total Collection"} value={fmt(collTotal)} accent="#059669" sub={`${data?.collection.count ?? 0} payments`} />
        <StatCard icon={<TrendingDown className="w-4 h-4" />} label={isTodayOnly ? "Today's Expenses" : "Total Expense"} value={fmt(expTotal)} accent="#e11d48" sub={`${data?.expense.count ?? 0} expenses`} />
        <StatCard icon={<Banknote className="w-4 h-4" />} label="Closing Balance" value={fmt(rangeClosing)} accent="#7c3aed" sub={formatDayKey(to)} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <section className="lg:col-span-2">
          <SectionTitle
            icon={<BookOpen className="w-4 h-4" />}
            iconClassName="bg-emerald-600/10 text-emerald-600"
            title="Day-by-Day"
            count={dayCount}
          />

          {useTable ? (
            <DayLedgerTable dayLedger={dayLedger} />
          ) : dayLedger.length === 0 ? (
            <div className="rounded-xl border border-black/[0.06] bg-white py-12 text-center text-zinc-500 shadow-[0_8px_24px_rgba(0,0,0,0.04)]">
              <BookOpen className="mx-auto mb-3 h-10 w-10 opacity-30" />
              <p className="text-sm">No balance movement in this period</p>
            </div>
          ) : (
            <div className={`grid gap-3 ${dayCount >= 2 ? "sm:grid-cols-2" : "sm:grid-cols-1"}`}>
              {dayLedger.map((d) => (
                <DayCard key={d.date} day={d} isLatest={d.date === today} />
              ))}
            </div>
          )}
        </section>

        <div className="space-y-4">
          <ExpenseCategoryPanel data={data} catMax={catMax} />
          <SpentByPersonPanel data={data} />
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* ─── Who collected how much ─── */}
        <section className="lg:col-span-2">
          <SectionTitle
            icon={<Users className="w-4 h-4" />}
            iconClassName="bg-zinc-900 text-emerald-300"
            title={isTodayOnly ? "Today's Collection by Salesman" : "Collection by Person"}
            count={data?.collection.byCollector.length ?? 0}
          />

          {!data || data.collection.byCollector.length === 0 ? (
            <div className="rounded-2xl border border-black/[0.06] bg-white text-center py-14 text-zinc-500">
              <TrendingUp className="w-10 h-10 mx-auto mb-3 opacity-30" />
              <p style={{ fontSize: "0.85rem" }}>No collection in this period</p>
            </div>
          ) : (
            <div className="rounded-xl border border-black/[0.06] overflow-hidden bg-white shadow-[0_10px_28px_rgba(0,0,0,0.05)]">
              <div className="overflow-x-auto">
                <table className="w-full" style={{ fontSize: "0.78rem" }}>
                  <thead>
                    <tr className="bg-zinc-50/80 text-zinc-400" style={{ fontSize: "0.6rem", textTransform: "uppercase", letterSpacing: "0.08em" }}>
                      <th className="text-left font-semibold px-4 py-2.5">Collector</th>
                      <th className="text-right font-semibold px-3 py-2.5">Cash</th>
                      <th className="text-right font-semibold px-3 py-2.5">Bank</th>
                      <th className="text-right font-semibold px-3 py-2.5">Coupon</th>
                      <th className="text-right font-semibold px-4 py-2.5">Total</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-black/[0.04]">
                    {data.collection.byCollector.map((c) => (
                      <tr key={c.user_id} className="hover:bg-zinc-50/60">
                        <td className="px-4 py-2.5">
                          <div className="flex items-center gap-2.5 min-w-0">
                            <div className="w-7 h-7 rounded-lg bg-zinc-100 text-zinc-500 flex items-center justify-center font-semibold shrink-0" style={{ fontSize: "0.62rem" }}>
                              {initials(c.name)}
                            </div>
                            <div className="min-w-0">
                              <div className="font-medium text-zinc-800 truncate">{c.name}</div>
                              <div className="text-zinc-400" style={{ fontSize: "0.62rem" }}>{c.count} {c.count === 1 ? "payment" : "payments"}</div>
                            </div>
                          </div>
                        </td>
                        <td className="px-3 py-2.5 text-right font-mono text-zinc-600">{fmt(c.cash)}</td>
                        <td className="px-3 py-2.5 text-right font-mono text-zinc-600">{fmt(c.bank)}</td>
                        <td className="px-3 py-2.5 text-right font-mono text-zinc-600">{fmt(c.coupon)}</td>
                        <td className="px-4 py-2.5 text-right font-mono font-bold text-emerald-700">{fmt(c.total)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="bg-zinc-50/80 font-semibold text-zinc-800">
                      <td className="px-4 py-2.5">Total</td>
                      <td className="px-3 py-2.5 text-right font-mono">{fmt(data.collection.cash)}</td>
                      <td className="px-3 py-2.5 text-right font-mono">{fmt(data.collection.bank)}</td>
                      <td className="px-3 py-2.5 text-right font-mono">{fmt(data.collection.coupon)}</td>
                      <td className="px-4 py-2.5 text-right font-mono text-emerald-700">{fmt(data.collection.total)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
          )}

          {/* party-by-party collection register */}
          <div className="mt-6 mb-3.5 flex flex-col gap-3 px-1 sm:flex-row sm:items-end sm:justify-between">
            <div className="flex items-center gap-2.5">
              <div className="rounded-xl border border-black/5 bg-emerald-600/10 p-2 text-emerald-600 shadow-sm">
                <Building2 className="h-4 w-4" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-lg font-semibold tracking-tight text-zinc-900">Party Collection Register</h3>
                  <span className="inline-flex items-center rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-600">{filteredCollections.length}</span>
                </div>
                <p className="text-xs text-zinc-500">Every party payment with its collector and receipt reference.</p>
              </div>
            </div>
            <label className="flex min-w-[220px] items-center gap-2 rounded-xl border border-black/[0.07] bg-white px-3 py-2 shadow-sm">
              <Filter className="h-3.5 w-3.5 text-zinc-400" />
              <select
                aria-label="Filter collections by salesman"
                value={collectorFilter}
                onChange={(event) => setCollectorFilter(event.target.value)}
                className="min-w-0 flex-1 bg-transparent text-sm font-medium text-zinc-700 outline-none"
              >
                <option value="all">All salesmen</option>
                {(data?.collection.byCollector || []).map((collector) => (
                  <option key={collector.user_id} value={collector.user_id}>{collector.name}</option>
                ))}
              </select>
            </label>
          </div>

          {!data || filteredCollections.length === 0 ? (
            <div className="rounded-2xl border border-black/[0.06] bg-white py-12 text-center text-zinc-500">
              <Building2 className="mx-auto mb-3 h-10 w-10 opacity-30" />
              <p className="text-sm">No party collections for this selection</p>
            </div>
          ) : (
            <div className="overflow-hidden rounded-2xl border border-black/[0.06] bg-white shadow-[0_14px_40px_rgba(0,0,0,0.06)]">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-black/[0.05] bg-emerald-50/50 px-4 py-3">
                <span className="text-xs font-semibold uppercase tracking-[0.1em] text-emerald-700">Selected collection</span>
                <span className="font-mono text-base font-bold text-emerald-700">{fmt(filteredCollectionTotal)}</span>
              </div>
              <div className="max-h-[28rem] overflow-auto">
                <table className="w-full min-w-[720px] text-xs">
                  <thead className="sticky top-0 z-10 bg-zinc-50 text-[0.62rem] uppercase tracking-[0.08em] text-zinc-400">
                    <tr>
                      <th className="px-4 py-2.5 text-left font-semibold">Party</th>
                      <th className="px-3 py-2.5 text-left font-semibold">Salesman</th>
                      <th className="px-3 py-2.5 text-left font-semibold">Receipt</th>
                      <th className="px-3 py-2.5 text-left font-semibold">Mode</th>
                      <th className="px-3 py-2.5 text-left font-semibold">Date</th>
                      <th className="px-4 py-2.5 text-right font-semibold">Amount</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-black/[0.04]">
                    {filteredCollections.map((payment) => (
                      <tr key={payment.id} className="hover:bg-zinc-50/70">
                        <td className="px-4 py-3">
                          <div className="font-semibold text-zinc-900">{payment.party_name}</div>
                          {payment.reference_number && <div className="mt-0.5 text-[0.66rem] text-zinc-400">Ref: {payment.reference_number}</div>}
                        </td>
                        <td className="px-3 py-3 text-zinc-600">{payment.collector_name}</td>
                        <td className="px-3 py-3">
                          <span className="inline-flex items-center gap-1 font-mono text-zinc-500"><Hash className="h-3 w-3" />{payment.payment_number || "—"}</span>
                        </td>
                        <td className="px-3 py-3">
                          <span className="inline-flex items-center gap-1 rounded-lg bg-zinc-100 px-2 py-1 font-semibold uppercase text-zinc-600">
                            {bucketIcon[payment.bucket]} {payment.payment_mode}
                          </span>
                        </td>
                        <td className="px-3 py-3 text-zinc-500">{formatDayKey(payment.payment_date)}</td>
                        <td className="px-4 py-3 text-right font-mono text-sm font-bold text-emerald-700">{fmt(payment.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* recent expenses for the period */}
          <div className="mt-5">
            <SectionTitle
              icon={<Receipt className="w-4 h-4" />}
              iconClassName="bg-rose-600/10 text-rose-600"
              title={isTodayOnly ? "Today's Expenses" : "Expenses"}
              count={data?.expense.list.length ?? 0}
            />
          </div>
          {!data || data.expense.list.length === 0 ? (
            <div className="rounded-2xl border border-black/[0.06] bg-white text-center py-12 text-zinc-500">
              <Receipt className="w-10 h-10 mx-auto mb-3 opacity-30" />
              <p style={{ fontSize: "0.85rem" }}>No expenses in this period</p>
            </div>
          ) : (
            <div className="rounded-2xl border border-black/[0.06] overflow-hidden bg-white shadow-[0_14px_40px_rgba(0,0,0,0.06)] divide-y divide-black/[0.04]">
              {data.expense.list.map((e) => (
                <div key={e.id} className="group flex items-center gap-3 px-4 py-3 hover:bg-zinc-50/60 transition-colors">
                  <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0" style={{ background: `${hueFor(e.category)}1a`, color: hueFor(e.category) }}>
                    <Receipt className="w-4 h-4" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold text-zinc-900" style={{ fontSize: "0.86rem" }}>{e.category}</span>
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-zinc-100 text-zinc-500" style={{ fontSize: "0.58rem", fontWeight: 600, textTransform: "uppercase" }}>
                        {bucketIcon[e.bucket]} {e.bucket}
                      </span>
                    </div>
                    <div className="text-zinc-500 truncate mt-0.5" style={{ fontSize: "0.72rem" }}>
                      {e.user_name} · {formatDayKey(e.created_at)}{e.note ? ` · ${e.note}` : ""}
                    </div>
                  </div>
                  <div className="font-mono font-bold text-rose-600 shrink-0" style={{ fontSize: "0.92rem" }}>
                    −{fmt(e.amount)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <div className="rounded-xl border border-dashed border-black/[0.08] bg-zinc-50/70 p-4 text-sm text-zinc-500">
          <div className="font-semibold text-zinc-800">Balance check</div>
          <div className="mt-2 space-y-1 text-xs">
            <div className="flex justify-between gap-3"><span>Opening</span><span className="font-mono text-zinc-700">{fmt(rangeOpening)}</span></div>
            <div className="flex justify-between gap-3"><span>+ Collection</span><span className="font-mono text-emerald-700">{fmt(collTotal)}</span></div>
            <div className="flex justify-between gap-3"><span>- Expense</span><span className="font-mono text-rose-700">{fmt(expTotal)}</span></div>
            <div className="mt-2 flex justify-between gap-3 border-t border-black/[0.06] pt-2 font-semibold text-zinc-900">
              <span>Closing</span><span className="font-mono">{fmt(rangeClosing)}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
