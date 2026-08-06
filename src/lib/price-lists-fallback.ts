import { supabaseAdmin } from '@/lib/supabase-server'

export const PRICE_LIST_FALLBACK_NOTE_PREFIX = 'SYSTEM_PRICE_LIST::'

export type PriceListItemFallback = {
  product_id: string
  unit_price: number
  min_margin_floor: number | null
  max_margin_ceiling: number | null
  status: string
}

export type PriceListFallbackRecord = {
  id: string
  company_id: string
  name: string
  code: string
  applicable_party_type: string
  party_id: string | null
  group_id: string | null
  valid_from: string
  valid_to: string | null
  is_current: boolean
  notes: string | null
  status: string
  created_at: string
  updated_at: string
  items: PriceListItemFallback[]
}

type CompanyNoteRow = {
  id: string
  company_id: string | null
  note: string | null
  created_at?: string | null
  updated_at?: string | null
}

function buildPriceListFallbackNote(record: PriceListFallbackRecord): string {
  return `${PRICE_LIST_FALLBACK_NOTE_PREFIX}${JSON.stringify(record)}`
}

function parsePriceListFallbackNote(note: string | null): PriceListFallbackRecord | null {
  if (!note || !note.startsWith(PRICE_LIST_FALLBACK_NOTE_PREFIX)) return null
  try {
    const parsed = JSON.parse(note.slice(PRICE_LIST_FALLBACK_NOTE_PREFIX.length)) as Partial<PriceListFallbackRecord>
    if (!parsed.id || !parsed.company_id || !parsed.name || !parsed.code || !parsed.applicable_party_type) return null
    return {
      id: String(parsed.id),
      company_id: String(parsed.company_id),
      name: String(parsed.name),
      code: String(parsed.code),
      applicable_party_type: String(parsed.applicable_party_type),
      party_id: parsed.party_id ? String(parsed.party_id) : null,
      group_id: parsed.group_id ? String(parsed.group_id) : null,
      valid_from: parsed.valid_from ? String(parsed.valid_from) : new Date().toISOString().slice(0, 10),
      valid_to: parsed.valid_to ? String(parsed.valid_to) : null,
      is_current: parsed.is_current !== false,
      notes: parsed.notes ? String(parsed.notes) : null,
      status: parsed.status ? String(parsed.status) : 'ACTIVE',
      created_at: parsed.created_at ? String(parsed.created_at) : new Date().toISOString(),
      updated_at: parsed.updated_at ? String(parsed.updated_at) : new Date().toISOString(),
      items: Array.isArray(parsed.items)
        ? parsed.items.map((item) => ({
            product_id: String(item.product_id),
            unit_price: Number(item.unit_price || 0),
            min_margin_floor: item.min_margin_floor == null ? null : Number(item.min_margin_floor),
            max_margin_ceiling: item.max_margin_ceiling == null ? null : Number(item.max_margin_ceiling),
            status: item.status ? String(item.status) : 'ACTIVE',
          }))
        : [],
    }
  } catch {
    return null
  }
}

async function listFallbackRows(companyId: string): Promise<Array<{ noteRow: CompanyNoteRow; record: PriceListFallbackRecord }>> {
  const { data, error } = await supabaseAdmin
    .from('company_notes')
    .select('id, company_id, note, created_at, updated_at')
    .eq('company_id', companyId)
    .like('note', `${PRICE_LIST_FALLBACK_NOTE_PREFIX}%`)
    .order('created_at', { ascending: false })
    .limit(5000)

  if (error) throw error

  return ((data || []) as CompanyNoteRow[])
    .map((noteRow) => ({ noteRow, record: parsePriceListFallbackNote(noteRow.note) }))
    .filter((entry): entry is { noteRow: CompanyNoteRow; record: PriceListFallbackRecord } => !!entry.record)
}

export async function listFallbackPriceLists(companyId: string): Promise<PriceListFallbackRecord[]> {
  const rows = await listFallbackRows(companyId)
  return rows.map((entry) => entry.record).filter((record) => record.status === 'ACTIVE')
}

export async function createFallbackPriceList(input: Omit<PriceListFallbackRecord, 'id' | 'created_at' | 'updated_at' | 'status'>) {
  const now = new Date().toISOString()
  const record: PriceListFallbackRecord = {
    id: crypto.randomUUID(),
    company_id: input.company_id,
    name: input.name,
    code: input.code,
    applicable_party_type: input.applicable_party_type,
    party_id: input.party_id,
    group_id: input.group_id,
    valid_from: input.valid_from,
    valid_to: input.valid_to,
    is_current: input.is_current,
    notes: input.notes,
    status: 'ACTIVE',
    created_at: now,
    updated_at: now,
    items: input.items,
  }

  const { error } = await supabaseAdmin
    .from('company_notes')
    .insert({ company_id: input.company_id, note: buildPriceListFallbackNote(record) })
  if (error) throw error

  return record
}


export async function findFallbackPriceListForParty(params: {
  partyId: string
  partyType?: string | null
  companyIds?: string[]
  groupId?: string | null
}): Promise<PriceListFallbackRecord | null> {
  const { partyId, partyType, companyIds = [], groupId } = params
  const ids = [...new Set(companyIds.filter(Boolean))]
  if (ids.length === 0) return null

  let rows: PriceListFallbackRecord[] = []
  for (const companyId of ids) {
    try {
      rows.push(...await listFallbackPriceLists(companyId))
    } catch {
    }
  }
  if (rows.length === 0) return null

  const byPartyDirect = rows.find((row) => !row.group_id && row.party_id === partyId && row.is_current)
  if (byPartyDirect) return byPartyDirect

  if (groupId) {
    const groupRows = rows.filter((row) => row.group_id === groupId && row.is_current)
    const byPartyInGroup = groupRows.find((row) => row.party_id === partyId)
    if (byPartyInGroup) return byPartyInGroup
    if (partyType) {
      const byCategoryInGroup = groupRows.find((row) => !row.party_id && row.applicable_party_type === partyType)
      if (byCategoryInGroup) return byCategoryInGroup
    }
    const byWholeGroup = groupRows.find((row) => !row.party_id && (row.applicable_party_type === 'GROUP' || !row.applicable_party_type))
    if (byWholeGroup) return byWholeGroup
  }

  if (partyType) {
    const byType = rows.find((row) => !row.group_id && !row.party_id && row.applicable_party_type === partyType && row.is_current)
    if (byType) return byType
  }

  return null
}


/**
 * Like {@link findFallbackPriceListForParty} but returns EVERY note-stored list that
 * applies to the party, ordered highest precedence first (individual → group-party →
 * group-category → whole-group → category). Callers merge these so a product priced in
 * a lower-precedence list is still honored when the top list doesn't list it — instead
 * of silently dropping to base price.
 */
export async function findApplicableFallbackPriceLists(params: {
  partyId: string
  partyType?: string | null
  companyIds?: string[]
  groupId?: string | null
}): Promise<PriceListFallbackRecord[]> {
  const { partyId, partyType, companyIds = [], groupId } = params
  const ids = [...new Set(companyIds.filter(Boolean))]
  if (ids.length === 0) return []

  const rows: PriceListFallbackRecord[] = []
  for (const companyId of ids) {
    try {
      rows.push(...await listFallbackPriceLists(companyId))
    } catch {
    }
  }
  if (rows.length === 0) return []

  const ordered: PriceListFallbackRecord[] = []
  const pushUnique = (record: PriceListFallbackRecord | undefined) => {
    if (record && !ordered.some((r) => r.id === record.id)) ordered.push(record)
  }

  // 1. Individual override scoped to this exact party.
  pushUnique(rows.find((row) => !row.group_id && row.party_id === partyId && row.is_current))

  // 2-4. Group-scoped: this party within the group → category within the group → whole group.
  if (groupId) {
    const groupRows = rows.filter((row) => row.group_id === groupId && row.is_current)
    pushUnique(groupRows.find((row) => row.party_id === partyId))
    if (partyType) pushUnique(groupRows.find((row) => !row.party_id && row.applicable_party_type === partyType))
    pushUnique(groupRows.find((row) => !row.party_id && (row.applicable_party_type === 'GROUP' || !row.applicable_party_type)))
  }

  // 5. Category/type list (not group-scoped).
  if (partyType) {
    pushUnique(rows.find((row) => !row.group_id && !row.party_id && row.applicable_party_type === partyType && row.is_current))
  }

  return ordered
}


export async function getFallbackPriceListById(companyId: string, id: string): Promise<PriceListFallbackRecord | null> {
  const rows = await listFallbackRows(companyId)
  const match = rows.find((entry) => entry.record.id === id)
  return match?.record ?? null
}

export async function updateFallbackPriceList(
  companyId: string,
  id: string,
  input: Omit<PriceListFallbackRecord, 'id' | 'company_id' | 'created_at' | 'updated_at' | 'status'>,
): Promise<PriceListFallbackRecord | null> {
  const rows = await listFallbackRows(companyId)
  const existing = rows.find((entry) => entry.record.id === id)
  if (!existing) return null

  const updated: PriceListFallbackRecord = {
    ...existing.record,
    name: input.name,
    code: input.code,
    applicable_party_type: input.applicable_party_type,
    party_id: input.party_id,
    group_id: input.group_id,
    valid_from: input.valid_from,
    valid_to: input.valid_to,
    is_current: input.is_current,
    notes: input.notes,
    items: input.items,
    updated_at: new Date().toISOString(),
  }

  const { error } = await supabaseAdmin
    .from('company_notes')
    .update({ note: buildPriceListFallbackNote(updated) })
    .eq('id', existing.noteRow.id)
    .eq('company_id', companyId)
  if (error) throw error

  return updated
}

export async function deleteFallbackPriceList(companyId: string, id: string): Promise<boolean> {
  const rows = await listFallbackRows(companyId)
  const existing = rows.find((entry) => entry.record.id === id)
  if (!existing) return false

  const deleted: PriceListFallbackRecord = {
    ...existing.record,
    status: 'DELETED',
    updated_at: new Date().toISOString(),
  }

  const { error } = await supabaseAdmin
    .from('company_notes')
    .update({ note: buildPriceListFallbackNote(deleted) })
    .eq('id', existing.noteRow.id)
    .eq('company_id', companyId)
  if (error) throw error

  return true
}
