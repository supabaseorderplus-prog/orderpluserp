import { supabaseAdmin, resolveUserDisplayMap } from '@/lib/supabase-server'
import { fetchAllInChunks, fetchAllInChunksPaged } from '@/lib/supabase-in-chunks'
import { runDirectSql } from '@/lib/direct-sql'
import { getFallbackGroupInfoForParties } from '@/lib/groups-fallback'

/**
 * Groups: a named set of parties that can be assigned to a salesman and linked to
 * a price list. Assigning a group to a salesman folds every member party into that
 * salesman's downline scope; linking a price list makes every member resolve to it.
 *
 * A party belongs to AT MOST ONE group (UNIQUE on group_members.party_id), so the
 * downline routing is unambiguous. Groups are additive — they coexist with the
 * existing party_salesman direct assignments.
 *
 * Schema is created lazily via a direct pg connection, mirroring
 * src/lib/pricing-schema.ts. On deployments without SUPABASE_DB_URL the ensure is
 * a no-op and every read here degrades to empty so the rest of the app keeps working.
 */

type DbErrorLike = { code?: string; message?: string; details?: string; hint?: string } | null | undefined

const SCHEMA_ERROR_CODES = new Set(['42P01', '42703', 'PGRST200', 'PGRST204', 'PGRST205'])

let groupsSchemaEnsured = false

const GROUPS_SCHEMA_WAIT_MS = [0, 150, 400, 900]

const GROUPS_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS public.groups (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID,
    name TEXT NOT NULL,
    code TEXT,
    salesman_id UUID,
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS public.group_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id UUID NOT NULL REFERENCES public.groups(id) ON DELETE CASCADE,
    party_id UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  ALTER TABLE public.groups ADD COLUMN IF NOT EXISTS company_id UUID;
  ALTER TABLE public.groups ADD COLUMN IF NOT EXISTS code TEXT;
  ALTER TABLE public.groups ADD COLUMN IF NOT EXISTS salesman_id UUID;
  ALTER TABLE public.groups ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'ACTIVE';
  ALTER TABLE public.groups ADD COLUMN IF NOT EXISTS notes TEXT;

  CREATE UNIQUE INDEX IF NOT EXISTS idx_group_members_party_unique ON public.group_members(party_id);
  CREATE INDEX IF NOT EXISTS idx_group_members_group_id ON public.group_members(group_id);
  CREATE INDEX IF NOT EXISTS idx_groups_company_id ON public.groups(company_id);
  CREATE INDEX IF NOT EXISTS idx_groups_salesman_id ON public.groups(salesman_id);
  CREATE INDEX IF NOT EXISTS idx_groups_status ON public.groups(status);

  DO $$ BEGIN
    IF EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'price_lists'
    ) THEN
      ALTER TABLE public.price_lists ADD COLUMN IF NOT EXISTS group_id UUID;
      CREATE INDEX IF NOT EXISTS idx_price_lists_group_id ON public.price_lists(group_id);
    END IF;
  END $$;

  NOTIFY pgrst, 'reload schema';
`

function errorText(err: DbErrorLike): string {
  return `${err?.code || ''} ${err?.message || ''} ${err?.details || ''} ${err?.hint || ''}`.toLowerCase()
}

export function isGroupsSchemaGap(err: DbErrorLike): boolean {
  if (!err) return false
  if (err.code && SCHEMA_ERROR_CODES.has(err.code)) return true
  const text = errorText(err)
  return (
    text.includes('schema cache') ||
    text.includes('does not exist') ||
    text.includes('relation') ||
    text.includes('could not find') ||
    text.includes('group_members') ||
    text.includes('groups')
  )
}

export async function hasGroupsSchema(): Promise<boolean> {
  try {
    const { error: groupsError } = await supabaseAdmin.from('groups').select('id').limit(1)
    if (groupsError) return false

    const { error: membersError } = await supabaseAdmin.from('group_members').select('id').limit(1)
    return !membersError
  } catch {
    return false
  }
}

async function waitForGroupsSchema(): Promise<boolean> {
  for (const delayMs of GROUPS_SCHEMA_WAIT_MS) {
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
    if (await hasGroupsSchema()) return true
  }
  return false
}

export async function ensureGroupsSchema(): Promise<void> {
  if (groupsSchemaEnsured) return

  if (await waitForGroupsSchema()) {
    groupsSchemaEnsured = true
    return
  }

  try {
    const directOk = await runDirectSql(GROUPS_SCHEMA_SQL)
    if (!directOk) {
      const probe = await supabaseAdmin.rpc('exec_sql', { sql: 'SELECT 1;' })
      if (!probe.error) {
        const { error } = await supabaseAdmin.rpc('exec_sql', { sql: GROUPS_SCHEMA_SQL })
        if (error) {
          console.warn('[ensureGroupsSchema] exec_sql migration failed:', error.message)
        }
      } else {
        console.warn('[ensureGroupsSchema] exec_sql unavailable:', probe.error.message)
      }
    }

    groupsSchemaEnsured = await waitForGroupsSchema()
  } catch (e) {
    console.error('[ensureGroupsSchema] migration failed:', e)
  }
}

/**
 * Splits the member ids a caller asked to write into those that may be persisted and
 * those that must be refused.
 *
 * Membership writes replace the whole member list, so the company-scope check that
 * guards them is destructive: any id it rejects is dropped from the group. Filtering
 * silently — as this used to — turns a degraded scope lookup into unannounced data
 * loss. That is how the Murshidabad groups emptied out: the scope came from the
 * `get_party_descendants` RPC, which caps at 1000 rows and omitted that whole branch,
 * so every selected party was quietly discarded and the group saved with none.
 * `getCompanyDescendantIds` still degrades to `[companyId]` when the party scan fails,
 * which would wipe a group outright.
 *
 * So: ids already in the group are always retained (a scope lookup must never purge
 * what is already there), and only *newly added* ids must resolve inside the company
 * tree. Callers reject a non-empty `rejected` with a 400 rather than saving a subset.
 * A null `scopeIds` means "unscoped caller" (SUPER_ADMIN with no company) — allow all.
 */
export function partitionRequestedMembers(
  requested: string[],
  existingMemberIds: string[],
  scopeIds: Set<string> | null,
): { valid: string[]; rejected: string[] } {
  const existing = new Set(existingMemberIds)
  const valid: string[] = []
  const rejected: string[] = []
  for (const id of new Set(requested.filter(Boolean))) {
    if (!scopeIds || scopeIds.has(id) || existing.has(id)) valid.push(id)
    else rejected.push(id)
  }
  return { valid, rejected }
}

/**
 * Party IDs that belong to any group assigned to one of the given salesmen.
 * Tolerant: returns [] when the groups schema is absent. Chunk-safe on group ids.
 */
export async function getGroupMemberIdsForSalesmen(salesmanIds: string[]): Promise<string[]> {
  const ids = [...new Set(salesmanIds.filter(Boolean))]
  if (ids.length === 0) return []
  try {
    const { data: groupRows, error: groupErr } = await supabaseAdmin
      .from('groups')
      .select('id')
      .in('salesman_id', ids)
      .neq('status', 'DELETED')
    if (groupErr) return []
    const groupIds = ((groupRows || []) as { id: string }[]).map((g) => g.id)
    if (groupIds.length === 0) return []

    // Paged: an unranged scan caps at PostgREST's 1000-row max-rows limit, which
    // would silently drop parties out of the salesman's downline scope.
    const { data: memberRows, error: memberErr } = await fetchAllInChunksPaged<{ party_id: string }>(
      groupIds,
      (chunk, from, to) =>
        supabaseAdmin.from('group_members').select('party_id').in('group_id', chunk).order('id').range(from, to),
    )
    if (memberErr) return []
    return [...new Set((memberRows || []).map((m) => m.party_id).filter(Boolean))]
  } catch {
    return []
  }
}

export interface PartyGroupInfo {
  groupId: string
  groupName: string | null
  salesmanId: string | null
  salesmanName: string | null
}

/**
 * Batch-resolves, for a set of party ids, the group each belongs to and that
 * group's assigned salesman (display name included). Reads the canonical table
 * first and fills any unresolved parties from the company_notes fallback, then
 * resolves salesman names in a single pass. Tolerant of a missing groups schema —
 * unresolved parties simply have no entry in the returned map.
 */
export async function getPartyGroupInfoMap(partyIds: string[]): Promise<Map<string, PartyGroupInfo>> {
  const result = new Map<string, PartyGroupInfo>()
  const ids = [...new Set(partyIds.filter(Boolean))]
  if (ids.length === 0) return result

  // Canonical, table-backed groups.
  try {
    const { data: memberRows, error: memberErr } = await fetchAllInChunks<{ party_id: string; group_id: string }>(
      ids,
      (chunk) => supabaseAdmin.from('group_members').select('party_id, group_id').in('party_id', chunk),
    )
    if (!memberErr && memberRows && memberRows.length > 0) {
      const groupIds = [...new Set(memberRows.map((m) => m.group_id).filter(Boolean))]
      const { data: groupRows } = await fetchAllInChunks<{ id: string; name: string | null; salesman_id: string | null; status: string | null }>(
        groupIds,
        (chunk) => supabaseAdmin.from('groups').select('id, name, salesman_id, status').in('id', chunk),
      )
      const groupMeta = new Map<string, { name: string | null; salesmanId: string | null }>()
      for (const g of (groupRows || []) as { id: string; name: string | null; salesman_id: string | null; status: string | null }[]) {
        if ((g.status || 'ACTIVE') === 'DELETED') continue
        groupMeta.set(g.id, { name: g.name ?? null, salesmanId: g.salesman_id ?? null })
      }
      for (const m of memberRows) {
        const meta = groupMeta.get(m.group_id)
        if (!meta || result.has(m.party_id)) continue
        result.set(m.party_id, { groupId: m.group_id, groupName: meta.name, salesmanId: meta.salesmanId, salesmanName: null })
      }
    }
  } catch {
    /* schema gap → fall through to notes fallback */
  }

  // company_notes fallback for any party the table didn't resolve.
  const unresolved = ids.filter((id) => !result.has(id))
  if (unresolved.length > 0) {
    try {
      const fallbackMap = await getFallbackGroupInfoForParties(unresolved)
      for (const [partyId, info] of fallbackMap) {
        result.set(partyId, { groupId: info.groupId, groupName: info.groupName, salesmanId: info.salesmanId, salesmanName: null })
      }
    } catch {
      /* notes table missing → leave unresolved */
    }
  }

  // Resolve every assigned salesman's display name in one batch.
  const salesmanIds = [...new Set([...result.values()].map((v) => v.salesmanId).filter((x): x is string => !!x))]
  if (salesmanIds.length > 0) {
    try {
      const nameMap = await resolveUserDisplayMap(salesmanIds)
      for (const info of result.values()) {
        if (info.salesmanId && nameMap[info.salesmanId]) info.salesmanName = nameMap[info.salesmanId].name
      }
    } catch {
      /* names are optional enrichment */
    }
  }

  return result
}

/**
 * The group a party belongs to (or null). Tolerant of a missing groups schema.
 */
export async function getPartyGroup(
  partyId: string,
): Promise<{ group_id: string; salesman_id: string | null } | null> {
  if (!partyId) return null
  try {
    const { data: member, error: memberErr } = await supabaseAdmin
      .from('group_members')
      .select('group_id')
      .eq('party_id', partyId)
      .maybeSingle()
    if (!memberErr && member?.group_id) {
      const { data: group, error: groupErr } = await supabaseAdmin
        .from('groups')
        .select('id, salesman_id, status')
        .eq('id', member.group_id)
        .maybeSingle()
      if (!groupErr && group && group.status !== 'DELETED') {
        return { group_id: group.id as string, salesman_id: (group.salesman_id as string | null) ?? null }
      }
    }
  } catch {
  }

  try {
    const fallbackMap = await getFallbackGroupInfoForParties([partyId])
    const fallback = fallbackMap.get(partyId)
    if (fallback?.groupId) {
      return { group_id: fallback.groupId, salesman_id: fallback.salesmanId ?? null }
    }
  } catch {
  }

  return null
}
