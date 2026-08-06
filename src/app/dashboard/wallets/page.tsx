"use client";

import React, { useEffect, useState, useCallback } from "react";
import { api, getUser } from "@/lib/api";
import { useVisibleInterval } from "@/lib/hooks/use-visible-interval";
import TransferModal, { type TransferBucket } from "@/components/wallet/TransferModal";
import WalletHistoryDrawer from "@/components/wallet/WalletHistoryDrawer";
import ExpenseModal from "@/components/wallet/ExpenseModal";
import BalanceSheet from "@/components/wallet/BalanceSheet";
import VendorsTreasury from "@/components/wallet/VendorsTreasury";
import { Banknote, Building2, Loader2, Tag, TrendingUp, ShieldCheck, Calculator, Wallet, History, X, Check, ArrowDownToLine, Send, Clock, Users, Receipt } from "lucide-react";

interface WalletData {
  id: string;
  user_id: string;
  user_name: string;
  user_email: string | null;
  user_phone: string | null;
  role_name: string;
  role_id: string;
  balance: number;
  cash_balance: number;
  bank_balance: number;
  coupon_balance: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

interface IncomingTransfer {
  id: string;
  bucket: TransferBucket;
  amount: number;
  status: "PENDING" | "ACCEPTED" | "REJECTED" | "CANCELLED";
  note: string | null;
  created_at: string;
  counterparty_name: string | null;
}

const bucketLabel: Record<TransferBucket, string> = { cash: "Cash", bank: "Bank", coupon: "Coupon" };
const transferStatusChip: Record<IncomingTransfer["status"], { label: string; cls: string }> = {
  PENDING: { label: "Pending", cls: "bg-amber-100 text-amber-700" },
  ACCEPTED: { label: "Accepted", cls: "bg-emerald-100 text-emerald-700" },
  REJECTED: { label: "Rejected", cls: "bg-red-100 text-red-700" },
  CANCELLED: { label: "Cancelled", cls: "bg-zinc-100 text-zinc-500" },
};

const fmt = (n: number) =>
  new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(n);

interface RoleConfig {
  label: string;
  plural: string;
  icon: React.ReactNode;
  color: string;
  bg: string;
}

const roleConfig: Record<string, RoleConfig> = {
  ADMIN: { label: "Admin", plural: "Admins", icon: <ShieldCheck className="w-4 h-4" />, color: "#7c3aed", bg: "rgba(139,92,246,0.10)" },
  ACCOUNTS_MANAGER: { label: "Financier / Accountant", plural: "Financiers / Accountants", icon: <Calculator className="w-4 h-4" />, color: "#0891b2", bg: "rgba(6,182,212,0.10)" },
  SALESMAN: { label: "Salesman", plural: "Salesmen", icon: <TrendingUp className="w-4 h-4" />, color: "#d97706", bg: "rgba(245,158,11,0.10)" },
};

const fallbackRole = (role: string): RoleConfig => ({
  label: role,
  plural: role,
  icon: <Wallet className="w-4 h-4" />,
  color: "#52525b",
  bg: "rgba(82,82,91,0.10)",
});

// Roles whose wallets get the premium, highlighted "custodian" treatment.
// SUPER_ADMIN is intentionally excluded — super admins never hold a wallet.
const HIGHLIGHT_ROLES = ["ADMIN", "ACCOUNTS_MANAGER"];

interface CustodianTheme {
  grad: string;
  accent: string;
  soft: string;
}

const custodianTheme: Record<string, CustodianTheme> = {
  ADMIN: { grad: "linear-gradient(135deg,#5b21b6 0%,#6d28d9 42%,#2e1065 100%)", accent: "#ddd6fe", soft: "rgba(221,214,254,0.16)" },
  ACCOUNTS_MANAGER: { grad: "linear-gradient(135deg,#0e7490 0%,#0891b2 42%,#083344 100%)", accent: "#a5f3fc", soft: "rgba(165,243,252,0.16)" },
};

const initials = (name: string) =>
  name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p.charAt(0).toUpperCase())
    .join("") || "?";

const totalColor = (n: number) => (n > 0 ? "#059669" : n < 0 ? "#dc2626" : "#71717a");

/* Resolve a human login id, never the synthetic <phone>_<hash>@portal.internal email */
const loginId = (w: Pick<WalletData, "user_email" | "user_phone">): string => {
  const email = w.user_email?.trim();
  if (email && !email.endsWith("@portal.internal")) return email;
  // Synthetic portal email encodes the phone before the underscore — recover it.
  const fromEmail = email?.split("@")[0]?.split("_")[0];
  return w.user_phone?.trim() || fromEmail || "";
};

/* ----------------------------- Light bucket chip ---------------------------- */

interface BucketChipProps {
  icon: React.ReactNode;
  label: string;
  value: number;
}

function BucketChip({ icon, label, value }: BucketChipProps) {
  return (
    <div className="rounded-xl border border-black/[0.04] bg-zinc-50/80 px-2.5 py-2 min-w-0">
      <div className="flex items-center gap-1 text-zinc-400" style={{ fontSize: "0.58rem", textTransform: "uppercase", letterSpacing: "0.1em" }}>
        {icon}
        {label}
      </div>
      <div className="font-mono font-semibold text-zinc-800 mt-1 truncate" style={{ fontSize: "0.78rem" }}>
        {fmt(value)}
      </div>
    </div>
  );
}

/* --------------------------- Individual wallet card -------------------------- */

interface WalletCardProps {
  wallet: WalletData;
  config: RoleConfig;
  onHistory: (w: WalletData) => void;
  isMe: boolean;
}

function WalletCard({ wallet, config, onHistory, isMe }: WalletCardProps) {
  return (
    <div className="group relative rounded-2xl border border-black/[0.06] bg-white p-4 shadow-[0_8px_28px_rgba(0,0,0,0.04)] transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[0_16px_44px_rgba(0,0,0,0.10)]">
      {/* identity */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div
            className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0 font-semibold"
            style={{ background: config.bg, color: config.color, fontSize: "0.8rem", boxShadow: `inset 0 0 0 1px ${config.bg}` }}
          >
            {initials(wallet.user_name)}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="font-semibold text-zinc-900 truncate" style={{ fontSize: "0.86rem" }}>
                {wallet.user_name.trim()}
              </span>
              {isMe && (
                <span className="rounded-full bg-amber-100 text-amber-700 px-1.5 py-px font-semibold" style={{ fontSize: "0.56rem" }}>
                  You
                </span>
              )}
            </div>
            <div className="flex items-center gap-1 mt-0.5" style={{ color: config.color }}>
              <span className="opacity-80">{config.icon}</span>
              <span style={{ fontSize: "0.68rem", fontWeight: 600 }}>{config.label}</span>
            </div>
          </div>
        </div>
        {!wallet.is_active && (
          <span className="rounded-full bg-zinc-100 text-zinc-500 px-2 py-0.5 shrink-0" style={{ fontSize: "0.58rem", fontWeight: 600 }}>
            Inactive
          </span>
        )}
      </div>

      {/* buckets */}
      <div className="grid grid-cols-3 gap-2 mt-3.5">
        <BucketChip icon={<Banknote className="w-3 h-3 text-emerald-500" />} label="Cash" value={wallet.cash_balance || 0} />
        <BucketChip icon={<Building2 className="w-3 h-3 text-blue-500" />} label="Bank" value={wallet.bank_balance || 0} />
        <BucketChip icon={<Tag className="w-3 h-3 text-violet-500" />} label="Coupon" value={wallet.coupon_balance || 0} />
      </div>

      {/* footer: total + history */}
      <div className="flex items-end justify-between gap-3 mt-3.5 pt-3 border-t border-black/[0.05]">
        <div className="min-w-0">
          <div className="text-zinc-400" style={{ fontSize: "0.6rem", textTransform: "uppercase", letterSpacing: "0.12em" }}>
            Total Balance
          </div>
          <div className="font-mono font-bold mt-0.5 truncate" style={{ fontSize: "1.15rem", color: totalColor(wallet.balance) }}>
            {fmt(wallet.balance)}
          </div>
        </div>
        <button
          onClick={() => onHistory(wallet)}
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-900 hover:text-white hover:border-zinc-900 transition-all duration-150 shrink-0"
          style={{ fontSize: "0.7rem", fontFamily: "inherit", cursor: "pointer", fontWeight: 600 }}
        >
          <History className="w-3.5 h-3.5" />
          History
        </button>
      </div>
    </div>
  );
}

/* --------------------------- Highlighted custodian card --------------------- */

interface CustodianCardProps {
  wallet: WalletData;
  config: RoleConfig;
  theme: CustodianTheme;
  onHistory: (w: WalletData) => void;
  isMe: boolean;
}

function DarkBucket({ icon, label, value }: BucketChipProps) {
  return (
    <div className="rounded-xl px-2.5 py-2 min-w-0" style={{ background: "rgba(255,255,255,0.10)" }}>
      <div className="flex items-center gap-1" style={{ color: "rgba(255,255,255,0.65)", fontSize: "0.56rem", textTransform: "uppercase", letterSpacing: "0.1em" }}>
        {icon}
        {label}
      </div>
      <div className="font-mono font-semibold text-white mt-1 truncate" style={{ fontSize: "0.8rem" }}>
        {fmt(value)}
      </div>
    </div>
  );
}

function CustodianCard({ wallet, config, theme, onHistory, isMe }: CustodianCardProps) {
  return (
    <div
      className="group relative overflow-hidden rounded-2xl p-5 text-white shadow-[0_18px_50px_rgba(0,0,0,0.22)] transition-transform duration-200 hover:-translate-y-0.5"
      style={{ background: theme.grad }}
    >
      {/* atmosphere */}
      <div className="absolute -right-12 -top-12 h-36 w-36 rounded-full blur-2xl" style={{ background: theme.soft }} />
      <div className="absolute -left-10 -bottom-14 h-32 w-32 rounded-full blur-2xl" style={{ background: theme.soft }} />
      <div className="absolute inset-0 opacity-[0.06]" style={{ backgroundImage: "radial-gradient(circle at 1px 1px, #fff 1px, transparent 0)", backgroundSize: "16px 16px" }} />

      <div className="relative">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <span
              className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-semibold"
              style={{ background: theme.soft, color: theme.accent, fontSize: "0.58rem", textTransform: "uppercase", letterSpacing: "0.12em" }}
            >
              {config.label} · Custodian
            </span>
            <h3 className="font-semibold text-white tracking-tight mt-2 truncate" style={{ fontSize: "1.08rem" }}>
              {wallet.user_name.trim()}
              {isMe && <span className="ml-1.5 align-middle rounded-full bg-white/20 px-1.5 py-px" style={{ fontSize: "0.55rem" }}>You</span>}
            </h3>
            {loginId(wallet) && (
              <p className="truncate" style={{ color: "rgba(255,255,255,0.6)", fontSize: "0.7rem", marginTop: 2 }}>
                {loginId(wallet)}
              </p>
            )}
          </div>
          <div className="w-11 h-11 rounded-2xl flex items-center justify-center shrink-0" style={{ background: theme.soft, color: theme.accent }}>
            {config.icon}
          </div>
        </div>

        {/* headline total */}
        <div className="mt-5">
          <div style={{ color: "rgba(255,255,255,0.6)", fontSize: "0.6rem", textTransform: "uppercase", letterSpacing: "0.14em" }}>Total Held</div>
          <div className="font-mono font-bold tracking-tight text-white" style={{ fontSize: "2rem", lineHeight: 1.1, marginTop: 2 }}>
            {fmt(wallet.balance)}
          </div>
        </div>

        {/* buckets */}
        <div className="grid grid-cols-3 gap-2 mt-5">
          <DarkBucket icon={<Banknote className="w-3 h-3" style={{ color: theme.accent }} />} label="Cash" value={wallet.cash_balance || 0} />
          <DarkBucket icon={<Building2 className="w-3 h-3" style={{ color: theme.accent }} />} label="Bank" value={wallet.bank_balance || 0} />
          <DarkBucket icon={<Tag className="w-3 h-3" style={{ color: theme.accent }} />} label="Coupon" value={wallet.coupon_balance || 0} />
        </div>

        <button
          onClick={() => onHistory(wallet)}
          className="mt-4 w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl font-semibold transition-all duration-150"
          style={{ background: "rgba(255,255,255,0.14)", color: "#fff", fontSize: "0.72rem", fontFamily: "inherit", cursor: "pointer", border: "1px solid rgba(255,255,255,0.18)" }}
        >
          <History className="w-3.5 h-3.5" />
          View History
        </button>
      </div>
    </div>
  );
}

/* ---------------------------------- Page ----------------------------------- */

export default function WalletsPage() {
  const me = getUser();
  const normalizedRole = String(me?.role || "").trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  const isCompanyAdmin = normalizedRole === "ADMIN";
  const canViewAllExpenseRequests = isCompanyAdmin || normalizedRole === "SUPER_ADMIN";
  const [wallets, setWallets] = useState<WalletData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [selectedWallet, setSelectedWallet] = useState<WalletData | null>(null);
  const [tab, setTab] = useState<"balances" | "incoming">("balances");
  const [incoming, setIncoming] = useState<IncomingTransfer[]>([]);
  const [acting, setActing] = useState<string | null>(null);
  const [transferOpen, setTransferOpen] = useState(false);

  // Top-level view: live wallet balances vs. the balance-sheet / cash book vs. vendor payables.
  const [view, setView] = useState<"wallet" | "finances" | "vendors">("wallet");
  const [expenseOpen, setExpenseOpen] = useState(false);
  // Bumped whenever an expense is added/removed so the Balance Sheet refetches its
  // (date-windowed) collection + expense data, which the page itself does not hold.
  const [financeReload, setFinanceReload] = useState(0);

  // A financer/accountant can forward accepted funds onward to an admin.
  const canForward = me?.role === "ACCOUNTS_MANAGER";
  // Salesmen have no access to the Vendors module.
  const isSalesman = me?.role === "SALESMAN";
  // Account managers (Financier / Accountant) do not get the org-wide treasury
  // view: the aggregate hero and the board of every other person's wallet are
  // hidden. They still see their OWN wallet, incoming transfers and forwarding.
  const isAccountsManager = me?.role === "ACCOUNTS_MANAGER";

  const fetchData = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError("");
    try {
      const [walletsRes, incomingRes] = await Promise.all([
        api<{ success: boolean; data: WalletData[] }>("/api/v1/wallets", { noCache: true }),
        api<{ success: boolean; data: IncomingTransfer[] }>("/api/v1/wallets/transfer?box=incoming", { noCache: true })
          .catch(() => ({ success: true, data: [] as IncomingTransfer[] })),
      ]);
      // Super admins never hold a wallet — filter defensively so a stale or
      // cached API payload can never surface the super-admin custodian card.
      setWallets((walletsRes.data || []).filter((w) => w.role_name !== "SUPER_ADMIN"));
      setIncoming(incomingRes.data || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load wallets");
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Wallets are derived from live collections and transfers, including actions
  // recorded by other users. Refresh quietly while this tab is visible and once
  // immediately when it becomes visible again, so the board never needs a manual
  // reload to catch up. The visibility-aware hook avoids background API traffic.
  useVisibleInterval(() => {
    void fetchData(true);
  }, 30_000);

  const decide = useCallback(
    async (id: string, action: "ACCEPT" | "REJECT") => {
      setActing(id);
      try {
        await api("/api/v1/wallets/transfer", { method: "PATCH", body: { id, action } });
        await fetchData();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to update transfer");
      } finally {
        setActing(null);
      }
    },
    [fetchData],
  );

  const pendingIncoming = incoming.filter((t) => t.status === "PENDING");
  const decidedIncoming = incoming
    .filter((t) => t.status !== "PENDING")
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

  // The viewer's own wallet row (for available balances when forwarding).
  const myWallet = wallets.find((w) => w.user_id === me?.id);
  const myAvailable = myWallet
    ? { cash: myWallet.cash_balance, bank: myWallet.bank_balance, coupon: myWallet.coupon_balance }
    : undefined;

  const openHistory = useCallback((wallet: WalletData) => {
    setSelectedWallet(wallet);
    setHistoryOpen(true);
  }, []);

  // System-wide treasury totals (every wallet folded together).
  const treasury = wallets.reduce(
    (acc, w) => ({
      cash: acc.cash + (w.cash_balance || 0),
      bank: acc.bank + (w.bank_balance || 0),
      coupon: acc.coupon + (w.coupon_balance || 0),
      total: acc.total + (w.balance || 0),
    }),
    { cash: 0, bank: 0, coupon: 0, total: 0 },
  );

  // The set of wallets the balances board is allowed to render. Admins/super
  // admins see everyone. An account manager sees ONLY their own wallet plus
  // every salesman's — never the admin's or another account manager's balance.
  const boardWallets = isAccountsManager
    ? wallets.filter((w) => w.user_id === me?.id || w.role_name === "SALESMAN")
    : wallets;

  // Highlighted custodians (admins + accountants), richest first.
  const custodians = boardWallets
    .filter((w) => HIGHLIGHT_ROLES.includes(w.role_name))
    .sort((a, b) => {
      const ra = HIGHLIGHT_ROLES.indexOf(a.role_name);
      const rb = HIGHLIGHT_ROLES.indexOf(b.role_name);
      if (ra !== rb) return ra - rb;
      return b.balance - a.balance;
    });

  // Everyone else, grouped by role (salesmen first), richest first within a role.
  const standardWallets = boardWallets.filter((w) => !HIGHLIGHT_ROLES.includes(w.role_name));
  const standardGrouped = standardWallets.reduce((acc, w) => {
    (acc[w.role_name] ||= []).push(w);
    return acc;
  }, {} as Record<string, WalletData[]>);
  const standardRoleOrder = Object.keys(standardGrouped).sort((a, b) => {
    if (a === "SALESMAN") return -1;
    if (b === "SALESMAN") return 1;
    return a.localeCompare(b);
  });
  for (const role of standardRoleOrder) standardGrouped[role].sort((a, b) => b.balance - a.balance);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <Loader2 className="w-8 h-8 text-amber-500 animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6" style={{ fontFamily: "'Inter','system-ui',sans-serif" }}>
      {/* ───────────────── Top view switch: Wallet | Internal Finances ───────────────── */}
      <div className="inline-flex rounded-2xl border border-black/[0.06] bg-white p-1 shadow-sm">
        <button
          onClick={() => setView("wallet")}
          className={`flex items-center gap-1.5 px-4 py-2 rounded-xl font-semibold transition-all ${view === "wallet" ? "bg-zinc-900 text-white shadow" : "text-zinc-500 hover:text-zinc-800"}`}
          style={{ fontSize: "0.8rem", cursor: "pointer", fontFamily: "inherit", border: "none" }}
        >
          <Wallet className="w-4 h-4" /> Wallets
        </button>
        <button
          onClick={() => setView("finances")}
          className={`flex items-center gap-1.5 px-4 py-2 rounded-xl font-semibold transition-all ${view === "finances" ? "bg-zinc-900 text-white shadow" : "text-zinc-500 hover:text-zinc-800"}`}
          style={{ fontSize: "0.8rem", cursor: "pointer", fontFamily: "inherit", border: "none" }}
        >
          <Receipt className="w-4 h-4" /> Balance Sheet
        </button>
        {!isSalesman && (
          <button
            onClick={() => setView("vendors")}
            className={`flex items-center gap-1.5 px-4 py-2 rounded-xl font-semibold transition-all ${view === "vendors" ? "bg-zinc-900 text-white shadow" : "text-zinc-500 hover:text-zinc-800"}`}
            style={{ fontSize: "0.8rem", cursor: "pointer", fontFamily: "inherit", border: "none" }}
          >
            <Building2 className="w-4 h-4" /> Vendors
          </button>
        )}
      </div>

      {!isSalesman && view === "vendors" && <VendorsTreasury />}

      {view === "finances" && (
        <BalanceSheet
          wallets={wallets}
          onAddExpense={normalizedRole === "SUPER_ADMIN" ? undefined : () => setExpenseOpen(true)}
          expenseActionLabel={isCompanyAdmin ? "Add Expense" : "Request Expense"}
          onViewExpenseRequests={canViewAllExpenseRequests ? () => window.location.assign("/dashboard/expenses") : undefined}
          reloadToken={financeReload}
        />
      )}

      {view === "wallet" && (
      <>
      {/* ---------------------------- Treasury hero (admins only) ---------------------------- */}
      {!isAccountsManager && (
      <div className="relative overflow-hidden rounded-2xl border border-black/[0.06] bg-gradient-to-br from-white via-amber-50/50 to-orange-50/30 p-6 shadow-[0_12px_40px_rgba(0,0,0,0.05)]">
        <div className="absolute -right-12 -top-12 h-40 w-40 rounded-full bg-amber-300/25 blur-3xl" />
        <div className="absolute -left-10 -bottom-12 h-32 w-32 rounded-full bg-orange-200/25 blur-2xl" />
        <div className="relative flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <div className="inline-flex items-center gap-1.5 rounded-full border border-amber-200/70 bg-white/70 px-2.5 py-1 text-amber-700" style={{ fontSize: "0.62rem", fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase" }}>
              <Wallet className="w-3 h-3" /> Treasury Overview
            </div>
            <h1 className="text-zinc-900 font-semibold tracking-tight mt-2.5" style={{ fontSize: "1.7rem", marginBottom: "0.3rem" }}>
              User Wallets
            </h1>
            <p className="text-zinc-600" style={{ fontSize: "0.86rem", margin: 0 }}>
              Live, individual wallet balances across every Salesman, Financier / Accountant and Admin.
            </p>
          </div>
          <div className="shrink-0 lg:text-right">
            <div className="text-zinc-500" style={{ fontSize: "0.64rem", textTransform: "uppercase", letterSpacing: "0.14em" }}>
              Total Held Across All Wallets
            </div>
            <div className="font-mono font-bold tracking-tight text-zinc-900" style={{ fontSize: "2.1rem", lineHeight: 1.1, marginTop: 2 }}>
              {fmt(treasury.total)}
            </div>
          </div>
        </div>

        {/* bucket + headcount strip */}
        <div className="relative grid grid-cols-2 sm:grid-cols-4 gap-2.5 mt-5">
          {[
            { icon: <Banknote className="w-3.5 h-3.5 text-emerald-500" />, label: "Cash", value: fmt(treasury.cash) },
            { icon: <Building2 className="w-3.5 h-3.5 text-blue-500" />, label: "Bank", value: fmt(treasury.bank) },
            { icon: <Tag className="w-3.5 h-3.5 text-violet-500" />, label: "Coupon", value: fmt(treasury.coupon) },
            { icon: <Users className="w-3.5 h-3.5 text-amber-600" />, label: "Wallets", value: String(wallets.length) },
          ].map((s) => (
            <div key={s.label} className="rounded-xl border border-black/[0.05] bg-white/80 backdrop-blur-sm px-3 py-2.5 shadow-sm">
              <div className="flex items-center gap-1.5 text-zinc-400" style={{ fontSize: "0.6rem", textTransform: "uppercase", letterSpacing: "0.1em" }}>
                {s.icon}
                {s.label}
              </div>
              <div className="font-mono font-semibold text-zinc-900 mt-1 truncate" style={{ fontSize: "0.95rem" }}>
                {s.value}
              </div>
            </div>
          ))}
        </div>
      </div>
      )}

      {error && (
        <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-500" style={{ fontSize: "0.78rem" }}>
          {error}
        </div>
      )}

      {/* Tabs: Balances | Incoming Transfers (+ pending badge) */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="inline-flex rounded-xl border border-black/[0.06] bg-white p-1 shadow-sm">
          <button
            onClick={() => setTab("balances")}
            className={`px-3.5 py-1.5 rounded-lg font-semibold transition-all ${tab === "balances" ? "bg-zinc-900 text-white" : "text-zinc-500 hover:text-zinc-800"}`}
            style={{ fontSize: "0.76rem", cursor: "pointer", fontFamily: "inherit", border: "none" }}
          >
            Balances
          </button>
          <button
            onClick={() => setTab("incoming")}
            className={`px-3.5 py-1.5 rounded-lg font-semibold transition-all flex items-center gap-1.5 ${tab === "incoming" ? "bg-zinc-900 text-white" : "text-zinc-500 hover:text-zinc-800"}`}
            style={{ fontSize: "0.76rem", cursor: "pointer", fontFamily: "inherit", border: "none" }}
          >
            <ArrowDownToLine className="w-3.5 h-3.5" /> Incoming Transfers
            {pendingIncoming.length > 0 && (
              <span className="inline-flex items-center justify-center min-w-[1.1rem] h-[1.1rem] px-1 rounded-full bg-amber-500 text-zinc-900 font-bold" style={{ fontSize: "0.62rem" }}>
                {pendingIncoming.length}
              </span>
            )}
          </button>
        </div>
        {canForward && (
          <button
            onClick={() => setTransferOpen(true)}
            className="flex items-center gap-2 px-3.5 py-2 rounded-lg bg-zinc-900 text-white font-semibold hover:bg-zinc-800 transition-all"
            style={{ cursor: "pointer", fontFamily: "inherit", fontSize: "0.76rem", border: "none" }}
          >
            <Send className="w-3.5 h-3.5" /> Transfer to Admin
          </button>
        )}
      </div>

      {tab === "balances" && (
        <>
          {wallets.length === 0 && (
            <div className="rounded-2xl border border-black/[0.06] bg-white text-center py-20 text-zinc-500">
              <Wallet className="w-12 h-12 mx-auto mb-4 opacity-30" />
              <p style={{ fontSize: "0.875rem" }}>No wallets found</p>
            </div>
          )}

          {/* Highlighted custodians — admins & accountants */}
          {custodians.length > 0 && (
            <section>
              <div className="flex items-center gap-2.5 mb-3.5 px-1">
                <div className="p-2 rounded-xl border border-black/5 shadow-sm bg-zinc-900 text-amber-300">
                  <ShieldCheck className="w-4 h-4" />
                </div>
                <div>
                  <h2 className="text-lg font-semibold text-zinc-900 tracking-tight leading-tight">Custodians</h2>
                  <p className="text-zinc-500 leading-tight" style={{ fontSize: "0.72rem" }}>Admin &amp; Financier / Accountant wallets</p>
                </div>
                <span className="ml-auto text-xs text-zinc-500 rounded-full border border-black/5 bg-white px-3 py-1.5 shadow-sm">
                  Held{" "}
                  <span className="font-semibold text-zinc-900 ml-1 text-sm">
                    {fmt(custodians.reduce((s, w) => s + w.balance, 0))}
                  </span>
                </span>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                {custodians.map((wallet) => {
                  const config = roleConfig[wallet.role_name] || fallbackRole(wallet.role_name);
                  const theme = custodianTheme[wallet.role_name] || custodianTheme.ADMIN;
                  return (
                    <CustodianCard
                      key={wallet.user_id}
                      wallet={wallet}
                      config={config}
                      theme={theme}
                      onHistory={openHistory}
                      isMe={wallet.user_id === me?.id}
                    />
                  );
                })}
              </div>
            </section>
          )}

          {/* Everyone else — one card per person */}
          {standardRoleOrder.map((role) => {
            const roleWallets = standardGrouped[role];
            if (!roleWallets || roleWallets.length === 0) return null;
            const config = roleConfig[role] || fallbackRole(role);
            const total = roleWallets.reduce((s, w) => s + w.balance, 0);
            return (
              <section key={role}>
                <div className="flex items-center gap-2.5 mb-3.5 px-1">
                  <div className="p-2 rounded-xl border border-black/5 shadow-sm" style={{ background: config.bg, color: config.color }}>
                    {config.icon}
                  </div>
                  <h2 className="text-lg font-semibold text-zinc-900 tracking-tight">{config.plural}</h2>
                  <span className="inline-flex items-center rounded-full bg-zinc-100 text-zinc-600 px-2 py-0.5 text-xs font-medium">{roleWallets.length}</span>
                  {/* Accountants see individual salesman wallets but never the org-wide roll-up total. */}
                  {!isAccountsManager && (
                    <span className="ml-auto text-xs text-zinc-500 rounded-full border border-black/5 bg-white px-3 py-1.5 shadow-sm">
                      Total Balance <span className="font-semibold text-zinc-900 ml-1 text-sm">{fmt(total)}</span>
                    </span>
                  )}
                </div>
                <div
                  className={`grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3.5${
                    roleWallets.length > 6
                      ? " max-h-[clamp(420px,62vh,560px)] overflow-y-auto pr-1 -mr-1 overscroll-contain"
                      : ""
                  }`}
                >
                  {roleWallets.map((wallet) => (
                    <WalletCard
                      key={wallet.user_id}
                      wallet={wallet}
                      config={config}
                      onHistory={openHistory}
                      isMe={wallet.user_id === me?.id}
                    />
                  ))}
                </div>
              </section>
            );
          })}
        </>
      )}

      {tab === "incoming" && (
        <div className="space-y-6">
          {/* Pending — awaiting your approval */}
          <section>
            <div className="flex items-center gap-2.5 mb-3 px-1.5">
              <div className="p-2 rounded-xl border border-black/5 shadow-sm bg-amber-500/10 text-amber-600">
                <Clock className="w-4 h-4" />
              </div>
              <h2 className="text-lg font-semibold text-zinc-900 tracking-tight">Pending Approval</h2>
              <span className="inline-flex items-center rounded-full bg-zinc-100 text-zinc-600 px-2 py-0.5 text-xs font-medium">{pendingIncoming.length}</span>
            </div>

            {pendingIncoming.length === 0 ? (
              <div className="rounded-2xl border border-black/[0.06] bg-white text-center py-14 text-zinc-500">
                <ArrowDownToLine className="w-10 h-10 mx-auto mb-3 opacity-30" />
                <p style={{ fontSize: "0.85rem" }}>No transfers waiting for your approval</p>
              </div>
            ) : (
              <div className="space-y-2.5">
                {pendingIncoming.map((t) => (
                  <div key={t.id} className="rounded-2xl border border-black/[0.06] bg-white p-4 shadow-[0_8px_28px_rgba(0,0,0,0.04)] flex items-center gap-4 flex-wrap">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold text-zinc-900" style={{ fontSize: "0.92rem" }}>{fmt(t.amount)}</span>
                        <span className="px-1.5 py-0.5 rounded text-[0.6rem] font-semibold bg-zinc-100 text-zinc-600">{bucketLabel[t.bucket]}</span>
                      </div>
                      <div className="text-zinc-500 mt-1" style={{ fontSize: "0.76rem" }}>
                        From <span className="font-medium text-zinc-700">{t.counterparty_name || "User"}</span>
                        {" · "}{new Date(t.created_at).toLocaleString("en-IN")}
                      </div>
                      {t.note && <div className="text-zinc-400 mt-0.5" style={{ fontSize: "0.72rem" }}>{t.note}</div>}
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => decide(t.id, "REJECT")}
                        disabled={acting === t.id}
                        className="px-3 py-2 rounded-lg border border-red-200 text-red-600 hover:bg-red-50 font-semibold flex items-center gap-1.5 disabled:opacity-50"
                        style={{ fontSize: "0.74rem", cursor: "pointer", fontFamily: "inherit", background: "#fff" }}
                      >
                        <X className="w-3.5 h-3.5" /> Reject
                      </button>
                      <button
                        onClick={() => decide(t.id, "ACCEPT")}
                        disabled={acting === t.id}
                        className="px-3 py-2 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 font-semibold flex items-center gap-1.5 disabled:opacity-50"
                        style={{ fontSize: "0.74rem", cursor: "pointer", fontFamily: "inherit", border: "none" }}
                      >
                        {acting === t.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />} Accept
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Decided history */}
          {decidedIncoming.length > 0 && (
            <section>
              <div className="flex items-center gap-2.5 mb-3 px-1.5">
                <div className="p-2 rounded-xl border border-black/5 shadow-sm bg-zinc-100 text-zinc-500">
                  <History className="w-4 h-4" />
                </div>
                <h2 className="text-lg font-semibold text-zinc-900 tracking-tight">History</h2>
              </div>
              <div className="rounded-2xl border border-black/[0.06] overflow-hidden bg-white shadow-[0_14px_40px_rgba(0,0,0,0.06)] divide-y divide-black/[0.04]">
                {decidedIncoming.map((t) => {
                  const chip = transferStatusChip[t.status];
                  return (
                    <div key={t.id} className="flex items-center gap-3 px-4 py-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-semibold text-zinc-800" style={{ fontSize: "0.84rem" }}>{fmt(t.amount)}</span>
                          <span className="px-1.5 py-0.5 rounded text-[0.58rem] font-semibold bg-zinc-100 text-zinc-600">{bucketLabel[t.bucket]}</span>
                          <span className={`px-1.5 py-0.5 rounded text-[0.58rem] font-semibold ${chip.cls}`}>{chip.label}</span>
                        </div>
                        <div className="text-zinc-500 mt-0.5" style={{ fontSize: "0.72rem" }}>
                          From {t.counterparty_name || "User"} · {new Date(t.created_at).toLocaleDateString("en-IN")}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          )}
        </div>
      )}
      </>
      )}

      <TransferModal
        open={transferOpen}
        onClose={() => setTransferOpen(false)}
        onDone={fetchData}
        defaultBucket="cash"
        available={myAvailable}
      />

      <ExpenseModal
        open={expenseOpen}
        onClose={() => setExpenseOpen(false)}
        onDone={() => { fetchData(); setFinanceReload((n) => n + 1); }}
        // Only ever the actor's OWN wallet — no one (admin or accountant) can see
        // or charge another user's wallet. The server enforces this too.
        wallets={myWallet ? [myWallet] : []}
        defaultUserId={me?.id ?? null}
        requiresApproval={!isCompanyAdmin}
      />

      <WalletHistoryDrawer
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        userId={selectedWallet?.user_id || null}
        userName={selectedWallet?.user_name || "User"}
        roleName={selectedWallet?.role_name || ""}
        currentBalance={selectedWallet?.balance ?? null}
      />
    </div>
  );
}
