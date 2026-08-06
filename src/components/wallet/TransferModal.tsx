"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { ArrowRight, Banknote, Building2, Loader2, Send, Tag, X } from "lucide-react";

export type TransferBucket = "cash" | "bank" | "coupon";

interface Recipient {
  user_id: string;
  name: string | null;
  role_name: string;
}

interface TransferModalProps {
  open: boolean;
  onClose: () => void;
  /** Called after a transfer is successfully created. */
  onDone: () => void;
  /** Pre-select a bucket (e.g. launched from a bucket card). */
  defaultBucket?: TransferBucket;
  /** Lock the bucket to defaultBucket (hide the picker). */
  lockBucket?: boolean;
  /** Available balances per bucket, used to validate the amount client-side. */
  available?: Partial<Record<TransferBucket, number>>;
}

const bucketMeta: Record<TransferBucket, { label: string; icon: typeof Banknote; color: string }> = {
  cash: { label: "Cash", icon: Banknote, color: "#059669" },
  bank: { label: "Bank", icon: Building2, color: "#2563eb" },
  coupon: { label: "Coupon", icon: Tag, color: "#7c3aed" },
};

const roleLabel: Record<string, string> = {
  ACCOUNTS_MANAGER: "Financier / Accountant",
  ADMIN: "Admin",
  SUPER_ADMIN: "Super Admin",
};

const fmt = (n: number) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(n);

export default function TransferModal({
  open,
  onClose,
  onDone,
  defaultBucket = "cash",
  lockBucket = false,
  available,
}: TransferModalProps) {
  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const [loadingRecipients, setLoadingRecipients] = useState(false);
  const [bucket, setBucket] = useState<TransferBucket>(defaultBucket);
  const [toUserId, setToUserId] = useState("");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const loadRecipients = useCallback(async () => {
    setLoadingRecipients(true);
    try {
      const res = await api<{ success: boolean; data: Recipient[] }>(
        "/api/v1/wallets/transfer?recipients=true",
      );
      setRecipients(res.data || []);
    } catch {
      setRecipients([]);
    } finally {
      setLoadingRecipients(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setBucket(defaultBucket);
    setToUserId("");
    setAmount("");
    setNote("");
    setError("");
    loadRecipients();
  }, [open, defaultBucket, loadRecipients]);

  const availableForBucket = available?.[bucket];
  const numericAmount = Number(amount);
  const overBalance =
    typeof availableForBucket === "number" &&
    Number.isFinite(numericAmount) &&
    numericAmount > availableForBucket + 1e-6;

  const canSubmit = useMemo(
    () => Boolean(toUserId) && Number.isFinite(numericAmount) && numericAmount > 0 && !overBalance && !submitting,
    [toUserId, numericAmount, overBalance, submitting],
  );

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError("");
    try {
      await api("/api/v1/wallets/transfer", {
        method: "POST",
        body: { to_user_id: toUserId, bucket, amount: numericAmount, note: note.trim() || undefined },
      });
      onDone();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Transfer failed");
    } finally {
      setSubmitting(false);
    }
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[60] bg-black/50 backdrop-blur-[2px] flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-2xl bg-white shadow-2xl border border-black/10 overflow-hidden"
        style={{ fontFamily: "'Inter','system-ui',sans-serif" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-black/[0.06] bg-gradient-to-r from-zinc-900 to-zinc-800">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-amber-500/20 border border-amber-500/30 flex items-center justify-center">
              <Send className="w-4 h-4 text-amber-400" />
            </div>
            <div>
              <h3 className="text-white font-semibold" style={{ fontSize: "0.95rem" }}>Transfer Money</h3>
              <p className="text-zinc-400" style={{ fontSize: "0.68rem" }}>Needs the recipient&apos;s approval</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-md text-zinc-400 hover:text-white hover:bg-white/10"
            style={{ background: "none", border: "none", cursor: "pointer" }}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {/* Bucket */}
          <div>
            <label className="block text-zinc-500 mb-1.5" style={{ fontSize: "0.7rem", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em" }}>
              From wallet
            </label>
            {lockBucket ? (
              (() => {
                const m = bucketMeta[bucket];
                const Icon = m.icon;
                return (
                  <div className="flex items-center gap-2 px-3 py-2.5 rounded-xl border border-black/10 bg-black/[0.02]">
                    <Icon className="w-4 h-4" style={{ color: m.color }} />
                    <span className="font-medium text-zinc-800" style={{ fontSize: "0.82rem" }}>{m.label} Wallet</span>
                    {typeof availableForBucket === "number" && (
                      <span className="ml-auto text-zinc-400" style={{ fontSize: "0.72rem" }}>
                        Available {fmt(availableForBucket)}
                      </span>
                    )}
                  </div>
                );
              })()
            ) : (
              <div className="grid grid-cols-3 gap-2">
                {(Object.keys(bucketMeta) as TransferBucket[]).map((b) => {
                  const m = bucketMeta[b];
                  const Icon = m.icon;
                  const isActive = bucket === b;
                  return (
                    <button
                      key={b}
                      onClick={() => setBucket(b)}
                      className={`flex flex-col items-center gap-1 py-2.5 rounded-xl border transition-all ${
                        isActive ? "border-amber-400 bg-amber-50" : "border-black/10 hover:border-black/20 bg-white"
                      }`}
                      style={{ cursor: "pointer", fontFamily: "inherit" }}
                    >
                      <Icon className="w-4 h-4" style={{ color: m.color }} />
                      <span className="font-medium text-zinc-700" style={{ fontSize: "0.72rem" }}>{m.label}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Recipient */}
          <div>
            <label className="block text-zinc-500 mb-1.5" style={{ fontSize: "0.7rem", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em" }}>
              Send to
            </label>
            {loadingRecipients ? (
              <div className="flex items-center gap-2 text-zinc-400 px-3 py-2.5" style={{ fontSize: "0.8rem" }}>
                <Loader2 className="w-4 h-4 animate-spin" /> Loading recipients…
              </div>
            ) : recipients.length === 0 ? (
              <p className="text-zinc-400 px-1" style={{ fontSize: "0.78rem" }}>
                No eligible recipients found in your company.
              </p>
            ) : (
              <select
                value={toUserId}
                onChange={(e) => setToUserId(e.target.value)}
                className="w-full px-3 py-2.5 rounded-xl border border-black/10 text-zinc-800 focus:border-amber-400 focus:outline-none"
                style={{ fontSize: "0.84rem", fontFamily: "inherit", background: "#fff" }}
              >
                <option value="">Choose a recipient…</option>
                {recipients.map((r) => (
                  <option key={r.user_id} value={r.user_id}>
                    {r.name || "User"} — {roleLabel[r.role_name] || r.role_name}
                  </option>
                ))}
              </select>
            )}
          </div>

          {/* Amount */}
          <div>
            <label className="block text-zinc-500 mb-1.5" style={{ fontSize: "0.7rem", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em" }}>
              Amount
            </label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" style={{ fontSize: "0.9rem" }}>₹</span>
              <input
                type="number"
                inputMode="decimal"
                min="0"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00"
                className="w-full pl-7 pr-3 py-2.5 rounded-xl border border-black/10 text-zinc-900 tabular-nums focus:border-amber-400 focus:outline-none"
                style={{ fontSize: "0.95rem", fontFamily: "inherit" }}
              />
            </div>
            {overBalance && (
              <p className="text-red-500 mt-1" style={{ fontSize: "0.72rem" }}>
                Exceeds available {bucketMeta[bucket].label.toLowerCase()} balance ({fmt(availableForBucket as number)})
              </p>
            )}
          </div>

          {/* Note */}
          <div>
            <label className="block text-zinc-500 mb-1.5" style={{ fontSize: "0.7rem", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em" }}>
              Note <span className="text-zinc-300 normal-case">(optional)</span>
            </label>
            <input
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. Today's cash collection"
              className="w-full px-3 py-2.5 rounded-xl border border-black/10 text-zinc-800 focus:border-amber-400 focus:outline-none"
              style={{ fontSize: "0.82rem", fontFamily: "inherit" }}
            />
          </div>

          {error && (
            <div className="p-2.5 rounded-lg bg-red-500/10 border border-red-500/20 text-red-600" style={{ fontSize: "0.76rem" }}>
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center gap-2.5 px-5 py-4 border-t border-black/[0.06] bg-zinc-50/60">
          <button
            onClick={onClose}
            className="flex-1 py-2.5 rounded-xl border border-black/10 text-zinc-600 hover:bg-black/[0.03] font-medium"
            style={{ fontSize: "0.82rem", cursor: "pointer", fontFamily: "inherit", background: "#fff" }}
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="flex-1 py-2.5 rounded-xl bg-zinc-900 text-white font-semibold flex items-center justify-center gap-1.5 disabled:opacity-40"
            style={{ fontSize: "0.82rem", cursor: canSubmit ? "pointer" : "not-allowed", fontFamily: "inherit", border: "none" }}
          >
            {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowRight className="w-4 h-4" />}
            Send for approval
          </button>
        </div>
      </div>
    </div>
  );
}
