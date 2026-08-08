"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Building2, Plus, Search, Loader2, Database, Download, BookOpen, Pencil, Trash2,
  ArrowUpRight, ArrowDownLeft, Phone, TrendingDown, HandCoins, Users, CalendarClock,
} from "lucide-react";
import { Vendor, vendorAuthHeaders, inr, balanceLabel } from "@/app/dashboard/parties/vendor-types";
import VendorFormModal from "@/app/dashboard/parties/VendorFormModal";
import VendorLedgerModal from "@/app/dashboard/parties/VendorLedgerModal";
import { getUser } from "@/lib/api";
import { toCsv, downloadCsv } from "@/lib/csv";

interface OutstandingTotals {
  total_payable: number;
  total_receivable: number;
}

interface LedgerTxn {
  txn_type: "BILL" | "PAYMENT" | "ADJUSTMENT";
  amount: number;
  txn_date: string;
  reference_number: string | null;
  description: string | null;
  running_balance?: number;
}

const MANAGE_ROLES = ["SUPER_ADMIN", "ADMIN", "ACCOUNTS_MANAGER"];

/* ------------------------------- KPI card -------------------------------- */

interface KpiProps {
  icon: React.ReactNode;
  tint: string;
  label: string;
  value: string;
  sub?: string;
}

function Kpi({ icon, tint, label, value, sub }: KpiProps) {
  return (
    <div className="rounded-2xl border border-black/[0.06] bg-white p-4 shadow-[0_8px_28px_rgba(0,0,0,0.04)]">
      <div className="flex items-center gap-2">
        <div className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0" style={{ background: `${tint}1a`, color: tint }}>
          {icon}
        </div>
        <span className="text-zinc-400" style={{ fontSize: "0.62rem", textTransform: "uppercase", letterSpacing: "0.1em", fontWeight: 600 }}>
          {label}
        </span>
      </div>
      <div className="font-mono font-bold text-zinc-900 mt-2.5 truncate" style={{ fontSize: "1.45rem", lineHeight: 1.1 }}>
        {value}
      </div>
      {sub && <div className="text-zinc-400 mt-0.5 truncate" style={{ fontSize: "0.66rem" }}>{sub}</div>}
    </div>
  );
}

/* ------------------------------- Section --------------------------------- */

export default function VendorsTreasury() {
  const me = getUser();
  const canManage = !!me && MANAGE_ROLES.includes(me.role);

  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [totals, setTotals] = useState<OutstandingTotals>({ total_payable: 0, total_receivable: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [migrationRequired, setMigrationRequired] = useState(false);
  const [search, setSearch] = useState("");
  const [exporting, setExporting] = useState(false);

  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Vendor | null>(null);
  const [ledgerVendor, setLedgerVendor] = useState<Vendor | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams();
      if (search.trim()) params.set("search", search.trim());
      const [listRes, outRes] = await Promise.all([
        fetch(`/api/v1/vendors?${params.toString()}`, { headers: vendorAuthHeaders() }).then((r) => r.json()),
        fetch(`/api/v1/vendors/outstanding`, { headers: vendorAuthHeaders() }).then((r) => r.json()),
      ]);
      if (!listRes.success) throw new Error(listRes.message || "Failed to load vendors");
      setMigrationRequired(!!listRes.migration_required);
      setVendors((listRes.data as Vendor[]) || []);
      if (outRes.success && outRes.data) {
        setTotals({
          total_payable: Number(outRes.data.total_payable || 0),
          total_receivable: Number(outRes.data.total_receivable || 0),
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load vendors");
    } finally {
      setLoading(false);
    }
  }, [search]);

  useEffect(() => {
    const t = setTimeout(() => { load(); }, 250);
    return () => clearTimeout(t);
  }, [load]);

  const handleDelete = async (vendor: Vendor) => {
    if (!confirm(`Delete vendor "${vendor.name}"? This hides it from the list.`)) return;
    setDeletingId(vendor.id);
    try {
      const res = await fetch(`/api/v1/vendors/${vendor.id}`, { method: "DELETE", headers: vendorAuthHeaders() });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.message || "Failed to delete");
      setVendors((vs) => vs.filter((v) => v.id !== vendor.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete vendor");
    } finally {
      setDeletingId(null);
    }
  };

  const updateBalanceInList = (vendorId: string, balance: number) => {
    setVendors((vs) => vs.map((v) => (v.id === vendorId ? { ...v, current_balance: balance } : v)));
  };

  // Net balance for a vendor (current if known, else opening).
  const balOf = (v: Vendor) => v.current_balance ?? v.opening_balance;

  // Largest single payable — the vendor we owe the most right now.
  const topPayable = useMemo(() => {
    let best: { name: string; amount: number } | null = null;
    for (const v of vendors) {
      const bal = balOf(v);
      const bl = balanceLabel(v, bal);
      if (bl.tone !== "payable") continue;
      const amt = Math.abs(bal);
      if (!best || amt > best.amount) best = { name: v.name, amount: amt };
    }
    return best;
  }, [vendors]);

  // Export the payables/receivables summary (one row per vendor with a balance).
  const exportSummary = useCallback(() => {
    const rows = vendors
      .map((v) => {
        const bal = balOf(v);
        const bl = balanceLabel(v, bal);
        return { v, bal, bl };
      })
      .filter(({ bl }) => bl.tone !== "settled")
      .map(({ v, bal, bl }) => [
        v.vendor_code,
        v.name,
        v.vendor_type,
        v.contact_phone ?? "",
        v.city ?? "",
        bl.tone === "payable" ? "PAYABLE" : "RECEIVABLE",
        Math.abs(bal).toFixed(2),
      ]);
    const csv = toCsv(
      ["Code", "Vendor", "Type", "Phone", "City", "Direction", "Amount"],
      rows,
    );
    downloadCsv(`vendor-payables-${new Date().toISOString().slice(0, 10)}.csv`, csv);
  }, [vendors]);

  // Export every vendor's full transaction history into one combined CSV.
  const exportAllTransactions = useCallback(async () => {
    if (vendors.length === 0) return;
    setExporting(true);
    setError("");
    try {
      const rows: (string | number)[][] = [];
      const CHUNK = 6;
      for (let i = 0; i < vendors.length; i += CHUNK) {
        const slice = vendors.slice(i, i + CHUNK);
        const results = await Promise.all(
          slice.map(async (v) => {
            const res = await fetch(`/api/v1/vendors/${v.id}/ledger`, { headers: vendorAuthHeaders() });
            const json = await res.json();
            return { v, txns: (json?.data as LedgerTxn[]) || [] };
          }),
        );
        for (const { v, txns } of results) {
          for (const t of txns) {
            const signed = t.txn_type === "PAYMENT" ? -Math.abs(t.amount) : t.amount;
            rows.push([
              v.vendor_code,
              v.name,
              t.txn_date,
              t.txn_type,
              t.reference_number ?? "",
              t.description ?? "",
              signed.toFixed(2),
              t.running_balance != null ? t.running_balance.toFixed(2) : "",
            ]);
          }
        }
      }
      const csv = toCsv(
        ["Vendor Code", "Vendor", "Date", "Type", "Reference", "Description", "Amount", "Running Balance"],
        rows,
      );
      downloadCsv(`vendor-transactions-${new Date().toISOString().slice(0, 10)}.csv`, csv);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to export transactions");
    } finally {
      setExporting(false);
    }
  }, [vendors]);

  /* --------------------------- Migration notice --------------------------- */
  if (migrationRequired) {
    return (
      <div className="max-w-lg mx-auto py-12 text-center">
        <div className="w-14 h-14 rounded-2xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center mb-4 mx-auto">
          <Database className="w-7 h-7 text-amber-500 opacity-80" />
        </div>
        <h2 className="text-zinc-900 font-semibold mb-1" style={{ fontSize: "1rem" }}>One-time setup needed</h2>
        <p className="text-zinc-500 mb-4" style={{ fontSize: "0.82rem" }}>
          Vendor management needs its database tables. Open the Supabase SQL editor and run
          <span className="font-mono text-zinc-700"> CREATE_VENDORS_TABLES.sql</span> (in the project root), then reload.
        </p>
        <button onClick={load} className="px-4 py-2 rounded-lg bg-amber-500 text-zinc-900 hover:bg-amber-600" style={{ fontSize: "0.8rem", border: "none", cursor: "pointer" }}>
          I&apos;ve run it — reload
        </button>
      </div>
    );
  }

  const visible = vendors;

  return (
    <div className="space-y-6">
      {/* ------------------------------- Hero ------------------------------- */}
      <div className="relative overflow-hidden rounded-2xl border border-black/[0.06] bg-gradient-to-br from-white via-rose-50/50 to-orange-50/30 p-6 shadow-[0_12px_40px_rgba(0,0,0,0.05)]">
        <div className="absolute -right-12 -top-12 h-40 w-40 rounded-full bg-rose-300/20 blur-3xl" />
        <div className="relative flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="inline-flex items-center gap-1.5 rounded-full border border-rose-200/70 bg-white/70 px-2.5 py-1 text-rose-700" style={{ fontSize: "0.62rem", fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase" }}>
              <Building2 className="w-3 h-3" /> Vendors &amp; Payables
            </div>
            <h2 className="text-zinc-900 font-semibold tracking-tight mt-2.5" style={{ fontSize: "1.4rem" }}>
              Vendor Payables &amp; Ledgers
            </h2>
            <p className="text-zinc-600" style={{ fontSize: "0.82rem", margin: 0 }}>
              What you owe each vendor right now — with full ledgers and downloadable transaction history.
            </p>
          </div>
        </div>
      </div>

      {/* ------------------------------ KPIs ------------------------------- */}
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3.5">
        <Kpi
          icon={<TrendingDown className="w-4 h-4" />}
          tint="#e11d48"
          label="Payable Now"
          value={inr(totals.total_payable)}
          sub="Amount you owe vendors"
        />
        <Kpi
          icon={<Users className="w-4 h-4" />}
          tint="#0891b2"
          label="Active Vendors"
          value={String(vendors.length)}
          sub={`${vendors.filter((v) => balanceLabel(v, balOf(v)).tone === "payable").length} with dues`}
        />
        <Kpi
          icon={<HandCoins className="w-4 h-4" />}
          tint="#7c3aed"
          label="Largest Payable"
          value={topPayable ? inr(topPayable.amount) : "₹0"}
          sub={topPayable?.name ?? "Nothing outstanding"}
        />
      </div>

      {/* --------------------- Search + export toolbar --------------------- */}
      <div className="flex flex-col sm:flex-row gap-3 sm:items-center">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-400" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search vendors by name, code, GSTIN, phone…"
            className="w-full pl-9 pr-3 py-2.5 rounded-xl border border-black/[0.08] bg-white text-zinc-900 outline-none focus:border-rose-400/50 shadow-sm"
            style={{ fontSize: "0.82rem" }}
          />
        </div>
        <div className="flex gap-2">
          <button
            onClick={exportSummary}
            disabled={vendors.length === 0}
            className="inline-flex items-center gap-1.5 px-3.5 py-2.5 rounded-xl border border-black/[0.08] bg-white text-zinc-700 font-semibold hover:bg-zinc-50 disabled:opacity-40 shadow-sm"
            style={{ fontSize: "0.78rem", cursor: "pointer", fontFamily: "inherit" }}
          >
            <Download className="w-3.5 h-3.5" /> Payables
          </button>
          <button
            onClick={exportAllTransactions}
            disabled={vendors.length === 0 || exporting}
            className="inline-flex items-center gap-1.5 px-3.5 py-2.5 rounded-xl bg-zinc-900 text-white font-semibold hover:bg-zinc-800 disabled:opacity-50 shadow-sm"
            style={{ fontSize: "0.78rem", cursor: "pointer", fontFamily: "inherit", border: "none" }}
          >
            {exporting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
            All Transactions
          </button>
        </div>
      </div>

      {error && <p className="text-rose-500" style={{ fontSize: "0.8rem" }}>{error}</p>}

      {/* ------------------------------ List ------------------------------- */}
      {loading ? (
        <div className="flex justify-center py-16"><Loader2 className="w-6 h-6 text-rose-500 animate-spin" /></div>
      ) : visible.length === 0 ? (
        <div className="rounded-2xl border border-black/[0.06] bg-white text-center py-16 text-zinc-500">
          <Building2 className="w-11 h-11 mx-auto mb-3 opacity-30" />
          <p style={{ fontSize: "0.85rem" }}>
            {search ? "No vendors match your search." : "No vendors yet. Add a vendor you owe money to."}
          </p>
          {canManage && !search && (
            <button
              onClick={() => { setEditing(null); setShowForm(true); }}
              className="mt-4 inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-zinc-900 text-white font-semibold hover:bg-zinc-800"
              style={{ fontSize: "0.76rem", cursor: "pointer", fontFamily: "inherit", border: "none" }}
            >
              <Plus className="w-3.5 h-3.5" /> Add your first vendor
            </button>
          )}
        </div>
      ) : (
        <div className="rounded-2xl border border-black/[0.06] bg-white shadow-[0_8px_28px_rgba(0,0,0,0.04)] divide-y divide-black/[0.05]">
          {visible.map((v) => {
            const bal = balOf(v);
            const bl = balanceLabel(v, bal);
            const isPayable = bl.tone === "payable";
            const balTone = isPayable ? "text-rose-600" : bl.tone === "receivable" ? "text-emerald-600" : "text-zinc-400";
            return (
              <div key={v.id} className="flex items-center gap-3 px-4 py-3 hover:bg-zinc-50/70 transition-colors">
                <span
                  className={`flex items-center justify-center w-9 h-9 rounded-xl shrink-0 ${isPayable ? "bg-rose-500/10 text-rose-500" : bl.tone === "receivable" ? "bg-emerald-500/10 text-emerald-500" : "bg-zinc-100 text-zinc-400"}`}
                >
                  {isPayable ? <ArrowUpRight className="w-4 h-4" /> : <ArrowDownLeft className="w-4 h-4" />}
                </span>
                <button onClick={() => setLedgerVendor(v)} className="flex-1 min-w-0 text-left" style={{ background: "none", border: "none", cursor: "pointer", padding: 0 }}>
                  <p className="text-zinc-900 font-semibold truncate" style={{ fontSize: "0.85rem", margin: 0 }}>{v.name}</p>
                  <p className="text-zinc-400 truncate flex items-center gap-2" style={{ fontSize: "0.68rem", margin: "1px 0 0" }}>
                    <span className="font-mono">{v.vendor_code}</span>
                    {v.contact_phone && <span className="flex items-center gap-0.5"><Phone className="w-2.5 h-2.5" />{v.contact_phone}</span>}
                    {v.payment_terms_days > 0 && <span className="flex items-center gap-0.5"><CalendarClock className="w-2.5 h-2.5" />{v.payment_terms_days}d terms</span>}
                  </p>
                </button>
                <div className="text-right hidden sm:block min-w-[7rem]">
                  <p style={{ fontSize: "0.6rem", color: "#a1a1aa", margin: 0, textTransform: "uppercase", letterSpacing: "0.08em" }}>{bl.text}</p>
                  <p className={`font-mono font-bold ${balTone}`} style={{ fontSize: "0.92rem", margin: 0 }}>{inr(bal)}</p>
                </div>
                <div className="flex items-center gap-1">
                  <button onClick={() => setLedgerVendor(v)} title="Ledger & history" className="p-1.5 rounded-lg text-zinc-400 hover:text-rose-600 hover:bg-rose-500/10" style={{ background: "none", border: "none", cursor: "pointer" }}>
                    <BookOpen className="w-4 h-4" />
                  </button>
                  {canManage && (
                    <button onClick={() => { setEditing(v); setShowForm(true); }} title="Edit" className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-700 hover:bg-black/5" style={{ background: "none", border: "none", cursor: "pointer" }}>
                      <Pencil className="w-4 h-4" />
                    </button>
                  )}
                  {canManage && (
                    <button onClick={() => handleDelete(v)} disabled={deletingId === v.id} title="Delete" className="p-1.5 rounded-lg text-zinc-400 hover:text-rose-600 hover:bg-rose-500/10 disabled:opacity-40" style={{ background: "none", border: "none", cursor: "pointer" }}>
                      {deletingId === v.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <VendorFormModal
        open={showForm}
        editing={editing}
        onClose={() => { setShowForm(false); setEditing(null); }}
        onSaved={() => { setShowForm(false); setEditing(null); load(); }}
      />
      {ledgerVendor && (
        <VendorLedgerModal
          vendor={ledgerVendor}
          canCreateEntry={canManage}
          onClose={() => { setLedgerVendor(null); load(); }}
          onBalanceChange={updateBalanceInList}
        />
      )}
    </div>
  );
}
