import { supabaseAdmin, resolveUserDisplayMap } from '@/lib/supabase-server'
import { fetchAllInChunks } from '@/lib/supabase-in-chunks'

export const GROUPS_FALLBACK_NOTE_PREFIX = 'SYSTEM_GROUP::'

export type GroupFallbackRecord = {
  id: string
  company_id: string | null
  name: string
  code: string | null
  salesman_id: string | null
  status: string
  notes: string | null
  member_ids: string[]
  price_list_id: string | null
  created_at: string
  updated_at: string
}

type CompanyNoteRow = {
  id: string
  company_id: string | null
  note: string | null
  created_at?: string | null
  updated_at?: string | null
}

function buildGroupFallbackNote(record: GroupFallbackRecord): string {
  return `${GROUPS_FALLBACK_NOTE_PREFIX}${JSON.stringify(record)}`
}

function parseGroupFallbackNote(note: string | null): GroupFallbackRecord | null {
  if (!note || !note.startsWith(GROUPS_FALLBACK_NOTE_PREFIX)) return null
  try {
    const parsed = JSON.parse(note.slice(GROUPS_FALLBACK_NOTE_PREFIX.length)) as Partial<GroupFallbackRecord>
    // The prefix already guarantees this is a group note, so an id is the only
    // hard requirement. Tolerate a missing name (older records corrupted by an
    // undefined-clobbering update) so they remain visible and editable instead
    // of vanishing from the list.
    if (!parsed.id) return null
    return {
      id: String(parsed.id),
      company_id: parsed.company_id ? String(parsed.company_id) : null,
      name: parsed.name ? String(parsed.name) : (parsed.code ? String(parsed.code) : 'Untitled Group'),
      code: parsed.code ? String(parsed.code) : null,
      salesman_id: parsed.salesman_id ? String(parsed.salesman_id) : null,
      status: parsed.status ? String(parsed.status) : 'ACTIVE',
      notes: parsed.notes ? String(parsed.notes) : null,
      member_ids: Array.isArray(parsed.member_ids) ? parsed.member_ids.map(String) : [],
      price_list_id: parsed.price_list_id ? String(parsed.price_list_id) : null,
      created_at: parsed.created_at ? String(parsed.created_at) : new Date().toISOString(),
      updated_at: parsed.updated_at ? String(parsed.updated_at) : new Date().toISOString(),
    }
  } catch {
    return null
  }
}

async function listFallbackRows(companyId?: string | null): Promise<Array<{ noteRow: CompanyNoteRow; group: GroupFallbackRecord }>> {
  let query = supabaseAdmin
    .from('company_notes')
    .select('id, company_id, note, created_at, updated_at')
    .like('note', `${GROUPS_FALLBACK_NOTE_PREFIX}%`)
    .order('created_at', { ascending: false })
    .limit(5000)

  if (companyId) query = query.eq('company_id', companyId)

  const { data, error } = await query
  if (error) throw error

  return ((data || []) as CompanyNoteRow[])
    .map((noteRow) => ({ noteRow, group: parseGroupFallbackNote(noteRow.note) }))
    .filter((entry): entry is { noteRow: CompanyNoteRow; group: GroupFallbackRecord } => !!entry.group)
}

export async function listFallbackGroups(companyId?: string | null) {
  const rows = await listFallbackRows(companyId)
  const active = rows.map((entry) => entry.group).filter((group) => group.status !== 'DELETED')
  const salesmanIds = [...new Set(active.map((group) => group.salesman_id).filter(Boolean) as string[])]
  const salesmanMap = salesmanIds.length ? await resolveUserDisplayMap(salesmanIds) : {}

  const priceListIds = [...new Set(active.map((group) => group.price_list_id).filter(Boolean) as string[])]
  const priceListMap: Record<string, { id: string; name: string }> = {}
  if (priceListIds.length > 0) {
    const { data } = await fetchAllInChunks<{ id: string; name: string }>(
      priceListIds,
      (chunk) => supabaseAdmin.from('price_lists').select('id, name').in('id', chunk),
    )
    for (const row of data || []) {
      priceListMap[row.id] = { id: row.id, name: row.name }
    }
  }

  return active.map((group) => ({
    ...group,
    member_count: group.member_ids.length,
    salesman_name: group.salesman_id ? (salesmanMap[group.salesman_id]?.name ?? null) : null,
    price_list: group.price_list_id ? (priceListMap[group.price_list_id] ?? null) : null,
  }))
}

export async function getFallbackGroup(id: string, companyId?: string | null) {
  const rows = await listFallbackRows(companyId)
  return rows.find((entry) => entry.group.id === id)?.group ?? null
}

/**
 * Maps each requested party id to the (note-stored) group it belongs to. A party
 * belongs to at most one group, so the first active group claiming it wins. Salesman
 * display names are left to the caller (resolved in one batch). Tolerant of a missing
 * company_notes table — returns an empty map.
 */
export async function getFallbackGroupInfoForParties(
  partyIds: string[],
): Promise<Map<string, { groupId: string; groupName: string | null; salesmanId: string | null }>> {
  const result = new Map<string, { groupId: string; groupName: string | null; salesmanId: string | null }>()
  const idSet = new Set(partyIds.filter(Boolean))
  if (idSet.size === 0) return result

  let rows: Array<{ group: GroupFallbackRecord }>
  try {
    rows = await listFallbackRows()
  } catch {
    return result
  }

  for (const { group } of rows) {
    if (group.status === 'DELETED') continue
    for (const memberId of group.member_ids) {
      if (!idSet.has(memberId) || result.has(memberId)) continue
      result.set(memberId, { groupId: group.id, groupName: group.name, salesmanId: group.salesman_id })
    }
  }
  return result
}

export async function createFallbackGroup(input: {
  companyId: string | null
  name: string
  code: string | null
  salesman_id: string | null
  notes: string | null
  party_ids: string[]
  price_list_id?: string | null
}) {
  const now = new Date().toISOString()
  const record: GroupFallbackRecord = {
    id: crypto.randomUUID(),
    company_id: input.companyId,
    name: input.name,
    code: input.code,
    salesman_id: input.salesman_id,
    status: 'ACTIVE',
    notes: input.notes,
    member_ids: [...new Set(input.party_ids.filter(Boolean))],
    price_list_id: input.price_list_id ?? null,
    created_at: now,
    updated_at: now,
  }

  const { data, error } = await supabaseAdmin
    .from('company_notes')
    .insert({ company_id: input.companyId, note: buildGroupFallbackNote(record) })
    .select('id')
    .single()
  if (error) throw error

  return { ...record, _company_note_id: data?.id ?? null }
}

export async function updateFallbackGroup(id: string, companyId: string | null | undefined, updates: Partial<GroupFallbackRecord>) {
  const rows = await listFallbackRows(companyId)
  const existing = rows.find((entry) => entry.group.id === id)
  if (!existing) return null

  // Only apply keys that are actually provided. Spreading undefined values would
  // overwrite existing fields, and JSON.stringify drops undefined keys entirely —
  // which is exactly how name/code/status got wiped on salesman/member updates.
  const definedUpdates = Object.fromEntries(
    Object.entries(updates).filter(([, value]) => value !== undefined),
  ) as Partial<GroupFallbackRecord>

  const next: GroupFallbackRecord = {
    ...existing.group,
    ...definedUpdates,
    member_ids: updates.member_ids ? [...new Set(updates.member_ids.filter(Boolean))] : existing.group.member_ids,
    updated_at: new Date().toISOString(),
  }

  const { error } = await supabaseAdmin
    .from('company_notes')
    .update({ note: buildGroupFallbackNote(next) })
    .eq('id', existing.noteRow.id)
  if (error) throw error

  return next
}

export async function deleteFallbackGroup(id: string, companyId: string | null | undefined) {
  const rows = await listFallbackRows(companyId)
  const existing = rows.find((entry) => entry.group.id === id)
  if (!existing) return false

  const { error } = await supabaseAdmin.from('company_notes').delete().eq('id', existing.noteRow.id)
  if (error) throw error
  return true
}

export async function hydrateFallbackGroupDetail(group: GroupFallbackRecord) {
  let members: Record<string, unknown>[] = []
  if (group.member_ids.length > 0) {
    const { data, error } = await fetchAllInChunks<Record<string, unknown>>(
      group.member_ids,
      (chunk) => supabaseAdmin.from('parties').select('id, name, party_code, parent_party_id, party_types(name)').in('id', chunk),
    )
    // Never degrade a failed party lookup into "this group has no members". The members
    // dialog seeds its checkbox set from this list and PATCHes it straight back, so an
    // empty list is indistinguishable from the admin deselecting everyone — one failed
    // read would silently wipe the group's membership on the next save.
    if (error) throw new Error(error.message || 'Failed to load group members')
    members = (data || []).sort((a, b) => String(a.name ?? '').localeCompare(String(b.name ?? '')))
  }

  let price_list: { id: string; name: string } | null = null
  if (group.price_list_id) {
    const { data } = await supabaseAdmin.from('price_lists').select('id, name').eq('id', group.price_list_id).maybeSingle()
    price_list = (data as { id: string; name: string } | null) ?? null
  }

  const salesmanMap = group.salesman_id ? await resolveUserDisplayMap([group.salesman_id]) : {}

  return {
    ...group,
    members,
    salesman_name: group.salesman_id ? (salesmanMap[group.salesman_id]?.name ?? null) : null,
    price_list,
  }
}
