import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, getUserFromToken, resolveCompanyScope } from '@/lib/supabase-server'

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url)
    const from = url.searchParams.get('from') || ''
    const to = url.searchParams.get('to') || ''
    const partyId = url.searchParams.get('party_id') || ''

    // CRITICAL: Enforce company isolation - GSTR1 exports must be scoped to user's company
    const authUser = await getUserFromToken(req)
    const companyId = await resolveCompanyScope(req, authUser)

    let query = supabaseAdmin
      .from('invoices')
      .select(`
        id, invoice_number, invoice_date, invoice_type, billing_path,
        subtotal, taxable_amount, cgst_amount, sgst_amount, igst_amount, grand_total,
        supplier_gstin, buyer_gstin, is_interstate, place_of_supply,
        billing_party:parties!billing_party_id(name, gstin, states(name, state_code)),
        invoice_items(hsn_code, quantity, unit_of_measure, taxable_amount, gst_rate, cgst_amount, sgst_amount, igst_amount)
      `)
      .eq('status', 'ACTIVE')
      .not('is_cancelled', 'eq', true)
      .eq('invoice_type', 'TAX_INVOICE')
      .order('invoice_date')

    if (from) query = query.gte('invoice_date', from)
    if (to) query = query.lte('invoice_date', to)
    if (partyId) query = query.eq('billing_party_id', partyId)

    // CRITICAL: Filter by company_id to prevent cross-company data access
    if (companyId) {
      query = query.eq('company_id', companyId)
    }

    const { data, error } = await query
    if (error) throw error

    // Format as GSTR-1 JSON structure
    const gstr1 = {
      gstin: data?.[0]?.supplier_gstin || '',
      fp: from ? from.substring(0, 7).replace('-', '') : '',
      b2b: (data || []).filter(inv => inv.buyer_gstin).map(inv => ({
        ctin: inv.buyer_gstin,
        inv: [{
          inum: inv.invoice_number,
          idt: inv.invoice_date,
          val: Number(inv.grand_total),
          pos: inv.place_of_supply,
          rchrg: 'N',
          itms: (inv.invoice_items || []).map((item: { hsn_code: string; taxable_amount: number; gst_rate: number; cgst_amount: number; sgst_amount: number; igst_amount: number }) => ({
            num: 1,
            itm_det: {
              txval: Number(item.taxable_amount),
              rt: Number(item.gst_rate),
              camt: Number(item.cgst_amount),
              samt: Number(item.sgst_amount),
              iamt: Number(item.igst_amount),
            },
          })),
        }],
      })),
      hsn: {
        data: (data || []).flatMap(inv =>
          (inv.invoice_items || []).map((item: { hsn_code: string; quantity: number; unit_of_measure: string; taxable_amount: number; gst_rate: number; cgst_amount: number; sgst_amount: number; igst_amount: number }) => ({
            hsn_sc: item.hsn_code,
            qty: Number(item.quantity),
            uqc: item.unit_of_measure,
            txval: Number(item.taxable_amount),
            rt: Number(item.gst_rate),
            camt: Number(item.cgst_amount),
            samt: Number(item.sgst_amount),
            iamt: Number(item.igst_amount),
          }))
        ),
      },
    }

    return NextResponse.json({ success: true, data: gstr1 })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Export failed' },
      { status: 500 }
    )
  }
}
