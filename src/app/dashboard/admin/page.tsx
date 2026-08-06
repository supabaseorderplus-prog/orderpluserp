"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Loader2, Save, Settings, Shield, Tag, Trophy, Wallet } from "lucide-react";

interface TDConfig { id: string; applicable_party_type: string; td_percent: number; valid_from: string; notes: string | null; party_id: string | null }
interface CDConfig { id: string; applicable_party_type: string; slab_name: string; cd_percent: number; valid_from: string; party_id: string | null }
interface GSTConfig { id: string; manufacturer_gstin: string; fiscal_year: string; invoice_prefix: string; invoice_series: string; current_sequence: number }

type Tab = "td" | "cd" | "gst" | "credit";
const css: React.CSSProperties = { transform: "none", filter: "none", WebkitTextStroke: "0", background: "none", boxShadow: "none", display: "block", padding: 0 };

export default function AdminPage() {
  const [tab, setTab] = useState<Tab>("td");
  const [tdConfigs, setTdConfigs] = useState<TDConfig[]>([]);
  const [cdConfigs, setCdConfigs] = useState<CDConfig[]>([]);
  const [gstConfig, setGstConfig] = useState<GSTConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  // New TD form
  const [newTD, setNewTD] = useState({ applicable_party_type: "CNF", td_percent: "5", valid_from: new Date().toISOString().split("T")[0], notes: "" });
  // New CD form
  const [newCD, setNewCD] = useState({ applicable_party_type: "CNF", slab_name: "ADVANCE", cd_percent: "3", valid_from: new Date().toISOString().split("T")[0] });

  useEffect(() => {
    setLoading(true);
    Promise.all([
      api<{ success: boolean; data: { td: TDConfig[]; cd: CDConfig[] } }>("/api/v1/td-config"),
      api<{ success: boolean; data: GSTConfig[] }>("/api/v1/gst-config").catch(() => ({ success: true, data: [] })),
    ]).then(([tdcdRes, gstRes]) => {
      setTdConfigs(tdcdRes.data.td || []);
      setCdConfigs(tdcdRes.data.cd || []);
      if (Array.isArray(gstRes.data) && gstRes.data.length > 0) setGstConfig(gstRes.data[0]);
    }).catch(() => {}).finally(() => setLoading(false));
  }, []);

  async function addTD() {
    setSaving(true); setMessage("");
    try {
      await api("/api/v1/td-config", { method: "POST", body: { ...newTD, td_percent: parseFloat(newTD.td_percent) } });
      setMessage("TD config added. Changes audit-logged.");
      // Refresh
      const res = await api<{ success: boolean; data: { td: TDConfig[]; cd: CDConfig[] } }>("/api/v1/td-config");
      setTdConfigs(res.data.td || []);
    } catch (err) { setMessage(err instanceof Error ? err.message : "Failed"); }
    finally { setSaving(false); }
  }

  async function addCD() {
    setSaving(true); setMessage("");
    try {
      await api("/api/v1/cd-config", { method: "POST", body: { ...newCD, cd_percent: parseFloat(newCD.cd_percent) } });
      setMessage("CD config added. Changes audit-logged.");
      const res = await api<{ success: boolean; data: { td: TDConfig[]; cd: CDConfig[] } }>("/api/v1/td-config");
      setCdConfigs(res.data.cd || []);
    } catch (err) { setMessage(err instanceof Error ? err.message : "Failed"); }
    finally { setSaving(false); }
  }

  const tabs = [
    { key: "td" as const, label: "TD Config", icon: Tag },
    { key: "cd" as const, label: "CD Config", icon: Wallet },
    { key: "gst" as const, label: "GST Config", icon: Shield },
    { key: "credit" as const, label: "Credit Control", icon: Settings },
  ];

  return (
    <div style={{ fontFamily: "'Inter','system-ui',sans-serif" }}>
      <h1 className="text-2xl font-bold text-zinc-900 mb-1" style={{ ...css, fontSize: "1.5rem", marginBottom: "0.25rem" }}>Admin Configuration</h1>
      <p className="text-zinc-600 mb-6" style={{ fontSize: "0.8rem" }}>TD/CD rates, GST config, credit control settings</p>

      {message && <div className="mb-4 p-3 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-400" style={{ fontSize: "0.8rem" }}>{message}</div>}

      <div className="flex gap-2 mb-6 overflow-x-auto -mx-3 px-3 sm:mx-0 sm:px-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {tabs.map((t) => {
          const Icon = t.icon;
          return (
            <button key={t.key} onClick={() => setTab(t.key)}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm transition-all shrink-0 whitespace-nowrap ${tab === t.key ? "bg-amber-500/10 text-amber-400 border border-amber-500/30" : "border border-black/10 text-zinc-600 hover:bg-black/5"}`}
              style={{ fontSize: "0.8rem", fontFamily: "inherit", textTransform: "none", boxShadow: "none", cursor: "pointer", background: tab === t.key ? undefined : "none" }}>
              <Icon className="w-4 h-4" /> {t.label}
            </button>
          );
        })}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20"><Loader2 className="w-8 h-8 text-amber-500 animate-spin" /></div>
      ) : (
        <>
          {/* TD Config */}
          {tab === "td" && (
            <div className="space-y-4">
              <div className="rounded-xl border border-black/[0.06] bg-black/[0.02] p-5">
                <h3 className="text-zinc-900 font-medium mb-4" style={{ fontSize: "0.9rem" }}>Add Trade Discount Config</h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
                  <select value={newTD.applicable_party_type} onChange={(e) => setNewTD({ ...newTD, applicable_party_type: e.target.value })}
                    className="px-3 py-2 rounded-lg border border-black/10 bg-[#ffffff] text-zinc-900 outline-none" style={{ fontSize: "0.8rem", fontFamily: "inherit" }}>
                    <option value="CNF">CNF</option>
                    <option value="SUPER_DEALER">Super Dealer</option>
                  </select>
                  <input type="number" step="0.1" placeholder="TD %" value={newTD.td_percent} onChange={(e) => setNewTD({ ...newTD, td_percent: e.target.value })}
                    className="px-3 py-2 rounded-lg border border-black/10 bg-black/[0.03] text-zinc-900 outline-none" style={{ fontSize: "0.8rem" }} />
                  <input type="date" value={newTD.valid_from} onChange={(e) => setNewTD({ ...newTD, valid_from: e.target.value })}
                    className="px-3 py-2 rounded-lg border border-black/10 bg-black/[0.03] text-zinc-900 outline-none" style={{ fontSize: "0.8rem" }} />
                  <button onClick={addTD} disabled={saving}
                    className="px-4 py-2 rounded-lg bg-amber-500 text-zinc-900 hover:bg-amber-600 disabled:opacity-50 flex items-center justify-center gap-2"
                    style={{ fontSize: "0.8rem", fontFamily: "inherit", textTransform: "none", boxShadow: "none", cursor: "pointer", border: "none" }}>
                    {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save
                  </button>
                </div>
                <p className="text-zinc-500" style={{ fontSize: "0.7rem" }}>All TD config changes are audit-logged. TD % applies to downstream invoices, NOT direct billing.</p>
              </div>

              <div className="rounded-xl border border-black/[0.06] overflow-hidden">
                <table className="w-full" style={{ borderCollapse: "collapse" }}>
                  <thead>
                    <tr className="border-b border-black/[0.06]">
                      {["Party Type", "TD %", "Valid From", "Scope", "Notes"].map(h => (
                        <th key={h} className="text-left px-4 py-3 text-xs font-medium text-zinc-500 bg-black/[0.02]" style={{ fontSize: "0.7rem", textTransform: "uppercase" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {tdConfigs.length === 0 ? (
                      <tr><td colSpan={5} className="text-center py-8 text-zinc-500" style={{ fontSize: "0.8rem" }}>No TD config found</td></tr>
                    ) : tdConfigs.map((td) => (
                      <tr key={td.id} className="border-b border-black/[0.04] hover:bg-black/[0.02]">
                        <td className="px-4 py-3"><span className="px-2 py-0.5 rounded text-xs bg-blue-500/20 text-blue-400" style={{ fontSize: "0.65rem" }}>{td.applicable_party_type}</span></td>
                        <td className="px-4 py-3 text-amber-400 font-bold" style={{ fontSize: "0.9rem" }}>{td.td_percent}%</td>
                        <td className="px-4 py-3 text-zinc-600" style={{ fontSize: "0.8rem" }}>{td.valid_from}</td>
                        <td className="px-4 py-3 text-zinc-600" style={{ fontSize: "0.75rem" }}>{td.party_id ? "Party-specific" : "Global"}</td>
                        <td className="px-4 py-3 text-zinc-500" style={{ fontSize: "0.75rem" }}>{td.notes || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* CD Config */}
          {tab === "cd" && (
            <div className="space-y-4">
              <div className="rounded-xl border border-black/[0.06] bg-black/[0.02] p-5">
                <h3 className="text-zinc-900 font-medium mb-4" style={{ fontSize: "0.9rem" }}>Add Cash Discount Slab</h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 mb-4">
                  <select value={newCD.applicable_party_type} onChange={(e) => setNewCD({ ...newCD, applicable_party_type: e.target.value })}
                    className="px-3 py-2 rounded-lg border border-black/10 bg-[#ffffff] text-zinc-900 outline-none" style={{ fontSize: "0.8rem", fontFamily: "inherit" }}>
                    <option value="CNF">CNF</option><option value="SUPER_DEALER">Super Dealer</option><option value="RETAILER">Retailer</option>
                  </select>
                  <select value={newCD.slab_name} onChange={(e) => setNewCD({ ...newCD, slab_name: e.target.value })}
                    className="px-3 py-2 rounded-lg border border-black/10 bg-[#ffffff] text-zinc-900 outline-none" style={{ fontSize: "0.8rem", fontFamily: "inherit" }}>
                    <option value="ADVANCE">Advance</option><option value="WITHIN_7">Within 7 days</option>
                    <option value="WITHIN_14">Within 14 days</option><option value="WITHIN_21">Within 21 days</option>
                  </select>
                  <input type="number" step="0.1" placeholder="CD %" value={newCD.cd_percent} onChange={(e) => setNewCD({ ...newCD, cd_percent: e.target.value })}
                    className="px-3 py-2 rounded-lg border border-black/10 bg-black/[0.03] text-zinc-900 outline-none" style={{ fontSize: "0.8rem" }} />
                  <input type="date" value={newCD.valid_from} onChange={(e) => setNewCD({ ...newCD, valid_from: e.target.value })}
                    className="px-3 py-2 rounded-lg border border-black/10 bg-black/[0.03] text-zinc-900 outline-none" style={{ fontSize: "0.8rem" }} />
                  <button onClick={addCD} disabled={saving}
                    className="px-4 py-2 rounded-lg bg-amber-500 text-zinc-900 hover:bg-amber-600 disabled:opacity-50 flex items-center justify-center gap-2"
                    style={{ fontSize: "0.8rem", fontFamily: "inherit", textTransform: "none", boxShadow: "none", cursor: "pointer", border: "none" }}>
                    {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save
                  </button>
                </div>
                <p className="text-zinc-500" style={{ fontSize: "0.7rem" }}>CD slabs are mutually exclusive per invoice-payment. Beyond 21 days = No CD.</p>
              </div>

              <div className="rounded-xl border border-black/[0.06] overflow-hidden">
                <table className="w-full" style={{ borderCollapse: "collapse" }}>
                  <thead>
                    <tr className="border-b border-black/[0.06]">
                      {["Party Type", "Slab", "CD %", "Valid From"].map(h => (
                        <th key={h} className="text-left px-4 py-3 text-xs font-medium text-zinc-500 bg-black/[0.02]" style={{ fontSize: "0.7rem", textTransform: "uppercase" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {cdConfigs.length === 0 ? (
                      <tr><td colSpan={4} className="text-center py-8 text-zinc-500" style={{ fontSize: "0.8rem" }}>No CD config found</td></tr>
                    ) : cdConfigs.map((cd) => (
                      <tr key={cd.id} className="border-b border-black/[0.04] hover:bg-black/[0.02]">
                        <td className="px-4 py-3"><span className="px-2 py-0.5 rounded text-xs bg-purple-500/20 text-purple-400" style={{ fontSize: "0.65rem" }}>{cd.applicable_party_type}</span></td>
                        <td className="px-4 py-3 text-zinc-700" style={{ fontSize: "0.8rem" }}>{cd.slab_name.replace(/_/g, " ")}</td>
                        <td className="px-4 py-3 text-amber-400 font-bold" style={{ fontSize: "0.9rem" }}>{cd.cd_percent}%</td>
                        <td className="px-4 py-3 text-zinc-600" style={{ fontSize: "0.8rem" }}>{cd.valid_from}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* GST Config */}
          {tab === "gst" && (
            <div className="rounded-xl border border-black/[0.06] bg-black/[0.02] p-5">
              <h3 className="text-zinc-900 font-medium mb-4" style={{ fontSize: "0.9rem" }}>GST Configuration</h3>
              {gstConfig ? (
                <div className="grid grid-cols-2 gap-4">
                  {[
                    { label: "Manufacturer GSTIN", value: gstConfig.manufacturer_gstin },
                    { label: "Fiscal Year", value: gstConfig.fiscal_year },
                    { label: "Invoice Prefix", value: gstConfig.invoice_prefix },
                    { label: "Invoice Series", value: gstConfig.invoice_series },
                    { label: "Current Sequence", value: String(gstConfig.current_sequence) },
                    { label: "Format", value: `${gstConfig.invoice_prefix}/WB/FY/${gstConfig.invoice_series}/SEQNO` },
                  ].map((item) => (
                    <div key={item.label} className="p-3 rounded-lg border border-black/[0.06] bg-black/[0.02]">
                      <div className="text-zinc-500" style={{ fontSize: "0.65rem" }}>{item.label}</div>
                      <div className="text-zinc-900 font-mono" style={{ fontSize: "0.85rem" }}>{item.value}</div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-zinc-500" style={{ fontSize: "0.8rem" }}>GST config loaded from database seed data</p>
              )}
              <div className="mt-4 p-3 rounded-lg bg-blue-500/5 border border-blue-500/20">
                <p className="text-blue-400" style={{ fontSize: "0.75rem" }}>
                  GST Rules: Intrastate (WB to WB) = CGST + SGST | Interstate = IGST. Auto-detected from GSTIN state codes.
                </p>
              </div>
            </div>
          )}

          {/* Credit Control */}
          {tab === "credit" && (
            <div className="rounded-xl border border-black/[0.06] bg-black/[0.02] p-5">
              <h3 className="text-zinc-900 font-medium mb-4" style={{ fontSize: "0.9rem" }}>Credit Control Settings</h3>
              <div className="space-y-4">
                <div className="p-4 rounded-lg border border-black/[0.06] bg-black/[0.02]">
                  <h4 className="text-zinc-700 font-medium mb-2" style={{ fontSize: "0.85rem" }}>Credit Limit Formula</h4>
                  <p className="text-zinc-600" style={{ fontSize: "0.75rem" }}>
                    Credit Limit = Security Deposit x Multiplier (default 3x)<br/>
                    OR: Fixed credit limit set by Admin per party<br/>
                    Configurable per party in Party Master
                  </p>
                </div>
                <div className="p-4 rounded-lg border border-black/[0.06] bg-black/[0.02]">
                  <h4 className="text-zinc-700 font-medium mb-2" style={{ fontSize: "0.85rem" }}>On Invoice Creation</h4>
                  <p className="text-zinc-600" style={{ fontSize: "0.75rem" }}>
                    Check: Outstanding + New Amount &#8804; Effective Limit<br/>
                    If exceeded: Soft block with Admin override option<br/>
                    All events logged in credit_control_events table
                  </p>
                </div>
                <div className="p-4 rounded-lg border border-amber-500/20 bg-amber-500/5">
                  <h4 className="text-amber-400 font-medium mb-2" style={{ fontSize: "0.85rem" }}>Security Deposit Interest</h4>
                  <p className="text-zinc-600" style={{ fontSize: "0.75rem" }}>
                    Annual interest calculated April 1st via pg_cron<br/>
                    Interest = Avg Monthly Balance x Rate%<br/>
                    Auto-credited to security_ledger
                  </p>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
