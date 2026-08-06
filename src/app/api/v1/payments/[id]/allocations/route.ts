import { NextRequest, NextResponse } from 'next/server'
import {
  getUserFromToken,
  resolveCompanyScope,
  supabaseAdmin,
} from '@/lib/supabase-server'
import { getScopedPartyIdsForUser } from '@/lib/party-scope'
import { getInvoiceRequestAllocationsForPayment } from '@/lib/invoice-request-payments'
import { loadConfirmedInvoiceRequests } from '@/lib/invoice-requests-source'

export const dynamic = 'force-dynamic'

interface AllocationDetail {
  invoice_id: string
  invoice_number: string
  amount: number
  source: 'INVOICE' | 'INVOICE_REQUEST'
}

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const authUser = await getUserFromToken(req)
    if (!authUser) {
      return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 })
    }

    const { id } = await context.params
    const companyId = await resolveCompanyScope(req, authUser)
    const scopedPartyIds = await getScopedPartyIdsForUser(authUser, companyId)

    const { data: payment, error: paymentError } = await supabaseAdmin
      .from('payments')
      .select('id, party_id, payment_number, amount')
      .eq('id', id)
      .maybeSingle()

    if (paymentError) throw paymentError
    if (!payment || (scopedPartyIds !== null && !scopedPartyIds.includes(String(payment.party_id)))) {
      return NextResponse.json({ success: false, message: 'Payment not found or access denied' }, { status: 404 })
    }

    const details: AllocationDetail[] = []

    const { data: links, error: linksError } = await supabaseAdmin
      .from('payment_invoice_links')
      .select('invoice_id, adjusted_amount')
      .eq('payment_id', id)
    if (linksError) throw linksError

    const invoiceIds = [...new Set((links || []).map((link) => String(link.invoice_id)).filter(Boolean))]
    const invoiceNumberById = new Map<string, string>()
    if (invoiceIds.length > 0) {
      const { data: invoices, error: invoiceError } = await supabaseAdmin
        .from('invoices')
        .select('id, invoice_number')
        .in('id', invoiceIds)
      if (invoiceError) throw invoiceError
      for (const invoice of invoices || []) {
        invoiceNumberById.set(String(invoice.id), String(invoice.invoice_number || invoice.id))
      }
    }

    for (const link of links || []) {
      const invoiceId = String(link.invoice_id)
      details.push({
        invoice_id: invoiceId,
        invoice_number: invoiceNumberById.get(invoiceId) || invoiceId,
        amount: Number(link.adjusted_amount || 0),
        source: 'INVOICE',
      })
    }

    const requestAllocations = await getInvoiceRequestAllocationsForPayment(id)
    if (requestAllocations.length > 0) {
      const requests = await loadConfirmedInvoiceRequests(String(payment.party_id))
      const requestNumberById = new Map(requests.map((request) => [request.id, request.invoice_number || request.id]))
      for (const allocation of requestAllocations) {
        details.push({
          invoice_id: allocation.request_id,
          invoice_number: requestNumberById.get(allocation.request_id) || allocation.request_id,
          amount: allocation.amount,
          source: 'INVOICE_REQUEST',
        })
      }
    }

    const allocatedAmount = details.reduce((sum, allocation) => sum + allocation.amount, 0)
    const paymentAmount = Number(payment.amount || 0)

    return NextResponse.json({
      success: true,
      data: {
        payment_id: String(payment.id),
        payment_number: String(payment.payment_number || payment.id),
        payment_amount: paymentAmount,
        allocated_amount: allocatedAmount,
        unallocated_amount: Math.max(0, paymentAmount - allocatedAmount),
        allocations: details,
      },
    })
  } catch (error) {
    console.error('[GET /api/v1/payments/[id]/allocations]', error)
    return NextResponse.json(
      { success: false, message: error instanceof Error ? error.message : 'Failed to load payment allocations' },
      { status: 500 },
    )
  }
}
