import { supabaseAdmin } from '@/lib/supabase-server'
import { runDirectSql } from '@/lib/direct-sql'
import { fetchAllInChunks } from '@/lib/supabase-in-chunks'

// Confirmed invoice_requests are surfaced in the payments UI as "invoices" but they
// are NOT rows in the invoices table (they live in invoice_requests / company_notes
// and derive their total from orders.grand_total). The payments table can therefore
// not link to them via payment_invoice_links (FK → invoices.id). This module gives
// request-based invoices their own lightweight allocation ledger so a partial
// payment against one is remembered and reflected on the next load.

const TABLE = 'invoice_request_payments'

// Deployments without DDL access can't create the dedicated ledger table (the
// CREATE TABLE via exec_sql / direct SQL silently no-ops). In that case we
// persist each allocation as a prefixed company_notes row — the exact same
// fallback the invoice_requests themselves use — so a partial payment against a
// request-based invoice still survives a reload.
const NOTE_PREFIX = 'SYSTEM_IR_PAYMENT::'

type AllocationNote = {
  request_id: string
  payment_id: string
  party_id: string
  amount: number
  order_id: string | null
  company_id: string | null
  created_at: string
}

function buildAllocationNote(payload: AllocationNote): string {
  return `${NOTE_PREFIX}${JSON.stringify(payload)}`
}

function parseAllocationNote(note: string | null): AllocationNote | null {
  if (!note || !note.startsWith(NOTE_PREFIX)) return null
  try {
    return JSON.parse(note.slice(NOTE_PREFIX.length)) as AllocationNote
  } catch {
    return null
  }
}

type DbError = { code?: string; message?: string; details?: string }

function isMissingSchemaPiece(error: DbError | null | undefined) {
  if (!error) return false
  const text = `${error.message || ''} ${error.details || ''}`.toLowerCase()
  return (
    error.code === '42P01' ||
    error.code === '42703' ||
    error.code === 'PGRST200' ||
    error.code === 'PGRST204' ||
    error.code === 'PGRST205' ||
    text.includes('schema cache') ||
    text.includes('could not find') ||
    text.includes('does not exist') ||
    text.includes('relation')
  )
}

export async function ensureInvoiceRequestPaymentsSchema(): Promise<boolean> {
  const sql = `
      CREATE TABLE IF NOT EXISTS public.invoice_request_payments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        request_id TEXT NOT NULL,
        order_id UUID,
        payment_id UUID,
        party_id UUID,
        amount FLOAT NOT NULL DEFAULT 0,
        company_id UUID,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_irp_request ON public.invoice_request_payments(request_id);
      CREATE INDEX IF NOT EXISTS idx_irp_payment ON public.invoice_request_payments(payment_id);
      NOTIFY pgrst, 'reload schema';
    `
  const { error } = await supabaseAdmin.rpc('exec_sql', { sql })
  if (!error) return true
  return runDirectSql(sql)
}

export interface InvoiceRequestPaymentInput {
  request_id: string
  payment_id: string
  party_id: string
  amount: number
  order_id?: string | null
  company_id?: string | null
}

// Records an allocation against a request-based invoice. Non-fatal: a payment must
// still succeed even if this ledger can't be written, so failures are logged, not thrown.
export async function recordInvoiceRequestPayment(input: InvoiceRequestPaymentInput): Promise<void> {
  const row: Record<string, unknown> = {
    request_id: input.request_id,
    payment_id: input.payment_id,
    party_id: input.party_id,
    amount: Number(input.amount),
  }
  if (input.order_id) row.order_id = input.order_id
  if (input.company_id) row.company_id = input.company_id

  const first = await supabaseAdmin.from(TABLE).insert(row)
  if (!first.error) return
  if (!isMissingSchemaPiece(first.error)) {
    console.warn('[invoice_request_payments] insert failed:', first.error.message)
    return
  }

  await ensureInvoiceRequestPaymentsSchema()
  const retry = await supabaseAdmin.from(TABLE).insert(row)
  if (!retry.error) return
  if (isMissingSchemaPiece(retry.error)) {
    // Table still unavailable (no DDL privilege) — fall back to company_notes so
    // the allocation is not silently lost.
    await recordAllocationInNotes(input)
    return
  }
  console.warn('[invoice_request_payments] insert failed after heal:', retry.error.message)
}

// company_notes fallback writer for a single allocation.
async function recordAllocationInNotes(input: InvoiceRequestPaymentInput): Promise<void> {
  const payload: AllocationNote = {
    request_id: input.request_id,
    payment_id: input.payment_id,
    party_id: input.party_id,
    amount: Number(input.amount),
    order_id: input.order_id ?? null,
    company_id: input.company_id ?? null,
    created_at: new Date().toISOString(),
  }
  const { error } = await supabaseAdmin.from('company_notes').insert({
    company_id: input.company_id ?? null,
    note: buildAllocationNote(payload),
  })
  if (error) {
    console.warn('[invoice_request_payments] company_notes fallback failed:', error.message)
  }
}

// Sums allocations stored in the company_notes fallback for the given request ids.
async function getPaidAmountsFromNotes(idSet: Set<string>): Promise<Map<string, number>> {
  const paid = new Map<string, number>()
  const { data, error } = await supabaseAdmin
    .from('company_notes')
    .select('note')
    .like('note', `${NOTE_PREFIX}%`)
    .limit(5000)
  if (error) return paid

  for (const r of (data || []) as { note: string | null }[]) {
    const parsed = parseAllocationNote(r.note)
    if (!parsed) continue
    const key = String(parsed.request_id || '')
    if (!idSet.has(key)) continue
    paid.set(key, (paid.get(key) || 0) + Number(parsed.amount || 0))
  }
  return paid
}

// Returns a map of request_id → total amount paid across all recorded allocations.
// If the ledger table does not exist yet, every request simply has zero paid.
export async function getPaidAmountsByRequestIds(
  requestIds: string[],
): Promise<Map<string, number>> {
  const paid = new Map<string, number>()
  const ids = [...new Set(requestIds.filter(Boolean))]
  if (ids.length === 0) return paid
  const idSet = new Set(ids)

  // Chunked: large request-id sets overflow PostgREST's URL-encoded .in() filter.
  const { data, error } = await fetchAllInChunks<{ request_id: string; amount: number }>(
    ids,
    (chunk) => supabaseAdmin.from(TABLE).select('request_id, amount').in('request_id', chunk),
  )

  if (!error) {
    for (const r of (data || []) as { request_id: string; amount: number }[]) {
      const key = String(r.request_id)
      paid.set(key, (paid.get(key) || 0) + Number(r.amount || 0))
    }
  }

  // Always fold in company_notes-stored allocations too. On deployments without
  // the dedicated table, this is the only source; where the table exists it
  // covers any legacy rows written before it did. Each allocation lives in
  // exactly one place, so summing both can never double-count.
  const fromNotes = await getPaidAmountsFromNotes(idSet)
  for (const [key, amount] of fromNotes) {
    paid.set(key, (paid.get(key) || 0) + amount)
  }

  return paid
}

export interface InvoiceRequestPaymentAllocation {
  request_id: string
  amount: number
}

// Returns the request-invoice allocations made by one payment. This mirrors the
// reversal path below and reads both storage backends, allowing payment detail
// screens to show exactly which confirmed request invoice received the money.
export async function getInvoiceRequestAllocationsForPayment(
  paymentId: string,
): Promise<InvoiceRequestPaymentAllocation[]> {
  if (!paymentId) return []

  const allocations: InvoiceRequestPaymentAllocation[] = []
  const { data, error } = await supabaseAdmin
    .from(TABLE)
    .select('request_id, amount')
    .eq('payment_id', paymentId)

  if (!error) {
    for (const row of (data || []) as { request_id: string; amount: number }[]) {
      allocations.push({
        request_id: String(row.request_id || ''),
        amount: Number(row.amount || 0),
      })
    }
  }

  const { data: noteRows, error: noteError } = await supabaseAdmin
    .from('company_notes')
    .select('note')
    .like('note', `${NOTE_PREFIX}%`)
    .limit(5000)

  if (!noteError) {
    for (const row of (noteRows || []) as { note: string | null }[]) {
      const parsed = parseAllocationNote(row.note)
      if (!parsed || String(parsed.payment_id || '') !== paymentId) continue
      allocations.push({
        request_id: String(parsed.request_id || ''),
        amount: Number(parsed.amount || 0),
      })
    }
  }

  return allocations.filter((allocation) => allocation.request_id && allocation.amount > 0)
}

// Removes every allocation tied to a deleted payment so reversals are accurate.
export async function reverseInvoiceRequestPaymentsForPayment(paymentId: string): Promise<void> {
  const { error } = await supabaseAdmin.from(TABLE).delete().eq('payment_id', paymentId)
  if (error && !isMissingSchemaPiece(error)) {
    console.warn('[invoice_request_payments] reversal failed:', error.message)
  }

  // Also remove any company_notes-stored allocations tied to this payment.
  const { data, error: readErr } = await supabaseAdmin
    .from('company_notes')
    .select('id, note')
    .like('note', `${NOTE_PREFIX}%`)
    .limit(5000)
  if (readErr) return

  const idsToDelete = (data || [])
    .filter((r: { note: string | null }) => {
      const parsed = parseAllocationNote(r.note)
      return parsed && String(parsed.payment_id || '') === paymentId
    })
    .map((r: { id: string }) => r.id)

  if (idsToDelete.length > 0) {
    await supabaseAdmin.from('company_notes').delete().in('id', idsToDelete)
  }
}
