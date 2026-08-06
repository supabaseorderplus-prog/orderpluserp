import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, getUserFromToken, resolveCompanyScope, getPartyDescendants } from '@/lib/supabase-server'

export async function GET(req: NextRequest, { params }: { params: Promise<{ partyId: string }> }) {
  try {
    const authUser = await getUserFromToken(req)
    const companyId = await resolveCompanyScope(req, authUser)

    const { partyId } = await params

    // Verify party is verified before allowing ledger access
    const { data: partyVerify } = await supabaseAdmin
      .from('parties')
      .select('is_verified')
      .eq('id', partyId)
      .single()
    if (!partyVerify || partyVerify.is_verified !== true) {
      return NextResponse.json({ success: false, message: 'Party must be verified to access security ledger' }, { status: 403 })
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
        .from('security_ledger')
        .select('*')
        .eq('party_id', partyId)
        .order('created_at', { ascending: false })

    const { data, error } = await query
    if (error) throw error

    const totalDeposits = (data || []).filter(e => ['DEPOSIT', 'BONUS_DEPOSIT', 'INTEREST_CREDIT'].includes(e.entry_type)).reduce((s, e) => s + Number(e.amount), 0)
    const totalWithdrawals = (data || []).filter(e => ['REFUND', 'ADJUSTMENT'].includes(e.entry_type)).reduce((s, e) => s + Number(e.amount), 0)
    const currentBalance = totalDeposits - totalWithdrawals

    return NextResponse.json({
      success: true,
      data: {
        entries: data || [],
        summary: { totalDeposits, totalWithdrawals, currentBalance },
      },
    })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed to fetch security ledger' },
      { status: 500 }
    )
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ partyId: string }> }) {
  try {
    const authUser = await getUserFromToken(req)
    const companyId = await resolveCompanyScope(req, authUser)

    const { partyId } = await params
    const body = await req.json()

    // Verify party belongs to company
    if (companyId) {
      const tree = await getPartyDescendants(companyId)
      const treeIds = tree && tree.length > 0 ? tree.map((r: { id: string }) => r.id) : []
      if (!treeIds.includes(companyId)) treeIds.push(companyId)

      if (!treeIds.includes(partyId)) {
        return NextResponse.json({ success: false, message: 'Party not found or access denied' }, { status: 403 })
      }
    }

      // Get current balance
      const { data: lastEntry } = await supabaseAdmin
        .from('security_ledger')
        .select('balance')
        .eq('party_id', partyId)
        .order('created_at', { ascending: false })
        .limit(1)
        .single()

    const prevBalance = Number(lastEntry?.balance || 0)
    const isCredit = ['DEPOSIT', 'BONUS_DEPOSIT', 'INTEREST_CREDIT'].includes(body.entry_type)
    const newBalance = isCredit ? prevBalance + Number(body.amount) : prevBalance - Number(body.amount)

      const insertData: Record<string, unknown> = {
        party_id: partyId,
        entry_type: body.entry_type,
        amount: body.amount,
        narration: body.narration,
        reference_no: body.reference_no,
        payment_mode: body.payment_mode,
        balance: newBalance,
        fiscal_year: body.fiscal_year,
      }

    const { data, error } = await supabaseAdmin
      .from('security_ledger')
      .insert(insertData)
      .select()
      .single()

    if (error) throw error
    return NextResponse.json({ success: true, data }, { status: 201 })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed to add security entry' },
      { status: 500 }
    )
  }
}
