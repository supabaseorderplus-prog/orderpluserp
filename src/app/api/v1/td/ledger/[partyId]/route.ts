import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, getUserFromToken, resolveCompanyScope, getPartyDescendants } from '@/lib/supabase-server'

export async function GET(req: NextRequest, { params }: { params: Promise<{ partyId: string }> }) {
  try {
    const { partyId } = await params
    const url = new URL(req.url)
    const from = url.searchParams.get('from')
    const to = url.searchParams.get('to')
    const fiscalYear = url.searchParams.get('fiscalYear')

    const authUser = await getUserFromToken(req)
    const companyId = await resolveCompanyScope(req, authUser)

    // Verify party is verified before allowing ledger access
    const { data: partyCheck, error: partyError } = await supabaseAdmin
      .from('parties')
      .select('is_verified')
      .eq('id', partyId)
      .single()
    if (partyError) throw partyError
    if (!partyCheck || partyCheck.is_verified !== true) {
      return NextResponse.json({ success: false, message: 'Party must be verified to access ledger' }, { status: 403 })
    }

    // Verify party belongs to company (using party tree, not company_id column)
    if (companyId) {
      const tree = await getPartyDescendants(companyId)
      const treeIds = tree && tree.length > 0 ? tree.map((r: { id: string }) => r.id) : []
      if (!treeIds.includes(companyId)) treeIds.push(companyId)

      if (!treeIds.includes(partyId)) {
        return NextResponse.json({ success: false, message: 'Party not found or access denied' }, { status: 403 })
      }
    }

      let query = supabaseAdmin
        .from('td_ledger')
        .select('*')
        .eq('party_id', partyId)
        .order('created_at', { ascending: true })

    if (from) query = query.gte('created_at', from)
    if (to) query = query.lte('created_at', to)
    if (fiscalYear) query = query.eq('fiscal_year', fiscalYear)

    const { data, error } = await query
    if (error) throw error

    // Get balance summary
    const totalCredit = (data || []).filter(e => e.entry_type === 'CREDIT').reduce((s, e) => s + Number(e.td_amount), 0)
    const totalDebit = (data || []).filter(e => e.entry_type !== 'CREDIT').reduce((s, e) => s + Number(e.td_amount), 0)
    const currentBalance = totalCredit - totalDebit

    return NextResponse.json({
      success: true,
      data: {
        entries: data || [],
        summary: { totalCredit, totalDebit, currentBalance },
      },
    })
  } catch (err) {
    console.error('TD Ledger API Error:', err)
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed to fetch TD ledger' },
      { status: 500 }
    )
  }
}
