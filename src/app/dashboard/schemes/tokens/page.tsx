"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import {
  AlertCircle, CheckCircle2, ChevronDown, ChevronRight, Coins, Gift, Loader2,
  Package, Plus, Trash2, Wallet, X, XCircle,
} from "lucide-react";

interface TokenScheme {
  id: string;
  name: string;
  scheme_code: string;
  target_value: number;   // amount_per_token (₹X = 1 token)
  reward_value: number;   // tokens_per_unit (usually 1)
  applicable_party_type: string;
  start_date: string;
  end_date: string;
  status: string;
  slabs: TokenGift[] | null;
  reward_description: string | null;
  terms_conditions: string | null;
}

interface TokenScopeMeta {
  scope_mode: "CATEGORY" | "PARTY";
  selected_party_ids: string[];
  selected_party_types: string[];
}

interface PartyOption {
  id: string;
  name: string;
  party_code: string;
  party_types: { name: string } | null;
}

interface TokenGift {
  id: string;
  name: string;
  description: string;
  tokens_required: number;
  qty_available: number;
  status: "ACTIVE" | "INACTIVE";
}

interface PartyBalance {
  party_id: string;
  party_name: string;
  party_code: string;
  party_type: string | null;
  total_paid: number;
  tokens_earned: number;
}

interface Redemption {
  id: string;
  party_id: string;
  party_name: string;
  party_code: string;
  gift_id: string;
  gift_name: string;
  tokens_used: number;
  status: "PENDING" | "APPROVED" | "REJECTED";
  created_at: string;
}

const css: React.CSSProperties = { transform: "none", filter: "none", WebkitTextStroke: "0", background: "none", boxShadow: "none", display: "block", padding: 0 };
const fmt = (n: number) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(n);

const LS_REDEMPTIONS = "ht_token_redemptions";
function loadRedemptions(): Redemption[] {
  try { return JSON.parse(localStorage.getItem(LS_REDEMPTIONS) || "[]"); } catch { return []; }
}
function saveRedemptions(r: Redemption[]) {
  localStorage.setItem(LS_REDEMPTIONS, JSON.stringify(r));
}

export default function TokenRewardsPage() {
  const [schemes, setSchemes] = useState<TokenScheme[]>([]);
  const [selectedSchemeId, setSelectedSchemeId] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [balances, setBalances] = useState<PartyBalance[]>([]);
  const [balancesLoading, setBalancesLoading] = useState(false);
  const [redemptions, setRedemptions] = useState<Redemption[]>([]);
  const [tab, setTab] = useState<"gifts" | "balances" | "redemptions">("gifts");

  const defaultSetupForm = {
    name: "Token Rewards",
    amount_per_token: "1000",
    tokens_per_unit: "1",
    applicable_party_type: "RETAILER",
    start_date: "",
    end_date: "",
    scope_mode: "CATEGORY" as "CATEGORY" | "PARTY",
    selected_party_ids: [] as string[],
  };

  // Setup modal
  const [showSetup, setShowSetup] = useState(false);
  const [setupForm, setSetupForm] = useState(defaultSetupForm);
  const [partyOptions, setPartyOptions] = useState<PartyOption[]>([]);
  const [partyOptionsLoading, setPartyOptionsLoading] = useState(false);
  const [setupSaving, setSetupSaving] = useState(false);
  const [setupError, setSetupError] = useState("");
  const [deletingSchemeId, setDeletingSchemeId] = useState<string | null>(null);
  const [pageError, setPageError] = useState("");
  const [templateDropdownOpen, setTemplateDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setTemplateDropdownOpen(false);
      }
    }
    if (templateDropdownOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [templateDropdownOpen]);

  const categoryOptions = useMemo(() => {
    const fromParties = Array.from(new Set((partyOptions || []).map((p) => p.party_types?.name).filter(Boolean) as string[]));
    const base = ["CNF", "SUPER_DEALER", "RETAILER", "COMPANY", "MANUFACTURER"];
    return Array.from(new Set([...fromParties, ...base]));
  }, [partyOptions]);

  // Add gift modal
  const [showAddGift, setShowAddGift] = useState(false);
  const [giftForm, setGiftForm] = useState({ name: "", description: "", tokens_required: "", qty_available: "100" });
  const [giftSaving, setGiftSaving] = useState(false);
  const [giftError, setGiftError] = useState("");

  // Redeem modal
  const [redeemTarget, setRedeemTarget] = useState<PartyBalance | null>(null);
  const [redeemGiftId, setRedeemGiftId] = useState("");

  const scheme = useMemo(
    () => schemes.find((s) => s.id === selectedSchemeId) || schemes[0] || null,
    [schemes, selectedSchemeId]
  );

  // ── Load scheme ──────────────────────────────────────────────
  const loadScheme = useCallback(async () => {
    setLoading(true);
    setPageError("");
    try {
      const res = await api<{ success: boolean; data: TokenScheme[] }>("/api/v1/schemes?type=TOKEN_SCHEME&limit=100");
      const rows = res.data || [];
      setSchemes(rows);
      if (rows.length > 0) {
        const active = rows.find((s) => s.status === "ACTIVE") || rows[0];
        setSelectedSchemeId((prev) => (prev && rows.some((r) => r.id === prev) ? prev : active.id));
      } else {
        setSelectedSchemeId("");
      }
    } catch (err) {
      setSchemes([]);
      setSelectedSchemeId("");
      setPageError(err instanceof Error ? err.message : "Failed to load token templates");
    }
    setLoading(false);
  }, []);

  // ── Load balances ────────────────────────────────────────────
  const loadBalances = useCallback(async (s: TokenScheme) => {
    setBalancesLoading(true);
    try {
      const res = await api<{ success: boolean; data: PartyBalance[] }>(`/api/v1/tokens?scheme_id=${s.id}`);
      setBalances(res.data || []);
    } catch { setBalances([]); }
    setBalancesLoading(false);
  }, []);

  const loadPartyOptions = useCallback(async () => {
    setPartyOptionsLoading(true);
    try {
      const res = await api<{ success: boolean; data: PartyOption[] }>("/api/v1/parties?limit=500&is_verified=all");
      setPartyOptions(res.data || []);
    } catch {
      setPartyOptions([]);
    }
    setPartyOptionsLoading(false);
  }, []);

  useEffect(() => { loadScheme(); setRedemptions(loadRedemptions()); }, [loadScheme]);
  useEffect(() => { if (scheme) loadBalances(scheme); }, [scheme, loadBalances]);
  useEffect(() => {
    if (showSetup && partyOptions.length === 0) {
      loadPartyOptions();
    }
  }, [showSetup, partyOptions.length, loadPartyOptions]);

  // ── Derived: tokens redeemed per party (APPROVED only) ───────
  const redeemedByParty: Record<string, number> = {};
  for (const r of redemptions) {
    if (r.status === "APPROVED") redeemedByParty[r.party_id] = (redeemedByParty[r.party_id] || 0) + r.tokens_used;
  }

  const gifts: TokenGift[] = (scheme?.slabs && Array.isArray(scheme.slabs)) ? (scheme.slabs as TokenGift[]) : [];
  const scopeMeta = useMemo<TokenScopeMeta>(() => {
    const raw = scheme?.terms_conditions;
    if (!raw) return { scope_mode: "CATEGORY", selected_party_ids: [], selected_party_types: [] };
    try {
      const parsed = JSON.parse(raw) as Partial<TokenScopeMeta>;
      return {
        scope_mode: parsed.scope_mode === "PARTY" ? "PARTY" : "CATEGORY",
        selected_party_ids: Array.isArray(parsed.selected_party_ids) ? parsed.selected_party_ids : [],
        selected_party_types: Array.isArray(parsed.selected_party_types) ? parsed.selected_party_types : [],
      };
    } catch {
      return { scope_mode: "CATEGORY", selected_party_ids: [], selected_party_types: [] };
    }
  }, [scheme?.terms_conditions]);

  // ── Create scheme ─────────────────────────────────────────────
  async function handleSetup(e: React.FormEvent) {
    e.preventDefault();
    setSetupError("");

    if (setupForm.scope_mode === "PARTY" && setupForm.selected_party_ids.length === 0) {
      setSetupError("Please select at least one party for party-wise token scheme.");
      return;
    }

    setSetupSaving(true);
      try {
        const scopePayload: TokenScopeMeta = {
          scope_mode: setupForm.scope_mode,
          selected_party_ids: setupForm.scope_mode === "PARTY" ? setupForm.selected_party_ids : [],
          selected_party_types: setupForm.scope_mode === "CATEGORY" ? [setupForm.applicable_party_type] : [],
        };

        const body = {
          name: setupForm.name,
          scheme_type: "TOKEN_SCHEME",
          applicable_party_type: setupForm.applicable_party_type,
          start_date: setupForm.start_date,
          end_date: setupForm.end_date,
          target_value: parseFloat(setupForm.amount_per_token),
          reward_value: parseFloat(setupForm.tokens_per_unit),
          reward_description: `${setupForm.tokens_per_unit} token per ₹${setupForm.amount_per_token} paid`,
          terms_conditions: JSON.stringify(scopePayload),
          status: "ACTIVE",
          slabs: [],
        };
        const created = await api<{ success: boolean; data: TokenScheme }>("/api/v1/schemes", { method: "POST", body });
        setSelectedSchemeId(created.data.id);
        setShowSetup(false);
        setSetupForm(defaultSetupForm);
        await loadScheme();
      } catch (err) { setSetupError(err instanceof Error ? err.message : "Failed to create scheme"); }
    finally { setSetupSaving(false); }
  }

  async function handleDeleteScheme(targetId?: string) {
    const idToDelete = targetId || scheme?.id;
    if (!idToDelete || deletingSchemeId) return;
    const target = schemes.find((s) => s.id === idToDelete);

    const confirmed = window.confirm(
      `Delete token template "${target?.name || "this template"}"? This will remove all gift setup for this template.`
    );
    if (!confirmed) return;

    setDeletingSchemeId(idToDelete);
    setPageError("");
    try {
      await api(`/api/v1/schemes?id=${idToDelete}`, { method: "DELETE" });
      await loadScheme();
    } catch (err) {
      setPageError(err instanceof Error ? err.message : "Failed to delete template");
    } finally {
      setDeletingSchemeId(null);
    }
  }

  // ── Add gift ──────────────────────────────────────────────────
  async function handleAddGift(e: React.FormEvent) {
    e.preventDefault();
    if (!scheme) return;
    setGiftError(""); setGiftSaving(true);
    try {
      const newGift: TokenGift = {
        id: `gift_${Date.now().toString(36)}`,
        name: giftForm.name,
        description: giftForm.description,
        tokens_required: parseInt(giftForm.tokens_required),
        qty_available: parseInt(giftForm.qty_available),
        status: "ACTIVE",
      };
      const updatedGifts = [...gifts, newGift];
      await api("/api/v1/schemes", { method: "PATCH", body: { id: scheme.id, slabs: updatedGifts } });
      setGiftForm({ name: "", description: "", tokens_required: "", qty_available: "100" });
      setShowAddGift(false);
      await loadScheme();
    } catch (err) { setGiftError(err instanceof Error ? err.message : "Failed to add gift"); }
    finally { setGiftSaving(false); }
  }

  // ── Delete gift ───────────────────────────────────────────────
  async function handleDeleteGift(giftId: string) {
    if (!scheme) return;
    const updatedGifts = gifts.filter(g => g.id !== giftId);
    try {
      await api("/api/v1/schemes", { method: "PATCH", body: { id: scheme.id, slabs: updatedGifts } });
      await loadScheme();
    } catch { /* ignore */ }
  }

  // ── Redeem ─────────────────────────────────────────────────────
  function handleRedeem() {
    if (!redeemTarget || !redeemGiftId) return;
    const gift = gifts.find(g => g.id === redeemGiftId);
    if (!gift) return;
    const newRedemption: Redemption = {
      id: `rdm_${Date.now().toString(36)}`,
      party_id: redeemTarget.party_id,
      party_name: redeemTarget.party_name,
      party_code: redeemTarget.party_code,
      gift_id: gift.id,
      gift_name: gift.name,
      tokens_used: gift.tokens_required,
      status: "PENDING",
      created_at: new Date().toISOString(),
    };
    const updated = [...redemptions, newRedemption];
    saveRedemptions(updated);
    setRedemptions(updated);
    setRedeemTarget(null);
    setRedeemGiftId("");
    setTab("redemptions");
  }

  // ── Approve / Reject ──────────────────────────────────────────
  function updateRedemptionStatus(id: string, status: "APPROVED" | "REJECTED") {
    const updated = redemptions.map(r => r.id === id ? { ...r, status } : r);
    saveRedemptions(updated);
    setRedemptions(updated);
  }

  const pendingCount = redemptions.filter(r => r.status === "PENDING").length;

  // ─────────────────────────────────────────────────────────────
  if (loading) {
    return <div className="flex items-center justify-center py-20"><Loader2 className="w-8 h-8 text-amber-500 animate-spin" /></div>;
  }

  return (
      <div style={{ fontFamily: "'Inter','system-ui',sans-serif" }}>
        {/* Header */}
        <div className="flex items-start justify-between mb-6 gap-3">
          <div>
            <h1 className="text-2xl font-bold text-zinc-900" style={{ ...css, fontSize: "1.5rem", marginBottom: "0.25rem" }}>
              Token Rewards
            </h1>
            <p className="text-zinc-500" style={{ fontSize: "0.8rem", margin: 0 }}>
              {scheme
                ? `${scheme.name} · ₹${Number(scheme.target_value).toLocaleString("en-IN")} = ${scheme.reward_value} token`
                : "Configure a token earning scheme for your parties"}
            </p>
            {scheme && (
              <p className="text-zinc-500 mt-1" style={{ fontSize: "0.7rem", margin: 0 }}>
                Scope: {scopeMeta.scope_mode === "PARTY"
                  ? `Party-wise (${scopeMeta.selected_party_ids.length} selected)`
                  : `Category-wise (${(scopeMeta.selected_party_types[0] || scheme.applicable_party_type).replace(/_/g, " ")})`}
              </p>
            )}
          </div>

            <div className="flex items-center gap-2">
              {schemes.length > 0 && (
                <div className="relative" ref={dropdownRef}>
                  <button
                    onClick={() => setTemplateDropdownOpen((v) => !v)}
                    className="flex items-center gap-2 px-3 py-2 rounded-lg border border-black/10 bg-white text-zinc-900 hover:border-amber-500/40 transition-all"
                    style={{ fontSize: "0.75rem", fontFamily: "inherit", cursor: "pointer", minWidth: "200px" }}
                  >
                    <Coins className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                    <span className="truncate flex-1 text-left">
                      {scheme
                        ? `${(scheme.applicable_party_type || "ALL").replace(/_/g, " ")} · ₹${Number(scheme.target_value).toLocaleString("en-IN")} = ${scheme.reward_value}`
                        : "Select Template"}
                    </span>
                    <ChevronDown className={`w-3.5 h-3.5 text-zinc-400 transition-transform ${templateDropdownOpen ? "rotate-180" : ""}`} />
                  </button>

                  {templateDropdownOpen && (
                    <div
                      className="absolute right-0 top-full mt-1.5 w-80 rounded-xl border border-black/10 bg-white shadow-xl z-50 overflow-hidden"
                      style={{ fontFamily: "inherit" }}
                    >
                      <div className="px-3 py-2 border-b border-black/[0.06] bg-black/[0.02]">
                        <p className="text-zinc-500 font-medium" style={{ fontSize: "0.65rem", textTransform: "uppercase", letterSpacing: "0.05em", margin: 0 }}>
                          All Templates ({schemes.length})
                        </p>
                      </div>
                      <div className="max-h-64 overflow-y-auto">
                        {schemes.map((s) => {
                          const labelType = (s.applicable_party_type || "ALL").replace(/_/g, " ");
                          const isSelected = s.id === selectedSchemeId;
                          const isDeleting = deletingSchemeId === s.id;
                          return (
                            <div
                              key={s.id}
                              className={`flex items-center gap-2 px-3 py-2.5 border-b border-black/[0.04] last:border-b-0 transition-all ${
                                isSelected ? "bg-amber-500/[0.08]" : "hover:bg-black/[0.03]"
                              }`}
                            >
                              <button
                                onClick={() => { setSelectedSchemeId(s.id); setTemplateDropdownOpen(false); }}
                                className="flex-1 text-left flex items-center gap-2.5 min-w-0"
                                style={{ background: "none", border: "none", cursor: "pointer", padding: 0, fontFamily: "inherit" }}
                              >
                                <div className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${
                                  isSelected ? "bg-amber-500/20" : "bg-black/[0.04]"
                                }`}>
                                  <Coins className={`w-3.5 h-3.5 ${isSelected ? "text-amber-500" : "text-zinc-400"}`} />
                                </div>
                                <div className="min-w-0">
                                  <div className={`font-medium truncate ${isSelected ? "text-amber-600" : "text-zinc-900"}`} style={{ fontSize: "0.78rem" }}>
                                    {s.name}
                                  </div>
                                  <div className="text-zinc-500 truncate" style={{ fontSize: "0.65rem" }}>
                                    {labelType} · ₹{Number(s.target_value).toLocaleString("en-IN")} = {s.reward_value} token
                                  </div>
                                </div>
                              </button>
                              <button
                                onClick={(e) => { e.stopPropagation(); handleDeleteScheme(s.id); }}
                                disabled={isDeleting}
                                className="p-1.5 rounded-lg text-zinc-400 hover:text-red-500 hover:bg-red-500/10 disabled:opacity-50 transition-all shrink-0"
                                style={{ background: "none", border: "none", cursor: isDeleting ? "not-allowed" : "pointer" }}
                                title={`Delete "${s.name}"`}
                              >
                                {isDeleting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              )}
              <button

              onClick={() => {
                setSetupError("");
                setSetupForm({
                  ...defaultSetupForm,
                  name: scheme ? `${scheme.name} (${(scheme.applicable_party_type || "CATEGORY").replace(/_/g, " ")})` : defaultSetupForm.name,
                  amount_per_token: scheme ? String(scheme.target_value || 1000) : defaultSetupForm.amount_per_token,
                  tokens_per_unit: scheme ? String(scheme.reward_value || 1) : defaultSetupForm.tokens_per_unit,
                  start_date: scheme?.start_date || defaultSetupForm.start_date,
                  end_date: scheme?.end_date || defaultSetupForm.end_date,
                });
                setShowSetup(true);
              }}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-amber-500 text-zinc-900 hover:bg-amber-600 transition-all"
              style={{ fontSize: "0.8rem", fontFamily: "inherit", border: "none", cursor: "pointer" }}>
              <Plus className="w-4 h-4" /> {scheme ? "Add Another Category" : "Setup Token Scheme"}
            </button>
          </div>
        </div>

        {pageError && (
          <div className="mb-4 p-3 rounded-lg bg-red-500/10 border border-red-500/20 flex items-center gap-2 text-red-500" style={{ fontSize: "0.8rem" }}>
            <AlertCircle className="w-4 h-4 shrink-0" />
            {pageError}
          </div>
        )}

        {/* No scheme empty state */}
        {!scheme && (

        <div className="flex flex-col items-center justify-center py-24 gap-5 text-center">
          <div className="w-20 h-20 rounded-2xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center">
            <Coins className="w-10 h-10 text-amber-400" />
          </div>
          <div>
            <h2 className="text-zinc-900 font-bold text-lg" style={css}>No Token Scheme Configured</h2>
            <p className="text-zinc-500 mt-1" style={{ fontSize: "0.85rem" }}>
              Set up a token earning rate and define gifts your parties can redeem.
            </p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 max-w-2xl w-full mt-2">
            {[
              { icon: Wallet, label: "Define Rate", desc: "Set how many tokens per ₹ paid" },
              { icon: Gift, label: "Add Gifts", desc: "Configure what tokens can be redeemed for" },
              { icon: CheckCircle2, label: "Auto-Earn", desc: "Tokens credited on every payment" },
            ].map(({ icon: Icon, label, desc }) => (
              <div key={label} className="rounded-xl border border-black/[0.06] bg-white p-4 text-left">
                <div className="w-9 h-9 rounded-lg bg-amber-500/10 flex items-center justify-center mb-3">
                  <Icon className="w-4.5 h-4.5 text-amber-500" />
                </div>
                <div className="text-zinc-900 font-medium" style={{ fontSize: "0.82rem" }}>{label}</div>
                <div className="text-zinc-500 mt-0.5" style={{ fontSize: "0.72rem" }}>{desc}</div>
              </div>
            ))}
          </div>
          <button
            onClick={() => setShowSetup(true)}
            className="flex items-center gap-2 px-6 py-2.5 rounded-xl bg-amber-500 text-zinc-900 hover:bg-amber-600 transition-all font-medium"
            style={{ fontSize: "0.85rem", fontFamily: "inherit", border: "none", cursor: "pointer" }}>
            <Coins className="w-4 h-4" /> Setup Token Scheme
          </button>
        </div>
      )}

      {/* Active scheme */}
      {scheme && (
        <>
          {/* Summary cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
            {[
              { label: "Earning Rate", value: `₹${Number(scheme.target_value).toLocaleString("en-IN")} = ${scheme.reward_value} token` },
              { label: "Gifts Available", value: gifts.filter(g => g.status === "ACTIVE").length.toString() },
              { label: "Parties Earning", value: balancesLoading ? "..." : balances.length.toString() },
              { label: "Pending Redemptions", value: pendingCount.toString(), highlight: pendingCount > 0 },
            ].map(c => (
              <div key={c.label} className={`rounded-xl border bg-white p-4 ${c.highlight ? "border-amber-500/30" : "border-black/[0.06]"}`}>
                <div className="text-zinc-500 mb-1" style={{ fontSize: "0.7rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>{c.label}</div>
                <div className={`font-bold ${c.highlight ? "text-amber-500" : "text-zinc-900"}`} style={{ fontSize: "1.2rem" }}>{c.value}</div>
              </div>
            ))}
          </div>

          {/* Tabs */}
          <div className="flex gap-1 mb-5 border-b border-black/[0.06]">
            {(["gifts", "balances", "redemptions"] as const).map(t => (
              <button key={t} onClick={() => setTab(t)}
                className={`px-4 py-2.5 text-sm font-medium transition-all border-b-2 -mb-px capitalize relative ${tab === t ? "border-amber-500 text-amber-500" : "border-transparent text-zinc-500 hover:text-zinc-900"}`}
                style={{ background: "none", fontFamily: "inherit", cursor: "pointer" }}>
                {t === "redemptions" ? "Redemptions" : t === "balances" ? "Party Balances" : "Gifts Catalog"}
                {t === "redemptions" && pendingCount > 0 && (
                  <span className="ml-1.5 inline-flex items-center justify-center w-4 h-4 rounded-full bg-amber-500 text-zinc-900 text-[0.55rem] font-bold">{pendingCount}</span>
                )}
              </button>
            ))}
          </div>

          {/* ── GIFTS TAB ── */}
          {tab === "gifts" && (
            <div>
              <div className="flex items-center justify-between mb-4">
                <p className="text-zinc-500" style={{ fontSize: "0.8rem" }}>{gifts.length} gift{gifts.length !== 1 ? "s" : ""} in catalog</p>
                <button onClick={() => setShowAddGift(true)}
                  className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-amber-500 text-zinc-900 hover:bg-amber-600 transition-all"
                  style={{ fontSize: "0.75rem", fontFamily: "inherit", border: "none", cursor: "pointer" }}>
                  <Plus className="w-3.5 h-3.5" /> Add Gift
                </button>
              </div>
              {gifts.length === 0 ? (
                <div className="text-center py-16 text-zinc-500">
                  <Gift className="w-10 h-10 mx-auto mb-3 opacity-30" />
                  <p style={{ fontSize: "0.85rem" }}>No gifts added yet</p>
                  <p style={{ fontSize: "0.75rem" }} className="mt-1">Add gifts that parties can redeem their tokens for.</p>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                  {gifts.map(gift => (
                    <div key={gift.id} className="rounded-xl border border-black/[0.06] bg-white p-5">
                      <div className="flex items-start justify-between mb-3">
                        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-purple-500/20 to-purple-500/5 flex items-center justify-center shrink-0">
                          <Package className="w-5 h-5 text-purple-400" />
                        </div>
                        <div className="flex items-center gap-2">
                          <span className={`px-2 py-0.5 rounded text-[0.6rem] font-medium ${gift.status === "ACTIVE" ? "bg-emerald-500/20 text-emerald-400" : "bg-zinc-500/20 text-zinc-500"}`}>
                            {gift.status}
                          </span>
                          <button onClick={() => handleDeleteGift(gift.id)}
                            className="p-1 rounded text-zinc-400 hover:text-red-400 hover:bg-red-500/10 transition-all"
                            style={{ background: "none", border: "none", cursor: "pointer" }}>
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                      <h3 className="text-zinc-900 font-semibold mb-1" style={{ fontSize: "0.9rem" }}>{gift.name}</h3>
                      {gift.description && <p className="text-zinc-500 mb-3" style={{ fontSize: "0.75rem" }}>{gift.description}</p>}
                      <div className="flex items-center justify-between pt-3 border-t border-black/[0.04]">
                        <div className="flex items-center gap-1.5">
                          <Coins className="w-3.5 h-3.5 text-amber-500" />
                          <span className="text-amber-500 font-bold" style={{ fontSize: "0.85rem" }}>{gift.tokens_required} tokens</span>
                        </div>
                        <span className="text-zinc-500" style={{ fontSize: "0.7rem" }}>Qty: {gift.qty_available}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ── BALANCES TAB ── */}
          {tab === "balances" && (
            <div>
              {balancesLoading ? (
                <div className="flex items-center justify-center py-20"><Loader2 className="w-7 h-7 text-amber-500 animate-spin" /></div>
              ) : balances.length === 0 ? (
                <div className="text-center py-16 text-zinc-500">
                  <Wallet className="w-10 h-10 mx-auto mb-3 opacity-30" />
                  <p style={{ fontSize: "0.85rem" }}>No payments recorded in this scheme period yet</p>
                </div>
              ) : (
                <div className="rounded-xl border border-black/[0.06] overflow-hidden">
                  <table className="w-full" style={{ borderCollapse: "collapse" }}>
                    <thead>
                      <tr className="border-b border-black/[0.06]">
                        {["Party", "Total Paid", "Earned", "Redeemed", "Available", ""].map(h => (
                          <th key={h} className="text-left px-4 py-3 text-zinc-500 bg-black/[0.02]"
                            style={{ fontSize: "0.65rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {balances.map(b => {
                        const redeemed = redeemedByParty[b.party_id] || 0;
                        const available = Math.max(0, b.tokens_earned - redeemed);
                        const hasGifts = gifts.some(g => g.status === "ACTIVE" && g.tokens_required <= available);
                        return (
                          <tr key={b.party_id} className="border-b border-black/[0.04] hover:bg-black/[0.02]">
                            <td className="px-4 py-3">
                              <div className="text-zinc-900 font-medium" style={{ fontSize: "0.82rem" }}>{b.party_name}</div>
                              <div className="text-zinc-500 font-mono" style={{ fontSize: "0.65rem" }}>{b.party_code}</div>
                            </td>
                            <td className="px-4 py-3 text-zinc-700 font-mono" style={{ fontSize: "0.8rem" }}>{fmt(b.total_paid)}</td>
                            <td className="px-4 py-3">
                              <div className="flex items-center gap-1">
                                <Coins className="w-3 h-3 text-amber-500" />
                                <span className="text-amber-500 font-bold" style={{ fontSize: "0.85rem" }}>{b.tokens_earned}</span>
                              </div>
                            </td>
                            <td className="px-4 py-3 text-zinc-500 font-mono" style={{ fontSize: "0.8rem" }}>{redeemed}</td>
                            <td className="px-4 py-3">
                              <span className={`font-bold font-mono ${available > 0 ? "text-emerald-500" : "text-zinc-400"}`} style={{ fontSize: "0.85rem" }}>{available}</span>
                            </td>
                            <td className="px-4 py-3">
                              {hasGifts && gifts.length > 0 && (
                                <button
                                  onClick={() => { setRedeemTarget(b); setRedeemGiftId(""); }}
                                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-purple-500/10 text-purple-400 hover:bg-purple-500/20 transition-all"
                                  style={{ fontSize: "0.72rem", fontFamily: "inherit", border: "none", cursor: "pointer" }}>
                                  <Gift className="w-3.5 h-3.5" /> Redeem
                                </button>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* ── REDEMPTIONS TAB ── */}
          {tab === "redemptions" && (
            <div>
              {redemptions.length === 0 ? (
                <div className="text-center py-16 text-zinc-500">
                  <ChevronRight className="w-10 h-10 mx-auto mb-3 opacity-30" />
                  <p style={{ fontSize: "0.85rem" }}>No redemption requests yet</p>
                </div>
              ) : (
                <div className="rounded-xl border border-black/[0.06] overflow-hidden">
                  <table className="w-full" style={{ borderCollapse: "collapse" }}>
                    <thead>
                      <tr className="border-b border-black/[0.06]">
                        {["Party", "Gift", "Tokens", "Status", "Date", ""].map(h => (
                          <th key={h} className="text-left px-4 py-3 text-zinc-500 bg-black/[0.02]"
                            style={{ fontSize: "0.65rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {redemptions.slice().reverse().map(r => (
                        <tr key={r.id} className="border-b border-black/[0.04] hover:bg-black/[0.02]">
                          <td className="px-4 py-3">
                            <div className="text-zinc-900 font-medium" style={{ fontSize: "0.82rem" }}>{r.party_name}</div>
                            <div className="text-zinc-500 font-mono" style={{ fontSize: "0.65rem" }}>{r.party_code}</div>
                          </td>
                          <td className="px-4 py-3 text-zinc-700" style={{ fontSize: "0.8rem" }}>{r.gift_name}</td>
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-1">
                              <Coins className="w-3 h-3 text-amber-500" />
                              <span className="text-amber-500 font-medium" style={{ fontSize: "0.8rem" }}>{r.tokens_used}</span>
                            </div>
                          </td>
                          <td className="px-4 py-3">
                            <span className={`px-2 py-0.5 rounded text-[0.6rem] font-medium ${r.status === "APPROVED" ? "bg-emerald-500/20 text-emerald-400" : r.status === "REJECTED" ? "bg-red-500/20 text-red-400" : "bg-amber-500/20 text-amber-400"}`}>
                              {r.status}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-zinc-500" style={{ fontSize: "0.75rem" }}>
                            {new Date(r.created_at).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "2-digit" })}
                          </td>
                          <td className="px-4 py-3">
                            {r.status === "PENDING" && (
                              <div className="flex items-center gap-1.5">
                                <button onClick={() => updateRedemptionStatus(r.id, "APPROVED")}
                                  className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 transition-all"
                                  style={{ fontSize: "0.65rem", fontFamily: "inherit", border: "none", cursor: "pointer" }}>
                                  <CheckCircle2 className="w-3 h-3" /> Approve
                                </button>
                                <button onClick={() => updateRedemptionStatus(r.id, "REJECTED")}
                                  className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-all"
                                  style={{ fontSize: "0.65rem", fontFamily: "inherit", border: "none", cursor: "pointer" }}>
                                  <XCircle className="w-3 h-3" /> Reject
                                </button>
                              </div>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </>
      )}

      {/* ── SETUP MODAL ── */}
      {showSetup && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setShowSetup(false)}>
          <div className="bg-white border border-black/10 rounded-2xl w-full max-w-lg mx-4 p-6" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-5">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl bg-amber-500/10 flex items-center justify-center">
                  <Coins className="w-4.5 h-4.5 text-amber-500" />
                </div>
                <div>
                  <h2 className="text-zinc-900 font-bold" style={{ ...css, fontSize: "1rem" }}>Setup Token Scheme</h2>
                  <p className="text-zinc-500" style={{ fontSize: "0.72rem", margin: 0 }}>Define how tokens are earned on payments</p>
                </div>
              </div>
              <button onClick={() => setShowSetup(false)} className="text-zinc-400 hover:text-zinc-900" style={{ background: "none", border: "none", cursor: "pointer" }}><X className="w-5 h-5" /></button>
            </div>
            {setupError && (
              <div className="mb-4 p-3 rounded-lg bg-red-500/10 border border-red-500/20 flex items-center gap-2 text-red-400" style={{ fontSize: "0.8rem" }}>
                <AlertCircle className="w-4 h-4 shrink-0" />{setupError}
              </div>
            )}
            <form onSubmit={handleSetup} className="space-y-4">
              <div>
                <label className="block text-zinc-600 mb-1" style={{ fontSize: "0.75rem" }}>Scheme Name *</label>
                <input required value={setupForm.name} onChange={e => setSetupForm({ ...setupForm, name: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg border border-black/10 bg-black/[0.03] text-zinc-900 outline-none focus:border-amber-500/40"
                  style={{ fontSize: "0.8rem", fontFamily: "inherit" }} />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-zinc-600 mb-1" style={{ fontSize: "0.75rem" }}>Amount per Token (₹) *</label>
                  <input required type="number" min="1" value={setupForm.amount_per_token}
                    onChange={e => setSetupForm({ ...setupForm, amount_per_token: e.target.value })}
                    className="w-full px-3 py-2 rounded-lg border border-black/10 bg-black/[0.03] text-zinc-900 outline-none focus:border-amber-500/40"
                    style={{ fontSize: "0.8rem", fontFamily: "inherit" }} placeholder="1000" />
                  <p className="text-zinc-400 mt-1" style={{ fontSize: "0.65rem" }}>For every ₹{setupForm.amount_per_token || "X"} paid → {setupForm.tokens_per_unit || "1"} token</p>
                </div>
                <div>
                  <label className="block text-zinc-600 mb-1" style={{ fontSize: "0.75rem" }}>Tokens per Unit</label>
                  <input type="number" min="1" value={setupForm.tokens_per_unit}
                    onChange={e => setSetupForm({ ...setupForm, tokens_per_unit: e.target.value })}
                    className="w-full px-3 py-2 rounded-lg border border-black/10 bg-black/[0.03] text-zinc-900 outline-none focus:border-amber-500/40"
                    style={{ fontSize: "0.8rem", fontFamily: "inherit" }} placeholder="1" />
                </div>
              </div>
                <div>
                  <label className="block text-zinc-600 mb-2" style={{ fontSize: "0.75rem" }}>Apply Tokens By *</label>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => setSetupForm(prev => ({ ...prev, scope_mode: "CATEGORY", selected_party_ids: [] }))}
                      className={`px-3 py-2 rounded-lg border text-left transition-all ${setupForm.scope_mode === "CATEGORY" ? "border-amber-500/40 bg-amber-500/10" : "border-black/10 bg-black/[0.02]"}`}
                      style={{ fontSize: "0.75rem", fontFamily: "inherit", cursor: "pointer" }}
                    >
                      <div className="text-zinc-900 font-medium">Category-wise</div>
                      <div className="text-zinc-500" style={{ fontSize: "0.65rem" }}>CNF, Super Dealer, Retailer</div>
                    </button>
                    <button
                      type="button"
                      onClick={() => setSetupForm(prev => ({ ...prev, scope_mode: "PARTY" }))}
                      className={`px-3 py-2 rounded-lg border text-left transition-all ${setupForm.scope_mode === "PARTY" ? "border-amber-500/40 bg-amber-500/10" : "border-black/10 bg-black/[0.02]"}`}
                      style={{ fontSize: "0.75rem", fontFamily: "inherit", cursor: "pointer" }}
                    >
                      <div className="text-zinc-900 font-medium">Party-wise</div>
                      <div className="text-zinc-500" style={{ fontSize: "0.65rem" }}>Select exact parties</div>
                    </button>
                  </div>
                </div>

                {setupForm.scope_mode === "CATEGORY" ? (
                  <div>
                    <label className="block text-zinc-600 mb-1" style={{ fontSize: "0.75rem" }}>Party Category *</label>
                    <select value={setupForm.applicable_party_type}
                      onChange={e => setSetupForm({ ...setupForm, applicable_party_type: e.target.value })}
                      className="w-full px-3 py-2 rounded-lg border border-black/10 bg-white text-zinc-900 outline-none focus:border-amber-500/40"
                      style={{ fontSize: "0.8rem", fontFamily: "inherit" }}>
                      {categoryOptions.map((t) => <option key={t} value={t}>{t.replace(/_/g, " ")}</option>)}
                    </select>
                  </div>
                ) : (
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="block text-zinc-600" style={{ fontSize: "0.75rem" }}>Select Parties *</label>
                      <button
                        type="button"
                        onClick={loadPartyOptions}
                        className="text-amber-500 hover:text-amber-600"
                        style={{ fontSize: "0.68rem", background: "none", border: "none", cursor: "pointer" }}
                      >
                        Refresh
                      </button>
                    </div>
                    <div className="max-h-40 overflow-y-auto rounded-lg border border-black/10 bg-black/[0.02] p-2 space-y-1">
                      {partyOptionsLoading ? (
                        <div className="flex items-center justify-center py-6 text-zinc-500" style={{ fontSize: "0.72rem" }}>
                          <Loader2 className="w-3.5 h-3.5 animate-spin mr-2" /> Loading parties...
                        </div>
                      ) : partyOptions.length === 0 ? (
                        <div className="text-zinc-500 py-4 text-center" style={{ fontSize: "0.72rem" }}>No parties found</div>
                      ) : (
                        partyOptions.map(party => {
                          const checked = setupForm.selected_party_ids.includes(party.id);
                          return (
                            <label key={party.id} className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-black/[0.03] cursor-pointer">
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={(e) => {
                                  setSetupForm(prev => ({
                                    ...prev,
                                    selected_party_ids: e.target.checked
                                      ? [...prev.selected_party_ids, party.id]
                                      : prev.selected_party_ids.filter(id => id !== party.id),
                                  }));
                                }}
                              />
                              <div className="min-w-0">
                                <div className="text-zinc-900" style={{ fontSize: "0.75rem" }}>{party.name}</div>
                                <div className="text-zinc-500 font-mono" style={{ fontSize: "0.65rem" }}>
                                  {party.party_code} {party.party_types?.name ? `· ${party.party_types.name}` : ""}
                                </div>
                              </div>
                            </label>
                          );
                        })
                      )}
                    </div>
                    <p className="text-zinc-500 mt-1" style={{ fontSize: "0.65rem" }}>
                      {setupForm.selected_party_ids.length} party{setupForm.selected_party_ids.length !== 1 ? "ies" : ""} selected
                    </p>
                  </div>
                )}

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-zinc-600 mb-1" style={{ fontSize: "0.75rem" }}>Start Date *</label>
                    <input required type="date" value={setupForm.start_date}
                      onChange={e => setSetupForm({ ...setupForm, start_date: e.target.value })}
                      className="w-full px-3 py-2 rounded-lg border border-black/10 bg-black/[0.03] text-zinc-900 outline-none focus:border-amber-500/40"
                      style={{ fontSize: "0.8rem", fontFamily: "inherit" }} />
                  </div>
                  <div>
                    <label className="block text-zinc-600 mb-1" style={{ fontSize: "0.75rem" }}>End Date *</label>
                    <input required type="date" value={setupForm.end_date}
                      onChange={e => setSetupForm({ ...setupForm, end_date: e.target.value })}
                      className="w-full px-3 py-2 rounded-lg border border-black/10 bg-black/[0.03] text-zinc-900 outline-none focus:border-amber-500/40"
                      style={{ fontSize: "0.8rem", fontFamily: "inherit" }} />
                  </div>
                </div>

              <div className="flex justify-end gap-3 pt-2">
                <button type="button" onClick={() => setShowSetup(false)}
                  className="px-4 py-2 rounded-lg border border-black/10 text-zinc-600 hover:bg-black/5"
                  style={{ fontSize: "0.8rem", fontFamily: "inherit", background: "none", cursor: "pointer" }}>Cancel</button>
                <button type="submit" disabled={setupSaving}
                  className="px-6 py-2 rounded-lg bg-amber-500 text-zinc-900 hover:bg-amber-600 disabled:opacity-50 flex items-center gap-2"
                  style={{ fontSize: "0.8rem", fontFamily: "inherit", border: "none", cursor: "pointer" }}>
                  {setupSaving && <Loader2 className="w-4 h-4 animate-spin" />} Activate Scheme
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── ADD GIFT MODAL ── */}
      {showAddGift && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setShowAddGift(false)}>
          <div className="bg-white border border-black/10 rounded-2xl w-full max-w-md mx-4 p-6" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-zinc-900 font-bold" style={{ ...css, fontSize: "1rem" }}>Add Redemption Gift</h2>
              <button onClick={() => setShowAddGift(false)} className="text-zinc-400 hover:text-zinc-900" style={{ background: "none", border: "none", cursor: "pointer" }}><X className="w-5 h-5" /></button>
            </div>
            {giftError && (
              <div className="mb-4 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400" style={{ fontSize: "0.8rem" }}>{giftError}</div>
            )}
            <form onSubmit={handleAddGift} className="space-y-4">
              <div>
                <label className="block text-zinc-600 mb-1" style={{ fontSize: "0.75rem" }}>Gift Name *</label>
                <input required value={giftForm.name} onChange={e => setGiftForm({ ...giftForm, name: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg border border-black/10 bg-black/[0.03] text-zinc-900 outline-none focus:border-amber-500/40"
                  style={{ fontSize: "0.8rem", fontFamily: "inherit" }} placeholder="e.g. Bluetooth Speaker" />
              </div>
              <div>
                <label className="block text-zinc-600 mb-1" style={{ fontSize: "0.75rem" }}>Description</label>
                <input value={giftForm.description} onChange={e => setGiftForm({ ...giftForm, description: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg border border-black/10 bg-black/[0.03] text-zinc-900 outline-none focus:border-amber-500/40"
                  style={{ fontSize: "0.8rem", fontFamily: "inherit" }} placeholder="Brief description of the gift" />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-zinc-600 mb-1" style={{ fontSize: "0.75rem" }}>Tokens Required *</label>
                  <input required type="number" min="1" value={giftForm.tokens_required}
                    onChange={e => setGiftForm({ ...giftForm, tokens_required: e.target.value })}
                    className="w-full px-3 py-2 rounded-lg border border-black/10 bg-black/[0.03] text-zinc-900 outline-none focus:border-amber-500/40"
                    style={{ fontSize: "0.8rem", fontFamily: "inherit" }} placeholder="50" />
                </div>
                <div>
                  <label className="block text-zinc-600 mb-1" style={{ fontSize: "0.75rem" }}>Qty Available</label>
                  <input type="number" min="1" value={giftForm.qty_available}
                    onChange={e => setGiftForm({ ...giftForm, qty_available: e.target.value })}
                    className="w-full px-3 py-2 rounded-lg border border-black/10 bg-black/[0.03] text-zinc-900 outline-none focus:border-amber-500/40"
                    style={{ fontSize: "0.8rem", fontFamily: "inherit" }} />
                </div>
              </div>
              <div className="flex justify-end gap-3 pt-2">
                <button type="button" onClick={() => setShowAddGift(false)}
                  className="px-4 py-2 rounded-lg border border-black/10 text-zinc-600 hover:bg-black/5"
                  style={{ fontSize: "0.8rem", fontFamily: "inherit", background: "none", cursor: "pointer" }}>Cancel</button>
                <button type="submit" disabled={giftSaving}
                  className="px-5 py-2 rounded-lg bg-amber-500 text-zinc-900 hover:bg-amber-600 disabled:opacity-50 flex items-center gap-2"
                  style={{ fontSize: "0.8rem", fontFamily: "inherit", border: "none", cursor: "pointer" }}>
                  {giftSaving && <Loader2 className="w-4 h-4 animate-spin" />} Add Gift
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── REDEEM MODAL ── */}
      {redeemTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setRedeemTarget(null)}>
          <div className="bg-white border border-black/10 rounded-2xl w-full max-w-md mx-4 p-6" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-5">
              <div>
                <h2 className="text-zinc-900 font-bold" style={{ ...css, fontSize: "1rem" }}>Redeem Tokens</h2>
                <p className="text-zinc-500 mt-0.5" style={{ fontSize: "0.72rem" }}>
                  {redeemTarget.party_name} · {Math.max(0, redeemTarget.tokens_earned - (redeemedByParty[redeemTarget.party_id] || 0))} tokens available
                </p>
              </div>
              <button onClick={() => setRedeemTarget(null)} className="text-zinc-400 hover:text-zinc-900" style={{ background: "none", border: "none", cursor: "pointer" }}><X className="w-5 h-5" /></button>
            </div>
            <div className="space-y-2 mb-5">
              {gifts.filter(g => g.status === "ACTIVE").map(gift => {
                const available = Math.max(0, redeemTarget.tokens_earned - (redeemedByParty[redeemTarget.party_id] || 0));
                const canRedeem = gift.tokens_required <= available;
                return (
                  <button key={gift.id} onClick={() => canRedeem && setRedeemGiftId(gift.id)}
                    disabled={!canRedeem}
                    className={`w-full flex items-center gap-3 p-3 rounded-xl border text-left transition-all ${redeemGiftId === gift.id ? "border-purple-500/40 bg-purple-500/5" : canRedeem ? "border-black/[0.06] hover:bg-black/[0.02]" : "border-black/[0.04] opacity-40 cursor-not-allowed"}`}
                    style={{ fontFamily: "inherit", background: redeemGiftId === gift.id ? undefined : "none", cursor: canRedeem ? "pointer" : "not-allowed" }}>
                    <div className="w-9 h-9 rounded-lg bg-purple-500/10 flex items-center justify-center shrink-0">
                      <Package className="w-4.5 h-4.5 text-purple-400" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-zinc-900 font-medium" style={{ fontSize: "0.82rem" }}>{gift.name}</div>
                      {gift.description && <div className="text-zinc-500 truncate" style={{ fontSize: "0.7rem" }}>{gift.description}</div>}
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <Coins className="w-3.5 h-3.5 text-amber-500" />
                      <span className={`font-bold ${canRedeem ? "text-amber-500" : "text-zinc-400"}`} style={{ fontSize: "0.82rem" }}>{gift.tokens_required}</span>
                    </div>
                  </button>
                );
              })}
            </div>
            <div className="flex justify-end gap-3">
              <button onClick={() => setRedeemTarget(null)}
                className="px-4 py-2 rounded-lg border border-black/10 text-zinc-600 hover:bg-black/5"
                style={{ fontSize: "0.8rem", fontFamily: "inherit", background: "none", cursor: "pointer" }}>Cancel</button>
              <button onClick={handleRedeem} disabled={!redeemGiftId}
                className="px-5 py-2 rounded-lg bg-purple-500 text-white hover:bg-purple-600 disabled:opacity-40 flex items-center gap-2"
                style={{ fontSize: "0.8rem", fontFamily: "inherit", border: "none", cursor: redeemGiftId ? "pointer" : "not-allowed" }}>
                <Gift className="w-4 h-4" /> Submit Request
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
