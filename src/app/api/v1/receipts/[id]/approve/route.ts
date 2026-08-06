import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, getUserFromToken, resolveCompanyScope } from '@/lib/supabase-server'
import { applyFifo } from '@/lib/services/fifo-engine'

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const authUser = await getUserFromToken(req)
    const companyId = await resolveCompanyScope(req, authUser)
    const { id } = await params

    const { data: receipt, error: fetchErr } = await supabaseAdmin
      .from('receipts')
      .select('*')
      .eq('id', id)
      .single()

    if (fetchErr || !receipt) {
      return NextResponse.json({ success: false, message: 'Receipt not found' }, { status: 404 })
    }

    if (companyId && receipt.company_id !== companyId) {
      return NextResponse.json({ success: false, message: 'Access denied' }, { status: 403 })
    }

    if (receipt.approval_status === 'APPROVED') {
      return NextResponse.json({ success: false, message: 'Receipt already approved' }, { status: 400 })
    }

    // Get running balance for this party
    const { data: lastEntry } = await supabaseAdmin
      .from('ledger_entries')
      .select('balance_after')
      .eq('party_id', receipt.party_id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    const prevBalance = Number(lastEntry?.balance_after || 0)
    const receiptAmount = Number(receipt.amount)
    const newBalance = prevBalance - receiptAmount // CREDIT reduces outstanding

    // Create CREDIT ledger entry
    const { data: ledgerEntry, error: ledgerErr } = await supabaseAdmin
      .from('ledger_entries')
      .insert({
        company_id: companyId || receipt.company_id || null,
        party_id: receipt.party_id,
        type: 'CREDIT',
        amount: receiptAmount,
        balance_after: newBalance,
        reference_id: id,
        reference_type: 'RECEIPT',
        narration: `Receipt ${receipt.receipt_number} approved`,
        entry_date: new Date().toISOString().split('T')[0],
        fiscal_year: new Date().getFullYear().toString(),
        created_by: authUser?.app_user_id || authUser?.id || null,
      })
      .select()
      .single()

    if (ledgerErr) throw ledgerErr

    // Approve the receipt and link the ledger entry
    await supabaseAdmin.from('receipts').update({
      approval_status: 'APPROVED',
      approved_by: authUser?.app_user_id || authUser?.id || null,
      approval_time: new Date().toISOString(),
      ledger_entry_id: ledgerEntry.id,
    }).eq('id', id)

    // Run FIFO: apply payment to oldest unpaid/partial invoices
    await applyFifo({
      partyId: receipt.party_id,
      companyId: companyId || receipt.company_id || null,
      amount: receiptAmount,
      receiptId: id,
    })

    // Credit salesman wallet if applicable
    if (receipt.salesman_id) {
      const { data: wallet } = await supabaseAdmin
        .from('wallets')
        .select('id, balance')
        .eq('owner_id', receipt.salesman_id)
        .eq('wallet_type', 'SALESMAN')
        .maybeSingle()

      if (wallet) {
        await supabaseAdmin.from('wallets').update({ balance: wallet.balance + receiptAmount }).eq('id', wallet.id)
        await supabaseAdmin.from('wallet_transactions').insert({
          party_id: receipt.party_id,
          type: 'PAYMENT_CREDIT',
          amount: receiptAmount,
          balance_after: wallet.balance + receiptAmount,
          reference_id: receipt.receipt_number,
          reference_type: 'RECEIPT',
          description: `Receipt ${receipt.receipt_number} approved — credited to salesman wallet`,
          created_by: authUser?.app_user_id || authUser?.id || null,
          company_id: companyId || receipt.company_id || null,
        })
      }
    }

    return NextResponse.json({ success: true, message: 'Receipt approved', data: { ledger_entry_id: ledgerEntry.id } })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Approval failed' },
      { status: 500 }
    )
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const authUser = await getUserFromToken(req)
    const companyId = await resolveCompanyScope(req, authUser)
    const { id } = await params

    const { data: receipt, error: fetchErr } = await supabaseAdmin
      .from('receipts')
      .select('*')
      .eq('id', id)
      .single()

    if (fetchErr || !receipt) {
      return NextResponse.json({ success: false, message: 'Receipt not found' }, { status: 404 })
    }

    if (companyId && receipt.company_id !== companyId) {
      return NextResponse.json({ success: false, message: 'Access denied' }, { status: 403 })
    }

    if (receipt.approval_status === 'APPROVED') {
      return NextResponse.json({ success: false, message: 'Approved receipts cannot be deleted' }, { status: 400 })
    }

    await supabaseAdmin.from('receipts').update({ status: 'DELETED' }).eq('id', id)
    return NextResponse.json({ success: true })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed to delete receipt' },
      { status: 500 }
    )
  }
}
