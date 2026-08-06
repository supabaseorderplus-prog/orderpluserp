import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, getUserFromToken, resolveCompanyScope } from '@/lib/supabase-server'

export async function GET(req: NextRequest) {
  try {
    const authUser = await getUserFromToken(req)
    const companyId = await resolveCompanyScope(req, authUser)

    if (!companyId) {
      return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 })
    }

    const url = new URL(req.url)
    const limit = parseInt(url.searchParams.get('limit') || '10')

    // Get invoice IDs scoped to this company
    const { data: companyInvoices } = await supabaseAdmin
      .from('invoices')
      .select('id')
      .eq('company_id', companyId)
      .eq('status', 'ACTIVE')
      .not('is_cancelled', 'eq', true)

    const invoiceIds = (companyInvoices || []).map(i => i.id)
    if (invoiceIds.length === 0) {
      return NextResponse.json({ data: [] })
    }

    const { data, error } = await supabaseAdmin
      .from('invoice_items')
      .select('product_id, quantity, line_total, products(name)')
      .in('invoice_id', invoiceIds)
      .limit(500)

    if (error) throw error

    const productMap = new Map<string, { name: string; totalQty: number; totalRevenue: number }>()
    for (const item of data || []) {
      const key = item.product_id
      const existing = productMap.get(key)
      const name = item.products && typeof item.products === 'object' && 'name' in item.products
        ? (item.products as { name: string }).name : 'Unknown'
      if (existing) {
        existing.totalQty += Number(item.quantity)
        existing.totalRevenue += Number(item.line_total)
      } else {
        productMap.set(key, { name, totalQty: Number(item.quantity), totalRevenue: Number(item.line_total) })
      }
    }

    const sorted = Array.from(productMap.values())
      .sort((a, b) => b.totalRevenue - a.totalRevenue)
      .slice(0, limit)

    return NextResponse.json({ data: sorted })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed' },
      { status: 500 }
    )
  }
}
