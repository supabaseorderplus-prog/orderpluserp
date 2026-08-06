"use client";

import { useEffect, useState, useCallback } from "react";
import { api } from "@/lib/api";
import {
  ChevronDown, ChevronRight, Loader2, Users2,
  Building2, Store, Layers3, Phone, MapPin, Search, ArrowRightLeft,
  UserCheck, UserX, X, Plus, IndianRupee,
} from "lucide-react";

function fmt(n: number) {
  if (n >= 10000000) return `${(n / 10000000).toFixed(2)} Cr`;
  if (n >= 100000)   return `${(n / 100000).toFixed(2)} L`;
  if (n >= 1000)     return `${(n / 1000).toFixed(1)}K`;
  return n.toLocaleString("en-IN");
}

// ── Types ──────────────────────────────────────────────────────────────────

interface FlatParty {
  id: string;
  name: string;
  party_code: string;
  parent_party_id: string | null;
  city: string | null;
  contact_phone: string | null;
  salesman_ids: string[];
  party_types: { name: string } | null;
  opening_balance?: number | null;
  wallet_balance?: number | null;
  current_balance?: number | null;
}

interface TreeParty extends FlatParty {
  level: "CNF" | "SUPER_DEALER" | "RETAILER" | string;
  children: TreeParty[];
  isCompanyChild?: boolean;
}

interface Salesman {
  id: string;
  name: string;
  email: string;
  phone?: string | null;
  employee_code?: string | null;
  status: string;
  assigned_party_id: string | null;
  parties: FlatParty | null;
}

interface GroupRef {
  id: string;
  name: string;
  salesman_id: string | null;
  party_ids: string[];
}

interface SalesmanDownlineData {
  salesmen: Salesman[];
  allParties: FlatParty[];
  salesmanToParties: Record<string, string[]>;
  groups?: GroupRef[];
}

interface OutstandingParty {
  party_id: string;
  total_outstanding: number;
}

interface DownlineParty {
  id: string;
  name: string;
  party_code: string;
  status: string;
  city: string | null;
  contact_phone: string | null;
  parent_party_id: string | null;
  level: "CNF" | "SUPER_DEALER" | "RETAILER";
  party_types: { id: string; name: string };
  children: DownlineParty[];
  opening_balance?: number | null;
  wallet_balance?: number | null;
  current_balance?: number | null;
}

interface DownlineData {
  tree: DownlineParty[];
  companyDirectSD: DownlineParty[];
  companyDirectR: DownlineParty[];
  unattachedSD: DownlineParty[];
  unattachedR: DownlineParty[];
  companyParty: { id: string; name: string; party_code: string } | null;
}

// ── Constants ──────────────────────────────────────────────────────────────

const LEVELS = [
  { key: "CNF",          label: "CNF",          color: "text-amber-400",   bg: "bg-amber-500/10",   border: "border-amber-500/20",   Icon: Layers3   },
  { key: "SUPER_DEALER", label: "Super Dealer",  color: "text-blue-400",    bg: "bg-blue-500/10",    border: "border-blue-500/20",    Icon: Building2 },
  { key: "RETAILER",     label: "Retailer",      color: "text-emerald-400", bg: "bg-emerald-500/10", border: "border-emerald-500/20", Icon: Store     },
];

const levelMeta = Object.fromEntries(LEVELS.map((l) => [l.key, l]));

const typeToLevel = (typeName: string): string => {
  if (typeName === "CNF")          return "CNF";
  if (typeName === "SUPER_DEALER") return "SUPER_DEALER";
  if (typeName === "RETAILER")     return "RETAILER";
  return typeName;
};

// Current balance, derived server-side (opening + payments − invoices). Falls back
// to opening_balance only on older API responses that don't send current_balance.
// (wallet_balance is not a real DB column, so it's always 0 — never trust it alone.)
const effectiveBalanceOf = (p: { current_balance?: number | null; opening_balance?: number | null; wallet_balance?: number | null }): number =>
  p.current_balance !== undefined && p.current_balance !== null
    ? Number(p.current_balance)
    : Number(p.wallet_balance ?? 0) + Number(p.opening_balance ?? 0);

// All nodes beneath a node (the whole downline subtree), excluding the node itself.
const collectDescendants = <T extends { children?: T[] }>(node: T): T[] => {
  const out: T[] = [];
  for (const child of node.children ?? []) {
    out.push(child);
    out.push(...collectDescendants(child));
  }
  return out;
};

type BalanceTotals = { credit: number; dues: number; net: number };

// Combined wallet balances across a set of downline parties (each party + its
// descendants): credit (positive), dues (negative), and the net subtotal.
const balanceTotalsFor = (roots: DownlineParty[]): BalanceTotals => {
  let credit = 0;
  let dues = 0;
  const seen = new Set<string>();
  for (const root of roots) {
    for (const d of [root, ...collectDescendants(root)]) {
      if (seen.has(d.id)) continue;
      seen.add(d.id);
      const bal = effectiveBalanceOf(d);
      if (bal > 0) credit += bal;
      else if (bal < 0) dues += bal;
    }
  }
  return { credit, dues, net: credit + dues };
};

// Combined wallet balances across a single node's downline (its descendants).
const downlineBalanceTotals = (node: DownlineParty): BalanceTotals =>
  balanceTotalsFor(node.children ?? []);

// Party-portal roles that get the self-scoped downline view (their own subtree +
// liabilities) instead of the admin hierarchy. Matches both the *_USER portal
// roles and the bare party-type role names the roles table may store.
const PARTY_ROLES = new Set([
  "CNF_USER", "CNF",
  "SUPER_DEALER_USER", "SUPER_DEALER",
  "RETAILER_USER", "RETAILER",
]);

const roleToLevel = (role: string): "CNF" | "SUPER_DEALER" | "RETAILER" => {
  const r = role.toUpperCase();
  if (r.startsWith("SUPER_DEALER")) return "SUPER_DEALER";
  if (r.startsWith("RETAILER"))     return "RETAILER";
  return "CNF";
};

// Build a single subtree rooted at `rootId` from a flat node list, nesting by
// parent_party_id. Cycle-safe via a visited set; returns null if root is absent.
function buildPartyTree(rootId: string, flat: DownlineParty[]): DownlineParty | null {
  const byId = new Map<string, DownlineParty>();
  for (const n of flat) byId.set(n.id, n);
  if (!byId.has(rootId)) return null;

  const childrenByParent = new Map<string, DownlineParty[]>();
  for (const n of byId.values()) {
    const pid = n.parent_party_id ?? "";
    const list = childrenByParent.get(pid) ?? [];
    list.push(n);
    childrenByParent.set(pid, list);
  }

  const build = (id: string, seen: Set<string>): DownlineParty => {
    seen.add(id);
    const node = byId.get(id)!;
    const kids = (childrenByParent.get(id) ?? [])
      .filter((c) => !seen.has(c.id))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((c) => build(c.id, seen));
    return { ...node, children: kids };
  };

  return build(rootId, new Set<string>());
}

// Reusable per-party / per-company liability rollup card.
function LiabilityDashboard({ totals, className = "" }: { totals: BalanceTotals; className?: string }) {
  return (
    <div className={`rounded-lg border border-black/[0.06] bg-black/[0.015] px-3 py-2 space-y-1 ${className}`} style={{ fontSize: "0.7rem" }}>
      <div className="text-zinc-600 font-semibold uppercase tracking-wider pb-1 mb-1 border-b border-black/[0.06]" style={{ fontSize: "0.62rem", letterSpacing: "0.06em" }}>
        Liability Dashboard
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-zinc-500">Downline credit (balance +)</span>
        <span className="font-mono font-semibold text-emerald-500">₹{totals.credit.toLocaleString("en-IN")}</span>
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-zinc-500">Downline dues (balance −)</span>
        <span className="font-mono font-semibold text-red-400">₹{Math.abs(totals.dues).toLocaleString("en-IN")}</span>
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-black/[0.06] pt-1">
        <span className="text-zinc-600 font-medium">Net downline balance</span>
        <span className={`font-mono font-semibold ${totals.net < 0 ? "text-red-400" : totals.net > 0 ? "text-emerald-500" : "text-zinc-500"}`}>
          {totals.net < 0 ? "−" : ""}₹{Math.abs(totals.net).toLocaleString("en-IN")}
        </span>
      </div>
    </div>
  );
}

const s: React.CSSProperties  = { transform: "none", filter: "none", WebkitTextStroke: "0", background: "none", boxShadow: "none", display: "block", padding: 0 };
const inp: React.CSSProperties = { fontSize: "0.8rem", fontFamily: "inherit" };

// ── Party Hierarchy Node ───────────────────────────────────────────────────

function PartyNode({
  node, depth = 0, onTransfer, allNodes, readonly = false,
}: {
  node: DownlineParty;
  depth?: number;
  onTransfer?: (node: DownlineParty) => void;
  allNodes: DownlineParty[];
  readonly?: boolean;
}) {
  const [open, setOpen] = useState(depth < 2);
  const meta = levelMeta[node.level];
  const Icon = meta?.Icon ?? Layers3;
  const hasChildren = node.children.length > 0;
  const nextLevel = node.level === "CNF" ? "SUPER_DEALER" : node.level === "SUPER_DEALER" ? "RETAILER" : null;
  const nextMeta  = nextLevel ? levelMeta[nextLevel] : null;
  const canTransfer = !readonly && node.level !== "CNF";
  const downlineTotals = hasChildren ? downlineBalanceTotals(node) : null;

  return (
    <div className={`${depth > 0 ? "ml-6 border-l border-black/[0.06] pl-4" : ""}`}>
      <div className={`flex items-center gap-2 rounded-lg px-3 py-2.5 mb-1 border ${meta?.border ?? "border-black/10"} ${meta?.bg ?? ""} group`}>
        <button
          onClick={() => setOpen((v) => !v)}
          className="shrink-0 text-zinc-500 hover:text-zinc-900 transition-colors"
          style={{ background: "none", border: "none", cursor: hasChildren ? "pointer" : "default", padding: 0 }}
        >
          {hasChildren ? (open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />) : <span className="w-3.5 h-3.5 block" />}
        </button>

        <Icon className={`w-4 h-4 shrink-0 ${meta?.color ?? "text-zinc-600"}`} />

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-zinc-900 font-medium" style={{ fontSize: "0.82rem" }}>{node.name}</span>
            {meta && <span className={`text-[0.6rem] px-1.5 py-0.5 rounded font-medium ${meta.bg} ${meta.color} border ${meta.border}`}>{meta.label}</span>}
            <span className="text-zinc-600" style={{ fontSize: "0.7rem" }}>{node.party_code}</span>
          </div>
          <div className="flex items-center gap-3 mt-0.5 flex-wrap">
            {node.city && <span className="text-zinc-500 flex items-center gap-1" style={{ fontSize: "0.7rem" }}><MapPin className="w-3 h-3" />{node.city}</span>}
            {node.contact_phone && <span className="text-zinc-500 flex items-center gap-1" style={{ fontSize: "0.7rem" }}><Phone className="w-3 h-3" />{node.contact_phone}</span>}
            {hasChildren && <span className="text-zinc-600" style={{ fontSize: "0.7rem" }}>{node.children.length} {nextMeta?.label ?? "child"}{node.children.length !== 1 ? "s" : ""}</span>}
            {node.level !== "CNF" && (() => {
              const bal = effectiveBalanceOf(node);
              return (
                <span
                  className={`font-semibold px-1.5 py-0.5 rounded-md ${bal < 0 ? "bg-red-500/10 text-red-400" : bal > 0 ? "bg-emerald-500/10 text-emerald-400" : "bg-zinc-500/15 text-zinc-500"}`}
                  style={{ fontSize: "0.7rem" }}
                >
                  ₹{Math.abs(bal).toLocaleString("en-IN")}
                </span>
              );
            })()}
          </div>
        </div>

        {canTransfer && (
          <button
            onClick={() => onTransfer?.(node)}
            title={`Move ${meta?.label} to another ${node.level === "SUPER_DEALER" ? "CNF" : "Super Dealer"}`}
            className="shrink-0 opacity-0 group-hover:opacity-100 flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-black/10 text-zinc-600 hover:text-zinc-900 hover:border-black/20 hover:bg-black/5 transition-all"
            style={{ fontSize: "0.7rem", fontFamily: "inherit", background: "none", cursor: "pointer" }}
          >
            <ArrowRightLeft className="w-3 h-3" />
            Transfer
          </button>
        )}
      </div>

      {/* Combined wallet balances across this party's downline */}
      {downlineTotals && <LiabilityDashboard totals={downlineTotals} className="ml-6 mb-1" />}

      {open && hasChildren && (
        <div className="mb-1">
          {node.children.map((child) => (
            <PartyNode key={child.id} node={child} depth={depth + 1} onTransfer={onTransfer} allNodes={allNodes} readonly={readonly} />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Salesman Downline Tree Node ────────────────────────────────────────────

function SalesmanPartyNode({
  node, depth = 0, takenBy = {}, allParties = [], allSalesmen = [], currentSalesmanId = "", onRefresh, readonly = false, duesByParty = {},
}: {
  node: TreeParty;
  depth?: number;
  takenBy?: Record<string, string>;
  allParties?: FlatParty[];
  allSalesmen?: Salesman[];
  currentSalesmanId?: string;
  onRefresh?: () => void;
  readonly?: boolean;
  duesByParty?: Record<string, number>;
}) {
  const [open, setOpen]                     = useState(depth < 2);
  const [showMove, setShowMove]             = useState(false);
  const [moveSearch, setMoveSearch]         = useState("");
  const [selectedSalesmanId, setSelectedSm] = useState("");
  const [selectedParentId, setSelectedPar]  = useState("");
  const [moving, setMoving]                 = useState(false);
  const [moveError, setMoveError]           = useState("");

  const level = typeToLevel(node.party_types?.name ?? "");
  const meta  = levelMeta[level];
  const Icon  = meta?.Icon ?? Store;
  const hasChildren = node.children.length > 0;
  // Only genuine structural children (parent_party_id points at THIS party) count
  // as sub-parties — never siblings/orphans grouped under the node for display.
  const subPartyCount = node.children.filter((c) => c.parent_party_id === node.id).length;
  const invoiceDue = Math.max(0, Number(duesByParty[node.id] || 0));
  const effectiveBal = effectiveBalanceOf(node);
  const walletDue  = Math.max(0, -effectiveBal);
  const partyDue   = Math.max(invoiceDue, walletDue);

  const openMove = () => {
    setSelectedSm("");
    setSelectedPar("");
    setMoveSearch("");
    setMoveError("");
    setShowMove(true);
  };

  // When a salesman is picked, figure out the new parent automatically:
  // - SD → put under that salesman's CNF (their assigned_party_id)
  // - Retailer → put under that salesman's CNF's first Super Dealer (or CNF if none)
  const getSalesmanCNF = (smId: string): FlatParty | undefined =>
    allSalesmen.find((s) => s.id === smId)?.parties ?? undefined;

  const handleMove = async () => {
    if (!selectedSalesmanId) { setMoveError("Please select a salesman"); return; }
    const newParentId = selectedParentId;
    if (!newParentId) { setMoveError("Selected salesman has no assigned CNF party"); return; }
    setMoving(true); setMoveError("");
    try {
      const json = await api<{ success: boolean; message?: string }>("/api/v1/downline", {
        method: "PATCH",
        body: { id: node.id, parent_party_id: newParentId },
      });
      if (!json.success) throw new Error(json.message ?? "Failed");
      setShowMove(false);
      onRefresh?.();
    } catch (e: unknown) {
      setMoveError(e instanceof Error ? e.message : "Failed");
    }
    setMoving(false);
  };

  // Salesman options: exclude current salesman
  const salesmanOptions = allSalesmen.filter((s) => s.id !== currentSalesmanId && s.assigned_party_id);
  const filteredSalesmen = salesmanOptions.filter((s) => {
    const q = moveSearch.toLowerCase();
    return !q || s.name.toLowerCase().includes(q) || s.email.toLowerCase().includes(q);
  });

  // When salesman is selected, auto-pick the parent:
  // For SD → parent is that salesman's CNF
  // For Retailer → parent is first SD under that CNF, or CNF itself
  const handleSelectSalesman = (smId: string) => {
    setSelectedSm(smId);
    const sm = allSalesmen.find((s) => s.id === smId);
    if (!sm?.assigned_party_id) { setSelectedPar(""); return; }
    if (level === "SUPER_DEALER") {
      setSelectedPar(sm.assigned_party_id);
    } else {
      // Retailer: find a Super Dealer under this CNF
      const sd = allParties.find(
        (p) => p.parent_party_id === sm.assigned_party_id && typeToLevel(p.party_types?.name ?? "") === "SUPER_DEALER"
      );
      setSelectedPar(sd?.id ?? sm.assigned_party_id);
    }
  };

  // For retailers: list of SDs under selected salesman's CNF for further picking
  const availableSDs = selectedSalesmanId && level === "RETAILER"
    ? allParties.filter((p) => {
        const sm = allSalesmen.find((s) => s.id === selectedSalesmanId);
        return sm?.assigned_party_id && p.parent_party_id === sm.assigned_party_id && typeToLevel(p.party_types?.name ?? "") === "SUPER_DEALER";
      })
    : [];

  return (
    <>
      <div className={`${depth > 0 ? "ml-5 border-l border-black/[0.06] pl-3" : ""}`}>
        <div className={`flex items-center gap-2 rounded-lg px-3 py-2 mb-1 border ${meta?.border ?? "border-black/10"} ${meta?.bg ?? "bg-black/[0.02]"}`}>
          <button
            onClick={() => setOpen((v) => !v)}
            className="shrink-0 text-zinc-500 hover:text-zinc-900 transition-colors"
            style={{ background: "none", border: "none", cursor: hasChildren ? "pointer" : "default", padding: 0 }}
          >
            {hasChildren ? (open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />) : <span className="w-3 h-3 block" />}
          </button>

          <Icon className={`w-3.5 h-3.5 shrink-0 ${meta?.color ?? "text-zinc-600"}`} />

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-zinc-900" style={{ fontSize: "0.78rem" }}>{node.name}</span>
              {meta && <span className={`text-[0.58rem] px-1.5 py-0.5 rounded font-medium ${meta.bg} ${meta.color} border ${meta.border}`}>{meta.label}</span>}
              <span className="text-zinc-600" style={{ fontSize: "0.65rem" }}>{node.party_code}</span>
              {depth === 0 && node.isCompanyChild && (
                <span className="text-[0.58rem] px-1.5 py-0.5 rounded font-medium bg-amber-500/10 text-amber-400 border border-amber-500/20 flex items-center gap-1">
                  <Building2 className="w-2.5 h-2.5" />Company Downline
                </span>
              )}
            </div>
            <div className="flex items-center gap-3 mt-0.5 flex-wrap">
              {node.city && <span className="text-zinc-500 flex items-center gap-1" style={{ fontSize: "0.65rem" }}><MapPin className="w-2.5 h-2.5" />{node.city}</span>}
              {node.contact_phone && <span className="text-zinc-500 flex items-center gap-1" style={{ fontSize: "0.65rem" }}><Phone className="w-2.5 h-2.5" />{node.contact_phone}</span>}
              {subPartyCount > 0 && <span className="text-zinc-600" style={{ fontSize: "0.65rem" }}>{subPartyCount} sub-{subPartyCount !== 1 ? "parties" : "party"}</span>}
            </div>
          </div>

          {/* Due badge — always visible, red if owed, green if clear */}
          <div className={`shrink-0 flex items-center gap-1 px-2 py-1 rounded-lg border font-mono font-semibold ${
            partyDue > 0
              ? "bg-red-500/10 border-red-500/20 text-red-400"
              : "bg-emerald-500/10 border-emerald-500/20 text-emerald-500"
          }`} style={{ fontSize: "0.7rem" }}>
            <IndianRupee className="w-2.5 h-2.5 shrink-0" />
            {partyDue > 0 ? partyDue.toLocaleString("en-IN") : "Clear"}
          </div>

          {/* Change downline button — hidden in readonly mode */}
          {!readonly && (
            <button
              onClick={openMove}
              title={`Move ${meta?.label} to another salesman's downline`}
              className="shrink-0 flex items-center gap-1.5 px-2 py-1 rounded-lg border border-black/10 text-zinc-600 hover:text-amber-400 hover:border-amber-500/30 hover:bg-amber-500/5 transition-all"
              style={{ fontSize: "0.65rem", fontFamily: "inherit", background: "none", cursor: "pointer" }}
            >
              <ArrowRightLeft className="w-2.5 h-2.5" />
              Change
            </button>
          )}
        </div>

        {open && hasChildren && (
          <div className="mb-1">
            {node.children.map((child) => (
              <SalesmanPartyNode
                  key={child.id}
                  node={child}
                  depth={depth + 1}
                  takenBy={takenBy}
                  allParties={allParties}
                  allSalesmen={allSalesmen}
                  currentSalesmanId={currentSalesmanId}
                  onRefresh={onRefresh}
                  readonly={readonly}
                  duesByParty={duesByParty}
                />
            ))}
          </div>
        )}
      </div>

      {/* ── Change Downline Modal ── */}
      {showMove && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setShowMove(false)}>
          <div className="w-full max-w-sm rounded-xl border border-black/10 bg-[#ffffff] p-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="text-zinc-900 font-semibold" style={{ fontSize: "1rem" }}>Change Downline</h2>
                <p className="text-zinc-500 mt-0.5" style={{ fontSize: "0.73rem" }}>
                  Move <span className="text-zinc-700">{node.name}</span> to another salesman downline
                </p>
              </div>
              <button onClick={() => setShowMove(false)} className="p-1 rounded-lg hover:bg-black/10 text-zinc-600 hover:text-zinc-900 transition-colors" style={{ background: "none", border: "none", cursor: "pointer" }}>
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Salesman search */}
            <p className="text-zinc-500 mb-2" style={{ fontSize: "0.68rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>Select Salesman</p>
            <div className="relative mb-3">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-500" />
              <input
                type="text"
                placeholder="Search salesman..."
                value={moveSearch}
                onChange={(e) => setMoveSearch(e.target.value)}
                className="w-full pl-9 pr-4 py-2 rounded-lg border border-black/10 bg-black/[0.03] text-zinc-900 placeholder:text-zinc-500 outline-none focus:border-amber-500/40"
                style={inp}
                autoFocus
              />
            </div>

            <div className="max-h-48 overflow-y-auto space-y-1 mb-4">
              {filteredSalesmen.length === 0 && (
                <p className="text-zinc-600 text-center py-4" style={{ fontSize: "0.75rem" }}>No other salesmen with an assigned CNF found</p>
              )}
              {filteredSalesmen.map((s) => {
                const isSelected = selectedSalesmanId === s.id;
                const cnf = getSalesmanCNF(s.id);
                return (
                  <button
                    key={s.id}
                    onClick={() => handleSelectSalesman(s.id)}
                    className={`w-full text-left px-3 py-2.5 rounded-lg border transition-all ${isSelected ? "border-amber-500/40 bg-amber-500/10" : "border-black/[0.06] hover:border-black/10 hover:bg-black/[0.02]"}`}
                    style={{ fontSize: "0.78rem", fontFamily: "inherit", cursor: "pointer", background: isSelected ? undefined : "none" }}
                  >
                    <div className={`font-medium ${isSelected ? "text-amber-400" : "text-zinc-700"}`}>{s.name}</div>
                    <div className="text-zinc-600 mt-0.5" style={{ fontSize: "0.62rem" }}>
                      {s.email}
                      {cnf && <span className="ml-2 text-zinc-500">→ {cnf.name}</span>}
                    </div>
                  </button>
                );
              })}
            </div>

            {/* If Retailer: pick which Super Dealer under that salesman */}
            {level === "RETAILER" && selectedSalesmanId && availableSDs.length > 0 && (
              <div className="mb-4">
                <p className="text-zinc-500 mb-2" style={{ fontSize: "0.68rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>Place Under Super Dealer</p>
                <div className="space-y-1 max-h-32 overflow-y-auto">
                  {availableSDs.map((sd) => (
                    <button
                      key={sd.id}
                      onClick={() => setSelectedPar(sd.id)}
                      className={`w-full text-left px-3 py-2 rounded-lg border transition-all ${selectedParentId === sd.id ? "border-blue-500/40 bg-blue-500/10 text-blue-400" : "border-black/[0.06] text-zinc-600 hover:border-black/10 hover:bg-black/[0.02]"}`}
                      style={{ fontSize: "0.75rem", fontFamily: "inherit", cursor: "pointer", background: selectedParentId === sd.id ? undefined : "none" }}
                    >
                      {sd.name} <span className="text-zinc-600" style={{ fontSize: "0.62rem" }}>{sd.party_code}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {moveError && <p className="mb-3 text-red-400" style={{ fontSize: "0.73rem" }}>{moveError}</p>}

            <div className="flex justify-end gap-2">
              <button onClick={() => setShowMove(false)} className="px-4 py-2 rounded-lg border border-black/10 text-zinc-600 hover:text-zinc-900 hover:bg-black/5 transition-colors" style={{ fontSize: "0.78rem", fontFamily: "inherit", background: "none", cursor: "pointer" }}>Cancel</button>
              <button
                onClick={handleMove}
                disabled={moving || !selectedSalesmanId || !selectedParentId}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg font-medium bg-amber-500 hover:bg-amber-400 text-black transition-colors disabled:opacity-40"
                style={{ fontSize: "0.78rem", fontFamily: "inherit", cursor: "pointer", border: "none" }}
              >
                {moving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                {moving ? "Moving..." : "Confirm"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────

export default function DownlinePage() {
  // Detect if the logged-in user is a salesman — read synchronously so there is no flash
  const [isSalesman] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    try {
      const u = JSON.parse(localStorage.getItem("user") || "{}");
      return u?.role === "SALESMAN";
    } catch { return false; }
  });

  const [companyContext, setCompanyContext] = useState<{ name: string; code: string } | null>(() => {
    if (typeof window === "undefined") return null;
    try {
      const u = JSON.parse(localStorage.getItem("user") || "{}");
      if (u?.party_name) return { name: u.party_name, code: u.party_code ?? "" };
      return null;
    } catch { return null; }
  });

  // Party-portal users (CNF / Super Dealer / Retailer) get a self-scoped view of
  // their own subtree + downline liabilities — never the admin hierarchy/tabs.
  // The /api/v1/downline GET is already scoped to authUser.party_id server-side.
  const [partySelf] = useState<{ id: string; name: string; code: string; role: string } | null>(() => {
    if (typeof window === "undefined") return null;
    try {
      const u = JSON.parse(localStorage.getItem("user") || "{}");
      const role = String(u?.role || "").toUpperCase();
      if (!PARTY_ROLES.has(role) || !u?.party_id) return null;
      return { id: u.party_id, name: u.party_name || "My Business", code: u.party_code || "", role };
    } catch { return null; }
  });
  const isPartyUser = !!partySelf;

  const [activeTab, setActiveTab] = useState<"hierarchy" | "salesman">(() =>
    isSalesman ? "salesman" : "hierarchy"
  );

  // If party_name not in localStorage (older session), use activeCompanyName as fallback
  useEffect(() => {
    if (companyContext) return;
    try {
      const name = localStorage.getItem("activeCompanyName");
      if (name) setCompanyContext({ name, code: "" });
    } catch {}
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Party hierarchy state
  const [data, setData]       = useState<DownlineData | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch]   = useState("");

  // Add modal state
  const [showModal, setShowModal] = useState(false);
  const [form, setForm]           = useState({ name: "", party_code: "", level: "CNF", parent_party_id: "", address_line1: "", city: "", contact_phone: "" });
  const [parentLabel, setParentLabel] = useState("");
  const [saving, setSaving]       = useState(false);
  const [saveError, setSaveError] = useState("");

  // Transfer state
  const [transferNode, setTransferNode]       = useState<DownlineParty | null>(null);
  const [transferParentId, setTransferParentId] = useState("");
  const [transferring, setTransferring]       = useState(false);
  const [transferError, setTransferError]     = useState("");
  const [companyDirectCollapsed, setCompanyDirectCollapsed] = useState(false);

  // Salesman downline state
  const [sdData, setSdData]     = useState<SalesmanDownlineData | null>(null);
  const [sdLoading, setSdLoading] = useState(false);
  const [sdSearch, setSdSearch] = useState("");
  const [duesByParty, setDuesByParty] = useState<Record<string, number>>({});
  const [selfReceivablesExpanded, setSelfReceivablesExpanded] = useState(false);

  // ── Fetch ────────────────────────────────────────────────────────────────

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api<{ data: DownlineData }>("/api/v1/downline");
      setData(res.data);
    } catch { setData(null); }
    setLoading(false);
  }, []);

  const fetchSalesmanData = useCallback(async () => {
    setSdLoading(true);
    try {
      const [sdRes, outstandingRes] = await Promise.all([
        api<{ data: SalesmanDownlineData }>("/api/v1/salesman-downline"),
        api<{ success: boolean; data: OutstandingParty[] }>("/api/v1/payments/outstanding").catch(() => ({ success: true, data: [] as OutstandingParty[] })),
      ]);

      const dueMap: Record<string, number> = {};
      for (const party of outstandingRes.data || []) {
        const due = Number(party.total_outstanding || 0);
        if (due > 0) dueMap[party.party_id] = due;
      }
      // Also capture negative effective balance (derived current balance) as dues
      for (const party of sdRes.data?.allParties || []) {
        const effectiveBal = effectiveBalanceOf(party);
        const walletDue = Math.max(0, -effectiveBal);
        if (walletDue > 0) {
          dueMap[party.id] = Math.max(dueMap[party.id] || 0, walletDue);
        }
      }

      setSdData(sdRes.data);
      setDuesByParty(dueMap);
    } catch {
      setSdData(null);
      setDuesByParty({});
    }
    setSdLoading(false);
  }, []);

  // Fetch on mount
  useEffect(() => { if (isSalesman) { fetchSalesmanData(); } }, [isSalesman, fetchSalesmanData]);
  useEffect(() => { if (!isSalesman) fetchData(); }, [isSalesman, fetchData]);
  useEffect(() => { if (!isSalesman && activeTab === "salesman") fetchSalesmanData(); }, [isSalesman, activeTab, fetchSalesmanData]);

  // ── Party hierarchy helpers ───────────────────────────────────────────────

  const flatten = (nodes: DownlineParty[]): DownlineParty[] =>
    nodes.flatMap((n) => [n, ...flatten(n.children)]);

    const allNodes  = data ? [
      ...flatten(data.tree),
      ...flatten(data.companyDirectSD),
      ...data.companyDirectR,
      ...data.unattachedSD,
      ...data.unattachedR,
    ] : [];
  const searchLow = search.toLowerCase();
  const matchIds  = search
    ? new Set(allNodes.filter((n) => n.name.toLowerCase().includes(searchLow) || n.party_code.toLowerCase().includes(searchLow)).map((n) => n.id))
    : null;

  const totalCNF = data?.tree.length ?? 0;
  const totalSD  = allNodes.filter((n) => n.level === "SUPER_DEALER").length;
  const totalRT  = allNodes.filter((n) => n.level === "RETAILER").length;

  const openAdd = (level: string, parentId = "", parentName = "") => {
    setForm({ name: "", party_code: "", level, parent_party_id: parentId, address_line1: "", city: "", contact_phone: "" });
    setParentLabel(parentName);
    setSaveError("");
    setShowModal(true);
  };

  const handleSave = async () => {
    if (!form.name.trim()) { setSaveError("Name is required"); return; }
    setSaving(true); setSaveError("");
    try {
      await api("/api/v1/downline", { method: "POST", body: form });
      setShowModal(false);
      fetchData();
    } catch (e: unknown) { setSaveError(e instanceof Error ? e.message : "Failed to create"); }
    setSaving(false);
  };

  const openTransfer = (node: DownlineParty) => {
    setTransferNode(node);
    setTransferParentId(node.parent_party_id || "");
    setTransferError("");
  };

  const handleTransfer = async () => {
    if (!transferNode || !transferParentId) { setTransferError("Please select a destination"); return; }
    setTransferring(true); setTransferError("");
    try {
      await api("/api/v1/downline", { method: "PATCH", body: { id: transferNode.id, parent_party_id: transferParentId } });
      setTransferNode(null);
      fetchData();
    } catch (e: unknown) { setTransferError(e instanceof Error ? e.message : "Failed to transfer"); }
    setTransferring(false);
  };

  // ── Salesman downline helpers ─────────────────────────────────────────────

  const getSalesmanTree = (sm: Salesman): TreeParty | null => {
    if (!sdData) return null;
    const myPartyIdSet = new Set(sdData.salesmanToParties[sm.id] ?? []);
    const smParties = sdData.allParties.filter(p => myPartyIdSet.has(p.id));
    if (smParties.length === 0) return null;

    const smPartyIds = new Set(smParties.map(p => p.id));

    function buildSalesmanTree(nodeId: string): TreeParty {
      const node = sdData!.allParties.find(p => p.id === nodeId)!;
      const children = sdData!.allParties
        .filter(p => p.parent_party_id === nodeId && smPartyIds.has(p.id))
        .map(p => buildSalesmanTree(p.id));
      return { ...node, level: typeToLevel(node.party_types?.name ?? ""), children };
    }

    // Determine root: prefer the assigned_party_id, but if it's a COMPANY type
    // (no meaningful level), skip it and use salesman's parties directly.
    const assignedParty = sm.assigned_party_id
      ? sdData.allParties.find(p => p.id === sm.assigned_party_id)
      : null;
    const assignedLevel = assignedParty ? typeToLevel(assignedParty.party_types?.name ?? "") : "";
    const isCompanyRoot = !assignedLevel || assignedLevel === "COMPANY" || !levelMeta[assignedLevel];

    let root: TreeParty;

    // Find top-level owned parties: those whose parent is NOT another owned party
    const topLevel = smParties.filter(p => !smPartyIds.has(p.parent_party_id ?? ""));
    if (topLevel.length === 0) return null;

    if (!isCompanyRoot && sm.assigned_party_id) {
      // Normal case: assigned party is a CNF/SD.
      // Only use it as root if it IS one of the salesman's owned top-level parties.
      // Otherwise build tree from the actual top-level owned parties directly.
      const assignedIsOwned = smPartyIds.has(sm.assigned_party_id);
      if (assignedIsOwned) {
        const assignedRoot = buildSalesmanTree(sm.assigned_party_id);
        // Parties owned by the salesman but NOT structural descendants of the
        // assigned party. They must never be shown as that party's sub-parties
        // (their parent_party_id points elsewhere), so surface them as their own
        // top-level groups under a salesman-level container instead of stapling
        // them onto the assigned root. Each orphan root keeps its real subtree.
        const reachableIds = new Set<string>();
        const collectIds = (n: TreeParty) => { reachableIds.add(n.id); n.children.forEach(collectIds); };
        collectIds(assignedRoot);
        const orphanRoots = smParties
          .filter(p => !reachableIds.has(p.id) && !smPartyIds.has(p.parent_party_id ?? ""))
          .map(p => buildSalesmanTree(p.id));
        if (orphanRoots.length === 0) {
          root = assignedRoot;
        } else {
          const base = smParties[0];
          root = { ...base, id: `virtual-${sm.id}`, name: sm.name, party_code: "", level: "CNF", children: [assignedRoot, ...orphanRoots], isCompanyChild: true };
        }
      } else {
        // Assigned CNF is not directly owned — build from owned top-level parties
        if (topLevel.length === 1) {
          root = buildSalesmanTree(topLevel[0].id);
        } else {
          const children = topLevel.map(p => buildSalesmanTree(p.id));
          const base = smParties[0];
          root = { ...base, id: `virtual-${sm.id}`, name: sm.name, party_code: "", level: "CNF", children };
        }
        // Mark each top-level node as company child if its parent is not a CNF/SD
        const cnfSdIds = new Set(sdData!.allParties.filter(p => {
          const lvl = typeToLevel(p.party_types?.name ?? "");
          return lvl === "CNF" || lvl === "SUPER_DEALER";
        }).map(p => p.id));
        if (topLevel.length === 1) {
          const parentId = topLevel[0].parent_party_id;
          if (!parentId || !cnfSdIds.has(parentId)) root.isCompanyChild = true;
        }
      }
    } else {
      // Salesman is assigned to the company or has no assignment — build from owned top-level parties
      if (topLevel.length === 1) {
        root = buildSalesmanTree(topLevel[0].id);
        root.isCompanyChild = true;
      } else {
        const children = topLevel.map(p => buildSalesmanTree(p.id));
        const base = smParties[0];
        root = { ...base, id: `virtual-${sm.id}`, name: sm.name, party_code: "", level: "CNF", children, isCompanyChild: true };
      }
    }

    return root;
  };

  const filteredSalesmen = (sdData?.salesmen ?? []).filter((sm) => {
    const q = sdSearch.toLowerCase();
    return !q || sm.name.toLowerCase().includes(q) || sm.email.toLowerCase().includes(q);
  });

  // ── Render ────────────────────────────────────────────────────────────────

  // ── Party self-view (CNF / Super Dealer / Retailer portals) ───────────────
  if (isPartyUser && partySelf) {
    // The downline GET is already scoped to this party's subtree. Flatten every
    // bucket into one list, then rebuild a single tree rooted at this party.
    const flat = data
      ? [
          ...flatten(data.tree),
          ...flatten(data.companyDirectSD),
          ...data.companyDirectR,
          ...data.unattachedSD,
          ...data.unattachedR,
        ]
      : [];
    const myTree = buildPartyTree(partySelf.id, flat);
    const myNode = flat.find((n) => n.id === partySelf.id) ?? null;
    const myName = myNode?.name || partySelf.name;
    const myCode = myNode?.party_code || partySelf.code;
    const myLevel = myNode?.level ?? roleToLevel(partySelf.role);
    const myMeta  = levelMeta[myLevel];
    const MyIcon  = myMeta?.Icon ?? Building2;
    const myBalance = myNode ? effectiveBalanceOf(myNode) : 0;

    const downlineTotals  = myTree ? downlineBalanceTotals(myTree) : { credit: 0, dues: 0, net: 0 };
    const totalDownlineDues = Math.abs(downlineTotals.dues);
    const descendants = myTree ? collectDescendants(myTree) : [];
    // Downline parties carrying a negative balance (they owe up the chain), most owed first.
    const owing = descendants
      .filter((d) => effectiveBalanceOf(d) < 0)
      .sort((a, b) => effectiveBalanceOf(a) - effectiveBalanceOf(b));

    const searchLow = search.toLowerCase();
    const partyMatchIds = search
      ? new Set(
          descendants
            .filter((d) => d.name.toLowerCase().includes(searchLow) || d.party_code.toLowerCase().includes(searchLow))
            .map((d) => d.id),
        )
      : null;
    const visibleChildren = (myTree?.children ?? []).filter(
      (n) => !partyMatchIds || partyMatchIds.has(n.id) || flatten([n]).some((c) => partyMatchIds.has(c.id)),
    );

    return (
      <div style={{ fontFamily: "'Inter','system-ui',sans-serif" }}>
        <div className="mb-6">
          <h1 className="text-xl lg:text-2xl font-bold text-zinc-900" style={{ ...s, marginBottom: "0.25rem" }}>My Downline</h1>
          <p className="text-zinc-600" style={{ fontSize: "0.8rem", margin: 0 }}>Your distribution hierarchy &amp; downline liabilities</p>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-20"><Loader2 className="w-8 h-8 text-amber-500 animate-spin" /></div>
        ) : (
          <div className="space-y-4">
            {/* Card 1 — who you are + your own balance */}
            <div className="rounded-xl border border-black/[0.07] bg-black/[0.02] overflow-hidden">
              <div className="flex items-center gap-3 px-4 py-3">
                <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 border ${myMeta?.bg ?? "bg-amber-500/15"} ${myMeta?.border ?? "border-amber-500/25"}`}>
                  <MyIcon className={`w-4 h-4 ${myMeta?.color ?? "text-amber-400"}`} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-zinc-900 font-semibold" style={{ fontSize: "0.9rem" }}>{myName}</span>
                    {myMeta && <span className={`text-[0.6rem] px-1.5 py-0.5 rounded font-medium ${myMeta.bg} ${myMeta.color} border ${myMeta.border}`}>{myMeta.label}</span>}
                    {myCode && <span className="text-zinc-600 font-mono" style={{ fontSize: "0.7rem" }}>{myCode}</span>}
                  </div>
                  {(myNode?.city || myNode?.contact_phone) && (
                    <div className="flex items-center gap-3 mt-0.5 flex-wrap">
                      {myNode?.city && <span className="text-zinc-500 flex items-center gap-1" style={{ fontSize: "0.7rem" }}><MapPin className="w-3 h-3" />{myNode.city}</span>}
                      {myNode?.contact_phone && <span className="text-zinc-500 flex items-center gap-1" style={{ fontSize: "0.7rem" }}><Phone className="w-3 h-3" />{myNode.contact_phone}</span>}
                    </div>
                  )}
                </div>
                <div className="text-right shrink-0">
                  <div className={`font-mono font-bold ${myBalance < 0 ? "text-red-400" : myBalance > 0 ? "text-emerald-500" : "text-zinc-500"}`} style={{ fontSize: "0.95rem" }}>
                    {myBalance < 0 ? "−" : ""}₹{Math.abs(myBalance).toLocaleString("en-IN")}
                  </div>
                  <div className="text-zinc-500" style={{ fontSize: "0.6rem" }}>
                    {myBalance < 0 ? "you owe" : myBalance > 0 ? "credit" : "settled"}
                  </div>
                </div>
              </div>
            </div>

            {/* Card 2 — combined downline liabilities */}
            <div className={`rounded-xl border overflow-hidden ${totalDownlineDues > 0 ? "border-red-500/20 bg-red-500/[0.02]" : "border-emerald-500/20 bg-emerald-500/[0.02]"}`}>
              <div className={`flex items-center gap-2 px-4 py-2.5 border-b ${totalDownlineDues > 0 ? "border-red-500/10" : "border-emerald-500/10"}`}>
                <IndianRupee className={`w-3.5 h-3.5 shrink-0 ${totalDownlineDues > 0 ? "text-red-400" : "text-emerald-500"}`} />
                <span className="text-zinc-500 font-medium flex-1" style={{ fontSize: "0.68rem", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                  Combined Downline Liabilities
                </span>
                {owing.length > 0 && (
                  <span className="text-[0.58rem] px-1.5 py-0.5 rounded bg-red-500/10 text-red-400 border border-red-500/20 font-medium">
                    {owing.length} {owing.length === 1 ? "party owes you" : "parties owe you"}
                  </span>
                )}
              </div>

              <div className="px-4 py-3 grid grid-cols-3 gap-2">
                <div>
                  <div className="text-zinc-500" style={{ fontSize: "0.62rem" }}>Credit (balance +)</div>
                  <div className="font-mono font-semibold text-emerald-500" style={{ fontSize: "0.85rem" }}>₹{downlineTotals.credit.toLocaleString("en-IN")}</div>
                </div>
                <div>
                  <div className="text-zinc-500" style={{ fontSize: "0.62rem" }}>Dues (balance −)</div>
                  <div className="font-mono font-semibold text-red-400" style={{ fontSize: "0.85rem" }}>₹{totalDownlineDues.toLocaleString("en-IN")}</div>
                </div>
                <div>
                  <div className="text-zinc-500" style={{ fontSize: "0.62rem" }}>Net</div>
                  <div className={`font-mono font-semibold ${downlineTotals.net < 0 ? "text-red-400" : downlineTotals.net > 0 ? "text-emerald-500" : "text-zinc-500"}`} style={{ fontSize: "0.85rem" }}>
                    {downlineTotals.net < 0 ? "−" : ""}₹{Math.abs(downlineTotals.net).toLocaleString("en-IN")}
                  </div>
                </div>
              </div>

              {owing.length > 0 && (
                <>
                  <button
                    onClick={() => setSelfReceivablesExpanded((v) => !v)}
                    className="w-full flex items-center justify-between px-4 py-2 border-t border-black/[0.05]"
                    style={{ background: "none", border: "none", cursor: "pointer" }}
                  >
                    <span className="text-zinc-500" style={{ fontSize: "0.7rem" }}>Parties with a negative balance</span>
                    {selfReceivablesExpanded ? <ChevronDown className="w-3.5 h-3.5 text-zinc-400" /> : <ChevronRight className="w-3.5 h-3.5 text-zinc-400" />}
                  </button>
                  {selfReceivablesExpanded && (
                    <div className="px-4 pb-3 space-y-1.5">
                      {owing.map((p) => {
                        const due  = Math.abs(effectiveBalanceOf(p));
                        const meta = levelMeta[p.level];
                        const Icon = meta?.Icon ?? Store;
                        return (
                          <div key={p.id} className="flex items-center justify-between px-3 py-2 rounded-lg border border-red-500/10 bg-red-500/[0.03]">
                            <div className="flex items-center gap-2 min-w-0">
                              <Icon className={`w-3 h-3 shrink-0 ${meta?.color ?? "text-zinc-500"}`} />
                              <div className="min-w-0">
                                <div className="text-zinc-800 font-medium truncate" style={{ fontSize: "0.78rem" }}>{p.name}</div>
                                <div className="flex items-center gap-1.5">
                                  <span className="text-zinc-500 font-mono" style={{ fontSize: "0.62rem" }}>{p.party_code}</span>
                                  {p.city && <span className="text-zinc-500" style={{ fontSize: "0.62rem" }}>· {p.city}</span>}
                                </div>
                              </div>
                            </div>
                            <div className="shrink-0 text-right ml-3">
                              <div className="text-red-400 font-mono font-semibold" style={{ fontSize: "0.78rem" }}>₹{due.toLocaleString("en-IN")}</div>
                              <div className="text-zinc-400" style={{ fontSize: "0.58rem" }}>owes you</div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </>
              )}
            </div>

            {/* Card 3 — the downline tree */}
            <div className="rounded-xl border border-black/[0.07] bg-black/[0.02] overflow-hidden">
              <div className="px-4 py-3">
                <p className="text-zinc-600 mb-3" style={{ fontSize: "0.68rem", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                  Downline Hierarchy
                </p>

                {(myTree?.children.length ?? 0) > 0 && (
                  <div className="relative mb-3">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
                    <input
                      type="text"
                      placeholder="Search downline by name or code..."
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      className="w-full pl-10 pr-4 py-2.5 rounded-lg border border-black/10 bg-black/[0.03] text-zinc-900 placeholder:text-zinc-500 outline-none focus:border-amber-500/40"
                      style={inp}
                    />
                  </div>
                )}

                {!myTree || myTree.children.length === 0 ? (
                  <div className="text-center py-10 text-zinc-500">
                    <Users2 className="w-10 h-10 mx-auto mb-3 opacity-30" />
                    <p style={{ fontSize: "0.8rem" }}>No parties in your downline yet</p>
                  </div>
                ) : visibleChildren.length === 0 ? (
                  <div className="text-center py-8 text-zinc-500">
                    <Search className="w-8 h-8 mx-auto mb-2 opacity-30" />
                    <p style={{ fontSize: "0.8rem" }}>No downline party matched your search</p>
                  </div>
                ) : (
                  <div className="space-y-1">
                    {visibleChildren.map((child) => (
                      <PartyNode key={child.id} node={child} depth={0} allNodes={[]} readonly />
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ── Salesman self-view ───────────────────────────────────────────────────
  if (isSalesman) {
    const mySalesman = sdData?.salesmen[0] ?? null;
    const myTree = mySalesman && sdData ? getSalesmanTree(mySalesman) : null;
    const myPartyIds = mySalesman ? new Set(sdData?.salesmanToParties[mySalesman.id] ?? []) : new Set<string>();
    const myDownlinePartyIds = myTree ? collectTreePartyIds(myTree) : myPartyIds;
    const myReceivableParties = (sdData?.allParties ?? [])
      .filter((p) => myDownlinePartyIds.has(p.id) && Number(duesByParty[p.id] || 0) > 0)
      .sort((a, b) => Number(duesByParty[b.id] || 0) - Number(duesByParty[a.id] || 0));
    const totalMyDownlineDues = myReceivableParties.reduce((sum, p) => sum + Number(duesByParty[p.id] || 0), 0);

    return (
      <div style={{ fontFamily: "'Inter','system-ui',sans-serif" }}>
        <div className="mb-6">
          <h1 className="text-xl lg:text-2xl font-bold text-zinc-900" style={{ ...s, marginBottom: "0.25rem" }}>My Downline</h1>
          <p className="text-zinc-600" style={{ fontSize: "0.8rem", margin: 0 }}>Your assigned distribution hierarchy</p>
        </div>

        {sdLoading ? (
          <div className="flex items-center justify-center py-20"><Loader2 className="w-8 h-8 text-amber-500 animate-spin" /></div>
        ) : !mySalesman ? (
          <div className="text-center py-20 text-zinc-500">
            <UserX className="w-12 h-12 mx-auto mb-4 opacity-30" />
            <p style={{ fontSize: "0.875rem" }}>No downline assigned to your account yet</p>
          </div>
        ) : (
          <>
          {/* Card 1: My info */}
          <div className="rounded-xl border border-black/[0.07] bg-black/[0.02] overflow-hidden">
            <div className="flex items-center gap-3 px-4 py-3">
              <div className="w-9 h-9 rounded-full bg-violet-500/20 border border-violet-500/30 flex items-center justify-center shrink-0">
                <span className="text-violet-400 font-semibold" style={{ fontSize: "0.72rem" }}>{mySalesman.name.charAt(0).toUpperCase()}</span>
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-zinc-900 font-medium" style={{ fontSize: "0.85rem" }}>{mySalesman.name}</span>
                  <span className="text-[0.6rem] px-1.5 py-0.5 rounded font-medium bg-violet-500/10 text-violet-400 border border-violet-500/20">SALESMAN</span>
                </div>
                {(mySalesman.employee_code || mySalesman.phone) && (
                  <div className="text-zinc-500 mt-0.5 font-mono" style={{ fontSize: "0.7rem" }}>
                    {mySalesman.employee_code || mySalesman.phone}
                  </div>
                )}
              </div>
              {mySalesman.parties && (() => {
                const ptMeta = levelMeta[typeToLevel(mySalesman.parties.party_types?.name ?? "")];
                return ptMeta ? (
                  <div className="text-right shrink-0">
                    <div className={`font-medium ${ptMeta.color}`} style={{ fontSize: "0.78rem" }}>{mySalesman.parties.name}</div>
                    <div className="flex items-center gap-1 justify-end mt-0.5">
                      <span className={`text-[0.6rem] px-1.5 py-0.5 rounded ${ptMeta.bg} ${ptMeta.color} border ${ptMeta.border}`}>{ptMeta.label}</span>
                    </div>
                  </div>
                ) : null;
              })()}
            </div>
          </div>

          {/* Card 2: Combined Downline Dues — standalone section */}
          <div className={`rounded-xl border overflow-hidden ${totalMyDownlineDues > 0 ? "border-red-500/20 bg-red-500/[0.02]" : "border-emerald-500/20 bg-emerald-500/[0.02]"}`}>
            {/* Section header */}
            <div className={`flex items-center gap-2 px-4 py-2.5 border-b ${totalMyDownlineDues > 0 ? "border-red-500/10" : "border-emerald-500/10"}`}>
              <IndianRupee className={`w-3.5 h-3.5 shrink-0 ${totalMyDownlineDues > 0 ? "text-red-400" : "text-emerald-500"}`} />
              <span className="text-zinc-500 font-medium flex-1" style={{ fontSize: "0.68rem", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                Combined Downline Dues
              </span>
              {myReceivableParties.length > 0 && (
                <span className="text-[0.58rem] px-1.5 py-0.5 rounded bg-red-500/10 text-red-400 border border-red-500/20 font-medium">
                  {myReceivableParties.length} {myReceivableParties.length === 1 ? "party" : "parties"}
                </span>
              )}
            </div>

            {/* Amount row + expand */}
            <button
              onClick={() => setSelfReceivablesExpanded((v) => !v)}
              className="w-full flex items-center justify-between px-4 py-3"
              style={{ background: "none", border: "none", cursor: "pointer" }}
            >
              <span className="text-zinc-500" style={{ fontSize: "0.75rem" }}>
                {totalMyDownlineDues > 0 ? "Total outstanding from your parties" : "All clear — no outstanding dues"}
              </span>
              <div className="flex items-center gap-2">
                <span className={`font-mono font-bold ${totalMyDownlineDues > 0 ? "text-red-400" : "text-emerald-500"}`} style={{ fontSize: "1rem" }}>
                  ₹{totalMyDownlineDues.toLocaleString("en-IN")}
                </span>
                {selfReceivablesExpanded
                  ? <ChevronDown className="w-3.5 h-3.5 text-zinc-400" />
                  : <ChevronRight className="w-3.5 h-3.5 text-zinc-400" />}
              </div>
            </button>

            {/* Expanded party list */}
            {selfReceivablesExpanded && (
              <div className="px-4 pb-3">
                {myReceivableParties.length > 0 ? (
                  <div className="space-y-1.5">
                    {myReceivableParties.map((p) => {
                      const due = Number(duesByParty[p.id] || 0);
                      const lvl = typeToLevel(p.party_types?.name ?? "");
                      const meta = levelMeta[lvl];
                      const Icon = meta?.Icon ?? Store;
                      return (
                        <div key={p.id} className="flex items-center justify-between px-3 py-2 rounded-lg border border-red-500/10 bg-red-500/[0.03]">
                          <div className="flex items-center gap-2 min-w-0">
                            <Icon className={`w-3 h-3 shrink-0 ${meta?.color ?? "text-zinc-500"}`} />
                            <div className="min-w-0">
                              <div className="text-zinc-800 font-medium truncate" style={{ fontSize: "0.78rem" }}>{p.name}</div>
                              <div className="flex items-center gap-1.5">
                                <span className="text-zinc-500 font-mono" style={{ fontSize: "0.62rem" }}>{p.party_code}</span>
                                {p.city && <span className="text-zinc-500" style={{ fontSize: "0.62rem" }}>· {p.city}</span>}
                              </div>
                            </div>
                          </div>
                          <div className="shrink-0 text-right ml-3">
                            <div className="text-red-400 font-mono font-semibold" style={{ fontSize: "0.78rem" }}>₹{due.toLocaleString("en-IN")}</div>
                            <div className="text-zinc-400" style={{ fontSize: "0.58rem" }}>due</div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="text-emerald-600" style={{ fontSize: "0.72rem" }}>
                    No dues in your downline.
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Card 3: Downline tree */}
          <div className="rounded-xl border border-black/[0.07] bg-black/[0.02] overflow-hidden">
            {myTree ? (
              <div className="px-4 py-3">
                <p className="text-zinc-600 mb-3" style={{ fontSize: "0.68rem", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                  Downline Hierarchy
                </p>
                <SalesmanPartyNode node={myTree} depth={0} readonly duesByParty={duesByParty} />
              </div>
            ) : (
              <div className="px-4 py-6 text-center text-zinc-600" style={{ fontSize: "0.8rem" }}>
                No parties in your downline yet
              </div>
            )}
          </div>
          </>
        )}
      </div>
    );
  }

  return (
    <div style={{ fontFamily: "'Inter','system-ui',sans-serif" }}>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-xl lg:text-2xl font-bold text-zinc-900" style={{ ...s, marginBottom: "0.25rem" }}>Downline</h1>
          <p className="text-zinc-600" style={{ fontSize: "0.8rem", margin: 0 }}>Distribution hierarchy — CNF → Super Dealer → Retailer</p>
        </div>
      </div>

      {/* Company context banner */}
      {companyContext && (
        <div className="flex items-center gap-3 mb-6 px-4 py-3 rounded-xl border border-amber-500/20 bg-amber-500/[0.06]">
          <div className="w-8 h-8 rounded-lg bg-amber-500/15 border border-amber-500/25 flex items-center justify-center shrink-0">
            <Building2 className="w-4 h-4 text-amber-400" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-zinc-600 mb-0.5" style={{ fontSize: "0.68rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>You are under</p>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-amber-300 font-semibold" style={{ fontSize: "0.9rem" }}>{companyContext.name}</span>
              {companyContext.code && (
                <span className="text-[0.6rem] px-1.5 py-0.5 rounded font-mono font-medium bg-amber-500/10 text-amber-500 border border-amber-500/20">{companyContext.code}</span>
              )}
            </div>
            <p className="text-zinc-500 mt-0.5" style={{ fontSize: "0.7rem" }}>Showing downline network for this company</p>
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 mb-6 p-1 rounded-xl border border-black/10 bg-black/[0.02] w-fit">
        {[
          { key: "hierarchy", label: "Party Hierarchy",    Icon: Layers3    },
          { key: "salesman",  label: "Salesman Downline",  Icon: UserCheck  },
        ].map(({ key, label, Icon }) => (
          <button
            key={key}
            onClick={() => setActiveTab(key as "hierarchy" | "salesman")}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-all ${activeTab === key ? "bg-amber-500 text-black font-semibold" : "text-zinc-600 hover:text-zinc-900"}`}
            style={{ fontSize: "0.8rem", fontFamily: "inherit", border: "none", cursor: "pointer", background: activeTab === key ? undefined : "none" }}
          >
            <Icon className="w-3.5 h-3.5" />
            {label}
          </button>
        ))}
      </div>

      {/* ── PARTY HIERARCHY TAB ── */}
      {activeTab === "hierarchy" && (<>
        {/* Stats */}
        <div className="grid grid-cols-3 gap-3 mb-6">
          {[
            { count: totalCNF, statLabel: "CNF", ...levelMeta["CNF"] },
            { count: totalSD, statLabel: "Super Dealers", ...levelMeta["SUPER_DEALER"] },
            { count: totalRT, statLabel: "Retailers", ...levelMeta["RETAILER"] },
          ].map(({ statLabel, count, color, bg, border, Icon }) => (
            <div key={statLabel} className={`rounded-xl border ${border} ${bg} px-4 py-3 flex items-center gap-3`}>
              <Icon className={`w-5 h-5 ${color} shrink-0`} />
              <div>
                <div className={`text-lg font-bold ${color}`} style={{ lineHeight: 1 }}>{count}</div>
                <div className="text-zinc-500 mt-0.5" style={{ fontSize: "0.7rem" }}>{statLabel}</div>
              </div>
            </div>
          ))}
        </div>

        {/* Search */}
        <div className="relative mb-5">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
          <input
            type="text"
            placeholder="Search by name or code..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-10 pr-4 py-2.5 rounded-lg border border-black/10 bg-black/[0.03] text-zinc-900 placeholder:text-zinc-500 outline-none focus:border-amber-500/40"
            style={inp}
          />
        </div>

        {/* Tree */}
        {loading ? (
          <div className="flex items-center justify-center py-20"><Loader2 className="w-8 h-8 text-amber-500 animate-spin" /></div>
          ) : !data || (data.tree.length === 0 && data.companyDirectSD.length === 0 && data.companyDirectR.length === 0 && data.unattachedSD.length === 0 && data.unattachedR.length === 0) ? (
          <div className="text-center py-20 text-zinc-500">
            <Users2 className="w-12 h-12 mx-auto mb-4 opacity-30" />
            <p style={{ fontSize: "0.875rem" }}>No downline parties yet</p>
            <button onClick={() => openAdd("CNF")} className="mt-4 px-4 py-2 rounded-lg bg-amber-500 hover:bg-amber-400 text-black text-sm font-medium transition-colors" style={{ border: "none", cursor: "pointer", fontFamily: "inherit" }}>
              Add your first CNF
            </button>
          </div>
        ) : (
            <div className="space-y-1">
              {/* CNF-rooted tree */}
              {data.tree
                .filter((n) => !matchIds || matchIds.has(n.id) || flatten([n]).some((c) => matchIds.has(c.id)))
                .map((node) => (
                  <PartyNode key={node.id} node={node} depth={0} onTransfer={openTransfer} allNodes={allNodes} />
                ))}

              {/* Company-direct section */}
              {(data.companyDirectSD.length > 0 || data.companyDirectR.length > 0) && (
                <div className="mt-4">
                  {/* Company header row — click to fold/unfold the list */}
                  <button
                    type="button"
                    onClick={() => setCompanyDirectCollapsed((v) => !v)}
                    aria-expanded={!companyDirectCollapsed}
                    className="w-full flex items-center gap-2 rounded-lg px-3 py-2.5 mb-1 border border-amber-500/30 bg-amber-500/[0.08] hover:bg-amber-500/[0.14] transition-colors text-left"
                    style={{ cursor: "pointer" }}
                  >
                    {companyDirectCollapsed
                      ? <ChevronRight className="w-3.5 h-3.5 shrink-0 text-amber-400" />
                      : <ChevronDown className="w-3.5 h-3.5 shrink-0 text-amber-400" />}
                    <Building2 className="w-4 h-4 shrink-0 text-amber-400" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-zinc-900 font-medium" style={{ fontSize: "0.82rem" }}>
                          {companyContext?.name ?? "Company"}
                        </span>
                        <span className="text-[0.6rem] px-1.5 py-0.5 rounded font-medium bg-amber-500/10 text-amber-400 border border-amber-500/20">COMPANY</span>
                        {companyContext?.code && (
                          <span className="text-zinc-600 font-mono" style={{ fontSize: "0.7rem" }}>{companyContext.code}</span>
                        )}
                        <span className="text-zinc-500" style={{ fontSize: "0.65rem" }}>
                          ({data.companyDirectSD.length + data.companyDirectR.length})
                        </span>
                      </div>
                      <div className="text-zinc-500 mt-0.5" style={{ fontSize: "0.7rem" }}>
                        Parties directly under company downline
                      </div>
                    </div>
                  </button>

                  {/* Company-level liability rollup across the entire direct downline */}
                  <LiabilityDashboard
                    totals={balanceTotalsFor([...data.companyDirectSD, ...data.companyDirectR])}
                    className="ml-6 mb-1"
                  />

                  {/* Children indented */}
                  {!companyDirectCollapsed && (
                    <div className="ml-6 border-l border-black/[0.06] pl-4 space-y-1">
                      {data.companyDirectSD
                        .filter((n) => !matchIds || matchIds.has(n.id) || flatten([n]).some((c) => matchIds.has(c.id)))
                        .map((node) => (
                          <PartyNode key={node.id} node={node} depth={1} onTransfer={openTransfer} allNodes={allNodes} />
                        ))}
                      {data.companyDirectR
                        .filter((n) => !matchIds || matchIds.has(n.id))
                        .map((node) => (
                          <PartyNode key={node.id} node={node} depth={1} onTransfer={openTransfer} allNodes={allNodes} />
                        ))}
                    </div>
                  )}
                </div>
              )}

            {data.unattachedSD.length > 0 && (
              <div className="mt-4">
                <p className="text-zinc-600 mb-2 px-1" style={{ fontSize: "0.7rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>Unattached Super Dealers</p>
                {data.unattachedSD.filter((n) => !matchIds || matchIds.has(n.id)).map((node) => (
                  <PartyNode key={node.id} node={node} depth={0} onTransfer={openTransfer} allNodes={allNodes} />
                ))}
              </div>
            )}

            {data.unattachedR.length > 0 && (
              <div className="mt-4">
                <p className="text-zinc-600 mb-2 px-1" style={{ fontSize: "0.7rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>Unattached Retailers</p>
                {data.unattachedR.filter((n) => !matchIds || matchIds.has(n.id)).map((node) => (
                  <PartyNode key={node.id} node={node} depth={0} onTransfer={openTransfer} allNodes={allNodes} />
                ))}
              </div>
            )}
          </div>
        )}
      </>)}

      {/* ── SALESMAN DOWNLINE TAB ── */}
      {activeTab === "salesman" && (
        <div>
          {/* Search */}
          <div className="relative mb-5">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
            <input
              type="text"
              placeholder="Search salesman by name or email..."
              value={sdSearch}
              onChange={(e) => setSdSearch(e.target.value)}
              className="w-full pl-10 pr-4 py-2.5 rounded-lg border border-black/10 bg-black/[0.03] text-zinc-900 placeholder:text-zinc-500 outline-none focus:border-amber-500/40"
              style={inp}
            />
          </div>

          {sdLoading ? (
            <div className="flex items-center justify-center py-20"><Loader2 className="w-8 h-8 text-amber-500 animate-spin" /></div>
          ) : !sdData || sdData.salesmen.length === 0 ? (
            <div className="text-center py-20 text-zinc-500">
              <UserCheck className="w-12 h-12 mx-auto mb-4 opacity-30" />
              <p style={{ fontSize: "0.875rem" }}>No salesman accounts found</p>
            </div>
          ) : filteredSalesmen.length === 0 ? (
            <div className="text-center py-20 text-zinc-500">
              <Search className="w-10 h-10 mx-auto mb-3 opacity-30" />
              <p style={{ fontSize: "0.875rem" }}>No salesman matched your search</p>
            </div>
          ) : (
              <div className="space-y-3">
                {filteredSalesmen.map((sm) => {
                  const tree = getSalesmanTree(sm);
                  return (
                    <SalesmanCard
                      key={sm.id}
                      sm={sm}
                      tree={tree}
                      allSalesmen={sdData!.salesmen}
                      allParties={sdData!.allParties}
                      groups={sdData!.groups ?? []}
                      duesByParty={duesByParty}
                      onRefresh={fetchSalesmanData}
                    />
                  );
                })}
            </div>
          )}
        </div>
      )}

      {/* ── Add Party Modal ── */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setShowModal(false)}>
          <div className="w-full max-w-md rounded-xl border border-black/10 bg-[#ffffff] p-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-5">
              <div>
                <h2 className="text-lg font-semibold text-zinc-900" style={{ ...s, fontSize: "1.05rem" }}>Add {levelMeta[form.level]?.label}</h2>
                {parentLabel && <p className="text-zinc-500 mt-0.5" style={{ fontSize: "0.75rem" }}>Under: <span className="text-zinc-700">{parentLabel}</span></p>}
              </div>
              <button onClick={() => setShowModal(false)} className="p-1 rounded-lg hover:bg-black/10 text-zinc-600 hover:text-zinc-900 transition-colors" style={{ background: "none", border: "none", cursor: "pointer" }}>
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-4">
              {!form.parent_party_id && (
                <div>
                  <label className="block text-zinc-600 mb-1.5" style={{ fontSize: "0.7rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>Level *</label>
                  <div className="flex gap-2">
                    {LEVELS.map((l) => (
                      <button
                        key={l.key}
                        onClick={() => setForm((f) => ({ ...f, level: l.key }))}
                        className={`flex-1 py-2 rounded-lg border text-center transition-colors ${form.level === l.key ? `${l.bg} ${l.color} ${l.border}` : "border-black/10 text-zinc-500 hover:border-black/20 hover:text-zinc-700"}`}
                        style={{ fontSize: "0.75rem", background: "none", cursor: "pointer", fontFamily: "inherit" }}
                      >
                        {l.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div>
                <label className="block text-zinc-600 mb-1.5" style={{ fontSize: "0.7rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>Name *</label>
                <input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="Party / Business name" className="w-full px-3 py-2.5 rounded-lg border border-black/10 bg-black/[0.03] text-zinc-900 placeholder:text-zinc-500 outline-none focus:border-amber-500/40" style={inp} />
              </div>

              <div>
                <label className="block text-zinc-600 mb-1.5" style={{ fontSize: "0.7rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>Address</label>
                <input value={form.address_line1} onChange={(e) => setForm((f) => ({ ...f, address_line1: e.target.value }))} placeholder="Street / Shop address" className="w-full px-3 py-2.5 rounded-lg border border-black/10 bg-black/[0.03] text-zinc-900 placeholder:text-zinc-500 outline-none focus:border-amber-500/40" style={inp} />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-zinc-600 mb-1.5" style={{ fontSize: "0.7rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>Code</label>
                  <input value={form.party_code} onChange={(e) => setForm((f) => ({ ...f, party_code: e.target.value }))} placeholder="Auto-generated" className="w-full px-3 py-2.5 rounded-lg border border-black/10 bg-black/[0.03] text-zinc-900 placeholder:text-zinc-500 outline-none focus:border-amber-500/40" style={inp} />
                </div>
                <div>
                  <label className="block text-zinc-600 mb-1.5" style={{ fontSize: "0.7rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>City</label>
                  <input value={form.city} onChange={(e) => setForm((f) => ({ ...f, city: e.target.value }))} placeholder="City" className="w-full px-3 py-2.5 rounded-lg border border-black/10 bg-black/[0.03] text-zinc-900 placeholder:text-zinc-500 outline-none focus:border-amber-500/40" style={inp} />
                </div>
              </div>

              <div>
                <label className="block text-zinc-600 mb-1.5" style={{ fontSize: "0.7rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>Phone</label>
                <input value={form.contact_phone} onChange={(e) => setForm((f) => ({ ...f, contact_phone: e.target.value }))} placeholder="+91 98765 43210" className="w-full px-3 py-2.5 rounded-lg border border-black/10 bg-black/[0.03] text-zinc-900 placeholder:text-zinc-500 outline-none focus:border-amber-500/40" style={inp} />
              </div>
            </div>

            {saveError && <p className="mt-3 text-red-400" style={{ fontSize: "0.75rem" }}>{saveError}</p>}

            <div className="flex justify-end gap-3 mt-6">
              <button onClick={() => setShowModal(false)} className="px-4 py-2.5 rounded-lg border border-black/10 text-zinc-600 hover:text-zinc-900 hover:bg-black/5 transition-colors" style={{ fontSize: "0.8rem", fontFamily: "inherit", background: "none", cursor: "pointer" }}>Cancel</button>
              <button
                onClick={handleSave}
                disabled={saving}
                className={`flex items-center gap-2 px-5 py-2.5 rounded-lg font-medium transition-colors disabled:opacity-50 ${levelMeta[form.level]?.key === "CNF" ? "bg-amber-500 hover:bg-amber-400 text-black" : levelMeta[form.level]?.key === "SUPER_DEALER" ? "bg-blue-500 hover:bg-blue-400 text-zinc-900" : "bg-emerald-500 hover:bg-emerald-400 text-zinc-900"}`}
                style={{ fontSize: "0.8rem", fontFamily: "inherit", cursor: "pointer", border: "none" }}
              >
                {saving && <Loader2 className="w-4 h-4 animate-spin" />}
                {saving ? "Saving..." : `Add ${levelMeta[form.level]?.label}`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Transfer Modal ── */}
      {transferNode && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setTransferNode(null)}>
          <div className="w-full max-w-sm rounded-xl border border-black/10 bg-[#ffffff] p-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-5">
              <div>
                <h2 className="text-lg font-semibold text-zinc-900" style={{ ...s, fontSize: "1.05rem" }}>Transfer</h2>
                <p className="text-zinc-500 mt-0.5" style={{ fontSize: "0.75rem" }}>
                  Moving: <span className="text-zinc-700">{transferNode.name}</span>
                  <span className={`ml-2 text-[0.6rem] px-1.5 py-0.5 rounded font-medium ${levelMeta[transferNode.level].bg} ${levelMeta[transferNode.level].color} border ${levelMeta[transferNode.level].border}`}>
                    {levelMeta[transferNode.level].label}
                  </span>
                </p>
              </div>
              <button onClick={() => setTransferNode(null)} className="p-1 rounded-lg hover:bg-black/10 text-zinc-600 hover:text-zinc-900 transition-colors" style={{ background: "none", border: "none", cursor: "pointer" }}>
                <X className="w-5 h-5" />
              </button>
            </div>

              <div>
                <label className="block text-zinc-600 mb-1.5" style={{ fontSize: "0.7rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                  Move under {transferNode.level === "SUPER_DEALER" ? "CNF" : "Super Dealer"} *
                </label>
                <select
                  value={transferParentId}
                  onChange={(e) => setTransferParentId(e.target.value)}
                  className="w-full px-3 py-2.5 rounded-lg border border-amber-500/40 bg-[#ffffff] text-zinc-700 outline-none focus:border-amber-500/60"
                  style={inp}
                >
                  <option value="">— Select destination —</option>
                  {/* Company downline option */}
                  {data?.companyParty && (
                    <option value={data.companyParty.id}>
                      {data.companyParty.name} — Company Downline ({data.companyParty.party_code})
                    </option>
                  )}
                  {allNodes
                    .filter((n) => transferNode.level === "SUPER_DEALER" ? n.level === "CNF" : n.level === "SUPER_DEALER")
                    .filter((n) => n.id !== transferNode.id)
                    .map((n) => <option key={n.id} value={n.id}>{n.name} ({n.party_code})</option>)}
                </select>
              </div>

            {transferError && <p className="mt-3 text-red-400" style={{ fontSize: "0.75rem" }}>{transferError}</p>}

            <div className="flex justify-end gap-3 mt-6">
              <button onClick={() => setTransferNode(null)} className="px-4 py-2.5 rounded-lg border border-black/10 text-zinc-600 hover:text-zinc-900 hover:bg-black/5 transition-colors" style={{ fontSize: "0.8rem", fontFamily: "inherit", background: "none", cursor: "pointer" }}>Cancel</button>
              <button
                onClick={handleTransfer}
                disabled={transferring || !transferParentId}
                className="flex items-center gap-2 px-5 py-2.5 rounded-lg font-medium bg-amber-500 hover:bg-amber-400 text-black transition-colors disabled:opacity-50"
                style={{ fontSize: "0.8rem", fontFamily: "inherit", cursor: "pointer", border: "none" }}
              >
                {transferring && <Loader2 className="w-4 h-4 animate-spin" />}
                {transferring ? "Transferring..." : "Confirm Transfer"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Downline Group Row (expandable: members + combined & individual dues) ──

function GroupRow({
  group, allParties, duesByParty,
}: {
  group: GroupRef;
  allParties: FlatParty[];
  duesByParty: Record<string, number>;
}) {
  const [open, setOpen] = useState(false);

  const partyIdSet = new Set(group.party_ids);
  // Member parties we can render (in scope). Combined due sums over every member
  // id via duesByParty so an out-of-scope party still counts toward the total.
  const members = allParties.filter((p) => partyIdSet.has(p.id));
  const memberCount = group.party_ids.length;
  const combinedDue = group.party_ids.reduce((sum, id) => sum + Number(duesByParty[id] || 0), 0);

  return (
    <div className="rounded-lg border border-amber-500/15 bg-amber-500/[0.04] overflow-hidden">
      {/* Group header — click name/chevron to expand the member list */}
      <div className="flex items-center gap-2 px-2.5 py-1.5">
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-2 flex-1 min-w-0 text-left"
          title="Show parties in this group"
          style={{ background: "none", border: "none", cursor: "pointer", padding: 0 }}
        >
          {open
            ? <ChevronDown className="w-3 h-3 text-amber-500 shrink-0" />
            : <ChevronRight className="w-3 h-3 text-amber-500 shrink-0" />}
          <Layers3 className="w-3.5 h-3.5 text-amber-500 shrink-0" />
          <div className="min-w-0">
            <div className="text-zinc-800 font-medium truncate" style={{ fontSize: "0.78rem" }}>{group.name}</div>
            <div className="text-zinc-500" style={{ fontSize: "0.62rem" }}>{memberCount} {memberCount === 1 ? "party" : "parties"}</div>
          </div>
        </button>

        {/* Combined due across the group's parties */}
        <div className="shrink-0 text-right">
          <div className={`font-mono font-semibold ${combinedDue > 0 ? "text-red-400" : "text-emerald-500"}`} style={{ fontSize: "0.78rem" }}>
            ₹{combinedDue.toLocaleString("en-IN")}
          </div>
          <div className="text-zinc-400" style={{ fontSize: "0.55rem" }}>{combinedDue > 0 ? "combined due" : "all clear"}</div>
        </div>
      </div>

      {/* Expanded member list with individual dues / credit */}
      {open && (
        <div className="border-t border-amber-500/10 px-2.5 py-2 space-y-1 bg-black/[0.015]">
          {members.length === 0 ? (
            <p className="text-zinc-500 text-center py-2" style={{ fontSize: "0.7rem" }}>No parties in this group</p>
          ) : (
            members.map((p) => {
              const due = Number(duesByParty[p.id] || 0);
              const bal = effectiveBalanceOf(p);
              const lvl = typeToLevel(p.party_types?.name ?? "");
              const meta = levelMeta[lvl];
              const Icon = meta?.Icon ?? Store;
              return (
                <div key={p.id} className="flex items-center justify-between gap-2 px-2 py-1.5 rounded-md border border-black/[0.05] bg-white/50">
                  <div className="flex items-center gap-2 min-w-0">
                    <Icon className={`w-3 h-3 shrink-0 ${meta?.color ?? "text-zinc-500"}`} />
                    <div className="min-w-0">
                      <div className="text-zinc-800 font-medium truncate" style={{ fontSize: "0.75rem" }}>{p.name}</div>
                      <div className="flex items-center gap-1.5">
                        <span className="text-zinc-500 font-mono" style={{ fontSize: "0.6rem" }}>{p.party_code}</span>
                        {p.city && <span className="text-zinc-500" style={{ fontSize: "0.6rem" }}>· {p.city}</span>}
                      </div>
                    </div>
                  </div>
                  <div className="shrink-0 text-right ml-2">
                    {due > 0 ? (
                      <>
                        <div className="text-red-400 font-mono font-semibold" style={{ fontSize: "0.75rem" }}>₹{due.toLocaleString("en-IN")}</div>
                        <div className="text-zinc-400" style={{ fontSize: "0.55rem" }}>due</div>
                      </>
                    ) : bal > 0 ? (
                      <>
                        <div className="text-emerald-500 font-mono font-semibold" style={{ fontSize: "0.75rem" }}>₹{bal.toLocaleString("en-IN")}</div>
                        <div className="text-zinc-400" style={{ fontSize: "0.55rem" }}>credit</div>
                      </>
                    ) : (
                      <div className="text-zinc-400 font-mono" style={{ fontSize: "0.7rem" }}>Clear</div>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

// ── Salesman Card (expandable downline) ───────────────────────────────────

function SalesmanCard({
  sm, tree, allSalesmen, allParties, groups = [], onRefresh, duesByParty,
}: {
  sm: Salesman;
  tree: TreeParty | null;
  allSalesmen: Salesman[];
  allParties: FlatParty[];
  groups?: GroupRef[];
  onRefresh: () => void;
  duesByParty: Record<string, number>;
}) {
  const myGroups = groups.filter((g) => g.salesman_id === sm.id);
  // Combined members across every group in this salesman's downline — deduped so
  // a party that sits in two groups is counted once (true distinct headcount).
  const groupMemberIds = new Set<string>();
  myGroups.forEach((g) => g.party_ids.forEach((id) => groupMemberIds.add(id)));
  const groupsCombinedMembers = groupMemberIds.size;
  // Combined due across every group's parties — shown on the section header.
  const groupsCombinedDue = myGroups.reduce(
    (sum, g) => sum + g.party_ids.reduce((s, id) => s + Number(duesByParty[id] || 0), 0),
    0,
  );
  const [groupsExpanded, setGroupsExpanded] = useState(false);
  const [receivablesExpanded, setReceivablesExpanded] = useState(false);
  const [showChange, setShowChange]     = useState(false);
  const [partySearch, setPartySearch]   = useState("");
  const [selectedPartyId, setSelected] = useState(sm.assigned_party_id ?? "");
  const [saving, setSaving]             = useState(false);
  const [saveError, setSaveError]       = useState("");

  // Assign Parties modal state
  const [showAssign, setShowAssign]     = useState(false);
  const [assignSearch, setAssignSearch] = useState("");
  const [checkedIds, setCheckedIds]     = useState<Set<string>>(new Set());
  const [assigning, setAssigning]       = useState(false);
  const [assignError, setAssignError]   = useState("");

  // Parties currently assigned to this salesman (from junction table)
  const myPartyIds = new Set(allParties.filter(p => p.salesman_ids.includes(sm.id)).map(p => p.id));
  const myDownlinePartyIds = tree ? collectTreePartyIds(tree) : myPartyIds;

  // Receivables: parties in this salesman's downline with outstanding dues.
  const receivableParties = allParties.filter(p => {
    if (!myDownlinePartyIds.has(p.id)) return false;
    return Number(duesByParty[p.id] || 0) > 0;
  });
  const totalReceivable = receivableParties.reduce((s, p) =>
    s + Number(duesByParty[p.id] || 0), 0
  );

  // Build a map of partyId → salesman names[] for multi-assignment display
  const partyTakenBy: Record<string, string[]> = {};
  allSalesmen.forEach((s) => {
    if (s.id === sm.id) return;
    allParties.filter(p => p.salesman_ids.includes(s.id)).forEach(p => {
      if (!partyTakenBy[p.id]) partyTakenBy[p.id] = [];
      partyTakenBy[p.id].push(s.name);
    });
  });

  const openAssign = () => {
    setCheckedIds(new Set(myPartyIds));
    setAssignSearch("");
    setAssignError("");
    setShowAssign(true);
  };

  const toggleParty = (id: string) => {
    setCheckedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const handleSaveAssign = async () => {
    setAssigning(true); setAssignError("");
    try {
      const json = await api<{ success: boolean; message?: string }>("/api/v1/salesman-downline", {
        method: "PATCH",
        body: { user_id: sm.id, party_ids: Array.from(checkedIds) },
      });
      if (!json.success) throw new Error(json.message ?? "Failed to assign");
      setShowAssign(false);
      onRefresh();
    } catch (e: unknown) {
      setAssignError(e instanceof Error ? e.message : "Failed to assign");
    }
    setAssigning(false);
  };

  const handleSaveChange = async () => {
    setSaving(true); setSaveError("");
    try {
      const json = await api<{ success: boolean; message?: string }>("/api/v1/salesman-downline", {
        method: "PATCH",
        body: { user_id: sm.id, assigned_party_id: selectedPartyId || null },
      });
      if (!json.success) throw new Error(json.message ?? "Failed to update");
      setShowChange(false);
      onRefresh();
    } catch (e: unknown) {
      setSaveError(e instanceof Error ? e.message : "Failed to update");
    }
    setSaving(false);
  };

  // Show CNF-level parties AND the company as assignable roots
  const rootParties = allParties.filter((p) => {
    const lvl = typeToLevel(p.party_types?.name ?? "");
    return lvl === "CNF" || lvl === "COMPANY";
  });
  const filteredParties = rootParties.filter((p) => {
    const q = partySearch.toLowerCase();
    return !q || p.name.toLowerCase().includes(q) || p.party_code.toLowerCase().includes(q);
  });

  // Assignable parties: CNF, SD, Retailer
  const assignableParties = allParties.filter((p) => {
    const lvl = typeToLevel(p.party_types?.name ?? "");
    return lvl === "CNF" || lvl === "SUPER_DEALER" || lvl === "RETAILER";
  });
  const filteredAssignable = assignableParties.filter((p) => {
    const q = assignSearch.toLowerCase();
    return !q || p.name.toLowerCase().includes(q) || p.party_code.toLowerCase().includes(q) || (p.city ?? "").toLowerCase().includes(q);
  });
  const assignableByLevel: Record<string, FlatParty[]> = { CNF: [], SUPER_DEALER: [], RETAILER: [] };
  filteredAssignable.forEach(p => {
    const lvl = typeToLevel(p.party_types?.name ?? "");
    if (assignableByLevel[lvl]) assignableByLevel[lvl].push(p);
  });

  return (
    <>
      <div className="rounded-xl border border-black/[0.07] bg-black/[0.02] overflow-hidden">
        {/* Salesman header row */}
        <div className="flex items-center gap-3 px-4 py-3">
          {/* Avatar */}
          <div className="w-9 h-9 rounded-full bg-violet-500/20 border border-violet-500/30 flex items-center justify-center shrink-0">
            <span className="text-violet-400 font-semibold" style={{ fontSize: "0.72rem" }}>{sm.name.charAt(0).toUpperCase()}</span>
          </div>

          {/* Info */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-zinc-900 font-medium" style={{ fontSize: "0.85rem" }}>{sm.name}</span>
              <span className="text-[0.6rem] px-1.5 py-0.5 rounded font-medium bg-violet-500/10 text-violet-400 border border-violet-500/20">SALESMAN</span>
              {sm.status !== "ACTIVE" && <span className="text-[0.6rem] px-1.5 py-0.5 rounded font-medium bg-red-500/10 text-red-400 border border-red-500/20">{sm.status}</span>}
              {myGroups.length > 0 && (
                <span
                  className="text-[0.6rem] px-1.5 py-0.5 rounded font-medium bg-amber-500/10 text-amber-500 border border-amber-500/20"
                  title={`${myGroups.length} ${myGroups.length === 1 ? "group" : "groups"} in this downline, ${groupsCombinedMembers} ${groupsCombinedMembers === 1 ? "party" : "parties"} combined across them`}
                >
                  {myGroups.length} {myGroups.length === 1 ? "group" : "groups"} · {groupsCombinedMembers} {groupsCombinedMembers === 1 ? "member" : "members"}
                </span>
              )}
            </div>
            {(sm.employee_code || sm.phone) && (
              <div className="text-zinc-500 mt-0.5 font-mono" style={{ fontSize: "0.7rem" }}>
                {sm.employee_code || sm.phone}
              </div>
            )}
          </div>

          {/* Actions */}
          <div className="shrink-0 flex items-center gap-2">
            {/* Groups button — toggles the Downline Groups section below */}
            <button
              onClick={() => setGroupsExpanded((v) => !v)}
              title={myGroups.length > 0 ? "View groups in this downline" : "No groups assigned to this salesman yet"}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border transition-all ${
                myGroups.length === 0
                  ? "border-black/10 text-zinc-400 hover:text-zinc-600 hover:border-black/20"
                  : groupsExpanded
                    ? "border-amber-500/40 bg-amber-500/10 text-amber-500"
                    : "border-amber-500/30 text-amber-500 hover:bg-amber-500/10 hover:border-amber-500/50"
              }`}
              style={{ fontSize: "0.7rem", fontFamily: "inherit", background: (groupsExpanded && myGroups.length > 0) ? undefined : "none", cursor: "pointer" }}
            >
              <Layers3 className="w-3 h-3" />
              {myGroups.length > 0 ? `${myGroups.length} ${myGroups.length === 1 ? "group" : "groups"}` : "Groups"}
              {myGroups.length > 0 && (groupsExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />)}
            </button>
          </div>
        </div>

        {/* Downline Groups — revealed by the Groups button; click a group to see its parties, combined due, and each party's due */}
        {groupsExpanded && (
          <div className="border-t border-black/[0.06] px-4 py-2.5 bg-amber-500/[0.02]">
            <div className="flex items-center gap-2 mb-2">
              <Layers3 className="w-3.5 h-3.5 text-amber-500 shrink-0" />
              <span className="text-zinc-500" style={{ fontSize: "0.68rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>Downline Groups</span>
              {myGroups.length > 0 && (
                <span className="text-[0.58rem] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-500 border border-amber-500/20 font-medium">
                  {myGroups.length} {myGroups.length === 1 ? "group" : "groups"} · {groupsCombinedMembers} {groupsCombinedMembers === 1 ? "party" : "parties"}
                </span>
              )}
              <div className="flex-1" />
              {groupsCombinedDue > 0 && (
                <span className="font-mono font-semibold text-red-400" style={{ fontSize: "0.74rem" }}>
                  ₹{groupsCombinedDue.toLocaleString("en-IN")}
                  <span className="text-zinc-400 ml-1" style={{ fontSize: "0.58rem" }}>due</span>
                </span>
              )}
            </div>
            {myGroups.length === 0 ? (
              <p className="text-zinc-500 py-1.5" style={{ fontSize: "0.72rem" }}>
                No groups assigned to this salesman&apos;s downline yet. Assign one from the Groups page.
              </p>
            ) : (
              <div className="space-y-1.5">
                {myGroups.map((g) => (
                  <GroupRow
                    key={g.id}
                    group={g}
                    allParties={allParties}
                    duesByParty={duesByParty}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {/* Receivables from parties section */}
        {receivableParties.length > 0 && (
          <div className="border-t border-black/[0.06] px-4 py-2.5 bg-red-500/[0.015]">
            <button
              onClick={() => setReceivablesExpanded(v => !v)}
              className="w-full flex items-center justify-between"
              style={{ background: "none", border: "none", cursor: "pointer", padding: 0 }}
            >
              <div className="flex items-center gap-2">
                <IndianRupee className="w-3.5 h-3.5 text-red-400 shrink-0" />
                <span className="text-zinc-500" style={{ fontSize: "0.68rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                  Receivables from parties
                </span>
                <span className="text-[0.58rem] px-1.5 py-0.5 rounded bg-red-500/10 text-red-400 border border-red-500/20 font-medium">
                  {receivableParties.length} {receivableParties.length === 1 ? "party" : "parties"}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-red-400 font-mono font-semibold" style={{ fontSize: "0.82rem" }}>
                  ₹{totalReceivable.toLocaleString("en-IN")}
                </span>
                {receivablesExpanded
                  ? <ChevronDown className="w-3 h-3 text-zinc-400" />
                  : <ChevronRight className="w-3 h-3 text-zinc-400" />}
              </div>
            </button>

            {receivablesExpanded && (
              <div className="mt-2.5 space-y-1">
                {receivableParties.map(p => {
                  const due = Number(duesByParty[p.id] || 0);
                  const lvl = typeToLevel(p.party_types?.name ?? "");
                  const meta = levelMeta[lvl];
                  const Icon = meta?.Icon ?? Store;
                  return (
                    <div key={p.id} className="flex items-center justify-between px-2.5 py-2 rounded-lg border border-red-500/10 bg-red-500/[0.03]">
                      <div className="flex items-center gap-2 min-w-0">
                        <Icon className={`w-3 h-3 shrink-0 ${meta?.color ?? "text-zinc-500"}`} />
                        <div className="min-w-0">
                          <div className="text-zinc-800 font-medium truncate" style={{ fontSize: "0.78rem" }}>{p.name}</div>
                          <div className="flex items-center gap-1.5">
                            <span className="text-zinc-500 font-mono" style={{ fontSize: "0.62rem" }}>{p.party_code}</span>
                            {p.city && <span className="text-zinc-500" style={{ fontSize: "0.62rem" }}>· {p.city}</span>}
                          </div>
                        </div>
                      </div>
                      <div className="shrink-0 text-right ml-3">
                        <div className="text-red-400 font-mono font-semibold" style={{ fontSize: "0.78rem" }}>₹{due.toLocaleString("en-IN")}</div>
                        <div className="text-zinc-400" style={{ fontSize: "0.58rem" }}>owes you</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

      </div>

      {/* ── Assign Parties Modal ── */}
      {showAssign && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setShowAssign(false)}>
          <div className="w-full max-w-md rounded-xl border border-black/10 bg-[#ffffff] p-6 flex flex-col max-h-[85vh]" onClick={(e) => e.stopPropagation()}>
            {/* Header */}
            <div className="flex items-center justify-between mb-4 shrink-0">
              <div>
                <h2 className="text-zinc-900 font-semibold" style={{ fontSize: "1rem" }}>Assign Parties</h2>
                <p className="text-zinc-500 mt-0.5" style={{ fontSize: "0.73rem" }}>
                  Select parties for <span className="text-zinc-700">{sm.name}</span>
                </p>
              </div>
              <button onClick={() => setShowAssign(false)} className="p-1 rounded-lg hover:bg-black/10 text-zinc-600 hover:text-zinc-900 transition-colors" style={{ background: "none", border: "none", cursor: "pointer" }}>
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Search */}
            <div className="relative mb-3 shrink-0">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-500" />
              <input
                type="text"
                placeholder="Search by name, code or city..."
                value={assignSearch}
                onChange={(e) => setAssignSearch(e.target.value)}
                className="w-full pl-9 pr-4 py-2 rounded-lg border border-black/10 bg-black/[0.03] text-zinc-900 placeholder:text-zinc-500 outline-none focus:border-emerald-500/40"
                style={inp}
                autoFocus
              />
            </div>

            {/* Selection summary */}
            <div className="flex items-center justify-between mb-2 shrink-0">
              <span className="text-zinc-500" style={{ fontSize: "0.68rem" }}>
                {checkedIds.size > 0 ? <span className="text-emerald-400">{checkedIds.size} selected</span> : "None selected"}
              </span>
              <div className="flex gap-2">
                <button onClick={() => setCheckedIds(new Set(assignableParties.map(p => p.id)))} className="text-zinc-500 hover:text-zinc-700 transition-colors" style={{ fontSize: "0.68rem", background: "none", border: "none", cursor: "pointer", fontFamily: "inherit" }}>Select all</button>
                <span className="text-zinc-700">·</span>
                <button onClick={() => setCheckedIds(new Set())} className="text-zinc-500 hover:text-zinc-700 transition-colors" style={{ fontSize: "0.68rem", background: "none", border: "none", cursor: "pointer", fontFamily: "inherit" }}>Clear</button>
              </div>
            </div>

            {/* Party list grouped by level */}
            <div className="flex-1 overflow-y-auto space-y-3 mb-4 pr-1">
              {(["CNF", "SUPER_DEALER", "RETAILER"] as const).map((lvl) => {
                const parties = assignableByLevel[lvl];
                if (parties.length === 0) return null;
                const meta = levelMeta[lvl];
                return (
                  <div key={lvl}>
                    <p className={`mb-1.5 flex items-center gap-1.5 ${meta.color}`} style={{ fontSize: "0.65rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                      <meta.Icon className="w-3 h-3" />{meta.label}
                    </p>
                    <div className="space-y-1">
                      {parties.map((p) => {
                          const isChecked = checkedIds.has(p.id);
                          const alsoAssigned = partyTakenBy[p.id] ?? [];
                          return (
                            <button
                              key={p.id}
                              onClick={() => toggleParty(p.id)}
                              className={`w-full text-left px-3 py-2 rounded-lg border transition-all flex items-center gap-2.5 ${
                                isChecked
                                  ? `${meta.border} ${meta.bg}`
                                  : "border-black/[0.06] hover:border-black/10 hover:bg-black/[0.02]"
                              }`}
                              style={{ fontSize: "0.78rem", fontFamily: "inherit", cursor: "pointer", background: isChecked ? undefined : "none" }}
                            >
                              {/* Checkbox */}
                              <div className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 transition-colors ${isChecked ? `${meta.bg} ${meta.border}` : "border-black/20"}`}>
                                {isChecked && <div className={`w-2 h-2 rounded-sm ${meta.color.replace("text-", "bg-")}`} />}
                              </div>
                              <div className="flex-1 min-w-0">
                                <div className={`font-medium truncate ${isChecked ? meta.color : "text-zinc-700"}`}>{p.name}</div>
                                <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                                  <span className="text-zinc-600" style={{ fontSize: "0.62rem" }}>{p.party_code}</span>
                                  {p.city && <span className="text-zinc-600 flex items-center gap-0.5" style={{ fontSize: "0.62rem" }}><MapPin className="w-2.5 h-2.5" />{p.city}</span>}
                                  {p.contact_phone && <span className="text-zinc-600 flex items-center gap-0.5" style={{ fontSize: "0.62rem" }}><Phone className="w-2.5 h-2.5" />{p.contact_phone}</span>}
                                  {alsoAssigned.length > 0 && (
                                    <span className="text-violet-400 flex items-center gap-0.5" style={{ fontSize: "0.6rem" }}>
                                      also: {alsoAssigned.join(", ")}
                                    </span>
                                  )}
                                </div>
                              </div>
                            </button>
                          );
                        })}
                    </div>
                  </div>
                );
              })}
              {filteredAssignable.length === 0 && (
                <p className="text-zinc-600 text-center py-8" style={{ fontSize: "0.78rem" }}>No parties found</p>
              )}
            </div>

            {assignError && <p className="mb-3 text-red-400 shrink-0" style={{ fontSize: "0.73rem" }}>{assignError}</p>}

            <div className="flex justify-end gap-2 shrink-0">
              <button onClick={() => setShowAssign(false)} className="px-4 py-2 rounded-lg border border-black/10 text-zinc-600 hover:text-zinc-900 hover:bg-black/5 transition-colors" style={{ fontSize: "0.78rem", fontFamily: "inherit", background: "none", cursor: "pointer" }}>Cancel</button>
              <button
                onClick={handleSaveAssign}
                disabled={assigning}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg font-medium bg-emerald-500 hover:bg-emerald-400 text-black transition-colors disabled:opacity-40"
                style={{ fontSize: "0.78rem", fontFamily: "inherit", cursor: "pointer", border: "none" }}
              >
                {assigning && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                {assigning ? "Saving..." : "Save Assignment"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Change Downline Modal ── */}
      {showChange && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setShowChange(false)}>
          <div className="w-full max-w-sm rounded-xl border border-black/10 bg-[#ffffff] p-6" onClick={(e) => e.stopPropagation()}>
            {/* Header */}
            <div className="flex items-center justify-between mb-4">
              <div>
                  <h2 className="text-zinc-900 font-semibold" style={{ fontSize: "1rem" }}>Change Downline</h2>
                  <p className="text-zinc-500 mt-0.5" style={{ fontSize: "0.73rem" }}>
                    Assign root party for <span className="text-zinc-700">{sm.name}</span>
                  </p>
              </div>
              <button onClick={() => setShowChange(false)} className="p-1 rounded-lg hover:bg-black/10 text-zinc-600 hover:text-zinc-900 transition-colors" style={{ background: "none", border: "none", cursor: "pointer" }}>
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Search */}
            <div className="relative mb-3">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-500" />
              <input
                type="text"
                placeholder="Search parties..."
                value={partySearch}
                onChange={(e) => setPartySearch(e.target.value)}
                className="w-full pl-9 pr-4 py-2 rounded-lg border border-black/10 bg-black/[0.03] text-zinc-900 placeholder:text-zinc-500 outline-none focus:border-amber-500/40"
                style={inp}
                autoFocus
              />
            </div>

            {/* None option */}
            <div className="max-h-64 overflow-y-auto space-y-1 mb-4">
              <button
                onClick={() => setSelected("")}
                className={`w-full text-left px-3 py-2.5 rounded-lg border transition-all ${selectedPartyId === "" ? "border-red-500/40 bg-red-500/10 text-red-400" : "border-black/[0.06] text-zinc-500 hover:border-black/10 hover:text-zinc-700"}`}
                style={{ fontSize: "0.78rem", fontFamily: "inherit", cursor: "pointer", background: selectedPartyId === "" ? undefined : "none" }}
              >
                <div className="flex items-center gap-2">
                  <UserX className="w-3.5 h-3.5" />
                  Unassign (no downline)
                </div>
              </button>

                {filteredParties.length === 0 && (
                  <p className="text-zinc-600 text-center py-4" style={{ fontSize: "0.75rem" }}>No parties found</p>
                )}

                  {filteredParties.map((p) => {
                    const isSelected = selectedPartyId === p.id;
                    const isCompany = typeToLevel(p.party_types?.name ?? "") === "COMPANY";
                    return (
                      <button
                        key={p.id}
                        onClick={() => setSelected(p.id)}
                        className={`w-full text-left px-3 py-2.5 rounded-lg border transition-all ${isSelected ? "border-amber-500/40 bg-amber-500/10" : "border-black/[0.06] hover:border-black/10 hover:bg-black/[0.02]"}`}
                        style={{ fontSize: "0.78rem", fontFamily: "inherit", cursor: "pointer", background: isSelected ? undefined : "none" }}
                      >
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className={isSelected ? "text-amber-400 font-medium" : "text-zinc-700"}>{p.name}</span>
                          {isCompany && (
                            <span className="text-[0.58rem] px-1.5 py-0.5 rounded font-medium bg-amber-500/10 text-amber-400 border border-amber-500/20">COMPANY</span>
                          )}
                          <span className="text-zinc-600" style={{ fontSize: "0.65rem" }}>{p.party_code}</span>
                          {p.city && <span className="text-zinc-600" style={{ fontSize: "0.65rem" }}>· {p.city}</span>}
                        </div>
                      </button>
                    );
                  })}
            </div>

            {saveError && <p className="mb-3 text-red-400" style={{ fontSize: "0.73rem" }}>{saveError}</p>}

            <div className="flex justify-end gap-2">
              <button onClick={() => setShowChange(false)} className="px-4 py-2 rounded-lg border border-black/10 text-zinc-600 hover:text-zinc-900 hover:bg-black/5 transition-colors" style={{ fontSize: "0.78rem", fontFamily: "inherit", background: "none", cursor: "pointer" }}>Cancel</button>
              <button
                onClick={handleSaveChange}
                disabled={saving || selectedPartyId === sm.assigned_party_id}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg font-medium bg-amber-500 hover:bg-amber-400 text-black transition-colors disabled:opacity-40"
                style={{ fontSize: "0.78rem", fontFamily: "inherit", cursor: "pointer", border: "none" }}
              >
                {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                {saving ? "Saving..." : "Confirm"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function collectTreePartyIds(node: TreeParty, acc: Set<string> = new Set<string>()): Set<string> {
  acc.add(node.id);
  node.children.forEach((child) => collectTreePartyIds(child, acc));
  return acc;
}
