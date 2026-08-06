import { supabaseAdmin } from '@/lib/supabase-server'
import { recalcPartySchemesFromInvoices } from '@/lib/scheme-progress'

/**
 * Side-effects that must run whenever an invoice request becomes CONFIRMED —
 * whether confirmed manually by the party (PUT /invoice-requests/[id]) or
 * auto-confirmed at initiation time when the approval kill switch is OFF
 * (POST /invoice-requests). Kept in one place so both paths stay identical.
 */

/**
 * Fire-and-forget: recompute the RECIPIENT party's INVOICE_SCHEME progress from
 * its confirmed invoices. An INVOICE scheme moves when an invoice issued TO the
 * party is confirmed, so the bar is recomputed for that party (party_id), not
 * the actor confirming. `companyId` (the invoice's company) lets the engine
 * short-circuit the company-scope walk; it falls back to walking up otherwise.
 */
export function recomputeInvoiceSchemes(partyId: string | null, companyId: string | null): void {
  if (!partyId) return
  recalcPartySchemesFromInvoices({ party_id: partyId }, companyId).catch(
    (e: unknown) => console.warn('[scheme_progress invoice]', e instanceof Error ? e.message : e),
  )
}

/**
 * Marks an order DELIVERED, stepping it through DISPATCHED first when it is
 * still mid-procurement so status history stays coherent. Idempotent.
 */
export async function markOrderDelivered(orderId: string, logPrefix: string): Promise<void> {
  const { data: currentOrder } = await supabaseAdmin
    .from('orders')
    .select('status')
    .eq('id', orderId)
    .maybeSingle()

  if (!currentOrder || currentOrder.status === 'DELIVERED') return

  if (['PROCUREMENT', 'IN_PROCUREMENT', 'APPROVED'].includes(currentOrder.status)) {
    const { error: dispatchErr } = await supabaseAdmin
      .from('orders')
      .update({ status: 'DISPATCHED' })
      .eq('id', orderId)
    if (dispatchErr) {
      console.error(`${logPrefix} Failed to update order to DISPATCHED:`, dispatchErr.message)
    }
  }

  const { error: deliverErr } = await supabaseAdmin
    .from('orders')
    .update({ status: 'DELIVERED' })
    .eq('id', orderId)
  if (deliverErr) {
    console.error(`${logPrefix} Failed to update order to DELIVERED:`, deliverErr.message)
  }
}

/**
 * Run all CONFIRMED side-effects for an invoice request: walk the order to
 * DELIVERED and recompute the recipient party's invoice-scheme progress.
 */
export async function applyInvoiceConfirmedEffects(
  orderId: string | null,
  partyId: string | null,
  companyId: string | null,
  logPrefix: string,
): Promise<void> {
  if (orderId) {
    await markOrderDelivered(orderId, logPrefix)
  }
  recomputeInvoiceSchemes(partyId, companyId)
}
