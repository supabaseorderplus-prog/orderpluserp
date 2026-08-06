import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, getUserFromToken, resolveCompanyScope, getPartyDescendants } from '@/lib/supabase-server'

type SupabaseCompatError = { code?: string; message?: string } | null | undefined
const isSchemaCompatError = (err: SupabaseCompatError) =>
  !!err && (
    err.code === 'PGRST200' ||
    err.code === 'PGRST204' ||
    err.code === 'PGRST205' ||
    err.code === '42703' ||
    err.code === '42P01' ||
    (err.message || '').includes('schema cache') ||
    (err.message || '').includes("Could not find the table 'public.")
  )

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url)
    const limit = parseInt(url.searchParams.get('limit') || '1000')
    const approvedBy = url.searchParams.get('approved_by') || ''

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

    let companyPartyIds: string[] | null = null
    if (companyId) {
      try {
        const tree = await getPartyDescendants(companyId)
        const treeIds = tree && tree.length > 0 ? tree.map((r: { id: string }) => r.id) : []
        if (!treeIds.includes(companyId)) treeIds.push(companyId)
        companyPartyIds = treeIds
      } catch {
        companyPartyIds = [companyId]
      }
    }

    let query = supabaseAdmin
      .from('orders')
      .select(`
        id,
        order_number,
        created_at,
        grand_total,
        status,
        notes,
        approved_by,
        created_by,
        buyer:parties!orders_buyer_id_fkey(id, name, party_code, party_types(name)),
        order_items(*, products(name, sku, unit_of_measure, technical_specs))
      `)
      .order('created_at', { ascending: false })
      .limit(limit)

    if (companyId && companyPartyIds !== null && companyPartyIds.length > 0) {
      query = query.in('buyer_id', companyPartyIds)
    }

    if (approvedBy) {
      query = query.eq('approved_by', approvedBy)
    }

    let { data, error } = await query

    if (error && isSchemaCompatError(error)) {
      let fallbackQuery = supabaseAdmin
        .from('orders')
        .select(`
          id,
          order_number,
          created_at,
          grand_total,
          status,
          notes,
          approved_by,
          created_by,
          buyer:parties!orders_buyer_id_fkey(id, name, party_code, party_types(name)),
          order_items(*, products(name, sku, unit_of_measure, technical_specs))
        `)
        .order('created_at', { ascending: false })
        .limit(limit)

      if (companyId && companyPartyIds !== null && companyPartyIds.length > 0) {
        fallbackQuery = fallbackQuery.in('billing_party_id', companyPartyIds)
      }
      if (approvedBy) fallbackQuery = fallbackQuery.eq('approved_by', approvedBy)

      const fallback = await fallbackQuery
      data = fallback.data
      error = fallback.error
    }
    
    if (error && isSchemaCompatError(error)) {
      return NextResponse.json({ success: true, data: [] })
    }
    if (error) throw error

    return NextResponse.json({
      success: true,
      data: data || [],
    })
  } catch (err) {
    console.error('Error fetching approved orders:', err)
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed to fetch approved orders' },
      { status: 500 }
    )
  }
}
