"use client";

import { useEffect, useState, useCallback } from "react";
import { api, getUser } from "@/lib/api";
import {
  Loader2, Plus, Pencil, Trash2, X, Check, ChevronDown,
  DollarSign, Percent, Users, Package, Search, AlertCircle, Building2
} from "lucide-react";

// ── Types ──
interface Product { id: string; name: string; sku: string; base_price: number; mrp: number }
interface Party { id: string; name: string; party_code: string; party_type_id: string; party_types?: { name: string } }
interface PriceListItem { id?: string; product_id: string; unit_price: number; min_margin_floor?: number; max_margin_ceiling?: number; products?: { name: string; sku: string; base_price?: number; mrp?: number } }
interface PriceList { id: string; name: string; code: string; applicable_party_type: string; party_id?: string | null; group_id?: string | null; valid_from: string; valid_to: string | null; is_current: boolean; notes: string; price_list_items: PriceListItem[]; parties?: { name: string; party_code: string } | null }
interface GroupOption { id: string; name: string }
interface GroupMember { id: string; name: string; party_code: string; party_types?: { name: string } }
type GroupScope = "all" | "category" | "party";
interface TDConfig { id: string; party_id: string | null; applicable_party_type: string; td_percent: number; valid_from: string; valid_to: string | null; notes: string; parties?: { name: string; party_code: string } | null }
const PARTY_TYPES = ["CNF", "SUPER_DEALER", "RETAILER"];

const ptColor: Record<string, string> = {
  CNF: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  SUPER_DEALER: "bg-purple-500/20 text-purple-400 border-purple-500/30",
  RETAILER: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
};

const today = () => new Date().toISOString().split("T")[0];

export default function PricingPage() {
  const [tab, setTab] = useState<"price_lists" | "td" | "party_pricing">("price_lists");
  const [priceLists, setPriceLists] = useState<PriceList[]>([]);
  const [tdConfigs, setTdConfigs] = useState<TDConfig[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [parties, setParties] = useState<Party[]>([]);
  const [groups, setGroups] = useState<GroupOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [noCompanyScope, setNoCompanyScope] = useState(false);
  const isSuperAdmin = getUser()?.role === "SUPER_ADMIN";

  // Delete confirm modal state
  const [deleteConfirm, setDeleteConfirm] = useState<{ type: "pl" | "td"; id: string; label: string } | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Modals
  const [showPLModal, setShowPLModal] = useState(false);
  const [editPL, setEditPL] = useState<PriceList | null>(null);
  const [showTDModal, setShowTDModal] = useState(false);
  const [editTD, setEditTD] = useState<TDConfig | null>(null);

  // Filters
  const [filterPT, setFilterPT] = useState("");
  const [searchQ, setSearchQ] = useState("");

  const load = useCallback(async () => {
    const currentUser = getUser();
    const activeCompanyId = typeof window !== "undefined" ? localStorage.getItem("activeCompanyId") : null;
    
    // Super admin must be scoped to a company — refuse to load all companies' data
    if (currentUser?.role === "SUPER_ADMIN" && !activeCompanyId) {
      setNoCompanyScope(true);
      setLoading(false);
      return;
    }
    
    setNoCompanyScope(false);
    setLoading(true);
    const [plRes, tdRes, prodRes, partyRes, groupRes] = await Promise.allSettled([
      api<{ success: boolean; data: PriceList[] }>("/api/v1/price-lists"),
      api<{ success: boolean; data: { td: TDConfig[] } }>("/api/v1/td-config"),
      api<{ success: boolean; data: Product[] }>("/api/v1/products?limit=500"),
      api<{ success: boolean; data: Party[] }>("/api/v1/parties?limit=500"),
      api<{ success: boolean; data: GroupOption[] }>("/api/v1/groups"),
    ]);
    if (plRes.status === "fulfilled") setPriceLists(plRes.value.data || []);
    if (tdRes.status === "fulfilled") { setTdConfigs(tdRes.value.data?.td || []); }
    if (prodRes.status === "fulfilled") setProducts(prodRes.value.data || []);
    if (partyRes.status === "fulfilled") setParties(partyRes.value.data || []);
    if (groupRes.status === "fulfilled") setGroups(groupRes.value.data || []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  // Re-fetch whenever company scope changes (e.g. Super Admin selects/clears a company from another tab or the dashboard)
  useEffect(() => {
    const onCompanyChanged = () => load();
    window.addEventListener("activeCompanyChanged", onCompanyChanged);
    return () => window.removeEventListener("activeCompanyChanged", onCompanyChanged);
  }, [load]);

  // ── Delete handlers ──
  const confirmDelete = async () => {
    if (!deleteConfirm) return;
    setDeleting(true);
    try {
      if (deleteConfirm.type === "pl") {
        await api(`/api/v1/price-lists/${deleteConfirm.id}`, { method: "DELETE" });
      } else {
        await api(`/api/v1/td-config?id=${deleteConfirm.id}&type=${deleteConfirm.type}`, { method: "DELETE" });
      }
      setDeleteConfirm(null);
      load();
    } catch { /* ignore */ }
    setDeleting(false);
  };

  const groupNameById = Object.fromEntries(groups.map(group => [group.id, group.name]));
  const partyNameById = Object.fromEntries(parties.map(party => [party.id, party.name]));

  const describePriceListTarget = (pl: PriceList) => {
    if (pl.group_id) {
      const groupName = groupNameById[pl.group_id] || "Unknown group";
      if (pl.party_id) {
        const partyName = partyNameById[pl.party_id] || pl.parties?.name || "Unknown party";
        return partyName + " from " + groupName + " group";
      }
      if (pl.applicable_party_type && pl.applicable_party_type !== "GROUP") {
        return pl.applicable_party_type.replace(/_/g, " ") + " from " + groupName + " group";
      }
      return groupName + " group";
    }

    if (pl.party_id) {
      return partyNameById[pl.party_id] || pl.parties?.name || "Unknown party";
    }

    return pl.applicable_party_type.replace(/_/g, " ");
  };

  const getPriceListBadgeLabel = (pl: PriceList) => {
    if (pl.group_id) {
      if (pl.party_id) return "GROUP PARTY";
      if (pl.applicable_party_type && pl.applicable_party_type !== "GROUP") {
        return pl.applicable_party_type.replace(/_/g, " ") + " GROUP";
      }
      return "GROUP";
    }

    if (pl.party_id) return "PARTY";
    return pl.applicable_party_type.replace(/_/g, " ");
  };

  const filteredPL = priceLists.filter(pl =>
    (!filterPT || pl.applicable_party_type === filterPT) &&
    (!searchQ || pl.name.toLowerCase().includes(searchQ.toLowerCase()) || pl.code.toLowerCase().includes(searchQ.toLowerCase()) || describePriceListTarget(pl).toLowerCase().includes(searchQ.toLowerCase()))
  );

  const filteredTD = tdConfigs.filter(td =>
    (!filterPT || td.applicable_party_type === filterPT)
  );

  // Party pricing view: group by party
  const partyPricingData = parties.map(p => {
    const partyType = p.party_types?.name || "";
    const plForParty = priceLists.find(pl => pl.applicable_party_type === partyType && pl.is_current);
    const tdForParty = tdConfigs.find(td => (td.party_id === p.id) || (!td.party_id && td.applicable_party_type === partyType));
    return { party: p, partyType, priceList: plForParty || null, td: tdForParty || null };
  }).filter(x =>
    (!filterPT || x.partyType === filterPT) &&
    (!searchQ || x.party.name.toLowerCase().includes(searchQ.toLowerCase()) || x.party.party_code.toLowerCase().includes(searchQ.toLowerCase()))
  );

  const tabs = [
    { key: "price_lists" as const, label: "Price Lists", icon: DollarSign, count: priceLists.length },
    { key: "td" as const, label: "Trade Discount", icon: Percent, count: tdConfigs.length },
    { key: "party_pricing" as const, label: "Party Pricing", icon: Users, count: parties.length },
  ];

  return (
    <div style={{ fontFamily: "'Inter','system-ui',sans-serif" }}>
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900" style={{ fontSize: "1.5rem", transform: "none", filter: "none" }}>Pricing & Discounts</h1>
          <p className="text-zinc-600 mt-1" style={{ fontSize: "0.8rem" }}>Set prices per distributor type, configure trade discounts, manage party-specific overrides</p>
        </div>
        <div className="flex gap-2">
          {tab === "price_lists" && (
            <button onClick={() => { setEditPL(null); setShowPLModal(true); }}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-amber-500 text-black font-medium text-sm hover:bg-amber-400 transition-colors"
              style={{ fontSize: "0.8rem", border: "none", cursor: "pointer" }}>
              <Plus className="w-4 h-4" /> New Price List
            </button>
          )}
          {tab === "td" && (
            <button onClick={() => { setEditTD(null); setShowTDModal(true); }}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-amber-500 text-black font-medium text-sm hover:bg-amber-400 transition-colors"
              style={{ fontSize: "0.8rem", border: "none", cursor: "pointer" }}>
              <Plus className="w-4 h-4" /> New TD Config
            </button>
          )}
          </div>
        </div>

      {/* ── No company scope guard (Super Admin only) ── */}
      {noCompanyScope && (
        <div className="max-w-lg mx-auto py-12">
          <div className="flex flex-col items-center text-center mb-8">
            <div className="w-14 h-14 rounded-2xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center mb-4">
              <Building2 className="w-7 h-7 text-amber-400 opacity-70" />
            </div>
            <h2 className="text-zinc-900 font-semibold mb-1" style={{ fontSize: "1rem" }}>Select a Company</h2>
            <p className="text-zinc-500" style={{ fontSize: "0.8rem" }}>Choose which company's pricing data you want to view.</p>
          </div>
          <div className="text-center text-zinc-500" style={{ fontSize: "0.8rem" }}>
            Please select a company from the dashboard to continue.
          </div>
        </div>
      )}

      {!noCompanyScope && (
        <>
      {/* Tabs */}
      <div className="flex gap-2 mb-4 overflow-x-auto pb-1">
        {tabs.map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm transition-all whitespace-nowrap ${
              tab === t.key ? "bg-amber-500/10 text-amber-400 border border-amber-500/30" : "border border-black/10 text-zinc-600 hover:bg-black/5"
            }`}
            style={{ fontSize: "0.8rem", cursor: "pointer", background: tab === t.key ? undefined : "none", fontFamily: "inherit", textTransform: "none", boxShadow: "none" }}>
            <t.icon className="w-4 h-4" />
            {t.label}
            <span className={`ml-1 px-1.5 py-0.5 rounded text-xs ${tab === t.key ? "bg-amber-500/20 text-amber-400" : "bg-black/5 text-zinc-500"}`} style={{ fontSize: "0.65rem" }}>{t.count}</span>
          </button>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3 mb-6">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
          <input
            value={searchQ} onChange={e => setSearchQ(e.target.value)}
            placeholder="Search by name, code..."
            className="w-full pl-10 pr-4 py-2.5 rounded-lg bg-black/[0.03] border border-black/[0.08] text-zinc-900 text-sm placeholder:text-zinc-500 focus:outline-none focus:border-amber-500/40"
            style={{ fontSize: "0.8rem", fontFamily: "inherit" }}
          />
        </div>
        <div className="relative">
          <select
            value={filterPT} onChange={e => setFilterPT(e.target.value)}
            className="appearance-none pl-4 pr-10 py-2.5 rounded-lg bg-black/[0.03] border border-black/[0.08] text-zinc-900 text-sm focus:outline-none focus:border-amber-500/40"
            style={{ fontSize: "0.8rem", fontFamily: "inherit", minWidth: "160px" }}
          >
            <option value="" style={{ background: "#ffffff" }}>All Party Types</option>
            {PARTY_TYPES.map(pt => <option key={pt} value={pt} style={{ background: "#ffffff" }}>{pt.replace(/_/g, " ")}</option>)}
          </select>
          <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500 pointer-events-none" />
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20"><Loader2 className="w-8 h-8 text-amber-500 animate-spin" /></div>
      ) : (
        <>
          {/* ── PRICE LISTS TAB ── */}
          {tab === "price_lists" && (
            filteredPL.length === 0 ? (
              <EmptyState icon={DollarSign} message="No price lists found" sub="Create a price list to set product prices per distributor type" onAction={() => { setEditPL(null); setShowPLModal(true); }} actionLabel="Create Price List" />
            ) : (
              <div className="space-y-4">
                {filteredPL.map((pl) => (
                  <div key={pl.id} className="rounded-xl border border-black/[0.06] bg-black/[0.02] hover:bg-black/[0.03] transition-all overflow-hidden">
                    <div className="p-5">
                      <div className="flex items-start justify-between mb-4">
                        <div className="flex items-start gap-3">
                          <div className="w-10 h-10 rounded-lg bg-amber-500/10 flex items-center justify-center shrink-0">
                            <DollarSign className="w-5 h-5 text-amber-400" />
                          </div>
                          <div>
                            <h3 className="text-zinc-900 font-semibold" style={{ fontSize: "0.9rem" }}>{pl.name}</h3>
                            <span className="text-zinc-500 font-mono" style={{ fontSize: "0.7rem" }}>{pl.code}</span>
                            <div className="text-zinc-600 mt-1" style={{ fontSize: "0.72rem" }}>
                              For {describePriceListTarget(pl)}
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className={`inline-block px-2.5 py-1 rounded-md text-xs border ${ptColor[pl.applicable_party_type] || "bg-zinc-500/20 text-zinc-600 border-zinc-500/30"}`} style={{ fontSize: "0.65rem" }}>
                            {getPriceListBadgeLabel(pl)}
                          </span>
                          <span className={`px-2 py-0.5 rounded text-xs ${pl.is_current ? "bg-emerald-500/20 text-emerald-400" : "bg-zinc-500/20 text-zinc-500"}`} style={{ fontSize: "0.6rem" }}>
                            {pl.is_current ? "CURRENT" : "EXPIRED"}
                          </span>
                            <button onClick={() => { setEditPL(pl); setShowPLModal(true); }}
                              className="p-1.5 rounded-md text-zinc-500 hover:text-zinc-900 hover:bg-black/10 transition-all"
                              style={{ background: "none", border: "none", cursor: "pointer" }}>
                              <Pencil className="w-3.5 h-3.5" />
                            </button>
                            {isSuperAdmin && (
                            <button onClick={() => setDeleteConfirm({ type: "pl", id: pl.id, label: pl.name })}
                              className="p-1.5 rounded-md text-zinc-500 hover:text-red-400 hover:bg-red-500/10 transition-all"
                              style={{ background: "none", border: "none", cursor: "pointer" }}>
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                            )}
                        </div>
                      </div>

                      <div className="grid grid-cols-3 gap-4 mb-4">
                        <div className="rounded-lg bg-black/[0.02] border border-black/[0.04] p-3">
                          <div className="text-zinc-500 mb-1" style={{ fontSize: "0.65rem" }}>Valid From</div>
                          <div className="text-zinc-900 font-medium" style={{ fontSize: "0.8rem" }}>{pl.valid_from}</div>
                        </div>
                        <div className="rounded-lg bg-black/[0.02] border border-black/[0.04] p-3">
                          <div className="text-zinc-500 mb-1" style={{ fontSize: "0.65rem" }}>Valid To</div>
                          <div className="text-zinc-900 font-medium" style={{ fontSize: "0.8rem" }}>{pl.valid_to || "No Expiry"}</div>
                        </div>
                        <div className="rounded-lg bg-black/[0.02] border border-black/[0.04] p-3">
                          <div className="text-zinc-500 mb-1" style={{ fontSize: "0.65rem" }}>Products</div>
                          <div className="text-amber-400 font-semibold" style={{ fontSize: "0.8rem" }}>{pl.price_list_items?.length || 0} items</div>
                        </div>
                      </div>

                      {/* Product prices table */}
                      {pl.price_list_items?.length > 0 && (
                        <div className="rounded-lg border border-black/[0.04] overflow-hidden">
                          <div style={{ maxHeight: "16rem", overflowY: "auto" }}>
                            <table className="w-full" style={{ borderCollapse: "collapse" }}>
                              <thead className="sticky top-0 z-10">
                                <tr className="bg-zinc-50">
                                  {["Product", "SKU", "Unit Price"].map(h => (
                                    <th key={h} className="text-left px-3 py-2 text-zinc-500 font-medium" style={{ fontSize: "0.65rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>{h}</th>
                                  ))}
                                </tr>
                              </thead>
                              <tbody>
                                {pl.price_list_items.map((item, i) => (
                                  <tr key={i} className="border-t border-black/[0.04]">
                                      <td className="px-3 py-2 text-zinc-900" style={{ fontSize: "0.8rem" }}>{item.products?.name || "—"}</td>
                                      <td className="px-3 py-2 text-zinc-600 font-mono" style={{ fontSize: "0.7rem" }}>{item.products?.sku || "—"}</td>
                                      <td className="px-3 py-2 text-amber-400 font-semibold" style={{ fontSize: "0.8rem" }}>&#8377;{Number(item.unit_price).toLocaleString("en-IN")}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )
          )}

          {/* ── TRADE DISCOUNT TAB ── */}
          {tab === "td" && (
            filteredTD.length === 0 ? (
              <EmptyState icon={Percent} message="No trade discount configs" sub="Set TD% per distributor type or for specific parties" onAction={() => { setEditTD(null); setShowTDModal(true); }} actionLabel="Create TD Config" />
            ) : (
              <div className="rounded-xl border border-black/[0.06] overflow-hidden">
                <table className="w-full" style={{ borderCollapse: "collapse" }}>
                  <thead>
                    <tr className="bg-black/[0.02]">
                      {["Party Type", "Specific Party", "TD %", "Valid From", "Valid To", "Notes", "Actions"].map(h => (
                        <th key={h} className="text-left px-4 py-3 text-zinc-500 font-medium" style={{ fontSize: "0.65rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {filteredTD.map(td => (
                      <tr key={td.id} className="border-t border-black/[0.04] hover:bg-black/[0.02]">
                        <td className="px-4 py-3">
                          <span className={`inline-block px-2 py-0.5 rounded text-xs ${ptColor[td.applicable_party_type]?.split(" border")[0] || "bg-zinc-500/20 text-zinc-600"}`} style={{ fontSize: "0.65rem" }}>{td.applicable_party_type.replace(/_/g, " ")}</span>
                        </td>
                        <td className="px-4 py-3 text-zinc-700" style={{ fontSize: "0.8rem" }}>
                          {td.parties ? `${td.parties.name} (${td.parties.party_code})` : <span className="text-zinc-500 italic">All</span>}
                        </td>
                        <td className="px-4 py-3">
                          <span className="text-amber-400 font-bold" style={{ fontSize: "0.95rem" }}>{td.td_percent}%</span>
                        </td>
                        <td className="px-4 py-3 text-zinc-600" style={{ fontSize: "0.8rem" }}>{td.valid_from}</td>
                        <td className="px-4 py-3 text-zinc-600" style={{ fontSize: "0.8rem" }}>{td.valid_to || "—"}</td>
                        <td className="px-4 py-3 text-zinc-500" style={{ fontSize: "0.75rem" }}>{td.notes || "—"}</td>
                        <td className="px-4 py-3">
                          <div className="flex gap-1">
                              <button onClick={() => { setEditTD(td); setShowTDModal(true); }} className="p-1.5 rounded text-zinc-500 hover:text-zinc-900 hover:bg-black/10" style={{ background: "none", border: "none", cursor: "pointer" }}><Pencil className="w-3.5 h-3.5" /></button>
                              {isSuperAdmin && (
                              <button onClick={() => setDeleteConfirm({ type: "td", id: td.id, label: `TD ${td.td_percent}% — ${td.applicable_party_type}` })} className="p-1.5 rounded text-zinc-500 hover:text-red-400 hover:bg-red-500/10" style={{ background: "none", border: "none", cursor: "pointer" }}><Trash2 className="w-3.5 h-3.5" /></button>
                              )}
                            </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          )}

          {/* ── PARTY PRICING TAB ── */}
          {tab === "party_pricing" && (
            partyPricingData.length === 0 ? (
              <EmptyState icon={Users} message="No parties found" sub="Add parties first to view their pricing configuration" />
            ) : (
              <div className="space-y-3">
                {partyPricingData.map(({ party, partyType, priceList, td }) => (
                  <div key={party.id} className="rounded-xl border border-black/[0.06] bg-black/[0.02] p-5 hover:bg-black/[0.03] transition-all">
                    <div className="flex items-start justify-between mb-4">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-zinc-100 to-zinc-200 flex items-center justify-center shrink-0">
                          <span className="text-zinc-900 text-xs font-bold" style={{ transform: "none" }}>{party.name.slice(0, 2).toUpperCase()}</span>
                        </div>
                        <div>
                          <h3 className="text-zinc-900 font-semibold" style={{ fontSize: "0.9rem" }}>{party.name}</h3>
                          <span className="text-zinc-500 font-mono" style={{ fontSize: "0.7rem" }}>{party.party_code}</span>
                        </div>
                      </div>
                      <span className={`inline-block px-2.5 py-1 rounded-md text-xs border ${ptColor[partyType] || "bg-zinc-500/20 text-zinc-600 border-zinc-500/30"}`} style={{ fontSize: "0.65rem" }}>
                        {partyType.replace(/_/g, " ")}
                      </span>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      {/* Price List */}
                      <div className="rounded-lg bg-black/[0.02] border border-black/[0.04] p-3">
                        <div className="flex items-center gap-2 mb-2">
                          <DollarSign className="w-3.5 h-3.5 text-amber-400" />
                          <span className="text-zinc-600 font-medium" style={{ fontSize: "0.7rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>Price List</span>
                        </div>
                        {priceList ? (
                          <div>
                            <div className="text-zinc-900 font-medium" style={{ fontSize: "0.8rem" }}>{priceList.name}</div>
                            <div className="text-amber-400" style={{ fontSize: "0.75rem" }}>{priceList.price_list_items?.length || 0} products</div>
                          </div>
                        ) : (
                          <div className="text-zinc-500 italic" style={{ fontSize: "0.75rem" }}>No price list assigned</div>
                        )}
                      </div>

                      {/* Trade Discount */}
                      <div className="rounded-lg bg-black/[0.02] border border-black/[0.04] p-3">
                        <div className="flex items-center gap-2 mb-2">
                          <Percent className="w-3.5 h-3.5 text-blue-400" />
                          <span className="text-zinc-600 font-medium" style={{ fontSize: "0.7rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>Trade Discount</span>
                        </div>
                        {td ? (
                          <div>
                            <div className="text-zinc-900 font-bold" style={{ fontSize: "1rem" }}>{td.td_percent}%</div>
                            <div className="text-zinc-500" style={{ fontSize: "0.7rem" }}>{td.party_id ? "Party-specific" : "Type default"}</div>
                          </div>
                        ) : (
                          <div className="text-zinc-500 italic" style={{ fontSize: "0.75rem" }}>No TD configured</div>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )
          )}
        </>
      )}

      {/* ── MODALS ── */}
      {showPLModal && <PriceListModal
          priceList={editPL} products={products} parties={parties} groups={groups} saving={saving} setSaving={setSaving}
          onClose={() => setShowPLModal(false)} onSaved={() => { setShowPLModal(false); load(); }}
        />}
      {showTDModal && <TDModal
        config={editTD} parties={parties} saving={saving} setSaving={setSaving}
        onClose={() => setShowTDModal(false)} onSaved={() => { setShowTDModal(false); load(); }}
      />}

      {/* ── Delete Confirm Modal ── */}
      {deleteConfirm && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setDeleteConfirm(null)}>
          <div className="bg-[#ffffff] border border-black/[0.08] rounded-2xl w-full max-w-sm mx-4 p-6 shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-xl bg-red-500/10 border border-red-500/20 flex items-center justify-center shrink-0">
                <Trash2 className="w-5 h-5 text-red-400" />
              </div>
              <div>
                <h3 className="text-zinc-900 font-semibold" style={{ fontSize: "0.95rem" }}>
                  Delete {deleteConfirm.type === "pl" ? "Price List" : "Trade Discount"}
                </h3>
                <p className="text-zinc-500" style={{ fontSize: "0.75rem" }}>This action cannot be undone</p>
              </div>
            </div>
            <div className="mb-5 p-3 rounded-lg bg-black/[0.03] border border-black/[0.06]">
              <p className="text-zinc-900 font-medium" style={{ fontSize: "0.85rem" }}>{deleteConfirm.label}</p>
            </div>
            <div className="flex gap-3">
              <button onClick={() => setDeleteConfirm(null)}
                className="flex-1 px-4 py-2.5 rounded-lg border border-black/10 text-zinc-600 hover:bg-black/5 transition-all"
                style={{ fontSize: "0.8rem", fontFamily: "inherit", background: "none", cursor: "pointer" }}>
                Cancel
              </button>
              <button onClick={confirmDelete} disabled={deleting}
                className="flex-1 px-4 py-2.5 rounded-lg bg-red-500/20 border border-red-500/30 text-red-400 hover:bg-red-500/30 disabled:opacity-50 flex items-center justify-center gap-2 transition-all"
                style={{ fontSize: "0.8rem", fontFamily: "inherit", cursor: "pointer" }}>
                {deleting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
      </>
      )}
    </div>
  );
}

// ── Empty State ──
function EmptyState({ icon: Icon, message, sub, onAction, actionLabel }: { icon: React.ElementType; message: string; sub?: string; onAction?: () => void; actionLabel?: string }) {
  return (
    <div className="text-center py-20">
      <div className="w-16 h-16 rounded-2xl bg-black/[0.03] border border-black/[0.06] flex items-center justify-center mx-auto mb-4">
        <Icon className="w-8 h-8 text-zinc-600" />
      </div>
      <p className="text-zinc-600 font-medium" style={{ fontSize: "0.9rem" }}>{message}</p>
      {sub && <p className="text-zinc-600 mt-1" style={{ fontSize: "0.75rem" }}>{sub}</p>}
      {onAction && actionLabel && (
        <button onClick={onAction}
          className="mt-4 inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-amber-500/10 text-amber-400 border border-amber-500/30 hover:bg-amber-500/20 transition-colors"
          style={{ fontSize: "0.8rem", cursor: "pointer", fontFamily: "inherit" }}>
          <Plus className="w-4 h-4" /> {actionLabel}
        </button>
      )}
    </div>
  );
}

// ── Modal Wrapper ──
function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center pt-[5vh] px-4" onClick={onClose}>
      <div className="fixed inset-0 bg-black/60 backdrop-blur-sm" />
      <div className="relative w-full max-w-2xl bg-[#ffffff] border border-black/[0.08] rounded-2xl shadow-2xl max-h-[85vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}>
        <div className="sticky top-0 z-10 flex items-center justify-between p-5 border-b border-black/[0.06] bg-[#ffffff]">
          <h2 className="text-zinc-900 font-semibold" style={{ fontSize: "1rem", transform: "none" }}>{title}</h2>
          <button onClick={onClose} className="p-1.5 rounded-lg text-zinc-500 hover:text-zinc-900 hover:bg-black/10 transition-all"
            style={{ background: "none", border: "none", cursor: "pointer" }}>
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

// ── Form field helper ──
function Field({ label, children, required }: { label: string; children: React.ReactNode; required?: boolean }) {
  return (
    <div>
      <label className="block text-zinc-600 mb-1.5" style={{ fontSize: "0.75rem" }}>
        {label} {required && <span className="text-red-400">*</span>}
      </label>
      {children}
    </div>
  );
}

const inputCls = "w-full px-3 py-2.5 rounded-lg bg-black/[0.03] border border-black/[0.08] text-zinc-900 text-sm focus:outline-none focus:border-amber-500/40 placeholder:text-zinc-600";
const inputStyle: React.CSSProperties = { fontSize: "0.8rem", fontFamily: "inherit" };
const selectStyle: React.CSSProperties = { ...inputStyle, appearance: "none" as const };

// ── Price List Modal ──
function PriceListModal({ priceList, products, parties, groups, saving, setSaving, onClose, onSaved }: {
  priceList: PriceList | null; products: Product[]; parties: Party[]; groups: GroupOption[]; saving: boolean; setSaving: (v: boolean) => void; onClose: () => void; onSaved: () => void;
}) {
  const [name, setName] = useState(priceList?.name || "");
  const [code, setCode] = useState(priceList?.code || "");
  const [partyType, setPartyType] = useState(priceList?.applicable_party_type || "CNF");
  const [partyId, setPartyId] = useState(priceList?.party_id || "");
  const [groupId, setGroupId] = useState(priceList?.group_id || "");
  // A group price list can target the whole group, one party category within the
  // group, or a single member of the group. Derive the initial mode from the
  // saved row: a party_id ⇒ "party", a real party-type ⇒ "category", else "all".
  const [groupScope, setGroupScope] = useState<GroupScope>(
    priceList?.group_id
      ? (priceList.party_id ? "party" : (PARTY_TYPES.includes(priceList.applicable_party_type) ? "category" : "all"))
      : "all"
  );
  const [groupMembers, setGroupMembers] = useState<GroupMember[]>([]);
  const [groupMembersLoading, setGroupMembersLoading] = useState(false);
  const isGroupScoped = !!groupId;
  const [partySearch, setPartySearch] = useState(priceList?.parties ? `${priceList.parties.name} (${priceList.parties.party_code})` : "");
  const [partyDropOpen, setPartyDropOpen] = useState(false);
  const [validFrom, setValidFrom] = useState(priceList?.valid_from || today());
  const [validTo, setValidTo] = useState(priceList?.valid_to || "");
  const [isCurrent, setIsCurrent] = useState(priceList?.is_current ?? true);
  const [notes, setNotes] = useState(priceList?.notes || "");
  const [items, setItems] = useState<{ product_id: string; unit_price: string; min_margin_floor: string; max_margin_ceiling: string }[]>(
    priceList?.price_list_items?.map(i => ({
      product_id: i.product_id,
      unit_price: String(i.unit_price),
      min_margin_floor: i.min_margin_floor ? String(i.min_margin_floor) : "",
      max_margin_ceiling: i.max_margin_ceiling ? String(i.max_margin_ceiling) : "",
    })) || []
  );
  const [productSearches, setProductSearches] = useState<string[]>(
    priceList?.price_list_items?.map(i => {
      const p = products.find(p => p.id === i.product_id);
      return p ? `${p.name} (${p.sku})` : "";
    }) || []
  );
  const [productDropOpen, setProductDropOpen] = useState<number | null>(null);
  const [error, setError] = useState("");

  // Load the selected group's members so we can offer the categories present in the
  // group and a searchable per-member picker. Refetched whenever the group changes.
  useEffect(() => {
    if (!groupId) { setGroupMembers([]); return; }
    let cancelled = false;
    setGroupMembersLoading(true);
    api<{ success: boolean; data: { members?: GroupMember[] } }>(`/api/v1/groups/${groupId}`)
      .then(res => { if (!cancelled) setGroupMembers(res.data?.members || []); })
      .catch(() => { if (!cancelled) setGroupMembers([]); })
      .finally(() => { if (!cancelled) setGroupMembersLoading(false); });
    return () => { cancelled = true; };
  }, [groupId]);

  // Distinct party categories present in the group (e.g. ["CNF", "RETAILER"]).
  const groupCategories = [...new Set(
    groupMembers.map(m => m.party_types?.name).filter((n): n is string => !!n)
  )];

  const companyParties = parties.filter(p => {
    const partyName = p.name.toLowerCase();
    const partyCode = p.party_code.toLowerCase();
    const search = partySearch.toLowerCase();
    return !partySearch || partyName.includes(search) || partyCode.includes(search);
  });

  // Members of the selected group, filtered by the search box (used by the
  // "specific user within group" picker).
  const filteredGroupMembers = groupMembers.filter(p =>
    !partySearch || p.name.toLowerCase().includes(partySearch.toLowerCase()) || p.party_code.toLowerCase().includes(partySearch.toLowerCase())
  );

  const changeGroup = (value: string) => {
    setGroupId(value);
    setGroupScope("all");
    setPartyId(""); setPartySearch("");
    // Clearing the group reverts to type-based pricing — ensure a valid party type
    // is selected (an edited group list carries the "GROUP" sentinel).
    if (!value && !PARTY_TYPES.includes(partyType)) setPartyType("CNF");
  };

  const changeGroupScope = (scope: GroupScope) => {
    setGroupScope(scope);
    setPartyId(""); setPartySearch("");
    if (scope === "category" && !PARTY_TYPES.includes(partyType)) {
      setPartyType(groupCategories[0] || "CNF");
    }
  };

  const addItem = () => {
    setItems([...items, { product_id: "", unit_price: "", min_margin_floor: "", max_margin_ceiling: "" }]);
    setProductSearches([...productSearches, ""]);
  };
  const removeItem = (idx: number) => {
    setItems(items.filter((_, i) => i !== idx));
    setProductSearches(productSearches.filter((_, i) => i !== idx));
  };
  const updateItem = (idx: number, field: string, val: string) => {
    const next = [...items];
    (next[idx] as Record<string, string>)[field] = val;
    setItems(next);
  };
  const selectProduct = (idx: number, product: Product) => {
    updateItem(idx, "product_id", product.id);
    const ns = [...productSearches];
    ns[idx] = `${product.name} (${product.sku})`;
    setProductSearches(ns);
    setProductDropOpen(null);
  };
  const getFilteredProducts = (idx: number) => {
    const q = productSearches[idx]?.toLowerCase() || "";
    const usedProductIds = items.map(i => i.product_id);
    return products.filter(p =>
      (!q || p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q)) &&
      (!usedProductIds.includes(p.id) || items[idx].product_id === p.id)
    );
  };

  const save = async () => {
    setError("");
    if (!name.trim()) { setError("Name is required"); return; }
    if (!code.trim()) { setError("Code is required — enter a unique identifier e.g. PL-CNF-Q1-2026"); return; }
    if (isGroupScoped) {
      if (groupScope === "category" && !partyType) { setError("Choose a category within the group"); return; }
      if (groupScope === "party" && !partyId) { setError("Choose a user within the group"); return; }
    } else if (!partyType) { setError("Party Type is required"); return; }
    if (!validFrom) { setError("Valid From date is required"); return; }
    if (items.length === 0) { setError("Add at least one product"); return; }
    for (const item of items) {
      if (!item.product_id || !item.unit_price) { setError("Each product must have a price"); return; }
    }

    setSaving(true);
    try {
      // How the list resolves (see resolveApplicablePriceListId):
      //   - group + whole group   → applicable_party_type "GROUP", party_id null
      //   - group + category      → applicable_party_type = category, party_id null
      //   - group + specific user → party_id = member, applicable_party_type "GROUP"
      //   - no group              → applicable_party_type = type, party_id optional
      const applicablePartyType = isGroupScoped
        ? (groupScope === "category" ? partyType : "GROUP")
        : partyType;
      const resolvedPartyId = isGroupScoped
        ? (groupScope === "party" ? (partyId || null) : null)
        : (partyId || null);
      const payload = {
          name: name.trim(), code: code.trim(),
          applicable_party_type: applicablePartyType,
          party_id: resolvedPartyId,
          group_id: groupId || null,
          valid_from: validFrom,
        valid_to: validTo || null, is_current: isCurrent, notes: notes || null, status: "ACTIVE",
        items: items.map(i => ({
          product_id: i.product_id, unit_price: Number(i.unit_price),
          min_margin_floor: i.min_margin_floor ? Number(i.min_margin_floor) : null,
          max_margin_ceiling: i.max_margin_ceiling ? Number(i.max_margin_ceiling) : null,
          status: "ACTIVE",
        })),
      };

      if (priceList) {
        await api(`/api/v1/price-lists/${priceList.id}`, { method: "PUT", body: payload });
      } else {
        await api("/api/v1/price-lists", { method: "POST", body: payload });
      }
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    }
    setSaving(false);
  };

  return (
    <Modal title={priceList ? "Edit Price List" : "Create Price List"} onClose={onClose}>
      <div className="space-y-4">
        {error && (
          <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400" style={{ fontSize: "0.8rem" }}>
            <AlertCircle className="w-4 h-4 shrink-0" /> {error}
          </div>
        )}

        <div className="grid grid-cols-2 gap-4">
          <Field label="Name" required>
            <input value={name} onChange={e => setName(e.target.value)} className={inputCls} style={inputStyle} placeholder="CNF Price List Q1 2026" />
          </Field>
            <Field label="Code" required>
              <input value={code} onChange={e => setCode(e.target.value)} className={inputCls} style={inputStyle} placeholder="PL-CNF-Q1-2026" />
              <p className="text-zinc-400 mt-1" style={{ fontSize: "0.65rem" }}>Unique identifier code e.g. PL-CNF-Q1-2026</p>
            </Field>
        </div>

          {groups.length > 0 && (
            <Field label="Apply to Group (optional — overrides type/party for the group's members)">
              <div className="relative">
                <select value={groupId} onChange={e => changeGroup(e.target.value)} className={inputCls} style={selectStyle}>
                  <option value="" style={{ background: "#ffffff" }}>— Not a group price list —</option>
                  {groups.map(g => <option key={g.id} value={g.id} style={{ background: "#ffffff" }}>{g.name}</option>)}
                </select>
                <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500 pointer-events-none" />
              </div>
            </Field>
          )}

          {isGroupScoped && (
            <Field label="Apply within group">
              <div className="grid grid-cols-3 gap-2">
                {([
                  { key: "all", label: "Entire group", sub: "All members" },
                  { key: "category", label: "By category", sub: "One party type" },
                  { key: "party", label: "Specific user", sub: "One member" },
                ] as { key: GroupScope; label: string; sub: string }[]).map(opt => (
                  <button key={opt.key} type="button" onClick={() => changeGroupScope(opt.key)}
                    className={`flex flex-col items-start gap-0.5 px-3 py-2 rounded-lg border text-left transition-all ${groupScope === opt.key ? "border-amber-500/40 bg-amber-500/10" : "border-black/[0.08] bg-black/[0.02] hover:bg-black/[0.04]"}`}
                    style={{ cursor: "pointer", fontFamily: "inherit" }}>
                    <span className={groupScope === opt.key ? "text-amber-600" : "text-zinc-700"} style={{ fontSize: "0.78rem", fontWeight: 500 }}>{opt.label}</span>
                    <span className="text-zinc-500" style={{ fontSize: "0.62rem" }}>{opt.sub}</span>
                  </button>
                ))}
              </div>

              {groupScope === "all" && (
                <p className="text-amber-600 mt-2" style={{ fontSize: "0.65rem" }}>This price applies to every member of the group — CNF, Super Dealer or Retailer alike.</p>
              )}

              {groupScope === "category" && (
                <div className="mt-2">
                  {groupCategories.length === 0 ? (
                    <p className="text-zinc-500" style={{ fontSize: "0.7rem" }}>{groupMembersLoading ? "Loading categories…" : "This group has no members with a category yet."}</p>
                  ) : (
                    <>
                      <div className="relative">
                        <select value={PARTY_TYPES.includes(partyType) ? partyType : ""} onChange={e => setPartyType(e.target.value)} className={inputCls} style={selectStyle}>
                          <option value="" disabled style={{ background: "#ffffff" }}>Select a category…</option>
                          {groupCategories.map(c => <option key={c} value={c} style={{ background: "#ffffff" }}>{c.replace(/_/g, " ")}</option>)}
                        </select>
                        <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500 pointer-events-none" />
                      </div>
                      <p className="text-zinc-500 mt-1" style={{ fontSize: "0.62rem" }}>Only {PARTY_TYPES.includes(partyType) ? `${partyType.replace(/_/g, " ")} ` : ""}members of this group get this price.</p>
                    </>
                  )}
                </div>
              )}

              {groupScope === "party" && (
                <div className="mt-2 relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500 pointer-events-none" style={{ zIndex: 1 }} />
                  <input
                    value={partySearch}
                    onChange={e => { setPartySearch(e.target.value); setPartyId(""); setPartyDropOpen(true); }}
                    onFocus={() => setPartyDropOpen(true)}
                    onBlur={() => setTimeout(() => setPartyDropOpen(false), 150)}
                    placeholder="Search a member of this group by name or code..."
                    className={inputCls}
                    style={{ ...inputStyle, paddingLeft: "2.2rem" }}
                  />
                  {partyId && (
                    <button onClick={() => { setPartyId(""); setPartySearch(""); }}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-900"
                      style={{ background: "none", border: "none", cursor: "pointer", padding: 0 }}>
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                  {partyDropOpen && (
                    <div className="absolute z-20 top-full left-0 right-0 mt-1 rounded-lg border border-black/[0.08] bg-[#ffffff] shadow-2xl max-h-48 overflow-y-auto">
                      {filteredGroupMembers.slice(0, 50).map(p => (
                        <div key={p.id}
                          className={`px-3 py-2 cursor-pointer hover:bg-black/5 flex items-center justify-between gap-2 ${partyId === p.id ? "bg-amber-500/10 text-amber-400" : "text-zinc-700"}`}
                          style={{ fontSize: "0.8rem" }}
                          onMouseDown={() => { setPartyId(p.id); setPartySearch(`${p.name} (${p.party_code})`); setPartyDropOpen(false); }}>
                          <span>{p.name}</span>
                          <span className="text-zinc-500 font-mono shrink-0" style={{ fontSize: "0.68rem" }}>{p.party_types?.name ? `${p.party_types.name.replace(/_/g, " ")} · ` : ""}{p.party_code}</span>
                        </div>
                      ))}
                      {filteredGroupMembers.length === 0 && (
                        <div className="px-3 py-4 text-center text-zinc-500" style={{ fontSize: "0.75rem" }}>{groupMembersLoading ? "Loading members…" : "No members found"}</div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </Field>
          )}

          <div className="grid grid-cols-2 gap-4">

            <Field label="Valid From" required>
              <input type="date" value={validFrom} onChange={e => setValidFrom(e.target.value)} className={inputCls} style={inputStyle} />
            </Field>
            <Field label="Valid To">
              <div className="flex items-center gap-2">
                <input type="date" value={validTo} onChange={e => setValidTo(e.target.value)} className={inputCls} style={inputStyle} disabled={!validTo && isCurrent} />
                <label className="flex items-center gap-1.5 cursor-pointer whitespace-nowrap shrink-0">
                  <input type="checkbox" checked={!validTo} onChange={e => { if (e.target.checked) setValidTo(""); }}
                    className="w-4 h-4 rounded border-black/20 bg-black/5 text-amber-500 focus:ring-amber-500/30 accent-amber-500" />
                  <span className="text-zinc-600" style={{ fontSize: "0.7rem" }}>No Expiry</span>
                </label>
              </div>
            </Field>
          </div>

          <div className="flex items-center gap-4">
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={isCurrent} onChange={e => setIsCurrent(e.target.checked)}
              className="w-4 h-4 rounded border-black/20 bg-black/5 text-amber-500 focus:ring-amber-500/30" />
            <span className="text-zinc-700" style={{ fontSize: "0.8rem" }}>Mark as current (active) price list</span>
          </label>
        </div>

        <Field label="Notes">
          <textarea value={notes} onChange={e => setNotes(e.target.value)} className={inputCls} style={{ ...inputStyle, minHeight: "60px", resize: "vertical" }} placeholder="Optional notes..." />
        </Field>

        {/* Product prices */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Package className="w-4 h-4 text-amber-400" />
              <span className="text-zinc-900 font-medium" style={{ fontSize: "0.85rem" }}>Product Prices</span>
              <span className="px-1.5 py-0.5 rounded bg-black/5 text-zinc-600" style={{ fontSize: "0.65rem" }}>{items.length}</span>
            </div>
            <button onClick={addItem}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-black/5 text-zinc-700 hover:bg-black/10 text-sm transition-all"
              style={{ fontSize: "0.75rem", border: "none", cursor: "pointer", background: "rgba(17, 17, 24,0.05)", fontFamily: "inherit" }}>
              <Plus className="w-3.5 h-3.5" /> Add Product
            </button>
          </div>

            {items.length === 0 ? (
              <div className="rounded-lg border border-dashed border-black/10 p-8 text-center">
                <p className="text-zinc-500" style={{ fontSize: "0.8rem" }}>No products added yet. Click &quot;Add Product&quot; to set prices.</p>
              </div>
            ) : (
              <div className="space-y-2">
                {items.map((item, idx) => (
                  <div key={idx} className="flex items-center gap-2 p-3 rounded-lg bg-black/[0.02] border border-black/[0.04]">
                    <div className="flex-1 relative">
                      <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-500 pointer-events-none" style={{ zIndex: 1 }} />
                      <input
                        value={productSearches[idx] || ""}
                        onChange={e => {
                          const ns = [...productSearches]; ns[idx] = e.target.value;
                          setProductSearches(ns);
                          updateItem(idx, "product_id", "");
                          setProductDropOpen(idx);
                        }}
                        onFocus={() => setProductDropOpen(idx)}
                        onBlur={() => setTimeout(() => setProductDropOpen(v => v === idx ? null : v), 150)}
                        placeholder="Search product by name or SKU..."
                        className={inputCls}
                        style={{ ...inputStyle, fontSize: "0.75rem", paddingLeft: "2.2rem" }}
                      />
                      {item.product_id && (
                        <button onClick={() => { updateItem(idx, "product_id", ""); const ns = [...productSearches]; ns[idx] = ""; setProductSearches(ns); }}
                          className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-900"
                          style={{ background: "none", border: "none", cursor: "pointer", padding: 0 }}>
                          <X className="w-3.5 h-3.5" />
                        </button>
                      )}
                      {productDropOpen === idx && (
                        <div className="absolute z-30 top-full left-0 right-0 mt-1 rounded-lg border border-black/[0.08] bg-[#ffffff] shadow-2xl max-h-48 overflow-y-auto">
                          {getFilteredProducts(idx).length === 0 ? (
                            <div className="px-3 py-4 text-center text-zinc-500" style={{ fontSize: "0.75rem" }}>No products found</div>
                          ) : getFilteredProducts(idx).map(p => (
                            <div key={p.id}
                              className={`px-3 py-2 cursor-pointer hover:bg-black/5 flex items-center justify-between ${item.product_id === p.id ? "bg-amber-500/10 text-amber-400" : "text-zinc-700"}`}
                              style={{ fontSize: "0.78rem" }}
                              onMouseDown={() => selectProduct(idx, p)}>
                              <span>{p.name}</span>
                              <span className="text-zinc-500 font-mono ml-2 shrink-0" style={{ fontSize: "0.68rem" }}>{p.sku} — ₹{Number(p.base_price).toLocaleString("en-IN")}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="w-28">
                      <input value={item.unit_price} onChange={e => updateItem(idx, "unit_price", e.target.value)}
                        type="number" min="0" step="0.01" placeholder="Price" className={inputCls} style={{ ...inputStyle, fontSize: "0.75rem" }} />
                    </div>
                    <button onClick={() => removeItem(idx)} className="p-1.5 rounded text-zinc-500 hover:text-red-400 hover:bg-red-500/10"
                      style={{ background: "none", border: "none", cursor: "pointer" }}>
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
        </div>

        <div className="flex justify-end gap-3 pt-4 border-t border-black/[0.06]">
          <button onClick={onClose}
            className="px-4 py-2.5 rounded-lg border border-black/10 text-zinc-600 hover:text-zinc-900 hover:bg-black/5 transition-all"
            style={{ fontSize: "0.8rem", cursor: "pointer", background: "none", fontFamily: "inherit" }}>
            Cancel
          </button>
          <button onClick={save} disabled={saving}
            className="flex items-center gap-2 px-5 py-2.5 rounded-lg bg-amber-500 text-black font-medium hover:bg-amber-400 disabled:opacity-50 transition-all"
            style={{ fontSize: "0.8rem", cursor: "pointer", border: "none", fontFamily: "inherit" }}>
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
            {priceList ? "Update" : "Create"} Price List
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ── TD Modal ──
function TDModal({ config, parties, saving, setSaving, onClose, onSaved }: {
  config: TDConfig | null; parties: Party[]; saving: boolean; setSaving: (v: boolean) => void; onClose: () => void; onSaved: () => void;
}) {
    const [partyType, setPartyType] = useState(config?.applicable_party_type || "CNF");
    const [partyId, setPartyId] = useState(config?.party_id || "");
    const [partySearch, setPartySearch] = useState(config?.parties ? `${config.parties.name} (${config.parties.party_code})` : "");
    const [partyDropOpen, setPartyDropOpen] = useState(false);
    const [tdPercent, setTdPercent] = useState(config ? String(config.td_percent) : "");
    const [validFrom, setValidFrom] = useState(config?.valid_from || today());
    const [validTo, setValidTo] = useState(config?.valid_to || "");
    const [notes, setNotes] = useState(config?.notes || "");
    const [error, setError] = useState("");

    const filteredParties = parties.filter(p =>
      (p.party_types?.name === partyType) &&
      (!partySearch || p.name.toLowerCase().includes(partySearch.toLowerCase()) || p.party_code.toLowerCase().includes(partySearch.toLowerCase()))
    );

  const save = async () => {
    setError("");
    if (!partyType) { setError("Party Type is required"); return; }
    if (!tdPercent) { setError("TD Percentage is required"); return; }
    if (!validFrom) { setError("Valid From date is required"); return; }

    setSaving(true);
    try {
      const payload = {
        type: "td",
        applicable_party_type: partyType,
        party_id: partyId || null,
        td_percent: Number(tdPercent),
        valid_from: validFrom,
        valid_to: validTo || null,
        notes: notes || null,
        status: "ACTIVE",
        ...(config ? { id: config.id } : {}),
      };

      if (config) {
        await api("/api/v1/td-config", { method: "PUT", body: payload });
      } else {
        await api("/api/v1/td-config", { method: "POST", body: payload });
      }
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    }
    setSaving(false);
  };

  return (
    <Modal title={config ? "Edit Trade Discount" : "New Trade Discount"} onClose={onClose}>
      <div className="space-y-4">
        {error && (
          <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400" style={{ fontSize: "0.8rem" }}>
            <AlertCircle className="w-4 h-4 shrink-0" /> {error}
          </div>
        )}

        <div className="rounded-lg bg-blue-500/5 border border-blue-500/20 p-3" style={{ fontSize: "0.75rem" }}>
          <p className="text-blue-400">Set TD% for an entire party type, or override for a specific party.</p>
        </div>

          <Field label="Party Type" required>
            <div className="relative">
              <select value={partyType} onChange={e => { setPartyType(e.target.value); setPartyId(""); setPartySearch(""); }} className={inputCls} style={selectStyle}>
                {PARTY_TYPES.map(pt => <option key={pt} value={pt} style={{ background: "#ffffff" }}>{pt.replace(/_/g, " ")}</option>)}
              </select>
              <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500 pointer-events-none" />
            </div>
          </Field>

          <Field label={`Specific ${partyType.replace(/_/g, " ")} (optional — leave blank to apply to all)`}>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500 pointer-events-none" />
              <input
                value={partySearch}
                onChange={e => { setPartySearch(e.target.value); setPartyId(""); setPartyDropOpen(true); }}
                onFocus={() => setPartyDropOpen(true)}
                onBlur={() => setTimeout(() => setPartyDropOpen(false), 150)}
                placeholder={`Search ${partyType.replace(/_/g, " ")} by name or code...`}
                className={inputCls}
                style={{ ...inputStyle, paddingLeft: "2.2rem" }}
              />
              {partyId && (
                <button onClick={() => { setPartyId(""); setPartySearch(""); }}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-900"
                  style={{ background: "none", border: "none", cursor: "pointer", padding: 0 }}>
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
              {partyDropOpen && (
                <div className="absolute z-20 top-full left-0 right-0 mt-1 rounded-lg border border-black/[0.08] bg-[#ffffff] shadow-2xl max-h-48 overflow-y-auto">
                  <div
                    className="px-3 py-2 text-zinc-500 hover:bg-black/5 cursor-pointer"
                    style={{ fontSize: "0.75rem" }}
                    onMouseDown={() => { setPartyId(""); setPartySearch(""); setPartyDropOpen(false); }}>
                    All {partyType.replace(/_/g, " ")}s (apply to entire type)
                  </div>
                  {filteredParties.slice(0, 50).map(p => (
                    <div key={p.id}
                      className={`px-3 py-2 cursor-pointer hover:bg-black/5 flex items-center justify-between ${partyId === p.id ? "bg-amber-500/10 text-amber-400" : "text-zinc-700"}`}
                      style={{ fontSize: "0.8rem" }}
                      onMouseDown={() => { setPartyId(p.id); setPartySearch(`${p.name} (${p.party_code})`); setPartyDropOpen(false); }}>
                      <span>{p.name}</span>
                      <span className="text-zinc-500 font-mono" style={{ fontSize: "0.7rem" }}>{p.party_code}</span>
                    </div>
                  ))}
                  {filteredParties.length === 0 && (
                    <div className="px-3 py-4 text-center text-zinc-500" style={{ fontSize: "0.75rem" }}>No parties found</div>
                  )}
                </div>
              )}
            </div>
          </Field>

          <Field label="TD Percentage" required>
          <div className="relative">
            <input value={tdPercent} onChange={e => setTdPercent(e.target.value)}
              type="number" min="0" max="100" step="0.1" placeholder="e.g. 5.0"
              className={inputCls} style={inputStyle} />
            <Percent className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500 pointer-events-none" />
          </div>
        </Field>

        <div className="grid grid-cols-2 gap-4">
            <Field label="Valid From" required>
              <input type="date" value={validFrom} onChange={e => setValidFrom(e.target.value)} className={inputCls} style={inputStyle} />
            </Field>
            <Field label="Valid To">
              <div className="flex items-center gap-2">
                <input type="date" value={validTo} onChange={e => setValidTo(e.target.value)} className={inputCls} style={inputStyle} disabled={!validTo} />
                <label className="flex items-center gap-1.5 cursor-pointer whitespace-nowrap shrink-0">
                  <input type="checkbox" checked={!validTo} onChange={e => { if (e.target.checked) setValidTo(""); }}
                    className="w-4 h-4 rounded border-black/20 bg-black/5 text-amber-500 focus:ring-amber-500/30 accent-amber-500" />
                  <span className="text-zinc-600" style={{ fontSize: "0.7rem" }}>No Expiry</span>
                </label>
              </div>
            </Field>
          </div>

          <Field label="Notes">
            <textarea value={notes} onChange={e => setNotes(e.target.value)} className={inputCls} style={{ ...inputStyle, minHeight: "60px", resize: "vertical" }} placeholder="Optional notes..." />
          </Field>

          <div className="flex justify-end gap-3 pt-4 border-t border-black/[0.06]">
            <button onClick={onClose}
              className="px-4 py-2.5 rounded-lg border border-black/10 text-zinc-600 hover:text-zinc-900 hover:bg-black/5 transition-all"
              style={{ fontSize: "0.8rem", cursor: "pointer", background: "none", fontFamily: "inherit" }}>
              Cancel
            </button>
            <button onClick={save} disabled={saving}
              className="flex items-center gap-2 px-5 py-2.5 rounded-lg bg-amber-500 text-black font-medium hover:bg-amber-400 disabled:opacity-50 transition-all"
              style={{ fontSize: "0.8rem", cursor: "pointer", border: "none", fontFamily: "inherit" }}>
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
              {config ? "Update" : "Create"} TD Config
            </button>
          </div>
      </div>
    </Modal>
  );
}


