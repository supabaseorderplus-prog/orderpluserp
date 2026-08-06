import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, getUserFromToken, resolveCompanyScope, getPartyDescendants } from '@/lib/supabase-server'
import { getPaidAmountsByRequestIds } from '@/lib/invoice-request-payments'
import { isInvoiceApprovalRequiredForParty } from '@/lib/invoice-approval-setting'
import { applyInvoiceConfirmedEffects } from '@/lib/invoice-confirm-effects'

function normalizeErrorMessage(err: unknown, fallback: string): string {
  if (!err) return fallback
  if (typeof err === 'string') return err
  if (err instanceof Error) {
    const msg = err.message
    if (msg && msg !== '[object Object]') return msg
  }
  if (typeof err === 'object') {
    const rec = err as Record<string, unknown>
    const nested = rec.message ?? rec.error_description ?? rec.error ?? rec.details ?? rec.hint
    if (typeof nested === 'string' && nested.trim() && nested !== '[object Object]') return nested
    if (nested && typeof nested === 'object') {
      try { return JSON.stringify(nested) } catch { /* noop */ }
    }
    const parts = [rec.code, rec.details, rec.hint].filter(Boolean).map(String)
    if (parts.length) return parts.join(' | ')
    try { return JSON.stringify(rec) } catch { /* noop */ }
  }
  return fallback
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const FALLBACK_PREFIX = 'SYSTEM_INVOICE_REQUEST::'

const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID_RE.test(value)

const getMissingFkColumn = (err: { detail?: string; message?: string } | null | undefined) => {
  if (!err) return null
  const detail = String(err.detail || err.message || '')
  const match = detail.match(/Key \(([^)]+)\)=\([^)]+\) is not present in table/i)
  return match?.[1] || null
}

function isInvoiceRequestSchemaError(message: string): boolean {
  return /invoice_requests/i.test(message) && (/does not exist|schema cache|not find/i.test(message))
}

function fallbackNoteKey(id: string) {
  return `${FALLBACK_PREFIX}${id}`
}

function parseFallbackNote(note: string | null): Record<string, unknown> | null {
  if (!note || !note.startsWith(FALLBACK_PREFIX)) return null
  const json = note.slice(FALLBACK_PREFIX.length)
  try {
    return JSON.parse(json) as Record<string, unknown>
  } catch {
    return null
  }
}

async function execSqlSafe(sql: string): Promise<boolean> {
  try {
    const { error } = await supabaseAdmin.rpc('exec_sql', { sql })
    return !error
  } catch {
    return false
  }
}

// Once the schema has been created/verified in this process, never re-run the
// (expensive, multi-statement) DDL. Reset only on process restart.
let invoiceSchemaEnsured = false
async function ensureInvoiceRequestsSchemaOnce(): Promise<void> {
  if (invoiceSchemaEnsured) return
  await ensureInvoiceRequestsSchema()
  invoiceSchemaEnsured = true
}

async function ensureInvoiceRequestsSchema(): Promise<void> {
  const statements = [
    `
    CREATE TABLE IF NOT EXISTS public.invoice_requests (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      order_id UUID NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
      lot_id TEXT,
      requested_by UUID NULL,
      party_id UUID NOT NULL REFERENCES public.parties(id) ON DELETE CASCADE,
      status VARCHAR(30) DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'CONFIRMED', 'REJECTED')),
      confirmed_at TIMESTAMP WITH TIME ZONE,
      confirmed_by UUID NULL,
      invoice_number TEXT,
      notes TEXT,
      company_id UUID NULL,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    )`,
    `ALTER TABLE public.invoice_requests ADD COLUMN IF NOT EXISTS company_id UUID`,
    `ALTER TABLE public.invoice_requests ADD COLUMN IF NOT EXISTS requested_by UUID`,
    `ALTER TABLE public.invoice_requests ADD COLUMN IF NOT EXISTS confirmed_by UUID`,
    `CREATE INDEX IF NOT EXISTS idx_invoice_requests_order_id ON public.invoice_requests(order_id)`,
    `CREATE INDEX IF NOT EXISTS idx_invoice_requests_party_id ON public.invoice_requests(party_id)`,
    `CREATE INDEX IF NOT EXISTS idx_invoice_requests_status ON public.invoice_requests(status)`,
    `CREATE INDEX IF NOT EXISTS idx_invoice_requests_company_id ON public.invoice_requests(company_id)`,
  ]

  let rpcOk = true
  for (const sql of statements) {
    const ok = await execSqlSafe(sql)
    rpcOk = rpcOk && ok
  }
  await execSqlSafe(`NOTIFY pgrst, 'reload schema'`)

  if (rpcOk) return

  const dbUrl = process.env.SUPABASE_DB_URL
  if (!dbUrl) return

  try {
    const pg = await import('pg')
    const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } })
    await client.connect()
    for (const sql of statements) {
      await client.query(sql)
    }
    await client.query(`NOTIFY pgrst, 'reload schema'`)
    await client.end()
  } catch (e) {
    console.error('[invoice-requests][schema-init] pg fallback failed:', e)
  }
}

async function hydrateOrdersForRequests(requests: Record<string, unknown>[]) {
  const orderIds = [...new Set(requests.map((row) => String(row.order_id || '')).filter(Boolean))]
  if (orderIds.length === 0) return requests.map((row) => ({ ...row, orders: null })) as Record<string, unknown>[]

  // Fetch orders — no embedded joins, matching the pattern used by the orders API.
  // Use select('*') (like orders/route.ts) instead of an explicit column list:
  // optional columns such as discount_amount / gst_amount / buyer_id do NOT exist
  // on every deployment, and a single missing column makes the WHOLE select fail
  // (Postgres 42703). When that happened, ordersData stayed empty, every request
  // got `orders: null`, and the payments UI showed grand_total ₹0 / status PAID —
  // making confirmed invoices uncollectable. select('*') can't fail on a missing
  // optional column, so the real grand_total always comes through.
  let ordersData: Record<string, unknown>[] = []
  {
    const { data, error } = await supabaseAdmin
      .from('orders')
      .select('*')
      .in('id', orderIds)

    if (!error && data) {
      ordersData = data as Record<string, unknown>[]
    } else {
      // Last-resort minimal select of columns guaranteed to exist on every schema
      const { data: fallback } = await supabaseAdmin
        .from('orders')
        .select('id, order_number, grand_total, subtotal, order_status, created_at, billing_party_id')
        .in('id', orderIds)
      ordersData = (fallback || []) as Record<string, unknown>[]
    }
  }

  // Fetch order_items separately (same pattern as orders/route.ts)
  const itemsByOrderId = new Map<string, Record<string, unknown>[]>()
  if (orderIds.length > 0) {
    const { data: itemRows } = await supabaseAdmin
      .from('order_items')
      .select('id, order_id, product_id, quantity, unit_price, discount_percent, discount_amount, gst_rate, line_total, products(name, sku, unit_of_measure)')
      .in('order_id', orderIds)

    for (const item of (itemRows || []) as Array<{ order_id: string } & Record<string, unknown>>) {
      const key = item.order_id
      const list = itemsByOrderId.get(key) || []
      list.push(item)
      itemsByOrderId.set(key, list)
    }
  }

  // Collect all party IDs for buyer hydration
  const partyIds = [...new Set(
    ordersData.flatMap((o) => [
      o.buyer_id as string | null,
      o.billing_party_id as string | null,
    ]).filter((id): id is string => Boolean(id))
  )]

  const buyersById = new Map<string, Record<string, unknown>>()
  if (partyIds.length > 0) {
    // No embedded joins — party_types(name) can fail if FK not in schema cache
    const { data: partiesData } = await supabaseAdmin
      .from('parties')
      .select('id, name, party_code, gstin, address_line1, city, party_type_id')
      .in('id', partyIds)

    for (const p of (partiesData || []) as Record<string, unknown>[]) {
      buyersById.set(String(p.id), p)
    }
  }

  const ordersById = new Map<string, unknown>()
  for (const row of ordersData) {
    const buyerId = (row.buyer_id as string | null) || (row.billing_party_id as string | null) || ''
    ordersById.set(String(row.id), {
      ...row,
      buyer: buyerId ? (buyersById.get(buyerId) || null) : null,
      order_items: itemsByOrderId.get(String(row.id)) || [],
    })
  }

  // Hydrate per-invoice partial payments. Request-based invoices are paid through
  // their own ledger (invoice_request_payments) since they aren't rows in the
  // invoices table — fold those allocations back in so the UI shows the true
  // outstanding and a PARTIAL / PAID status instead of always the full grand_total.
  const requestIds = requests.map((row) => String(row.id || '')).filter(Boolean)
  const paidByRequestId = await getPaidAmountsByRequestIds(requestIds)

  return requests.map((row) => {
    const order = ordersById.get(String(row.order_id || '')) as Record<string, unknown> | undefined
    const grandTotal = Number((order?.grand_total as number) || 0)
    const amountPaid = paidByRequestId.get(String(row.id || '')) || 0
    const amountOutstanding = Math.max(0, grandTotal - amountPaid)
    const paymentStatus =
      amountPaid <= 0 ? 'UNPAID' : amountOutstanding <= 0 ? 'PAID' : 'PARTIAL'

    return {
      ...row,
      orders: order
        ? { ...order, amount_paid: amountPaid, amount_outstanding: amountOutstanding, payment_status: paymentStatus }
        : null,
      amount_paid: amountPaid,
      amount_outstanding: amountOutstanding,
      payment_status: paymentStatus,
    }
  }) as Record<string, unknown>[]
}

async function resolveInvoiceRequestPartyIds(partyId: string | null): Promise<string[] | null> {
  if (!partyId) return null

  try {
    const descendants = await getPartyDescendants(partyId)
    const ids = descendants.map((row) => row.id).filter(Boolean)
    if (!ids.includes(partyId)) ids.unshift(partyId)
    return [...new Set(ids)]
  } catch {
    const seen = new Set([partyId])
    let frontier = [partyId]

    for (let depth = 0; frontier.length > 0 && depth < 10; depth += 1) {
      const { data: children } = await supabaseAdmin
        .from('parties')
        .select('id')
        .in('parent_party_id', frontier)

      const next = (children || [])
        .map((p) => p.id)
        .filter((id): id is string => Boolean(id) && !seen.has(id))

      next.forEach((id) => seen.add(id))
      frontier = next
    }

    return [...seen]
  }
}

async function loadFallbackRequests(companyId: string | null, partyIds: string[] | null, status: string | null) {
  let query = supabaseAdmin
    .from('company_notes')
    .select('id, company_id, note, created_at, updated_at')
    .like('note', `${FALLBACK_PREFIX}%`)
    .order('created_at', { ascending: false })
    .limit(500)

  // When partyIds is set (party-user query), skip the DB-level company_id filter.
  // The invoice was created under the admin's company_id which differs from the party's
  // party_id. Filter in-memory by party_id (below) instead.
  if (companyId && !partyIds?.length) query = query.eq('company_id', companyId)

  const { data, error } = await query
  if (error) throw error

  let rows = (data || [])
    .map((row) => {
      const parsed = parseFallbackNote((row as { note?: string | null }).note || null)
      if (!parsed) return null
      return {
        id: String(parsed.id || (row as { id?: string }).id || ''),
        order_id: String(parsed.order_id || ''),
        party_id: String(parsed.party_id || ''),
        lot_id: parsed.lot_id ? String(parsed.lot_id) : null,
        requested_by: parsed.requested_by ? String(parsed.requested_by) : null,
        status: String(parsed.status || 'PENDING'),
        invoice_number: String(parsed.invoice_number || ''),
        notes: parsed.notes ? String(parsed.notes) : null,
        company_id: parsed.company_id ? String(parsed.company_id) : ((row as { company_id?: string }).company_id || null),
        created_at: String(parsed.created_at || (row as { created_at?: string }).created_at || new Date().toISOString()),
        updated_at: String(parsed.updated_at || (row as { updated_at?: string }).updated_at || new Date().toISOString()),
        confirmed_at: parsed.confirmed_at ? String(parsed.confirmed_at) : null,
        confirmed_by: parsed.confirmed_by ? String(parsed.confirmed_by) : null,
      }
    })
    .filter(Boolean) as Record<string, unknown>[]

  if (partyIds?.length) {
    const allowed = new Set(partyIds)
    rows = rows.filter((row) => allowed.has(String(row.party_id || '')))
  }
  if (status) rows = rows.filter((row) => String(row.status || '') === status)

  return hydrateOrdersForRequests(rows)
}

async function saveFallbackRequest(request: Record<string, unknown>) {
  const fallbackId = String(request.id || crypto.randomUUID())
  const normalized = {
    ...request,
    id: fallbackId,
    created_at: request.created_at || new Date().toISOString(),
    updated_at: request.updated_at || new Date().toISOString(),
  }

  const { error } = await supabaseAdmin
    .from('company_notes')
    .insert({
      company_id: normalized.company_id || null,
      note: fallbackNoteKey(JSON.stringify(normalized)),
      created_by: normalized.requested_by || null,
    })

  if (error) throw error
  return normalized
}

async function buildInvoiceRequestPayload(
  order_id: string,
  party_id: string,
  lot_id: string | null,
  notes: string | null,
  authUser: Awaited<ReturnType<typeof getUserFromToken>>,
  companyId: string | null,
  useFallbackNumbering = false,
) {
  // These three lookups are independent — fetch the order, the party, and any
  // existing invoice request concurrently instead of one after another.
  const [orderRes, partyRes, existingRes] = await Promise.all([
    supabaseAdmin.from('orders').select('id, buyer_id, billing_party_id').eq('id', order_id).maybeSingle(),
    supabaseAdmin.from('parties').select('id').eq('id', party_id).maybeSingle(),
    supabaseAdmin.from('invoice_requests').select('id, status').eq('order_id', order_id).maybeSingle(),
  ])

  let orderBuyerId: string | null = null
  let orderBillingPartyId: string | null = null
  if (!orderRes.error && orderRes.data?.id) {
    orderBuyerId = (orderRes.data as Record<string, unknown>).buyer_id as string | null
    orderBillingPartyId = (orderRes.data as Record<string, unknown>).billing_party_id as string | null
  } else {
    // orders may lack buyer_id on legacy schemas — confirm existence with a minimal select.
    const { data: orderBasic } = await supabaseAdmin
      .from('orders')
      .select('id, billing_party_id')
      .eq('id', order_id)
      .maybeSingle()
    if (!orderBasic?.id) {
      return NextResponse.json({ success: false, message: 'Order not found.' }, { status: 400 })
    }
    orderBillingPartyId = (orderBasic as Record<string, unknown>).billing_party_id as string | null
  }

  const partyRow = partyRes.data

  const canonicalPartyId: string | null =
    partyRow?.id ||
    (isUuid(orderBuyerId) ? orderBuyerId : null) ||
    (isUuid(orderBillingPartyId) ? orderBillingPartyId : null)

  if (!canonicalPartyId) {
    return NextResponse.json(
      { success: false, message: 'Unable to create invoice request: no valid party linked to this order.' },
      { status: 400 }
    )
  }

  // existing check may error if the table is missing — treat that as "no existing".
  const existing = existingRes.error ? null : existingRes.data

  if (existing) {
    return NextResponse.json({
      success: false,
      message: `Invoice request already exists (status: ${existing.status})`,
    }, { status: 409 })
  }

  let invoiceNumber = 'INV/001'
  if (!useFallbackNumbering) {
    let maxSeq = 0
    const seqQuery = companyId
      ? supabaseAdmin.from('invoice_requests').select('invoice_number').eq('company_id', companyId).order('created_at', { ascending: false }).limit(100)
      : supabaseAdmin.from('invoice_requests').select('invoice_number').order('created_at', { ascending: false }).limit(100)
    const { data: seqRows } = await seqQuery
    for (const row of (seqRows || []) as { invoice_number?: string }[]) {
      const match = String(row.invoice_number || '').match(/INV\/(\d+)$/)
      if (match) {
        const value = parseInt(match[1], 10)
        if (value > maxSeq) maxSeq = value
      }
    }
    invoiceNumber = `INV/${String(maxSeq + 1).padStart(3, '0')}`
  } else {
    const fallbackRows = await loadFallbackRequests(companyId, null, null)
    const fallbackExisting = fallbackRows.find((row) => String(row.order_id || '') === order_id)
    if (fallbackExisting) {
      return NextResponse.json({
        success: false,
        message: `Invoice request already exists (status: ${String(fallbackExisting.status || 'PENDING')})`,
      }, { status: 409 })
    }
    let maxSeq = 0
    for (const row of fallbackRows) {
      const match = String(row.invoice_number || '').match(/INV\/(\d+)$/)
      if (match) {
        const value = parseInt(match[1], 10)
        if (value > maxSeq) maxSeq = value
      }
    }
    invoiceNumber = `INV/${String(maxSeq + 1).padStart(3, '0')}`
  }

  const actorId = isUuid(authUser?.app_user_id) ? authUser.app_user_id : null
  const now = new Date().toISOString()

  return {
    order_id,
    party_id: canonicalPartyId,
    lot_id: lot_id || null,
    requested_by: actorId,
    status: 'PENDING',
    confirmed_at: null,
    confirmed_by: null,
    invoice_number: invoiceNumber,
    notes: notes || null,
    company_id: companyId || null,
    created_at: now,
    updated_at: now,
  }
}

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url)
    const partyId = url.searchParams.get('party_id')
    const status = url.searchParams.get('status')
    const limit = parseInt(url.searchParams.get('limit') || '50')

    const authUser = await getUserFromToken(req)
    const companyId = await resolveCompanyScope(req, authUser)
    const partyIds = await resolveInvoiceRequestPartyIds(partyId)

    // Fetch invoice_requests without the fragile FK-hint join — hydrate orders separately
    let baseQuery = supabaseAdmin
      .from('invoice_requests')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit)

    if (partyIds?.length) {
      baseQuery = baseQuery.in('party_id', partyIds)
    } else if (companyId) {
      baseQuery = baseQuery.eq('company_id', companyId)
    }
    if (status) baseQuery = baseQuery.eq('status', status)

    let { data, error } = await baseQuery

    if (error && String(error.message || '').includes('company_id')) {
      // company_id column may not exist yet — retry without company filter
      let legacyQuery = supabaseAdmin
        .from('invoice_requests')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(limit)
      if (partyIds?.length) legacyQuery = legacyQuery.in('party_id', partyIds)
      if (status) legacyQuery = legacyQuery.eq('status', status)
      const legacy = await legacyQuery
      data = legacy.data
      error = legacy.error
    }

    if (error) {
      const msg = String(error.message || '')
      if (isInvoiceRequestSchemaError(msg)) {
        await ensureInvoiceRequestsSchemaOnce()
        const fallbackRows = await loadFallbackRequests(companyId, partyIds, status)
        return NextResponse.json({ success: true, data: fallbackRows })
      }
      throw error
    }

    // Secondary lookup: if party-scoped query found nothing, also search by order membership
    // (handles cases where invoice_request.party_id doesn't match app_users.party_id exactly)
    if ((!data || data.length === 0) && partyIds?.length) {
      try {
        const [{ data: byBuyer }, { data: byBilling }] = await Promise.all([
          supabaseAdmin.from('orders').select('id').in('buyer_id', partyIds).limit(200),
          supabaseAdmin.from('orders').select('id').in('billing_party_id', partyIds).limit(200),
        ])
        const orderIds = [...new Set([
          ...((byBuyer || []) as { id: string }[]).map(o => o.id),
          ...((byBilling || []) as { id: string }[]).map(o => o.id),
        ])].filter(Boolean)

        if (orderIds.length > 0) {
          let secQuery = supabaseAdmin
            .from('invoice_requests')
            .select('*')
            .in('order_id', orderIds)
            .order('created_at', { ascending: false })
            .limit(limit)
          if (status) secQuery = secQuery.eq('status', status)
          const secResult = await secQuery
          if (secResult.data && secResult.data.length > 0) {
            data = secResult.data
          }
        }
      } catch {
        // Secondary lookup is best-effort; swallow and return the empty primary result
      }
    }

    // Hydrate full order + buyer + items for every request
    const hydrated = await hydrateOrdersForRequests((data || []) as Record<string, unknown>[])
    return NextResponse.json({ success: true, data: hydrated })
  } catch (err) {
    console.error('[invoice-requests][GET] failed:', err)
    const msg = normalizeErrorMessage(err, 'Failed to fetch invoice requests')
    if (isInvoiceRequestSchemaError(msg)) {
      const authUser = await getUserFromToken(req).catch(() => null)
      const companyId = await resolveCompanyScope(req, authUser).catch(() => null)
      const url = new URL(req.url)
      const partyId = url.searchParams.get('party_id')
      const status = url.searchParams.get('status')
      const partyIds = await resolveInvoiceRequestPartyIds(partyId).catch(() => partyId ? [partyId] : null)
      const fallbackRows = await loadFallbackRequests(companyId, partyIds, status)
      return NextResponse.json({ success: true, data: fallbackRows })
    }
    return NextResponse.json(
      { success: false, message: msg },
      { status: 500 }
    )
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { order_id, party_id, lot_id, notes } = body

    if (!order_id || !party_id) {
      return NextResponse.json({ success: false, message: 'order_id and party_id are required' }, { status: 400 })
    }

    const authUser = await getUserFromToken(req)
    const companyId = await resolveCompanyScope(req, authUser)
    // The dedicated WhatsApp action explicitly requests party confirmation even
    // when that party normally has auto-confirm enabled. Only authenticated staff
    // may force this; party/public callers cannot change approval policy.
    const forcePartyApproval = body.force_party_approval === true && !!authUser && ![
      'PARTY', 'RETAILER', 'DEALER', 'DISTRIBUTOR', 'CNF',
    ].includes(String(authUser.role || '').toUpperCase())

    // Per-party kill switch: when this party's approval is OFF, the invoice is
    // auto-confirmed (generated immediately) instead of waiting on the party.
    // The decision is keyed on the party the invoice is actually issued to,
    // resolved inside buildInvoiceRequestPayload (built.party_id).

    // NOTE: schema creation is intentionally NOT run on the happy path — the table
    // already exists in normal operation. It is created lazily only if an insert
    // fails with a schema error (see the catch below), saving ~8 DDL round-trips per call.

    const createInvoiceRequest = async () => {
      const built = await buildInvoiceRequestPayload(order_id, party_id, lot_id || null, notes || null, authUser, companyId)
      if (built instanceof NextResponse) return built

      const invoicePartyId = String(built.party_id || '') || null
      const autoConfirm = !forcePartyApproval && !(await isInvoiceApprovalRequiredForParty(invoicePartyId))
      const successMessage = autoConfirm
        ? 'Invoice generated successfully'
        : 'Invoice request initiated successfully'

      const insertPayload: Record<string, unknown> = {
        ...built,
        status: autoConfirm ? 'CONFIRMED' : 'PENDING',
        confirmed_at: autoConfirm ? built.created_at : null,
        confirmed_by: autoConfirm ? built.requested_by : null,
      }
      const optionalCols = ['requested_by', 'company_id', 'lot_id', 'notes', 'confirmed_by', 'confirmed_at']
      let insertedRow: unknown = null
      let lastErrMsg = ''
      let lastErrCode = ''
      let lastErrDetails = ''
      let failed = false

      for (let attempt = 0; attempt <= optionalCols.length; attempt += 1) {
        const { data, error } = await supabaseAdmin
          .from('invoice_requests')
          .insert(insertPayload)
          .select()
          .single()

        if (!error) { insertedRow = data; break }
        lastErrCode = error.code ?? ''
        lastErrMsg = error.message ?? ''
        lastErrDetails = error.details ?? ''
        failed = true

        if (lastErrCode === '23503') {
          const fkCol = getMissingFkColumn({ detail: lastErrDetails, message: lastErrMsg })
          if (fkCol && fkCol in insertPayload && optionalCols.includes(fkCol)) {
            delete insertPayload[fkCol]
            continue
          }
        }

        if (lastErrCode === '42703' || lastErrMsg.includes('column')) {
          if ('confirmed_by' in insertPayload) { delete insertPayload.confirmed_by; continue }
          if ('confirmed_at' in insertPayload) { delete insertPayload.confirmed_at; continue }
          if ('company_id' in insertPayload) { delete insertPayload.company_id; continue }
          if ('requested_by' in insertPayload) { delete insertPayload.requested_by; continue }
        }

        throw new Error(lastErrMsg || 'Failed to create invoice request')
      }

      if (failed && !insertedRow) throw new Error(lastErrMsg || 'Failed to create invoice request')

      // Auto-confirm path: run the same side-effects as a manual party confirm
      // (walk the order to DELIVERED, recompute the party's invoice-scheme bar).
      if (autoConfirm) {
        await applyInvoiceConfirmedEffects(
          String(built.order_id || '') || null,
          String(built.party_id || '') || null,
          (built.company_id as string | null) ?? null,
          '[invoice-autoconfirm]',
        )
      }

      return NextResponse.json({
        success: true,
        data: insertedRow,
        message: successMessage,
      }, { status: 201 })
    }

    try {
      return await createInvoiceRequest()
    } catch (err) {
      const msg = normalizeErrorMessage(err, 'Failed to initiate invoice request')
      if (isInvoiceRequestSchemaError(msg)) {
        // Table/columns missing — create the schema now (once per process) and retry
        // the real insert before falling back to company_notes storage.
        await ensureInvoiceRequestsSchemaOnce()
        try {
          return await createInvoiceRequest()
        } catch (retryErr) {
          const retryMsg = normalizeErrorMessage(retryErr, 'Failed to initiate invoice request')
          if (!isInvoiceRequestSchemaError(retryMsg)) throw retryErr
          // Still unusable after schema creation — fall back to company_notes.
          const built = await buildInvoiceRequestPayload(order_id, party_id, lot_id || null, notes || null, authUser, companyId, true)
          if (built instanceof NextResponse) return built

          const invoicePartyId = String(built.party_id || '') || null
          const autoConfirm = !forcePartyApproval && !(await isInvoiceApprovalRequiredForParty(invoicePartyId))
          if (autoConfirm) {
            built.status = 'CONFIRMED'
            built.confirmed_at = built.created_at
            built.confirmed_by = built.requested_by
          }

          const saved = await saveFallbackRequest(built)
          if (autoConfirm) {
            await applyInvoiceConfirmedEffects(
              String(built.order_id || '') || null,
              invoicePartyId,
              (built.company_id as string | null) ?? null,
              '[invoice-autoconfirm][fallback]',
            )
          }
          return NextResponse.json({
            success: true,
            data: saved,
            message: autoConfirm ? 'Invoice generated successfully' : 'Invoice request initiated successfully',
          }, { status: 201 })
        }
      }
      throw err
    }
  } catch (err) {
    console.error('[invoice-requests][POST] failed:', err)
    const msg = normalizeErrorMessage(err, 'Failed to initiate invoice request')
    if (/foreign key|violates/i.test(msg)) {
      return NextResponse.json(
        { success: false, message: 'Unable to create invoice request due to invalid linked records.' },
        { status: 400 }
      )
    }
    return NextResponse.json(
      { success: false, message: msg },
      { status: 400 }
    )
  }
}
