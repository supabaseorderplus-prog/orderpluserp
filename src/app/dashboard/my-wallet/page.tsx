"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { api, getUser } from "@/lib/api";
import TransferModal, { type TransferBucket } from "@/components/wallet/TransferModal";
import {
  ArrowDownLeft,
  ArrowUpRight,
  Banknote,
  Building2,
  ChevronDown,
  CreditCard,
  Loader2,
  RefreshCw,
  ReceiptIndianRupee,
  Send,
  Tag,
  Wallet,
} from "lucide-react";

interface Payment {
  id: string;
  amount: number;
  payment_mode: string;
  payment_date: string;
  reference_number: string | null;
  bank_name: string | null;
  notes: string | null;
  party_id: string;
}

interface OutgoingTransfer {
  id: string;
  bucket: TransferBucket;
  amount: number;
  status: "PENDING" | "ACCEPTED" | "REJECTED" | "CANCELLED";
  note: string | null;
  created_at: string;
  counterparty_name: string | null;
}

interface WalletExpense {
  id: string;
  bucket: TransferBucket;
  requested_amount: number;
  approved_amount: number | null;
  category: string;
  status: "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED";
  created_at: string;
  is_mine: boolean;
}

interface PartyMap {
  [id: string]: string;
}

interface BucketTotals {
  cash: number;
  bank: number;
  coupon: number;
}

const CASH_MODES = ["CASH"];
const COUPON_MODES = ["COUPON", "VOUCHER", "TOKEN"];

function walletType(mode: string): TransferBucket {
  const m = (mode || "").toUpperCase();
  if (CASH_MODES.includes(m)) return "cash";
  if (COUPON_MODES.includes(m)) return "coupon";
  return "bank";
}

const fmt = (n: number) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(n);

const fmtDate = (d: string) =>
  new Date(d).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });

const walletConfig = {
  cash: { label: "Cash Wallet", icon: Banknote, color: "text-emerald-600", bg: "bg-emerald-500/10", border: "border-emerald-500/20", ring: "ring-emerald-500/30", dot: "bg-emerald-500", badge: "bg-emerald-100 text-emerald-700" },
  bank: { label: "Bank Wallet", icon: Building2, color: "text-blue-600", bg: "bg-blue-500/10", border: "border-blue-500/20", ring: "ring-blue-500/30", dot: "bg-blue-500", badge: "bg-blue-100 text-blue-700" },
  coupon: { label: "Coupon Wallet", icon: Tag, color: "text-violet-600", bg: "bg-violet-500/10", border: "border-violet-500/20", ring: "ring-violet-500/30", dot: "bg-violet-500", badge: "bg-violet-100 text-violet-700" },
};

const statusChip: Record<OutgoingTransfer["status"], { label: string; cls: string }> = {
  PENDING: { label: "Pending approval", cls: "bg-amber-100 text-amber-700" },
  ACCEPTED: { label: "Accepted", cls: "bg-emerald-100 text-emerald-700" },
  REJECTED: { label: "Rejected", cls: "bg-red-100 text-red-700" },
  CANCELLED: { label: "Cancelled", cls: "bg-zinc-100 text-zinc-500" },
};

export default function MyWalletPage() {
  const user = getUser();
  const [payments, setPayments] = useState<Payment[]>([]);
  // Uncapped, server-computed collected totals (cash/bank/coupon). The payments
  // list below is paginated/capped for display, but the wallet BALANCE must equal
  // every collection — so it comes from here, not from summing the capped page.
  const [serverTotals, setServerTotals] = useState<BucketTotals | null>(null);
  const [serverCounts, setServerCounts] = useState<BucketTotals | null>(null);
  const [transfers, setTransfers] = useState<OutgoingTransfer[]>([]);
  const [expenses, setExpenses] = useState<WalletExpense[]>([]);
  const [partyNames, setPartyNames] = useState<PartyMap>({});
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<"all" | TransferBucket>("all");
  const [modalOpen, setModalOpen] = useState(false);
  const [modalBucket, setModalBucket] = useState<TransferBucket>("cash");
  const [modalLock, setModalLock] = useState(false);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [showTransit, setShowTransit] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [paymentsRes, partiesRes, transfersRes, expensesRes] = await Promise.all([
        api<{ success: boolean; data: Payment[]; walletTotals?: BucketTotals; walletCounts?: BucketTotals }>(`/api/v1/payments?limit=500&mine=true`),
        api<{ success: boolean; data: { id: string; name: string }[] }>(`/api/v1/parties?limit=500`)
          .catch(() => ({ success: true, data: [] as { id: string; name: string }[] })),
        api<{ success: boolean; data: OutgoingTransfer[] }>(`/api/v1/wallets/transfer?box=outgoing`)
          .catch(() => ({ success: true, data: [] as OutgoingTransfer[] })),
        api<{ success: boolean; data: WalletExpense[] }>(`/api/v1/expenses`, { noCache: true })
          .catch(() => ({ success: true, data: [] as WalletExpense[] })),
      ]);

      const nameMap: PartyMap = {};
      for (const p of partiesRes.data || []) nameMap[p.id] = p.name;
      setPartyNames(nameMap);
      setPayments(paymentsRes.data || []);
      setServerTotals(paymentsRes.walletTotals ?? null);
      setServerCounts(paymentsRes.walletCounts ?? null);
      setTransfers(transfersRes.data || []);
      setExpenses((expensesRes.data || []).filter((expense) => expense.is_mine));
    } catch {
      setPayments([]);
      setServerTotals(null);
      setServerCounts(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    window.addEventListener("paymentRecorded", load);
    window.addEventListener("expenseChanged", load);
    return () => {
      window.removeEventListener("paymentRecorded", load);
      window.removeEventListener("expenseChanged", load);
    };
  }, [load]);

  const cash = payments.filter((p) => walletType(p.payment_mode) === "cash");
  const bank = payments.filter((p) => walletType(p.payment_mode) === "bank");
  const coupon = payments.filter((p) => walletType(p.payment_mode) === "coupon");

  // Prefer the uncapped server totals; fall back to summing the (capped) page only
  // when the endpoint did not return them. This keeps the wallet balance equal to
  // the admin Wallets board even for salesmen with more than 500 collections.
  const collected: BucketTotals = serverTotals ?? {
    cash: cash.reduce((s, p) => s + Number(p.amount), 0),
    bank: bank.reduce((s, p) => s + Number(p.amount), 0),
    coupon: coupon.reduce((s, p) => s + Number(p.amount), 0),
  };
  // Collection counts: server-side (uncapped) when available, else the page length.
  const counts: BucketTotals = serverCounts ?? {
    cash: cash.length,
    bank: bank.length,
    coupon: coupon.length,
  };
  const totalCollections = counts.cash + counts.bank + counts.coupon;

  // `held` = money subtracted from the available balance. A transfer leaves the
  // wallet the moment it is initiated (PENDING) and stays gone once ACCEPTED
  // (delivered to the recipient). REJECTED/CANCELLED return it.
  const held = { cash: 0, bank: 0, coupon: 0 };
  // `inTransitAmt` = money still AWAITING approval (PENDING only). Once a transfer
  // is ACCEPTED the money has arrived — it is delivered, not in transit.
  const inTransitAmt = { cash: 0, bank: 0, coupon: 0 };
  for (const t of transfers) {
    const amt = Number(t.amount) || 0;
    if (t.status === "PENDING" || t.status === "ACCEPTED") held[t.bucket] += amt;
    if (t.status === "PENDING") inTransitAmt[t.bucket] += amt;
  }
  const expenseHeld = { cash: 0, bank: 0, coupon: 0 };
  const expenseInTransit = { cash: 0, bank: 0, coupon: 0 };
  const pendingExpenses = expenses.filter((expense) => expense.status === "PENDING");
  for (const expense of expenses) {
    const debit = expense.status === "PENDING"
      ? Number(expense.requested_amount) || 0
      : expense.status === "APPROVED"
        ? Number(expense.approved_amount) || 0
        : 0;
    expenseHeld[expense.bucket] += debit;
    if (expense.status === "PENDING") expenseInTransit[expense.bucket] += debit;
  }
  const available = {
    cash: collected.cash - held.cash - expenseHeld.cash,
    bank: collected.bank - held.bank - expenseHeld.bank,
    coupon: collected.coupon - held.coupon - expenseHeld.coupon,
  };
  const grandAvailable = available.cash + available.bank + available.coupon;
  const totalInTransit = inTransitAmt.cash + inTransitAmt.bank + inTransitAmt.coupon
    + expenseInTransit.cash + expenseInTransit.bank + expenseInTransit.coupon;

  // The transfers behind the "in transit" total: money still awaiting approval.
  // ACCEPTED (delivered) and REJECTED/CANCELLED (returned) are excluded.
  const inTransit = transfers
    .filter((t) => t.status === "PENDING")
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

  const outgoingActive = transfers
    .slice()
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

  const displayed =
    activeTab === "cash" ? cash : activeTab === "bank" ? bank : activeTab === "coupon" ? coupon : payments;

  const openTransfer = (bucket?: TransferBucket) => {
    if (bucket) {
      setModalBucket(bucket);
      setModalLock(true);
    } else {
      setModalBucket("cash");
      setModalLock(false);
    }
    setModalOpen(true);
  };

  const cancelTransfer = async (id: string) => {
    setCancelling(id);
    try {
      await api("/api/v1/wallets/transfer", { method: "PATCH", body: { id, action: "CANCEL" } });
      await load();
    } catch {
      /* surfaced on next load */
    } finally {
      setCancelling(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <Loader2 className="w-7 h-7 text-amber-500 animate-spin" />
      </div>
    );
  }

  return (
    <div style={{ fontFamily: "'Inter','system-ui',sans-serif" }}>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-zinc-900 mb-0.5">My Wallet</h1>
          <p className="text-zinc-500" style={{ fontSize: "0.75rem" }}>Collections by mode · transfer to financer or admin</p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/dashboard/expenses"
            className="flex items-center gap-2 rounded-lg bg-amber-500 px-3 py-2 text-white font-semibold hover:bg-amber-600 transition-all"
            style={{ fontSize: "0.75rem" }}
          >
            <ReceiptIndianRupee className="w-3.5 h-3.5" /> Expense
          </Link>
          <button
            onClick={() => openTransfer()}
            className="flex items-center gap-2 px-3 py-2 rounded-lg bg-zinc-900 text-white font-semibold hover:bg-zinc-800 transition-all"
            style={{ cursor: "pointer", fontFamily: "inherit", fontSize: "0.75rem", border: "none" }}
          >
            <Send className="w-3.5 h-3.5" /> Transfer
          </button>
          <button
            onClick={load}
            className="flex items-center gap-2 px-3 py-2 rounded-lg border border-black/10 text-zinc-500 hover:text-zinc-800 hover:bg-black/5 transition-all"
            style={{ background: "none", border: "1px solid rgba(0,0,0,0.08)", cursor: "pointer", fontFamily: "inherit", fontSize: "0.75rem" }}
          >
            <RefreshCw className="w-3.5 h-3.5" /> Refresh
          </button>
        </div>
      </div>

      {/* Total Balance Banner */}
      <div className="relative rounded-2xl bg-gradient-to-br from-zinc-900 to-zinc-800 p-5 mb-6 flex items-center gap-4">
        <div className="w-12 h-12 rounded-xl bg-amber-500/20 border border-amber-500/30 flex items-center justify-center shrink-0">
          <Wallet className="w-6 h-6 text-amber-400" />
        </div>
        <div>
          <div className="text-zinc-400 text-xs mb-0.5">Available Balance</div>
          <div className="text-3xl font-bold text-white tabular-nums">{fmt(grandAvailable)}</div>
          <div className="text-zinc-500 text-xs mt-0.5">
            {totalCollections} collection{totalCollections !== 1 ? "s" : ""}
            {totalInTransit > 0 && (
              <>
                {" · "}
                <button
                  type="button"
                  onClick={() => setShowTransit((v) => !v)}
                  className="inline-flex items-center gap-0.5 text-amber-400/90 hover:text-amber-300 underline decoration-dotted underline-offset-2"
                  style={{ background: "none", border: "none", padding: 0, cursor: "pointer", fontFamily: "inherit", fontSize: "inherit" }}
                >
                  {fmt(totalInTransit)} in transit
                  <ChevronDown className={`w-3 h-3 transition-transform ${showTransit ? "rotate-180" : ""}`} />
                </button>
              </>
            )}
          </div>
        </div>
        <div className="ml-auto flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-amber-500/10 border border-amber-500/20">
          <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
          <span className="text-amber-400 font-medium" style={{ fontSize: "0.7rem" }}>{user?.name}</span>
        </div>

        {/* In-transit detail popover */}
        {showTransit && totalInTransit > 0 && (
          <>
            <button
              type="button"
              aria-label="Close in-transit details"
              onClick={() => setShowTransit(false)}
              className="fixed inset-0 z-20"
              style={{ background: "transparent", border: "none", cursor: "default" }}
            />
            <div className="absolute left-4 right-4 sm:left-16 sm:right-auto sm:w-80 top-full mt-2 z-30 rounded-xl border border-black/10 bg-white shadow-xl overflow-hidden">
              <div className="px-3 py-2 border-b border-black/[0.06] flex items-center justify-between">
                <span className="font-semibold text-zinc-800" style={{ fontSize: "0.72rem" }}>In transit — {fmt(totalInTransit)}</span>
                <span className="text-zinc-400" style={{ fontSize: "0.6rem" }}>{inTransit.length + pendingExpenses.length} item{inTransit.length + pendingExpenses.length !== 1 ? "s" : ""}</span>
              </div>
              <div className="max-h-64 overflow-y-auto divide-y divide-black/[0.04]">
                {inTransit.map((t) => {
                  const cfg = walletConfig[t.bucket];
                  const chip = statusChip[t.status];
                  return (
                    <div key={t.id} className="flex items-center gap-2.5 px-3 py-2.5">
                      <div className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${cfg.bg}`}>
                        <cfg.icon className={`w-3.5 h-3.5 ${cfg.color}`} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="font-medium text-zinc-800 truncate" style={{ fontSize: "0.74rem" }}>
                          To {t.counterparty_name || "User"}
                        </div>
                        <div className="flex items-center gap-1.5 mt-0.5">
                          <span className={`px-1 py-0.5 rounded text-[0.55rem] font-semibold ${chip.cls}`}>{chip.label}</span>
                          <span className="text-zinc-400" style={{ fontSize: "0.6rem" }}>{fmtDate(t.created_at)}</span>
                        </div>
                      </div>
                      <span className={`font-bold tabular-nums shrink-0 ${cfg.color}`} style={{ fontSize: "0.78rem" }}>{fmt(Number(t.amount))}</span>
                    </div>
                  );
                })}
                {pendingExpenses.map((expense) => {
                  const cfg = walletConfig[expense.bucket];
                  return (
                    <Link key={expense.id} href="/dashboard/expenses" className="flex items-center gap-2.5 px-3 py-2.5 hover:bg-amber-50/50">
                      <div className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${cfg.bg}`}>
                        <ReceiptIndianRupee className={`w-3.5 h-3.5 ${cfg.color}`} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="font-medium text-zinc-800 truncate" style={{ fontSize: "0.74rem" }}>{expense.category} expense</div>
                        <div className="mt-0.5 text-amber-600" style={{ fontSize: "0.6rem" }}>Awaiting expense approval</div>
                      </div>
                      <span className={`font-bold tabular-nums shrink-0 ${cfg.color}`} style={{ fontSize: "0.78rem" }}>{fmt(expense.requested_amount)}</span>
                    </Link>
                  );
                })}
              </div>
            </div>
          </>
        )}
      </div>

      {/* 3 Wallet Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
        {(["cash", "bank", "coupon"] as const).map((type) => {
          const cfg = walletConfig[type];
          const Icon = cfg.icon;
          const avail = available[type];
          const transitAmt = inTransitAmt[type] + expenseInTransit[type];
          const count = counts[type];
          const isActive = activeTab === type;
          return (
            <div
              key={type}
              className={`rounded-2xl border p-4 transition-all ${
                isActive ? `${cfg.bg} ${cfg.border} ring-2 ${cfg.ring}` : "bg-white border-black/[0.06]"
              }`}
              style={{ background: isActive ? undefined : "#ffffff" }}
            >
              <button
                onClick={() => setActiveTab(isActive ? "all" : type)}
                className="w-full text-left"
                style={{ background: "none", border: "none", cursor: "pointer", fontFamily: "inherit", padding: 0 }}
              >
                <div className="flex items-center gap-2.5 mb-3">
                  <div className={`w-9 h-9 rounded-xl flex items-center justify-center ${cfg.bg} ${cfg.border} border`}>
                    <Icon className={`w-4.5 h-4.5 ${cfg.color}`} />
                  </div>
                  <div>
                    <div className="font-semibold text-zinc-900" style={{ fontSize: "0.82rem" }}>{cfg.label}</div>
                    <div className="text-zinc-400" style={{ fontSize: "0.62rem" }}>{count} collection{count !== 1 ? "s" : ""}</div>
                  </div>
                </div>
                <div className={`text-2xl font-bold tabular-nums ${cfg.color}`}>{fmt(avail)}</div>
                <div className="mt-1.5 flex items-center gap-1.5">
                  <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot}`} />
                  <span className="text-zinc-400" style={{ fontSize: "0.6rem" }}>
                    {transitAmt > 0 ? `${fmt(transitAmt)} in transit` : "Available to transfer"}
                  </span>
                </div>
              </button>
              <button
                onClick={() => openTransfer(type)}
                disabled={avail <= 0}
                className="mt-3 w-full flex items-center justify-center gap-1.5 py-2 rounded-lg border border-black/10 text-zinc-700 hover:bg-black/[0.03] font-semibold disabled:opacity-40"
                style={{ fontSize: "0.72rem", cursor: avail > 0 ? "pointer" : "not-allowed", fontFamily: "inherit", background: "#fff" }}
              >
                <Send className="w-3 h-3" /> Transfer {cfg.label.replace(" Wallet", "")}
              </button>
            </div>
          );
        })}
      </div>

      {/* Outgoing Transfers */}
      {outgoingActive.length > 0 && (
        <div className="rounded-2xl border border-black/[0.06] bg-white overflow-hidden mb-6">
          <div className="px-4 py-3 border-b border-black/[0.06] flex items-center gap-2">
            <ArrowUpRight className="w-4 h-4 text-zinc-500" />
            <span className="font-semibold text-zinc-800" style={{ fontSize: "0.82rem" }}>Outgoing Transfers</span>
            <span className="px-1.5 py-0.5 rounded-full bg-black/5 text-zinc-500" style={{ fontSize: "0.6rem" }}>{outgoingActive.length}</span>
          </div>
          <div className="divide-y divide-black/[0.04]">
            {outgoingActive.map((t) => {
              const cfg = walletConfig[t.bucket];
              const chip = statusChip[t.status];
              return (
                <div key={t.id} className="flex items-center gap-3 px-4 py-3">
                  <div className={`w-8 h-8 rounded-xl flex items-center justify-center shrink-0 ${cfg.bg}`}>
                    <cfg.icon className={`w-3.5 h-3.5 ${cfg.color}`} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-zinc-800" style={{ fontSize: "0.8rem" }}>
                        To {t.counterparty_name || "User"}
                      </span>
                      <span className={`px-1.5 py-0.5 rounded text-[0.58rem] font-semibold ${chip.cls}`}>{chip.label}</span>
                    </div>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="text-zinc-400" style={{ fontSize: "0.65rem" }}>{fmtDate(t.created_at)}</span>
                      {t.note && (
                        <>
                          <span className="text-zinc-200">·</span>
                          <span className="text-zinc-400" style={{ fontSize: "0.62rem" }}>{t.note}</span>
                        </>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className={`font-bold tabular-nums ${cfg.color}`} style={{ fontSize: "0.85rem" }}>{fmt(Number(t.amount))}</span>
                    {t.status === "PENDING" && (
                      <button
                        onClick={() => cancelTransfer(t.id)}
                        disabled={cancelling === t.id}
                        className="px-2 py-1 rounded-md border border-red-200 text-red-600 hover:bg-red-50 font-medium disabled:opacity-50"
                        style={{ fontSize: "0.66rem", cursor: "pointer", fontFamily: "inherit", background: "#fff" }}
                      >
                        {cancelling === t.id ? "…" : "Cancel"}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Transactions */}
      <div className="rounded-2xl border border-black/[0.06] bg-white overflow-hidden">
        <div className="flex border-b border-black/[0.06]">
          {(["all", "cash", "bank", "coupon"] as const).map((tab) => {
            const label = tab === "all" ? "All" : walletConfig[tab].label.replace(" Wallet", "");
            const count = tab === "all" ? payments.length : tab === "cash" ? cash.length : tab === "bank" ? bank.length : coupon.length;
            return (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`flex-1 py-3 flex items-center justify-center gap-1.5 transition-all ${
                  activeTab === tab ? "border-b-2 border-amber-500 text-amber-600 bg-amber-500/5" : "text-zinc-500 hover:text-zinc-700"
                }`}
                style={{ fontSize: "0.72rem", fontWeight: 600, background: activeTab === tab ? undefined : "none", border: "none", borderBottom: activeTab === tab ? "2px solid #f59e0b" : "2px solid transparent", cursor: "pointer", fontFamily: "inherit" }}
              >
                {tab !== "all" && <span className={`w-2 h-2 rounded-full ${walletConfig[tab].dot}`} />}
                {label}
                <span className="px-1.5 py-0.5 rounded-full bg-black/5 text-zinc-500" style={{ fontSize: "0.6rem" }}>{count}</span>
              </button>
            );
          })}
        </div>

        {displayed.length === 0 ? (
          <div className="py-16 text-center">
            <CreditCard className="w-10 h-10 text-zinc-200 mx-auto mb-3" />
            <p className="text-zinc-400" style={{ fontSize: "0.82rem" }}>No transactions yet</p>
            <p className="text-zinc-300 mt-1" style={{ fontSize: "0.7rem" }}>Collections will appear here once payments are recorded</p>
          </div>
        ) : (
          <div className="divide-y divide-black/[0.04] overflow-y-auto overscroll-contain" style={{ maxHeight: "18rem" }}>
            {displayed.map((p) => {
              const type = walletType(p.payment_mode);
              const cfg = walletConfig[type];
              const Icon = cfg.icon;
              return (
                <div key={p.id} className="flex items-center gap-3 px-4 py-3">
                  <div className={`w-8 h-8 rounded-xl flex items-center justify-center shrink-0 ${cfg.bg}`}>
                    <Icon className={`w-3.5 h-3.5 ${cfg.color}`} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-zinc-800" style={{ fontSize: "0.8rem" }}>{partyNames[p.party_id] || "Party"}</span>
                      <span className={`px-1.5 py-0.5 rounded text-[0.58rem] font-semibold ${cfg.badge}`}>{cfg.label.replace(" Wallet", "")}</span>
                    </div>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="text-zinc-400" style={{ fontSize: "0.65rem" }}>{fmtDate(p.payment_date)}</span>
                      {p.reference_number && (
                        <>
                          <span className="text-zinc-200">·</span>
                          <span className="text-zinc-400 font-mono" style={{ fontSize: "0.6rem" }}>{p.reference_number}</span>
                        </>
                      )}
                      {p.bank_name && (
                        <>
                          <span className="text-zinc-200">·</span>
                          <span className="text-zinc-400" style={{ fontSize: "0.6rem" }}>{p.bank_name}</span>
                        </>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 text-emerald-600 font-bold tabular-nums shrink-0" style={{ fontSize: "0.9rem" }}>
                    <ArrowDownLeft className="w-3.5 h-3.5 text-emerald-500" />
                    {fmt(Number(p.amount))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <TransferModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onDone={load}
        defaultBucket={modalBucket}
        lockBucket={modalLock}
        available={available}
      />
    </div>
  );
}
