import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, getUserFromToken, resolveCompanyScope, getPartyDescendants } from '@/lib/supabase-server'

export async function GET(req: NextRequest, { params }: { params: Promise<{ partyId: string }> }) {
  try {
    const { partyId } = await params
    const url = new URL(req.url)
    const from = url.searchParams.get('from')
    const to = url.searchParams.get('to')

    const authUser = await getUserFromToken(req)
    const companyId = await resolveCompanyScope(req, authUser)

    // Verify party is verified before allowing ledger access
    const { data: partyVerify } = await supabaseAdmin
      .from('parties')
      .select('is_verified')
      .eq('id', partyId)
      .single()
    if (!partyVerify || partyVerify.is_verified !== true) {
      return NextResponse.json({ success: false, message: 'Party must be verified to access ledger' }, { status: 403 })
    }

    // Verify party belongs to company
    if (companyId) {
      const tree = await getPartyDescendants(companyId)
      const treeIds = tree && tree.length > 0 ? tree.map((r: { id: string }) => r.id) : []
      if (!treeIds.includes(companyId)) treeIds.push(companyId)

      if (!treeIds.includes(partyId)) {
        return NextResponse.json({ success: false, message: 'Party not found or access denied' }, { status: 403 })
      }
    }

      let query = supabaseAdmin
        .from('cd_ledger')
        .select('*')
        .eq('party_id', partyId)
        .order('created_at', { ascending: true })

    if (from) query = query.gte('created_at', from)
    if (to) query = query.lte('created_at', to)

    const { data, error } = await query
    if (error) throw error

    const totalCredit = (data || []).filter(e => e.entry_type === 'CREDIT').reduce((s, e) => s + Number(e.cd_amount), 0)
    const totalDebit = (data || []).filter(e => e.entry_type !== 'CREDIT').reduce((s, e) => s + Number(e.cd_amount), 0)
    const currentBalance = totalCredit - totalDebit

    return NextResponse.json({
      success: true,
      data: {
        entries: data || [],
        summary: { totalCredit, totalDebit, currentBalance },
      },
    })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed to fetch CD ledger' },
      { status: 500 }
    )
  }
}
