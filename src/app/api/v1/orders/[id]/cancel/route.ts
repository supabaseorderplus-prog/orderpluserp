import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, getUserFromToken, resolveCompanyScope, getPartyDescendants } from '@/lib/supabase-server'

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const authUser = await getUserFromToken(req)
    if (!authUser) {
      return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 })
    }

    let companyId = await resolveCompanyScope(req, authUser)
    if (!companyId && authUser.role !== 'SUPER_ADMIN') {
      companyId = authUser.party_id || null
    }
    if (!companyId && authUser.role !== 'SUPER_ADMIN') {
      return NextResponse.json({ success: false, message: 'Company scope is required' }, { status: 403 })
    }

    const { id } = await params

    // Get order
    const { data: order, error } = await supabaseAdmin
      .from('orders')
      .select('id, order_status, company_id, seller_id, buyer_id, billing_party_id')
      .eq('id', id)
      .single()

    if (error || !order) {
      return NextResponse.json({ success: false, message: 'Order not found' }, { status: 404 })
    }

    if (companyId) {
      const partyId = order.buyer_id || order.billing_party_id
      const directMatch = (order.company_id && order.company_id === companyId) || (order.seller_id && order.seller_id === companyId)
      if (!directMatch) {
        if (!partyId) {
          return NextResponse.json({ success: false, message: 'Order not found or access denied' }, { status: 403 })
        }
        const tree = await getPartyDescendants(companyId)
        const treeIds = tree && tree.length > 0 ? tree.map((r: { id: string }) => r.id) : []
        if (!treeIds.includes(companyId)) treeIds.push(companyId)
        if (!treeIds.includes(partyId)) {
          return NextResponse.json({ success: false, message: 'Order not found or access denied' }, { status: 403 })
        }
      }
    }

    // Validate status transition — can cancel PENDING or APPROVED
    if (!['PENDING', 'APPROVED'].includes(order.order_status || '')) {
      return NextResponse.json(
        { success: false, message: `Cannot cancel order with status "${order.order_status}". Only PENDING or APPROVED orders can be cancelled.` },
        { status: 400 }
      )
    }

    // Update status to CANCELLED
    const { data: updated, error: updateErr } = await supabaseAdmin
      .from('orders')
      .update({
        order_status: 'CANCELLED',
        notes: 'Order cancelled',
      })
      .eq('id', id)
      .select()
      .single()

    if (updateErr) throw updateErr

    return NextResponse.json({ success: true, data: updated, message: 'Order cancelled' })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Cancellation failed' },
      { status: 500 }
    )
  }
}
