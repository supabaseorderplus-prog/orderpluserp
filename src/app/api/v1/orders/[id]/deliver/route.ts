import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, getUserFromToken, resolveCompanyScope, getPartyDescendants } from '@/lib/supabase-server'

// When an order is delivered, promote any delivery lot it belongs to to
// DELIVERED once all of that lot's orders are delivered. Best-effort: any
// failure (e.g. delivery_lots tables not provisioned) is swallowed so the
// order delivery itself is never blocked.
async function syncLotStatusAfterDelivery(orderId: string): Promise<void> {
  try {
    // Find every lot this order belongs to.
    const { data: links } = await supabaseAdmin
      .from('delivery_lot_orders')
      .select('lot_id')
      .eq('order_id', orderId)

    const lotIds = Array.from(new Set((links || []).map((l) => l.lot_id as string).filter(Boolean)))
    if (lotIds.length === 0) return

    for (const lotId of lotIds) {
      // All order ids in this lot.
      const { data: lotOrders } = await supabaseAdmin
        .from('delivery_lot_orders')
        .select('order_id')
        .eq('lot_id', lotId)

      const orderIds = (lotOrders || []).map((o) => o.order_id as string).filter(Boolean)
      if (orderIds.length === 0) continue

      // Statuses of every order in the lot.
      const { data: orders } = await supabaseAdmin
        .from('orders')
        .select('status')
        .in('id', orderIds)

      const allDelivered =
        (orders || []).length === orderIds.length &&
        (orders || []).every((o) => o.status === 'DELIVERED')

      if (allDelivered) {
        await supabaseAdmin
          .from('delivery_lots')
          .update({ status: 'DELIVERED' })
          .eq('id', lotId)
      }
    }
  } catch {
    // Non-fatal: lot tables may not exist; order delivery already succeeded.
  }
}

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
        .select('id, status, company_id, seller_id, buyer_id, billing_party_id, grand_total, order_number')
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

      // Validate status transition
      if (order.status !== 'DISPATCHED') {
        return NextResponse.json(
          { success: false, message: `Cannot mark delivered with status "${order.status}". Order must be DISPATCHED.` },
          { status: 400 }
        )
      }

      // Update status to DELIVERED
      const { data: updated, error: updateErr } = await supabaseAdmin
        .from('orders')
        .update({ status: 'DELIVERED' })
        .eq('id', id)
        .select()
        .single()

    if (updateErr) throw updateErr

    // Sync delivery lot status: when every order in a lot is DELIVERED,
    // mark the lot itself DELIVERED so it no longer shows as DISPATCHED.
    // Non-fatal — delivery succeeds even if the lot tables aren't provisioned.
    await syncLotStatusAfterDelivery(id)

    return NextResponse.json({ success: true, data: updated, message: 'Order delivered' })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Delivery failed' },
      { status: 500 }
    )
  }
}
