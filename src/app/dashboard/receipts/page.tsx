"use client";

import React, { useEffect, useState, useCallback } from "react";
import { api } from "@/lib/api";
import {
  AlertCircle, CheckCircle2, ChevronLeft, ChevronRight,
  Clock, FileText, Loader2, Plus, Trash2, X,
} from "lucide-react";

interface Receipt {
  id: string;
  receipt_number: string;
  party_id: string;
  salesman_id: string | null;
  amount: number;
  payment_mode: string;
  reference_number: string | null;
  bank_name: string | null;
  notes: string | null;
  receipt_date: string;
  approval_status: "PENDING_APPROVAL" | "APPROVED" | "REJECTED";
  approved_by: string | null;
  approval_time: string | null;
  status: string;
  created_at: string;
  parties?: { id: string; name: string; phone: string | null } | null;
}

interface Party { id: string; name: string; party_code: string }
interface Pagination { page: number; limit: number; total: number; pages: number }

const modeColors: Record<string, string> = {
  NEFT: "bg-blue-500/20 text-blue-400",
  RTGS: "bg-purple-500/20 text-purple-400",
  UPI: "bg-emerald-500/20 text-emerald-400",
  CHEQUE: "bg-amber-500/20 text-amber-400",
  CASH: "bg-zinc-500/20 text-zinc-400",
  DD: "bg-cyan-500/20 text-cyan-400",
};

const statusColors: Record<string, string> = {
  PENDING_APPROVAL: "bg-amber-500/20 text-amber-400",
  APPROVED: "bg-emerald-500/20 text-emerald-400",
  REJECTED: "bg-red-500/20 text-red-400",
};

const fmt = (n: number) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(n);

export default function ReceiptsPage() {
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pagination, setPagination] = useState<Pagination>({ page: 1, limit: 20, total: 0, pages: 0 });
  const [filterStatus, setFilterStatus] = useState("");
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [parties, setParties] = useState<Party[]>([]);
  const [form, setForm] = useState({
    party_id: "", amount: "", payment_mode: "CASH",
    reference_number: "", bank_name: "", notes: "",
  });

  const fetchReceipts = useCallback(async (page = 1) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ page: String(page), limit: "20" });
      if (filterStatus) params.set("approval_status", filterStatus);
      const res = await api<{ data: Receipt[]; pagination: Pagination }>(`/api/v1/receipts?${params}`);
      setReceipts(res.data || []);
      setPagination(res.pagination || { page: 1, limit: 20, total: 0, pages: 0 });
    } catch {
      setError("Failed to load receipts");
    } finally {
      setLoading(false);
    }
  }, [filterStatus]);

  const fetchParties = useCallback(async () => {
    try {
      const res = await api<{ data: Party[] }>("/api/v1/parties?limit=200&is_verified=all");
      setParties(res.data || []);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { fetchReceipts(1); }, [fetchReceipts]);
  useEffect(() => { if (showCreateModal) fetchParties(); }, [showCreateModal, fetchParties]);

  const handleApprove = async (id: string) => {
    setActionLoading(id);
    try {
      await api(`/api/v1/receipts/${id}/approve`, { method: 'POST' });
      fetchReceipts(pagination.page);
    } catch {
      setError("Failed to approve receipt");
    } finally {
      setActionLoading(null);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Delete this pending receipt?")) return;
    setActionLoading(id);
    try {
      await api(`/api/v1/receipts/${id}/approve`, { method: 'DELETE' });
      fetchReceipts(pagination.page);
    } catch {
      setError("Failed to delete receipt");
    } finally {
      setActionLoading(null);
    }
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setActionLoading("create");
    try {
      await api("/api/v1/receipts", { method: 'POST', body: {
        party_id: form.party_id,
        amount: Number(form.amount),
        payment_mode: form.payment_mode,
        reference_number: form.reference_number || undefined,
        bank_name: form.bank_name || undefined,
        notes: form.notes || undefined,
      } });
      setShowCreateModal(false);
      setForm({ party_id: "", amount: "", payment_mode: "CASH", reference_number: "", bank_name: "", notes: "" });
      fetchReceipts(1);
    } catch {
      setError("Failed to create receipt");
    } finally {
      setActionLoading(null);
    }
  };

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Receipts</h1>
          <p className="text-zinc-400 text-sm mt-1">Manage payment collections with approval workflow</p>
        </div>
        <button
          onClick={() => setShowCreateModal(true)}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm font-medium transition-colors"
        >
          <Plus className="w-4 h-4" /> New Receipt
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-2 px-4 py-3 bg-red-900/30 border border-red-700/50 rounded-lg text-red-400 text-sm">
          <AlertCircle className="w-4 h-4 shrink-0" /> {error}
          <button onClick={() => setError(null)} className="ml-auto"><X className="w-4 h-4" /></button>
        </div>
      )}

      {/* Filters */}
      <div className="flex gap-3 flex-wrap">
        {["", "PENDING_APPROVAL", "APPROVED", "REJECTED"].map((s) => (
          <button
            key={s}
            onClick={() => setFilterStatus(s)}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
              filterStatus === s
                ? "bg-blue-600 text-white"
                : "bg-zinc-800 text-zinc-400 hover:text-white"
            }`}
          >
            {s === "" ? "All" : s.replace("_", " ")}
          </button>
        ))}
      </div>

      {/* Table */}
      <div className="bg-zinc-900 border border-zinc-700/50 rounded-xl overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="w-6 h-6 animate-spin text-zinc-500" />
          </div>
        ) : receipts.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-zinc-500">
            <FileText className="w-10 h-10 mb-3 opacity-40" />
            <p>No receipts found</p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-700/50 text-zinc-400 text-xs uppercase tracking-wider">
                <th className="px-4 py-3 text-left">Receipt #</th>
                <th className="px-4 py-3 text-left">Party</th>
                <th className="px-4 py-3 text-left">Date</th>
                <th className="px-4 py-3 text-right">Amount</th>
                <th className="px-4 py-3 text-left">Mode</th>
                <th className="px-4 py-3 text-left">Status</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800">
              {receipts.map((r) => (
                <tr key={r.id} className="hover:bg-zinc-800/50 transition-colors">
                  <td className="px-4 py-3 text-white font-mono text-xs">{r.receipt_number}</td>
                  <td className="px-4 py-3 text-zinc-300">
                    {r.parties?.name || r.party_id.slice(0, 8)}
                  </td>
                  <td className="px-4 py-3 text-zinc-400">
                    {new Date(r.receipt_date).toLocaleDateString("en-IN")}
                  </td>
                  <td className="px-4 py-3 text-right text-white font-medium">{fmt(r.amount)}</td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-0.5 rounded text-xs font-medium ${modeColors[r.payment_mode] || "bg-zinc-700 text-zinc-300"}`}>
                      {r.payment_mode}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`flex items-center gap-1 w-fit px-2 py-0.5 rounded text-xs font-medium ${statusColors[r.approval_status]}`}>
                      {r.approval_status === "APPROVED" ? <CheckCircle2 className="w-3 h-3" /> : <Clock className="w-3 h-3" />}
                      {r.approval_status.replace("_", " ")}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-2">
                      {r.approval_status === "PENDING_APPROVAL" && (
                        <>
                          <button
                            onClick={() => handleApprove(r.id)}
                            disabled={actionLoading === r.id}
                            className="flex items-center gap-1 px-3 py-1 bg-emerald-600/20 hover:bg-emerald-600/40 text-emerald-400 rounded text-xs font-medium transition-colors disabled:opacity-50"
                          >
                            {actionLoading === r.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <CheckCircle2 className="w-3 h-3" />}
                            Approve
                          </button>
                          <button
                            onClick={() => handleDelete(r.id)}
                            disabled={actionLoading === r.id}
                            className="flex items-center gap-1 px-2 py-1 bg-red-600/20 hover:bg-red-600/40 text-red-400 rounded text-xs transition-colors disabled:opacity-50"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </>
                      )}
                      {r.approval_status === "APPROVED" && (
                        <span className="text-zinc-600 text-xs">
                          {r.approval_time ? new Date(r.approval_time).toLocaleDateString("en-IN") : "—"}
                        </span>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination */}
      {pagination.pages > 1 && (
        <div className="flex items-center justify-between text-sm text-zinc-400">
          <span>{pagination.total} receipts</span>
          <div className="flex gap-2">
            <button
              onClick={() => fetchReceipts(pagination.page - 1)}
              disabled={pagination.page <= 1}
              className="p-1.5 rounded bg-zinc-800 hover:bg-zinc-700 disabled:opacity-30"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <span className="px-3 py-1 bg-zinc-800 rounded">{pagination.page} / {pagination.pages}</span>
            <button
              onClick={() => fetchReceipts(pagination.page + 1)}
              disabled={pagination.page >= pagination.pages}
              className="p-1.5 rounded bg-zinc-800 hover:bg-zinc-700 disabled:opacity-30"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* Create Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-zinc-900 border border-zinc-700 rounded-2xl w-full max-w-md p-6">
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-white font-semibold text-lg">New Receipt</h2>
              <button onClick={() => setShowCreateModal(false)} className="text-zinc-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleCreate} className="space-y-4">
              <div>
                <label className="block text-xs text-zinc-400 mb-1.5">Party *</label>
                <select
                  required
                  value={form.party_id}
                  onChange={e => setForm(f => ({ ...f, party_id: e.target.value }))}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white"
                >
                  <option value="">Select party...</option>
                  {parties.map(p => (
                    <option key={p.id} value={p.id}>{p.name} ({p.party_code})</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-zinc-400 mb-1.5">Amount *</label>
                <input
                  type="number" required min="1" step="0.01"
                  value={form.amount}
                  onChange={e => setForm(f => ({ ...f, amount: e.target.value }))}
                  placeholder="0.00"
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white"
                />
              </div>
              <div>
                <label className="block text-xs text-zinc-400 mb-1.5">Payment Mode *</label>
                <select
                  value={form.payment_mode}
                  onChange={e => setForm(f => ({ ...f, payment_mode: e.target.value }))}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white"
                >
                  {["CASH", "UPI", "CHEQUE", "NEFT", "RTGS", "DD"].map(m => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-zinc-400 mb-1.5">Reference Number</label>
                <input
                  type="text" value={form.reference_number}
                  onChange={e => setForm(f => ({ ...f, reference_number: e.target.value }))}
                  placeholder="Cheque / UTR no."
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white"
                />
              </div>
              <div>
                <label className="block text-xs text-zinc-400 mb-1.5">Notes</label>
                <textarea
                  rows={2} value={form.notes}
                  onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white resize-none"
                />
              </div>
              <div className="flex gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  className="flex-1 px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-white rounded-lg text-sm"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={actionLoading === "create"}
                  className="flex-1 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm font-medium disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  {actionLoading === "create" && <Loader2 className="w-4 h-4 animate-spin" />}
                  Create Receipt
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
