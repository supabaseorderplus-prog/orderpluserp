import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, getUserFromToken, resolveCompanyScope } from '@/lib/supabase-server'

export async function GET(req: NextRequest) {
  try {
    const authUser = await getUserFromToken(req)
    const companyId = await resolveCompanyScope(req, authUser)

    if (!companyId) {
      return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 })
    }

    const isSalesman = authUser?.role === 'SALESMAN'

    let salesmanPartyIds: string[] | null = null
    if (isSalesman && authUser) {
      const { data: userRow } = await supabaseAdmin
        .from('app_users')
        .select('assigned_party_id')
        .eq('id', authUser.id)
        .single()
      const rootId = userRow?.assigned_party_id
      if (rootId) {
        const { data: descRows } = await supabaseAdmin.rpc('get_party_descendants', { root_id: rootId })
        salesmanPartyIds = (descRows as { id: string }[] | null)?.map((r) => r.id) ?? []
      } else {
        salesmanPartyIds = []
      }
    }

    const today = new Date().toISOString().split('T')[0]
    const monthStart = today.substring(0, 7) + '-01'
    const now = new Date()
    const fyStart = now.getMonth() >= 3
      ? `${now.getFullYear()}-04-01`
      : `${now.getFullYear() - 1}-04-01`

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const scopeInvoices = (q: any) => {
      q = q.eq('company_id', companyId)
      if (salesmanPartyIds !== null && salesmanPartyIds.length > 0) {
        return q.in('billing_party_id', salesmanPartyIds)
      }
      if (salesmanPartyIds !== null && salesmanPartyIds.length === 0) {
        return q.eq('billing_party_id', '00000000-0000-0000-0000-000000000000')
      }
      return q
    }

    // Run all independent queries in parallel
    const [
      todayInvoicesRes,
      mtdInvoicesRes,
      ytdInvoicesRes,
      activeOrdersRes,
      outstandingDataRes,
      agingDataRes,
      tdDataRes,
      cdDataRes,
      recentInvoicesRes,
      activeSalesmenRes,
      descRowsRes,
      allOutstandingInvoicesRes,
      activeSchemesRes,
      todayPaymentsRes,
      mtdPaymentsRes,
    ] = await Promise.all([
      scopeInvoices(
        supabaseAdmin.from('invoices').select('grand_total').eq('invoice_date', today).not('is_cancelled', 'eq', true)
      ),
      scopeInvoices(
        supabaseAdmin.from('invoices').select('grand_total').gte('invoice_date', monthStart).lte('invoice_date', today).not('is_cancelled', 'eq', true)
      ),
      scopeInvoices(
        supabaseAdmin.from('invoices').select('grand_total').gte('invoice_date', fyStart).lte('invoice_date', today).not('is_cancelled', 'eq', true)
      ),
      scopeInvoices(
        supabaseAdmin.from('invoices').select('id', { count: 'exact', head: true }).in('payment_status', ['UNPAID', 'PARTIAL']).not('is_cancelled', 'eq', true)
      ),
      scopeInvoices(
        supabaseAdmin.from('invoices').select('amount_outstanding').in('payment_status', ['UNPAID', 'PARTIAL']).not('is_cancelled', 'eq', true)
      ),
      scopeInvoices(
        supabaseAdmin.from('invoices').select('aging_bucket, amount_outstanding').in('payment_status', ['UNPAID', 'PARTIAL']).not('is_cancelled', 'eq', true)
      ),
      supabaseAdmin.from('td_ledger').select('td_amount, entry_type').eq('entry_type', 'CREDIT').eq('status', 'ACTIVE').eq('company_id', companyId),
      supabaseAdmin.from('cd_ledger').select('cd_amount, entry_type').eq('entry_type', 'CREDIT').eq('status', 'ACTIVE').eq('company_id', companyId),
      scopeInvoices(
        supabaseAdmin.from('invoices')
          .select('id, invoice_number, invoice_date, grand_total, payment_status, aging_bucket, billing_party_id')
          .not('is_cancelled', 'eq', true)
          .order('invoice_date', { ascending: false })
          .limit(8)
      ),
      supabaseAdmin.from('app_users').select('id', { count: 'exact', head: true }).eq('status', 'ACTIVE').eq('party_id', companyId),
      supabaseAdmin.rpc('get_party_descendants', { root_id: companyId }),
      scopeInvoices(
        supabaseAdmin.from('invoices')
          .select('billing_party_id, amount_outstanding')
          .in('payment_status', ['UNPAID', 'PARTIAL'])
          .not('is_cancelled', 'eq', true)
      ),
      supabaseAdmin.from('schemes').select('id', { count: 'exact', head: true }).eq('status', 'ACTIVE').eq('company_id', companyId).gte('end_date', today),
      supabaseAdmin.from('payments').select('amount').eq('payment_date', today).eq('company_id', companyId),
      supabaseAdmin.from('payments').select('amount').gte('payment_date', monthStart).lte('payment_date', today).eq('company_id', companyId),
    ])

    const todaySales = todayInvoicesRes.data?.reduce((s: number, i: { grand_total: number }) => s + Number(i.grand_total || 0), 0) || 0
    const mtdSales = mtdInvoicesRes.data?.reduce((s: number, i: { grand_total: number }) => s + Number(i.grand_total || 0), 0) || 0
    const ytdSales = ytdInvoicesRes.data?.reduce((s: number, i: { grand_total: number }) => s + Number(i.grand_total || 0), 0) || 0
    const outstanding = outstandingDataRes.data?.reduce((s: number, i: { amount_outstanding: number }) => s + Number(i.amount_outstanding || 0), 0) || 0
    const tdEarned = tdDataRes.data?.reduce((s, t) => s + Number(t.td_amount || 0), 0) || 0
    const cdEarned = cdDataRes.data?.reduce((s, c) => s + Number(c.cd_amount || 0), 0) || 0
    const todayCollection = todayPaymentsRes.data?.reduce((s, p) => s + Number(p.amount || 0), 0) || 0
    const mtdCollection = mtdPaymentsRes.data?.reduce((s, p) => s + Number(p.amount || 0), 0) || 0

    // Aging breakdown
    const aging: Record<string, number> = { CURRENT: 0, BUCKET_1: 0, BUCKET_2: 0, BUCKET_3: 0, BUCKET_4: 0 }
    agingDataRes.data?.forEach((inv: { aging_bucket: string; amount_outstanding: number }) => {
      const bucket = inv.aging_bucket || 'CURRENT'
      aging[bucket] = (aging[bucket] || 0) + Number(inv.amount_outstanding || 0)
    })

    // Recent invoices enrichment
    const recentInvoices = recentInvoicesRes.data as { billing_party_id: string; [k: string]: unknown }[] | null
    const partyIds = [...new Set(recentInvoices?.map(i => i.billing_party_id).filter(Boolean) || [])]
    let partyMap: Record<string, string> = {}
    if (partyIds.length > 0) {
      const { data: parties } = await supabaseAdmin.from('parties').select('id, name').in('id', partyIds)
      parties?.forEach(p => { partyMap[p.id] = p.name })
    }
    const enrichedInvoices = recentInvoices?.map(inv => ({ ...inv, partyName: partyMap[inv.billing_party_id] || 'N/A' })) || []

    // Network size = active parties downstream of the company. get_party_descendants
    // includes the company root, so exclude it. NOTE: the parties table has no
    // is_verified column — filtering on it errors the query and zeroes the count.
    const descendantIds = (descRowsRes.data as { id: string }[] | null)?.map(r => r.id).filter(id => id !== companyId) ?? []
    const totalPartiesRes = descendantIds.length > 0
      ? await supabaseAdmin.from('parties').select('id', { count: 'exact', head: true }).eq('status', 'ACTIVE').in('id', descendantIds)
      : { count: 0 }

    // Top outstanding parties
    const allOutstandingInvoices = allOutstandingInvoicesRes.data as { billing_party_id: string; amount_outstanding: number }[] | null
    const partyOutstanding: Record<string, number> = {}
    allOutstandingInvoices?.forEach(inv => {
      if (inv.billing_party_id) {
        partyOutstanding[inv.billing_party_id] = (partyOutstanding[inv.billing_party_id] || 0) + Number(inv.amount_outstanding || 0)
      }
    })
    const topOutstandingIds = Object.entries(partyOutstanding).sort((a, b) => b[1] - a[1]).slice(0, 5)
    let topOutstandingParties: { id: string; name: string; party_code: string; outstanding: number }[] = []
    if (topOutstandingIds.length > 0) {
      const ids = topOutstandingIds.map(([id]) => id)
      const { data: topParties } = await supabaseAdmin.from('parties').select('id, name, party_code').in('id', ids)
      topOutstandingParties = topOutstandingIds.map(([id, amt]) => {
        const p = topParties?.find(tp => tp.id === id)
        return { id, name: p?.name || 'Unknown', party_code: p?.party_code || '', outstanding: amt }
      })
    }

    return NextResponse.json({
      success: true,
      data: {
        todaySales,
        mtdSales,
        ytdSales,
        activeOrders: activeOrdersRes.count || 0,
        outstanding,
        activeSalesmen: activeSalesmenRes.count || 0,
        totalParties: totalPartiesRes.count || 0,
        tdEarned,
        cdEarned,
        todayCollection,
        mtdCollection,
        activeSchemes: activeSchemesRes.count || 0,
        aging,
        recentInvoices: enrichedInvoices,
        topOutstandingParties,
      },
    })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed to load dashboard' },
      { status: 500 }
    )
  }
}
