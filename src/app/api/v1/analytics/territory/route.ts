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
    const territoryId = url.searchParams.get('territory_id') || ''

    const now = new Date()
    const fiscalYearStart = now.getMonth() >= 3
      ? `${now.getFullYear()}-04-01`
      : `${now.getFullYear() - 1}-04-01`

    let billingQuery = supabaseAdmin
      .from('invoices')
      .select('territory_id, grand_total, territories(name, code)')
      .eq('company_id', companyId)
      .gte('invoice_date', fiscalYearStart)
      .eq('status', 'ACTIVE')
      .not('is_cancelled', 'eq', true)

    if (territoryId) billingQuery = billingQuery.eq('territory_id', territoryId)

    const { data: invoices } = await billingQuery

    const territoryMap = new Map<string, { name: string; code: string; billing: number; count: number }>()
    for (const inv of invoices || []) {
      const tid = inv.territory_id || 'unknown'
      const territory = Array.isArray(inv.territories) ? inv.territories[0] : inv.territories
      const existing = territoryMap.get(tid) || {
        name: territory?.name || 'Unknown',
        code: territory?.code || '',
        billing: 0,
        count: 0,
      }
      existing.billing += Number(inv.grand_total)
      existing.count += 1
      territoryMap.set(tid, existing)
    }

    const { data: outstandingData } = await supabaseAdmin
      .from('invoices')
      .select('territory_id, amount_outstanding')
      .eq('company_id', companyId)
      .in('payment_status', ['UNPAID', 'PARTIAL'])
      .not('is_cancelled', 'eq', true)

    const outstandingMap = new Map<string, number>()
    for (const inv of outstandingData || []) {
      const tid = inv.territory_id || 'unknown'
      outstandingMap.set(tid, (outstandingMap.get(tid) || 0) + Number(inv.amount_outstanding))
    }

    const territoryPerformance = Array.from(territoryMap.entries()).map(([id, data]) => ({
      territoryId: id, ...data, outstanding: outstandingMap.get(id) || 0,
    })).sort((a, b) => b.billing - a.billing)

    const months = []
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
      const monthStart = d.toISOString().split('T')[0]
      const nextMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0)
      const monthEnd = nextMonth.toISOString().split('T')[0]
      months.push({ label: d.toLocaleDateString('en-IN', { month: 'short', year: '2-digit' }), start: monthStart, end: monthEnd })
    }

    const monthlyData = []
    for (const m of months) {
      let q = supabaseAdmin
        .from('invoices')
        .select('grand_total')
        .eq('company_id', companyId)
        .gte('invoice_date', m.start)
        .lte('invoice_date', m.end)
        .eq('status', 'ACTIVE')
        .not('is_cancelled', 'eq', true)

      if (territoryId) q = q.eq('territory_id', territoryId)
      const { data } = await q
      const total = (data || []).reduce((s, i) => s + Number(i.grand_total), 0)
      monthlyData.push({ month: m.label, billing: total })
    }

    const { data: agingData } = await supabaseAdmin
      .from('invoices')
      .select('aging_bucket, amount_outstanding')
      .eq('company_id', companyId)
      .in('payment_status', ['UNPAID', 'PARTIAL'])
      .not('is_cancelled', 'eq', true)

    const agingSummary: Record<string, number> = { CURRENT: 0, BUCKET_1: 0, BUCKET_2: 0, BUCKET_3: 0, BUCKET_4: 0 }
    for (const inv of agingData || []) {
      const bucket = inv.aging_bucket || 'CURRENT'
      agingSummary[bucket] = (agingSummary[bucket] || 0) + Number(inv.amount_outstanding)
    }

    return NextResponse.json({
      success: true,
      data: { territoryPerformance, monthlyTrend: monthlyData, agingSummary },
    })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed' },
      { status: 500 }
    )
  }
}
