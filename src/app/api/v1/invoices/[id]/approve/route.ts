import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, getUserFromToken, resolveCompanyScope } from '@/lib/supabase-server'
import { calculateTD, creditTD } from '@/lib/services/td-calculator'

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const authUser = await getUserFromToken(req)
    const companyId = await resolveCompanyScope(req, authUser)

    const { id } = await params

    // Get invoice
    const { data: invoice, error: invErr } = await supabaseAdmin
      .from('invoices')
      .select('*, invoice_items(*)')
      .eq('id', id)
      .single()

    if (invErr || !invoice) {
      return NextResponse.json({ success: false, message: 'Invoice not found' }, { status: 404 })
    }

    // Verify company access
    if (companyId && invoice.company_id !== companyId) {
      return NextResponse.json({ success: false, message: 'Invoice not found or access denied' }, { status: 403 })
    }

    if (invoice.approved_by) {
      return NextResponse.json({ success: false, message: 'Invoice already approved' }, { status: 400 })
    }

    // Approve
    await supabaseAdmin.from('invoices').update({
      approved_by: authUser?.app_user_id || authUser?.id || invoice.created_by,
      approval_time: new Date().toISOString(),
      order_status: 'CONFIRM',
    }).eq('id', id)

    // Create DEBIT ledger entry for this invoice
    if (invoice.billing_party_id && invoice.grand_total) {
      // Get current party balance from ledger
      const { data: lastEntry } = await supabaseAdmin
        .from('ledger_entries')
        .select('balance_after')
        .eq('party_id', invoice.billing_party_id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()

      const prevBalance = Number(lastEntry?.balance_after || 0)
      const invoiceAmount = Number(invoice.grand_total)
      const newBalance = prevBalance + invoiceAmount

      await supabaseAdmin.from('ledger_entries').insert({
        company_id: companyId || invoice.company_id || null,
        party_id: invoice.billing_party_id,
        type: 'DEBIT',
        amount: invoiceAmount,
        balance_after: newBalance,
        reference_id: id,
        reference_type: 'INVOICE',
        narration: `Invoice ${invoice.invoice_number} approved`,
        entry_date: new Date().toISOString().split('T')[0],
        fiscal_year: new Date().getFullYear().toString(),
        created_by: authUser?.app_user_id || authUser?.id || null,
      })
    }

    // Trigger TD if applicable
    if (!invoice.td_triggered && ['A', 'B'].includes(invoice.billing_path)) {
      const tdResult = await calculateTD({
        invoiceId: id,
        billingPath: invoice.billing_path as 'A' | 'B',
        cnfId: invoice.cnf_id,
        superDealerId: invoice.super_dealer_id,
        invoiceDate: invoice.invoice_date,
        invoiceItems: invoice.invoice_items || [],
      })

      if (tdResult && tdResult.configId) {
        await creditTD({
          partyId: tdResult.partyId,
          partyType: tdResult.partyType,
          invoiceId: id,
          tdConfigId: tdResult.configId,
          tdPercent: tdResult.tdPercent,
          baseAmount: tdResult.baseAmount,
          tdAmount: tdResult.tdAmount,
          invoiceNumber: invoice.invoice_number,
          invoiceDate: invoice.invoice_date,
        })
      }
    }

    return NextResponse.json({ success: true, message: 'Invoice approved' })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Approval failed' },
      { status: 500 }
    )
  }
}
