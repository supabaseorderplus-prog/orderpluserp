import { NextRequest, NextResponse } from 'next/server'
import { getApprovalByToken, confirmApproval } from '@/lib/order-approval-links'
import { loadOrderApprovalView } from '@/lib/order-approval-view'
import { confirmInvoiceRequestFromPublicLink } from '@/lib/public-invoice-confirmation'

// PUBLIC — no auth. The URL token IS the bearer credential (256-bit random,
// single-use). Only ever exposes the one order tied to the token.

export async function GET(_req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params
    const found = await getApprovalByToken(token)
    if (!found) {
      return NextResponse.json({ success: false, status: 'NOT_FOUND', message: 'This link is invalid.' }, { status: 404 })
    }
    const { record, effective } = found
    if (effective !== 'ACTIVE') {
      // Repair an approval that was committed before invoice confirmation (for
      // example, an old deployment or a transient failure between the two
      // writes). This also makes reopening an already-used WhatsApp link safely
      // finish generation instead of leaving the dashboard on PENDING forever.
      if (effective === 'APPROVED' && record.purpose === 'INVOICE') {
        const invoice = await confirmInvoiceRequestFromPublicLink({
          requestId: record.invoice_request_id,
          orderId: record.order_id,
          approverName: record.approved_name || record.party_name,
        })
        return NextResponse.json({
          success: true,
          data: {
            status: 'APPROVED',
            invoice_generated: true,
            invoice_number: invoice.invoiceNumber,
            party_confirmed: true,
            party_confirmed_name: record.approved_name,
            party_confirmed_at: record.approved_at,
          },
        })
      }
      const message =
        effective === 'APPROVED'
          ? 'This order was already confirmed and the secure link is now closed.'
          : effective === 'EXPIRED'
            ? 'This link has expired.'
            : 'This link is no longer valid.'
      return NextResponse.json({ success: false, status: effective, message }, { status: 410 })
    }

    const { order, items } = await loadOrderApprovalView(record.order_id)
    if (!order) {
      return NextResponse.json({ success: false, status: 'NOT_FOUND', message: 'This order is no longer available.' }, { status: 404 })
    }

    return NextResponse.json({
      success: true,
      data: {
        status: effective,
        order_number: record.order_number,
        order_date: (order?.created_at as string) || record.created_at,
        company_name: record.company_name,
        party_name: record.party_name,
        party_phone: record.party_phone,
        grand_total: (order?.grand_total as number) ?? record.grand_total,
        staff_approved: true,
        party_confirmed: false,
        party_confirmed_name: null,
        party_confirmed_at: null,
        expires_at: record.expires_at,
        purpose: record.purpose || 'ORDER',
        invoice_request_id: record.invoice_request_id || null,
        items,
      },
    })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed to load order' },
      { status: 500 },
    )
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params
    let name = ''
    try {
      const body = await req.json()
      name = typeof body?.name === 'string' ? body.name : ''
    } catch {
      // empty body is fine
    }

    const before = await getApprovalByToken(token)
    if (!before) {
      return NextResponse.json({ success: false, status: 'NOT_FOUND', message: 'This link is invalid.' }, { status: 404 })
    }

    // If the approval token was committed but invoice confirmation hit a
    // transient failure, allow the same link to safely reconcile the invoice on
    // retry. The invoice operation itself is idempotent.
    if (before.effective === 'APPROVED' && before.record.purpose === 'INVOICE') {
      const invoice = await confirmInvoiceRequestFromPublicLink({
        requestId: before.record.invoice_request_id,
        orderId: before.record.order_id,
        approverName: before.record.approved_name || name || before.record.party_name,
      })
      return NextResponse.json({
        success: true,
        data: { status: 'APPROVED', party_confirmed: true, invoice_generated: true, invoice_number: invoice.invoiceNumber },
        message: 'Invoice confirmed and generated successfully.',
      })
    }

    const result = await confirmApproval(token, name)
    if (result.ok) {
      const invoice = result.record.purpose === 'INVOICE'
        ? await confirmInvoiceRequestFromPublicLink({
            requestId: result.record.invoice_request_id,
            orderId: result.record.order_id,
            approverName: result.record.approved_name || result.record.party_name,
          })
        : null
      return NextResponse.json({
        success: true,
        data: {
          status: 'APPROVED',
          party_confirmed: true,
          party_confirmed_name: result.record.approved_name,
          party_confirmed_at: result.record.approved_at,
          invoice_generated: !!invoice,
          invoice_number: invoice?.invoiceNumber || null,
        },
        message: invoice ? 'Invoice confirmed and generated successfully.' : 'Order confirmed. Thank you!',
      })
    }

    const statusMap: Record<string, { code: number; message: string }> = {
      NOT_FOUND: { code: 404, message: 'This link is invalid.' },
      APPROVED: { code: 409, message: 'This order has already been confirmed.' },
      EXPIRED: { code: 410, message: 'This link has expired.' },
      REVOKED: { code: 410, message: 'This link is no longer valid.' },
    }
    const mapped = statusMap[result.reason] || { code: 400, message: 'Unable to confirm this order.' }
    return NextResponse.json(
      { success: false, status: result.reason, message: mapped.message },
      { status: mapped.code },
    )
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed to confirm order' },
      { status: 500 },
    )
  }
}
