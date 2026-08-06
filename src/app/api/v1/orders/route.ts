import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, getUserFromToken, resolveCompanyScope, getPartyDescendants } from '@/lib/supabase-server'
import { IN_FILTER_MAX_IDS, chunkIds, fetchAllInChunks } from '@/lib/supabase-in-chunks'
import { getScopedPartyIdsForUser } from '@/lib/party-scope'

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

const getMissingColumn = (err: { message?: string } | null | undefined) => {
  const message = err?.message || ''
  const patterns = [
    /Could not find the '([^']+)' column/i,
    /column\s+"?([^"\s]+)"?\s+does not exist/i,
    /column\s+([^.\s]+)\.([^.\s]+)\s+does not exist/i,
  ]

  for (const pattern of patterns) {
    const match = message.match(pattern)
    if (!match) continue
    if (match[2]) return match[2]
    if (match[1]) return match[1]
  }
  return null
}

const isOrderNumberDuplicateError = (err: { code?: string; message?: string; details?: string } | null | undefined) => {
  if (!err) return false
  return (
    err.code === '23505' &&
    (
      (err.message || '').includes('orders_order_number_key') ||
      (err.details || '').includes('orders_order_number_key')
    )
  )
}

const generateNextOrderNumber = async (attempt = 0) => {
  let orderNumber = 'ORD/WB/001'
  const { data: existing } = await supabaseAdmin
    .from('orders')
    .select('order_number')
    .order('created_at', { ascending: false })
    .limit(1000)

  let maxSeq = 0
  for (const row of existing || []) {
    const match = (row.order_number || '').match(/ORD\/WB\/(\d+)$/)
    if (match) {
      const n = parseInt(match[1], 10)
      if (n > maxSeq) maxSeq = n
    }
  }
  // On high-concurrency retries, switch to a time-based suffix to guarantee uniqueness.
  if (attempt >= 2) {
    orderNumber = `ORD/WB/${Date.now()}${attempt}`
  } else {
    orderNumber = `ORD/WB/${String(maxSeq + 1).padStart(3, '0')}`
  }
  return orderNumber
}

const insertOrder = async (payload: Record<string, unknown>) => {
  const optionalColumns = new Set([
    'seller_id',
    'company_id',
    'order_type',
    'payment_mode',
    'payment_status',
    'delivery_date',
    'notes',
    'is_offline_created',
    'created_by',
    'status',
    'discount_amount',
    'gst_amount',
    // buyer_id / billing_party_id: both are optional to handle old and new schema column names
    'buyer_id',
    'billing_party_id',
  ])
  const enumLikeColumns = ['order_type', 'payment_mode', 'payment_status', 'status']
  const current = { ...payload }
  let enumFallbackTried = false

  for (let attempt = 0; attempt < optionalColumns.size + 3; attempt += 1) {
    const result = await supabaseAdmin
      .from('orders')
      .insert(current)
      .select('id, order_number, created_at')
      .single()

    if (!result.error) return result

    const missingColumn = getMissingColumn(result.error)
    if (missingColumn && optionalColumns.has(missingColumn) && missingColumn in current) {
      delete current[missingColumn]
      continue
    }

    if (result.error.code === '22P02' && !enumFallbackTried) {
      enumLikeColumns.forEach((column) => delete current[column])
      enumFallbackTried = true
      continue
    }

    return result
  }

  return supabaseAdmin
    .from('orders')
    .insert(current)
    .select('id, order_number, created_at')
    .single()
}

const insertOrderItems = async (rows: Record<string, unknown>[]) => {
  const optionalColumns = new Set(['line_total', 'discount_percent', 'discount_amount', 'gst_amount'])
  let currentRows = rows.map((row) => ({ ...row }))

  for (let attempt = 0; attempt < optionalColumns.size + 2; attempt += 1) {
    const result = await supabaseAdmin.from('order_items').insert(currentRows)
    if (!result.error) return result

    const missingColumn = getMissingColumn(result.error)
    if (missingColumn && optionalColumns.has(missingColumn) && currentRows.some((row) => missingColumn in row)) {
      currentRows = currentRows.map((row) => {
        const next = { ...row }
        delete next[missingColumn]
        return next
      })
      continue
    }

    return result
  }

  return supabaseAdmin.from('order_items').insert(currentRows)
}

const hydrateOrders = async (orders: Record<string, unknown>[] | null) => {
  const rows = (orders || []).map((row) => ({ ...row }))
  if (rows.length === 0) return rows

  const orderIds = rows
    .map((row) => row.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
  const buyerIds = [...new Set(rows
    .map((row) => (row.buyer_id || row.billing_party_id))
    .filter((id): id is string => typeof id === 'string' && id.length > 0))]

  // Chunked: with large `limit` requests these ID lists can exceed the URL-safe
  // .in() size (see src/lib/supabase-in-chunks.ts).
  //
  // The item count is what the UI shows as "N items", so it must survive even when
  // an OPTIONAL column or product relationship is absent on this deployment.
  // discount_percent / discount_amount (order_items) and pack_size / category_id /
  // unit_of_measure / product_categories (products) are all added lazily via
  // `ADD COLUMN IF NOT EXISTS` and may not exist everywhere. A single rich select
  // that references any missing column/relationship 42703/PGRST200-fails the whole
  // chunk; fetchAllInChunks then returns null and EVERY order silently shows
  // "0 items". So we degrade through progressively safer selects until one works:
  // full → minimal product embed → no embed → bare counts. The frontend only needs
  // products(name, sku, technical_specs), so the minimal embed already satisfies it.
  const ORDER_ITEM_BASE = 'id, order_id, product_id, quantity, unit_price, line_total'
  const ORDER_ITEM_SELECTS = [
    `${ORDER_ITEM_BASE}, discount_percent, discount_amount, products(name, sku, unit_of_measure, technical_specs, pack_size, category_id, product_categories(id, name))`,
    `${ORDER_ITEM_BASE}, discount_percent, discount_amount, products(name, sku, technical_specs)`,
    `${ORDER_ITEM_BASE}, products(name, sku, technical_specs)`,
    ORDER_ITEM_BASE,
    'id, order_id, product_id, quantity',
  ]
  const fetchOrderItemsChunk = async (chunk: string[]) => {
    let lastResult = await supabaseAdmin
      .from('order_items')
      .select(ORDER_ITEM_SELECTS[0])
      .in('order_id', chunk)
    if (!lastResult.error) return lastResult
    // Only keep retrying for schema-shape errors (missing column/relationship/table).
    // A real failure (auth, network) should surface, not be masked by a simpler query.
    for (let i = 1; i < ORDER_ITEM_SELECTS.length && isSchemaCompatError(lastResult.error); i += 1) {
      lastResult = await supabaseAdmin
        .from('order_items')
        .select(ORDER_ITEM_SELECTS[i])
        .in('order_id', chunk)
      if (!lastResult.error) return lastResult
    }
    return lastResult
  }
  const [{ data: itemRows }, { data: buyerRows }] = await Promise.all([
    orderIds.length > 0
      ? fetchAllInChunks(orderIds, fetchOrderItemsChunk)
      : Promise.resolve({ data: [] as unknown[] }),
    buyerIds.length > 0
      ? fetchAllInChunks(buyerIds, (chunk) =>
          supabaseAdmin
            .from('parties')
            .select('id, name, party_code, party_types(name)')
            .in('id', chunk))
      : Promise.resolve({ data: [] as unknown[] }),
  ])

  const itemsByOrderId = new Map<string, unknown[]>()
  for (const item of (itemRows || []) as Array<{ order_id: string } & Record<string, unknown>>) {
    const key = item.order_id
    const list = itemsByOrderId.get(key) || []
    list.push(item)
    itemsByOrderId.set(key, list)
  }

  const buyersById = new Map<string, unknown>()
  for (const buyer of (buyerRows || []) as Array<{ id: string } & Record<string, unknown>>) {
    buyersById.set(buyer.id, buyer)
  }

  return rows.map((row) => {
    const orderId = typeof row.id === 'string' ? row.id : null
    const buyerId = (typeof row.buyer_id === 'string' ? row.buyer_id : null) || (typeof row.billing_party_id === 'string' ? row.billing_party_id : null)
    return {
      ...row,
      order_items: orderId ? (itemsByOrderId.get(orderId) || []) : [],
      buyer: buyerId ? (buyersById.get(buyerId) || null) : null,
    }
  })
}

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url)
    const page = parseInt(url.searchParams.get('page') || '1')
    const limit = parseInt(url.searchParams.get('limit') || '20')
    let partyId = url.searchParams.get('party_id') || ''
    const orderStatus = url.searchParams.get('status') || ''
    const approvedBy = url.searchParams.get('approved_by') || ''
    const offset = (page - 1) * limit

    // CRITICAL: Require authenticated access and company scope.
    const authUser = await getUserFromToken(req)
    if (!authUser) {
      return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 })
    }

    // Role-aware order visibility:
    //  - ADMIN / SUPER_ADMIN: every order under the company (scoped below).
    //  - SALESMAN: only orders for parties in their downline (direct + group
    //    assignments + descendants) plus orders they placed themselves. Resolved
    //    after the company tree is built, via getScopedPartyIdsForUser.
    //  - Other party users (retailer/dealer/etc.): only their own party's orders.
    const normalizedRole = (authUser.role || '').trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_')
    const isAdminRole = normalizedRole === 'SUPER_ADMIN' || normalizedRole === 'ADMIN'
    const isSalesman = normalizedRole === 'SALESMAN'
    if (!isAdminRole && !isSalesman && authUser.party_id) {
      partyId = authUser.party_id
    }

    let companyId = await resolveCompanyScope(req, authUser)
    if (!companyId && authUser.role !== 'SUPER_ADMIN') {
      companyId = authUser.party_id || null
    }
    if (!companyId && authUser.role !== 'SUPER_ADMIN') {
      return NextResponse.json(
        { success: false, message: 'Company scope is required to access orders' },
        { status: 403 }
      )
    }

    // Get all party IDs under this company to filter orders.
    // We also try a direct children query as fallback when the RPC is unavailable.
    let companyPartyIds: string[] | null = null
    if (companyId) {
      try {
        // Cached, non-truncating party subtree (shared 30s cache across orders/
        // payments/wallets keyed by the same company root). Avoids one uncached
        // round-trip to the get_party_descendants RPC on every request.
        const tree = await getPartyDescendants(companyId)
        const treeIds = tree.map((r) => r.id)
        if (!treeIds.includes(companyId)) treeIds.push(companyId)
        companyPartyIds = treeIds.length > 0 ? treeIds : null
      } catch (e) {
        console.warn('[ORDERS GET] get_party_descendants failed, fetching direct children', e)
        try {
          const { data: children } = await supabaseAdmin
            .from('parties')
            .select('id')
            .eq('parent_party_id', companyId)
          const childIds = (children || []).map((c: { id: string }) => c.id)
          companyPartyIds = [companyId, ...childIds]
        } catch {
          companyPartyIds = [companyId]
        }
      }
    }

    // SALESMAN downline scope: narrow the company tree to the parties this
    // salesman owns (direct + group-assigned + their descendants), then union in
    // the parties of any orders the salesman placed personally ("orders he
    // placed OR parties in the group assigned to his downline"). Fail-closed: a
    // salesman with no assignments and no self-placed orders sees nothing rather
    // than the whole company.
    if (isSalesman) {
      const scoped = await getScopedPartyIdsForUser(authUser, companyId)
      const scopeSet = new Set<string>(scoped || [])

      const salesmanIds = [...new Set([authUser.id, authUser.app_user_id].filter((id): id is string => Boolean(id)))]
      if (salesmanIds.length > 0) {
        const { data: ownOrders, error: ownErr } = await supabaseAdmin
          .from('orders')
          .select('billing_party_id')
          .in('created_by', salesmanIds)
        // created_by may be absent on legacy schemas — ignore and keep party scope.
        if (!ownErr) {
          for (const row of (ownOrders || []) as { billing_party_id: string | null }[]) {
            if (row.billing_party_id) scopeSet.add(row.billing_party_id)
          }
        }
      }

      companyPartyIds = [...scopeSet]
    }

    // Non-super-admin users must remain company-scoped.
    if (companyId && (!companyPartyIds || companyPartyIds.length === 0)) {
      return NextResponse.json({
        success: true,
        data: [],
        pagination: { page, limit, total: 0, pages: 0 },
      })
    }

    const applyCommonFilters = <T extends { eq: (...args: unknown[]) => T; or: (...args: unknown[]) => T }>(queryBuilder: T) => {
      let next = queryBuilder
      if (approvedBy) next = next.eq('approved_by', approvedBy)
      if (orderStatus) next = next.or(`status.eq.${orderStatus},order_status.eq.${orderStatus}`)
      return next
    }

    // Thenable shape shared by every tier's query builder.
    interface OrdersPageQuery extends PromiseLike<{
      data: Record<string, unknown>[] | null
      count: number | null
      error: SupabaseCompatError
    }> {
      in(column: string, values: string[]): OrdersPageQuery
      range(from: number, to: number): OrdersPageQuery
      limit(count: number): OrdersPageQuery
    }

    // Runs one tier's query scoped to companyPartyIds. Large scopes can't go into a
    // single .in() filter (PostgREST URL > undici's 16KB header cap), so split into
    // chunks, take each chunk's top (offset+limit) rows by created_at — enough to
    // reconstruct the global page — then merge, re-sort and slice. Totals come from
    // summing per-chunk exact counts.
    const runScopedQuery = async (build: () => OrdersPageQuery, scopeColumn: string) => {
      if (!companyId || !companyPartyIds) {
        return await build().range(offset, offset + limit - 1)
      }
      if (companyPartyIds.length <= IN_FILTER_MAX_IDS) {
        return await build().in(scopeColumn, companyPartyIds).range(offset, offset + limit - 1)
      }
      const results = await Promise.all(
        chunkIds(companyPartyIds).map((chunk) => build().in(scopeColumn, chunk).limit(offset + limit))
      )
      let total = 0
      const rows: Record<string, unknown>[] = []
      for (const result of results) {
        if (result.error) return { data: null, count: null, error: result.error }
        total += result.count || 0
        rows.push(...(result.data || []))
      }
      rows.sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')))
      return { data: rows.slice(offset, offset + limit), count: total, error: null }
    }

    const buildTierQuery = (partyColumn: 'billing_party_id' | 'buyer_id') => () => {
      let q = supabaseAdmin
        .from('orders')
        .select('*', { count: 'exact' })
        .order('created_at', { ascending: false })
      if (partyId) q = q.eq(partyColumn, partyId)
      return applyCommonFilters(q as unknown as { eq: (...args: unknown[]) => unknown; or: (...args: unknown[]) => unknown }) as unknown as OrdersPageQuery
    }

    // Tier-1: primary scope via billing_party_id (the canonical, always-present
    // party column). buyer_id-based scoping is handled by Tier-2 only on schemas
    // where that column exists — referencing it here would crash legacy schemas.
    let { data, count, error } = await runScopedQuery(buildTierQuery('billing_party_id'), 'billing_party_id')

    // Tier-1b: if billing_party_id scoping returned nothing without a schema error,
    // retry with buyer_id (covers newer schemas where orders are linked via buyer_id
    // and billing_party_id is unpopulated). Errors here are ignored — the column may
    // not exist on legacy schemas, in which case Tier-1's result stands.
    if (!error && (!data || data.length === 0) && (companyPartyIds || partyId)) {
      const retry = await runScopedQuery(buildTierQuery('buyer_id'), 'buyer_id')
      if (!retry.error && retry.data && retry.data.length > 0) {
        data = retry.data
        count = retry.count
      }
    }

    // Tier-2: newer schema scope via buyer_id
    if (error && isSchemaCompatError(error)) {
      const t2 = await runScopedQuery(buildTierQuery('buyer_id'), 'buyer_id')
      data = t2.data
      count = t2.count
      error = t2.error
    }

    // Tier-3: seller-only scope, still restricted to one company
    if (error && isSchemaCompatError(error)) {
      let t3Query = supabaseAdmin
        .from('orders')
        .select('*', { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1)
      if (companyId) t3Query = t3Query.eq('seller_id', companyId)
      t3Query = applyCommonFilters(t3Query)
      const t3 = await t3Query
      data = t3.data
      count = t3.count
      error = t3.error
    }

    if (error && isSchemaCompatError(error)) {
      // Schema is completely unresolvable — return empty rather than 500
      return NextResponse.json({
        success: true,
        data: [],
        pagination: { page, limit, total: 0, pages: 0 },
      })
    }
    if (error) throw error

    // Fallback queries can return bare order rows without relational data.
    // Hydrate order_items + buyer so UI always reflects item counts/details.
    let enrichedData = await hydrateOrders(data as Record<string, unknown>[] | null)

    // When fetching for a specific party: fix any orders whose invoice was confirmed
    // but status was never updated to DELIVERED (e.g. historical invoices).
    if (partyId && enrichedData.length > 0) {
      const nonDeliveredIds = enrichedData
        .filter((o) => !['DELIVERED', 'CANCELLED'].includes(String(o.status || '')))
        .map((o) => String(o.id))
        .filter(Boolean)

      if (nonDeliveredIds.length > 0) {
        const { data: confirmedReqs } = await fetchAllInChunks(nonDeliveredIds, (chunk) =>
          supabaseAdmin
            .from('invoice_requests')
            .select('order_id')
            .in('order_id', chunk)
            .eq('status', 'CONFIRMED'))

        const deliveredOrderIds = new Set(
          ((confirmedReqs || []) as { order_id: string }[]).map((r) => r.order_id)
        )

        if (deliveredOrderIds.size > 0) {
          // Fix status in DB
          for (const chunk of chunkIds([...deliveredOrderIds])) {
            await supabaseAdmin
              .from('orders')
              .update({ status: 'DELIVERED' })
              .in('id', chunk)
          }

          // Fix status in response so UI is correct immediately
          enrichedData = enrichedData.map((o) =>
            deliveredOrderIds.has(String(o.id)) ? { ...o, status: 'DELIVERED' } : o
          )
        }
      }
    }

    return NextResponse.json({
      success: true,
      data: enrichedData,
      pagination: { page, limit, total: count || 0, pages: Math.ceil((count || 0) / limit) },
    })
  } catch (err) {
    console.error('[ORDERS GET] error:', err)
    const msg = err instanceof Error ? err.message : 'Failed to fetch orders'
    if (
      msg.includes('get_party_descendants') ||
      msg.includes('schema cache') ||
      msg.includes("Could not find the table 'public.")
    ) {
      const url = new URL(req.url)
      const page = parseInt(url.searchParams.get('page') || '1')
      const limit = parseInt(url.searchParams.get('limit') || '20')
      return NextResponse.json({
        success: true,
        data: [],
        pagination: { page, limit, total: 0, pages: 0 },
      })
    }
    return NextResponse.json(
      { success: false, message: msg },
      { status: 500 }
    )
  }
}

export async function POST(req: NextRequest) {
  let stage = 'init'
  try {
    stage = 'parse-body'
    const body = await req.json()
    const { buyer_id, items, delivery_date, notes, order_type, bill_discount_percent } = body

    if (!buyer_id || !items?.length) {
      return NextResponse.json(
        { success: false, message: 'buyer_id and items are required' },
        { status: 400 }
      )
    }

    // CRITICAL: Get authenticated user and resolve company scope for data isolation
    stage = 'auth-scope'
    const authUser = await getUserFromToken(req)
    if (!authUser) {
      return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 })
    }

    let companyId = await resolveCompanyScope(req, authUser)
    if (!companyId) companyId = authUser.party_id || null
    if (!companyId) {
      return NextResponse.json(
        { success: false, message: 'Company scope is required to create an order' },
        { status: 403 }
      )
    }

    // Validate buyer existence early to avoid opaque FK 500s.
    stage = 'buyer-exists'
    const { data: buyerExists, error: buyerErr } = await supabaseAdmin
      .from('parties')
      .select('id')
      .eq('id', buyer_id)
      .maybeSingle()
    if (buyerErr && !isSchemaCompatError(buyerErr)) throw buyerErr
    if (!buyerExists) {
      return NextResponse.json(
        { success: false, message: 'Selected party not found. Please refresh and re-select the party.' },
        { status: 400 }
      )
    }

    // Verify the party belongs to the user's company and is verified
    if (companyId) {
      stage = 'company-scope-check'
      let treeIds: string[] = []
      try {
        treeIds = (await getPartyDescendants(companyId)).map((r) => r.id)
      } catch {
        treeIds = []
      }
      if (!treeIds.includes(companyId)) treeIds.push(companyId)

      if (!treeIds.includes(buyer_id)) {
        return NextResponse.json({ success: false, message: 'Party not found or access denied' }, { status: 403 })
      }

      stage = 'party-verify-check'
      const { data: partyCheck, error: partyCheckErr } = await supabaseAdmin
        .from('parties')
        .select('is_verified')
        .eq('id', buyer_id)
        .maybeSingle()

      // New-project compatibility: if is_verified column doesn't exist, skip this guard.
      if (partyCheckErr && !isSchemaCompatError(partyCheckErr)) {
        throw partyCheckErr
      }
      if (partyCheck && partyCheck.is_verified === false) {
        return NextResponse.json({ success: false, message: 'Party must be verified before creating orders' }, { status: 400 })
      }
    }

    // Calculate totals with per-line discounts plus an optional order-wide bill
    // discount. The bill discount is allocated proportionally back into each
    // item so single-item and multi-item orders both show the discount on the
    // product rows themselves, not only at the final total.
    const round2 = (n: number) => Math.round((Number.isFinite(n) ? n : 0) * 100) / 100
    const baseComputedItems = (items as Array<{ quantity: number; unit_price: number; discount_percent?: number }>).map((i) => {
      const qty = Number(i.quantity) || 0
      const price = Number(i.unit_price) || 0
      const discountPercent = Math.min(Math.max(Number(i.discount_percent) || 0, 0), 100)
      const lineGross = round2(qty * price)
      const lineDiscount = round2(lineGross * (discountPercent / 100))
      const lineNetBeforeBill = round2(lineGross - lineDiscount)
      return { discountPercent, lineGross, lineDiscount, lineNetBeforeBill }
    })
    const subtotal = round2(baseComputedItems.reduce((sum, item) => sum + item.lineGross, 0))
    const lineDiscountTotal = round2(baseComputedItems.reduce((sum, item) => sum + item.lineDiscount, 0))
    const afterLineDiscount = round2(subtotal - lineDiscountTotal)
    const billDiscountPercent = Math.min(Math.max(Number(bill_discount_percent) || 0, 0), 100)
    const rawBillDiscount = round2(afterLineDiscount * (billDiscountPercent / 100))

    let allocatedBillDiscount = 0
    const computedItems = baseComputedItems.map((item, index) => {
      const isLastItem = index === baseComputedItems.length - 1
      const billDiscountShare = rawBillDiscount > 0
        ? (isLastItem
            ? round2(rawBillDiscount - allocatedBillDiscount)
            : round2(rawBillDiscount * (afterLineDiscount > 0 ? item.lineNetBeforeBill / afterLineDiscount : 0)))
        : 0
      allocatedBillDiscount = round2(allocatedBillDiscount + billDiscountShare)
      const lineDiscount = round2(item.lineDiscount + billDiscountShare)
      const lineNet = round2(Math.max(0, item.lineGross - lineDiscount))
      return { ...item, billDiscountShare, lineDiscount, lineNet }
    })

    const billDiscount = round2(computedItems.reduce((sum, item) => sum + item.billDiscountShare, 0))
    const discountTotal = round2(computedItems.reduce((sum, item) => sum + item.lineDiscount, 0))
    const grandTotal = round2(computedItems.reduce((sum, item) => sum + item.lineNet, 0))
    stage = 'order-insert'
    let order: { id: string } | null = null
    let orderInsertError: { code?: string; message?: string; details?: string } | null = null
    for (let attempt = 0; attempt < 8; attempt += 1) {
      stage = attempt === 0 ? 'order-number' : `order-number-retry-${attempt}`
      let order_number = 'ORD/WB/001'
      try {
        order_number = await generateNextOrderNumber(attempt)
      } catch {
        // Keep default fallback and continue insert attempt
      }

      const baseOrder = {
        order_number,
        order_type: order_type || 'STANDARD',
        subtotal,
        discount_amount: discountTotal,
        gst_amount: 0,
        grand_total: grandTotal,
        status: 'PENDING',
        payment_mode: 'CREDIT',
        payment_status: 'UNPAID',
        delivery_date: delivery_date || null,
        notes: notes || null,
        is_offline_created: false,
        ...((authUser?.id) ? { created_by: authUser.id } : {}),
      }

      const orderPayload: Record<string, unknown> = {
        ...baseOrder,
        buyer_id,
        billing_party_id: buyer_id, // backward-compat: old schema uses billing_party_id
        company_id: companyId || null,
        seller_id: companyId || null,
      }

      const { data, error } = await insertOrder(orderPayload)
      if (!error && data?.id) {
        order = data as { id: string }
        orderInsertError = null
        break
      }

      orderInsertError = (error as { code?: string; message?: string; details?: string } | null) || null
      if (isOrderNumberDuplicateError(orderInsertError)) {
        continue
      }
      throw error || new Error('Order was not created')
    }

    if (!order?.id) {
      if (isOrderNumberDuplicateError(orderInsertError)) {
        return NextResponse.json(
          { success: false, message: 'Could not generate a unique order number. Please retry.', stage },
          { status: 409 }
        )
      }
      throw orderInsertError || new Error('Order was not created')
    }

    // Insert order items
    const orderItemsPrimary = (items as Array<{ product_id: string; quantity: number; unit_price: number; discount_percent?: number }>).map((item, idx) => {
      const computed = computedItems[idx]
      return {
        order_id: order.id,
        product_id: item.product_id,
        quantity: item.quantity,
        unit_price: item.unit_price,
        line_total: computed.lineNet,
        discount_percent: computed.discountPercent,
        discount_amount: computed.lineDiscount,
        gst_amount: 0,
      }
    })

    stage = 'items-insert'
    const { error: itemsErr } = await insertOrderItems(orderItemsPrimary)
    if (itemsErr) throw itemsErr

    return NextResponse.json({ success: true, data: order }, { status: 201 })
  } catch (err) {
    console.error('[ORDERS POST] error at stage:', stage, err)
    let msg = 'Failed to create order'
    if (err instanceof Error) {
      msg = err.message || msg
    } else if (typeof err === 'object' && err !== null) {
      const e = err as Record<string, unknown>
      msg = String(e.message || e.details || e.hint || e.code || msg)
    }
    return NextResponse.json(
      { success: false, message: msg, stage },
      { status: 500 }
    )
  }
}
