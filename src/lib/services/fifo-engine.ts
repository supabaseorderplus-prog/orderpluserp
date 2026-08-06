import { supabaseAdmin } from '@/lib/supabase-server'

interface FifoParams {
  partyId: string
  companyId: string | null
  amount: number
  receiptId: string
}

/**
 * FIFO Payment Allocation
 * Applies a payment amount to the oldest unpaid/partial invoices first.
 * Updates invoice payment_status to PARTIAL or PAID and records payment_invoice_links.
 */
export async function applyFifo({ partyId, companyId, amount, receiptId }: FifoParams): Promise<void> {
  let remaining = amount

  // Fetch oldest invoices with outstanding balance, FIFO order
  let query = supabaseAdmin
    .from('invoices')
    .select('id, invoice_number, grand_total, amount_paid, amount_outstanding, payment_status')
    .eq('billing_party_id', partyId)
    .in('payment_status', ['UNPAID', 'PARTIAL'])
    .not('is_cancelled', 'eq', true)
    .order('invoice_date', { ascending: true })
    .order('created_at', { ascending: true })
    .limit(100)

  if (companyId) query = query.eq('company_id', companyId)

  const { data: invoices, error } = await query
  if (error || !invoices || invoices.length === 0) return

  for (const inv of invoices) {
    if (remaining <= 0) break

    const outstanding = Number(inv.amount_outstanding || 0)
    if (outstanding <= 0) continue

    const applied = Math.min(remaining, outstanding)
    const newPaid = Number(inv.amount_paid || 0) + applied
    const newOutstanding = Math.max(0, Number(inv.grand_total) - newPaid)
    const newStatus = newOutstanding <= 0.01 ? 'PAID' : 'PARTIAL'

    await Promise.all([
      supabaseAdmin.from('invoices').update({
        amount_paid: newPaid,
        amount_outstanding: newOutstanding,
        payment_status: newStatus,
      }).eq('id', inv.id),

      supabaseAdmin.from('payment_invoice_links').insert({
        payment_id: receiptId,
        invoice_id: inv.id,
        adjusted_amount: applied,
      }),
    ])

    remaining -= applied
  }
}
