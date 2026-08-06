import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, getUserFromToken } from '@/lib/supabase-server'

/**
 * POST /api/v1/invoice-requests/backfill-wallet
 *
 * Replays missing wallet deductions for all CONFIRMED invoice_requests
 * belonging to a party. Safe to call multiple times — idempotent via
 * the INVOICE_DEBIT duplicate check.
 *
 * Body: { party_id: string }
 */
export async function POST(req: NextRequest) {
  try {
    const authUser = await getUserFromToken(req)
    if (authUser?.role !== 'SUPER_ADMIN' && authUser?.role !== 'ADMIN') {
      return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 403 })
    }

    const body = await req.json()
    const { party_id } = body as { party_id?: string }

    if (!party_id) {
      return NextResponse.json({ success: false, message: 'party_id is required' }, { status: 400 })
    }

    // 1. Fetch all CONFIRMED invoice_requests for this party
    const { data: requests, error: reqErr } = await supabaseAdmin
      .from('invoice_requests')
      .select('id, order_id, party_id, invoice_number, company_id, confirmed_at')
      .eq('party_id', party_id)
      .eq('status', 'CONFIRMED')

    if (reqErr) throw reqErr

    const confirmed = (requests || []) as {
      id: string
      order_id: string
      party_id: string
      invoice_number: string
      company_id: string | null
      confirmed_at: string | null
    }[]

    if (confirmed.length === 0) {
      return NextResponse.json({ success: true, applied: 0, skipped: 0, message: 'No confirmed invoices found for this party' })
    }

    // 2. Fetch all existing INVOICE_DEBIT transactions for this party in one query
    const { data: existingDebits } = await supabaseAdmin
      .from('wallet_transactions')
      .select('reference_id')
      .eq('party_id', party_id)
      .eq('type', 'INVOICE_DEBIT')

    const alreadyDebited = new Set(
      ((existingDebits || []) as { reference_id: string }[]).map(r => r.reference_id)
    )

    // 3. Filter to only those missing a debit entry
    const missing = confirmed.filter(r => r.invoice_number && !alreadyDebited.has(r.invoice_number))

    if (missing.length === 0) {
      return NextResponse.json({
        success: true,
        applied: 0,
        skipped: confirmed.length,
        message: 'All confirmed invoices already have wallet debits — nothing to do',
      })
    }

    // 4. Fetch all relevant orders in one query
    const orderIds = [...new Set(missing.map(r => r.order_id).filter(Boolean))]
    const { data: orders } = await supabaseAdmin
      .from('orders')
      .select('id, grand_total')
      .in('id', orderIds)

    const orderMap = new Map(
      ((orders || []) as { id: string; grand_total: number }[]).map(o => [o.id, Number(o.grand_total || 0)])
    )

    // 5. Fetch current party wallet balance once
    const { data: partyRow, error: partyErr } = await supabaseAdmin
      .from('parties')
      .select('wallet_balance')
      .eq('id', party_id)
      .single()

    if (partyErr) throw partyErr

    let runningBalance = Number(partyRow?.wallet_balance || 0)
    let applied = 0
    const errors: string[] = []

    // 6. Apply deductions sequentially (sorted by confirmed_at so balance runs correctly)
    const sorted = [...missing].sort((a, b) =>
      (a.confirmed_at || '').localeCompare(b.confirmed_at || '')
    )

    for (const req of sorted) {
      const grandTotal = orderMap.get(req.order_id) || 0
      if (grandTotal <= 0) {
        errors.push(`${req.invoice_number}: order grand_total is 0, skipped`)
        continue
      }

      const newBalance = runningBalance - grandTotal

      const { error: updateErr } = await supabaseAdmin
        .from('parties')
        .update({ wallet_balance: newBalance })
        .eq('id', party_id)

      if (updateErr) {
        errors.push(`${req.invoice_number}: wallet update failed — ${updateErr.message}`)
        continue
      }

      const txPayload: Record<string, unknown> = {
        party_id,
        type: 'INVOICE_DEBIT',
        amount: -grandTotal,
        balance_after: newBalance,
        reference_id: req.invoice_number,
        reference_type: 'INVOICE',
        description: `Invoice ${req.invoice_number} confirmed — ₹${grandTotal.toLocaleString('en-IN')} deducted (backfill)`,
        created_by: authUser?.app_user_id || authUser?.id || null,
        company_id: req.company_id || null,
      }

      const { error: txErr } = await supabaseAdmin.from('wallet_transactions').insert(txPayload)

      if (txErr) {
        if (txErr.code === '42703' || (txErr.message || '').includes('company_id')) {
          delete txPayload.company_id
          const { error: retryErr } = await supabaseAdmin.from('wallet_transactions').insert(txPayload)
          if (retryErr) {
            errors.push(`${req.invoice_number}: tx insert failed — ${retryErr.message}`)
            continue
          }
        } else {
          errors.push(`${req.invoice_number}: tx insert failed — ${txErr.message}`)
          continue
        }
      }

      runningBalance = newBalance
      applied++
    }

    // 7. Backfill order statuses: confirmed invoice requests whose orders are not yet DELIVERED
    const allOrderIds = [...new Set(confirmed.map(r => r.order_id).filter(Boolean))]
    let ordersFixed = 0
    const orderErrors: string[] = []

    if (allOrderIds.length > 0) {
      const { data: stuckOrders } = await supabaseAdmin
        .from('orders')
        .select('id, status')
        .in('id', allOrderIds)
        .neq('status', 'DELIVERED')

      for (const order of (stuckOrders || []) as { id: string; status: string }[]) {
        if (['PROCUREMENT', 'IN_PROCUREMENT', 'APPROVED'].includes(order.status)) {
          const { error: dispErr } = await supabaseAdmin
            .from('orders')
            .update({ status: 'DISPATCHED' })
            .eq('id', order.id)
          if (dispErr) {
            orderErrors.push(`${order.id}: DISPATCHED update failed — ${dispErr.message}`)
            continue
          }
        }
        const { error: delErr } = await supabaseAdmin
          .from('orders')
          .update({ status: 'DELIVERED' })
          .eq('id', order.id)
        if (delErr) {
          orderErrors.push(`${order.id}: DELIVERED update failed — ${delErr.message}`)
        } else {
          ordersFixed++
        }
      }
    }

    return NextResponse.json({
      success: true,
      applied,
      skipped: confirmed.length - missing.length,
      finalBalance: runningBalance,
      ordersFixed,
      errors: [...errors, ...orderErrors].length > 0 ? [...errors, ...orderErrors] : undefined,
      message: `Applied ${applied} missing deduction${applied !== 1 ? 's' : ''}, fixed ${ordersFixed} order status${ordersFixed !== 1 ? 'es' : ''}${[...errors, ...orderErrors].length > 0 ? ` (${[...errors, ...orderErrors].length} error${[...errors, ...orderErrors].length !== 1 ? 's' : ''})` : ''}`,
    })
  } catch (err) {
    console.error('[backfill-wallet] failed:', err)
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Backfill failed' },
      { status: 500 }
    )
  }
}
