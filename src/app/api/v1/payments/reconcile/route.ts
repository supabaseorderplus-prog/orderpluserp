import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, getUserFromToken, resolveCompanyScope } from '@/lib/supabase-server'
import { calculateCD, creditCD } from '@/lib/services/cd-calculator'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { payment_id, adjustments } = body

    if (!payment_id || !adjustments?.length) {
      return NextResponse.json(
        { success: false, message: 'payment_id and adjustments required' },
        { status: 400 }
      )
    }

    // CRITICAL: Enforce company isolation - users can only reconcile payments for their company
    const authUser = await getUserFromToken(req)
    const companyId = await resolveCompanyScope(req, authUser)

    // Verify payment belongs to the user's company
    if (companyId) {
      const { data: payment } = await supabaseAdmin
        .from('payments')
        .select('company_id')
        .eq('id', payment_id)
        .single()

      if (!payment || payment.company_id !== companyId) {
        return NextResponse.json(
          { success: false, message: 'Payment not found or access denied' },
          { status: 403 }
        )
      }
    }

    const results = []

    for (const adj of adjustments) {
      const { invoiceId, amount } = adj

      // Verify invoice belongs to the user's company
      if (companyId) {
        const { data: invCheck } = await supabaseAdmin
          .from('invoices')
          .select('company_id')
          .eq('id', invoiceId)
          .single()

        if (!invCheck || invCheck.company_id !== companyId) {
          return NextResponse.json(
            { success: false, message: 'Invoice not found or access denied' },
            { status: 403 }
          )
        }
      }

      // Create link
      const { data: link, error: linkErr } = await supabaseAdmin
        .from('payment_invoice_links')
        .insert({
          payment_id,
          invoice_id: invoiceId,
          adjusted_amount: amount,
        })
        .select()
        .single()

      if (linkErr) throw linkErr

      // Update invoice outstanding
      const { data: inv } = await supabaseAdmin
        .from('invoices')
        .select('amount_outstanding, amount_paid, grand_total, taxable_amount, invoice_date, invoice_number, billing_party_id')
        .eq('id', invoiceId)
        .single()

      if (inv) {
        const newPaid = Number(inv.amount_paid) + Number(amount)
        const newOutstanding = Number(inv.grand_total) - newPaid
        const newStatus = newOutstanding <= 0 ? 'PAID' : 'PARTIAL'

        await supabaseAdmin.from('invoices').update({
          amount_paid: newPaid,
          amount_outstanding: Math.max(0, newOutstanding),
          payment_status: newStatus,
        }).eq('id', invoiceId)

        // Get payment date and party type for CD
        const { data: payment } = await supabaseAdmin
          .from('payments')
          .select('payment_date, party_id')
          .eq('id', payment_id)
          .single()

        if (payment) {
          const { data: partyData } = await supabaseAdmin
            .from('parties')
            .select('party_types(name)')
            .eq('id', payment.party_id)
            .single()

          const partyTypeName = (partyData?.party_types as { name: string }[] | null)?.[0]?.name || ''

          // Calculate CD
          const cdResult = await calculateCD({
            invoiceValue: Number(inv.taxable_amount),
            invoiceDate: inv.invoice_date,
            paymentDate: payment.payment_date,
            partyId: payment.party_id,
            partyType: partyTypeName,
          })

          if (cdResult) {
            await creditCD({
              partyId: payment.party_id,
              partyType: partyTypeName,
              paymentId: payment_id,
              invoiceId,
              cdConfigId: cdResult.configId,
              cdSlab: cdResult.slab,
              cdPercent: cdResult.cdPercent,
              invoiceValue: Number(inv.taxable_amount),
              cdAmount: cdResult.cdAmount,
              paymentDate: payment.payment_date,
              invoiceDate: inv.invoice_date,
              daysTaken: cdResult.daysTaken,
              invoiceNumber: inv.invoice_number,
            })

            // Update link with CD info
            await supabaseAdmin.from('payment_invoice_links').update({
              cd_triggered: true,
              cd_amount: cdResult.cdAmount,
              cd_slab: cdResult.slab,
            }).eq('id', link.id)
          }
        }
      }

      results.push(link)
    }

    return NextResponse.json({ success: true, data: results })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Reconciliation failed' },
      { status: 500 }
    )
  }
}
