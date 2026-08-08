import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, getUserFromToken, resolveCompanyScope, getPartyDescendants } from '@/lib/supabase-server'

type SupabaseError = { code?: string; message?: string } | null

function missingColumn(error: SupabaseError): string | null {
  const message = error?.message || ''
  const patterns = [
    /Could not find the '([^']+)' column/i,
    /column\s+"?([^"\s]+)"?\s+(?:of relation\s+"?[^"]+"?\s+)?does not exist/i,
    /column\s+[^.\s]+\.([^\s]+)\s+does not exist/i,
  ]
  for (const pattern of patterns) {
    const match = message.match(pattern)
    if (match?.[1]) return match[1].replace(/"/g, '')
  }
  return null
}

async function approveOrderCompat(id: string, approvedBy: string | null) {
  const optionalColumns = new Set(['order_status', 'approved_by', 'approval_time'])
  const payload: Record<string, unknown> = {
    status: 'APPROVED',
    order_status: 'APPROVED',
    approved_by: approvedBy,
    approval_time: new Date().toISOString(),
  }

  for (let attempt = 0; attempt <= optionalColumns.size; attempt += 1) {
    const result = await supabaseAdmin
      .from('orders')
      .update(payload)
      .eq('id', id)
      .select('*')
      .maybeSingle()

    if (!result.error) return result
    const column = missingColumn(result.error)
    if (!column || !optionalColumns.has(column) || !(column in payload)) return result
    delete payload[column]
  }

  return { data: null, error: { message: 'Order approval could not be saved.' } }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const authUser = await getUserFromToken(req)
    if (!authUser) {
      return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 })
    }

    let companyId = await resolveCompanyScope(req, authUser)
    if (!companyId && authUser.role !== 'SUPER_ADMIN') {
      companyId = authUser.party_id || null
    }
    if (!companyId && authUser.role !== 'SUPER_ADMIN') {
      return NextResponse.json({ success: false, message: 'Company scope is required' }, { status: 403 })
    }

    const { id } = await params

    const normalizedRole = (authUser.role || '').trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_')
    if (normalizedRole === 'SALESMAN') {
      return NextResponse.json(
        { success: false, message: 'Salesmen are not allowed to approve orders' },
        { status: 403 },
      )
    }

    // Get order
    // select('*') keeps approval compatible with legacy schemas that only have
    // billing_party_id and do not yet have company_id/seller_id/buyer_id.
    const { data: order, error } = await supabaseAdmin
      .from('orders')
      .select('*')
      .eq('id', id)
      .maybeSingle()

    if (error) throw error
    if (!order) {
      return NextResponse.json({ success: false, message: 'Order not found' }, { status: 404 })
    }

    if (companyId) {
      const partyId = order.buyer_id || order.billing_party_id
      const directMatch = (order.company_id && order.company_id === companyId) || (order.seller_id && order.seller_id === companyId)
      if (!directMatch) {
        if (!partyId) {
          return NextResponse.json({ success: false, message: 'Order not found or access denied' }, { status: 403 })
        }
        const tree = await getPartyDescendants(companyId)
        const treeIds = tree && tree.length > 0 ? tree.map((r: { id: string }) => r.id) : []
        if (!treeIds.includes(companyId)) treeIds.push(companyId)
        if (!treeIds.includes(partyId)) {
          return NextResponse.json({ success: false, message: 'Order not found or access denied' }, { status: 403 })
        }
      }
    }

    // Validate status transition
    const currentStatus = String(order.status || order.order_status || '').toUpperCase()
    if (currentStatus !== 'PENDING') {
      return NextResponse.json(
        { success: false, message: `Cannot approve order with status "${currentStatus}". Order must be PENDING.` },
        { status: 400 }
      )
    }

    // Update both status fields when present, and automatically drop optional
    // audit columns that do not exist in older deployments.
    const { data: updated, error: updateErr } = await approveOrderCompat(
      id,
      authUser?.app_user_id || authUser?.id || null,
    )

    if (updateErr) throw updateErr
    if (!updated) {
      return NextResponse.json({ success: false, message: 'Order status changed. Refresh and try again.' }, { status: 409 })
    }

    return NextResponse.json({ success: true, data: updated, message: 'Order approved' })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Approval failed' },
      { status: 500 }
    )
  }
}
