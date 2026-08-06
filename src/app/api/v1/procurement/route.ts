import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, getUserFromToken, resolveCompanyScope } from '@/lib/supabase-server'

export async function GET(req: NextRequest) {
  try {
    const authUser = await getUserFromToken(req)
    const companyId = await resolveCompanyScope(req, authUser)

    const url = new URL(req.url)
    const status = url.searchParams.get('status')
    const from = url.searchParams.get('from')
    const to = url.searchParams.get('to')
    const page = parseInt(url.searchParams.get('page') || '1')
    const limit = parseInt(url.searchParams.get('limit') || '20')
    const offset = (page - 1) * limit

    let query = supabaseAdmin
      .from('procurement_orders')
      .select('*, procurement_order_items(*)', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1)

    if (companyId) query = query.eq('company_id', companyId)
    if (status) query = query.eq('status', status)
    if (from) query = query.gte('created_at', from)
    if (to) query = query.lte('created_at', to)

    const { data, count, error } = await query
    if (error) throw error

    return NextResponse.json({
      success: true,
      data: data || [],
      pagination: { page, limit, total: count || 0, pages: Math.ceil((count || 0) / limit) },
    })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed to fetch procurement orders' },
      { status: 500 }
    )
  }
}

export async function POST(req: NextRequest) {
  try {
    const authUser = await getUserFromToken(req)
    const companyId = await resolveCompanyScope(req, authUser)
    const body = await req.json()

    const { supplier_name, supplier_id, warehouse_id, expected_date, notes, items } = body

    if (!items || !Array.isArray(items) || items.length === 0) {
      return NextResponse.json({ success: false, message: 'At least one item is required' }, { status: 400 })
    }

    // Generate procurement number
    const seq = Date.now().toString(36).toUpperCase()
    const procurement_number = `PO-${seq}`

    const totalAmount = items.reduce((s: number, i: { quantity_ordered: number; unit_cost: number }) =>
      s + (Number(i.quantity_ordered) * Number(i.unit_cost)), 0)

    const { data: po, error: poErr } = await supabaseAdmin
      .from('procurement_orders')
      .insert({
        company_id: companyId || null,
        procurement_number,
        supplier_name: supplier_name || null,
        supplier_id: supplier_id || null,
        warehouse_id: warehouse_id || null,
        expected_date: expected_date || null,
        notes: notes || null,
        total_amount: totalAmount,
        status: 'PENDING',
        created_by: authUser?.app_user_id || authUser?.id || null,
      })
      .select()
      .single()

    if (poErr) throw poErr

    const itemRows = items.map((i: { product_id: string; product_name?: string; sku?: string; quantity_ordered: number; unit_cost: number; unit_of_measure?: string; notes?: string }) => ({
      procurement_order_id: po.id,
      product_id: i.product_id,
      product_name: i.product_name || null,
      sku: i.sku || null,
      quantity_ordered: Number(i.quantity_ordered),
      quantity_received: 0,
      unit_cost: Number(i.unit_cost),
      line_total: Number(i.quantity_ordered) * Number(i.unit_cost),
      unit_of_measure: i.unit_of_measure || 'PIECE',
      notes: i.notes || null,
    }))

    const { error: itemsErr } = await supabaseAdmin.from('procurement_order_items').insert(itemRows)
    if (itemsErr) throw itemsErr

    return NextResponse.json({ success: true, data: po }, { status: 201 })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed to create procurement order' },
      { status: 500 }
    )
  }
}
