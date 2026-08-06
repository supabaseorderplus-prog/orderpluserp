import { NextResponse } from 'next/server'
import { getPaymentApprovalByToken } from '@/lib/payment-approval-links'

export const dynamic = 'force-dynamic'

export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params
    const found = await getPaymentApprovalByToken(token)
    if (!found) {
      return NextResponse.json({ success: false, status: 'NOT_FOUND', message: 'This payment approval link is invalid.' }, { status: 404 })
    }
    if (found.effective !== 'ACTIVE') {
      const message = found.effective === 'APPROVED'
        ? 'This payment was already approved and the secure link has expired.'
        : found.effective === 'PROCESSING'
          ? 'This payment is currently being processed.'
          : 'This payment approval link has expired.'
      return NextResponse.json({ success: false, status: found.effective, message }, { status: found.effective === 'PROCESSING' ? 409 : 410 })
    }
    const { record } = found
    const { payload } = record
    return NextResponse.json({
      success: true,
      data: {
        request_number: record.request_number,
        company_name: record.company_name,
        party_name: record.party_name,
        party_code: record.party_code,
        collector_name: record.collector_name,
        invoices: record.invoices,
        schemes: record.schemes,
        balance_before: record.balance_before,
        balance_after: record.balance_after,
        unallocated_amount: record.unallocated_amount,
        created_at: record.created_at,
        expires_at: record.expires_at,
        status: found.effective,
        payment: {
          amount: payload.amount,
          payment_mode: payload.payment_mode,
          reference_number: payload.reference_number || null,
          bank_name: payload.bank_name || null,
          is_advance: Boolean(payload.is_advance),
          notes: payload.notes || null,
          proof_url: payload.proof_url || null,
        },
      },
    })
  } catch (error) {
    return NextResponse.json({ success: false, message: error instanceof Error ? error.message : 'Failed to load payment approval.' }, { status: 500 })
  }
}
