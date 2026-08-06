import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, getUserFromToken, resolveCompanyScope } from '@/lib/supabase-server'

export async function GET(req: NextRequest) {
  try {
    const authUser = await getUserFromToken(req)
    const companyId = await resolveCompanyScope(req, authUser)

    const url = new URL(req.url)
    const from = url.searchParams.get('from') || new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split('T')[0]
    const to = url.searchParams.get('to') || new Date().toISOString().split('T')[0]
    const territoryId = url.searchParams.get('territory')

    let payQuery = supabaseAdmin
      .from('payments')
      .select('*, parties(name, party_code, party_types(name)), payment_invoice_links(adjusted_amount, invoices(invoice_number))')
      .gte('payment_date', from)
      .lte('payment_date', to)
      .order('payment_date', { ascending: true })

    // CRITICAL: Filter by company_id through parties relationship for data isolation
    if (companyId) {
      payQuery = payQuery.eq('parties.company_id', companyId)
    }

    const { data: payments } = await payQuery

    // Build CSV
    const rows = (payments || []).map(p => {
      const party = p.parties as Record<string, unknown> | null
      const links = (p.payment_invoice_links || []) as Record<string, unknown>[]
      const invoiceNos = links.map(l => {
        const inv = l.invoices as Record<string, unknown> | null
        return inv?.invoice_number || ''
      }).join('; ')

      return [
        p.payment_date,
        p.payment_number,
        party?.name || '',
        party?.party_code || '',
        p.payment_mode,
        p.amount,
        p.reference_number || '',
        p.is_advance ? 'Yes' : 'No',
        p.is_verified ? 'Yes' : 'No',
        invoiceNos,
      ].join(',')
    })

    const totalCollection = (payments || []).reduce((s, p) => s + Number(p.amount), 0)

    const csv = [
      `Collection Report: ${from} to ${to}`,
      '',
      'Date,Receipt No,Party,Code,Mode,Amount,Reference,Advance,Verified,Against Invoices',
      ...rows,
      '',
      `Total Collection: ${totalCollection}`,
      `Total Receipts: ${(payments || []).length}`,
    ].join('\n')

    return new NextResponse(csv, {
      headers: {
        'Content-Type': 'text/csv',
        'Content-Disposition': `attachment; filename="collection-report-${from}-${to}.csv"`,
      },
    })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Export failed' },
      { status: 500 }
    )
  }
}
