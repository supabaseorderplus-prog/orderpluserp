"use client";

import { useCallback, useEffect, useState } from "react";
import {
  X, Loader2, Plus, FileText, Wallet, SlidersHorizontal, ArrowUpRight, ArrowDownLeft, Download,
} from "lucide-react";
import { Vendor, VendorTransaction, VendorTxnType, vendorAuthHeaders, inr, balanceLabel } from "./vendor-types";
import { toCsv, downloadCsv } from "@/lib/csv";

const inp = "w-full px-3 py-2 rounded-lg border border-black/10 bg-black/[0.03] text-zinc-900 outline-none focus:border-amber-500/40";
const sel = "w-full px-3 py-2 rounded-lg border border-black/10 bg-white text-zinc-900 outline-none focus:border-amber-500/40";
const is: React.CSSProperties = { fontSize: "0.8rem", fontFamily: "inherit" };
const lbl: React.CSSProperties = { fontSize: "0.7rem", display: "block", marginBottom: "0.2rem", color: "#a1a1aa" };

interface VendorLedgerModalProps {
  vendor: Vendor;
  onClose: () => void;
  onBalanceChange: (vendorId: string, balance: number) => void;
}

const txnMeta: Record<VendorTxnType, { label: string; Icon: typeof FileText; tone: string }> = {
  BILL: { label: "Bill", Icon: FileText, tone: "text-rose-500 bg-rose-500/10" },
  PAYMENT: { label: "Payment", Icon: Wallet, tone: "text-emerald-500 bg-emerald-500/10" },
  ADJUSTMENT: { label: "Adjustment", Icon: SlidersHorizontal, tone: "text-amber-500 bg-amber-500/10" },
};

export default function VendorLedgerModal({ vendor, onClose, onBalanceChange }: VendorLedgerModalProps) {
  const [txns, setTxns] = useState<VendorTransaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [balance, setBalance] = useState(vendor.current_balance ?? vendor.opening_balance);
  const [error, setError] = useState("");

  const [showAdd, setShowAdd] = useState(false);
  const [txnType, setTxnType] = useState<VendorTxnType>("BILL");
  const [amount, setAmount] = useState("");
  const [txnDate, setTxnDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [reference, setReference] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/v1/vendors/${vendor.id}/ledger`, { headers: vendorAuthHeaders() });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.message || "Failed to load ledger");
      setTxns((json.data as VendorTransaction[]) || []);
      setBalance(json.current_balance ?? vendor.opening_balance);
      onBalanceChange(vendor.id, json.current_balance ?? vendor.opening_balance);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load ledger");
    } finally {
      setLoading(false);
    }
  }, [vendor.id, vendor.opening_balance, onBalanceChange]);

  useEffect(() => { load(); }, [load]);

  const addTransaction = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt === 0) { setError("Enter a non-zero amount."); return; }
    setSaving(true);
    try {
      const res = await fetch(`/api/v1/vendors/${vendor.id}/ledger`, {
        method: "POST",
        headers: vendorAuthHeaders(),
        body: JSON.stringify({ txn_type: txnType, amount: amt, txn_date: txnDate, reference_number: reference, description }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.message || "Failed to add transaction");
      setShowAdd(false);
      setAmount(""); setReference(""); setDescription("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add transaction");
    } finally {
      setSaving(false);
    }
  };

  // Export this vendor's full transaction history (oldest → newest) as a CSV.
  const exportLedger = useCallback(() => {
    const rows = txns.map((t) => {
      const signed = t.txn_type === "PAYMENT" ? -Math.abs(t.amount) : t.amount;
      return [
        t.txn_date,
        t.txn_type,
        t.reference_number ?? "",
        t.description ?? "",
        signed.toFixed(2),
        t.running_balance != null ? t.running_balance.toFixed(2) : "",
      ];
    });
    const csv = toCsv(
      ["Date", "Type", "Reference", "Description", "Amount", "Running Balance"],
      rows,
    );
    const safeName = vendor.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
    downloadCsv(`ledger-${vendor.vendor_code}-${safeName}.csv`, csv);
  }, [txns, vendor.name, vendor.vendor_code]);

  const bl = balanceLabel(vendor, balance);
  const balTone = bl.tone === "payable" ? "text-rose-600" : bl.tone === "receivable" ? "text-emerald-600" : "text-zinc-500";

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 overflow-y-auto" onClick={onClose}>
      <div className="w-full max-w-2xl rounded-2xl bg-white shadow-2xl mt-8" style={{ fontFamily: "'Inter','system-ui',sans-serif" }} onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-start justify-between px-5 py-4 border-b border-black/[0.06]">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="font-bold text-zinc-900" style={{ fontSize: "1rem" }}>{vendor.name}</h2>
            </div>
            <p className="text-zinc-500 font-mono" style={{ fontSize: "0.68rem", margin: "2px 0 0" }}>
              {vendor.vendor_code}{vendor.city ? ` • ${vendor.city}` : ""}
            </p>
          </div>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-700" style={{ background: "none", border: "none", cursor: "pointer" }}>
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {/* Balance summary */}
          <div className="flex items-center justify-between rounded-xl border border-black/[0.07] bg-black/[0.02] px-4 py-3">
            <div>
              <p style={{ fontSize: "0.68rem", color: "#a1a1aa", margin: 0 }}>{bl.text}</p>
              <p className={`font-bold ${balTone}`} style={{ fontSize: "1.4rem", margin: "2px 0 0" }}>{inr(balance)}</p>
            </div>
            <button onClick={() => { setShowAdd((s) => !s); setError(""); }}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-amber-500 text-zinc-900 hover:bg-amber-600 transition-all"
              style={{ fontSize: "0.78rem", border: "none", cursor: "pointer" }}>
              <Plus className="w-4 h-4" /> Add Entry
            </button>
          </div>

          {/* Add transaction form */}
          {showAdd && (
            <form onSubmit={addTransaction} className="rounded-xl border border-amber-500/20 bg-amber-500/[0.04] p-4 space-y-3">
              <div className="grid grid-cols-3 gap-2">
                {(["BILL", "PAYMENT", "ADJUSTMENT"] as VendorTxnType[]).map((t) => {
                  const m = txnMeta[t];
                  const active = txnType === t;
                  return (
                    <button key={t} type="button" onClick={() => setTxnType(t)}
                      className={`flex items-center justify-center gap-1.5 py-2 rounded-lg border transition-all ${active ? "border-amber-500/50 bg-white" : "border-black/10 bg-black/[0.02] hover:bg-black/[0.04]"}`}
                      style={{ fontSize: "0.74rem", cursor: "pointer", fontWeight: active ? 600 : 400 }}>
                      <m.Icon className="w-3.5 h-3.5" /> {m.label}
                    </button>
                  );
                })}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label style={lbl}>Amount (INR) *</label>
                  <input className={inp} style={is} type="number" step="any" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus />
                </div>
                <div>
                  <label style={lbl}>Date</label>
                  <input className={sel} style={is} type="date" value={txnDate} onChange={(e) => setTxnDate(e.target.value)} />
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label style={lbl}>Reference No.</label>
                  <input className={inp} style={is} placeholder="Bill / UTR no." value={reference} onChange={(e) => setReference(e.target.value)} />
                </div>
                <div>
                  <label style={lbl}>Description</label>
                  <input className={inp} style={is} value={description} onChange={(e) => setDescription(e.target.value)} />
                </div>
              </div>
              {txnType === "ADJUSTMENT" && (
                <p className="text-zinc-500" style={{ fontSize: "0.68rem", margin: 0 }}>
                  Use a negative amount to reduce the balance.
                </p>
              )}
              <div className="flex justify-end gap-2">
                <button type="button" onClick={() => setShowAdd(false)} className="px-3 py-1.5 rounded-lg border border-black/10 text-zinc-600 hover:bg-black/5" style={{ fontSize: "0.76rem", background: "none", cursor: "pointer" }}>Cancel</button>
                <button type="submit" disabled={saving} className="px-4 py-1.5 rounded-lg bg-amber-500 text-zinc-900 hover:bg-amber-600 disabled:opacity-50 flex items-center gap-1.5" style={{ fontSize: "0.76rem", border: "none", cursor: "pointer" }}>
                  {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Save
                </button>
              </div>
            </form>
          )}

          {error && <p className="text-rose-500" style={{ fontSize: "0.78rem" }}>{error}</p>}

          {/* Ledger list */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-zinc-700 font-semibold" style={{ fontSize: "0.78rem" }}>Ledger</h3>
              <div className="flex items-center gap-2.5">
                <span className="text-zinc-400" style={{ fontSize: "0.68rem" }}>Opening {inr(vendor.opening_balance)}</span>
                <button
                  onClick={exportLedger}
                  disabled={txns.length === 0}
                  title="Download transaction history (CSV)"
                  className="flex items-center gap-1 px-2 py-1 rounded-lg border border-black/10 text-zinc-600 hover:bg-black/5 disabled:opacity-40"
                  style={{ fontSize: "0.68rem", background: "none", cursor: "pointer" }}
                >
                  <Download className="w-3 h-3" /> CSV
                </button>
              </div>
            </div>
            {loading ? (
              <div className="flex justify-center py-8"><Loader2 className="w-5 h-5 text-amber-500 animate-spin" /></div>
            ) : txns.length === 0 ? (
              <p className="text-center text-zinc-400 py-8" style={{ fontSize: "0.8rem" }}>No transactions yet.</p>
            ) : (
              <div className="space-y-1.5">
                {[...txns].reverse().map((t) => {
                  const m = txnMeta[t.txn_type];
                  const signed = t.txn_type === "PAYMENT" ? -Math.abs(t.amount) : t.amount;
                  return (
                    <div key={t.id} className="flex items-center gap-3 rounded-lg border border-black/[0.06] px-3 py-2">
                      <span className={`flex items-center justify-center w-7 h-7 rounded-lg ${m.tone}`}>
                        <m.Icon className="w-3.5 h-3.5" />
                      </span>
                      <div className="flex-1 min-w-0">
                        <p className="text-zinc-800 font-medium truncate" style={{ fontSize: "0.78rem", margin: 0 }}>
                          {m.label}{t.reference_number ? ` · ${t.reference_number}` : ""}
                        </p>
                        <p className="text-zinc-400 truncate" style={{ fontSize: "0.66rem", margin: 0 }}>
                          {t.txn_date}{t.description ? ` · ${t.description}` : ""}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className={`font-semibold flex items-center gap-1 justify-end ${signed < 0 ? "text-emerald-600" : "text-rose-600"}`} style={{ fontSize: "0.8rem", margin: 0 }}>
                          {signed < 0 ? <ArrowDownLeft className="w-3 h-3" /> : <ArrowUpRight className="w-3 h-3" />}
                          {inr(t.amount)}
                        </p>
                        {t.running_balance != null && (
                          <p className="text-zinc-400" style={{ fontSize: "0.64rem", margin: 0 }}>bal {inr(t.running_balance)}</p>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
