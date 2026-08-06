"use client";

import { useCallback, useEffect, useState } from "react";
import { api, getUser } from "@/lib/api";
import {
  Calendar, ChevronRight, Coins, Gift, Loader2, Plus, Search, Target, Trash2,
  Trophy, Users, X, Zap, CheckCircle2, UserCheck, Layers, Sparkles, Pen, Receipt, Lock,
  UserPlus,
} from "lucide-react";

interface Slab { from: number; to: number; reward: number }

interface Scheme {
  id: string;
  scheme_code: string;
  name: string;
  scheme_type: string;
  applicable_party_type: string;
  start_date: string;
  end_date: string;
  target_type: string | null;
  target_value: number | null;
  reward_type: string | null;
  reward_value: number | null;
  reward_description: string | null;
  slabs: Slab[] | null;
  terms_conditions: string | null;
  is_stackable: boolean;
  status: string;
  territories: { name: string } | null;
  enrolled_party_names?: string[];
  individual_party_type?: string | null;
}

interface SchemeProgress {
  id: string;
  scheme_id: string;
  party_id: string;
  current_value: number;
  target_value: number;
  progress_percent: number;
  current_slab: number;
  is_eligible: boolean;
  is_achieved: boolean;
  is_salesman?: boolean;
  auto_value?: number;
  manual_adjustment?: number;
  parties: { name: string; party_code: string | null; party_types?: { name: string } | null } | null;
}

interface Party {
  id: string;
  user_id?: string;
  name: string;
  party_code: string;
  party_id?: string | null;
  party_types?: { name: string } | { name: string }[] | null;
}

interface EnrolledParty {
  party_id: string;
  parties: Party | null;
}

const PARTY_TYPES = ["CNF", "SUPER_DEALER", "RETAILER", "SALESMAN", "ALL"];
// Built-in scheme types. INVOICE_SCHEME is measured by the value of invoices
// CONFIRMED to a party (not payments collected) — see lib/invoice-scheme-progress.
const DEFAULT_SCHEME_TYPES = ["SALES_TARGET", "HOT_SCHEME", "PAYMENT_BONANZA", "TOUR_SCHEME", "VOLUME_SLAB", "TOKEN_SCHEME", "INVOICE_SCHEME"];
const LS_KEY = "hometech_scheme_types";

// Hard-coded, built-in scheme types that can never be deleted. INVOICE_SCHEME
// triggers automatically when an invoice issued to a party is CONFIRMED
// (see invoice-requests/[id] → recalcPartySchemesFromInvoices), so removing it
// would break that wiring — it stays locked and highlighted in the picker.
const LOCKED_SCHEME_TYPES = new Set(["INVOICE_SCHEME"]);

const typeIcons: Record<string, typeof Gift> = {
  SALES_TARGET: Target, HOT_SCHEME: Zap, PAYMENT_BONANZA: Gift,
  TOUR_SCHEME: Trophy, YEARLY_BUSINESS: Calendar, VOLUME_SLAB: Users, TOKEN_SCHEME: Coins,
  INVOICE_SCHEME: Receipt,
};
const typeColors: Record<string, string> = {
  SALES_TARGET: "from-blue-500/20 to-blue-500/5 text-blue-400 border-blue-500/20",
  HOT_SCHEME: "from-amber-500/20 to-amber-500/5 text-amber-400 border-amber-500/20",
  PAYMENT_BONANZA: "from-emerald-500/20 to-emerald-500/5 text-emerald-400 border-emerald-500/20",
  TOUR_SCHEME: "from-purple-500/20 to-purple-500/5 text-purple-400 border-purple-500/20",
  YEARLY_BUSINESS: "from-cyan-500/20 to-cyan-500/5 text-cyan-400 border-cyan-500/20",
  VOLUME_SLAB: "from-orange-500/20 to-orange-500/5 text-orange-400 border-orange-500/20",
  TOKEN_SCHEME: "from-yellow-500/20 to-yellow-500/5 text-yellow-500 border-yellow-500/20",
  INVOICE_SCHEME: "from-rose-500/20 to-rose-500/5 text-rose-400 border-rose-500/20",
};

function formatINR(n: number): string {
  if (n >= 10000000) return `${(n / 10000000).toFixed(2)} Cr`;
  if (n >= 100000) return `${(n / 100000).toFixed(2)} L`;
  return `₹${n.toLocaleString("en-IN")}`;
}

function daysRemaining(end: string): number {
  return Math.max(0, Math.ceil((new Date(end).getTime() - Date.now()) / 86400000));
}

const inp = "w-full px-3 py-2 rounded-lg border border-black/10 bg-black/[0.03] text-zinc-900 outline-none focus:border-amber-500/40 text-sm";
const sel = "w-full px-3 py-2 rounded-lg border border-black/10 bg-white text-zinc-900 outline-none focus:border-amber-500/40 text-sm";

const INDIVIDUAL_TYPES = [
  { key: "CNF",          label: "CNF" },
  { key: "SUPER_DEALER", label: "Super Dealer" },
  { key: "RETAILER",     label: "Retailer" },
  { key: "SALESMAN",     label: "Salesman" },
];

// ── Party Picker ──────────────────────────────────────────────────────────────
// Step 1: pick a party-type group  →  Step 2: pick individuals from that group
function PartyPicker({
  groupType,
  onGroupTypeChange,
  selected,
  onToggle,
  disabledIds = [],
}: {
  groupType: string;
  onGroupTypeChange: (t: string) => void;
  selected: Party[];
  onToggle: (p: Party) => void;
  disabledIds?: string[];
}) {
  const [allParties, setAllParties] = useState<Party[]>([]);
  const [loading, setLoading]       = useState(false);
  const [query, setQuery]           = useState("");
  const selectedIds = new Set(selected.map((p) => p.id));
  const disabledIdSet = new Set(disabledIds);

  // Load parties whenever the group type changes
  // Salesmen live in the users table (not parties), so use the dedicated salesmen endpoint
  useEffect(() => {
    if (!groupType) return;
    let cancelled = false;
    setLoading(true);
    setAllParties([]);
    setQuery("");

    async function loadAllParties() {
      try {
        if (groupType === "SALESMAN") {
          const res = await api<{ success?: boolean; data: Party[] }>("/api/v1/parties/salesmen");
          if (cancelled) return;
          const seen = new Set<string>();
          setAllParties((res.data || []).filter((p) => (seen.has(p.id) ? false : seen.add(p.id) && true)));
          return;
        }

        // Page through EVERY party of this type. A single large `limit` is capped
        // server-side (PostgREST max-rows / scope slicing), so a hardcoded limit
        // silently drops the tail once a company exceeds it. Looping by page makes
        // the list complete regardless of size (1k, 10k, …). Results stream in so
        // the picker fills progressively instead of blocking on the full set.
        const PAGE_SIZE = 1000;
        const MAX_PAGES = 50; // safety ceiling: 50k parties
        const seen = new Set<string>();
        const collected: Party[] = [];
        let page = 1;
        for (;;) {
          const res = await api<{ success?: boolean; data: Party[]; pagination?: { pages?: number } }>(
            `/api/v1/parties?type_name=${encodeURIComponent(groupType)}&limit=${PAGE_SIZE}&page=${page}&minimal=1`,
          );
          if (cancelled) return;
          const batch = res.data || [];
          for (const p of batch) {
            if (!seen.has(p.id)) {
              seen.add(p.id);
              collected.push(p);
            }
          }
          setAllParties([...collected]);
          const pages = res.pagination?.pages ?? 1;
          if (batch.length < PAGE_SIZE || page >= pages || page >= MAX_PAGES) break;
          page += 1;
        }
      } catch {
        if (!cancelled) setAllParties([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadAllParties();
    return () => {
      cancelled = true;
    };
  }, [groupType]);

  const filtered = query.trim()
    ? allParties.filter(
        (p) =>
          p.name.toLowerCase().includes(query.toLowerCase()) ||
          p.party_code.toLowerCase().includes(query.toLowerCase()),
      )
    : allParties;

  return (
    <div className="space-y-3">
      {/* Step 1 – type tabs */}
      <div>
        <p className="text-zinc-400 mb-2" style={{ fontSize: "0.72rem" }}>
          Step 1 — Choose a party group
        </p>
        <div className="flex flex-wrap gap-2">
          {INDIVIDUAL_TYPES.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => onGroupTypeChange(t.key)}
              className={`px-3 py-1.5 rounded-lg border text-xs font-medium transition-all ${
                groupType === t.key
                  ? "border-amber-500/50 bg-amber-500/10 text-amber-600"
                  : "border-black/[0.08] bg-black/[0.02] text-zinc-500 hover:bg-black/[0.05]"
              }`}
              style={{ fontFamily: "inherit", cursor: "pointer" }}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Step 2 – party list */}
      {groupType && (
        <div>
          <p className="text-zinc-400 mb-2" style={{ fontSize: "0.72rem" }}>
            Step 2 — Select {INDIVIDUAL_TYPES.find((t) => t.key === groupType)?.label} parties
            {!loading && allParties.length > 0 && (
              <span className="ml-1.5 px-1.5 py-0.5 rounded bg-black/[0.05] text-zinc-500" style={{ fontSize: "0.65rem" }}>
                {query.trim() ? `${filtered.length} of ${allParties.length}` : `${allParties.length} total`}
              </span>
            )}
            {selected.length > 0 && (
              <span className="ml-1.5 px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-600" style={{ fontSize: "0.65rem" }}>
                {selected.length} selected
              </span>
            )}
          </p>

          {/* Search within list */}
          <div className="relative mb-2">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3 h-3 text-zinc-400" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`Search ${INDIVIDUAL_TYPES.find((t) => t.key === groupType)?.label}…`}
              className="w-full pl-8 pr-3 py-1.5 rounded-lg border border-black/10 bg-black/[0.02] text-zinc-900 outline-none focus:border-amber-500/40"
              style={{ fontSize: "0.8rem", fontFamily: "inherit" }}
            />
          </div>

          {/* Party checklist */}
          {loading ? (
            <div className="flex items-center justify-center py-6">
              <Loader2 className="w-5 h-5 text-amber-500 animate-spin" />
            </div>
          ) : filtered.length === 0 ? (
            <div className="text-center py-5 text-zinc-400">
              <Users className="w-7 h-7 mx-auto mb-1.5 opacity-30" />
              <p style={{ fontSize: "0.75rem" }}>
                {allParties.length === 0 ? `No ${groupType} parties found` : "No results for search"}
              </p>
            </div>
          ) : (
            <div
              className="rounded-lg border border-black/[0.08] divide-y divide-black/[0.04] overflow-y-auto"
              style={{ maxHeight: "14rem" }}
            >
              {filtered.map((p) => {
                const isChecked = selectedIds.has(p.id);
                const enrollmentId = groupType === "SALESMAN" ? (p.user_id ?? p.id) : (p.party_id ?? p.id);
                const isAlreadyEnrolled = disabledIdSet.has(enrollmentId) || disabledIdSet.has(p.id);
                return (
                  <label
                    key={p.id}
                    className={`flex items-center gap-3 px-3 py-2.5 transition-colors ${
                      isAlreadyEnrolled ? "cursor-not-allowed bg-black/[0.02] opacity-60" : "cursor-pointer"
                    } ${
                      isChecked ? "bg-amber-500/5" : !isAlreadyEnrolled ? "hover:bg-black/[0.02]" : ""
                    }`}
                  >
                    <div
                      className={`w-4 h-4 rounded shrink-0 border-2 flex items-center justify-center transition-all ${
                        isChecked
                          ? "bg-amber-500 border-amber-500"
                          : "border-black/20 bg-white"
                      }`}
                      onClick={() => { if (!isAlreadyEnrolled) onToggle(p); }}
                    >
                      {isChecked && (
                        <svg width="8" height="6" viewBox="0 0 8 6" fill="none">
                          <path d="M1 3L3 5L7 1" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      )}
                    </div>
                    <div className="flex-1 min-w-0" onClick={() => { if (!isAlreadyEnrolled) onToggle(p); }}>
                      <span className="text-zinc-900 block truncate" style={{ fontSize: "0.825rem" }}>{p.name}</span>
                      <span className="text-zinc-400 font-mono" style={{ fontSize: "0.62rem" }}>{p.party_code}</span>
                    </div>
                    {isAlreadyEnrolled && (
                      <span className="shrink-0 rounded bg-emerald-500/10 px-1.5 py-0.5 text-emerald-600" style={{ fontSize: "0.6rem" }}>
                        Enrolled
                      </span>
                    )}
                  </label>
                );
              })}
            </div>
          )}

          {/* Selected chips */}
          {selected.length > 0 && (
            <div className="mt-2.5 pt-2.5 border-t border-black/[0.06]">
              <p className="text-zinc-400 mb-1.5" style={{ fontSize: "0.65rem" }}>Selected parties:</p>
              <div className="flex flex-wrap gap-1.5">
                {selected.map((p) => (
                  <span
                    key={p.id}
                    className="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-full bg-amber-500/10 border border-amber-500/25 text-amber-700"
                    style={{ fontSize: "0.68rem" }}
                  >
                    {p.name}
                    <button
                      type="button"
                      onClick={() => onToggle(p)}
                      className="w-3.5 h-3.5 rounded-full flex items-center justify-center hover:bg-amber-500/20 transition-colors"
                      style={{ background: "none", border: "none", cursor: "pointer" }}
                    >
                      <X className="w-2.5 h-2.5" />
                    </button>
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Member view (non-admin users) ─────────────────────────────────────────────
interface MyScheme extends Scheme {
  progress: {
    current_value: number;
    target_value: number;
    progress_percent: number;
    is_achieved: boolean;
    is_eligible: boolean;
  };
}

function MemberSchemesView() {
  const [mySchemes, setMySchemes] = useState<MyScheme[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      // Self-heal first: recompute this salesman's progress from their actual
      // collected payments so the bar always reflects what they've collected —
      // even for payments made before progress tracking, or while offline.
      // Idempotent; safe to fail silently (the GET below still renders stored progress).
      try {
        await api("/api/v1/schemes/my", { method: "POST" });
      } catch {
        /* recompute is best-effort; fall through to read whatever is stored */
      }

      try {
        const r = await api<{ success: boolean; data: MyScheme[] }>("/api/v1/schemes/my");
        if (!cancelled) setMySchemes(r.data || []);
      } catch {
        if (!cancelled) setMySchemes([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    load();

    // Refresh when a payment is collected elsewhere in the app.
    const onPayment = () => load();
    window.addEventListener("paymentRecorded", onPayment);
    return () => {
      cancelled = true;
      window.removeEventListener("paymentRecorded", onPayment);
    };
  }, []);

  if (loading) return (
    <div className="flex items-center justify-center py-20">
      <Loader2 className="w-7 h-7 text-amber-500 animate-spin" />
    </div>
  );

  return (
    <div style={{ fontFamily: "'Inter','system-ui',sans-serif" }}>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-zinc-900" style={{ marginBottom: "0.25rem" }}>My Schemes</h1>
        <p className="text-zinc-500" style={{ fontSize: "0.75rem" }}>
          {mySchemes.length} active scheme{mySchemes.length !== 1 ? "s" : ""}
        </p>
      </div>

      {mySchemes.length === 0 ? (
        <div className="text-center py-20 text-zinc-400">
          <Gift className="w-12 h-12 mx-auto mb-4 opacity-30" />
          <p className="text-sm">No active schemes for you right now</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {mySchemes.map((sch) => {
            const pct = Math.min(100, sch.progress?.progress_percent ?? 0);
            const achieved = sch.progress?.is_achieved;
            const days = daysRemaining(sch.end_date);
            const barColor = achieved ? "bg-emerald-500" : pct >= 75 ? "bg-amber-500" : "bg-blue-500";
            return (
              <div key={sch.id} className="rounded-xl border border-black/[0.06] bg-white p-4 shadow-sm">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-medium text-zinc-500 bg-black/[0.04] px-2 py-0.5 rounded">
                    {sch.scheme_type.replace(/_/g, " ")}
                  </span>
                  {achieved ? (
                    <span className="flex items-center gap-1 text-emerald-600 text-xs font-semibold">
                      <CheckCircle2 className="w-3.5 h-3.5" /> Achieved!
                    </span>
                  ) : days <= 7 ? (
                    <span className="text-amber-500 text-xs font-medium">{days}d left</span>
                  ) : null}
                </div>

                <h3 className="text-zinc-900 font-semibold mb-0.5" style={{ fontSize: "0.9rem" }}>{sch.name}</h3>
                <p className="text-zinc-400 font-mono mb-3" style={{ fontSize: "0.6rem" }}>{sch.scheme_code}</p>

                {sch.target_value && (
                  <div className="mb-3">
                    <div className="flex justify-between mb-1">
                      <span className="text-zinc-500" style={{ fontSize: "0.7rem" }}>Progress</span>
                      <span className="text-zinc-700 font-medium" style={{ fontSize: "0.7rem" }}>
                        {formatINR(sch.progress?.current_value ?? 0)} / {formatINR(Number(sch.target_value))}
                      </span>
                    </div>
                    <div className="w-full h-2 rounded-full bg-black/[0.06]">
                      <div className={`h-full rounded-full transition-all ${barColor}`} style={{ width: `${pct}%` }} />
                    </div>
                    <div className="text-right mt-0.5" style={{ fontSize: "0.65rem", color: "#a1a1aa" }}>{pct.toFixed(1)}%</div>
                  </div>
                )}

                {sch.reward_description && (
                  <div className="text-xs text-amber-600 bg-amber-500/5 border border-amber-500/15 rounded-lg px-2.5 py-1.5 mb-2">
                    {sch.reward_description}
                  </div>
                )}

                <div className="flex items-center justify-between pt-2 border-t border-black/[0.04]">
                  <span className="text-zinc-400" style={{ fontSize: "0.65rem" }}>
                    {fmtDate(sch.start_date)} – {fmtDate(sch.end_date)}
                  </span>
                  {sch.reward_type && (
                    <span className="text-xs text-zinc-500 bg-black/[0.03] px-2 py-0.5 rounded border border-black/[0.06]">
                      {sch.reward_type}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function SchemesPage() {
  const user = getUser();
  const isAdmin = user?.role === "SUPER_ADMIN" || user?.role === "ADMIN";
  // Non-admin users (retailers, CNF, salesmen, etc.) see only their own schemes
  if (!isAdmin) return <MemberSchemesView />;
  return <AdminSchemesView />;
}

function AdminSchemesView() {
  const user = getUser();
  const [schemes, setSchemes] = useState<Scheme[]>([]);
  const [loading, setLoading] = useState(true);
  const [typeFilter, setTypeFilter] = useState("");
  const [selectedScheme, setSelectedScheme] = useState<Scheme | null>(null);
  const [progress, setProgress] = useState<SchemeProgress[]>([]);
  const [progressLoading, setProgressLoading] = useState(false);
  const [progressSearch, setProgressSearch] = useState("");
  const [enrolledParties, setEnrolledParties] = useState<EnrolledParty[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState("");

  const [deleteTarget, setDeleteTarget] = useState<Scheme | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  // Add more parties to an existing individually targeted scheme.
  const [addPartiesTarget, setAddPartiesTarget] = useState<Scheme | null>(null);
  const [addPartyGroupType, setAddPartyGroupType] = useState("");
  const [partiesToAdd, setPartiesToAdd] = useState<Party[]>([]);
  const [existingEnrollmentIds, setExistingEnrollmentIds] = useState<string[]>([]);
  const [addPartiesLoading, setAddPartiesLoading] = useState(false);
  const [addPartiesSaving, setAddPartiesSaving] = useState(false);
  const [addPartiesError, setAddPartiesError] = useState("");

  // Manual progress edit — % and ₹ value stay in sync (edit either one).
  const [editTarget, setEditTarget] = useState<SchemeProgress | null>(null);
  const [editPct, setEditPct] = useState("");
  const [editValue, setEditValue] = useState("");
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState("");

  function openEdit(p: SchemeProgress) {
    setEditTarget(p);
    setEditPct(String(Math.round(Math.min(100, Number(p.progress_percent) || 0))));
    setEditValue(String(Math.round(Number(p.current_value) || 0)));
    setEditError("");
  }

  // Typing a ₹ amount auto-derives the percent (and vice-versa) in real time.
  function onChangeEditValue(v: string) {
    setEditValue(v);
    const target = Number(editTarget?.target_value) || 0;
    const amount = Number(v);
    if (target > 0 && Number.isFinite(amount)) {
      setEditPct((Math.min(100, (amount / target) * 100)).toFixed(1));
    }
  }
  function onChangeEditPct(v: string) {
    setEditPct(v);
    const target = Number(editTarget?.target_value) || 0;
    const pct = Number(v);
    if (target > 0 && Number.isFinite(pct)) {
      setEditValue(String(Math.round((pct / 100) * target)));
    }
  }

  async function handleSaveProgress() {
    if (!editTarget || !selectedScheme) return;
    const amount = Number(editValue);
    if (!Number.isFinite(amount) || amount < 0) {
      setEditError("Enter a valid amount (0 or more).");
      return;
    }
    setEditSaving(true);
    setEditError("");
    try {
      // Send the absolute ₹ value so the percent is derived precisely from it.
      await api(`/api/v1/schemes/${selectedScheme.id}/progress`, {
        method: "PATCH",
        body: { party_id: editTarget.party_id, current_value: amount },
      });
      setEditTarget(null);
      await loadProgress(selectedScheme.id);
      // Let other surfaces (member "My Schemes") refresh if they're listening.
      window.dispatchEvent(new Event("paymentRecorded"));
    } catch (err) {
      setEditError(err instanceof Error ? err.message : "Failed to save progress");
    } finally {
      setEditSaving(false);
    }
  }

  const isSuperAdmin = user?.role === "SUPER_ADMIN" || user?.role === "ADMIN";

  // Party Progress list, narrowed by the search box (matches name or party code).
  const filteredProgress = (() => {
    const q = progressSearch.trim().toLowerCase();
    if (!q) return progress;
    return progress.filter((p) => {
      const name = p.parties?.name?.toLowerCase() ?? "";
      const code = p.parties?.party_code?.toLowerCase() ?? "";
      return name.includes(q) || code.includes(q);
    });
  })();

  // ── Form state ───────────────────────────────────────────────────────────────
  const [scopeMode, setScopeMode] = useState<"GROUP" | "INDIVIDUAL">("GROUP");
  const [individualGroupType, setIndividualGroupType] = useState("");
  const [selectedParties, setSelectedParties] = useState<Party[]>([]);
  const [isCustomType, setIsCustomType] = useState(false);

  const [availableSchemeTypes, setAvailableSchemeTypes] = useState<string[]>(() => {
    if (typeof window === "undefined") return DEFAULT_SCHEME_TYPES;
    try {
      const saved = localStorage.getItem(LS_KEY);
      if (!saved) return DEFAULT_SCHEME_TYPES;
      const parsed = JSON.parse(saved) as string[];
      if (!Array.isArray(parsed)) return DEFAULT_SCHEME_TYPES;
      // Always surface the hard-coded built-in types (e.g. INVOICE_SCHEME) for
      // users whose cached list predates them, without resurrecting types they
      // removed on purpose.
      const missingLocked = [...LOCKED_SCHEME_TYPES].filter((t) => !parsed.includes(t));
      return missingLocked.length > 0 ? [...parsed, ...missingLocked] : parsed;
    } catch { return DEFAULT_SCHEME_TYPES; }
  });

  function removeSchemeType(type: string) {
    if (LOCKED_SCHEME_TYPES.has(type)) return; // built-in scheme — cannot be deleted
    const updated = availableSchemeTypes.filter((t) => t !== type);
    setAvailableSchemeTypes(updated);
    try { localStorage.setItem(LS_KEY, JSON.stringify(updated)); } catch {}
    if (form.scheme_type === type) {
      setForm({ ...form, scheme_type: updated[0] ?? "" });
      setIsCustomType(false);
    }
  }
  const [form, setForm] = useState({
    name: "", scheme_type: "SALES_TARGET", applicable_party_type: "CNF",
    start_date: "", end_date: "", target_type: "VALUE", target_value: "",
    reward_type: "PRODUCT", reward_value: "", reward_description: "", terms_conditions: "",
  });

  function toggleParty(p: Party) {
    setSelectedParties((prev) =>
      prev.some((x) => x.id === p.id) ? prev.filter((x) => x.id !== p.id) : [...prev, p],
    );
  }

  function togglePartyToAdd(p: Party) {
    setPartiesToAdd((prev) =>
      prev.some((x) => x.id === p.id) ? prev.filter((x) => x.id !== p.id) : [...prev, p],
    );
  }

  async function openAddParties(scheme: Scheme) {
    setAddPartiesTarget(scheme);
    setAddPartyGroupType(scheme.individual_party_type || "");
    setPartiesToAdd([]);
    setExistingEnrollmentIds([]);
    setAddPartiesError("");
    setAddPartiesLoading(true);
    try {
      const res = await api<{ success: boolean; data: EnrolledParty[] }>(
        `/api/v1/schemes/enroll?scheme_id=${scheme.id}`,
      );
      setExistingEnrollmentIds((res.data || []).map((row) => row.party_id).filter(Boolean));
    } catch (err) {
      setAddPartiesError(err instanceof Error ? err.message : "Could not load current enrollments");
    } finally {
      setAddPartiesLoading(false);
    }
  }

  async function handleAddParties() {
    if (!addPartiesTarget) return;
    if (!addPartyGroupType) {
      setAddPartiesError("Choose a party group first.");
      return;
    }
    if (partiesToAdd.length === 0) {
      setAddPartiesError("Select at least one new party.");
      return;
    }

    setAddPartiesSaving(true);
    setAddPartiesError("");
    const target = addPartiesTarget;
    try {
      const partyIds = partiesToAdd.map((p) =>
        addPartyGroupType === "SALESMAN" ? (p.user_id ?? p.id) : (p.party_id ?? p.id),
      );
      const res = await api<{ success: boolean; enrolled?: number; warning?: string }>("/api/v1/schemes/enroll", {
        method: "POST",
        body: { scheme_id: target.id, party_ids: partyIds },
      });
      if (res.warning || res.enrolled === 0) {
        throw new Error(res.warning || "No parties were enrolled");
      }

      const addedNames = partiesToAdd.map((p) => p.name);
      setSchemes((prev) => prev.map((scheme) =>
        scheme.id === target.id
          ? { ...scheme, enrolled_party_names: [...new Set([...(scheme.enrolled_party_names || []), ...addedNames])] }
          : scheme,
      ));
      if (selectedScheme?.id === target.id) {
        setSelectedScheme((current) => current
          ? { ...current, enrolled_party_names: [...new Set([...(current.enrolled_party_names || []), ...addedNames])] }
          : current,
        );
        await loadProgress(target.id);
      }
      setAddPartiesTarget(null);
      setPartiesToAdd([]);
      await loadSchemes();
    } catch (err) {
      setAddPartiesError(err instanceof Error ? err.message : "Failed to add parties");
    } finally {
      setAddPartiesSaving(false);
    }
  }

  function resetForm() {
    setScopeMode("GROUP");
    setIndividualGroupType("");
    setSelectedParties([]);
    setIsCustomType(false);
    setForm({
      name: "", scheme_type: "SALES_TARGET", applicable_party_type: "CNF",
      start_date: "", end_date: "", target_type: "VALUE", target_value: "",
      reward_type: "PRODUCT", reward_value: "", reward_description: "", terms_conditions: "",
    });
    setFormError("");
  }

  // ── Data loaders ─────────────────────────────────────────────────────────────
  const loadSchemes = useCallback(async (type = typeFilter) => {
    try {
      const params = new URLSearchParams();
      if (type) params.set("type", type);
      const res = await api<{ success: boolean; data: Scheme[] }>(`/api/v1/schemes?${params}`);
      setSchemes(res.data || []);
    } catch { setSchemes([]); }
    setLoading(false);
  }, [typeFilter]);

  useEffect(() => { setLoading(true); loadSchemes(typeFilter); }, [typeFilter]); // eslint-disable-line react-hooks/exhaustive-deps

  async function loadProgress(schemeId: string) {
    setProgressLoading(true);
    setProgressSearch("");
    setEnrolledParties([]);
    try {
      const [progRes, enrollRes] = await Promise.allSettled([
        api<{ success: boolean; data: SchemeProgress[] }>(`/api/v1/schemes/${schemeId}/progress`),
        api<{ success: boolean; data: EnrolledParty[] }>(`/api/v1/schemes/enroll?scheme_id=${schemeId}`),
      ]);
      if (progRes.status === "fulfilled") setProgress(progRes.value.data || []);
      if (enrollRes.status === "fulfilled") setEnrolledParties(enrollRes.value.data || []);
    } catch { setProgress([]); }
    setProgressLoading(false);
  }

  // ── Create ───────────────────────────────────────────────────────────────────
  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (scopeMode === "INDIVIDUAL" && !individualGroupType) {
      setFormError("Select a party group (CNF, Retailer, etc.) first.");
      return;
    }
    if (scopeMode === "INDIVIDUAL" && selectedParties.length === 0) {
      setFormError("Select at least one party from the list.");
      return;
    }
    setFormError(""); setCreating(true);
    try {
      // Step 1: Create the scheme
      const res = await api<{ success: boolean; data: Scheme }>("/api/v1/schemes", {
        method: "POST",
        body: {
          ...form,
          scope_mode: scopeMode,
          individual_party_type: scopeMode === "INDIVIDUAL" ? individualGroupType : null,
          applicable_party_type: scopeMode === "INDIVIDUAL" ? "INDIVIDUAL" : form.applicable_party_type,
          party_names: scopeMode === "INDIVIDUAL" ? selectedParties.map((p) => p.name) : undefined,
          target_value: parseFloat(form.target_value) || null,
          reward_value: parseFloat(form.reward_value) || null,
        },
      });

      // Step 2: Enroll individual parties (best-effort — scheme is already saved even if this fails)
      if (scopeMode === "INDIVIDUAL" && res.data?.id && selectedParties.length > 0) {
        try {
          await api("/api/v1/schemes/enroll", {
            method: "POST",
            body: {
              scheme_id: res.data.id,
              party_ids: selectedParties.map((p) =>
                individualGroupType === "SALESMAN" ? (p.user_id ?? p.id) : (p.party_id ?? p.id),
              ),
            },
          });
        } catch (enrollErr) {
          // Scheme was created — warn but don't block the user
          console.warn("[scheme create] enrollment failed:", enrollErr);
          setFormError(
            `Scheme created, but individual party enrollment failed: ${
              enrollErr instanceof Error ? enrollErr.message : String(enrollErr)
            }. You can re-assign parties from the scheme detail.`,
          );
          // Still close and refresh so the scheme shows up
          setShowCreate(false);
          resetForm();
          await loadSchemes();
          return;
        }
      }

      setShowCreate(false);
      resetForm();
      await loadSchemes();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Failed to create scheme");
    } finally { setCreating(false); }
  }

  // ── Delete ───────────────────────────────────────────────────────────────────
  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true); setDeleteError("");
    try {
      await api(`/api/v1/schemes?id=${deleteTarget.id}`, { method: "DELETE" });
      setSchemes((prev) => prev.filter((s) => s.id !== deleteTarget.id));
      setDeleteTarget(null);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Failed to delete scheme");
    } finally { setDeleting(false); }
  }

  return (
    <div style={{ fontFamily: "'Inter','system-ui',sans-serif" }}>

      {/* ── Header ── */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900" style={{ fontSize: "1.5rem", marginBottom: "0.25rem" }}>
            Schemes & Offers
          </h1>
          <p className="text-zinc-500" style={{ fontSize: "0.75rem" }}>
            {schemes.length} scheme{schemes.length !== 1 ? "s" : ""} configured
          </p>
        </div>
        <button
          onClick={() => { resetForm(); setShowCreate(true); }}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-amber-500 text-zinc-900 hover:bg-amber-600 transition-all text-sm font-medium"
          style={{ fontFamily: "inherit", border: "none", cursor: "pointer" }}
        >
          <Plus className="w-4 h-4" /> New Scheme
        </button>
      </div>

      {/* ── Type filters ── */}
      <div className="flex flex-wrap gap-2 mb-6">
        {["", ...availableSchemeTypes].map((t) => (
          <button
            key={t}
            onClick={() => setTypeFilter(t)}
            className={`px-3 py-1.5 rounded-lg border transition-all text-xs ${
              typeFilter === t
                ? "border-amber-500/40 bg-amber-500/10 text-amber-600"
                : "border-black/10 bg-black/[0.03] text-zinc-500 hover:bg-black/5"
            }`}
            style={{ fontFamily: "inherit", cursor: "pointer" }}
          >
            {t ? t.replace(/_/g, " ") : "ALL"}
          </button>
        ))}
      </div>

      {/* ── Scheme grid ── */}
      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-7 h-7 text-amber-500 animate-spin" />
        </div>
      ) : schemes.length === 0 ? (
        <div className="text-center py-20 text-zinc-400">
          <Gift className="w-12 h-12 mx-auto mb-4 opacity-30" />
          <p className="text-sm">No schemes found</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
          {schemes.map((sch) => {
            const days = daysRemaining(sch.end_date);
            const isActive = sch.status === "ACTIVE" && days > 0;
            const Icon = typeIcons[sch.scheme_type] || Gift;
            const colorStr = typeColors[sch.scheme_type] || "from-zinc-500/20 to-zinc-500/5 text-zinc-600 border-zinc-500/20";
            const [gradFrom, gradTo, textColor] = colorStr.split(" ");
            return (
              <div
                key={sch.id}
                onClick={() => { setSelectedScheme(sch); loadProgress(sch.id); }}
                className={`rounded-xl border bg-white p-5 cursor-pointer transition-all hover:shadow-sm ${
                  isActive ? "border-black/[0.08]" : "border-black/[0.04] opacity-60"
                }`}
              >
                <div className="flex items-start justify-between mb-3">
                  <div className={`w-9 h-9 rounded-xl bg-gradient-to-br ${gradFrom} ${gradTo} flex items-center justify-center`}>
                    <Icon className={`w-4.5 h-4.5 ${textColor}`} style={{ width: "1.1rem", height: "1.1rem" }} />
                  </div>
                  <div className="flex items-center gap-1.5">
                    {isActive && days <= 30 && (
                      <span className="px-2 py-0.5 rounded bg-amber-500/15 text-amber-500 font-medium" style={{ fontSize: "0.6rem" }}>
                        {days}d left
                      </span>
                    )}
                    <span
                      className={`px-2 py-0.5 rounded font-medium ${
                        isActive ? "bg-emerald-500/15 text-emerald-600" : "bg-zinc-100 text-zinc-500"
                      }`}
                      style={{ fontSize: "0.6rem" }}
                    >
                      {isActive ? "Active" : days <= 0 ? "Expired" : "Inactive"}
                    </span>
                  </div>
                </div>

                <h3 className="text-zinc-900 font-semibold mb-0.5" style={{ fontSize: "0.875rem" }}>{sch.name}</h3>
                <p className="text-zinc-400 font-mono mb-3" style={{ fontSize: "0.65rem" }}>{sch.scheme_code}</p>

                <div className="space-y-1.5">
                  <InfoRow label="Type" value={sch.scheme_type.replace(/_/g, " ")} />
                  <InfoRow
                    label="For"
                    value={
                      sch.applicable_party_type === "INDIVIDUAL"
                        ? fmtPartyNames(sch.enrolled_party_names)
                        : sch.applicable_party_type === "ALL"
                        ? "All parties"
                        : sch.applicable_party_type.replace(/_/g, " ") + " (group)"
                    }
                    highlight={sch.applicable_party_type === "INDIVIDUAL"}
                  />
                  {sch.target_value && (
                    <InfoRow label="Target" value={formatINR(Number(sch.target_value))} amber />
                  )}
                  <InfoRow
                    label="Period"
                    value={`${fmtDate(sch.start_date)} – ${fmtDate(sch.end_date)}`}
                  />
                </div>

                {sch.slabs && Array.isArray(sch.slabs) && sch.slabs.length > 0 && (
                  <div className="mt-3 pt-3 border-t border-black/[0.05]">
                    <span className="text-zinc-400" style={{ fontSize: "0.6rem" }}>
                      {sch.slabs.length} slab{sch.slabs.length > 1 ? "s" : ""} configured
                    </span>
                  </div>
                )}

                <div className="flex items-center justify-between mt-3 pt-2 border-t border-black/[0.04]">
                  <div className="flex items-center gap-1.5">
                    {isSuperAdmin && sch.applicable_party_type === "INDIVIDUAL" && (
                      <button
                        onClick={(e) => { e.stopPropagation(); openAddParties(sch); }}
                        className="flex items-center gap-1.5 rounded-lg border border-violet-500/20 bg-violet-500/[0.07] px-2.5 py-1.5 text-violet-600 transition-all hover:bg-violet-500/15"
                        style={{ cursor: "pointer", fontFamily: "inherit", fontSize: "0.68rem" }}
                        title="Add more parties to this scheme"
                      >
                        <UserPlus className="w-3.5 h-3.5" />
                        Add parties
                      </button>
                    )}
                    {isSuperAdmin && (
                      <button
                        onClick={(e) => { e.stopPropagation(); setDeleteTarget(sch); setDeleteError(""); }}
                        className="p-1.5 rounded-lg text-zinc-400 hover:text-red-400 hover:bg-red-500/10 transition-all"
                        style={{ background: "none", border: "none", cursor: "pointer" }}
                        title="Delete scheme"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                  <ChevronRight className="w-4 h-4 text-zinc-400" />
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ── Detail modal ── */}
      {selectedScheme && (
        <Modal onClose={() => setSelectedScheme(null)}>
          <div className="flex items-center justify-between mb-5">
            <div>
              <h2 className="text-lg font-bold text-zinc-900">{selectedScheme.name}</h2>
              <span className="text-zinc-400 font-mono" style={{ fontSize: "0.7rem" }}>{selectedScheme.scheme_code}</span>
            </div>
            <CloseBtn onClick={() => setSelectedScheme(null)} />
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
            {[
              { label: "Type", value: selectedScheme.scheme_type.replace(/_/g, " ") },
              {
                label: "For",
                value:
                  selectedScheme.applicable_party_type === "INDIVIDUAL"
                    ? enrolledParties.length > 0
                      ? fmtPartyNames(enrolledParties.map((ep) => ep.parties?.name ?? "").filter(Boolean))
                      : fmtPartyNames(selectedScheme.enrolled_party_names)
                    : selectedScheme.applicable_party_type === "ALL"
                    ? "All parties"
                    : selectedScheme.applicable_party_type.replace(/_/g, " ") + " (group)",
                sub: progressLoading
                  ? "counting…"
                  : `${progress.length} part${progress.length === 1 ? "y" : "ies"}`,
              },
              { label: "Target", value: selectedScheme.target_value ? formatINR(Number(selectedScheme.target_value)) : "N/A" },
              { label: "Reward", value: selectedScheme.reward_type || "N/A" },
            ].map((item) => (
              <div key={item.label} className="rounded-lg border border-black/[0.06] bg-black/[0.02] p-3 min-w-0">
                <span className="text-zinc-400 block mb-0.5" style={{ fontSize: "0.65rem" }}>{item.label}</span>
                <span className="text-zinc-900 font-medium text-sm block truncate" title={item.value}>{item.value}</span>
                {"sub" in item && item.sub && (
                  <span className="text-amber-600 font-medium block mt-0.5" style={{ fontSize: "0.65rem" }}>{item.sub}</span>
                )}
              </div>
            ))}
          </div>

          {selectedScheme.reward_description && (
            <div className="mb-4 p-3 rounded-lg bg-amber-500/5 border border-amber-500/15">
              <span className="text-amber-600 text-sm">{selectedScheme.reward_description}</span>
            </div>
          )}

          {/* Slabs */}
          {selectedScheme.slabs && Array.isArray(selectedScheme.slabs) && selectedScheme.slabs.length > 0 && (
            <div className="mb-5">
              <h3 className="text-sm font-semibold text-zinc-700 mb-2">Slab Structure</h3>
              <div className="rounded-lg border border-black/[0.06] overflow-hidden">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-black/[0.06] bg-black/[0.02]">
                      <th className="text-left px-4 py-2 text-zinc-400 font-medium" style={{ fontSize: "0.7rem" }}>From</th>
                      <th className="text-left px-4 py-2 text-zinc-400 font-medium" style={{ fontSize: "0.7rem" }}>To</th>
                      <th className="text-right px-4 py-2 text-zinc-400 font-medium" style={{ fontSize: "0.7rem" }}>Reward %</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(selectedScheme.slabs as Slab[]).map((slab, i) => (
                      <tr key={i} className="border-b border-black/[0.04]">
                        <td className="px-4 py-2 text-zinc-700 text-sm">{formatINR(slab.from)}</td>
                        <td className="px-4 py-2 text-zinc-700 text-sm">{formatINR(slab.to)}</td>
                        <td className="px-4 py-2 text-amber-500 font-semibold text-sm text-right">{slab.reward}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Individually enrolled parties */}
          {!progressLoading && enrolledParties.length > 0 && (
            <div className="mb-5">
              <div className="flex items-center gap-2 mb-2">
                <UserCheck className="w-3.5 h-3.5 text-violet-400" />
                <h3 className="text-sm font-semibold text-zinc-700">Individually Enrolled ({enrolledParties.length})</h3>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {enrolledParties.map((ep) => (
                  <span
                    key={ep.party_id}
                    className="px-2 py-1 rounded-lg bg-violet-500/10 border border-violet-500/20 text-violet-600"
                    style={{ fontSize: "0.7rem" }}
                  >
                    {ep.parties?.name || ep.party_id}
                    {ep.parties?.party_code && (
                      <span className="ml-1 text-violet-400 font-mono">{ep.parties.party_code}</span>
                    )}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Progress */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-zinc-700">
                Party Progress{!progressLoading && progress.length > 0 ? ` (${progress.length})` : ""}
              </h3>
              {!progressLoading && progress.length > 0 && (
                <span className="flex items-center gap-1 px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-600" style={{ fontSize: "0.65rem" }}>
                  <CheckCircle2 className="w-3 h-3" />
                  {progress.filter((p) => p.is_achieved).length} achieved
                </span>
              )}
            </div>
            {!progressLoading && progress.length > 0 && (
              <div className="relative mb-3">
                <Search className="w-3.5 h-3.5 text-zinc-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  value={progressSearch}
                  onChange={(e) => setProgressSearch(e.target.value)}
                  placeholder="Search parties by name or code…"
                  className="w-full pl-8 pr-8 py-2 rounded-lg bg-black/[0.02] border border-black/[0.08] text-sm text-zinc-700 outline-none focus:border-amber-500/50"
                  style={{ fontFamily: "inherit" }}
                />
                {progressSearch && (
                  <button
                    type="button"
                    onClick={() => setProgressSearch("")}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600"
                    aria-label="Clear search"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            )}
            {progressLoading ? (
              <div className="flex justify-center py-6"><Loader2 className="w-5 h-5 text-amber-500 animate-spin" /></div>
            ) : progress.length === 0 ? (
              <div className="text-center py-6 text-zinc-400">
                <Target className="w-8 h-8 mx-auto mb-2 opacity-30" />
                <p className="text-sm">No parties match this scheme yet</p>
                <p style={{ fontSize: "0.7rem" }} className="mt-0.5">Add parties of this type, or enroll individuals, to see them here.</p>
              </div>
            ) : filteredProgress.length === 0 ? (
              <div className="text-center py-6 text-zinc-400">
                <Search className="w-8 h-8 mx-auto mb-2 opacity-30" />
                <p className="text-sm">No parties match &ldquo;{progressSearch}&rdquo;</p>
              </div>
            ) : (
              <div className="space-y-3 max-h-[22rem] overflow-y-auto pr-1">
                {filteredProgress.map((p) => (
                  <ProgressRow key={p.id} p={p} onEdit={isSuperAdmin ? () => openEdit(p) : undefined} />
                ))}
              </div>
            )}
          </div>

          {selectedScheme.terms_conditions && (
            <div className="mt-4 p-3 rounded-lg bg-black/[0.02] border border-black/[0.06]">
              <span className="text-zinc-400 block mb-1 text-xs">Terms & Conditions</span>
              <span className="text-zinc-600 text-sm">{selectedScheme.terms_conditions}</span>
            </div>
          )}
        </Modal>
      )}

      {/* ── Create modal ── */}
      {showCreate && (
        <Modal onClose={() => { setShowCreate(false); resetForm(); }}>
          <div className="flex items-center justify-between mb-5">
            <div>
              <h2 className="text-lg font-bold text-zinc-900">Create Scheme</h2>
              <p className="text-zinc-400 text-xs mt-0.5">Set up a new incentive scheme for your parties</p>
            </div>
            <CloseBtn onClick={() => { setShowCreate(false); resetForm(); }} />
          </div>

          {formError && (
            <div className="mb-4 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-500 text-sm">{formError}</div>
          )}

          <form onSubmit={handleCreate} className="space-y-5">
            {/* Basic info */}
            <Section title="Basic Information">
              <div>
                <Label>Scheme Name *</Label>
                <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
                  className={inp} style={{ fontFamily: "inherit" }} placeholder="e.g. Summer Bonanza 2025" />
              </div>

              {/* Scheme type — visual cards */}
              <div>
                <Label>Scheme Type *</Label>
                <div className="grid grid-cols-3 gap-2 mb-2">
                  {availableSchemeTypes.map((t) => {
                    const Icon = typeIcons[t] || Gift;
                    const isActive = !isCustomType && form.scheme_type === t;
                    const isLocked = LOCKED_SCHEME_TYPES.has(t);
                    return (
                      <div key={t} className="relative group">
                        <button
                          type="button"
                          onClick={() => { setForm({ ...form, scheme_type: t }); setIsCustomType(false); }}
                          className={`w-full flex items-center gap-2 px-3 py-2.5 rounded-xl border-2 text-left transition-all pr-7 ${
                            isActive
                              ? "border-amber-500/60 bg-amber-50"
                              : isLocked
                                ? "border-rose-500/40 bg-rose-50 hover:bg-rose-100/70 ring-1 ring-rose-500/20"
                                : "border-black/[0.08] bg-black/[0.02] hover:bg-black/[0.04]"
                          }`}
                          style={{ fontFamily: "inherit", cursor: "pointer" }}
                          title={isLocked ? "Built-in scheme — triggers automatically when an invoice is confirmed" : undefined}
                        >
                          <Icon className={`w-3.5 h-3.5 shrink-0 ${isActive ? "text-amber-500" : isLocked ? "text-rose-500" : "text-zinc-400"}`} />
                          <span className={`text-xs font-medium leading-tight ${isActive ? "text-amber-700" : isLocked ? "text-rose-600" : "text-zinc-600"}`}>
                            {t.replace(/_/g, " ")}
                          </span>
                        </button>
                        {isLocked ? (
                          /* Built-in scheme — locked, cannot be deleted */
                          <span
                            className="absolute top-1 right-1 w-5 h-5 rounded-md flex items-center justify-center bg-rose-500/10 text-rose-500"
                            title="Built-in scheme — cannot be deleted"
                          >
                            <Lock className="w-2.5 h-2.5" />
                          </span>
                        ) : (
                          /* Delete button — appears on hover */
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); removeSchemeType(t); }}
                            className="absolute top-1 right-1 w-5 h-5 rounded-md flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity bg-red-500/10 hover:bg-red-500/20 text-red-400"
                            style={{ border: "none", cursor: "pointer" }}
                            title={`Remove ${t.replace(/_/g, " ")}`}
                          >
                            <X className="w-2.5 h-2.5" />
                          </button>
                        )}
                      </div>
                    );
                  })}

                  {/* Custom / your own */}
                  <button
                    type="button"
                    onClick={() => { setIsCustomType(true); setForm({ ...form, scheme_type: "" }); }}
                    className={`flex items-center gap-2 px-3 py-2.5 rounded-xl border-2 text-left transition-all ${
                      isCustomType
                        ? "border-violet-500/60 bg-violet-50"
                        : "border-dashed border-black/[0.12] bg-black/[0.01] hover:bg-black/[0.03]"
                    }`}
                    style={{ fontFamily: "inherit", cursor: "pointer" }}
                  >
                    <Sparkles className={`w-3.5 h-3.5 shrink-0 ${isCustomType ? "text-violet-500" : "text-zinc-300"}`} />
                    <span className={`text-xs font-medium leading-tight ${isCustomType ? "text-violet-700" : "text-zinc-400"}`}>
                      Custom
                    </span>
                  </button>
                </div>

                {/* Custom name input — appears when Custom is selected */}
                {isCustomType && (
                  <div className="relative mt-1">
                    <Pen className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-violet-400" />
                    <input
                      required
                      autoFocus
                      value={form.scheme_type}
                      onChange={(e) => setForm({ ...form, scheme_type: e.target.value.toUpperCase().replace(/\s+/g, "_") })}
                      placeholder="Type your scheme name, e.g. FESTIVE_BONUS"
                      className="w-full pl-8 pr-3 py-2 rounded-lg border-2 border-violet-500/40 bg-violet-50 text-zinc-900 outline-none focus:border-violet-500/60 text-sm font-mono"
                      style={{ fontFamily: "monospace" }}
                    />
                    {form.scheme_type && (
                      <span className="absolute right-3 top-1/2 -translate-y-1/2 text-violet-400" style={{ fontSize: "0.6rem" }}>
                        Custom
                      </span>
                    )}
                  </div>
                )}
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label>Start Date *</Label>
                  <input type="date" required value={form.start_date} onChange={(e) => setForm({ ...form, start_date: e.target.value })}
                    className={inp} style={{ fontFamily: "inherit" }} />
                </div>
                <div>
                  <Label>End Date *</Label>
                  <input type="date" required value={form.end_date} onChange={(e) => setForm({ ...form, end_date: e.target.value })}
                    className={inp} style={{ fontFamily: "inherit" }} />
                </div>
              </div>
            </Section>

            {/* Target audience */}
            <Section title="Who Is This For?">
              {/* Scope toggle */}
              <div className="flex gap-2 mb-4">
                <ScopeBtn
                  active={scopeMode === "GROUP"}
                  icon={<Layers className="w-4 h-4" />}
                  title="All parties of a type"
                  desc="CNF, Retailer, Salesman…"
                  onClick={() => setScopeMode("GROUP")}
                />
                <ScopeBtn
                  active={scopeMode === "INDIVIDUAL"}
                  icon={<UserCheck className="w-4 h-4" />}
                  title="Specific individuals"
                  desc="Pick parties by name"
                  onClick={() => setScopeMode("INDIVIDUAL")}
                />
              </div>

              {scopeMode === "GROUP" ? (
                <div>
                  <Label>Party Type *</Label>
                  <select value={form.applicable_party_type} onChange={(e) => setForm({ ...form, applicable_party_type: e.target.value })}
                    className={sel} style={{ fontFamily: "inherit" }}>
                    {PARTY_TYPES.map((t) => <option key={t} value={t}>{t.replace(/_/g, " ")}</option>)}
                  </select>
                  <p className="text-zinc-400 mt-1.5" style={{ fontSize: "0.7rem" }}>
                    All active {form.applicable_party_type === "ALL" ? "parties" : form.applicable_party_type.replace(/_/g, " ") + " parties"} will automatically see this scheme.
                  </p>
                </div>
              ) : (
                <div>
                  <PartyPicker
                    groupType={individualGroupType}
                    onGroupTypeChange={(t) => { setIndividualGroupType(t); setSelectedParties([]); }}
                    selected={selectedParties}
                    onToggle={toggleParty}
                  />
                  <p className="text-zinc-400 mt-2" style={{ fontSize: "0.7rem" }}>
                    Only the parties you check above will see and track this scheme.
                  </p>
                </div>
              )}
            </Section>

            {/* Target & Reward */}
            <Section title="Target & Reward">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div>
                  <Label>Target Value</Label>
                  <input type="number" value={form.target_value} onChange={(e) => setForm({ ...form, target_value: e.target.value })}
                    className={inp} style={{ fontFamily: "inherit" }} placeholder="e.g. 100000" />
                </div>
                <div>
                  <Label>Reward Type</Label>
                  <select value={form.reward_type} onChange={(e) => setForm({ ...form, reward_type: e.target.value })}
                    className={sel} style={{ fontFamily: "inherit" }}>
                    {["PRODUCT", "GIFT", "TOUR"].map((t) => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <Label>Reward Value</Label>
                  <input type="number" value={form.reward_value} onChange={(e) => setForm({ ...form, reward_value: e.target.value })}
                    className={inp} style={{ fontFamily: "inherit" }} placeholder="Amount / %…" />
                </div>
              </div>
              <div>
                <Label>Reward Description</Label>
                <input value={form.reward_description} onChange={(e) => setForm({ ...form, reward_description: e.target.value })}
                  className={inp} style={{ fontFamily: "inherit" }} placeholder="e.g. Win a trip to Goa on hitting ₹1L target" />
              </div>
              <div>
                <Label>Terms & Conditions</Label>
                <textarea value={form.terms_conditions} onChange={(e) => setForm({ ...form, terms_conditions: e.target.value })}
                  rows={2} className={`${inp} resize-none`} style={{ fontFamily: "inherit" }}
                  placeholder="Optional conditions…" />
              </div>
            </Section>

            <div className="flex justify-end gap-3 pt-2">
              <button type="button" onClick={() => { setShowCreate(false); resetForm(); }}
                className="px-4 py-2 rounded-lg border border-black/10 text-zinc-600 hover:bg-black/5 text-sm transition-all"
                style={{ fontFamily: "inherit", background: "none", cursor: "pointer" }}>
                Cancel
              </button>
              <button type="submit" disabled={creating}
                className="px-6 py-2 rounded-lg bg-amber-500 text-zinc-900 hover:bg-amber-600 disabled:opacity-50 flex items-center gap-2 text-sm font-medium transition-all"
                style={{ fontFamily: "inherit", border: "none", cursor: "pointer" }}>
                {creating && <Loader2 className="w-4 h-4 animate-spin" />}
                {creating ? "Creating…" : "Create Scheme"}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {/* ── Add parties to an existing scheme ── */}
      {addPartiesTarget && (
        <Modal onClose={() => { if (!addPartiesSaving) setAddPartiesTarget(null); }}>
          <div className="flex items-start justify-between mb-5">
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-10 h-10 rounded-xl bg-violet-500/10 border border-violet-500/20 flex items-center justify-center shrink-0">
                <UserPlus className="w-5 h-5 text-violet-500" />
              </div>
              <div className="min-w-0">
                <h2 className="text-lg font-bold text-zinc-900">Add parties</h2>
                <p className="text-zinc-400 text-xs mt-0.5 truncate">
                  {addPartiesTarget.name} · {addPartiesTarget.scheme_code}
                </p>
              </div>
            </div>
            <CloseBtn onClick={() => { if (!addPartiesSaving) setAddPartiesTarget(null); }} />
          </div>

          {addPartiesError && (
            <div className="mb-4 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-500 text-sm">
              {addPartiesError}
            </div>
          )}

          {addPartiesLoading ? (
            <div className="flex items-center justify-center py-14">
              <Loader2 className="w-6 h-6 text-violet-500 animate-spin" />
            </div>
          ) : (
            <>
              {existingEnrollmentIds.length > 0 && (
                <div className="mb-4 rounded-lg border border-emerald-500/15 bg-emerald-500/[0.05] px-3 py-2 text-emerald-700" style={{ fontSize: "0.72rem" }}>
                  {existingEnrollmentIds.length} {existingEnrollmentIds.length === 1 ? "party is" : "parties are"} already enrolled. They are marked below.
                </div>
              )}
              <PartyPicker
                groupType={addPartyGroupType}
                onGroupTypeChange={(type) => { setAddPartyGroupType(type); setPartiesToAdd([]); setAddPartiesError(""); }}
                selected={partiesToAdd}
                onToggle={togglePartyToAdd}
                disabledIds={existingEnrollmentIds}
              />
            </>
          )}

          <div className="flex justify-end gap-3 mt-5 pt-4 border-t border-black/[0.06]">
            <button
              type="button"
              onClick={() => setAddPartiesTarget(null)}
              disabled={addPartiesSaving}
              className="px-4 py-2 rounded-lg border border-black/10 text-zinc-600 hover:bg-black/5 disabled:opacity-50 text-sm"
              style={{ fontFamily: "inherit", background: "none", cursor: "pointer" }}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleAddParties}
              disabled={addPartiesLoading || addPartiesSaving || partiesToAdd.length === 0}
              className="px-5 py-2 rounded-lg bg-violet-500 text-white hover:bg-violet-600 disabled:opacity-50 flex items-center gap-2 text-sm font-medium transition-all"
              style={{ fontFamily: "inherit", border: "none", cursor: "pointer" }}
            >
              {addPartiesSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <UserPlus className="w-4 h-4" />}
              {addPartiesSaving ? "Adding…" : `Add ${partiesToAdd.length || ""} ${partiesToAdd.length === 1 ? "party" : "parties"}`}
            </button>
          </div>
        </Modal>
      )}

      {/* ── Delete confirm ── */}
      {deleteTarget && (
        <Modal onClose={() => { setDeleteTarget(null); setDeleteError(""); }} small>
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-xl bg-red-500/10 border border-red-500/20 flex items-center justify-center shrink-0">
              <Trash2 className="w-5 h-5 text-red-400" />
            </div>
            <div>
              <h3 className="text-zinc-900 font-semibold">Delete Scheme</h3>
              <p className="text-zinc-400 text-sm">This action cannot be undone</p>
            </div>
          </div>
          <div className="mb-5 p-3 rounded-lg bg-black/[0.03] border border-black/[0.06]">
            <p className="text-zinc-900 font-medium text-sm">{deleteTarget.name}</p>
            <p className="text-zinc-400 font-mono mt-0.5" style={{ fontSize: "0.7rem" }}>{deleteTarget.scheme_code}</p>
            <p className="text-zinc-500 mt-1 text-xs">
              {deleteTarget.scheme_type.replace(/_/g, " ")} · {deleteTarget.applicable_party_type}
            </p>
          </div>
          {deleteError && (
            <div className="mb-4 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-500 text-sm">{deleteError}</div>
          )}
          <div className="flex gap-3">
            <button onClick={() => { setDeleteTarget(null); setDeleteError(""); }}
              className="flex-1 px-4 py-2 rounded-lg border border-black/10 text-zinc-600 hover:bg-black/5 text-sm"
              style={{ fontFamily: "inherit", background: "none", cursor: "pointer" }}>
              Cancel
            </button>
            <button onClick={handleDelete} disabled={deleting}
              className="flex-1 px-4 py-2 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 hover:bg-red-500/20 disabled:opacity-50 flex items-center justify-center gap-2 text-sm"
              style={{ fontFamily: "inherit", cursor: "pointer" }}>
              {deleting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
              Delete
            </button>
          </div>
        </Modal>
      )}

      {/* ── Manual progress edit ── */}
      {editTarget && selectedScheme && (
        <Modal onClose={() => setEditTarget(null)} small>
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-xl bg-violet-500/10 border border-violet-500/20 flex items-center justify-center shrink-0">
              <Pen className="w-5 h-5 text-violet-500" />
            </div>
            <div className="min-w-0">
              <h3 className="text-zinc-900 font-semibold">Edit Progress</h3>
              <p className="text-zinc-400 text-sm truncate">{editTarget.parties?.name || "Party"}</p>
            </div>
          </div>

          <div className="mb-4 p-3 rounded-lg bg-black/[0.03] border border-black/[0.06] flex items-center justify-between">
            <div>
              <span className="text-zinc-400 block" style={{ fontSize: "0.65rem" }}>Current</span>
              <span className="text-zinc-700 font-medium text-sm">
                {formatINR(Number(editTarget.current_value))} · {Math.min(100, Number(editTarget.progress_percent)).toFixed(1)}%
              </span>
            </div>
            <div className="text-right">
              <span className="text-zinc-400 block" style={{ fontSize: "0.65rem" }}>Target</span>
              <span className="text-zinc-700 font-medium text-sm">{formatINR(Number(editTarget.target_value))}</span>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Amount clocked (₹)</Label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400 text-sm">₹</span>
                <input
                  type="number"
                  autoFocus
                  min={0}
                  value={editValue}
                  onChange={(e) => onChangeEditValue(e.target.value)}
                  className={`${inp} pl-7`}
                  style={{ fontFamily: "inherit" }}
                  placeholder="e.g. 56000"
                />
              </div>
            </div>
            <div>
              <Label>Progress (%)</Label>
              <div className="relative">
                <input
                  type="number"
                  min={0}
                  value={editPct}
                  onChange={(e) => onChangeEditPct(e.target.value)}
                  className={inp}
                  style={{ fontFamily: "inherit" }}
                  placeholder="e.g. 70"
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-400 text-sm">%</span>
              </div>
            </div>
          </div>
          {Number(editTarget.target_value) > 0 && Number.isFinite(Number(editValue)) && (
            <p className="text-zinc-400 mt-1.5" style={{ fontSize: "0.7rem" }}>
              Sets value to {formatINR(Number(editValue) || 0)} ({Math.min(100, ((Number(editValue) || 0) / Number(editTarget.target_value)) * 100).toFixed(1)}%).
              It will keep moving as {selectedScheme.scheme_type === "INVOICE_SCHEME" ? "invoices are confirmed" : "payments are collected"}.
            </p>
          )}

          {editError && (
            <div className="mt-3 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-500 text-sm">{editError}</div>
          )}

          <div className="flex gap-3 mt-5">
            <button onClick={() => setEditTarget(null)}
              className="flex-1 px-4 py-2 rounded-lg border border-black/10 text-zinc-600 hover:bg-black/5 text-sm"
              style={{ fontFamily: "inherit", background: "none", cursor: "pointer" }}>
              Cancel
            </button>
            <button onClick={handleSaveProgress} disabled={editSaving}
              className="flex-1 px-4 py-2 rounded-lg bg-amber-500 text-zinc-900 hover:bg-amber-600 disabled:opacity-50 flex items-center justify-center gap-2 text-sm font-medium"
              style={{ fontFamily: "inherit", border: "none", cursor: "pointer" }}>
              {editSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
              Save
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ── Small reusable pieces ─────────────────────────────────────────────────────

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "2-digit" });
}

function fmtPartyNames(names: string[] | undefined): string {
  if (!names || names.length === 0) return "Selected individuals";
  if (names.length === 1) return names[0];
  if (names.length <= 3) return names.join(", ");
  return `${names.slice(0, 2).join(", ")} +${names.length - 2} more`;
}

function InfoRow({ label, value, amber, highlight }: { label: string; value: string; amber?: boolean; highlight?: boolean }) {
  return (
    <div className="flex justify-between items-center">
      <span className="text-zinc-400" style={{ fontSize: "0.7rem" }}>{label}</span>
      <span className={amber ? "text-amber-500 font-semibold" : highlight ? "text-violet-500" : "text-zinc-700"} style={{ fontSize: "0.7rem" }}>
        {value}
      </span>
    </div>
  );
}

function ProgressRow({ p, onEdit }: { p: SchemeProgress; onEdit?: () => void }) {
  const pct = Math.min(100, Number(p.progress_percent));
  const typeName = p.parties?.party_types?.name;
  const isManual = Math.abs(Number(p.manual_adjustment) || 0) > 0.5;
  return (
    <div className="rounded-lg border border-black/[0.06] bg-black/[0.02] p-4">
      <div className="flex items-center justify-between mb-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-zinc-900 font-medium text-sm truncate">{p.parties?.name || "Unknown"}</span>
            {p.is_salesman ? (
              <span className="shrink-0 inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-600" style={{ fontSize: "0.55rem" }}>
                <UserCheck className="w-2.5 h-2.5" /> SALESMAN
              </span>
            ) : typeName ? (
              <span className="shrink-0 px-1.5 py-0.5 rounded bg-black/[0.04] text-zinc-500" style={{ fontSize: "0.55rem" }}>
                {typeName.replace(/_/g, " ")}
              </span>
            ) : null}
            {isManual && (
              <span className="shrink-0 inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-violet-500/10 text-violet-600" style={{ fontSize: "0.55rem" }} title="Progress was manually adjusted">
                <Pen className="w-2.5 h-2.5" /> MANUAL
              </span>
            )}
          </div>
          {p.parties?.party_code && (
            <span className="text-zinc-400 font-mono" style={{ fontSize: "0.6rem" }}>{p.parties.party_code}</span>
          )}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <span className="text-zinc-500 text-xs">{pct.toFixed(1)}%</span>
          {p.is_achieved && (
            <span className="flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-600" style={{ fontSize: "0.55rem" }}>
              <CheckCircle2 className="w-2.5 h-2.5" /> ACHIEVED
            </span>
          )}
          {onEdit && (
            <button
              onClick={onEdit}
              className="p-1 rounded-md text-zinc-400 hover:text-violet-600 hover:bg-violet-500/10 transition-all"
              style={{ background: "none", border: "none", cursor: "pointer" }}
              title="Edit progress manually"
            >
              <Pen className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>
      <div className="w-full h-1.5 rounded-full bg-black/[0.06] overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${
            p.is_achieved ? "bg-emerald-500" : pct >= 75 ? "bg-amber-500" : "bg-blue-500"
          }`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="flex justify-between mt-1.5">
        <span className="text-zinc-400" style={{ fontSize: "0.65rem" }}>{formatINR(Number(p.current_value))}</span>
        <span className="text-zinc-400" style={{ fontSize: "0.65rem" }}>Target: {formatINR(Number(p.target_value))}</span>
      </div>
    </div>
  );
}

function Modal({ children, onClose, small }: { children: React.ReactNode; onClose: () => void; small?: boolean }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4" onClick={onClose}>
      <div
        className={`bg-white border border-black/10 rounded-2xl overflow-y-auto p-6 w-full ${small ? "max-w-sm" : "max-w-2xl max-h-[90vh]"}`}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

function CloseBtn({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick} className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-700 hover:bg-black/5 transition-all"
      style={{ background: "none", border: "none", cursor: "pointer" }}>
      <X className="w-5 h-5" />
    </button>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <label className="block text-zinc-500 text-xs mb-1">{children}</label>;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wide mb-3">{title}</h3>
      <div className="space-y-3">{children}</div>
    </div>
  );
}

function ScopeBtn({
  active, icon, title, desc, onClick,
}: {
  active: boolean;
  icon: React.ReactNode;
  title: string;
  desc: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex-1 flex items-start gap-2.5 px-4 py-3 rounded-xl border-2 text-left transition-all ${
        active
          ? "border-amber-500/50 bg-amber-500/5"
          : "border-black/[0.08] bg-black/[0.02] hover:bg-black/[0.04]"
      }`}
      style={{ fontFamily: "inherit", cursor: "pointer" }}
    >
      <span className={`mt-0.5 ${active ? "text-amber-500" : "text-zinc-400"}`}>{icon}</span>
      <div>
        <p className={`text-sm font-medium ${active ? "text-amber-600" : "text-zinc-700"}`}>{title}</p>
        <p className="text-zinc-400" style={{ fontSize: "0.7rem" }}>{desc}</p>
      </div>
      {active && <CheckCircle2 className="w-4 h-4 text-amber-500 ml-auto mt-0.5 shrink-0" />}
    </button>
  );
}
