import { NextRequest, NextResponse } from 'next/server'
import { resetApprovalsForOrder } from '@/lib/order-approval-links'
import { getPartyDescendants, getUserFromToken, resolveCompanyScope, supabaseAdmin } from '@/lib/supabase-server'

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const authUser = await getUserFromToken(req)
    if (!authUser) {
      return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 })
    }

    const normalizedRole = String(authUser.role || '').trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_')
    if (normalizedRole === 'SALESMAN') {
      return NextResponse.json(
        { success: false, message: 'Salesmen are not allowed to revert order approvals' },
        { status: 403 },
      )
    }

    let companyId = await resolveCompanyScope(req, authUser)
    if (!companyId && authUser.role !== 'SUPER_ADMIN') companyId = authUser.party_id || null
    if (!companyId && authUser.role !== 'SUPER_ADMIN') {
      return NextResponse.json({ success: false, message: 'Company scope is required' }, { status: 403 })
    }

    const { id } = await params
    const { data: order, error } = await supabaseAdmin
      .from('orders')
      .select('*')
      .eq('id', id)
      .maybeSingle()

    if (error || !order) {
      return NextResponse.json({ success: false, message: 'Order not found' }, { status: 404 })
    }

    const partyId = (order.buyer_id as string) || (order.billing_party_id as string) || null
    if (companyId) {
      const directMatch =
        (order.company_id && order.company_id === companyId) ||
        (order.seller_id && order.seller_id === companyId)
      if (!directMatch) {
        if (!partyId) {
          return NextResponse.json({ success: false, message: 'Order not found or access denied' }, { status: 403 })
        }
        const tree = await getPartyDescendants(companyId)
        const treeIds = tree.length > 0 ? tree.map((row) => row.id) : []
        if (!treeIds.includes(companyId)) treeIds.push(companyId)
        if (!treeIds.includes(partyId)) {
          return NextResponse.json({ success: false, message: 'Order not found or access denied' }, { status: 403 })
        }
      }
    }

    const currentStatus = String(order.status || order.order_status || 'PENDING').toUpperCase()
    if (currentStatus !== 'APPROVED') {
      return NextResponse.json(
        {
          success: false,
          message: `Only an APPROVED order can be returned to Pending. This order is ${currentStatus}.`,
        },
        { status: 409 },
      )
    }

    // Compare against APPROVED in the update itself so a concurrent dispatch or
    // invoice action cannot be accidentally overwritten by this reversal.
    const { data: updated, error: updateError } = await supabaseAdmin
      .from('orders')
      .update({ status: 'PENDING', approved_by: null, approval_time: null })
      .eq('id', id)
      .eq('status', 'APPROVED')
      .select()
      .maybeSingle()

    if (updateError) throw updateError
    if (!updated) {
      return NextResponse.json(
        { success: false, message: 'The order status changed before approval could be reverted. Refresh and try again.' },
        { status: 409 },
      )
    }

    try {
      await resetApprovalsForOrder(id, 'ORDER')
    } catch (resetError) {
      // Keep the two approval layers consistent if confirmation cleanup fails.
      await supabaseAdmin
        .from('orders')
        .update({
          status: 'APPROVED',
          approved_by: order.approved_by || null,
          approval_time: order.approval_time || null,
        })
        .eq('id', id)
        .eq('status', 'PENDING')
      throw resetError
    }

    return NextResponse.json({
      success: true,
      data: updated,
      message: 'Approval reverted. The order is Pending and must be approved again.',
    })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed to revert approval' },
      { status: 500 },
    )
  }
}
