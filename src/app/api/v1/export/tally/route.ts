import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, getUserFromToken, resolveCompanyScope } from '@/lib/supabase-server'

export async function GET(req: NextRequest) {
  try {
    const authUser = await getUserFromToken(req)
    const companyId = await resolveCompanyScope(req, authUser)

    const url = new URL(req.url)
    const from = url.searchParams.get('from') || ''
    const to = url.searchParams.get('to') || ''
    const partyId = url.searchParams.get('party_id') || ''

    let query = supabaseAdmin
      .from('invoices')
      .select(`
        invoice_number, invoice_date, grand_total, taxable_amount,
        cgst_amount, sgst_amount, igst_amount, payment_status,
        billing_party:parties!billing_party_id(name, party_code)
      `)
      .eq('status', 'ACTIVE')
      .not('is_cancelled', 'eq', true)
      .order('invoice_date')

    if (from) query = query.gte('invoice_date', from)
    if (to) query = query.lte('invoice_date', to)
    if (partyId) query = query.eq('billing_party_id', partyId)
    if (companyId) query = query.eq('company_id', companyId)

    const { data, error } = await query
    if (error) throw error

    // Generate Tally XML
    const entries = (data || []).map(inv => {
      const party = (inv.billing_party as { name: string; party_code: string }[] | null)?.[0] || null
      return `  <VOUCHER>
    <DATE>${inv.invoice_date}</DATE>
    <VOUCHERTYPENAME>Sales</VOUCHERTYPENAME>
    <VOUCHERNUMBER>${inv.invoice_number}</VOUCHERNUMBER>
    <PARTYLEDGERNAME>${party?.name || ''}</PARTYLEDGERNAME>
    <AMOUNT>${inv.grand_total}</AMOUNT>
    <LEDGERENTRIES>
      <LEDGERENTRY><LEDGERNAME>Sales Account</LEDGERNAME><AMOUNT>-${inv.taxable_amount}</AMOUNT></LEDGERENTRY>
      <LEDGERENTRY><LEDGERNAME>CGST</LEDGERNAME><AMOUNT>-${inv.cgst_amount}</AMOUNT></LEDGERENTRY>
      <LEDGERENTRY><LEDGERNAME>SGST</LEDGERNAME><AMOUNT>-${inv.sgst_amount}</AMOUNT></LEDGERENTRY>
      <LEDGERENTRY><LEDGERNAME>IGST</LEDGERNAME><AMOUNT>-${inv.igst_amount}</AMOUNT></LEDGERENTRY>
      <LEDGERENTRY><LEDGERNAME>${party?.name || 'Debtor'}</LEDGERNAME><AMOUNT>${inv.grand_total}</AMOUNT></LEDGERENTRY>
    </LEDGERENTRIES>
  </VOUCHER>`
    }).join('\n')

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
<HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
<BODY>
<IMPORTDATA><REQUESTDATA>
<TALLYMESSAGE xmlns:UDF="TallyUDF">
${entries}
</TALLYMESSAGE>
</REQUESTDATA></IMPORTDATA>
</BODY>
</ENVELOPE>`

    return new Response(xml, {
      headers: {
        'Content-Type': 'application/xml',
        'Content-Disposition': `attachment; filename="tally-export-${from || 'all'}.xml"`,
      },
    })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Export failed' },
      { status: 500 }
    )
  }
}
