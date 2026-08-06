import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, getUserFromToken, resolveCompanyScope, getPartyDescendants } from '@/lib/supabase-server'

type SupabaseCompatError = { code?: string; message?: string } | null | undefined

const isSchemaCompatError = (err: SupabaseCompatError) =>
  !!err && (
    err.code === 'PGRST200' ||
    err.code === 'PGRST204' ||
    err.code === 'PGRST205' ||
    err.code === '42703' ||
    err.code === '42P01' ||
    (err.message || '').includes('schema cache') ||
    (err.message || '').includes("Could not find the table 'public.")
  )

const getOrderPartyId = (order: Record<string, unknown> | null | undefined): string | null => {
  if (!order) return null
  if (typeof order.buyer_id === 'string' && order.buyer_id) return order.buyer_id
  if (typeof order.billing_party_id === 'string' && order.billing_party_id) return order.billing_party_id
  return null
}

const getOrderStatus = (order: Record<string, unknown> | null | undefined): string => {
  if (!order) return 'PENDING'
  if (typeof order.status === 'string' && order.status) return order.status
  if (typeof order.order_status === 'string' && order.order_status) return order.order_status
  return 'PENDING'
}

const getOrderCompanyId = (order: Record<string, unknown> | null | undefined): string | null => {
  if (!order) return null
  if (typeof order.company_id === 'string' && order.company_id) return order.company_id
  if (typeof order.seller_id === 'string' && order.seller_id) return order.seller_id
  return null
}

async function hasOrderAccessInScope(companyId: string | null, order: Record<string, unknown>): Promise<boolean> {
  if (!companyId) return true

  const orderCompanyId = getOrderCompanyId(order)
  if (orderCompanyId && orderCompanyId === companyId) return true

  const partyId = getOrderPartyId(order)
  if (!partyId) return false

  try {
    const tree = await getPartyDescendants(companyId)
    const treeIds = tree && tree.length > 0 ? tree.map((r: { id: string }) => r.id) : []
    if (!treeIds.includes(companyId)) treeIds.push(companyId)
    return treeIds.includes(partyId)
  } catch {
    return false
  }
}

const hydrateOrder = async (baseOrder: Record<string, unknown>) => {
  const orderId = baseOrder.id as string
  const partyId = getOrderPartyId(baseOrder)

  const [{ data: items }, { data: party }] = await Promise.all([
    supabaseAdmin
      .from('order_items')
      .select('*, products(name, sku, technical_specs)')
      .eq('order_id', orderId),
    partyId
      ? supabaseAdmin
          .from('parties')
          .select('id, name, phone, address, party_code, party_types(name)')
          .eq('id', partyId)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ])

  return {
    ...baseOrder,
    buyer: party || null,
    order_items: items || [],
  }
}

export async function GET(
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

    let { data: order, error } = await supabaseAdmin
      .from('orders')
      .select(`
        *,
        buyer:parties!orders_buyer_id_fkey(id, name, phone, address, party_code, party_types(name)),
        order_items(*, products(name, sku, technical_specs))
      `)
      .eq('id', id)
      .single()

    if (error && isSchemaCompatError(error)) {
      const fallback = await supabaseAdmin
        .from('orders')
        .select('*')
        .eq('id', id)
        .single()
      order = fallback.data
      error = fallback.error
      if (!error && order) {
        order = await hydrateOrder(order as Record<string, unknown>)
      }
    }

    if (error || !order) {
      return NextResponse.json({ success: false, message: 'Order not found' }, { status: 404 })
    }

    if (!(await hasOrderAccessInScope(companyId, order as Record<string, unknown>))) {
      return NextResponse.json({ success: false, message: 'Order not found or access denied' }, { status: 403 })
    }

    return NextResponse.json({ success: true, data: order })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed to fetch order' },
      { status: 500 }
    )
  }
}

export async function PUT(
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
    const body = await req.json()

    // Verify order exists
    let { data: existing, error: fetchErr } = await supabaseAdmin
      .from('orders')
      .select('id, buyer_id, billing_party_id, company_id, seller_id, status, order_status')
      .eq('id', id)
      .single()

    if (fetchErr && isSchemaCompatError(fetchErr)) {
      const fallback = await supabaseAdmin
        .from('orders')
        .select('*')
        .eq('id', id)
        .single()
      existing = fallback.data
      fetchErr = fallback.error
    }

    if (fetchErr || !existing) {
      return NextResponse.json({ success: false, message: 'Order not found' }, { status: 404 })
    }

    if (!(await hasOrderAccessInScope(companyId, existing as Record<string, unknown>))) {
      return NextResponse.json({ success: false, message: 'Order not found or access denied' }, { status: 403 })
    }

    // Salesmen may place and track orders but must never approve them — approval
    // is reserved for admins. Enforce server-side, not just by hiding the button.
    const normalizedRole = (authUser.role || '').trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_')
    const isSalesman = normalizedRole === 'SALESMAN'

    // Build update payload — only allow specific fields
    const updateData: Record<string, unknown> = {}
    if (body.status) {
      if (isSalesman && String(body.status).toUpperCase() === 'APPROVED') {
        return NextResponse.json(
          { success: false, message: 'Salesmen are not allowed to approve orders' },
          { status: 403 }
        )
      }
      // Prevent cancelling an approved order
      if (body.status === 'CANCELLED' && getOrderStatus(existing as Record<string, unknown>) === 'APPROVED') {
        return NextResponse.json(
          { success: false, message: 'Cannot cancel an approved order' },
          { status: 400 }
        )
      }
      updateData.status = body.status
    }
    if (body.payment_status) updateData.payment_status = body.payment_status
    if (body.notes !== undefined) updateData.notes = body.notes

    // Handle order items edit — only allowed when PENDING
    if (body.items && Array.isArray(body.items)) {
      if (getOrderStatus(existing as Record<string, unknown>) !== 'PENDING') {
        return NextResponse.json(
          { success: false, message: 'Cannot edit items on an approved or cancelled order' },
          { status: 400 }
        )
      }

      // Preserve any per-line discount the order already had. The inline edit
      // panel only changes quantities/items, so without this an edit would reset
      // grand_total to the gross amount and silently wipe the discount. We read
      // the existing per-product discount_percent and reapply it (the client may
      // also send discount_percent explicitly, which takes precedence).
      const existingDiscountByProduct = new Map<string, number>()
      try {
        const { data: existingItems, error: existingErr } = await supabaseAdmin
          .from('order_items')
          .select('product_id, discount_percent')
          .eq('order_id', id)
        if (existingErr && !isSchemaCompatError(existingErr)) throw existingErr
        for (const row of (existingItems || []) as { product_id: string; discount_percent: number | null }[]) {
          existingDiscountByProduct.set(row.product_id, Number(row.discount_percent) || 0)
        }
      } catch {
        // No discount_percent column — treat all existing discounts as 0.
      }

      // Delete existing order items
      const { error: deleteErr } = await supabaseAdmin
        .from('order_items')
        .delete()
        .eq('order_id', id)
      if (deleteErr) throw deleteErr

      // Insert new items, carrying the per-line discount forward.
      const round2 = (n: number) => Math.round((Number.isFinite(n) ? n : 0) * 100) / 100
      const computed = body.items.map((item: { product_id: string; quantity: number; unit_price: number; discount_percent?: number }) => {
        const qty = Number(item.quantity) || 0
        const price = Number(item.unit_price) || 0
        const discountPercent = Math.min(Math.max(
          item.discount_percent !== undefined
            ? Number(item.discount_percent) || 0
            : existingDiscountByProduct.get(item.product_id) || 0,
          0,
        ), 100)
        const lineGross = round2(qty * price)
        const lineDiscount = round2(lineGross * (discountPercent / 100))
        return { product_id: item.product_id, quantity: item.quantity, unit_price: item.unit_price, discountPercent, lineGross, lineDiscount, lineNet: round2(lineGross - lineDiscount) }
      })

      const newItems = computed.map((c: { product_id: string; quantity: number; unit_price: number; discountPercent: number; lineDiscount: number; lineNet: number }) => ({
        order_id: id,
        product_id: c.product_id,
        quantity: c.quantity,
        unit_price: c.unit_price,
        line_total: c.lineNet,
        discount_percent: c.discountPercent,
        discount_amount: c.lineDiscount,
      }))

      let { error: insertErr } = await supabaseAdmin
        .from('order_items')
        .insert(newItems)
      if (insertErr && isSchemaCompatError(insertErr)) {
        // Deployment lacks discount columns on order_items — retry without them.
        const baseItems = newItems.map(({ discount_percent: _dp, discount_amount: _da, ...rest }: { discount_percent: number; discount_amount: number } & Record<string, unknown>) => rest)
        const retry = await supabaseAdmin.from('order_items').insert(baseItems)
        insertErr = retry.error
      }
      if (insertErr) throw insertErr

      // Recalculate totals from the net line values so the discount survives.
      const newSubtotal = round2(computed.reduce((sum: number, c: { lineGross: number }) => sum + c.lineGross, 0))
      const newDiscountTotal = round2(computed.reduce((sum: number, c: { lineDiscount: number }) => sum + c.lineDiscount, 0))
      const newGrandTotal = round2(newSubtotal - newDiscountTotal)
      updateData.grand_total = newGrandTotal
      updateData.subtotal = newSubtotal
    }

    let { data: updated, error: updateErr } = await supabaseAdmin
      .from('orders')
      .update(Object.keys(updateData).length > 0 ? updateData : { updated_at: new Date().toISOString() })
      .eq('id', id)
      .select(`
        *,
        buyer:parties!orders_buyer_id_fkey(id, name, party_code, party_types(name)),
        order_items(*, products(name, sku, technical_specs))
      `)
      .single()

    if (updateErr && isSchemaCompatError(updateErr)) {
      const fallback = await supabaseAdmin
        .from('orders')
        .update(Object.keys(updateData).length > 0 ? updateData : { updated_at: new Date().toISOString() })
        .eq('id', id)
        .select('*')
        .single()
      updated = fallback.data
      updateErr = fallback.error
      if (!updateErr && updated) {
        updated = await hydrateOrder(updated as Record<string, unknown>)
      }
    }

    if (updateErr) throw updateErr

    return NextResponse.json({ success: true, data: updated })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed to update order' },
      { status: 500 }
    )
  }
}
