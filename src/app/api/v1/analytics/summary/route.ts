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
    const partyId = url.searchParams.get('party_id') || ''
    const from = url.searchParams.get('from') || ''
    const to = url.searchParams.get('to') || ''

    let query = supabaseAdmin
      .from('invoices')
      .select('grand_total, taxable_amount, cgst_amount, sgst_amount, igst_amount, payment_status, amount_outstanding')
      .not('is_cancelled', 'eq', true)
      .eq('company_id', companyId)

    if (partyId) query = query.eq('billing_party_id', partyId)
    if (from) query = query.gte('invoice_date', from)
    if (to) query = query.lte('invoice_date', to)

    const { data: invoices } = await query

    let payQuery = supabaseAdmin
      .from('payments')
      .select('amount')
      .eq('parties.company_id', companyId)

    if (partyId) payQuery = payQuery.eq('party_id', partyId)
    if (from) payQuery = payQuery.gte('payment_date', from)
    if (to) payQuery = payQuery.lte('payment_date', to)

    const { data: payments } = await payQuery

    const totalBilling = (invoices || []).reduce((s, i) => s + Number(i.grand_total), 0)
    const totalTaxable = (invoices || []).reduce((s, i) => s + Number(i.taxable_amount), 0)
    const totalCGST = (invoices || []).reduce((s, i) => s + Number(i.cgst_amount), 0)
    const totalSGST = (invoices || []).reduce((s, i) => s + Number(i.sgst_amount), 0)
    const totalIGST = (invoices || []).reduce((s, i) => s + Number(i.igst_amount), 0)
    const totalCollections = (payments || []).reduce((s, p) => s + Number(p.amount), 0)
    const totalOutstanding = (invoices || []).filter(i => ['UNPAID', 'PARTIAL'].includes(i.payment_status)).reduce((s, i) => s + Number(i.amount_outstanding), 0)
    const invoiceCount = (invoices || []).length

    return NextResponse.json({
      success: true,
      data: {
        totalBilling, totalTaxable, totalCGST, totalSGST, totalIGST,
        totalTax: totalCGST + totalSGST + totalIGST,
        totalCollections, totalOutstanding, invoiceCount,
        collectionRatio: totalBilling > 0 ? Math.round((totalCollections / totalBilling) * 10000) / 100 : 0,
      },
    })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed' },
      { status: 500 }
    )
  }
}
