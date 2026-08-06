import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, getUserFromToken, resolveCompanyScope, getPartyDescendants } from '@/lib/supabase-server'

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ partyId: string }> }
) {
  try {
    const authUser = await getUserFromToken(req)
    const companyId = await resolveCompanyScope(req, authUser)
    const { partyId } = await params

    const url = new URL(req.url)
    const from = url.searchParams.get('from')
    const to = url.searchParams.get('to')
    const page = parseInt(url.searchParams.get('page') || '1')
    const limit = parseInt(url.searchParams.get('limit') || '50')
    const offset = (page - 1) * limit

    // Verify party access
    if (companyId) {
      const tree = await getPartyDescendants(companyId)
      const treeIds = tree && tree.length > 0 ? tree.map((r: { id: string }) => r.id) : []
      if (!treeIds.includes(companyId)) treeIds.push(companyId)
      if (!treeIds.includes(partyId)) {
        return NextResponse.json({ success: false, message: 'Party not found or access denied' }, { status: 403 })
      }
    }

    let query = supabaseAdmin
      .from('ledger_entries')
      .select('*', { count: 'exact' })
      .eq('party_id', partyId)
      .order('entry_date', { ascending: false })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1)

    if (companyId) query = query.eq('company_id', companyId)
    if (from) query = query.gte('entry_date', from)
    if (to) query = query.lte('entry_date', to)

    const { data, count, error } = await query
    if (error) throw error

    // Calculate running totals
    const entries = data || []
    const totalDebit = entries.filter(e => e.type === 'DEBIT').reduce((s, e) => s + Number(e.amount), 0)
    const totalCredit = entries.filter(e => e.type === 'CREDIT').reduce((s, e) => s + Number(e.amount), 0)
    const outstanding = totalDebit - totalCredit

    return NextResponse.json({
      success: true,
      data: entries,
      summary: { totalDebit, totalCredit, outstanding },
      pagination: { page, limit, total: count || 0, pages: Math.ceil((count || 0) / limit) },
    })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed to fetch ledger' },
      { status: 500 }
    )
  }
}
