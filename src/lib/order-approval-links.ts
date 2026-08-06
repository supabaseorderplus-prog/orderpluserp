// Party-side approval links for the dual-approval flow.
//
// After staff approve an order (status APPROVED), an approval LINK is minted and
// shared to the party over WhatsApp. The party opens the link (no login), reviews
// the order + PDF, and confirms it — the order is then "dual-approved". Each link
// is a single-use bearer credential that EXPIRES the moment the party confirms
// (and also has a hard TTL).
//
// Storage: these records live as `company_notes` rows (the same schema-free
// key/value escape hatch used by delivery-lots / invoice-requests / expenses),
// so the feature ships without any blocked DDL. Each row's `note` is a
// prefixed JSON blob. Never expose the raw token anywhere except the shared URL.
import { supabaseAdmin } from '@/lib/supabase-server'
import { fetchAllInChunks } from '@/lib/supabase-in-chunks'

export const ORDER_APPROVAL_PREFIX = 'SYSTEM_ORDER_APPROVAL::'

// Hard expiry even if the party never opens the link.
const DEFAULT_TTL_DAYS = 14

export type ApprovalLinkStatus = 'ACTIVE' | 'APPROVED' | 'EXPIRED' | 'REVOKED'
export type ApprovalPurpose = 'ORDER' | 'INVOICE'

export interface OrderApprovalRecord {
  token: string
  order_id: string
  order_number: string
  company_id: string | null
  company_name: string
  party_id: string | null
  party_name: string
  party_phone: string
  grand_total: number
  status: ApprovalLinkStatus
  created_by: string | null
  created_at: string
  expires_at: string
  approved_at: string | null
  approved_name: string | null
  /** ORDER keeps the existing dual-approval flow; INVOICE confirms a linked invoice request. */
  purpose?: ApprovalPurpose
  invoice_request_id?: string | null
}

type CompanyNoteRow = { id: string; company_id: string | null; note: string | null }

interface StoredEntry {
  noteRowId: string
  record: OrderApprovalRecord
}

function encode(record: OrderApprovalRecord): string {
  return `${ORDER_APPROVAL_PREFIX}${JSON.stringify(record)}`
}

function decode(note: string | null): OrderApprovalRecord | null {
  if (!note?.startsWith(ORDER_APPROVAL_PREFIX)) return null
  try {
    const parsed = JSON.parse(note.slice(ORDER_APPROVAL_PREFIX.length)) as OrderApprovalRecord
    return parsed?.token && parsed?.order_id ? parsed : null
  } catch {
    return null
  }
}

/** 256 bits of URL-safe randomness — infeasible to guess. */
export function generateApprovalToken(): string {
  const bytes = new Uint8Array(32)
  globalThis.crypto.getRandomValues(bytes)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Normalise the effective status of a stored record (applies TTL on read). */
function effectiveStatus(record: OrderApprovalRecord): ApprovalLinkStatus {
  if (record.status === 'APPROVED' || record.status === 'REVOKED') return record.status
  if (record.expires_at && new Date(record.expires_at).getTime() < Date.now()) return 'EXPIRED'
  return record.status
}

// Scope semantics:
//   undefined  → every approval row (super admin, no company selected)
//   null       → only rows with company_id IS NULL
//   string     → rows for that single company_id
//   string[]   → rows for any of those company_ids (the party tree), chunked so a
//                large tree can't overflow PostgREST's request-URL header limit
async function loadAllRows(scope?: string | string[] | null): Promise<StoredEntry[]> {
  const base = () =>
    supabaseAdmin
      .from('company_notes')
      .select('id, company_id, note')
      .like('note', `${ORDER_APPROVAL_PREFIX}%`)
      .order('created_at', { ascending: false })
      .limit(5000)

  const toEntries = (rows: CompanyNoteRow[] | null): StoredEntry[] =>
    ((rows || []) as CompanyNoteRow[])
      .map((row) => ({ row, record: decode(row.note) }))
      .filter((e): e is { row: CompanyNoteRow; record: OrderApprovalRecord } => !!e.record)
      .map((e) => ({ noteRowId: e.row.id, record: e.record }))

  if (Array.isArray(scope)) {
    if (scope.length === 0) return []
    const { data, error } = await fetchAllInChunks<CompanyNoteRow>(scope, (chunk) =>
      base().in('company_id', chunk),
    )
    if (error) throw error
    return toEntries(data)
  }

  let query = base()
  if (scope !== undefined) {
    query = scope ? query.eq('company_id', scope) : query.is('company_id', null)
  }
  const { data, error } = await query
  if (error) throw error
  return toEntries(data)
}

/**
 * Mint a fresh approval link for an order. Any still-active links for the same
 * order are revoked first, so only ONE live link exists per order at a time.
 */
export async function createApprovalToken(input: {
  orderId: string
  orderNumber: string
  companyId: string | null
  companyName: string
  partyId: string | null
  partyName: string
  partyPhone: string
  grandTotal: number
  createdBy: string | null
  purpose?: ApprovalPurpose
  invoiceRequestId?: string | null
  ttlDays?: number
}): Promise<OrderApprovalRecord> {
  await revokeTokensForOrder(input.orderId, input.companyId, input.purpose || 'ORDER')

  const now = new Date()
  const expires = new Date(now.getTime() + (input.ttlDays ?? DEFAULT_TTL_DAYS) * 24 * 60 * 60 * 1000)
  const record: OrderApprovalRecord = {
    token: generateApprovalToken(),
    order_id: input.orderId,
    order_number: input.orderNumber,
    company_id: input.companyId,
    company_name: input.companyName || '',
    party_id: input.partyId,
    party_name: input.partyName || '',
    party_phone: input.partyPhone || '',
    grand_total: Number(input.grandTotal) || 0,
    status: 'ACTIVE',
    created_by: input.createdBy,
    created_at: now.toISOString(),
    expires_at: expires.toISOString(),
    approved_at: null,
    approved_name: null,
    purpose: input.purpose || 'ORDER',
    invoice_request_id: input.invoiceRequestId || null,
  }

  const { error } = await supabaseAdmin
    .from('company_notes')
    .insert({ company_id: input.companyId, note: encode(record) })
  if (error) throw error
  return record
}

/** Look up a single link by its token. Returns the row id so callers can update. */
export async function getApprovalByToken(
  token: string,
): Promise<{ noteRowId: string; record: OrderApprovalRecord; effective: ApprovalLinkStatus } | null> {
  if (!token || token.length < 20) return null
  const { data, error } = await supabaseAdmin
    .from('company_notes')
    .select('id, company_id, note')
    .like('note', `${ORDER_APPROVAL_PREFIX}%${token}%`)
    .limit(50)
  if (error) throw error
  for (const row of (data || []) as CompanyNoteRow[]) {
    const record = decode(row.note)
    if (record && record.token === token) {
      return { noteRowId: row.id, record, effective: effectiveStatus(record) }
    }
  }
  return null
}

/**
 * Party confirms the order. Single-use: succeeds only when the link is ACTIVE and
 * unexpired, and flips it to APPROVED so the link immediately stops working.
 */
export async function confirmApproval(
  token: string,
  approverName: string,
): Promise<{ ok: true; record: OrderApprovalRecord } | { ok: false; reason: ApprovalLinkStatus | 'NOT_FOUND' }> {
  const found = await getApprovalByToken(token)
  if (!found) return { ok: false, reason: 'NOT_FOUND' }
  if (found.effective !== 'ACTIVE') return { ok: false, reason: found.effective }

  const next: OrderApprovalRecord = {
    ...found.record,
    status: 'APPROVED',
    approved_at: new Date().toISOString(),
    approved_name: (approverName || '').trim().slice(0, 120) || found.record.party_name || 'Party',
  }
  // Optimistic compare-and-swap: two near-simultaneous taps must not both be
  // accepted. Only the request whose stored JSON is still unchanged can win.
  const { data, error } = await supabaseAdmin
    .from('company_notes')
    .update({ note: encode(next) })
    .eq('id', found.noteRowId)
    .eq('note', encode(found.record))
    .select('id')
  if (error) throw error
  if (!data || data.length === 0) {
    const latest = await getApprovalByToken(token)
    return { ok: false, reason: latest?.effective || 'NOT_FOUND' }
  }
  return { ok: true, record: next }
}

/** Revoke (kill) every still-active link for an order. */
export async function revokeTokensForOrder(
  orderId: string,
  companyId: string | null,
  purpose: ApprovalPurpose = 'ORDER',
): Promise<void> {
  const entries = (await loadAllRows(companyId ?? undefined)).filter(
    (e) =>
      e.record.order_id === orderId &&
      (e.record.purpose || 'ORDER') === purpose &&
      effectiveStatus(e.record) === 'ACTIVE',
  )
  for (const entry of entries) {
    const next: OrderApprovalRecord = { ...entry.record, status: 'REVOKED' }
    const { error } = await supabaseAdmin.from('company_notes').update({ note: encode(next) }).eq('id', entry.noteRowId)
    if (error) throw error
  }
}

/**
 * Invalidate the complete party-confirmation cycle when staff undo an order
 * approval. Confirmed records must be revoked as well as active links; otherwise
 * the old confirmation would continue to win in approval summaries after the
 * order is approved for a second time.
 */
export async function resetApprovalsForOrder(
  orderId: string,
  purpose: ApprovalPurpose = 'ORDER',
): Promise<void> {
  const { data, error } = await supabaseAdmin
    .from('company_notes')
    .select('id, company_id, note')
    .like('note', `${ORDER_APPROVAL_PREFIX}%"order_id":"${orderId}"%`)
    .limit(100)
  if (error) throw error

  const entries = ((data || []) as CompanyNoteRow[])
    .map((row) => ({ noteRowId: row.id, record: decode(row.note) }))
    .filter((entry): entry is StoredEntry =>
      !!entry.record &&
      entry.record.order_id === orderId &&
      (entry.record.purpose || 'ORDER') === purpose &&
      (effectiveStatus(entry.record) === 'ACTIVE' || effectiveStatus(entry.record) === 'APPROVED'),
    )
  for (const entry of entries) {
    const next: OrderApprovalRecord = { ...entry.record, status: 'REVOKED' }
    const { error } = await supabaseAdmin
      .from('company_notes')
      .update({ note: encode(next) })
      .eq('id', entry.noteRowId)
      .eq('note', encode(entry.record))
    if (error) throw error
  }
}

export interface OrderApprovalSummary {
  order_id: string
  status: ApprovalLinkStatus
  approved_at: string | null
  approved_name: string | null
  has_active_link: boolean
}

/**
 * Bulk "party-confirmation" summary for a company, keyed by order_id. For each
 * order we surface the most meaningful link: a confirmation wins over an active
 * link, which wins over expired/revoked. Powers the dual-approval badges.
 *
 * `scope` must be the caller's party-tree ids (as used to scope the orders list),
 * NOT a single company_id. An approval link is stored under the *minter's* party
 * scope (an admin stores the company root, a salesman stores their own node) and
 * `confirmApproval` flips it in place. Reading with a single exact company_id can
 * therefore miss a genuinely-confirmed record and leave the badge stuck on
 * "Awaiting". Passing the whole tree keeps this read aligned with the orders list
 * so the APPROVED record is always visible (and always wins the rank).
 * Pass `null` for an unscoped (super-admin, no company selected) read.
 */
export async function getApprovalSummaries(
  scope: string[] | null,
  purpose?: ApprovalPurpose,
): Promise<Record<string, OrderApprovalSummary>> {
  const entries = await loadAllRows(scope === null ? undefined : scope)
  const byOrder = new Map<string, OrderApprovalRecord[]>()
  for (const { record } of entries) {
    if (purpose && (record.purpose || 'ORDER') !== purpose) continue
    const list = byOrder.get(record.order_id) || []
    list.push(record)
    byOrder.set(record.order_id, list)
  }

  const rank: Record<ApprovalLinkStatus, number> = { APPROVED: 3, ACTIVE: 2, EXPIRED: 1, REVOKED: 0 }
  const out: Record<string, OrderApprovalSummary> = {}
  for (const [orderId, records] of byOrder) {
    let best: OrderApprovalRecord | null = null
    let bestStatus: ApprovalLinkStatus = 'REVOKED'
    for (const record of records) {
      const eff = effectiveStatus(record)
      if (!best || rank[eff] > rank[bestStatus]) {
        best = record
        bestStatus = eff
      }
    }
    if (!best) continue
    out[orderId] = {
      order_id: orderId,
      status: bestStatus,
      approved_at: bestStatus === 'APPROVED' ? best.approved_at : null,
      approved_name: bestStatus === 'APPROVED' ? best.approved_name : null,
      has_active_link: records.some((r) => effectiveStatus(r) === 'ACTIVE'),
    }
  }
  return out
}
