"use client";

import { useEffect, useState } from "react";
import {
  Check,
  Edit2,
  Loader2,
  Percent,
  Plus,
  Receipt,
  RefreshCw,
  Save,
  Trash2,
  X,
} from "lucide-react";
import { api } from "@/lib/api";

// ─── Types ────────────────────────────────────────────────────────────────────

const GST_CATEGORIES = [
  { value: "goods", label: "Goods" },
  { value: "services", label: "Services" },
  { value: "works_contract", label: "Works Contract" },
  { value: "mixed", label: "Mixed Supply" },
  { value: "exempt", label: "Exempt / Nil Rated" },
];

function gstBreakdown(rate: number) {
  return { cgst: rate / 2, sgst: rate / 2, igst: rate };
}

interface GSTTemplate {
  id: string;
  product_name: string;
  hsn_code?: string;
  gst_rate: number;
  gst_category: string;
  cess_rate: number;
  transaction_type: "intra" | "inter";
  created_at: string;
}

interface GSTConfig {
  id: string;
  invoice_prefix: string;
  invoice_series: string;
  current_sequence: number;
  gst_number: string | null;
  company_name: string | null;
  company_address: string | null;
  company_state_code: string | null;
  status: string;
}

const GST_SLABS = [0, 5, 12, 18, 28];

const blankTpl = () => ({ product_name: "", gst_rate: 18, gst_category: "goods", cess_rate: 0 });

const css: React.CSSProperties = {
  transform: "none", filter: "none", WebkitTextStroke: "0",
  background: "none", boxShadow: "none", display: "block", padding: 0,
};

export default function TaxSettingsPage() {
  const [tab, setTab] = useState<"templates" | "gst">("templates");

  // ── GST Templates state ───────────────────────────────────────────────────────
  const [templates, setTemplates] = useState<GSTTemplate[]>([]);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [tplForm, setTplForm] = useState(blankTpl());
  const [tplSuccess, setTplSuccess] = useState("");
  const [tplError, setTplError] = useState("");
  const [editingTpl, setEditingTpl] = useState<string | null>(null);
  const [txnType, setTxnType] = useState<"intra" | "inter">("intra");

  const [tplLoading, setTplLoading] = useState(true);

  function fetchTemplates() {
    setTplLoading(true);
    setTplError("");
    api<{ success: boolean; data: GSTTemplate[] }>("/api/v1/gst-templates")
      .then(r => setTemplates(r.data || []))
      .catch((err) => {
        setTemplates([]);
        setTplError(err instanceof Error ? err.message : "Failed to load GST templates");
      })
      .finally(() => setTplLoading(false));
  }

  useEffect(() => { fetchTemplates(); }, []);

  function openCreate() {
    setTplForm(blankTpl());
    setTxnType("intra");
    setEditingTpl(null);
    setTplError("");
    setShowCreateForm(true);
  }

  function openEdit(t: GSTTemplate) {
    setTplForm({ product_name: t.product_name, gst_rate: t.gst_rate, gst_category: t.gst_category, cess_rate: t.cess_rate });
    setTxnType(t.transaction_type || "intra");
    setEditingTpl(t.id);
    setTplError("");
    setShowCreateForm(true);
  }

  function cancelForm() {
    setShowCreateForm(false);
    setEditingTpl(null);
    setTplError("");
  }

  async function submitTemplate() {
    if (!tplForm.product_name.trim()) { setTplError("Product name is required"); return; }
    if (tplForm.gst_rate === undefined || tplForm.gst_rate === null) { setTplError("GST rate is required"); return; }

    try {
      if (editingTpl) {
        await api("/api/v1/gst-templates", {
          method: "PUT",
          body: { id: editingTpl, ...tplForm, transaction_type: txnType },
        });
        setTplSuccess("Template updated!");
      } else {
        await api("/api/v1/gst-templates", {
          method: "POST",
          body: { ...tplForm, transaction_type: txnType },
        });
        setTplSuccess("Template saved!");
      }
      setShowCreateForm(false);
      setEditingTpl(null);
      fetchTemplates();
      setTimeout(() => setTplSuccess(""), 3000);
    } catch (err) {
      setTplError(err instanceof Error ? err.message : "Failed to save template");
    }
  }

  async function deleteTemplate(id: string) {
    try {
      await api(`/api/v1/gst-templates?id=${id}`, { method: "DELETE" });
      fetchTemplates();
    } catch { /* ignore */ }
  }

  // ── GST Config state ─────────────────────────────────────────────────────────
  const [gstConfigs, setGSTConfigs] = useState<GSTConfig[]>([]);
  const [gstLoading, setGSTLoading] = useState(true);
  const [gstForm, setGSTForm] = useState<Partial<GSTConfig>>({});
  const [gstEditId, setGSTEditId] = useState<string | null>(null);
  const [gstSaving, setGSTSaving] = useState(false);
  const [gstError, setGSTError] = useState("");
  const [gstSuccess, setGSTSuccess] = useState("");

  function fetchGST() {
    setGSTLoading(true);
    setGSTError("");
    api<{ success: boolean; data: GSTConfig[] }>("/api/v1/gst-config")
      .then(r => setGSTConfigs(r.data || []))
      .catch(() => setGSTError("Failed to load GST configuration"))
      .finally(() => setGSTLoading(false));
  }
  useEffect(() => { fetchGST(); }, []);

  function startEditGST(config: GSTConfig) {
    setGSTEditId(config.id);
    setGSTForm({
      id: config.id,
      invoice_prefix: config.invoice_prefix,
      invoice_series: config.invoice_series,
      current_sequence: config.current_sequence,
      gst_number: config.gst_number ?? "",
      company_name: config.company_name ?? "",
      company_address: config.company_address ?? "",
      company_state_code: config.company_state_code ?? "",
    });
    setGSTError(""); setGSTSuccess("");
  }

  async function saveGST() {
    if (!gstForm.id) return;
    setGSTSaving(true); setGSTError(""); setGSTSuccess("");
    try {
      await api("/api/v1/gst-config", { method: "PUT", body: gstForm });
      setGSTSuccess("GST configuration updated successfully.");
      setGSTEditId(null);
      fetchGST();
    } catch (err) {
      setGSTError(err instanceof Error ? err.message : "Update failed");
    } finally {
      setGSTSaving(false);
    }
  }

  return (
    <div style={{ fontFamily: "'Inter','system-ui',sans-serif" }}>
      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900 mb-0.5" style={{ ...css, fontSize: "1.5rem" }}>Tax Settings</h1>
          <p className="text-zinc-500" style={{ fontSize: "0.8rem" }}>
            Manage GST templates &amp; invoice configuration
          </p>
        </div>
        <button
          onClick={fetchGST}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-black/10 text-zinc-600 hover:text-zinc-900 hover:border-black/20 transition-all"
          style={{ fontSize: "0.75rem", background: "none", fontFamily: "inherit", cursor: "pointer" }}
        >
          <RefreshCw className="w-3.5 h-3.5" /> Refresh
        </button>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-6 p-1 bg-black/[0.04] rounded-xl border border-black/[0.06] w-fit">
        {([["templates", "GST Templates", Percent], ["gst", "Invoice & GST Config", Receipt]] as const).map(([t, label, Icon]) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg font-medium transition-all ${
              tab === t ? "bg-white text-zinc-900 shadow-sm border border-black/[0.06]" : "text-zinc-500 hover:text-zinc-700"
            }`}
            style={{ fontSize: "0.82rem", fontFamily: "inherit", cursor: "pointer", border: tab === t ? undefined : "none" }}
          >
            <Icon className="w-4 h-4" />
            {label}
          </button>
        ))}
      </div>

      {/* ── TAB: GST TEMPLATES ── */}
      {tab === "templates" && (
        <div className="space-y-4">
          {tplLoading && <div className="flex items-center justify-center py-14"><Loader2 className="w-6 h-6 text-amber-400 animate-spin" /></div>}
          {!tplLoading && tplSuccess && (
            <div className="p-3 rounded-xl border border-emerald-500/20 bg-emerald-500/8 text-emerald-500 flex items-center gap-2" style={{ fontSize: "0.8rem" }}>
              <Check className="w-4 h-4 shrink-0" /> {tplSuccess}
            </div>
          )}

          {/* Header row — always visible */}
          {!tplLoading && !showCreateForm && (
            <div className="flex items-center justify-between">
              <div>
                <div className="font-semibold text-zinc-900" style={{ fontSize: "0.95rem" }}>GST Templates</div>
                <div className="text-zinc-400 mt-0.5" style={{ fontSize: "0.72rem" }}>
                  Reusable tax templates applied to products at invoicing.
                </div>
              </div>
              <button
                onClick={openCreate}
                className="flex items-center gap-1.5 px-3 py-2 rounded-xl border border-amber-500/30 text-amber-600 hover:bg-amber-500/10 transition-all"
                style={{ fontSize: "0.78rem", background: "none", fontFamily: "inherit", cursor: "pointer" }}
              >
                <Plus className="w-3.5 h-3.5" /> Create New Template
              </button>
            </div>
          )}

          {/* Create / Edit form */}
          {showCreateForm && (
            <div className="rounded-2xl border border-black/[0.07] bg-white p-5">
              <div className="flex items-center justify-between mb-4">
                <div className="font-semibold text-zinc-900" style={{ fontSize: "0.95rem" }}>
                  {editingTpl ? "Edit Template" : "Create GST Template"}
                </div>
                <button onClick={cancelForm} style={{ background: "none", border: "none", cursor: "pointer", padding: 0 }}>
                  <X className="w-4 h-4 text-zinc-400 hover:text-zinc-700" />
                </button>
              </div>

              {/* Quick slab buttons */}
              <div className="mb-4">
                <div className="text-zinc-400 mb-2" style={{ fontSize: "0.65rem", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                  Quick GST Slab
                </div>
                <div className="flex flex-wrap gap-2">
                  {GST_SLABS.map(r => (
                    <button
                      key={r}
                      onClick={() => setTplForm(f => ({ ...f, gst_rate: r }))}
                      className={`px-3 py-1.5 rounded-lg text-sm font-semibold transition-all border ${
                        tplForm.gst_rate === r
                          ? "bg-amber-500/15 border-amber-500/40 text-amber-500"
                          : "border-black/10 text-zinc-600 hover:border-amber-500/30 hover:text-amber-500"
                      }`}
                      style={{ fontSize: "0.78rem", background: tplForm.gst_rate === r ? undefined : "none", fontFamily: "inherit", cursor: "pointer" }}
                    >
                      {r}%
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-4">
                  {/* Product Name */}
                  <div className="sm:col-span-2 lg:col-span-3">
                    <label className="block text-zinc-500 mb-1.5" style={{ fontSize: "0.65rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                      Description <span className="text-red-400">*</span>
                    </label>
                    <input
                      type="text"
                      value={tplForm.product_name}
                      onChange={e => setTplForm(f => ({ ...f, product_name: e.target.value }))}
                      placeholder="e.g. Waterproofing Compounds, Construction Chemicals…"
                      className="w-full px-3 py-2.5 rounded-xl border border-black/10 bg-black/[0.02] text-zinc-900 placeholder:text-zinc-400 outline-none focus:border-amber-500/50"
                      style={{ fontSize: "0.82rem", fontFamily: "inherit" }}
                    />
                  </div>

                  {/* GST Rate */}
                <div>
                  <label className="block text-zinc-500 mb-1.5" style={{ fontSize: "0.65rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                    GST Rate (%) <span className="text-red-400">*</span>
                  </label>
                  <input
                    type="number"
                    value={tplForm.gst_rate}
                    min={0} max={100} step={0.1}
                    onChange={e => setTplForm(f => ({ ...f, gst_rate: parseFloat(e.target.value) || 0 }))}
                    className="w-full px-3 py-2.5 rounded-xl border border-black/10 bg-black/[0.02] text-zinc-900 outline-none focus:border-amber-500/50"
                    style={{ fontSize: "0.82rem", fontFamily: "inherit" }}
                  />
                </div>

                {/* GST Category */}
                <div>
                  <label className="block text-zinc-500 mb-1.5" style={{ fontSize: "0.65rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                    GST Category <span className="text-red-400">*</span>
                  </label>
                  <select
                    value={tplForm.gst_category}
                    onChange={e => setTplForm(f => ({ ...f, gst_category: e.target.value }))}
                    className="w-full px-3 py-2.5 rounded-xl border border-black/10 bg-black/[0.02] text-zinc-900 outline-none focus:border-amber-500/50"
                    style={{ fontSize: "0.82rem", fontFamily: "inherit", cursor: "pointer" }}
                  >
                    {GST_CATEGORIES.map(c => (
                      <option key={c.value} value={c.value}>{c.label}</option>
                    ))}
                  </select>
                </div>

                {/* Cess Rate */}
                <div>
                  <label className="block text-zinc-500 mb-1.5" style={{ fontSize: "0.65rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                    Cess Rate (%)
                  </label>
                  <input
                    type="number"
                    value={tplForm.cess_rate}
                    min={0} step={0.1}
                    onChange={e => setTplForm(f => ({ ...f, cess_rate: parseFloat(e.target.value) || 0 }))}
                    className="w-full px-3 py-2.5 rounded-xl border border-black/10 bg-black/[0.02] text-zinc-900 outline-none focus:border-amber-500/50"
                    style={{ fontSize: "0.82rem", fontFamily: "inherit" }}
                  />
                </div>
              </div>

              {/* GST Breakdown preview */}
              {tplForm.gst_rate > 0 && (
                <div className="mb-4 p-3 rounded-xl border border-black/[0.06] bg-black/[0.02]">
                  <div className="flex items-center justify-between mb-3">
                    <div className="text-zinc-400" style={{ fontSize: "0.62rem", textTransform: "uppercase", letterSpacing: "0.06em" }}>GST Breakdown</div>
                    <div className="flex items-center gap-1 p-0.5 rounded-lg border border-black/[0.08] bg-black/[0.03]">
                      <button
                        onClick={() => setTxnType("intra")}
                        className={`px-2.5 py-1 rounded-md font-semibold transition-all ${txnType === "intra" ? "bg-blue-500/15 border border-blue-500/30 text-blue-600" : "text-zinc-500 hover:text-zinc-700"}`}
                        style={{ fontSize: "0.68rem", background: txnType === "intra" ? undefined : "none", border: txnType === "intra" ? undefined : "none", fontFamily: "inherit", cursor: "pointer" }}
                      >Intra-state</button>
                      <button
                        onClick={() => setTxnType("inter")}
                        className={`px-2.5 py-1 rounded-md font-semibold transition-all ${txnType === "inter" ? "bg-purple-500/15 border border-purple-500/30 text-purple-600" : "text-zinc-500 hover:text-zinc-700"}`}
                        style={{ fontSize: "0.68rem", background: txnType === "inter" ? undefined : "none", border: txnType === "inter" ? undefined : "none", fontFamily: "inherit", cursor: "pointer" }}
                      >Inter-state</button>
                    </div>
                  </div>
                  {txnType === "intra" ? (
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-zinc-500" style={{ fontSize: "0.7rem" }}>CGST + SGST applies:</span>
                      <span className="px-2 py-0.5 rounded-md font-bold bg-blue-500/10 border border-blue-500/20 text-blue-600" style={{ fontSize: "0.72rem" }}>CGST {gstBreakdown(tplForm.gst_rate).cgst}%</span>
                      <span className="text-zinc-400" style={{ fontSize: "0.68rem" }}>+</span>
                      <span className="px-2 py-0.5 rounded-md font-bold bg-emerald-500/10 border border-emerald-500/20 text-emerald-600" style={{ fontSize: "0.72rem" }}>SGST {gstBreakdown(tplForm.gst_rate).sgst}%</span>
                      <span className="text-zinc-400" style={{ fontSize: "0.68rem" }}>=</span>
                      <span className="text-zinc-600 font-semibold" style={{ fontSize: "0.72rem" }}>{tplForm.gst_rate}% total</span>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-zinc-500" style={{ fontSize: "0.7rem" }}>Only IGST applies:</span>
                      <span className="px-2 py-0.5 rounded-md font-bold bg-purple-500/10 border border-purple-500/20 text-purple-600" style={{ fontSize: "0.72rem" }}>IGST {gstBreakdown(tplForm.gst_rate).igst}%</span>
                      <span className="text-zinc-400" style={{ fontSize: "0.68rem" }}>=</span>
                      <span className="text-zinc-600 font-semibold" style={{ fontSize: "0.72rem" }}>{tplForm.gst_rate}% total</span>
                    </div>
                  )}
                </div>
              )}

              {tplError && (
                <div className="mb-3 text-red-400" style={{ fontSize: "0.78rem" }}>{tplError}</div>
              )}

              <div className="flex items-center gap-2">
                <button
                  onClick={submitTemplate}
                  className="flex items-center gap-2 px-5 py-2.5 rounded-xl font-semibold transition-all"
                  style={{
                    fontSize: "0.82rem", fontFamily: "inherit", cursor: "pointer",
                    background: "linear-gradient(135deg, #f59e0b 0%, #d97706 100%)",
                    color: "#1c1917", border: "none",
                    boxShadow: "0 2px 8px rgba(245,158,11,0.3)",
                  }}
                >
                  <Save className="w-4 h-4" />
                  {editingTpl ? "Update Template" : "Save Template"}
                </button>
                <button
                  onClick={cancelForm}
                  className="flex items-center gap-2 px-4 py-2.5 rounded-xl border border-black/10 text-zinc-600 hover:text-zinc-900 transition-all"
                  style={{ fontSize: "0.82rem", background: "none", fontFamily: "inherit", cursor: "pointer" }}
                >
                  <X className="w-4 h-4" /> Cancel
                </button>
              </div>
            </div>
          )}

          {/* Empty state — only when no templates and form is closed */}
          {!tplLoading && templates.length === 0 && !showCreateForm && (
            <div className="rounded-2xl border border-black/[0.07] bg-white p-14 text-center">
              <div className="w-12 h-12 rounded-2xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center mx-auto mb-4">
                <Percent className="w-5 h-5 text-amber-400" />
              </div>
              <div className="text-zinc-500 mb-1" style={{ fontSize: "0.9rem", fontWeight: 600 }}>No GST Templates Yet</div>
              <div className="text-zinc-400 mb-4" style={{ fontSize: "0.78rem" }}>
                Create a template to quickly assign GST rates to products.
              </div>
              <button
                onClick={openCreate}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-xl font-semibold"
                style={{ fontSize: "0.8rem", fontFamily: "inherit", cursor: "pointer", background: "linear-gradient(135deg, #f59e0b 0%, #d97706 100%)", color: "#1c1917", border: "none" }}
              >
                <Plus className="w-4 h-4" /> Create First Template
              </button>
            </div>
          )}

          {/* Templates list — always visible when templates exist */}
          {templates.length > 0 && (
            <div className="rounded-2xl border border-black/[0.07] bg-white overflow-hidden">
              {templates.map((tpl, idx) => {
                const { cgst, sgst, igst } = gstBreakdown(tpl.gst_rate);
                const catLabel = GST_CATEGORIES.find(c => c.value === tpl.gst_category)?.label || tpl.gst_category;
                const rateColor =
                  tpl.gst_rate === 0 ? "text-zinc-500 bg-zinc-500/10 border-zinc-500/20" :
                  tpl.gst_rate <= 5 ? "text-emerald-500 bg-emerald-500/10 border-emerald-500/20" :
                  tpl.gst_rate <= 12 ? "text-blue-500 bg-blue-500/10 border-blue-500/20" :
                  tpl.gst_rate <= 18 ? "text-amber-500 bg-amber-500/10 border-amber-500/20" :
                  "text-red-500 bg-red-500/10 border-red-500/20";
                return (
                  <div
                    key={tpl.id}
                    className={`flex items-center gap-4 px-5 py-4 hover:bg-black/[0.015] transition-all ${idx < templates.length - 1 ? "border-b border-black/[0.05]" : ""}`}
                  >
                    <div className="w-9 h-9 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center shrink-0">
                      <Receipt className="w-4 h-4 text-amber-400" />
                    </div>
                    <div className="flex-1 min-w-0">
                        <div className="font-semibold text-zinc-900 truncate" style={{ fontSize: "0.88rem" }}>{tpl.product_name}</div>
                        <div className="flex items-center gap-2 mt-0.5 flex-wrap">

                          <span className="text-zinc-500" style={{ fontSize: "0.72rem" }}>{catLabel}</span>
                        <span className="text-zinc-300">·</span>
                        {tpl.transaction_type === "inter" ? (
                          <>
                            <span className="px-1.5 py-0.5 rounded font-semibold bg-purple-500/10 border border-purple-500/20 text-purple-500" style={{ fontSize: "0.62rem" }}>Inter-State</span>
                            {tpl.gst_rate > 0 && <span className="text-purple-500 font-semibold" style={{ fontSize: "0.7rem" }}>IGST {igst}%</span>}
                          </>
                        ) : (
                          <>
                            <span className="px-1.5 py-0.5 rounded font-semibold bg-blue-500/10 border border-blue-500/20 text-blue-500" style={{ fontSize: "0.62rem" }}>Intra-State</span>
                            {tpl.gst_rate > 0 && (
                              <>
                                <span className="text-blue-500 font-semibold" style={{ fontSize: "0.7rem" }}>CGST {cgst}%</span>
                                <span className="text-zinc-400" style={{ fontSize: "0.68rem" }}>+</span>
                                <span className="text-emerald-500 font-semibold" style={{ fontSize: "0.7rem" }}>SGST {sgst}%</span>
                              </>
                            )}
                          </>
                        )}
                        {tpl.cess_rate > 0 && (
                          <span className="text-zinc-500 font-semibold" style={{ fontSize: "0.7rem" }}>+Cess {tpl.cess_rate}%</span>
                        )}
                      </div>
                    </div>
                    <span className={`px-2.5 py-1 rounded-lg border font-bold shrink-0 ${rateColor}`} style={{ fontSize: "0.78rem" }}>
                      {tpl.gst_rate}%
                    </span>
                    <button
                      onClick={() => openEdit(tpl)}
                      className="p-1.5 rounded-lg text-zinc-400 hover:text-amber-500 hover:bg-amber-500/10 transition-all shrink-0"
                      style={{ background: "none", border: "none", cursor: "pointer" }}
                      title="Edit"
                    >
                      <Edit2 className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => deleteTemplate(tpl.id)}
                      className="p-1.5 rounded-lg text-zinc-400 hover:text-red-400 hover:bg-red-500/10 transition-all shrink-0"
                      style={{ background: "none", border: "none", cursor: "pointer" }}
                      title="Delete"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ── TAB: GST CONFIG ── */}
      {tab === "gst" && (
        <div className="space-y-4">
          {gstError && (
            <div className="p-3 rounded-xl border border-red-500/20 bg-red-500/8 text-red-400" style={{ fontSize: "0.8rem" }}>{gstError}</div>
          )}
          {gstSuccess && (
            <div className="p-3 rounded-xl border border-emerald-500/20 bg-emerald-500/8 text-emerald-500 flex items-center gap-2" style={{ fontSize: "0.8rem" }}>
              <Check className="w-4 h-4 shrink-0" /> {gstSuccess}
            </div>
          )}

          {gstLoading ? (
            <div className="flex items-center justify-center py-14 text-zinc-500">
              <Loader2 className="w-5 h-5 animate-spin mr-2 text-amber-400" /> Loading GST configuration…
            </div>
          ) : gstConfigs.length === 0 ? (
            <div className="rounded-2xl border border-black/[0.07] bg-white p-14 text-center text-zinc-400" style={{ fontSize: "0.85rem" }}>
              No GST configuration found.
            </div>
          ) : (
            gstConfigs.map(config => (
              <div key={config.id} className="rounded-2xl border border-black/[0.07] bg-white overflow-hidden">
                <div className="px-6 py-4 border-b border-black/[0.06] flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center">
                      <Receipt className="w-4 h-4 text-amber-400" />
                    </div>
                    <div>
                      <div className="font-bold text-zinc-900" style={{ fontSize: "0.9rem" }}>
                        {config.company_name || "Invoice Configuration"}
                      </div>
                      <div className="text-zinc-400" style={{ fontSize: "0.7rem" }}>
                        Series: <span className="font-mono text-zinc-600">{config.invoice_prefix}/{config.invoice_series}</span>
                        {" · "}Next: <span className="font-mono text-zinc-600">#{(config.current_sequence || 0) + 1}</span>
                      </div>
                    </div>
                  </div>
                  {gstEditId !== config.id && (
                    <button
                      onClick={() => startEditGST(config)}
                      className="flex items-center gap-1.5 px-3 py-2 rounded-xl border border-black/10 text-zinc-600 hover:text-zinc-900 hover:border-black/20 transition-all"
                      style={{ fontSize: "0.75rem", background: "none", fontFamily: "inherit", cursor: "pointer" }}
                    >
                      <Edit2 className="w-3.5 h-3.5" /> Edit
                    </button>
                  )}
                </div>

                {gstEditId === config.id ? (
                  <div className="p-6">
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5 mb-5">
                      {[
                        { key: "company_name", label: "Company Name", placeholder: "Your Company Pvt Ltd" },
                        { key: "gst_number", label: "GSTIN", placeholder: "27AABCU9603R1ZX", mono: true },
                        { key: "company_state_code", label: "State Code", placeholder: "27" },
                        { key: "company_address", label: "Company Address", placeholder: "123, Industrial Area, Mumbai" },
                        { key: "invoice_prefix", label: "Invoice Prefix", placeholder: "HTC", mono: true },
                        { key: "invoice_series", label: "Invoice Series", placeholder: "A", mono: true },
                      ].map(f => (
                        <div key={f.key}>
                          <label className="block text-zinc-500 mb-1.5" style={{ fontSize: "0.65rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                            {f.label}
                          </label>
                          <input
                            type="text"
                            value={(gstForm as Record<string, string | number | null>)[f.key] as string || ""}
                            onChange={e => setGSTForm(prev => ({ ...prev, [f.key]: e.target.value }))}
                            placeholder={f.placeholder}
                            className="w-full px-3 py-2.5 rounded-xl border border-black/10 bg-black/[0.02] text-zinc-900 placeholder:text-zinc-400 outline-none focus:border-amber-500/50"
                            style={{ fontSize: "0.82rem", fontFamily: f.mono ? "ui-monospace, monospace" : "inherit" }}
                          />
                        </div>
                      ))}
                      <div>
                        <label className="block text-zinc-500 mb-1.5" style={{ fontSize: "0.65rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                          Current Sequence
                        </label>
                        <input
                          type="number"
                          value={gstForm.current_sequence ?? config.current_sequence}
                          min={0}
                          onChange={e => setGSTForm(prev => ({ ...prev, current_sequence: parseInt(e.target.value) || 0 }))}
                          className="w-full px-3 py-2.5 rounded-xl border border-black/10 bg-black/[0.02] text-zinc-900 outline-none focus:border-amber-500/50"
                          style={{ fontSize: "0.82rem", fontFamily: "inherit" }}
                        />
                        <div className="text-zinc-400 mt-1" style={{ fontSize: "0.65rem" }}>
                          Next invoice = {config.invoice_prefix}/{config.invoice_series}/{String((gstForm.current_sequence ?? config.current_sequence) + 1).padStart(6, "0")}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={saveGST}
                        disabled={gstSaving}
                        className="flex items-center gap-2 px-5 py-2.5 rounded-xl font-semibold transition-all disabled:opacity-50"
                        style={{
                          fontSize: "0.82rem", fontFamily: "inherit", cursor: "pointer",
                          background: "linear-gradient(135deg, #f59e0b 0%, #d97706 100%)",
                          color: "#1c1917", border: "none",
                          boxShadow: "0 2px 8px rgba(245,158,11,0.3)",
                        }}
                      >
                        {gstSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                        Save Configuration
                      </button>
                      <button
                        onClick={() => { setGSTEditId(null); setGSTForm({}); }}
                        className="flex items-center gap-2 px-4 py-2.5 rounded-xl border border-black/10 text-zinc-600 hover:text-zinc-900 transition-all"
                        style={{ fontSize: "0.82rem", background: "none", fontFamily: "inherit", cursor: "pointer" }}
                      >
                        <X className="w-4 h-4" /> Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="p-6 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
                    {[
                      ["Company Name", config.company_name || "—"],
                      ["GSTIN", config.gst_number || "—"],
                      ["State Code", config.company_state_code || "—"],
                      ["Invoice Prefix", config.invoice_prefix],
                      ["Invoice Series", config.invoice_series],
                      ["Current Sequence", String(config.current_sequence)],
                      ["Next Invoice No", `${config.invoice_prefix}/${config.invoice_series}/${String((config.current_sequence || 0) + 1).padStart(6, "0")}`],
                    ].map(([label, value]) => (
                      <div key={label} className="rounded-xl border border-black/[0.06] bg-black/[0.02] p-3">
                        <div className="text-zinc-400 mb-1" style={{ fontSize: "0.62rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>{label}</div>
                        <div className="text-zinc-900 font-semibold font-mono" style={{ fontSize: "0.82rem" }}>{value}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
