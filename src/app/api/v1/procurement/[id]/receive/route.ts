import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, getUserFromToken, resolveCompanyScope } from '@/lib/supabase-server'

/**
 * POST /api/v1/procurement/[id]/receive
 * Marks goods as received and increases stock (Inventory) per item.
 * Body: { items: [{ product_id, quantity_received, warehouse_id? }] }
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const authUser = await getUserFromToken(req)
    const companyId = await resolveCompanyScope(req, authUser)
    const { id } = await params
    const body = await req.json()

    const { data: po, error: poErr } = await supabaseAdmin
      .from('procurement_orders')
      .select('*, procurement_order_items(*)')
      .eq('id', id)
      .single()

    if (poErr || !po) return NextResponse.json({ success: false, message: 'Procurement order not found' }, { status: 404 })
    if (companyId && po.company_id !== companyId) {
      return NextResponse.json({ success: false, message: 'Access denied' }, { status: 403 })
    }
    if (po.status === 'CANCELLED') {
      return NextResponse.json({ success: false, message: 'Cannot receive a cancelled order' }, { status: 400 })
    }

    const receiveItems: Array<{ product_id: string; quantity_received: number; warehouse_id?: string }> =
      body.items || po.procurement_order_items.map((i: { product_id: string; quantity_ordered: number }) => ({
        product_id: i.product_id,
        quantity_received: i.quantity_ordered,
      }))

    const warehouseId = body.warehouse_id || po.warehouse_id

    for (const item of receiveItems) {
      if (!item.product_id || !item.quantity_received) continue

      const qty = Number(item.quantity_received)
      const wid = item.warehouse_id || warehouseId
      if (!wid) continue

      // Upsert inventory: increase quantity_on_hand
      const { data: inv } = await supabaseAdmin
        .from('inventory')
        .select('id, quantity_on_hand')
        .eq('product_id', item.product_id)
        .eq('warehouse_id', wid)
        .maybeSingle()

      if (inv) {
        await supabaseAdmin.from('inventory').update({
          quantity_on_hand: inv.quantity_on_hand + qty,
          last_stock_date: new Date().toISOString(),
        }).eq('id', inv.id)
      } else {
        await supabaseAdmin.from('inventory').insert({
          product_id: item.product_id,
          warehouse_id: wid,
          quantity_on_hand: qty,
          quantity_reserved: 0,
          reorder_threshold: 10,
          last_stock_date: new Date().toISOString(),
        })
      }

      // Update quantity_received on the item
      await supabaseAdmin
        .from('procurement_order_items')
        .update({ quantity_received: qty })
        .eq('procurement_order_id', id)
        .eq('product_id', item.product_id)
    }

    // Mark procurement order as RECEIVED
    await supabaseAdmin.from('procurement_orders').update({
      status: 'RECEIVED',
      received_date: new Date().toISOString().split('T')[0],
      received_by: authUser?.app_user_id || authUser?.id || null,
    }).eq('id', id)

    return NextResponse.json({ success: true, message: 'Goods received and stock updated' })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed to receive procurement order' },
      { status: 500 }
    )
  }
}
