"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  Banknote,
  Building2,
  Check,
  CheckCircle2,
  Clock3,
  History,
  Loader2,
  Plus,
  ReceiptIndianRupee,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Tag,
  Wallet,
  X,
  XCircle,
} from "lucide-react";
import { api, getUser } from "@/lib/api";
import ExpenseModal, { type ExpenseWalletOption } from "@/components/wallet/ExpenseModal";
import { expenseHistoryAmounts } from "@/lib/expense-history-amounts";
import type { ExpenseBucket, ExpenseStatus } from "@/lib/expenses-fallback";

type ExpenseItem = {
  id: string;
  user_id: string;
  user_name: string | null;
  requester_role: string;
  bucket: ExpenseBucket;
  requested_amount: number;
  approved_amount: number | null;
  amount: number;
  category: string;
  note: string | null;
  status: ExpenseStatus;
  decided_by_name: string | null;
  decision_note: string | null;
  decided_at: string | null;
  created_at: string;
  is_mine: boolean;
  can_approve: boolean;
  can_cancel: boolean;
  refund_amount: number;
  awaiting_label: string;
};

type ExpenseSummary = {
  pendingMineCount: number;
  pendingMineAmount: number;
  pendingApprovalCount: number;
  pendingApprovalAmount: number;
  approvedTotal: number;
  revertedTotal: number;
};

type WalletRow = ExpenseWalletOption & {
  id: string;
  balance: number;
};

const EMPTY_SUMMARY: ExpenseSummary = {
  pendingMineCount: 0,
  pendingMineAmount: 0,
  pendingApprovalCount: 0,
  pendingApprovalAmount: 0,
  approvedTotal: 0,
  revertedTotal: 0,
};

const fmt = (value: number) => new Intl.NumberFormat("en-IN", {
  style: "currency", currency: "INR", maximumFractionDigits: 2,
}).format(Number(value) || 0);

const dateTime = (value: string | null) => value
  ? new Date(value).toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })
  : "—";

const bucketMeta = {
  cash: { label: "Cash", icon: Banknote, cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  bank: { label: "Bank", icon: Building2, cls: "bg-blue-50 text-blue-700 border-blue-200" },
  coupon: { label: "Coupon", icon: Tag, cls: "bg-violet-50 text-violet-700 border-violet-200" },
} as const;

const statusMeta: Record<ExpenseStatus, { label: string; icon: typeof Clock3; cls: string; line: string }> = {
  PENDING: { label: "In transit", icon: Clock3, cls: "bg-amber-50 text-amber-700 border-amber-200", line: "bg-amber-400" },
  APPROVED: { label: "Approved", icon: CheckCircle2, cls: "bg-emerald-50 text-emerald-700 border-emerald-200", line: "bg-emerald-500" },
  REJECTED: { label: "Rejected · Reverted", icon: RotateCcw, cls: "bg-rose-50 text-rose-700 border-rose-200", line: "bg-rose-500" },
  CANCELLED: { label: "Cancelled · Reverted", icon: XCircle, cls: "bg-zinc-100 text-zinc-600 border-zinc-200", line: "bg-zinc-400" },
};

function SummaryCard({ icon: Icon, label, value, sub, tone }: {
  icon: typeof Wallet; label: string; value: string; sub: string; tone: string;
}) {
  return (
    <div className="rounded-2xl border border-black/[0.06] bg-white p-4 shadow-[0_8px_30px_rgba(0,0,0,0.04)]">
      <div className="flex items-center gap-2 text-zinc-500 text-xs font-semibold">
        <span className={`flex h-8 w-8 items-center justify-center rounded-xl ${tone}`}><Icon className="h-4 w-4" /></span>
        {label}
      </div>
      <div className="mt-3 text-xl font-bold tabular-nums text-zinc-900">{value}</div>
      <div className="mt-1 text-[0.68rem] text-zinc-400">{sub}</div>
    </div>
  );
}

function ApprovalCard({ expense, busy, onDecision }: {
  expense: ExpenseItem;
  busy: boolean;
  onDecision: (expense: ExpenseItem, action: "APPROVE" | "REJECT", amount: number, note: string) => Promise<void>;
}) {
  const [amount, setAmount] = useState(String(expense.requested_amount));
  const [note, setNote] = useState("");
  const [showReject, setShowReject] = useState(false);
  const approved = Number(amount);
  const refund = Number.isFinite(approved) ? Math.max(0, expense.requested_amount - approved) : 0;
  const valid = Number.isFinite(approved) && approved > 0 && approved <= expense.requested_amount;
  const bucket = bucketMeta[expense.bucket];
  const BucketIcon = bucket.icon;

  return (
    <article className="overflow-hidden rounded-2xl border border-amber-200/70 bg-white shadow-[0_14px_45px_rgba(245,158,11,0.08)]">
      <div className="h-1 bg-gradient-to-r from-amber-400 via-orange-400 to-rose-400" />
      <div className="p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="font-bold text-zinc-900">{expense.user_name || "User"}</h3>
              <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[0.6rem] font-bold text-zinc-500">{expense.requester_role.replace(/_/g, " ")}</span>
              <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[0.62rem] font-bold ${bucket.cls}`}>
                <BucketIcon className="h-3 w-3" /> {bucket.label}
              </span>
            </div>
            <p className="mt-1 text-xs text-zinc-400">Requested {dateTime(expense.created_at)} · {expense.category}</p>
          </div>
          <div className="text-right">
            <div className="text-[0.65rem] font-semibold uppercase tracking-wider text-zinc-400">Requested</div>
            <div className="text-xl font-bold tabular-nums text-zinc-900">{fmt(expense.requested_amount)}</div>
          </div>
        </div>

        {expense.note && <div className="mt-4 rounded-xl bg-zinc-50 px-3 py-2.5 text-xs leading-relaxed text-zinc-600">“{expense.note}”</div>}

        <div className="mt-4 grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
          <label className="block">
            <span className="mb-1.5 block text-[0.7rem] font-bold text-zinc-600">Approve amount</span>
            <div className="flex items-center rounded-xl border border-zinc-200 bg-white px-3 focus-within:border-emerald-400 focus-within:ring-2 focus-within:ring-emerald-500/10">
              <span className="text-zinc-400">₹</span>
              <input
                aria-label={`Approved amount for ${expense.user_name || "request"}`}
                type="number"
                min="0.01"
                max={expense.requested_amount}
                step="0.01"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                className="w-full border-0 bg-transparent px-2 py-2.5 font-mono text-sm font-bold text-zinc-900 outline-none"
              />
            </div>
          </label>
          <label className="block">
            <span className="mb-1.5 block text-[0.7rem] font-bold text-zinc-600">Approval note (optional)</span>
            <input
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="Reason for adjustment or approval"
              className="w-full rounded-xl border border-zinc-200 px-3 py-2.5 text-sm text-zinc-900 outline-none focus:border-emerald-400 focus:ring-2 focus:ring-emerald-500/10"
            />
          </label>
        </div>

        {refund > 0 && valid && (
          <div className="mt-3 flex items-center gap-2 rounded-xl border border-blue-200 bg-blue-50 px-3 py-2 text-xs font-medium text-blue-700">
            <RotateCcw className="h-3.5 w-3.5" /> {fmt(refund)} will return to {expense.user_name || "the requester"}&apos;s {bucket.label.toLowerCase()} wallet.
          </div>
        )}
        {!valid && <p className="mt-2 text-xs font-medium text-rose-600">Approval must be above ₹0 and cannot exceed the requested amount.</p>}

        {showReject && (
          <div className="mt-3 rounded-xl border border-rose-200 bg-rose-50 p-3">
            <label className="block text-[0.7rem] font-bold text-rose-700">Rejection reason (required)</label>
            <textarea
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="Tell the requester why this was rejected"
              rows={2}
              className="mt-1.5 w-full resize-none rounded-lg border border-rose-200 bg-white px-3 py-2 text-sm outline-none focus:border-rose-400"
            />
          </div>
        )}

        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <button
            type="button"
            onClick={() => setShowReject((value) => !value)}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-xl border border-rose-200 bg-white px-3 py-2 text-xs font-bold text-rose-600 hover:bg-rose-50 disabled:opacity-50"
          >
            <X className="h-3.5 w-3.5" /> Reject
          </button>
          {showReject && (
            <button
              type="button"
              onClick={() => onDecision(expense, "REJECT", expense.requested_amount, note)}
              disabled={busy || !note.trim()}
              className="inline-flex items-center gap-1.5 rounded-xl bg-rose-600 px-3 py-2 text-xs font-bold text-white hover:bg-rose-700 disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />} Reject &amp; return funds
            </button>
          )}
          <button
            type="button"
            onClick={() => onDecision(expense, "APPROVE", approved, note)}
            disabled={busy || !valid || showReject}
            className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-600 px-4 py-2 text-xs font-bold text-white shadow-sm hover:bg-emerald-700 disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />} Approve {fmt(valid ? approved : 0)}
          </button>
        </div>
      </div>
    </article>
  );
}

function QueueRow({ expense, busy, onCancel }: { expense: ExpenseItem; busy: boolean; onCancel: (expense: ExpenseItem) => Promise<void> }) {
  const status = statusMeta[expense.status];
  const StatusIcon = status.icon;
  const bucket = bucketMeta[expense.bucket];
  const BucketIcon = bucket.icon;
  const historyAmounts = expenseHistoryAmounts(expense);

  return (
    <article className="relative overflow-hidden rounded-2xl border border-black/[0.06] bg-white p-4 shadow-[0_8px_28px_rgba(0,0,0,0.035)]">
      <span className={`absolute inset-y-0 left-0 w-1 ${status.line}`} />
      <div className="flex flex-wrap items-start gap-3 pl-1">
        <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border ${bucket.cls}`}><BucketIcon className="h-4 w-4" /></div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-bold text-zinc-900">{expense.category}</span>
            <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[0.62rem] font-bold ${status.cls}`}>
              <StatusIcon className="h-3 w-3" /> {status.label}
            </span>
            {!expense.is_mine && <span className="text-xs text-zinc-500">· {expense.user_name || "User"}</span>}
          </div>
          <div className="mt-1 text-[0.68rem] text-zinc-400">{dateTime(expense.created_at)} · {bucket.label} wallet</div>
          {expense.note && <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-zinc-600">{expense.note}</p>}
          {expense.status === "PENDING" && (
            <div className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-amber-50 px-2 py-1 text-[0.68rem] font-medium text-amber-700">
              <Clock3 className="h-3 w-3" /> Waiting for {expense.awaiting_label}
            </div>
          )}
          {expense.status !== "PENDING" && (
            <div className="mt-2 text-[0.68rem] text-zinc-500">
              {expense.decided_by_name ? `Processed by ${expense.decided_by_name}` : "Processed"} · {dateTime(expense.decided_at)}
              {expense.decision_note && <span> · {expense.decision_note}</span>}
            </div>
          )}
          {expense.refund_amount > 0 && (
            <div className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-blue-50 px-2 py-1 text-[0.68rem] font-bold text-blue-700">
              <RotateCcw className="h-3 w-3" /> {fmt(expense.refund_amount)} reverted to wallet
            </div>
          )}
        </div>
        <div className="ml-auto text-right">
          <div className="text-lg font-bold tabular-nums text-zinc-900">{fmt(historyAmounts.primaryAmount)}</div>
          {historyAmounts.requestedAmount !== null && (
            <div className="text-[0.65rem] font-medium text-zinc-400">Requested {fmt(historyAmounts.requestedAmount)}</div>
          )}
          {expense.can_cancel && (
            <button
              type="button"
              onClick={() => onCancel(expense)}
              disabled={busy}
              className="mt-2 rounded-lg border border-zinc-200 px-2 py-1 text-[0.65rem] font-bold text-zinc-500 hover:border-rose-200 hover:bg-rose-50 hover:text-rose-600 disabled:opacity-50"
            >
              {busy ? "Cancelling…" : "Cancel request"}
            </button>
          )}
        </div>
      </div>
    </article>
  );
}

export default function ExpensesPage() {
  const user = getUser();
  const canRequest = user?.role === "SALESMAN" || user?.role === "ACCOUNTS_MANAGER" || user?.role === "ADMIN";
  const requiresApproval = user?.role !== "ADMIN";
  const [expenses, setExpenses] = useState<ExpenseItem[]>([]);
  const [summary, setSummary] = useState<ExpenseSummary>(EMPTY_SUMMARY);
  const [wallets, setWallets] = useState<WalletRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const [acting, setActing] = useState<string | null>(null);
  const [filter, setFilter] = useState<"ALL" | ExpenseStatus>("ALL");

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError("");
    try {
      const [expenseResponse, walletResponse] = await Promise.all([
        api<{ data: ExpenseItem[]; summary: ExpenseSummary }>("/api/v1/expenses", { noCache: true }),
        canRequest
          ? api<{ data: WalletRow[] }>("/api/v1/wallets", { noCache: true }).catch(() => ({ data: [] as WalletRow[] }))
          : Promise.resolve({ data: [] as WalletRow[] }),
      ]);
      setExpenses(expenseResponse.data || []);
      setSummary(expenseResponse.summary || EMPTY_SUMMARY);
      setWallets(walletResponse.data || []);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load expense queue");
    } finally {
      if (!silent) setLoading(false);
    }
  }, [canRequest]);

  useEffect(() => {
    void load();
    // expenseChanged already fires on this user's own submit/approve actions, so
    // the timer only needs to catch another user's — 60s is enough.
    const timer = window.setInterval(() => { if (!document.hidden) void load(true); }, 60_000);
    const refresh = () => void load(true);
    window.addEventListener("expenseChanged", refresh);
    return () => { window.clearInterval(timer); window.removeEventListener("expenseChanged", refresh); };
  }, [load]);

  const ownWallet = wallets.find((wallet) => wallet.user_id === user?.id)
    || wallets.find((wallet) => wallet.user_name === user?.name)
    || null;
  const pendingApprovals = expenses.filter((expense) => expense.can_approve);
  const history = expenses.filter((expense) => filter === "ALL" || expense.status === filter);
  const statusCounts = useMemo(() => ({
    ALL: expenses.length,
    PENDING: expenses.filter((expense) => expense.status === "PENDING").length,
    APPROVED: expenses.filter((expense) => expense.status === "APPROVED").length,
    REJECTED: expenses.filter((expense) => expense.status === "REJECTED").length,
    CANCELLED: expenses.filter((expense) => expense.status === "CANCELLED").length,
  }), [expenses]);

  const decide = async (expense: ExpenseItem, action: "APPROVE" | "REJECT", amount: number, note: string) => {
    setActing(expense.id);
    setError(""); setSuccess("");
    try {
      await api("/api/v1/expenses", { method: "PATCH", body: { id: expense.id, action, approved_amount: amount, decision_note: note || null } });
      setSuccess(action === "APPROVE" ? "Expense approved and wallet adjustment completed." : "Expense rejected and the full reservation returned.");
      window.dispatchEvent(new Event("expenseChanged"));
      window.dispatchEvent(new Event("walletBalanceChanged"));
      await load(true);
    } catch (decisionError) {
      setError(decisionError instanceof Error ? decisionError.message : "Could not process expense");
    } finally { setActing(null); }
  };

  const cancel = async (expense: ExpenseItem) => {
    setActing(expense.id);
    setError(""); setSuccess("");
    try {
      await api("/api/v1/expenses", { method: "PATCH", body: { id: expense.id, action: "CANCEL" } });
      setSuccess("Request cancelled and the reserved amount returned to your wallet.");
      window.dispatchEvent(new Event("expenseChanged"));
      window.dispatchEvent(new Event("walletBalanceChanged"));
      await load(true);
    } catch (cancelError) {
      setError(cancelError instanceof Error ? cancelError.message : "Could not cancel request");
    } finally { setActing(null); }
  };

  if (loading) return <div className="flex min-h-[60vh] items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-amber-500" /></div>;

  return (
    <div className="space-y-6" style={{ fontFamily: "'Inter','system-ui',sans-serif" }}>
      <div className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-zinc-950 via-zinc-900 to-amber-950 p-5 text-white shadow-[0_24px_70px_rgba(0,0,0,0.2)] sm:p-7">
        <div className="absolute -right-20 -top-24 h-64 w-64 rounded-full bg-amber-500/20 blur-3xl" />
        <div className="absolute -bottom-24 left-1/3 h-52 w-52 rounded-full bg-emerald-500/10 blur-3xl" />
        <div className="relative flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="inline-flex items-center gap-1.5 rounded-full border border-amber-400/30 bg-amber-400/10 px-2.5 py-1 text-[0.65rem] font-bold uppercase tracking-[0.14em] text-amber-300">
              <ShieldCheck className="h-3.5 w-3.5" /> Controlled spending
            </div>
            <h1 className="mt-3 text-2xl font-bold tracking-tight sm:text-3xl">Expense approvals</h1>
            <p className="mt-1.5 max-w-2xl text-xs leading-relaxed text-zinc-400 sm:text-sm">
              Funds are reserved immediately, remain in transit while pending, and become an expense only after approval.
            </p>
          </div>
          <div className="flex gap-2">
            <button onClick={() => load()} className="inline-flex items-center gap-1.5 rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 text-xs font-bold text-zinc-200 hover:bg-white/10">
              <RefreshCw className="h-3.5 w-3.5" /> Refresh
            </button>
            {canRequest && (
              <button onClick={() => setModalOpen(true)} disabled={!ownWallet} className="inline-flex items-center gap-1.5 rounded-xl bg-amber-400 px-4 py-2.5 text-xs font-bold text-zinc-950 shadow-lg shadow-amber-500/20 hover:bg-amber-300 disabled:opacity-40">
                <Plus className="h-4 w-4" /> {requiresApproval ? "Request expense" : "Add expense"}
              </button>
            )}
          </div>
        </div>
      </div>

      {error && <div className="flex items-center gap-2 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-xs font-medium text-rose-700"><AlertCircle className="h-4 w-4" /> {error}</div>}
      {success && <div className="flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-xs font-medium text-emerald-700"><CheckCircle2 className="h-4 w-4" /> {success}</div>}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <SummaryCard icon={Clock3} label="My in transit" value={fmt(summary.pendingMineAmount)} sub={`${summary.pendingMineCount} waiting for approval`} tone="bg-amber-50 text-amber-600" />
        <SummaryCard icon={ShieldCheck} label="Needs my approval" value={fmt(summary.pendingApprovalAmount)} sub={`${summary.pendingApprovalCount} pending request${summary.pendingApprovalCount === 1 ? "" : "s"}`} tone="bg-violet-50 text-violet-600" />
        <SummaryCard icon={ReceiptIndianRupee} label="Approved expense" value={fmt(summary.approvedTotal)} sub="Finalized requests in this queue" tone="bg-emerald-50 text-emerald-600" />
        <SummaryCard icon={RotateCcw} label="Returned to wallets" value={fmt(summary.revertedTotal)} sub="Rejected and reduced amounts" tone="bg-blue-50 text-blue-600" />
      </div>

      {pendingApprovals.length > 0 && (
        <section>
          <div className="mb-3 flex items-center gap-2 px-1">
            <ShieldCheck className="h-4 w-4 text-amber-600" />
            <h2 className="font-bold text-zinc-900">Awaiting your approval</h2>
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[0.65rem] font-bold text-amber-700">{pendingApprovals.length}</span>
          </div>
          <div className="grid gap-4 xl:grid-cols-2">
            {pendingApprovals.map((expense) => <ApprovalCard key={expense.id} expense={expense} busy={acting === expense.id} onDecision={decide} />)}
          </div>
        </section>
      )}

      <section>
        <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2 px-1">
            <History className="h-4 w-4 text-zinc-500" />
            <h2 className="font-bold text-zinc-900">Request queue &amp; audit history</h2>
          </div>
          <div className="flex max-w-full gap-1 overflow-x-auto rounded-xl border border-black/[0.06] bg-white p-1">
            {(["ALL", "PENDING", "APPROVED", "REJECTED", "CANCELLED"] as const).map((status) => (
              <button key={status} onClick={() => setFilter(status)} className={`whitespace-nowrap rounded-lg px-2.5 py-1.5 text-[0.65rem] font-bold transition ${filter === status ? "bg-zinc-900 text-white" : "text-zinc-500 hover:bg-zinc-50"}`}>
                {status === "ALL" ? "All" : status.charAt(0) + status.slice(1).toLowerCase()} <span className="opacity-60">{statusCounts[status]}</span>
              </button>
            ))}
          </div>
        </div>

        {history.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-zinc-200 bg-white py-16 text-center">
            <ReceiptIndianRupee className="mx-auto h-10 w-10 text-zinc-200" />
            <p className="mt-3 text-sm font-semibold text-zinc-500">No expense requests here yet</p>
            {canRequest && <button onClick={() => setModalOpen(true)} className="mt-3 text-xs font-bold text-amber-600 hover:text-amber-700">{requiresApproval ? "Create the first request" : "Add the first expense"} →</button>}
          </div>
        ) : (
          <div className="grid gap-3 xl:grid-cols-2">
            {history.map((expense) => <QueueRow key={expense.id} expense={expense} busy={acting === expense.id} onCancel={cancel} />)}
          </div>
        )}
      </section>

      <ExpenseModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onDone={() => {
          setSuccess(requiresApproval
            ? "Expense submitted. The amount is now reserved and awaiting approval."
            : "Expense added and deducted directly from your admin wallet.");
          window.dispatchEvent(new Event("expenseChanged"));
          window.dispatchEvent(new Event("walletBalanceChanged"));
          void load(true);
        }}
        wallets={ownWallet ? [ownWallet] : []}
        defaultUserId={ownWallet?.user_id || user?.id || null}
        requiresApproval={requiresApproval}
      />
    </div>
  );
}
