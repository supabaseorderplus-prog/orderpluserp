import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, getUserFromToken, resolveCompanyScope, getPartyDescendants } from '@/lib/supabase-server'

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url)
    const partyId = url.searchParams.get('partyId')
    const page = parseInt(url.searchParams.get('page') || '1')
    const limit = parseInt(url.searchParams.get('limit') || '20')
    const offset = (page - 1) * limit

    const authUser = await getUserFromToken(req)
    const companyId = await resolveCompanyScope(req, authUser)

    let query = supabaseAdmin
      .from('expense_allocations')
      .select('*, parties(name, party_code), expense_heads(name, code)', { count: 'exact' })
      .eq('status', 'ACTIVE')
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1)

    if (partyId) query = query.eq('party_id', partyId)
    if (companyId) query = query.eq('company_id', companyId)

    const { data, count, error } = await query
    if (error) throw error

    return NextResponse.json({
      success: true,
      data: data || [],
      pagination: { page, limit, total: count || 0, pages: Math.ceil((count || 0) / limit) },
    })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed to fetch expenses' },
      { status: 500 }
    )
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()

    const authUser = await getUserFromToken(req)
    const companyId = await resolveCompanyScope(req, authUser)

    if (!body.party_id || !body.expense_head_id || !body.amount) {
      return NextResponse.json(
        { success: false, message: 'party_id, expense_head_id, and amount required' },
        { status: 400 }
      )
    }

    // Verify party belongs to company
    if (companyId && body.party_id) {
      const tree = await getPartyDescendants(companyId)
      const treeIds = tree && tree.length > 0 ? tree.map((r: { id: string }) => r.id) : []
      if (!treeIds.includes(companyId)) treeIds.push(companyId)

      if (!treeIds.includes(body.party_id)) {
        return NextResponse.json({ success: false, message: 'Party not found or access denied' }, { status: 403 })
      }
    }

    const insertData: Record<string, unknown> = { ...body }
    if (companyId) {
      insertData.company_id = companyId
    }

    const { data, error } = await supabaseAdmin
      .from('expense_allocations')
      .insert(insertData)
      .select('*, parties(name), expense_heads(name)')
      .single()

    if (error) throw error

    return NextResponse.json({ success: true, data }, { status: 201 })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed to allocate expense' },
      { status: 500 }
    )
  }
}
