import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, getUserFromToken, resolveCompanyScope } from '@/lib/supabase-server'
import { BOM_INVENTORY_SCHEMA_NOT_READY_MESSAGE, ensureBomInventorySchema, isBomInventorySchemaGap } from '@/lib/bom-inventory-schema'

// Stock movements: POST to add a movement; GET to list movements for an item

export async function GET(req: NextRequest) {
  try {
    await ensureBomInventorySchema()
    const authUser = await getUserFromToken(req)
    if (!authUser) return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 })

    const companyId = await resolveCompanyScope(req, authUser)
    if (!companyId) return NextResponse.json({ success: false, message: 'Company not found' }, { status: 403 })

    const itemId = new URL(req.url).searchParams.get('item_id')

    let query = supabaseAdmin
      .from('stock_movements')
      .select('*')
      .eq('company_id', companyId)
      .order('created_at', { ascending: false })

    if (itemId) {
      query = query.eq('item_id', itemId)
    }

    const { data, error } = await query
    if (error) throw error

    return NextResponse.json({ success: true, data: data || [] })
  } catch (err) {
    console.error('[GET /api/v1/stock-movements]', err)
    return NextResponse.json(
      { success: false, message: isBomInventorySchemaGap(err) ? BOM_INVENTORY_SCHEMA_NOT_READY_MESSAGE : err instanceof Error ? err.message : 'Failed to fetch movements' },
      { status: isBomInventorySchemaGap(err) ? 503 : 500 }
    )
  }
}

export async function POST(req: NextRequest) {
  try {
    await ensureBomInventorySchema()
    const authUser = await getUserFromToken(req)
    if (!authUser) return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 })

    const companyId = await resolveCompanyScope(req, authUser)
    if (!companyId) return NextResponse.json({ success: false, message: 'Company not found' }, { status: 403 })

    const body = await req.json()
    const { item_id, type, quantity, reason, reference } = body

    if (!item_id || !type || !quantity || !reason) {
      return NextResponse.json({ success: false, message: 'item_id, type, quantity, reason required' }, { status: 400 })
    }

    if (!['in', 'out', 'adjustment'].includes(type)) {
      return NextResponse.json({ success: false, message: 'type must be in, out, or adjustment' }, { status: 400 })
    }

    // Verify item belongs to company
    const { data: item, error: itemErr } = await supabaseAdmin
      .from('raw_materials')
      .select('id, current_stock')
      .eq('id', item_id)
      .eq('company_id', companyId)
      .single()

    if (itemErr || !item) {
      return NextResponse.json({ success: false, message: 'Item not found' }, { status: 404 })
    }

    // Calculate new stock
    const qty = Math.abs(Number(quantity))
    const newStock = type === 'in'
      ? Number(item.current_stock) + qty
      : Math.max(0, Number(item.current_stock) - qty)

    // Insert movement and update stock in one sequence
    const [mvRes] = await Promise.all([
      supabaseAdmin
        .from('stock_movements')
        .insert({
          company_id: companyId,
          item_id,
          type,
          quantity: qty,
          reason,
          reference: reference || '',
        })
        .select('*')
        .single(),
      supabaseAdmin
        .from('raw_materials')
        .update({ current_stock: newStock, updated_at: new Date().toISOString() })
        .eq('id', item_id),
    ])

    if (mvRes.error) throw mvRes.error

    return NextResponse.json({ success: true, data: mvRes.data, new_stock: newStock }, { status: 201 })
  } catch (err) {
    console.error('[POST /api/v1/stock-movements]', err)
    return NextResponse.json(
      { success: false, message: isBomInventorySchemaGap(err) ? BOM_INVENTORY_SCHEMA_NOT_READY_MESSAGE : err instanceof Error ? err.message : 'Failed to record movement' },
      { status: isBomInventorySchemaGap(err) ? 503 : 500 }
    )
  }
}
