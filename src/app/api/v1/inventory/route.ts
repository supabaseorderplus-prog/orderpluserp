import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, getUserFromToken, resolveCompanyScope } from '@/lib/supabase-server'

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url)
    const search = url.searchParams.get('search') || ''
    const lowStock = url.searchParams.get('lowStock') === 'true'
    const page = parseInt(url.searchParams.get('page') || '1')
    const limit = parseInt(url.searchParams.get('limit') || '20')
    const offset = (page - 1) * limit

    // CRITICAL: Get authenticated user and resolve company scope for data isolation
    const authUser = await getUserFromToken(req)
    const companyId = await resolveCompanyScope(req, authUser)

    let query = supabaseAdmin
      .from('inventory')
      .select('id, product_id, warehouse_id, quantity, min_quantity, max_quantity, products(name, sku), warehouses(name)', { count: 'exact' })
      .order('product_id')
      .range(offset, offset + limit - 1)

    // CRITICAL: Filter by company_id to ensure strict data isolation
    if (companyId) {
      query = query.eq('company_id', companyId)
    }

    if (lowStock) {
      // Use raw filter for low stock - quantity <= min_quantity
      query = query.filter('quantity', 'lte', 'min_quantity')
    }

    const { data, count, error } = await query
    if (error) throw error

    const total = count || 0
    const totalPages = Math.ceil(total / limit)

    const items = (data || []).map(i => ({
      id: i.id,
      product: i.products && typeof i.products === 'object' ? { name: (i.products as Record<string, unknown>).name as string, sku: (i.products as Record<string, unknown>).sku as string } : null,
      warehouse: i.warehouses && typeof i.warehouses === 'object' ? { name: (i.warehouses as Record<string, unknown>).name as string } : null,
      qty: Number(i.quantity || 0),
      minQty: Number(i.min_quantity || 0),
      maxQty: Number(i.max_quantity || 0),
    }))

    return NextResponse.json({ data: items, meta: { total, page, totalPages } })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed to fetch inventory' },
      { status: 500 }
    )
  }
}
