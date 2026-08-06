import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, getUserFromToken, resolveCompanyScope, getPartyDescendants } from '@/lib/supabase-server'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { orders } = body

    if (!orders || !Array.isArray(orders) || orders.length === 0) {
      return NextResponse.json({ success: false, message: 'orders array required' }, { status: 400 })
    }

    const authUser = await getUserFromToken(req)
    const companyId = await resolveCompanyScope(req, authUser)

    const results = []

    for (const order of orders) {
      // Verify party belongs to company
      if (companyId && order.buyer_id) {
        const tree = await getPartyDescendants(companyId)
        const treeIds = tree && tree.length > 0 ? tree.map((r: { id: string }) => r.id) : []
        if (!treeIds.includes(companyId)) treeIds.push(companyId)

        if (!treeIds.includes(order.buyer_id)) {
          results.push({ offline_id: order.offline_id, error: 'Party not found or access denied' })
          continue
        }
      }

      const seq = Date.now().toString(36).toUpperCase()
      const orderNumber = `ORD/WB/${seq}/${Math.random().toString(36).substring(2, 5).toUpperCase()}`

      const { data: newOrder, error: orderErr } = await supabaseAdmin
        .from('orders')
        .insert({
          order_number: orderNumber,
          order_type: order.order_type || 'STANDARD',
          buyer_id: order.buyer_id,
          salesman_id: order.salesman_id,
          subtotal: order.subtotal || 0,
          grand_total: order.grand_total || 0,
          status: 'PENDING',
          payment_status: 'UNPAID',
          notes: order.notes,
          delivery_date: order.delivery_date || null,
        })
        .select()
        .single()

      if (orderErr) {
        results.push({ offline_id: order.offline_id, error: orderErr.message })
        continue
      }

      // Insert items
      if (order.items && Array.isArray(order.items)) {
        const items = order.items.map((item: Record<string, unknown>) => ({
          order_id: newOrder.id,
          product_id: item.product_id,
          quantity: item.quantity,
          unit_price: item.unit_price,
          line_total: Number(item.quantity) * Number(item.unit_price),
        }))
        await supabaseAdmin.from('order_items').insert(items)
      }

      results.push({ offline_id: order.offline_id, order_id: newOrder.id, order_number: orderNumber })
    }

    return NextResponse.json({ success: true, data: results })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Sync failed' },
      { status: 500 }
    )
  }
}
