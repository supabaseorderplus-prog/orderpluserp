import { supabaseAdmin, type AuthUser } from '@/lib/supabase-server'
import { fetchAllRows } from '@/lib/supabase-in-chunks'

export const PAYMENT_APPROVAL_PREFIX = 'SYSTEM_PAYMENT_APPROVAL::'
const DEFAULT_TTL_HOURS = 72

export type PaymentApprovalStatus = 'ACTIVE' | 'PROCESSING' | 'APPROVED' | 'EXPIRED' | 'REVOKED'

export interface PendingPaymentPayload {
  party_id: string
  amount: number
  payment_mode: string
  reference_number?: string | null
  bank_name?: string | null
  proof_url?: string | null
  is_advance?: boolean
  notes?: string | null
  adjustments?: Array<{ invoiceId: string; amount: number }>
  skip_party_scheme?: boolean
  applied_scheme_ids?: string[]
}

export interface PaymentApprovalInvoice {
  id: string
  invoice_number: string
  invoice_date: string | null
  invoice_total: number
  outstanding_before: number
  allocation: number
  outstanding_after: number
  status_after: 'PAID' | 'PARTIAL' | 'UNPAID'
}

export interface PaymentApprovalScheme {
  id: string
  name: string
  target_value: number
  current_value: number
  payment_credit: number
  projected_value: number
  progress_before: number
  progress_after: number
  status_before: string
  status_after: string
  end_date: string | null
  reward_description?: string | null
}

export interface PaymentApprovalRecord {
  token: string
  request_number: string
  status: PaymentApprovalStatus
  company_id: string | null
  company_name: string
  party_id: string
  party_name: string
  party_code: string
  party_phone: string
  collector_id: string | null
  collector_name: string
  auth_user: AuthUser
  payload: PendingPaymentPayload
  invoices: PaymentApprovalInvoice[]
  schemes: PaymentApprovalScheme[]
  balance_before: number
  balance_after: number
  unallocated_amount: number
  created_at: string
  expires_at: string
  processing_at: string | null
  approved_at: string | null
  approved_name: string | null
  payment_id: string | null
  payment_number: string | null
  last_error: string | null
}

type NoteRow = { id: string; note: string | null }

const encode = (record: PaymentApprovalRecord) => `${PAYMENT_APPROVAL_PREFIX}${JSON.stringify(record)}`

function decode(note: string | null): PaymentApprovalRecord | null {
  if (!note?.startsWith(PAYMENT_APPROVAL_PREFIX)) return null
  try {
    const parsed = JSON.parse(note.slice(PAYMENT_APPROVAL_PREFIX.length)) as PaymentApprovalRecord
    return parsed?.token && parsed?.request_number ? parsed : null
  } catch {
    return null
  }
}

/**
 * Returns payment-approval requests stored for a company. These records are the
 * source of truth for the gap between a salesman initiating a collection and
 * the party approving it (at which point a real `payments` row is created).
 *
 * Callers must apply their own party/role scope when `companyId` is null. The
 * route that exposes this to the dashboard does that before returning data.
 */
export async function listPaymentApprovalRecords(companyId: string | null): Promise<PaymentApprovalRecord[]> {
  const { data, error } = await fetchAllRows<NoteRow>((from, to) => {
    let query = supabaseAdmin
      .from('company_notes')
      .select('id, note')
      .like('note', `${PAYMENT_APPROVAL_PREFIX}%`)
    if (companyId) query = query.eq('company_id', companyId)
    return query.order('id', { ascending: true }).range(from, to)
  })
  if (error) throw error
  return (data || []).map((row) => decode(row.note)).filter((record): record is PaymentApprovalRecord => Boolean(record))
}

function generateToken(): string {
  const bytes = new Uint8Array(32)
  globalThis.crypto.getRandomValues(bytes)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function effectivePaymentApprovalStatus(record: PaymentApprovalRecord): PaymentApprovalStatus {
  if (record.status === 'APPROVED' || record.status === 'REVOKED') return record.status
  if (new Date(record.expires_at).getTime() <= Date.now()) return 'EXPIRED'
  // A worker that died while posting must not lock the party out forever.
  if (record.status === 'PROCESSING' && record.processing_at) {
    const staleAt = new Date(record.processing_at).getTime() + 2 * 60 * 1000
    if (staleAt <= Date.now()) return 'ACTIVE'
  }
  return record.status
}

export async function createPaymentApproval(
  input: Omit<PaymentApprovalRecord, 'token' | 'status' | 'created_at' | 'expires_at' | 'processing_at' | 'approved_at' | 'approved_name' | 'payment_id' | 'payment_number' | 'last_error'> & { ttlHours?: number },
): Promise<PaymentApprovalRecord> {
  const now = new Date()
  const record: PaymentApprovalRecord = {
    ...input,
    token: generateToken(),
    status: 'ACTIVE',
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + (input.ttlHours ?? DEFAULT_TTL_HOURS) * 60 * 60 * 1000).toISOString(),
    processing_at: null,
    approved_at: null,
    approved_name: null,
    payment_id: null,
    payment_number: null,
    last_error: null,
  }
  delete (record as PaymentApprovalRecord & { ttlHours?: number }).ttlHours
  const { error } = await supabaseAdmin.from('company_notes').insert({ company_id: record.company_id, note: encode(record) })
  if (error) throw error
  return record
}

export async function getPaymentApprovalByToken(token: string): Promise<{ noteRowId: string; record: PaymentApprovalRecord; effective: PaymentApprovalStatus } | null> {
  if (!token || token.length < 20) return null
  const { data, error } = await supabaseAdmin
    .from('company_notes')
    .select('id, note')
    .like('note', `${PAYMENT_APPROVAL_PREFIX}%${token}%`)
    .limit(20)
  if (error) throw error
  for (const row of (data || []) as NoteRow[]) {
    const record = decode(row.note)
    if (record?.token === token) return { noteRowId: row.id, record, effective: effectivePaymentApprovalStatus(record) }
  }
  return null
}

export async function claimPaymentApproval(token: string, approverName: string) {
  const found = await getPaymentApprovalByToken(token)
  if (!found) return { ok: false as const, reason: 'NOT_FOUND' as const }
  if (found.effective !== 'ACTIVE') return { ok: false as const, reason: found.effective }

  const next: PaymentApprovalRecord = {
    ...found.record,
    status: 'PROCESSING',
    processing_at: new Date().toISOString(),
    approved_name: approverName.trim().slice(0, 120) || found.record.party_name || 'Party',
    last_error: null,
  }
  const { data, error } = await supabaseAdmin
    .from('company_notes')
    .update({ note: encode(next) })
    .eq('id', found.noteRowId)
    .eq('note', encode(found.record))
    .select('id')
  if (error) throw error
  if (!data?.length) return { ok: false as const, reason: 'PROCESSING' as const }
  return { ok: true as const, record: next }
}

export async function completePaymentApproval(token: string, payment: { id?: unknown; payment_number?: unknown }) {
  const found = await getPaymentApprovalByToken(token)
  if (!found || found.record.status !== 'PROCESSING') return false
  const next: PaymentApprovalRecord = {
    ...found.record,
    status: 'APPROVED',
    approved_at: new Date().toISOString(),
    payment_id: typeof payment.id === 'string' ? payment.id : null,
    payment_number: typeof payment.payment_number === 'string' ? payment.payment_number : null,
    last_error: null,
  }
  const { data, error } = await supabaseAdmin
    .from('company_notes')
    .update({ note: encode(next) })
    .eq('id', found.noteRowId)
    .eq('note', encode(found.record))
    .select('id')
  if (error) throw error
  return Boolean(data?.length)
}

export async function releasePaymentApproval(token: string, message: string) {
  const found = await getPaymentApprovalByToken(token)
  if (!found || found.record.status !== 'PROCESSING') return
  const next: PaymentApprovalRecord = {
    ...found.record,
    status: 'ACTIVE',
    processing_at: null,
    last_error: message.slice(0, 500),
  }
  await supabaseAdmin
    .from('company_notes')
    .update({ note: encode(next) })
    .eq('id', found.noteRowId)
    .eq('note', encode(found.record))
}

/**
 * Revokes an unapproved request with a compare-and-swap update. Keeping the
 * record (instead of deleting the note) preserves an audit trail while making
 * every public URL backed by the token return HTTP 410 immediately.
 */
export async function revokePaymentApproval(token: string) {
  const found = await getPaymentApprovalByToken(token)
  if (!found) return { ok: false as const, reason: 'NOT_FOUND' as const }
  if (found.effective !== 'ACTIVE') return { ok: false as const, reason: found.effective }

  const now = new Date().toISOString()
  const next: PaymentApprovalRecord = {
    ...found.record,
    status: 'REVOKED',
    expires_at: now,
    processing_at: null,
    last_error: null,
  }
  const { data, error } = await supabaseAdmin
    .from('company_notes')
    .update({ note: encode(next) })
    .eq('id', found.noteRowId)
    .eq('note', encode(found.record))
    .select('id')
  if (error) throw error
  if (!data?.length) return { ok: false as const, reason: 'PROCESSING' as const }
  return { ok: true as const, record: next }
}
