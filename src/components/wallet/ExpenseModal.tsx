"use client";

import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { Banknote, Building2, Loader2, Receipt, Tag, X } from "lucide-react";
import { EXPENSE_CATEGORIES, type ExpenseBucket } from "@/lib/expenses-fallback";

export interface ExpenseWalletOption {
  user_id: string;
  user_name: string;
  role_name: string;
  cash_balance: number;
  bank_balance: number;
  coupon_balance: number;
}

interface ExpenseModalProps {
  open: boolean;
  onClose: () => void;
  /** Called after an expense is successfully recorded. */
  onDone: () => void;
  /** Wallets the actor may charge an expense to. */
  wallets: ExpenseWalletOption[];
  /** Pre-select this wallet (the actor's own, when present). */
  defaultUserId?: string | null;
  /** False for admins: their expense is finalized immediately. */
  requiresApproval?: boolean;
}

const bucketMeta: Record<ExpenseBucket, { label: string; icon: typeof Banknote; color: string }> = {
  cash: { label: "Cash", icon: Banknote, color: "#059669" },
  bank: { label: "Bank", icon: Building2, color: "#2563eb" },
  coupon: { label: "Coupon", icon: Tag, color: "#7c3aed" },
};

const fmt = (n: number) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(n);

export default function ExpenseModal({ open, onClose, onDone, wallets, defaultUserId, requiresApproval = true }: ExpenseModalProps) {
  const [userId, setUserId] = useState("");
  const [bucket, setBucket] = useState<ExpenseBucket>("cash");
  const [amount, setAmount] = useState("");
  const [category, setCategory] = useState<string>(EXPENSE_CATEGORIES[0]);
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    const fallback = defaultUserId && wallets.some((w) => w.user_id === defaultUserId)
      ? defaultUserId
      : wallets[0]?.user_id || "";
    setUserId(fallback);
    setBucket("cash");
    setAmount("");
    setCategory(EXPENSE_CATEGORIES[0]);
    setNote("");
    setError("");
  }, [open, defaultUserId, wallets]);

  const selected = useMemo(() => wallets.find((w) => w.user_id === userId), [wallets, userId]);
  const available = useMemo(() => {
    if (!selected) return 0;
    return bucket === "cash" ? selected.cash_balance : bucket === "bank" ? selected.bank_balance : selected.coupon_balance;
  }, [selected, bucket]);

  if (!open) return null;

  const numericAmount = parseFloat(amount) || 0;
  const overspend = numericAmount > available;

  const submit = async () => {
    setError("");
    if (!userId) return setError("Select a wallet to charge the expense to.");
    if (numericAmount <= 0) return setError("Enter a positive amount.");
    setSubmitting(true);
    try {
      await api("/api/v1/expenses", {
        method: "POST",
        body: {
          user_id: userId,
          user_name: selected?.user_name || null,
          bucket,
          amount: numericAmount,
          category,
          note: note.trim() || null,
        },
      });
      onDone();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to record expense");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 backdrop-blur-sm p-0 sm:p-4"
      onClick={onClose}
    >
      <div
        className="w-full sm:max-w-md bg-white rounded-t-2xl sm:rounded-2xl shadow-2xl overflow-hidden max-h-[92vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
        style={{ fontFamily: "'Inter','system-ui',sans-serif" }}
      >
        {/* header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-black/[0.06] bg-gradient-to-r from-rose-50 to-orange-50">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-rose-600 text-white flex items-center justify-center">
              <Receipt className="w-4 h-4" />
            </div>
            <div>
              <h3 className="font-semibold text-zinc-900" style={{ fontSize: "0.95rem" }}>{requiresApproval ? "Request Expense" : "Add Expense"}</h3>
              <p className="text-zinc-500" style={{ fontSize: "0.7rem" }}>
                {requiresApproval ? "Reserved now · finalized after approval" : "Deducted immediately · no approval required"}
              </p>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-black/5 text-zinc-400" style={{ cursor: "pointer", border: "none", background: "transparent" }}>
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {/* own wallet — read-only; an expense is always charged to your own wallet */}
          <div>
            <label className="block text-zinc-600 mb-1.5" style={{ fontSize: "0.72rem", fontWeight: 600 }}>Charge to your wallet</label>
            {selected ? (
              <div className="w-full rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2.5 flex items-center justify-between gap-3">
                <span className="font-semibold text-zinc-900 truncate" style={{ fontSize: "0.85rem" }}>
                  {selected.user_name}
                </span>
                <span className="font-mono font-semibold text-zinc-600 shrink-0" style={{ fontSize: "0.82rem" }}>
                  {fmt(selected.cash_balance + selected.bank_balance + selected.coupon_balance)}
                </span>
              </div>
            ) : (
              <div className="w-full rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2.5 text-zinc-400" style={{ fontSize: "0.85rem" }}>
                No wallet available for your account
              </div>
            )}
          </div>

          {/* bucket */}
          <div>
            <label className="block text-zinc-600 mb-1.5" style={{ fontSize: "0.72rem", fontWeight: 600 }}>Pay from</label>
            <div className="grid grid-cols-3 gap-2">
              {(Object.keys(bucketMeta) as ExpenseBucket[]).map((b) => {
                const meta = bucketMeta[b];
                const Icon = meta.icon;
                const active = bucket === b;
                return (
                  <button
                    key={b}
                    onClick={() => setBucket(b)}
                    className={`flex flex-col items-center gap-1 rounded-xl border px-2 py-2.5 transition-all ${active ? "border-transparent text-white" : "border-zinc-200 text-zinc-600 hover:border-zinc-300"}`}
                    style={{ cursor: "pointer", fontFamily: "inherit", background: active ? meta.color : "#fff" }}
                  >
                    <Icon className="w-4 h-4" />
                    <span style={{ fontSize: "0.7rem", fontWeight: 600 }}>{meta.label}</span>
                  </button>
                );
              })}
            </div>
            {selected && (
              <p className="text-zinc-400 mt-1.5" style={{ fontSize: "0.68rem" }}>
                Available in {bucketMeta[bucket].label}: <span className="font-semibold text-zinc-600">{fmt(available)}</span>
              </p>
            )}
          </div>

          {/* amount */}
          <div>
            <label className="block text-zinc-600 mb-1.5" style={{ fontSize: "0.72rem", fontWeight: 600 }}>Amount</label>
            <input
              type="number"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0"
              className="w-full rounded-xl border border-zinc-200 px-3 py-2.5 bg-white text-zinc-900 font-mono focus:outline-none focus:ring-2 focus:ring-rose-500/30"
              style={{ fontSize: "1.1rem", fontFamily: "inherit" }}
            />
            {overspend && numericAmount > 0 && (
              <p className="text-amber-600 mt-1.5" style={{ fontSize: "0.68rem" }}>
                This exceeds your available balance. Reduce the amount to submit.
              </p>
            )}
          </div>

          {/* category */}
          <div>
            <label className="block text-zinc-600 mb-1.5" style={{ fontSize: "0.72rem", fontWeight: 600 }}>Category</label>
            <div className="flex flex-wrap gap-1.5">
              {EXPENSE_CATEGORIES.map((c) => (
                <button
                  key={c}
                  onClick={() => setCategory(c)}
                  className={`px-2.5 py-1 rounded-full border transition-all ${category === c ? "bg-zinc-900 text-white border-zinc-900" : "bg-white text-zinc-600 border-zinc-200 hover:border-zinc-300"}`}
                  style={{ fontSize: "0.7rem", fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}
                >
                  {c}
                </button>
              ))}
            </div>
          </div>

          {/* note */}
          <div>
            <label className="block text-zinc-600 mb-1.5" style={{ fontSize: "0.72rem", fontWeight: 600 }}>Note (optional)</label>
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="What was this for?"
              className="w-full rounded-xl border border-zinc-200 px-3 py-2.5 bg-white text-zinc-900 focus:outline-none focus:ring-2 focus:ring-rose-500/30"
              style={{ fontSize: "0.85rem", fontFamily: "inherit" }}
            />
          </div>

          {error && (
            <div className="p-2.5 rounded-lg bg-red-500/10 border border-red-500/20 text-red-600" style={{ fontSize: "0.76rem" }}>
              {error}
            </div>
          )}
        </div>

        {/* footer */}
        <div className="flex gap-2.5 px-5 py-4 border-t border-black/[0.06]">
          <button
            onClick={onClose}
            className="flex-1 px-3 py-2.5 rounded-xl border border-zinc-200 text-zinc-600 font-semibold hover:bg-zinc-50"
            style={{ fontSize: "0.82rem", cursor: "pointer", fontFamily: "inherit", background: "#fff" }}
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={submitting || !userId || numericAmount <= 0 || overspend}
            className="flex-1 px-3 py-2.5 rounded-xl bg-rose-600 text-white font-semibold hover:bg-rose-700 flex items-center justify-center gap-1.5 disabled:opacity-50"
            style={{ fontSize: "0.82rem", cursor: "pointer", fontFamily: "inherit", border: "none" }}
          >
            {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Receipt className="w-4 h-4" />}
            {requiresApproval ? "Submit for Approval" : "Add Expense"}
          </button>
        </div>
      </div>
    </div>
  );
}
