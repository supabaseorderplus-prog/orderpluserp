"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import {
  Layers, Plus, Search, X, Check, Trash2, Pencil, UserCheck, Users, Loader2, Building2,
} from "lucide-react";

interface GroupItem {
  id: string;
  name: string;
  code: string | null;
  salesman_id: string | null;
  status: string;
  notes: string | null;
  member_count: number;
  member_ids?: string[];
  salesman_name: string | null;
  price_list: { id: string; name: string } | null;
}
interface Party {
  id: string;
  name: string;
  party_code: string;
  party_types: { name: string } | { name: string }[] | null;
}
interface Salesman { id: string; name: string; email: string }

function partyTypeName(raw: Party["party_types"]): string {
  if (Array.isArray(raw)) return raw[0]?.name ?? "";
  return raw?.name ?? "";
}

const FONT = { fontFamily: "'Inter','system-ui',sans-serif" } as const;

// Page through EVERY party. A single large `limit` is capped server-side
// (PostgREST max-rows / scope slicing), so a hardcoded limit silently drops the
// tail once the company exceeds it. Looping by page makes the list complete
// regardless of size (1k, 10k, …) so the "Not in any group" picker is accurate.
async function fetchAllParties(): Promise<Party[]> {
  const PAGE_SIZE = 1000;
  const MAX_PAGES = 50; // safety ceiling: 50k parties
  const seen = new Set<string>();
  const collected: Party[] = [];
  let page = 1;
  for (;;) {
    let res: { data?: Party[]; pagination?: { pages?: number } };
    try {
      res = await api<{ success: boolean; data: Party[]; pagination?: { pages?: number } }>(
        `/api/v1/parties?limit=${PAGE_SIZE}&page=${page}&is_verified=all`,
      );
    } catch {
      break;
    }
    const batch = res.data || [];
    for (const p of batch) {
      if (!seen.has(p.id)) {
        seen.add(p.id);
        collected.push(p);
      }
    }
    const pages = res.pagination?.pages ?? 1;
    if (batch.length < PAGE_SIZE || page >= pages || page >= MAX_PAGES) break;
    page += 1;
  }
  return collected;
}

export default function GroupsPage() {
  const [groups, setGroups] = useState<GroupItem[]>([]);
  const [parties, setParties] = useState<Party[]>([]);
  const [salesmen, setSalesmen] = useState<Salesman[]>([]);
  // salesman_id → party_ids in that salesman's downline (direct + group-folded).
  // Inverted below to show, per group, which salesman owns its member parties.
  const [salesmanToParties, setSalesmanToParties] = useState<Record<string, string[]>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");

  // Create / edit modal
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<GroupItem | null>(null);
  const [formName, setFormName] = useState("");
  const [formNotes, setFormNotes] = useState("");
  const [saving, setSaving] = useState(false);

  // Members modal
  const [membersFor, setMembersFor] = useState<GroupItem | null>(null);
  const [membersLoadFailed, setMembersLoadFailed] = useState(false);
  const [memberIds, setMemberIds] = useState<Set<string>>(new Set());
  // Snapshot of the parties in this group when the modal opened — drives the
  // "In this group" section so rows don't jump sections while toggling.
  const [initialMemberIds, setInitialMemberIds] = useState<Set<string>>(new Set());
  const [memberSearch, setMemberSearch] = useState("");
  const [savingMembers, setSavingMembers] = useState(false);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [g, allParties, sd] = await Promise.all([
        api<{ success: boolean; data: GroupItem[] }>("/api/v1/groups"),
        fetchAllParties(),
        api<{ data: { salesmen: Salesman[]; salesmanToParties?: Record<string, string[]> } }>("/api/v1/salesman-downline").catch(() => ({ data: { salesmen: [] as Salesman[], salesmanToParties: {} as Record<string, string[]> } })),
      ]);
      setGroups(g.data || []);
      setParties(allParties);
      setSalesmen(sd.data?.salesmen || []);
      setSalesmanToParties(sd.data?.salesmanToParties || {});
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load groups");
    }
    setLoading(false);
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const filteredGroups = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return groups;
    return groups.filter((g) =>
      g.name.toLowerCase().includes(q) || (g.code || "").toLowerCase().includes(q) || (g.salesman_name || "").toLowerCase().includes(q),
    );
  }, [groups, search]);

  // ── Downline reflection ────────────────────────────────────────────────────
  // Which salesman('s downline) each group's member parties belong to. Derived
  // by inverting salesmanToParties (salesman → parties) into party → salesmen,
  // then collecting the distinct salesmen across a group's members.
  const salesmanNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of salesmen) m.set(s.id, s.name);
    return m;
  }, [salesmen]);

  const partyToSalesmanIds = useMemo(() => {
    const m: Record<string, string[]> = {};
    for (const [salesmanId, partyIds] of Object.entries(salesmanToParties)) {
      for (const pid of partyIds) (m[pid] ||= []).push(salesmanId);
    }
    return m;
  }, [salesmanToParties]);

  const downlineNamesByGroup = useMemo(() => {
    const result: Record<string, string[]> = {};
    for (const g of groups) {
      const ids = new Set<string>();
      for (const pid of g.member_ids || []) {
        for (const sid of partyToSalesmanIds[pid] || []) ids.add(sid);
      }
      result[g.id] = [...ids]
        .map((id) => salesmanNameById.get(id))
        .filter((n): n is string => Boolean(n))
        .sort((a, b) => a.localeCompare(b));
    }
    return result;
  }, [groups, partyToSalesmanIds, salesmanNameById]);

  // ── Create / edit ────────────────────────────────────────────────────────
  const openCreate = () => { setEditing(null); setFormName(""); setFormNotes(""); setShowForm(true); };
  const openEdit = (g: GroupItem) => { setEditing(g); setFormName(g.name); setFormNotes(g.notes || ""); setShowForm(true); };

  const saveForm = async () => {
    if (!formName.trim()) { setError("Group name is required"); return; }
    setSaving(true); setError("");
    try {
      if (editing) {
        await api(`/api/v1/groups/${editing.id}`, { method: "PATCH", body: { name: formName.trim(), notes: formNotes } });
      } else {
        await api("/api/v1/groups", { method: "POST", body: { name: formName.trim(), notes: formNotes } });
      }
      setShowForm(false);
      await fetchAll();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save group");
    }
    setSaving(false);
  };

  const deleteGroup = async (g: GroupItem) => {
    if (!confirm(`Delete group "${g.name}"? Its ${g.member_count} parties will be ungrouped.`)) return;
    try {
      await api(`/api/v1/groups/${g.id}`, { method: "DELETE" });
      await fetchAll();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete group");
    }
  };

  const assignSalesman = async (g: GroupItem, salesmanId: string) => {
    try {
      await api(`/api/v1/groups/${g.id}`, { method: "PATCH", body: { salesman_id: salesmanId || null } });
      await fetchAll();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to assign salesman");
    }
  };

  // ── Members ──────────────────────────────────────────────────────────────
  const openMembers = async (g: GroupItem) => {
    setMembersFor(g);
    setMemberSearch("");
    setMemberIds(new Set());
    setInitialMemberIds(new Set());
    setMembersLoadFailed(false);
    try {
      const res = await api<{ success: boolean; data: { members: { id: string }[] } }>(`/api/v1/groups/${g.id}`);
      const ids = new Set((res.data?.members || []).map((m) => m.id));
      setMemberIds(ids);
      setInitialMemberIds(new Set(ids));
    } catch {
      // Saving now would PATCH an empty party_ids and wipe every member, because the
      // checkbox set never got seeded. Mark the dialog unsafe instead of letting the
      // admin submit a list that only looks like "nothing is selected".
      setMembersLoadFailed(true);
    }
  };

  const toggleMember = (id: string) => {
    setMemberIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const saveMembers = async () => {
    if (!membersFor || membersLoadFailed) return;
    setSavingMembers(true); setError("");
    try {
      await api(`/api/v1/groups/${membersFor.id}`, { method: "PATCH", body: { party_ids: Array.from(memberIds) } });
      setMembersFor(null);
      await fetchAll();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save members");
    }
    setSavingMembers(false);
  };

  // Every party already claimed by ANY group, so parties owned by other groups
  // can be hidden (a party belongs to at most one group).
  const groupedPartyIds = useMemo(() => {
    const s = new Set<string>();
    for (const g of groups) for (const pid of g.member_ids || []) s.add(pid);
    return s;
  }, [groups]);

  const matchesMemberSearch = useCallback((p: Party) => {
    const q = memberSearch.trim().toLowerCase();
    if (!q) return true;
    return p.name.toLowerCase().includes(q) || p.party_code.toLowerCase().includes(q);
  }, [memberSearch]);

  // Section 1 — parties that were in this group when the modal opened.
  const inGroupParties = useMemo(
    () => parties.filter((p) => initialMemberIds.has(p.id) && matchesMemberSearch(p)),
    [parties, initialMemberIds, matchesMemberSearch],
  );

  // Section 2 — parties that belong to no group at all (available to add).
  const availableParties = useMemo(
    () => parties.filter((p) => !groupedPartyIds.has(p.id) && matchesMemberSearch(p)),
    [parties, groupedPartyIds, matchesMemberSearch],
  );

  const renderPartyRow = (p: Party) => {
    const checked = memberIds.has(p.id);
    return (
      <button key={p.id} onClick={() => toggleMember(p.id)}
        className={`flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left transition ${checked ? "border-amber-300 bg-amber-50" : "border-zinc-200 bg-white hover:border-zinc-300"}`}>
        <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${checked ? "border-amber-500 bg-amber-500 text-white" : "border-zinc-300"}`}>
          {checked && <Check className="h-3 w-3" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-zinc-900">{p.name}</span>
          <span className="block truncate font-mono text-[0.65rem] text-zinc-500">{p.party_code} · {partyTypeName(p.party_types).replace(/_/g, " ") || "N/A"}</span>
        </span>
      </button>
    );
  };

  return (
    <div className="space-y-6" style={FONT}>
      {/* Header */}
      <div className="rounded-2xl border border-zinc-200 bg-gradient-to-r from-white to-amber-50/40 p-6 shadow-sm">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-amber-500/10 border border-amber-500/20">
              <Layers className="h-5 w-5 text-amber-600" />
            </div>
            <div>
              <h1 className="text-2xl font-bold tracking-tight text-zinc-900">Groups</h1>
              <p className="mt-0.5 text-sm text-zinc-600">Bundle parties, assign a salesman, and set a group price list</p>
            </div>
          </div>
          <button
            onClick={openCreate}
            className="inline-flex items-center gap-2 rounded-xl bg-amber-500 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-amber-600"
          >
            <Plus className="h-4 w-4" /> New Group
          </button>
        </div>
      </div>

      {error && <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">{error}</div>}

      {/* Search */}
      <div className="relative">
        <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
        <input
          type="text"
          placeholder="Search groups by name, code, or salesman"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full rounded-xl border border-zinc-200 bg-white py-2.5 pl-10 pr-3.5 text-sm font-medium text-zinc-900 outline-none transition focus:border-amber-400 focus:ring-2 focus:ring-amber-100"
        />
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-24"><Loader2 className="h-8 w-8 animate-spin text-amber-500" /></div>
      ) : filteredGroups.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-zinc-300 bg-white py-20 text-center">
          <Layers className="mx-auto mb-3 h-10 w-10 text-zinc-300" />
          <p className="text-sm font-medium text-zinc-600">{groups.length === 0 ? "No groups yet" : "No groups match your search"}</p>
          {groups.length === 0 && <p className="mt-1 text-xs text-zinc-400">Create a group to bundle parties under one salesman and price list</p>}
        </div>
      ) : (
        <div
          aria-label="Groups list"
          data-testid="groups-scroll-window"
          className="max-h-[144rem] overflow-y-auto rounded-2xl border border-zinc-200 bg-zinc-50/60 p-2 pr-1 shadow-inner [scrollbar-gutter:stable] lg:max-h-[72rem]"
        >
          <div className="grid auto-rows-[17rem] grid-cols-1 gap-4 lg:grid-cols-2">
            {filteredGroups.map((g) => {
              const downlineNames = downlineNamesByGroup[g.id] || [];
              return (
            <div key={g.id} className="h-full overflow-hidden rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm transition hover:border-amber-200">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h3 className="truncate text-base font-semibold text-zinc-900">{g.name}</h3>
                    {g.code && <span className="shrink-0 rounded-md bg-zinc-100 px-1.5 py-0.5 font-mono text-[0.65rem] text-zinc-500">{g.code}</span>}
                  </div>
                  <div className="mt-1 flex items-center gap-1.5 text-xs text-zinc-500">
                    <Users className="h-3.5 w-3.5" />
                    <span>{g.member_count} {g.member_count === 1 ? "party" : "parties"}</span>
                  </div>
                  {downlineNames.length > 0 && (
                    <div className="mt-1 flex items-center gap-1.5 text-xs text-zinc-500" title={`Member parties belong to ${downlineNames.join(", ")}'s downline`}>
                      <UserCheck className="h-3.5 w-3.5 shrink-0 text-amber-600" />
                      <span className="truncate">Downline: <span className="font-medium text-zinc-700">{downlineNames.join(", ")}</span></span>
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button onClick={() => openEdit(g)} title="Rename" className="rounded-lg p-1.5 text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-900"><Pencil className="h-4 w-4" /></button>
                  <button onClick={() => deleteGroup(g)} title="Delete" className="rounded-lg p-1.5 text-zinc-500 transition hover:bg-red-50 hover:text-red-600"><Trash2 className="h-4 w-4" /></button>
                </div>
              </div>

              <div className="mt-4 space-y-3">
                {/* Salesman */}
                <label className="block">
                  <span className="mb-1 flex items-center gap-1.5 text-[0.7rem] font-semibold uppercase tracking-wide text-zinc-500"><UserCheck className="h-3.5 w-3.5" /> Salesman</span>
                  <select
                    value={g.salesman_id || ""}
                    onChange={(e) => assignSalesman(g, e.target.value)}
                    className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 outline-none transition focus:border-amber-400"
                  >
                    <option value="">— Unassigned —</option>
                    {salesmen.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </label>
              </div>

              <button
                onClick={() => openMembers(g)}
                className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm font-medium text-zinc-700 transition hover:border-amber-200 hover:bg-amber-50 hover:text-amber-700"
              >
                <Building2 className="h-4 w-4" /> Manage Parties
              </button>
            </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Create / edit modal */}
      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm" onClick={() => setShowForm(false)}>
          <div className="w-full max-w-md rounded-2xl border border-zinc-200 bg-white p-6 shadow-xl" onClick={(e) => e.stopPropagation()} style={FONT}>
            <div className="mb-5 flex items-center justify-between">
              <h2 className="text-lg font-semibold text-zinc-900">{editing ? "Edit Group" : "New Group"}</h2>
              <button onClick={() => setShowForm(false)} className="rounded-lg p-1 text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-900"><X className="h-5 w-5" /></button>
            </div>
            <label className="mb-4 block">
              <span className="mb-1 block text-sm font-medium text-zinc-700">Group name</span>
              <input autoFocus value={formName} onChange={(e) => setFormName(e.target.value)} placeholder="e.g. North Zone Retailers"
                className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2.5 text-sm text-zinc-900 outline-none transition focus:border-amber-400 focus:ring-2 focus:ring-amber-100" />
            </label>
            <label className="mb-5 block">
              <span className="mb-1 block text-sm font-medium text-zinc-700">Notes <span className="text-zinc-400">(optional)</span></span>
              <textarea value={formNotes} onChange={(e) => setFormNotes(e.target.value)} rows={2}
                className="w-full resize-none rounded-lg border border-zinc-200 bg-white px-3 py-2.5 text-sm text-zinc-900 outline-none transition focus:border-amber-400 focus:ring-2 focus:ring-amber-100" />
            </label>
            <div className="flex justify-end gap-2">
              <button onClick={() => setShowForm(false)} className="rounded-lg border border-zinc-200 px-4 py-2 text-sm font-medium text-zinc-600 transition hover:bg-zinc-50">Cancel</button>
              <button onClick={saveForm} disabled={saving} className="inline-flex items-center gap-2 rounded-lg bg-amber-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-amber-600 disabled:opacity-60">
                {saving && <Loader2 className="h-4 w-4 animate-spin" />} {editing ? "Save" : "Create"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Members modal */}
      {membersFor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm" onClick={() => setMembersFor(null)}>
          <div className="flex max-h-[85vh] w-full max-w-lg flex-col rounded-2xl border border-zinc-200 bg-white shadow-xl" onClick={(e) => e.stopPropagation()} style={FONT}>
            <div className="flex items-center justify-between border-b border-zinc-100 p-5">
              <div>
                <h2 className="text-lg font-semibold text-zinc-900">Manage Parties</h2>
                <p className="mt-0.5 text-xs text-zinc-500">{membersFor.name} · {memberIds.size} selected</p>
              </div>
              <button onClick={() => setMembersFor(null)} className="rounded-lg p-1 text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-900"><X className="h-5 w-5" /></button>
            </div>
            <div className="border-b border-zinc-100 p-4">
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
                <input value={memberSearch} onChange={(e) => setMemberSearch(e.target.value)} placeholder="Search parties by name or code"
                  className="w-full rounded-lg border border-zinc-200 bg-white py-2 pl-9 pr-3 text-sm text-zinc-900 outline-none transition focus:border-amber-400" />
              </div>
            </div>
            <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
              {/* Section 1 — parties already in this group */}
              <div>
                <h3 className="mb-2 flex items-center gap-1.5 text-[0.7rem] font-semibold uppercase tracking-wide text-zinc-500">
                  <Check className="h-3.5 w-3.5 text-amber-600" /> In this group ({inGroupParties.length})
                </h3>
                <div className="space-y-1.5">
                  {inGroupParties.length === 0 ? (
                    <p className="py-3 text-center text-xs text-zinc-400">No parties in this group yet</p>
                  ) : inGroupParties.map(renderPartyRow)}
                </div>
              </div>

              {/* Section 2 — parties not in any group */}
              <div>
                <h3 className="mb-2 flex items-center gap-1.5 text-[0.7rem] font-semibold uppercase tracking-wide text-zinc-500">
                  <Building2 className="h-3.5 w-3.5" /> Not in any group ({availableParties.length})
                </h3>
                <div className="space-y-1.5">
                  {availableParties.length === 0 ? (
                    <p className="py-3 text-center text-xs text-zinc-400">No ungrouped parties available</p>
                  ) : availableParties.map(renderPartyRow)}
                </div>
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-zinc-100 p-4">
              {membersLoadFailed && (
                <p className="mr-auto text-xs font-medium text-red-600">
                  Could not load this group&apos;s current members — saving is disabled so they aren&apos;t erased. Close and reopen to retry.
                </p>
              )}
              <button onClick={() => setMembersFor(null)} className="rounded-lg border border-zinc-200 px-4 py-2 text-sm font-medium text-zinc-600 transition hover:bg-zinc-50">Cancel</button>
              <button onClick={saveMembers} disabled={savingMembers || membersLoadFailed} className="inline-flex items-center gap-2 rounded-lg bg-amber-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-amber-600 disabled:opacity-60">
                {savingMembers && <Loader2 className="h-4 w-4 animate-spin" />} Save {memberIds.size} {memberIds.size === 1 ? "party" : "parties"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
