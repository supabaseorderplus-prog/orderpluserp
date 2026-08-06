import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, getUserFromToken, resolveCompanyScope, getPartyDescendants } from '@/lib/supabase-server'

export async function GET(req: NextRequest) {
  try {
    const authUser = await getUserFromToken(req)
    const companyId = await resolveCompanyScope(req, authUser)

    const url = new URL(req.url)
    const partyId = url.searchParams.get('partyId')
    const fiscalYear = url.searchParams.get('fiscalYear')

    if (!partyId) {
      return NextResponse.json({ success: false, message: 'partyId required' }, { status: 400 })
    }

    // Verify party is verified
    const { data: partyVerifyCheck } = await supabaseAdmin
      .from('parties')
      .select('is_verified')
      .eq('id', partyId)
      .single()
    if (!partyVerifyCheck || partyVerifyCheck.is_verified !== true) {
      return NextResponse.json({ success: false, message: 'Party must be verified to export report' }, { status: 403 })
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

    // TD ledger
    let tdQuery = supabaseAdmin
      .from('td_ledger')
      .select('*')
      .eq('party_id', partyId)
      .order('transaction_date', { ascending: true })

    if (fiscalYear) tdQuery = tdQuery.eq('fiscal_year', fiscalYear)
    if (companyId) tdQuery = tdQuery.eq('company_id', companyId)

    const { data: tdData } = await tdQuery

    // CD ledger
    let cdQuery = supabaseAdmin
      .from('cd_ledger')
      .select('*')
      .eq('party_id', partyId)
      .order('transaction_date', { ascending: true })

    if (fiscalYear) cdQuery = cdQuery.eq('fiscal_year', fiscalYear)
    if (companyId) cdQuery = cdQuery.eq('company_id', companyId)

    const { data: cdData } = await cdQuery

    // Party info
    const { data: party } = await supabaseAdmin
      .from('parties')
      .select('name, party_code, party_types(name)')
      .eq('id', partyId)
      .single()

    // Generate CSV
    const tdRows = (tdData || []).map(e =>
      [e.transaction_date, e.entry_type, e.narration || '', e.td_percent, e.base_amount, e.td_amount, e.balance].join(',')
    )
    const cdRows = (cdData || []).map(e =>
      [e.transaction_date, e.entry_type, e.cd_slab, e.narration || '', e.cd_percent, e.invoice_value, e.cd_amount, e.balance].join(',')
    )

    const csv = [
      `TD/CD Report - ${party?.name || partyId} (${party?.party_code || ''})`,
      `Fiscal Year: ${fiscalYear || 'All'}`,
      '',
      'TRADE DISCOUNT LEDGER',
      'Date,Type,Narration,TD%,Base Amount,TD Amount,Balance',
      ...tdRows,
      '',
      `TD Total Earned: ${(tdData || []).filter(e => e.entry_type === 'CREDIT').reduce((s, e) => s + Number(e.td_amount), 0)}`,
      '',
      'CASH DISCOUNT LEDGER',
      'Date,Type,Slab,Narration,CD%,Invoice Value,CD Amount,Balance',
      ...cdRows,
      '',
      `CD Total Earned: ${(cdData || []).filter(e => e.entry_type === 'CREDIT').reduce((s, e) => s + Number(e.cd_amount), 0)}`,
    ].join('\n')

    return new NextResponse(csv, {
      headers: {
        'Content-Type': 'text/csv',
        'Content-Disposition': `attachment; filename="td-cd-report-${party?.party_code || partyId}.csv"`,
      },
    })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Export failed' },
      { status: 500 }
    )
  }
}
