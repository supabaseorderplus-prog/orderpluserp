"use client";

import { useEffect, useMemo, useState } from "react";
import { api, getUser } from "@/lib/api";
import { ArrowLeft, Building2, FileText, Loader2, Wallet, ImageIcon, X, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";

interface Party {
  id: string;
  name: string;
  party_code: string;
  opening_balance: number;
  wallet_balance: number;
}

interface Transaction {
  id: string;
  date: string;
  type: string;
  reference: string;
  description: string;
  debit: number;
  credit: number;
  balance: number | null;
  proof_url?: string;
  collected_by?: string;
}

interface Summary {
  totalInvoices: number;
  totalPayments: number;
  totalTD: number;
  totalCD: number;
  totalSecurity: number;
  currentBalance: number;
  openingBalance: number;
}

const fmt = (n: number) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(n);

export default function WalletStatementPage() {
  const params = useParams<{ partyId: string }>();
  const searchParams = useSearchParams();
  const partyId = params.partyId;
  const [party, setParty] = useState<Party | null>(null);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [proofPreview, setProofPreview] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<{ applied: number; message: string } | null>(null);

  const currentUser = getUser();
  const isAdmin = ["SUPER_ADMIN", "ADMIN"].includes(currentUser?.role || "");

  useEffect(() => {
    if (!partyId) return;

    const fallbackParty: Party | null = searchParams.get("name")
      ? {
          id: partyId,
          name: searchParams.get("name") || "Party",
          party_code: searchParams.get("code") || "",
          opening_balance: Number(searchParams.get("opening_balance") || 0),
          wallet_balance: Number(searchParams.get("wallet_balance") || 0),
        }
      : null;

    setLoading(true);
    setError("");
    api<{ success: boolean; data: Party }>(`/api/v1/parties/${partyId}`)
      .then(async (partyRes) => {
        const loadedParty = partyRes.data || fallbackParty;
        setParty(loadedParty);

        try {
          const txRes = await api<{ success: boolean; data: { transactions: Transaction[]; summary: Summary } }>(`/api/v1/parties/${partyId}/transactions`);
          setTransactions(txRes.data?.transactions || []);
          setSummary(txRes.data?.summary || null);
        } catch {
          setTransactions([]);
          setSummary({
            totalInvoices: 0,
            totalPayments: 0,
            totalTD: 0,
            totalCD: 0,
            totalSecurity: 0,
            currentBalance: Number(loadedParty?.opening_balance || 0) + Number(loadedParty?.wallet_balance || 0),
            openingBalance: Number(loadedParty?.opening_balance || 0),
          });
        }
      })
      .catch((err) => {
        if (fallbackParty) {
          setParty(fallbackParty);
          setTransactions([]);
          setSummary({
            totalInvoices: 0,
            totalPayments: 0,
            totalTD: 0,
            totalCD: 0,
            totalSecurity: 0,
            currentBalance: Number(fallbackParty.opening_balance || 0) + Number(fallbackParty.wallet_balance || 0),
            openingBalance: Number(fallbackParty.opening_balance || 0),
          });
          return;
        }
        setError(err instanceof Error ? err.message : "Failed to load wallet statement");
      })
      .finally(() => setLoading(false));
  }, [partyId, searchParams]);

  const effectiveBalance = useMemo(() => {
    if (summary) return summary.currentBalance;
    if (!party) return 0;
    return Number(party.opening_balance || 0) + Number(party.wallet_balance || 0);
  }, [party, summary]);

  const statementRows = useMemo(() => {
    // The API returns transactions oldest-first; reverse so the latest sits on top
    // and the oldest at the bottom, preserving exact intra-day sequencing.
    const rows = [...transactions].reverse();
    if (rows.length === 0 && party) {
      const opening = Number(party.opening_balance || 0);
      const wallet = Number(party.wallet_balance || 0);
      if (opening !== 0) {
        rows.push({
          id: "opening-balance",
          date: new Date().toISOString(),
          type: "OPENING",
          reference: party.party_code,
          description: "Opening wallet balance",
          debit: opening < 0 ? Math.abs(opening) : 0,
          credit: opening > 0 ? opening : 0,
          balance: opening,
        });
      }
      if (wallet !== 0) {
        rows.push({
          id: "current-wallet-balance",
          date: new Date().toISOString(),
          type: "WALLET",
          reference: party.party_code,
          description: "Current wallet balance",
          debit: wallet < 0 ? Math.abs(wallet) : 0,
          credit: wallet > 0 ? wallet : 0,
          balance: opening + wallet,
        });
      }
    }
    return rows;
  }, [party, transactions]);

  async function syncWalletDebits() {
    if (!partyId || syncing) return;
    setSyncing(true);
    setSyncResult(null);
    try {
      const res = await api<{ success: boolean; applied: number; message: string }>(
        "/api/v1/invoice-requests/backfill-wallet",
        { method: "POST", body: { party_id: partyId } }
      );
      setSyncResult({ applied: res.applied ?? 0, message: res.message ?? "Done" });
      // Reload page data after sync
      window.location.reload();
    } catch (err) {
      setSyncResult({ applied: 0, message: err instanceof Error ? err.message : "Sync failed" });
    }
    setSyncing(false);
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[55vh]">
        <Loader2 className="w-8 h-8 animate-spin text-amber-500" />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <Link href="/dashboard/payments" className="p-2 rounded-lg border border-black/10 text-zinc-500 hover:text-zinc-900 hover:bg-black/[0.03]">
            <ArrowLeft className="w-4 h-4" />
          </Link>
          <div className="min-w-0">
            <h1 className="text-zinc-900 font-bold truncate" style={{ fontSize: "1.45rem" }}>Wallet Statement</h1>
            <p className="text-zinc-500 truncate" style={{ fontSize: "0.82rem" }}>
              {party ? `${party.name} (${party.party_code})` : "Party wallet ledger"}
            </p>
          </div>
        </div>
        {isAdmin && (
          <div className="flex flex-col items-end gap-1">
            <button
              onClick={syncWalletDebits}
              disabled={syncing}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg border text-xs font-medium transition-all disabled:opacity-50"
              style={{
                background: "rgba(245,158,11,0.06)",
                border: "1px solid rgba(245,158,11,0.25)",
                color: "#d97706",
                cursor: syncing ? "not-allowed" : "pointer",
                fontFamily: "inherit",
              }}
              title="Apply missing invoice debits to this party's wallet"
            >
              {syncing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
              Sync Invoice Debits
            </button>
            {syncResult && (
              <span className="text-[0.65rem] text-zinc-500">{syncResult.message}</span>
            )}
          </div>
        )}
      </div>

      {error ? (
        <div className="rounded-xl border border-red-500/20 bg-red-500/[0.04] p-5 text-red-500" style={{ fontSize: "0.85rem" }}>
          {error}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="rounded-xl border border-black/[0.06] bg-white p-4">
              <div className="flex items-center gap-2 text-zinc-500 mb-2" style={{ fontSize: "0.68rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                <Wallet className="w-3.5 h-3.5" /> Effective Balance
              </div>
              <div className={`font-bold ${effectiveBalance < 0 ? "text-red-500" : effectiveBalance > 0 ? "text-emerald-500" : "text-zinc-500"}`} style={{ fontSize: "1.25rem" }}>
                {fmt(Math.abs(effectiveBalance))}
              </div>
              <div className="text-zinc-400 mt-1" style={{ fontSize: "0.68rem" }}>
                {effectiveBalance < 0 ? "Party owes you" : effectiveBalance > 0 ? "You owe party" : "Settled"}
              </div>
            </div>
            <div className="rounded-xl border border-black/[0.06] bg-white p-4">
              <div className="flex items-center gap-2 text-zinc-500 mb-2" style={{ fontSize: "0.68rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                <Building2 className="w-3.5 h-3.5" /> Opening Balance
              </div>
              <div className="text-zinc-900 font-bold" style={{ fontSize: "1.25rem" }}>{fmt(summary?.openingBalance ?? Number(party?.opening_balance || 0))}</div>
            </div>
            <div className="rounded-xl border border-black/[0.06] bg-white p-4">
              <div className="flex items-center gap-2 text-zinc-500 mb-2" style={{ fontSize: "0.68rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                <FileText className="w-3.5 h-3.5" /> Records
              </div>
              <div className="text-zinc-900 font-bold" style={{ fontSize: "1.25rem" }}>{statementRows.length}</div>
            </div>
          </div>

          {/* Proof lightbox */}
          {proofPreview && (
            <div
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
              onClick={() => setProofPreview(null)}
            >
              <div className="relative max-w-2xl w-full mx-4" onClick={e => e.stopPropagation()}>
                <button
                  onClick={() => setProofPreview(null)}
                  className="absolute -top-10 right-0 text-white/80 hover:text-white flex items-center gap-1"
                  style={{ fontSize: "0.8rem", background: "none", border: "none", cursor: "pointer" }}
                >
                  <X className="w-4 h-4" /> Close
                </button>
                <img src={proofPreview} alt="Payment proof" className="w-full rounded-xl shadow-2xl" style={{ maxHeight: "80vh", objectFit: "contain" }} />
              </div>
            </div>
          )}

          <div className="rounded-xl border border-black/[0.06] overflow-hidden bg-white">
            <table className="w-full" style={{ borderCollapse: "collapse" }}>
              <thead>
                <tr className="border-b border-black/[0.06] bg-black/[0.02]">
                  {["Date", "Type", "Reference", "Description", "Debit", "Credit", "Balance", "Proof"].map((h) => (
                    <th key={h} className="text-left px-4 py-3 text-xs font-medium text-zinc-500" style={{ fontSize: "0.68rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {statementRows.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="text-center py-16 text-zinc-500" style={{ fontSize: "0.85rem" }}>
                      No wallet statement records found.
                    </td>
                  </tr>
                ) : (
                  statementRows.map((tx) => (
                    <tr key={tx.id} className="border-b border-black/[0.04] hover:bg-black/[0.01]">
                      <td className="px-4 py-3 text-zinc-600" style={{ fontSize: "0.78rem" }}>
                        {new Date(tx.date).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}
                      </td>
                      <td className="px-4 py-3">
                        <span className="px-2 py-0.5 rounded bg-zinc-100 text-zinc-600" style={{ fontSize: "0.68rem" }}>{tx.type}</span>
                      </td>
                      <td className="px-4 py-3 text-zinc-500 font-mono" style={{ fontSize: "0.74rem" }}>{tx.reference || "-"}</td>
                      <td className="px-4 py-3 text-zinc-700" style={{ fontSize: "0.78rem" }}>
                        {tx.description || "-"}
                        {tx.collected_by && (
                          <span className="block text-zinc-400" style={{ fontSize: "0.66rem" }}>
                            Collected by {tx.collected_by}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-red-500 font-mono" style={{ fontSize: "0.78rem" }}>{tx.debit > 0 ? fmt(tx.debit) : "-"}</td>
                      <td className="px-4 py-3 text-emerald-500 font-mono" style={{ fontSize: "0.78rem" }}>{tx.credit > 0 ? fmt(tx.credit) : "-"}</td>
                      <td className={`px-4 py-3 font-mono ${tx.balance === null ? "text-zinc-400" : tx.balance < 0 ? "text-red-500" : tx.balance > 0 ? "text-emerald-500" : "text-zinc-500"}`} style={{ fontSize: "0.78rem" }}>
                        {tx.balance === null ? "-" : fmt(tx.balance)}
                      </td>
                      <td className="px-4 py-3">
                        {tx.proof_url ? (
                          <button
                            onClick={() => setProofPreview(tx.proof_url!)}
                            className="flex items-center gap-1 px-2 py-1 rounded-lg border border-blue-500/20 bg-blue-500/5 text-blue-500 hover:bg-blue-500/10 transition-colors"
                            style={{ fontSize: "0.68rem", background: undefined, cursor: "pointer" }}
                          >
                            <ImageIcon className="w-3 h-3" /> View
                          </button>
                        ) : (
                          <span className="text-zinc-300" style={{ fontSize: "0.72rem" }}>—</span>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
