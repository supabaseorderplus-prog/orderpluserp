import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, getUserFromToken } from '@/lib/supabase-server'
import { loadConfirmedInvoiceRequests } from '@/lib/invoice-requests-source'

/**
 * POST /api/v1/orders/fix-delivered
 *
 * Self-service: any authenticated party user can call this to fix their own
 * orders that have confirmed invoice requests but are still in a non-DELIVERED
 * status (stuck due to a previous silent update failure).
 */
export async function POST(req: NextRequest) {
  try {
    const authUser = await getUserFromToken(req)
    if (!authUser) {
      return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 })
    }

    const partyId = authUser.party_id || null
    if (!partyId) {
      return NextResponse.json({ success: true, fixed: 0, message: 'No party linked to this account' })
    }

    // 1. Find confirmed invoice requests for this party from BOTH the
    // invoice_requests table and the company_notes fallback (deployments without
    // the table store them only in the fallback — reading the table alone leaves
    // these orders stuck in PROCUREMENT forever).
    const confirmedReqs = await loadConfirmedInvoiceRequests(partyId)

    const confirmedOrderIds = [
      ...new Set(confirmedReqs.map((r) => r.order_id).filter(Boolean)),
    ]

    if (confirmedOrderIds.length === 0) {
      return NextResponse.json({ success: true, fixed: 0, message: 'No confirmed deliveries found' })
    }

    // 2. Find which of those orders are NOT yet DELIVERED
    const { data: stuckOrders } = await supabaseAdmin
      .from('orders')
      .select('id, status')
      .in('id', confirmedOrderIds)
      .neq('status', 'DELIVERED')

    const stuck = (stuckOrders || []) as { id: string; status: string }[]

    if (stuck.length === 0) {
      return NextResponse.json({ success: true, fixed: 0, message: 'All confirmed orders already DELIVERED' })
    }

    let fixed = 0

    for (const order of stuck) {
      // Step through DISPATCHED first if a DB trigger/constraint enforces it
      if (['PROCUREMENT', 'IN_PROCUREMENT', 'APPROVED'].includes(order.status)) {
        await supabaseAdmin
          .from('orders')
          .update({ status: 'DISPATCHED' })
          .eq('id', order.id)
      }

      const { error: delErr } = await supabaseAdmin
        .from('orders')
        .update({ status: 'DELIVERED' })
        .eq('id', order.id)

      if (!delErr) fixed++
    }

    return NextResponse.json({
      success: true,
      fixed,
      message: `Fixed ${fixed} order${fixed !== 1 ? 's' : ''} to DELIVERED status`,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err || 'Fix failed')
    console.error('[fix-delivered] failed:', message)
    return NextResponse.json({ success: false, message }, { status: 500 })
  }
}
