import { NextRequest, NextResponse } from 'next/server'
import { getUserFromToken, resolveCompanyScope } from '@/lib/supabase-server'
import { getScopedPartyIdsForUser } from '@/lib/party-scope'
import { effectivePaymentApprovalStatus, listPaymentApprovalRecords, revokePaymentApproval } from '@/lib/payment-approval-links'

export const dynamic = 'force-dynamic'

/**
 * Pending collections for the party cards. A collection is "pending" after a
 * salesman initiates it and before the party approves the acknowledgement link.
 */
export async function GET(req: NextRequest) {
  try {
    const authUser = await getUserFromToken(req)
    if (!authUser) return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 })

    const companyId = await resolveCompanyScope(req, authUser)
    const visiblePartyIds = await getScopedPartyIdsForUser(authUser, companyId)
    // Only a super admin may intentionally operate without a company/party
    // scope. Everyone else fails closed so pending financial requests can never
    // bleed across tenants when an account is incompletely configured.
    if (!companyId && visiblePartyIds === null && authUser.role !== 'SUPER_ADMIN') {
      return NextResponse.json({ success: true, data: [] })
    }
    const visibleSet = visiblePartyIds ? new Set(visiblePartyIds) : null
    const records = await listPaymentApprovalRecords(companyId)

    const data = records
      .map((record) => ({ record, status: effectivePaymentApprovalStatus(record) }))
      .filter(({ record, status }) =>
        (status === 'ACTIVE' || status === 'PROCESSING') &&
        (!visibleSet || visibleSet.has(record.party_id))
      )
      .sort((a, b) => b.record.created_at.localeCompare(a.record.created_at))
      .map(({ record, status }) => ({
        request_number: record.request_number,
        party_id: record.party_id,
        amount: Number(record.payload.amount) || 0,
        collector_name: record.collector_name || 'Staff',
        collector_id: record.collector_id,
        initiated_at: record.created_at,
        expires_at: record.expires_at,
        status,
      }))

    return NextResponse.json({ success: true, data })
  } catch (error) {
    return NextResponse.json(
      { success: false, message: error instanceof Error ? error.message : 'Failed to load pending payments' },
      { status: 500 },
    )
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const authUser = await getUserFromToken(req)
    if (!authUser) return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 })

    const requestNumber = new URL(req.url).searchParams.get('request_number')?.trim()
    if (!requestNumber) {
      return NextResponse.json({ success: false, message: 'Payment request number is required.' }, { status: 400 })
    }

    const companyId = await resolveCompanyScope(req, authUser)
    const visiblePartyIds = await getScopedPartyIdsForUser(authUser, companyId)
    if (!companyId && visiblePartyIds === null && authUser.role !== 'SUPER_ADMIN') {
      return NextResponse.json({ success: false, message: 'Payment request not found or access denied.' }, { status: 404 })
    }

    const record = (await listPaymentApprovalRecords(companyId))
      .find((item) => item.request_number === requestNumber)
    const isVisible = record && (!visiblePartyIds || visiblePartyIds.includes(record.party_id))
    if (!record || !isVisible) {
      return NextResponse.json({ success: false, message: 'Payment request not found or access denied.' }, { status: 404 })
    }

    const result = await revokePaymentApproval(record.token)
    if (!result.ok) {
      const processing = result.reason === 'PROCESSING'
      return NextResponse.json({
        success: false,
        message: processing
          ? 'This payment is already being approved. Please wait and refresh before trying again.'
          : 'This payment request is no longer active.',
      }, { status: processing ? 409 : 410 })
    }

    return NextResponse.json({
      success: true,
      message: 'Initiated payment deleted. Its shared approval and PDF links have expired.',
    })
  } catch (error) {
    return NextResponse.json(
      { success: false, message: error instanceof Error ? error.message : 'Failed to delete initiated payment.' },
      { status: 500 },
    )
  }
}
