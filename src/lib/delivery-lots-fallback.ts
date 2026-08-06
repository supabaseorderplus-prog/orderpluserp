import { supabaseAdmin } from '@/lib/supabase-server'

export const DELIVERY_LOT_FALLBACK_PREFIX = 'SYSTEM_DELIVERY_LOT::'

export type DeliveryLotFallbackRecord = {
  id: string
  lot_number: string
  name: string
  dispatch_date: string
  destination: string
  vehicle_no: string
  notes: string
  status: 'OPEN' | 'READY' | 'DISPATCHED' | 'DELIVERED'
  order_ids: string[]
  order_meta: Record<string, { invoice_number: string; party_name: string; grand_total: number }>
  driver_id: string
  driver_name: string
  company_id: string | null
  created_by: string | null
  created_at: string
  updated_at: string
  manufacturing_statuses: Record<string, string>
}

type CompanyNoteRow = { id: string; company_id: string | null; note: string | null }

function encode(record: DeliveryLotFallbackRecord) {
  return `${DELIVERY_LOT_FALLBACK_PREFIX}${JSON.stringify(record)}`
}

function decode(note: string | null): DeliveryLotFallbackRecord | null {
  if (!note?.startsWith(DELIVERY_LOT_FALLBACK_PREFIX)) return null
  try {
    const parsed = JSON.parse(note.slice(DELIVERY_LOT_FALLBACK_PREFIX.length)) as DeliveryLotFallbackRecord
    return parsed?.id && parsed?.lot_number ? parsed : null
  } catch {
    return null
  }
}

async function rows(companyId: string | null) {
  let query = supabaseAdmin
    .from('company_notes')
    .select('id, company_id, note')
    .like('note', `${DELIVERY_LOT_FALLBACK_PREFIX}%`)
    .order('created_at', { ascending: false })
    .limit(5000)
  query = companyId ? query.eq('company_id', companyId) : query.is('company_id', null)
  const { data, error } = await query
  if (error) throw error
  return ((data || []) as CompanyNoteRow[])
    .map((noteRow) => ({ noteRow, lot: decode(noteRow.note) }))
    .filter((entry): entry is { noteRow: CompanyNoteRow; lot: DeliveryLotFallbackRecord } => !!entry.lot)
}

export async function listFallbackDeliveryLots(companyId: string | null, status?: string | null) {
  const all = (await rows(companyId)).map((entry) => entry.lot)
  return status ? all.filter((lot) => lot.status === status) : all
}

export async function createFallbackDeliveryLot(input: {
  companyId: string | null
  createdBy: string | null
  name: string
  dispatch_date?: string
  destination?: string
  vehicle_no?: string
  notes?: string
  driver_id?: string
  driver_name?: string
  order_ids?: string[]
  order_meta?: DeliveryLotFallbackRecord['order_meta']
  manufacturing_statuses?: Record<string, string>
}) {
  const existing = await listFallbackDeliveryLots(input.companyId)
  const nextNumber = existing.reduce((max, lot) => {
    const value = Number(lot.lot_number.match(/LOT-(\d+)/)?.[1] || 0)
    return Math.max(max, value)
  }, 0) + 1
  const now = new Date().toISOString()
  const record: DeliveryLotFallbackRecord = {
    id: crypto.randomUUID(),
    lot_number: `LOT-${String(nextNumber).padStart(3, '0')}`,
    name: input.name,
    dispatch_date: input.dispatch_date || '',
    destination: input.destination || '',
    vehicle_no: input.vehicle_no || '',
    notes: input.notes || '',
    status: 'OPEN',
    order_ids: [...new Set(input.order_ids || [])],
    order_meta: input.order_meta || {},
    driver_id: input.driver_id || '',
    driver_name: input.driver_name || '',
    company_id: input.companyId,
    created_by: input.createdBy,
    created_at: now,
    updated_at: now,
    manufacturing_statuses: input.manufacturing_statuses || {},
  }
  const { error } = await supabaseAdmin.from('company_notes').insert({
    company_id: input.companyId,
    note: encode(record),
  })
  if (error) throw error
  return record
}

export async function updateFallbackDeliveryLot(
  id: string,
  companyId: string | null,
  updates: Partial<DeliveryLotFallbackRecord>,
) {
  const existing = (await rows(companyId)).find((entry) => entry.lot.id === id)
  if (!existing) return null
  const defined = Object.fromEntries(Object.entries(updates).filter(([, value]) => value !== undefined))
  const next: DeliveryLotFallbackRecord = {
    ...existing.lot,
    ...defined,
    order_ids: updates.order_ids ? [...new Set(updates.order_ids)] : existing.lot.order_ids,
    order_meta: updates.order_meta ? { ...existing.lot.order_meta, ...updates.order_meta } : existing.lot.order_meta,
    manufacturing_statuses: updates.manufacturing_statuses
      ? { ...existing.lot.manufacturing_statuses, ...updates.manufacturing_statuses }
      : existing.lot.manufacturing_statuses,
    updated_at: new Date().toISOString(),
  }
  if (next.status === 'DISPATCHED' && existing.lot.status !== 'READY') {
    const incomplete = next.order_ids.filter(
      (orderId) => (next.manufacturing_statuses[orderId] || '').toLowerCase() !== 'completed',
    )
    if (incomplete.length) {
      throw new Error(`Cannot dispatch: ${incomplete.length} order${incomplete.length === 1 ? '' : 's'} still pending manufacturing. Mark all orders as Complete first.`)
    }
  }
  // updated_at is bumped explicitly: getFallbackDeliveryLotsVersion reads it as the
  // change signal, and rewriting `note` alone would leave the row's timestamp stale.
  const { error } = await supabaseAdmin
    .from('company_notes')
    .update({ note: encode(next), updated_at: next.updated_at })
    .eq('id', existing.noteRow.id)
  if (error) throw error
  return next
}

/**
 * Cheap change signal for the fallback store — a row count plus the newest
 * updated_at, so a poller can detect "something changed" without pulling every
 * lot blob out of company_notes. Returns null when the query fails, which the
 * caller treats as "unknown" and falls back to a full fetch.
 */
export async function getFallbackDeliveryLotsVersion(companyId: string | null): Promise<string | null> {
  let query = supabaseAdmin
    .from('company_notes')
    .select('updated_at', { count: 'exact' })
    .like('note', `${DELIVERY_LOT_FALLBACK_PREFIX}%`)
    .order('updated_at', { ascending: false })
    .limit(1)
  query = companyId ? query.eq('company_id', companyId) : query.is('company_id', null)

  const { data, count, error } = await query
  if (error) return null
  const newest = (data?.[0] as { updated_at?: string } | undefined)?.updated_at || ''
  return `notes:${count ?? 0}:${newest}`
}

export async function deleteFallbackDeliveryLot(id: string, companyId: string | null) {
  const existing = (await rows(companyId)).find((entry) => entry.lot.id === id)
  if (!existing) return false
  const { error } = await supabaseAdmin.from('company_notes').delete().eq('id', existing.noteRow.id)
  if (error) throw error
  return true
}
