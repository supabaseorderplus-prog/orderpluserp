"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Plus, Search, Loader2, Building2, Trash2, Pencil, BookOpen, Phone,
  ArrowUpRight, Database, ShieldCheck, Shield, Check,
} from "lucide-react";
import { getUser } from "@/lib/api";
import { Vendor, vendorAuthHeaders, inr, balanceLabel } from "./vendor-types";
import VendorFormModal from "./VendorFormModal";
import VendorLedgerModal from "./VendorLedgerModal";

interface VendorsPanelProps {
  canCreate: boolean;
  companyId: string | null;
}

export default function VendorsPanel({ canCreate, companyId }: VendorsPanelProps) {
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [migrationRequired, setMigrationRequired] = useState(false);
  const [search, setSearch] = useState("");

  // Verification view, mirroring the Parties page. Salesmen see every vendor.
  const currentUser = getUser();
  const isAdminUser = currentUser?.role === "SUPER_ADMIN" || currentUser?.role === "ADMIN";
  const isSalesman = currentUser?.role === "SALESMAN";
  const showTabs = isAdminUser && !isSalesman;
  const [verificationTab, setVerificationTab] = useState<"verified" | "unverified">("verified");
  const [verificationAvailable, setVerificationAvailable] = useState(true);
  const [verifyingId, setVerifyingId] = useState<string | null>(null);

  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Vendor | null>(null);
  const [ledgerVendor, setLedgerVendor] = useState<Vendor | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const loadVendors = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams();
      if (search.trim()) params.set("search", search.trim());
      // Salesmen always see all; admins toggle between verified/unverified.
      params.set("is_verified", isSalesman ? "all" : verificationTab === "verified" ? "true" : "false");
      const res = await fetch(`/api/v1/vendors?${params.toString()}`, { headers: vendorAuthHeaders() });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.message || "Failed to load vendors");
      setMigrationRequired(!!json.migration_required);
      setVerificationAvailable(json.verification_available !== false);
      setVendors((json.data as Vendor[]) || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load vendors");
    } finally {
      setLoading(false);
    }
  }, [search, isSalesman, verificationTab]);

  // Debounced reload on search/filter/tab change.
  useEffect(() => {
    const t = setTimeout(() => { loadVendors(); }, 250);
    return () => clearTimeout(t);
  }, [loadVendors]);

  // Reload list whenever the active company changes.
  useEffect(() => { loadVendors(); }, [companyId]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSaved = () => {
    setShowForm(false);
    setEditing(null);
    // New vendors enter the unverified queue — jump there so it's visible.
    if (showTabs && verificationTab !== "unverified") setVerificationTab("unverified");
    else loadVendors();
  };

  const handleVerify = async (vendor: Vendor) => {
    if (!confirm(`Verify "${vendor.name}"? This vendor becomes active across the company.`)) return;
    setVerifyingId(vendor.id);
    try {
      const res = await fetch(`/api/v1/vendors/${vendor.id}/verify`, {
        method: "PUT",
        headers: vendorAuthHeaders(),
        body: JSON.stringify({ verified: true }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.message || "Failed to verify");
      // Remove from the unverified list it currently sits in.
      setVendors((vs) => vs.filter((v) => v.id !== vendor.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to verify vendor");
    } finally {
      setVerifyingId(null);
    }
  };

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



  return (
    <div>
      {/* Verified / Unverified tabs (admins only) */}
      {showTabs && (
        <div className="flex items-center gap-1 mb-4 p-1 rounded-lg bg-black/[0.04] w-fit">
          <button
            onClick={() => setVerificationTab("verified")}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md transition-all ${verificationTab === "verified" ? "bg-white text-zinc-900 font-medium shadow-sm" : "text-zinc-500 hover:text-zinc-700"}`}
            style={{ fontSize: "0.76rem", border: "none", cursor: "pointer", background: verificationTab === "verified" ? undefined : "transparent" }}
          >
            <ShieldCheck className="w-3.5 h-3.5" /> Verified
          </button>
          <button
            onClick={() => setVerificationTab("unverified")}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md transition-all ${verificationTab === "unverified" ? "bg-white text-zinc-900 font-medium shadow-sm" : "text-zinc-500 hover:text-zinc-700"}`}
            style={{ fontSize: "0.76rem", border: "none", cursor: "pointer", background: verificationTab === "unverified" ? undefined : "transparent" }}
          >
            <Shield className="w-3.5 h-3.5" /> Unverified
          </button>
        </div>
      )}

      {migrationRequired && (
        <div className="mb-4 rounded-xl border border-amber-500/20 bg-amber-500/[0.06] px-4 py-3 text-amber-700">
          <div className="flex items-start gap-3">
            <Database className="mt-0.5 h-4 w-4 shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="font-medium" style={{ fontSize: "0.78rem" }}>Vendor backend setup is incomplete</p>
              <p className="mt-1 text-amber-600" style={{ fontSize: "0.72rem" }}>
                The vendors module is now visible, but some vendor data actions may fail until the Supabase vendor schema is fully available.
              </p>
            </div>
            <button
              onClick={loadVendors}
              className="rounded-lg border border-amber-500/30 px-3 py-1.5 text-amber-700 hover:bg-amber-500/10"
              style={{ fontSize: "0.72rem", background: "transparent", cursor: "pointer" }}
            >
              Reload
            </button>
          </div>
        </div>
      )}

      {showTabs && !verificationAvailable && (
        <p className="mb-4 rounded-lg border border-amber-500/20 bg-amber-500/[0.06] px-3 py-2 text-amber-600" style={{ fontSize: "0.72rem" }}>
          Showing all vendors. Run the verification ALTER in <span className="font-mono">CREATE_VENDORS_TABLES.sql</span> to split them into Verified / Unverified.
        </p>
      )}

      {/* Search + type filter + add */}
      <div className="flex flex-col sm:flex-row gap-3 mb-5">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search vendors by name, code, GSTIN, phone…"
            className="w-full pl-9 pr-3 py-2 rounded-lg border border-black/10 bg-black/[0.03] text-zinc-900 outline-none focus:border-amber-500/40"
            style={{ fontSize: "0.8rem" }}
          />
        </div>
        {canCreate && (
          <button onClick={() => { setEditing(null); setShowForm(true); }}
            className="flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-amber-500 text-zinc-900 hover:bg-amber-600 transition-all"
            style={{ fontSize: "0.8rem", border: "none", cursor: "pointer" }}>
            <Plus className="w-4 h-4" /> Add Vendor
          </button>
        )}
      </div>

      {error && <p className="text-rose-500 mb-3" style={{ fontSize: "0.8rem" }}>{error}</p>}

      {/* List */}
      {loading ? (
        <div className="flex justify-center py-12"><Loader2 className="w-6 h-6 text-amber-500 animate-spin" /></div>
      ) : vendors.length === 0 ? (
        <div className="text-center py-16">
          <div className="w-14 h-14 rounded-2xl bg-black/[0.04] flex items-center justify-center mb-3 mx-auto">
            <Building2 className="w-7 h-7 text-zinc-400" />
          </div>
          <p className="text-zinc-500" style={{ fontSize: "0.85rem" }}>
            {search
              ? "No vendors match your search."
              : showTabs && verificationTab === "unverified"
              ? "No vendors awaiting verification."
              : showTabs && verificationTab === "verified"
              ? "No verified vendors yet. Check the Unverified tab."
              : "No vendors yet. Add a vendor you owe money to."}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {vendors.map((v) => {
            const bal = v.current_balance ?? v.opening_balance;
            const bl = balanceLabel(v, bal);
            const balTone = bl.tone === "payable" ? "text-rose-600" : bl.tone === "receivable" ? "text-emerald-600" : "text-zinc-400";
            return (
              <div key={v.id} className="flex items-center gap-3 rounded-xl border border-black/[0.07] bg-white px-4 py-3 hover:border-amber-500/30 transition-all">
                <span className="flex items-center justify-center w-9 h-9 rounded-lg bg-rose-500/10 text-rose-500">
                  <ArrowUpRight className="w-4 h-4" />
                </span>
                <button onClick={() => setLedgerVendor(v)} className="flex-1 min-w-0 text-left" style={{ background: "none", border: "none", cursor: "pointer", padding: 0 }}>
                  <div className="flex items-center gap-2">
                    <p className="text-zinc-900 font-semibold truncate" style={{ fontSize: "0.85rem", margin: 0 }}>{v.name}</p>
                  </div>
                  <p className="text-zinc-400 truncate flex items-center gap-2" style={{ fontSize: "0.68rem", margin: "1px 0 0" }}>
                    <span className="font-mono">{v.vendor_code}</span>
                    {v.contact_phone && <span className="flex items-center gap-0.5"><Phone className="w-2.5 h-2.5" />{v.contact_phone}</span>}
                    {v.city && <span>{v.city}</span>}
                  </p>
                </button>
                <div className="text-right hidden sm:block">
                  <p style={{ fontSize: "0.62rem", color: "#a1a1aa", margin: 0 }}>{bl.text}</p>
                  <p className={`font-semibold ${balTone}`} style={{ fontSize: "0.85rem", margin: 0 }}>{inr(bal)}</p>
                </div>
                <div className="flex items-center gap-1">
                  {showTabs && verificationAvailable && v.is_verified === false && (
                    <button
                      onClick={() => handleVerify(v)}
                      disabled={verifyingId === v.id}
                      title="Verify vendor"
                      className="flex items-center gap-1 px-2 py-1.5 rounded-lg text-emerald-600 hover:bg-emerald-500/10 disabled:opacity-40"
                      style={{ fontSize: "0.7rem", background: "none", border: "none", cursor: "pointer" }}
                    >
                      {verifyingId === v.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                      <span className="hidden sm:inline">Verify</span>
                    </button>
                  )}
                  <button onClick={() => setLedgerVendor(v)} title="Ledger" className="p-1.5 rounded-lg text-zinc-400 hover:text-amber-600 hover:bg-amber-500/10" style={{ background: "none", border: "none", cursor: "pointer" }}>
                    <BookOpen className="w-4 h-4" />
                  </button>
                  {canCreate && (
                    <button onClick={() => { setEditing(v); setShowForm(true); }} title="Edit" className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-700 hover:bg-black/5" style={{ background: "none", border: "none", cursor: "pointer" }}>
                      <Pencil className="w-4 h-4" />
                    </button>
                  )}
                  {canCreate && (
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

      <VendorFormModal open={showForm} editing={editing} onClose={() => { setShowForm(false); setEditing(null); }} onSaved={handleSaved} />
      {ledgerVendor && (
        <VendorLedgerModal vendor={ledgerVendor} onClose={() => setLedgerVendor(null)} onBalanceChange={updateBalanceInList} />
      )}
    </div>
  );
}
