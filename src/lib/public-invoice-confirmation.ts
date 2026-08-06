import 'server-only'

import { supabaseAdmin } from '@/lib/supabase-server'
import { applyInvoiceConfirmedEffects } from '@/lib/invoice-confirm-effects'

const FALLBACK_PREFIX = 'SYSTEM_INVOICE_REQUEST::'

type InvoiceRequestRow = {
  id: string
  order_id: string | null
  party_id: string | null
  company_id?: string | null
  status: string
  invoice_number?: string | null
}

function parseFallback(note: string | null): Record<string, unknown> | null {
  if (!note?.startsWith(FALLBACK_PREFIX)) return null
  try {
    return JSON.parse(note.slice(FALLBACK_PREFIX.length)) as Record<string, unknown>
  } catch {
    return null
  }
}

/**
 * Confirms the invoice request tied to a public, single-use approval token.
 * The operation is idempotent: a repeated network request returns the already
 * confirmed invoice instead of generating a second invoice.
 */
export async function confirmInvoiceRequestFromPublicLink(input: {
  requestId?: string | null
  orderId: string
  approverName: string
}): Promise<{ id: string; invoiceNumber: string | null; alreadyConfirmed: boolean }> {
  let query = supabaseAdmin
    .from('invoice_requests')
    .select('id, order_id, party_id, company_id, status, invoice_number')

  query = input.requestId
    ? query.eq('id', input.requestId)
    : query.eq('order_id', input.orderId)

  const primary = await query.maybeSingle()
  if (!primary.error && primary.data) {
    const row = primary.data as InvoiceRequestRow
    if (row.order_id !== input.orderId) throw new Error('This confirmation link does not match the invoice order.')
    if (row.status === 'CONFIRMED') {
      return { id: row.id, invoiceNumber: row.invoice_number || null, alreadyConfirmed: true }
    }
    if (row.status !== 'PENDING') throw new Error(`This invoice request is ${row.status.toLowerCase()} and cannot be confirmed.`)

    const now = new Date().toISOString()
    const { data: updated, error } = await supabaseAdmin
      .from('invoice_requests')
      .update({
        status: 'CONFIRMED',
        confirmed_at: now,
        updated_at: now,
        notes: `Confirmed through secure WhatsApp link by ${input.approverName || 'Party'}`,
      })
      .eq('id', row.id)
      .eq('status', 'PENDING')
      .select('id, invoice_number')
      .maybeSingle()
    if (error) throw error

    // A simultaneous confirmation may have won the compare-and-swap.
    if (!updated) {
      const latest = await supabaseAdmin
        .from('invoice_requests')
        .select('id, status, invoice_number')
        .eq('id', row.id)
        .maybeSingle()
      if (latest.data?.status !== 'CONFIRMED') throw new Error('Invoice confirmation could not be completed. Please try again.')
      return { id: row.id, invoiceNumber: latest.data.invoice_number || null, alreadyConfirmed: true }
    }

    await applyInvoiceConfirmedEffects(row.order_id, row.party_id, row.company_id || null, '[public-invoice-confirm]')
    return { id: row.id, invoiceNumber: updated.invoice_number || row.invoice_number || null, alreadyConfirmed: false }
  }

  // Compatibility fallback for deployments where invoice_requests is stored in
  // company_notes. Match the explicit request id first, then the order id.
  const notes = await supabaseAdmin
    .from('company_notes')
    .select('id, note')
    .like('note', `${FALLBACK_PREFIX}%`)
    .order('created_at', { ascending: false })
    .limit(5000)
  if (notes.error) throw notes.error

  const found = (notes.data || [])
    .map((row) => ({ row, request: parseFallback(row.note) }))
    .find(({ request }) => request && (
      (input.requestId && String(request.id || '') === input.requestId) ||
      (!input.requestId && String(request.order_id || '') === input.orderId)
    ))
  if (!found?.request) throw new Error('The pending invoice request could not be found.')
  if (String(found.request.order_id || '') !== input.orderId) throw new Error('This confirmation link does not match the invoice order.')

  const status = String(found.request.status || '')
  if (status === 'CONFIRMED') {
    return {
      id: String(found.request.id || ''),
      invoiceNumber: found.request.invoice_number ? String(found.request.invoice_number) : null,
      alreadyConfirmed: true,
    }
  }
  if (status !== 'PENDING') throw new Error(`This invoice request is ${status.toLowerCase()} and cannot be confirmed.`)

  const now = new Date().toISOString()
  const next: Record<string, unknown> = {
    ...found.request,
    status: 'CONFIRMED',
    confirmed_at: now,
    updated_at: now,
    confirmed_by_name: input.approverName || 'Party',
    notes: `Confirmed through secure WhatsApp link by ${input.approverName || 'Party'}`,
  }
  const encoded = `${FALLBACK_PREFIX}${JSON.stringify(next)}`
  const { data: updatedNotes, error: updateError } = await supabaseAdmin
    .from('company_notes')
    .update({ note: encoded, updated_at: now })
    .eq('id', found.row.id)
    .eq('note', found.row.note)
    .select('id')
  if (updateError) throw updateError
  if (!updatedNotes || updatedNotes.length === 0) {
    throw new Error('This invoice was already processed. Refresh to see its current status.')
  }

  await applyInvoiceConfirmedEffects(
    input.orderId,
    next.party_id ? String(next.party_id) : null,
    next.company_id ? String(next.company_id) : null,
    '[public-invoice-confirm][fallback]',
  )
  return {
    id: String(next.id || ''),
    invoiceNumber: next.invoice_number ? String(next.invoice_number) : null,
    alreadyConfirmed: false,
  }
}
