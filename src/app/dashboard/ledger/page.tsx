"use client";

import React, { useEffect, useState, useCallback } from "react";
import { api } from "@/lib/api";
import {
  AlertCircle, ArrowDownCircle, ArrowUpCircle, ChevronLeft,
  ChevronRight, FileText, Loader2, Printer, X,
} from "lucide-react";

interface LedgerEntry {
  id: string;
  party_id: string;
  type: "DEBIT" | "CREDIT";
  amount: number;
  balance_after: number;
  reference_id: string | null;
  reference_type: string | null;
  narration: string | null;
  entry_date: string;
  fiscal_year: string;
  created_at: string;
}

interface LedgerSummary { totalDebit: number; totalCredit: number; outstanding: number }
interface Party { id: string; name: string; party_code: string }
interface Pagination { page: number; limit: number; total: number; pages: number }

const fmt = (n: number) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(n);

export default function LedgerPage() {
  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  const [summary, setSummary] = useState<LedgerSummary>({ totalDebit: 0, totalCredit: 0, outstanding: 0 });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pagination, setPagination] = useState<Pagination>({ page: 1, limit: 50, total: 0, pages: 0 });
  const [selectedParty, setSelectedParty] = useState<Party | null>(null);
  const [parties, setParties] = useState<Party[]>([]);
  const [partySearch, setPartySearch] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const fetchParties = useCallback(async () => {
    try {
      const res = await api<{ data: Party[] }>("/api/v1/parties?limit=300&is_verified=all");
      setParties(res.data || []);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { fetchParties(); }, [fetchParties]);

  const fetchLedger = useCallback(async (page = 1) => {
    if (!selectedParty) return;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ page: String(page), limit: "50" });
      if (dateFrom) params.set("from", dateFrom);
      if (dateTo) params.set("to", dateTo);
      const res = await api<{ data: LedgerEntry[]; summary: LedgerSummary; pagination: Pagination }>(`/api/v1/ledger/${selectedParty.id}?${params}`);
      setEntries(res.data || []);
      setSummary(res.summary || { totalDebit: 0, totalCredit: 0, outstanding: 0 });
      setPagination(res.pagination || { page: 1, limit: 50, total: 0, pages: 0 });
    } catch {
      setError("Failed to load ledger entries");
    } finally {
      setLoading(false);
    }
  }, [selectedParty, dateFrom, dateTo]);

  useEffect(() => { if (selectedParty) fetchLedger(1); }, [fetchLedger, selectedParty]);

  const handlePrint = () => {
    if (!selectedParty) return;
    const html = `
      <!DOCTYPE html><html><head>
      <title>Ledger Statement — ${selectedParty.name}</title>
      <style>
        body { font-family: Arial, sans-serif; font-size: 12px; color: #111; padding: 20px; }
        h1 { font-size: 18px; margin-bottom: 4px; }
        .sub { color: #555; font-size: 13px; margin-bottom: 20px; }
        table { width: 100%; border-collapse: collapse; margin-top: 10px; }
        th { background: #f0f0f0; padding: 8px; text-align: left; border: 1px solid #ddd; font-size: 11px; text-transform: uppercase; }
        td { padding: 7px 8px; border: 1px solid #eee; vertical-align: top; }
        .debit { color: #c0392b; } .credit { color: #27ae60; }
        .summary { display: flex; gap: 40px; margin-top: 20px; padding: 12px; background: #f9f9f9; border-radius: 6px; }
        .summary-item { text-align: center; }
        .summary-item .label { font-size: 10px; color: #777; text-transform: uppercase; }
        .summary-item .value { font-size: 16px; font-weight: bold; margin-top: 2px; }
        @media print { body { padding: 10px; } }
      </style></head><body>
      <h1>Ledger Statement</h1>
      <div class="sub">${selectedParty.name} (${selectedParty.party_code})${dateFrom || dateTo ? ` &nbsp;|&nbsp; ${dateFrom || "—"} to ${dateTo || "—"}` : ""}</div>
      <div class="summary">
        <div class="summary-item"><div class="label">Total Debit</div><div class="value debit">${fmt(summary.totalDebit)}</div></div>
        <div class="summary-item"><div class="label">Total Credit</div><div class="value credit">${fmt(summary.totalCredit)}</div></div>
        <div class="summary-item"><div class="label">Outstanding</div><div class="value">${fmt(summary.outstanding)}</div></div>
      </div>
      <table>
        <thead><tr><th>Date</th><th>Narration</th><th>Reference</th><th>Debit</th><th>Credit</th><th>Balance</th></tr></thead>
        <tbody>
          ${entries.map(e => `
            <tr>
              <td>${new Date(e.entry_date).toLocaleDateString("en-IN")}</td>
              <td>${e.narration || "—"}</td>
              <td style="font-size:10px;color:#777">${e.reference_type || ""}${e.reference_id ? " · " + e.reference_id.slice(0, 8) : ""}</td>
              <td class="debit">${e.type === "DEBIT" ? fmt(e.amount) : ""}</td>
              <td class="credit">${e.type === "CREDIT" ? fmt(e.amount) : ""}</td>
              <td>${fmt(e.balance_after)}</td>
            </tr>`).join("")}
        </tbody>
      </table>
      <script>window.onload=()=>window.print()</script></body></html>`;
    const w = window.open("", "_blank");
    if (w) { w.document.write(html); w.document.close(); }
  };

  const filteredParties = parties.filter(
    p => p.name.toLowerCase().includes(partySearch.toLowerCase()) ||
         p.party_code.toLowerCase().includes(partySearch.toLowerCase())
  );

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Ledger</h1>
          <p className="text-zinc-400 text-sm mt-1">Unified DEBIT / CREDIT party statement</p>
        </div>
        {selectedParty && (
          <button
            onClick={handlePrint}
            className="flex items-center gap-2 px-4 py-2 bg-zinc-700 hover:bg-zinc-600 text-white rounded-lg text-sm font-medium transition-colors"
          >
            <Printer className="w-4 h-4" /> Print Statement
          </button>
        )}
      </div>

      {error && (
        <div className="flex items-center gap-2 px-4 py-3 bg-red-900/30 border border-red-700/50 rounded-lg text-red-400 text-sm">
          <AlertCircle className="w-4 h-4 shrink-0" /> {error}
          <button onClick={() => setError(null)} className="ml-auto"><X className="w-4 h-4" /></button>
        </div>
      )}

      {/* Party Selector + Date Filters */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div>
          <label className="block text-xs text-zinc-400 mb-1.5">Select Party</label>
          <input
            type="text"
            placeholder="Search party..."
            value={partySearch}
            onChange={e => setPartySearch(e.target.value)}
            className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white placeholder-zinc-500 mb-2"
          />
          {partySearch && (
            <div className="absolute z-10 mt-1 max-h-48 overflow-y-auto bg-zinc-800 border border-zinc-700 rounded-lg shadow-xl">
              {filteredParties.slice(0, 20).map(p => (
                <button
                  key={p.id}
                  onClick={() => { setSelectedParty(p); setPartySearch(""); }}
                  className="w-full text-left px-4 py-2.5 hover:bg-zinc-700 text-sm text-white"
                >
                  {p.name} <span className="text-zinc-500 text-xs">({p.party_code})</span>
                </button>
              ))}
              {filteredParties.length === 0 && (
                <div className="px-4 py-3 text-zinc-500 text-sm">No parties found</div>
              )}
            </div>
          )}
          {selectedParty && (
            <div className="flex items-center justify-between px-3 py-2 bg-blue-600/20 border border-blue-600/30 rounded-lg">
              <span className="text-blue-300 text-sm font-medium">{selectedParty.name}</span>
              <button onClick={() => { setSelectedParty(null); setEntries([]); }} className="text-zinc-400 hover:text-white ml-2">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
        </div>
        <div>
          <label className="block text-xs text-zinc-400 mb-1.5">From Date</label>
          <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
            className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white" />
        </div>
        <div>
          <label className="block text-xs text-zinc-400 mb-1.5">To Date</label>
          <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}
            className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white" />
        </div>
      </div>

      {/* Summary Cards */}
      {selectedParty && (
        <div className="grid grid-cols-3 gap-4">
          <div className="bg-zinc-900 border border-zinc-700/50 rounded-xl p-4">
            <div className="flex items-center gap-2 mb-2">
              <ArrowDownCircle className="w-4 h-4 text-red-400" />
              <span className="text-zinc-400 text-xs uppercase tracking-wider">Total Debit</span>
            </div>
            <div className="text-red-400 text-xl font-bold">{fmt(summary.totalDebit)}</div>
          </div>
          <div className="bg-zinc-900 border border-zinc-700/50 rounded-xl p-4">
            <div className="flex items-center gap-2 mb-2">
              <ArrowUpCircle className="w-4 h-4 text-emerald-400" />
              <span className="text-zinc-400 text-xs uppercase tracking-wider">Total Credit</span>
            </div>
            <div className="text-emerald-400 text-xl font-bold">{fmt(summary.totalCredit)}</div>
          </div>
          <div className="bg-zinc-900 border border-zinc-700/50 rounded-xl p-4">
            <div className="flex items-center gap-2 mb-2">
              <FileText className="w-4 h-4 text-amber-400" />
              <span className="text-zinc-400 text-xs uppercase tracking-wider">Outstanding</span>
            </div>
            <div className={`text-xl font-bold ${summary.outstanding > 0 ? "text-amber-400" : "text-emerald-400"}`}>
              {fmt(Math.abs(summary.outstanding))}
              {summary.outstanding < 0 && <span className="text-xs font-normal text-emerald-500 ml-1">(advance)</span>}
            </div>
          </div>
        </div>
      )}

      {/* Ledger Table */}
      {selectedParty ? (
        <div className="bg-zinc-900 border border-zinc-700/50 rounded-xl overflow-hidden">
          {loading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="w-6 h-6 animate-spin text-zinc-500" />
            </div>
          ) : entries.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-zinc-500">
              <FileText className="w-10 h-10 mb-3 opacity-40" />
              <p>No ledger entries for this party</p>
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-700/50 text-zinc-400 text-xs uppercase tracking-wider">
                  <th className="px-4 py-3 text-left">Date</th>
                  <th className="px-4 py-3 text-left">Narration</th>
                  <th className="px-4 py-3 text-left">Ref Type</th>
                  <th className="px-4 py-3 text-right">Debit</th>
                  <th className="px-4 py-3 text-right">Credit</th>
                  <th className="px-4 py-3 text-right">Balance</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800">
                {entries.map((e) => (
                  <tr key={e.id} className="hover:bg-zinc-800/50 transition-colors">
                    <td className="px-4 py-3 text-zinc-400">
                      {new Date(e.entry_date).toLocaleDateString("en-IN")}
                    </td>
                    <td className="px-4 py-3 text-zinc-300">{e.narration || "—"}</td>
                    <td className="px-4 py-3">
                      {e.reference_type && (
                        <span className="px-2 py-0.5 bg-zinc-800 text-zinc-400 rounded text-xs">
                          {e.reference_type}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {e.type === "DEBIT" ? (
                        <span className="text-red-400 font-medium">{fmt(e.amount)}</span>
                      ) : "—"}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {e.type === "CREDIT" ? (
                        <span className="text-emerald-400 font-medium">{fmt(e.amount)}</span>
                      ) : "—"}
                    </td>
                    <td className="px-4 py-3 text-right text-white font-medium">{fmt(e.balance_after)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center py-20 text-zinc-600 bg-zinc-900 border border-zinc-700/50 rounded-xl">
          <FileText className="w-12 h-12 mb-4 opacity-30" />
          <p className="text-lg font-medium">Select a party to view their ledger</p>
          <p className="text-sm mt-1 text-zinc-700">Search by name or party code above</p>
        </div>
      )}

      {pagination.pages > 1 && (
        <div className="flex items-center justify-between text-sm text-zinc-400">
          <span>{pagination.total} entries</span>
          <div className="flex gap-2">
            <button
              onClick={() => fetchLedger(pagination.page - 1)}
              disabled={pagination.page <= 1}
              className="p-1.5 rounded bg-zinc-800 hover:bg-zinc-700 disabled:opacity-30"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <span className="px-3 py-1 bg-zinc-800 rounded">{pagination.page} / {pagination.pages}</span>
            <button
              onClick={() => fetchLedger(pagination.page + 1)}
              disabled={pagination.page >= pagination.pages}
              className="p-1.5 rounded bg-zinc-800 hover:bg-zinc-700 disabled:opacity-30"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
