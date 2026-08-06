"use client";

import React, { useMemo } from "react";
import {
  Banknote, Building2, Crown, Plus, Receipt, Tag, Trash2, TrendingDown,
  TrendingUp, Wallet, CalendarDays, Layers,
} from "lucide-react";
import type { ExpenseRecord } from "@/lib/expenses-fallback";

export interface FinanceWallet {
  user_id: string;
  user_name: string;
  role_name: string;
  balance: number;
  cash_balance: number;
  bank_balance: number;
  coupon_balance: number;
}

export interface ExpenseSummary {
  total: number;
  monthTotal: number;
  count: number;
  byCategory: Record<string, number>;
  byBucket: Record<string, number>;
}

interface InternalFinancesProps {
  wallets: FinanceWallet[];
  expenses: ExpenseRecord[];
  summary: ExpenseSummary | null;
  onAddExpense: () => void;
  onDeleteExpense: (id: string) => void;
  deleting: string | null;
}

const fmt = (n: number) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(n);

const bucketIcon: Record<string, React.ReactNode> = {
  cash: <Banknote className="w-3 h-3 text-emerald-500" />,
  bank: <Building2 className="w-3 h-3 text-blue-500" />,
  coupon: <Tag className="w-3 h-3 text-violet-500" />,
};

const categoryHue: Record<string, string> = {
  Travel: "#0891b2", Fuel: "#d97706", Food: "#16a34a", Office: "#6366f1",
  Salary: "#db2777", Rent: "#9333ea", Utilities: "#0ea5e9", Maintenance: "#ca8a04",
  Marketing: "#e11d48", Misc: "#64748b",
};
const hueFor = (c: string) => categoryHue[c] || "#64748b";

const initials = (name: string) =>
  name.trim().split(/\s+/).slice(0, 2).map((p) => p.charAt(0).toUpperCase()).join("") || "?";

const dateLabel = (iso: string) =>
  new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });

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

export default function InternalFinances({
  wallets, expenses, summary, onAddExpense, onDeleteExpense, deleting,
}: InternalFinancesProps) {
  const stats = useMemo(() => {
    const totalHeld = wallets.reduce((s, w) => s + (w.balance || 0), 0);
    const avg = wallets.length ? totalHeld / wallets.length : 0;
    const salesmen = wallets.filter((w) => w.role_name === "SALESMAN");
    const topPerformer = [...salesmen].sort((a, b) => b.balance - a.balance)[0] || null;

    // spend per user (from the loaded expense list)
    const spendByUser: Record<string, { name: string; amount: number }> = {};
    for (const e of expenses) {
      const key = e.user_id;
      const name = e.user_name || wallets.find((w) => w.user_id === key)?.user_name || "User";
      spendByUser[key] = { name, amount: (spendByUser[key]?.amount || 0) + (Number(e.amount) || 0) };
    }
    const topSpenders = Object.values(spendByUser).sort((a, b) => b.amount - a.amount).slice(0, 5);

    const categories = Object.entries(summary?.byCategory || {})
      .sort((a, b) => b[1] - a[1]);
    const catMax = categories.reduce((m, [, v]) => Math.max(m, v), 0) || 1;

    return { avg, topPerformer, topSpenders, categories, catMax };
  }, [wallets, expenses, summary]);

  const total = summary?.total ?? expenses.reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const monthTotal = summary?.monthTotal ?? 0;
  const count = summary?.count ?? expenses.length;

  return (
    <div className="space-y-6">
      {/* ─── Header + Add Expense ─── */}
      <div className="relative overflow-hidden rounded-2xl border border-black/[0.06] bg-gradient-to-br from-white via-rose-50/50 to-orange-50/30 p-6 shadow-[0_12px_40px_rgba(0,0,0,0.05)]">
        <div className="absolute -right-12 -top-12 h-40 w-40 rounded-full bg-rose-300/20 blur-3xl" />
        <div className="relative flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="inline-flex items-center gap-1.5 rounded-full border border-rose-200/70 bg-white/70 px-2.5 py-1 text-rose-700" style={{ fontSize: "0.62rem", fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase" }}>
              <Receipt className="w-3 h-3" /> Internal Finances
            </div>
            <h2 className="text-zinc-900 font-semibold tracking-tight mt-2.5" style={{ fontSize: "1.4rem" }}>
              Expense &amp; Treasury Dashboard
            </h2>
            <p className="text-zinc-600" style={{ fontSize: "0.82rem", margin: 0 }}>
              Track spending across wallets — every expense is deducted from its wallet instantly.
            </p>
          </div>
          <button
            onClick={onAddExpense}
            className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-rose-600 text-white font-semibold hover:bg-rose-700 transition-all shadow-lg shadow-rose-600/20 shrink-0"
            style={{ fontSize: "0.82rem", cursor: "pointer", fontFamily: "inherit", border: "none" }}
          >
            <Plus className="w-4 h-4" /> Add Expense
          </button>
        </div>
      </div>

      {/* ─── Stat cards ─── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3.5">
        <StatCard icon={<TrendingDown className="w-4 h-4" />} label="Total Spent" value={fmt(total)} accent="#e11d48" sub={`${count} ${count === 1 ? "expense" : "expenses"}`} />
        <StatCard icon={<CalendarDays className="w-4 h-4" />} label="This Month" value={fmt(monthTotal)} accent="#d97706" />
        <StatCard icon={<Wallet className="w-4 h-4" />} label="Avg Wallet Balance" value={fmt(stats.avg)} accent="#0891b2" sub={`${wallets.length} wallets`} />
        <StatCard
          icon={<Crown className="w-4 h-4" />}
          label="Top Performer"
          value={stats.topPerformer ? fmt(stats.topPerformer.balance) : "—"}
          accent="#7c3aed"
          sub={stats.topPerformer?.user_name}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* ─── Expense list ─── */}
        <section className="lg:col-span-2">
          <div className="flex items-center gap-2.5 mb-3.5 px-1">
            <div className="p-2 rounded-xl border border-black/5 shadow-sm bg-rose-600/10 text-rose-600">
              <Receipt className="w-4 h-4" />
            </div>
            <h3 className="text-lg font-semibold text-zinc-900 tracking-tight">Recent Expenses</h3>
            <span className="inline-flex items-center rounded-full bg-zinc-100 text-zinc-600 px-2 py-0.5 text-xs font-medium">{expenses.length}</span>
          </div>

          {expenses.length === 0 ? (
            <div className="rounded-2xl border border-black/[0.06] bg-white text-center py-16 text-zinc-500">
              <Receipt className="w-11 h-11 mx-auto mb-3 opacity-30" />
              <p style={{ fontSize: "0.85rem" }}>No expenses recorded yet</p>
              <button
                onClick={onAddExpense}
                className="mt-4 inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-zinc-900 text-white font-semibold hover:bg-zinc-800"
                style={{ fontSize: "0.76rem", cursor: "pointer", fontFamily: "inherit", border: "none" }}
              >
                <Plus className="w-3.5 h-3.5" /> Add your first expense
              </button>
            </div>
          ) : (
            <div className="rounded-2xl border border-black/[0.06] overflow-hidden bg-white shadow-[0_14px_40px_rgba(0,0,0,0.06)] divide-y divide-black/[0.04]">
              {expenses.map((e) => (
                <div key={e.id} className="group flex items-center gap-3 px-4 py-3 hover:bg-zinc-50/60 transition-colors">
                  <div
                    className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0"
                    style={{ background: `${hueFor(e.category)}1a`, color: hueFor(e.category) }}
                  >
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
                      {e.user_name || "User"} · {dateLabel(e.created_at)}{e.note ? ` · ${e.note}` : ""}
                    </div>
                  </div>
                  <div className="font-mono font-bold text-rose-600 shrink-0" style={{ fontSize: "0.92rem" }}>
                    −{fmt(Number(e.amount) || 0)}
                  </div>
                  <button
                    onClick={() => onDeleteExpense(e.id)}
                    disabled={deleting === e.id}
                    className="p-1.5 rounded-lg text-zinc-300 hover:text-red-600 hover:bg-red-50 transition-all sm:opacity-0 sm:group-hover:opacity-100 disabled:opacity-50"
                    style={{ cursor: "pointer", border: "none", background: "transparent" }}
                    title="Delete expense"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* ─── Right column: categories + top spenders ─── */}
        <div className="space-y-5">
          {/* category breakdown */}
          <section>
            <div className="flex items-center gap-2.5 mb-3.5 px-1">
              <div className="p-2 rounded-xl border border-black/5 shadow-sm bg-amber-500/10 text-amber-600">
                <Layers className="w-4 h-4" />
              </div>
              <h3 className="text-lg font-semibold text-zinc-900 tracking-tight">By Category</h3>
            </div>
            <div className="rounded-2xl border border-black/[0.06] bg-white p-4 shadow-[0_8px_28px_rgba(0,0,0,0.04)] space-y-3">
              {stats.categories.length === 0 ? (
                <p className="text-zinc-400 text-center py-4" style={{ fontSize: "0.78rem" }}>No spend yet</p>
              ) : (
                stats.categories.map(([cat, amt]) => (
                  <div key={cat}>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-zinc-700" style={{ fontSize: "0.74rem", fontWeight: 600 }}>{cat}</span>
                      <span className="font-mono text-zinc-500" style={{ fontSize: "0.72rem" }}>{fmt(amt)}</span>
                    </div>
                    <div className="h-2 rounded-full bg-zinc-100 overflow-hidden">
                      <div className="h-full rounded-full transition-all" style={{ width: `${Math.max(4, (amt / stats.catMax) * 100)}%`, background: hueFor(cat) }} />
                    </div>
                  </div>
                ))
              )}
            </div>
          </section>

          {/* top spenders */}
          <section>
            <div className="flex items-center gap-2.5 mb-3.5 px-1">
              <div className="p-2 rounded-xl border border-black/5 shadow-sm bg-zinc-900 text-amber-300">
                <TrendingUp className="w-4 h-4" />
              </div>
              <h3 className="text-lg font-semibold text-zinc-900 tracking-tight">Top Spenders</h3>
            </div>
            <div className="rounded-2xl border border-black/[0.06] bg-white p-2 shadow-[0_8px_28px_rgba(0,0,0,0.04)]">
              {stats.topSpenders.length === 0 ? (
                <p className="text-zinc-400 text-center py-6" style={{ fontSize: "0.78rem" }}>No spend yet</p>
              ) : (
                stats.topSpenders.map((s, i) => (
                  <div key={s.name + i} className="flex items-center gap-3 px-2.5 py-2 rounded-xl hover:bg-zinc-50">
                    <div className="w-7 h-7 rounded-lg bg-zinc-100 text-zinc-500 flex items-center justify-center font-semibold shrink-0" style={{ fontSize: "0.66rem" }}>
                      {initials(s.name)}
                    </div>
                    <span className="flex-1 min-w-0 truncate text-zinc-800" style={{ fontSize: "0.8rem", fontWeight: 500 }}>{s.name}</span>
                    <span className="font-mono font-semibold text-rose-600 shrink-0" style={{ fontSize: "0.78rem" }}>{fmt(s.amount)}</span>
                  </div>
                ))
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
