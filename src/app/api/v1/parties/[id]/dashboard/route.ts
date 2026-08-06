import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, getUserFromToken, resolveCompanyScope, getPartyDescendants } from '@/lib/supabase-server'

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const url = new URL(req.url)
    const period = url.searchParams.get('period') || 'MTD'

    const authUser = await getUserFromToken(req)
    const companyId = await resolveCompanyScope(req, authUser)

    // Get party info
    const { data: party } = await supabaseAdmin
      .from('parties')
      .select('*, party_types(name)')
      .eq('id', id)
      .single()

    if (!party) {
      return NextResponse.json({ success: false, message: 'Party not found' }, { status: 404 })
    }

    // Verify company access
    if (companyId && party.id !== companyId) {
      const tree = await getPartyDescendants(companyId)
      const treeIds = tree.map((r) => r.id)
      if (!treeIds.includes(companyId)) treeIds.push(companyId)

      if (!treeIds.includes(id)) {
        return NextResponse.json({ success: false, message: 'Party not found or access denied' }, { status: 403 })
      }
    }

    const now = new Date()
    const fiscalYearStart = now.getMonth() >= 3
      ? new Date(now.getFullYear(), 3, 1)
      : new Date(now.getFullYear() - 1, 3, 1)
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)

    const fromDate = period === 'YTD' ? fiscalYearStart : monthStart
    const fromDateStr = fromDate.toISOString().split('T')[0]

    // Run all independent queries in parallel
    const [
      billingRes,
      outstandingInvRes,
      tdEntriesRes,
      tdBalRes,
      cdEntriesRes,
      secBalRes,
      rankingRes,
      monthlyBillingRes,
      schemeProgressRes,
      totalCnfsRes,
    ] = await Promise.all([
      supabaseAdmin.from('invoices').select('grand_total, taxable_amount, invoice_date')
        .eq('billing_party_id', id).gte('invoice_date', fromDateStr).eq('is_cancelled', false).eq('status', 'ACTIVE'),
      supabaseAdmin.from('invoices').select('amount_outstanding, aging_bucket')
        .eq('billing_party_id', id).in('payment_status', ['UNPAID', 'PARTIAL']).eq('is_cancelled', false),
      supabaseAdmin.from('td_ledger').select('td_amount, entry_type, transaction_date')
        .eq('party_id', id).gte('transaction_date', fromDateStr),
      supabaseAdmin.from('td_ledger').select('balance')
        .eq('party_id', id).order('created_at', { ascending: false }).limit(1),
      supabaseAdmin.from('cd_ledger').select('cd_amount, entry_type, transaction_date')
        .eq('party_id', id).gte('transaction_date', fromDateStr),
      supabaseAdmin.from('security_ledger').select('balance')
        .eq('party_id', id).order('created_at', { ascending: false }).limit(1),
      supabaseAdmin.from('party_rankings').select('rank_position, total_weighted_score, rank_change')
        .eq('party_id', id).order('calculated_at', { ascending: false }).limit(1),
      supabaseAdmin.from('invoices').select('grand_total, invoice_date')
        .eq('billing_party_id', id)
        .gte('invoice_date', new Date(now.getFullYear() - 1, now.getMonth(), 1).toISOString().split('T')[0])
        .eq('is_cancelled', false).eq('status', 'ACTIVE'),
      supabaseAdmin.from('scheme_progress')
        .select('*, schemes(name, scheme_code, scheme_type, start_date, end_date, target_value, reward_type, reward_value)')
        .eq('party_id', id).eq('status', 'ACTIVE'),
      supabaseAdmin.from('parties').select('id', { count: 'exact', head: true })
        .eq('party_type_id', party.party_type_id).eq('status', 'ACTIVE'),
    ])

    const totalBilling = billingRes.data?.reduce((s, i) => s + Number(i.grand_total), 0) || 0

    const outstandingTotal = outstandingInvRes.data?.reduce((s, i) => s + Number(i.amount_outstanding), 0) || 0
    const agingBreakdown = { CURRENT: 0, BUCKET_1: 0, BUCKET_2: 0, BUCKET_3: 0, BUCKET_4: 0 }
    outstandingInvRes.data?.forEach(inv => {
      const b = inv.aging_bucket as keyof typeof agingBreakdown
      if (b in agingBreakdown) agingBreakdown[b] += Number(inv.amount_outstanding)
    })

    const tdEarned = tdEntriesRes.data?.filter(e => e.entry_type === 'CREDIT')
      .reduce((s, e) => s + Number(e.td_amount), 0) || 0

    const cdEarned = cdEntriesRes.data?.filter(e => e.entry_type === 'CREDIT')
      .reduce((s, e) => s + Number(e.cd_amount), 0) || 0

    const monthlyTrend: Record<string, number> = {}
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
      monthlyTrend[key] = 0
    }
    monthlyBillingRes.data?.forEach(inv => {
      const d = new Date(inv.invoice_date)
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
      if (key in monthlyTrend) monthlyTrend[key] += Number(inv.grand_total)
    })

    return NextResponse.json({
      success: true,
      data: {
        party,
        kpi: {
          billing: totalBilling,
          outstanding: outstandingTotal,
          tdEarned,
          tdBalance: tdBalRes.data?.[0]?.balance || 0,
          cdEarned,
          securityBalance: secBalRes.data?.[0]?.balance || 0,
          rank: rankingRes.data?.[0]?.rank_position || null,
          rankChange: rankingRes.data?.[0]?.rank_change || 0,
          totalParties: totalCnfsRes.count || 0,
        },
        agingBreakdown,
        monthlyTrend: Object.entries(monthlyTrend).map(([month, value]) => ({ month, value })),
        schemes: schemeProgressRes.data || [],
      },
    })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed to fetch dashboard' },
      { status: 500 }
    )
  }
}
