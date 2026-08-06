import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, getUserFromToken, resolveCompanyScope } from '@/lib/supabase-server'
import { runDirectSql, executeDirectSql } from '@/lib/direct-sql'
import {
  createFallbackDeliveryLot,
  deleteFallbackDeliveryLot,
  listFallbackDeliveryLots,
  updateFallbackDeliveryLot,
  type DeliveryLotFallbackRecord,
} from '@/lib/delivery-lots-fallback'

const DELIVERY_LOTS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS public.delivery_lots (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lot_number    text NOT NULL,
  name          text NOT NULL DEFAULT '',
  status        text NOT NULL DEFAULT 'OPEN',
  dispatch_date date,
  destination   text DEFAULT '',
  vehicle_no    text DEFAULT '',
  notes         text DEFAULT '',
  driver_id     uuid,
  driver_name   text DEFAULT '',
  company_id    uuid,
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.delivery_lots ADD COLUMN IF NOT EXISTS name text NOT NULL DEFAULT '';
ALTER TABLE public.delivery_lots ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'OPEN';
ALTER TABLE public.delivery_lots ADD COLUMN IF NOT EXISTS dispatch_date date;
ALTER TABLE public.delivery_lots ADD COLUMN IF NOT EXISTS destination text DEFAULT '';
ALTER TABLE public.delivery_lots ADD COLUMN IF NOT EXISTS vehicle_no text DEFAULT '';
ALTER TABLE public.delivery_lots ADD COLUMN IF NOT EXISTS notes text DEFAULT '';
ALTER TABLE public.delivery_lots ADD COLUMN IF NOT EXISTS driver_id uuid;
ALTER TABLE public.delivery_lots ADD COLUMN IF NOT EXISTS driver_name text DEFAULT '';
ALTER TABLE public.delivery_lots ADD COLUMN IF NOT EXISTS company_id uuid;
ALTER TABLE public.delivery_lots ADD COLUMN IF NOT EXISTS created_by uuid;
ALTER TABLE public.delivery_lots ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.delivery_lots ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS public.delivery_lot_orders (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lot_id               uuid NOT NULL REFERENCES public.delivery_lots(id) ON DELETE CASCADE,
  order_id             uuid NOT NULL,
  invoice_number       text DEFAULT '',
  party_name           text DEFAULT '',
  grand_total          numeric DEFAULT 0,
  manufacturing_status text DEFAULT 'Not Started',
  created_at           timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.delivery_lot_orders ADD COLUMN IF NOT EXISTS invoice_number text DEFAULT '';
ALTER TABLE public.delivery_lot_orders ADD COLUMN IF NOT EXISTS party_name text DEFAULT '';
ALTER TABLE public.delivery_lot_orders ADD COLUMN IF NOT EXISTS grand_total numeric DEFAULT 0;
ALTER TABLE public.delivery_lot_orders ADD COLUMN IF NOT EXISTS manufacturing_status text DEFAULT 'Not Started';
ALTER TABLE public.delivery_lot_orders ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

CREATE UNIQUE INDEX IF NOT EXISTS delivery_lot_orders_lot_order_idx
  ON public.delivery_lot_orders(lot_id, order_id);

CREATE INDEX IF NOT EXISTS delivery_lots_company_created_idx
  ON public.delivery_lots(company_id, created_at DESC);

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.delivery_lots;
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN undefined_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.delivery_lot_orders;
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN undefined_object THEN NULL;
END $$;

NOTIFY pgrst, 'reload schema';
`

// Only the columns the DeliveryLot shape below actually renders. `select('*')` here
// was pulling every column of every lot plus every linked order row on a hot path,
// and lot lists are polled — narrow selects keep Supabase egress off the free-tier cap.
const LOT_COLUMNS = 'id, lot_number, name, dispatch_date, destination, vehicle_no, notes, status, driver_id, driver_name, created_at, updated_at'
const LOT_ORDER_COLUMNS = 'lot_id, order_id, invoice_number, party_name, grand_total, manufacturing_status'

const ensureDeliveryLotsSchema = async () => {
  try {
    const { error } = await supabaseAdmin.rpc('exec_sql', { sql: DELIVERY_LOTS_SCHEMA_SQL })
    if (!error) return true
    console.warn('[delivery-lots] exec_sql schema setup failed:', error.message)
  } catch (err) {
    console.warn('[delivery-lots] exec_sql unavailable:', err instanceof Error ? err.message : err)
  }

  return runDirectSql(DELIVERY_LOTS_SCHEMA_SQL)
}

let schemaEnsureInFlight: Promise<boolean> | null = null
let dedicatedTablesUnavailableUntil = 0

const shouldUseCloudFallback = () => Date.now() < dedicatedTablesUnavailableUntil
const markDedicatedTablesUnavailable = () => {
  dedicatedTablesUnavailableUntil = Date.now() + 5 * 60_000
}

const ensureDeliveryLotsSchemaOnce = async () => {
  if (schemaEnsureInFlight) return schemaEnsureInFlight
  schemaEnsureInFlight = ensureDeliveryLotsSchema().finally(() => {
    schemaEnsureInFlight = null
  })
  return schemaEnsureInFlight
}

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

const isMissingSchemaObject = (err: { code?: string; message?: string } | null | undefined) =>
  !!err && (
    err.code === 'PGRST205' ||
    err.code === 'PGRST200' ||
    err.code === 'PGRST204' ||
    err.code === '42P01' ||
    (err.message || '').includes('schema cache') ||
    (err.message || '').includes("Could not find the table 'public.")
  )

const isMissingColumnError = (err: { code?: string; message?: string } | null | undefined) =>
  !!err && (
    err.code === '42703' ||
    !!getMissingColumn(err)
  )

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function withSchemaCacheRetry<T>(run: () => Promise<T>, shouldRetry: (value: T) => boolean): Promise<T> {
  let last = await run()
  if (!shouldRetry(last)) return last

  const schemaReady = await ensureDeliveryLotsSchemaOnce()
  if (!schemaReady) return last

  for (const delayMs of [250, 700, 1500]) {
    await sleep(delayMs)
    last = await run()
    if (!shouldRetry(last)) return last
  }

  return last
}

const insertLotOrdersWithCompat = async (
  lotId: string,
  orderIds: string[],
  orderMeta: Record<string, { invoice_number?: string; party_name?: string; grand_total?: number }> | undefined,
  manufacturingStatuses: Record<string, string> | undefined,
) => {
  const rows = orderIds.map((orderId) => ({
    lot_id: lotId,
    order_id: orderId,
    invoice_number: orderMeta?.[orderId]?.invoice_number || '',
    party_name: orderMeta?.[orderId]?.party_name || '',
    grand_total: orderMeta?.[orderId]?.grand_total || 0,
    manufacturing_status: manufacturingStatuses?.[orderId] || 'Not Started',
  }))

  const result = await supabaseAdmin
    .from('delivery_lot_orders')
    .insert(rows)

  if (!result.error) return result

  if (
    result.error.code === '42703' ||
    result.error.code === 'PGRST204' ||
    result.error.code === 'PGRST205'
  ) {
    const minimalRows = orderIds.map((orderId) => ({
      lot_id: lotId,
      order_id: orderId,
    }))

    return supabaseAdmin
      .from('delivery_lot_orders')
      .insert(minimalRows)
  }

  return result
}

const syncOrdersToProcurement = async (orderIds: string[]) => {
  if (orderIds.length === 0) return

  const attempts: Record<string, string>[] = [
    { status: 'IN_PROCUREMENT', order_status: 'IN_PROCUREMENT' },
    { status: 'IN_PROCUREMENT' },
    { order_status: 'IN_PROCUREMENT' },
    { status: 'PROCUREMENT', order_status: 'PROCUREMENT' },
    { status: 'PROCUREMENT' },
    { order_status: 'PROCUREMENT' },
  ]

  let lastError: unknown = null

  for (const payload of attempts) {
    const { error } = await supabaseAdmin
      .from('orders')
      .update(payload)
      .in('id', orderIds)

    if (!error) return

    lastError = error
    const missingColumn = getMissingColumn(error)
    const canTryNext =
      error.code === '22P02' ||
      error.code === '42703' ||
      error.code === 'PGRST204' ||
      (missingColumn && (missingColumn === 'status' || missingColumn === 'order_status'))

    if (!canTryNext) break
  }

  throw lastError
}


function sqlString(value: string | null | undefined): string {
  if (value == null) return 'NULL'
  return "'" + value.replace(/'/g, "''") + "'"
}

function sqlUuid(value: string | null | undefined): string {
  return value ? sqlString(value) : 'NULL'
}

function sqlNumber(value: number | null | undefined): string {
  return Number.isFinite(value) ? String(value) : '0'
}

type DirectLotRow = {
  id: string
  lot_number: string
  name: string | null
  dispatch_date: string | null
  destination: string | null
  vehicle_no: string | null
  notes: string | null
  status: string | null
  driver_id: string | null
  driver_name: string | null
  created_at: string
  updated_at: string
  company_id: string | null
  created_by: string | null
}

type DirectLotOrderRow = {
  lot_id: string | null
  order_id: string | null
  invoice_number: string | null
  party_name: string | null
  grand_total: string | number | null
  manufacturing_status: string | null
}

async function listLotsDirect(params: { companyId: string | null; status: string | null; includeOrphansOnly: boolean }) {
  const where: string[] = []
  if (params.includeOrphansOnly) where.push('l.company_id IS NULL')
  else if (params.companyId) where.push(`l.company_id = ${sqlUuid(params.companyId)}`)
  if (params.status) where.push(`l.status = ${sqlString(params.status)}`)
  const sql = `
    SELECT
      l.id,
      l.lot_number,
      l.name,
      l.dispatch_date::text as dispatch_date,
      l.destination,
      l.vehicle_no,
      l.notes,
      l.status,
      l.driver_id::text as driver_id,
      l.driver_name,
      l.created_at::text as created_at,
      l.updated_at::text as updated_at,
      l.company_id::text as company_id,
      l.created_by::text as created_by,
      o.lot_id::text as lot_id,
      o.order_id::text as order_id,
      o.invoice_number,
      o.party_name,
      o.grand_total,
      o.manufacturing_status
    FROM public.delivery_lots l
    LEFT JOIN public.delivery_lot_orders o ON o.lot_id = l.id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY l.created_at DESC, o.created_at ASC NULLS LAST
  `
  return await executeDirectSql<(DirectLotRow & DirectLotOrderRow)>(sql)
}

async function createLotDirect(input: {
  lotNumber: string
  name: string
  dispatchDate: string | null
  destination: string
  vehicleNo: string
  notes: string
  driverId: string | null
  driverName: string
  companyId: string | null
  createdBy: string | null
  orderIds: string[]
  orderMeta?: Record<string, { invoice_number?: string; party_name?: string; grand_total?: number }>
  manufacturingStatuses?: Record<string, string>
}) {
  const insertLotSql = `
    INSERT INTO public.delivery_lots (
      lot_number, name, dispatch_date, destination, vehicle_no, notes, status, driver_id, driver_name, company_id, created_by
    ) VALUES (
      ${sqlString(input.lotNumber)},
      ${sqlString(input.name)},
      ${sqlString(input.dispatchDate) === 'NULL' ? 'NULL' : `${sqlString(input.dispatchDate)}::date`},
      ${sqlString(input.destination)},
      ${sqlString(input.vehicleNo)},
      ${sqlString(input.notes)},
      'OPEN',
      ${sqlUuid(input.driverId)},
      ${sqlString(input.driverName)},
      ${sqlUuid(input.companyId)},
      ${sqlUuid(input.createdBy)}
    )
    RETURNING id, lot_number, name, dispatch_date::text as dispatch_date, destination, vehicle_no, notes, status, driver_id::text as driver_id, driver_name, created_at::text as created_at, updated_at::text as updated_at, company_id::text as company_id, created_by::text as created_by
  `
  const lotRows = await executeDirectSql<DirectLotRow>(insertLotSql)
  const lot = lotRows?.[0]
  if (!lot) return null

  if (input.orderIds.length > 0) {
    const values = input.orderIds.map((orderId) => `(
      ${sqlUuid(lot.id)},
      ${sqlUuid(orderId)},
      ${sqlString(input.orderMeta?.[orderId]?.invoice_number || '')},
      ${sqlString(input.orderMeta?.[orderId]?.party_name || '')},
      ${sqlNumber(Number(input.orderMeta?.[orderId]?.grand_total || 0))},
      ${sqlString(input.manufacturingStatuses?.[orderId] || 'Not Started')}
    )`).join(',\n')
    const insertOrdersSql = `
      INSERT INTO public.delivery_lot_orders (
        lot_id, order_id, invoice_number, party_name, grand_total, manufacturing_status
      ) VALUES ${values}
    `
    const inserted = await runDirectSql(insertOrdersSql)
    if (!inserted) {
      await runDirectSql(`DELETE FROM public.delivery_lots WHERE id = ${sqlUuid(lot.id)}`)
      return null
    }
  }

  return lot
}

const insertLotWithCompat = async (payload: Record<string, unknown>) => {
  const optionalColumns = new Set([
    'company_id',
    'created_by',
    'driver_id',
    'driver_name',
    'destination',
    'vehicle_no',
    'notes',
    'dispatch_date',
    'name',
    'status',
  ])
  const enumLikeColumns = ['status']
  const current = { ...payload }
  let enumFallbackTried = false

  for (let attempt = 0; attempt < optionalColumns.size + 3; attempt += 1) {
    const result = await supabaseAdmin
      .from('delivery_lots')
      .insert(current)
      .select()
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

    if (result.error.code === '23505' && typeof current.lot_number === 'string') {
      current.lot_number = `${current.lot_number}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`
      continue
    }

    return result
  }

  return supabaseAdmin
    .from('delivery_lots')
    .insert(current)
    .select()
    .single()
}

export async function GET(req: NextRequest) {
  try {
    const authUser = await getUserFromToken(req)
    const companyId = await resolveCompanyScope(req, authUser)
    const isSuperAdmin = authUser?.role === 'SUPER_ADMIN'

    // Fail-closed: non-super-admin users with no resolved company scope see nothing.
    if (!companyId && !isSuperAdmin) {
      return NextResponse.json({ success: true, data: [] })
    }

    const url = new URL(req.url)
    const status = url.searchParams.get('status')

    if (shouldUseCloudFallback()) {
      const fallbackLots = await listFallbackDeliveryLots(companyId, status)
      return NextResponse.json({ success: true, data: fallbackLots, source: 'company-notes' })
    }

    let usedFallbackWithoutJoin = false
    let rpcRows: Record<string, unknown>[] | null = null
    if (companyId || isSuperAdmin) {
      const rpc = await supabaseAdmin.rpc('list_delivery_lots', {
        p_company_id: companyId || null,
        p_status: status,
      })
      if (!rpc.error && Array.isArray(rpc.data)) {
        rpcRows = rpc.data as Record<string, unknown>[]
      }
    }

    let data: Record<string, unknown>[] | null = null
    let error: { code?: string; message?: string } | null = null

    if (rpcRows) {
      data = rpcRows.map((row) => ({ ...row, delivery_lot_orders: [] }))
    } else {
      ({ data, error } = await withSchemaCacheRetry(
        async () => {
          let nextQuery = supabaseAdmin
            .from('delivery_lots')
            .select(`${LOT_COLUMNS}, delivery_lot_orders(${LOT_ORDER_COLUMNS})`)
            .order('created_at', { ascending: false })
          nextQuery = companyId
            ? nextQuery.eq('company_id', companyId)
            : nextQuery.is('company_id', null)
          if (status) nextQuery = nextQuery.eq('status', status)
          return nextQuery
        },
        (result) => isMissingSchemaObject((result as { error?: { code?: string; message?: string } | null }).error)
      ))
    }
    if (error && isMissingSchemaObject(error)) {
      // Compatibility fallback for fresh/new projects where relation table or FKs are not yet migrated.
      let fallbackQuery = supabaseAdmin
        .from('delivery_lots')
        .select(LOT_COLUMNS)
        .order('created_at', { ascending: false })
      fallbackQuery = companyId
        ? fallbackQuery.eq('company_id', companyId)
        : fallbackQuery.is('company_id', null)
      if (status) fallbackQuery = fallbackQuery.eq('status', status)
      const retry = await fallbackQuery
      usedFallbackWithoutJoin = !retry.error
      data = (retry.data || []).map((row: Record<string, unknown>) => ({ ...row, delivery_lot_orders: [] }))
      error = retry.error
    }
    if (error && isMissingSchemaObject(error)) {
      const directRows = await listLotsDirect({
        companyId,
        status,
        includeOrphansOnly: !companyId && isSuperAdmin,
      })
      if (directRows) {
        const lotMap = new Map<string, Record<string, unknown> & { delivery_lot_orders: Record<string, unknown>[] }>()
        for (const row of directRows) {
          const lotId = String(row.id)
          const existing = lotMap.get(lotId) || {
            id: row.id,
            lot_number: row.lot_number,
            name: row.name || '',
            dispatch_date: row.dispatch_date || '',
            destination: row.destination || '',
            vehicle_no: row.vehicle_no || '',
            notes: row.notes || '',
            status: row.status || 'OPEN',
            driver_id: row.driver_id || '',
            driver_name: row.driver_name || '',
            created_at: row.created_at,
            updated_at: row.updated_at,
            delivery_lot_orders: [],
          }
          if (row.order_id) {
            existing.delivery_lot_orders.push({
              order_id: row.order_id,
              invoice_number: row.invoice_number || '',
              party_name: row.party_name || '',
              grand_total: row.grand_total || 0,
              manufacturing_status: row.manufacturing_status || 'Not Started',
            })
          }
          lotMap.set(lotId, existing)
        }
        data = [...lotMap.values()]
        error = null
      } else {
        markDedicatedTablesUnavailable()
        const fallbackLots = await listFallbackDeliveryLots(companyId, status)
        return NextResponse.json({ success: true, data: fallbackLots, source: 'company-notes' })
      }
    }
    if (error) {
      console.warn('[delivery-lots GET] degraded fetch:', error)
      return NextResponse.json({
        success: true,
        data: [],
        source: 'degraded',
        message: error instanceof Error ? error.message : 'Delivery lots are temporarily unavailable.',
      })
    }

    if (usedFallbackWithoutJoin && data && data.length > 0) {
      const lotIds = (data as Record<string, unknown>[])
        .map((row) => String(row.id || ''))
        .filter(Boolean)

      if (lotIds.length > 0) {
        const { data: orderRows, error: orderRowsError } = await supabaseAdmin
          .from('delivery_lot_orders')
          .select(LOT_ORDER_COLUMNS)
          .in('lot_id', lotIds)

        if (!orderRowsError && orderRows) {
          const ordersByLot = new Map<string, Record<string, unknown>[]>()
          for (const row of orderRows as Record<string, unknown>[]) {
            const lotId = String(row.lot_id || '')
            if (!lotId) continue
            const existing = ordersByLot.get(lotId) || []
            existing.push(row)
            ordersByLot.set(lotId, existing)
          }

          data = (data as Record<string, unknown>[]).map((row) => ({
            ...row,
            delivery_lot_orders: ordersByLot.get(String(row.id || '')) || [],
          }))
        }
      }
    }

    // Transform to match the frontend DeliveryLot shape
    const lots = (data || []).map((lot: Record<string, unknown>) => {
      const orders = (lot.delivery_lot_orders || []) as Record<string, unknown>[]
      const order_ids = orders.map((o) => o.order_id as string)
      const order_meta: Record<string, { invoice_number: string; party_name: string; grand_total: number }> = {}
      orders.forEach((o) => {
        order_meta[o.order_id as string] = {
          invoice_number: (o.invoice_number as string) || '',
          party_name: (o.party_name as string) || '',
          grand_total: Number(o.grand_total) || 0,
        }
      })
      return {
        id: lot.id,
        lot_number: lot.lot_number,
        name: lot.name,
        dispatch_date: lot.dispatch_date || '',
        destination: lot.destination || '',
        vehicle_no: lot.vehicle_no || '',
        notes: lot.notes || '',
        status: lot.status,
        order_ids,
        order_meta,
        driver_id: lot.driver_id || '',
        driver_name: lot.driver_name || '',
        created_at: lot.created_at,
        updated_at: lot.updated_at,
        manufacturing_statuses: orders.reduce((acc, o) => {
          acc[o.order_id as string] = (o.manufacturing_status as string) || 'Not Started'
          return acc
        }, {} as Record<string, string>),
      }
    })

    // `source: 'db'` confirms the shared tables exist, so the client can safely
    // leave per-device localStorage mode (migrating any trapped local lots up first).
    return NextResponse.json({ success: true, data: lots, source: 'db' })
  } catch (err) {
    console.warn('[delivery-lots GET] unexpected failure:', err)
    return NextResponse.json({
      success: true,
      data: [],
      source: 'degraded',
      message: err instanceof Error ? err.message : 'Failed to fetch delivery lots',
    })
  }
}

export async function POST(req: NextRequest) {
  let stage = 'init'
  try {
    stage = 'auth'
    const authUser = await getUserFromToken(req)
    const companyId = await resolveCompanyScope(req, authUser)
    stage = 'parse-body'
    const body = await req.json()

    const createUsingCloudFallback = async () => {
      const fallbackLot = await createFallbackDeliveryLot({
        companyId,
        createdBy: authUser?.id || null,
        name: String(body.name || ''),
        dispatch_date: body.dispatch_date || '',
        destination: String(body.destination || ''),
        vehicle_no: String(body.vehicle_no || ''),
        notes: String(body.notes || ''),
        driver_id: body.driver_id || '',
        driver_name: String(body.driver_name || ''),
        order_ids: Array.isArray(body.order_ids) ? body.order_ids : [],
        order_meta: body.order_meta || {},
        manufacturing_statuses: body.manufacturing_statuses || {},
      })
      try {
        await syncOrdersToProcurement(fallbackLot.order_ids)
      } catch (syncErr) {
        console.warn('[DELIVERY_LOTS POST] fallback lot created, but order status sync failed:', syncErr)
      }
      return NextResponse.json({ success: true, data: fallbackLot, source: 'company-notes' })
    }

    if (shouldUseCloudFallback()) return createUsingCloudFallback()

    // Generate lot number
    stage = 'count-existing'
    let count = 0
    const countResult = await withSchemaCacheRetry(
      async () => {
        let countQuery = supabaseAdmin
          .from('delivery_lots')
          .select('id', { count: 'exact', head: true })
        if (companyId) countQuery = countQuery.eq('company_id', companyId)
        return countQuery
      },
      (result) => {
        const error = (result as { error?: { code?: string; message?: string } | null }).error
        return isMissingSchemaObject(error) || isMissingColumnError(error)
      }
    )
    const countErr = countResult.error
    if (!countErr) {
      count = Number(countResult.count || 0)
    } else if (isMissingSchemaObject(countErr) || isMissingColumnError(countErr)) {
      const countRows = await executeDirectSql<{ count: string | number }>(`
        SELECT COUNT(*)::int AS count
        FROM public.delivery_lots
        ${companyId ? `WHERE company_id = ${sqlUuid(companyId)}` : ''}
      `)
      if (countRows?.[0]) {
        count = Number(countRows[0].count || 0)
      } else {
        stage = 'create-cloud-fallback'
        markDedicatedTablesUnavailable()
        return createUsingCloudFallback()
      }
    } else {
      throw countErr
    }

    const lotNumber = `LOT-${String((count || 0) + 1).padStart(3, '0')}`

    stage = 'insert-lot'
    const insertPayload: Record<string, unknown> = {
      lot_number: lotNumber,
      name: body.name || '',
      dispatch_date: body.dispatch_date || null,
      destination: body.destination || '',
      vehicle_no: body.vehicle_no || '',
      notes: body.notes || '',
      status: 'OPEN',
      driver_id: body.driver_id || null,
      driver_name: body.driver_name || '',
      company_id: companyId || null,
      created_by: authUser?.id || null,
    }

    let lot: Record<string, unknown> | null = null
    let error: { code?: string; message?: string } | null = null
    let ordersAlreadyAttached = false

    const rpcCreate = await supabaseAdmin.rpc('create_delivery_lot', {
      p_company_id: companyId || null,
      p_created_by: authUser?.id || null,
      p_lot_number: lotNumber,
      p_name: String(body.name || ''),
      p_dispatch_date: body.dispatch_date || null,
      p_destination: String(body.destination || ''),
      p_vehicle_no: String(body.vehicle_no || ''),
      p_notes: String(body.notes || ''),
      p_driver_id: body.driver_id || null,
      p_driver_name: String(body.driver_name || ''),
    })
    if (!rpcCreate.error && Array.isArray(rpcCreate.data) && rpcCreate.data[0]) {
      lot = rpcCreate.data[0] as Record<string, unknown>
    } else {
      ({ data: lot, error } = await insertLotWithCompat(insertPayload))

      if (error && isMissingSchemaObject(error)) {
        const directLot = await createLotDirect({
          lotNumber,
          name: String(body.name || ''),
          dispatchDate: body.dispatch_date || null,
          destination: String(body.destination || ''),
          vehicleNo: String(body.vehicle_no || ''),
          notes: String(body.notes || ''),
          driverId: body.driver_id || null,
          driverName: String(body.driver_name || ''),
          companyId: companyId || null,
          createdBy: authUser?.id || null,
          orderIds: Array.isArray(body.order_ids) ? body.order_ids as string[] : [],
          orderMeta: body.order_meta,
          manufacturingStatuses: body.manufacturing_statuses,
        })
        if (!directLot) {
          markDedicatedTablesUnavailable()
          return createUsingCloudFallback()
        }
        lot = directLot as unknown as typeof lot
        error = null
        // createLotDirect writes the lot and its order links together. Do not
        // run the shared attachment step below or the unique lot/order index
        // rejects the duplicate rows and makes a successful create look failed.
        ordersAlreadyAttached = true
      }

      if (error) throw error
    }

    if (!lot) throw new Error('Delivery lot could not be created')

    // Attach orders if provided
    if (!ordersAlreadyAttached && body.order_ids && body.order_ids.length > 0) {
      stage = 'attach-orders'
      const orderIds = body.order_ids as string[]
      const attachResult = await insertLotOrdersWithCompat(
        lot.id as string,
        orderIds,
        body.order_meta,
        body.manufacturing_statuses,
      )

      if (attachResult.error && isMissingSchemaObject(attachResult.error)) {
        const directValues = orderIds.map((orderId) => `(
          ${sqlUuid(String(lot.id))},
          ${sqlUuid(orderId)},
          ${sqlString(body.order_meta?.[orderId]?.invoice_number || '')},
          ${sqlString(body.order_meta?.[orderId]?.party_name || '')},
          ${sqlNumber(Number(body.order_meta?.[orderId]?.grand_total || 0))},
          ${sqlString(body.manufacturing_statuses?.[orderId] || 'Not Started')}
        )`).join(',\n')
        const directInserted = await runDirectSql(`
          INSERT INTO public.delivery_lot_orders (
            lot_id, order_id, invoice_number, party_name, grand_total, manufacturing_status
          ) VALUES ${directValues}
        `)
        if (!directInserted) {
          await runDirectSql(`DELETE FROM public.delivery_lots WHERE id = ${sqlUuid(String(lot.id))}`)
          throw attachResult.error
        }
      } else if (attachResult.error) {
        await runDirectSql(`DELETE FROM public.delivery_lots WHERE id = ${sqlUuid(String(lot.id))}`)
        throw attachResult.error
      }

      stage = 'sync-order-status'
      try {
        await syncOrdersToProcurement(orderIds)
      } catch (syncErr) {
        console.warn('[DELIVERY_LOTS POST] lot created, but order status sync failed:', syncErr)
      }
    }

    return NextResponse.json({
      success: true,
      data: { ...lot, lot_number: lotNumber, order_ids: body.order_ids || [] },
    })
  } catch (err) {
    console.error('[DELIVERY_LOTS POST] error at stage:', stage, err)
    const message = err instanceof Error
      ? err.message
      : (typeof err === 'object' && err !== null && 'message' in err
          ? String((err as { message?: string }).message)
          : 'Failed to create delivery lot')
    return NextResponse.json(
      { success: false, message },
      { status: 500 }
    )
  }
}

export async function PUT(req: NextRequest) {
  try {
    const authUser = await getUserFromToken(req)
    const companyId = await resolveCompanyScope(req, authUser)
    const body = await req.json()
    const { id, ...updates } = body

    if (!id) {
      return NextResponse.json({ success: false, message: 'Lot ID required' }, { status: 400 })
    }

    if (shouldUseCloudFallback()) {
      const fallbackLot = await updateFallbackDeliveryLot(
        id,
        companyId,
        updates as Partial<DeliveryLotFallbackRecord>,
      )
      if (!fallbackLot) return NextResponse.json({ success: false, message: 'Lot not found' }, { status: 404 })
      if (updates.status === 'DISPATCHED' || updates.status === 'DELIVERED') {
        await supabaseAdmin.from('orders').update({ status: updates.status }).in('id', fallbackLot.order_ids)
      }
      return NextResponse.json({ success: true, data: fallbackLot, source: 'company-notes' })
    }

    // Probe once up front so deployments without the dedicated lot tables can
    // transparently use the shared company_notes cloud store.
    const { data: lotCheck, error: lotCheckError } = await supabaseAdmin
      .from('delivery_lots')
      .select('id, company_id')
      .eq('id', id)
      .maybeSingle()

    if (isMissingSchemaObject(lotCheckError)) {
      markDedicatedTablesUnavailable()
      const fallbackLot = await updateFallbackDeliveryLot(
        id,
        companyId,
        updates as Partial<DeliveryLotFallbackRecord>,
      )
      if (!fallbackLot) {
        return NextResponse.json({ success: false, message: 'Lot not found' }, { status: 404 })
      }
      if (updates.status === 'DISPATCHED' || updates.status === 'DELIVERED') {
        await supabaseAdmin
          .from('orders')
          .update({ status: updates.status })
          .in('id', fallbackLot.order_ids)
      }
      return NextResponse.json({ success: true, data: fallbackLot, source: 'company-notes' })
    }
    if (lotCheckError) throw lotCheckError
    if (companyId && lotCheck?.company_id && lotCheck.company_id !== companyId) {
      return NextResponse.json({ success: false, message: 'Lot not found' }, { status: 404 })
    }

    // Separate order-level updates from lot-level updates
    const { order_ids, order_meta, manufacturing_statuses, ...lotUpdates } = updates

    // Gate: block DISPATCHED if manufacturing is not complete.
    // Skip the check if the lot is already READY (procurement already validated it).
    if (lotUpdates.status === 'DISPATCHED') {
      const { data: currentLot } = await supabaseAdmin
        .from('delivery_lots')
        .select('status')
        .eq('id', id)
        .maybeSingle()

      const alreadyReady = (currentLot as { status?: string } | null)?.status === 'READY'

      if (!alreadyReady) {
        const { data: lotOrderRows } = await supabaseAdmin
          .from('delivery_lot_orders')
          .select('order_id, manufacturing_status')
          .eq('lot_id', id)

        const rows = (lotOrderRows || []) as { order_id: string; manufacturing_status: string | null }[]
        const incomplete = rows.filter(
          (r) => (r.manufacturing_status || '').toLowerCase() !== 'completed'
        )

        if (incomplete.length > 0) {
          return NextResponse.json(
            {
              success: false,
              message: `Cannot dispatch: ${incomplete.length} order${incomplete.length !== 1 ? 's' : ''} still pending manufacturing. Mark all orders as Complete first.`,
            },
            { status: 422 }
          )
        }
      }
    }

    // Update lot fields
    if (Object.keys(lotUpdates).length > 0) {
      const { error } = await supabaseAdmin
        .from('delivery_lots')
        .update({ ...lotUpdates, updated_at: new Date().toISOString() })
        .eq('id', id)

      if (error && (error.code === 'PGRST205' || error.code === '42P01')) {
        return NextResponse.json(
          { success: false, message: 'delivery_lots table is not set up yet. Run database migrations first.' },
          { status: 400 }
        )
      }
      if (error) throw error
    }

    // When lot is dispatched, sync all linked orders to DISPATCHED directly
    if (lotUpdates.status === 'DISPATCHED') {
      const { data: lotOrders } = await supabaseAdmin
        .from('delivery_lot_orders')
        .select('order_id')
        .eq('lot_id', id)

      if (lotOrders && lotOrders.length > 0) {
        const orderIds = lotOrders.map((o: { order_id: string }) => o.order_id)
        await supabaseAdmin
          .from('orders')
          .update({ status: 'DISPATCHED' })
          .in('id', orderIds)
          .in('status', ['PENDING', 'CONFIRMED', 'APPROVED', 'PROCUREMENT', 'IN_PROCUREMENT'])
      }
    }

    // When lot is delivered, sync all linked orders to DELIVERED
    if (lotUpdates.status === 'DELIVERED') {
      const { data: lotOrders } = await supabaseAdmin
        .from('delivery_lot_orders')
        .select('order_id')
        .eq('lot_id', id)

      if (lotOrders && lotOrders.length > 0) {
        const orderIds = lotOrders.map((o: { order_id: string }) => o.order_id)
        await supabaseAdmin
          .from('orders')
          .update({ status: 'DELIVERED' })
          .in('id', orderIds)
          .eq('status', 'DISPATCHED')
      }
    }

    // Update manufacturing statuses if provided
    if (manufacturing_statuses) {
      for (const [orderId, status] of Object.entries(manufacturing_statuses)) {
        await supabaseAdmin
          .from('delivery_lot_orders')
          .update({ manufacturing_status: status as string })
          .eq('lot_id', id)
          .eq('order_id', orderId)
      }
    }

    // Attach / replace linked orders if provided
    if (order_ids && Array.isArray(order_ids)) {
      await supabaseAdmin
        .from('delivery_lot_orders')
        .delete()
        .eq('lot_id', id)

      if (order_ids.length > 0) {
        const rows = order_ids.map((orderId: string) => ({
          lot_id: id,
          order_id: orderId,
          invoice_number: order_meta?.[orderId]?.invoice_number || '',
          party_name: order_meta?.[orderId]?.party_name || '',
          grand_total: order_meta?.[orderId]?.grand_total || 0,
          manufacturing_status: manufacturing_statuses?.[orderId] || 'Not Started',
        }))

        const { error: insertErr } = await supabaseAdmin
          .from('delivery_lot_orders')
          .insert(rows)

        if (insertErr && (insertErr.code === '42703' || insertErr.code === 'PGRST204' || insertErr.code === 'PGRST205')) {
          const minimalRows = order_ids.map((orderId: string) => ({
            lot_id: id,
            order_id: orderId,
          }))
          const retry = await supabaseAdmin
            .from('delivery_lot_orders')
            .insert(minimalRows)
          if (retry.error) throw retry.error
        } else if (insertErr) {
          throw insertErr
        }
      }
    }

    // Order-level writes above land on delivery_lot_orders and never touch the
    // parent row. /version derives its change signal from max(updated_at) on
    // delivery_lots, so bump the parent or those edits stay invisible to pollers.
    if (manufacturing_statuses || (order_ids && Array.isArray(order_ids))) {
      await supabaseAdmin
        .from('delivery_lots')
        .update({ updated_at: new Date().toISOString() })
        .eq('id', id)
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to update delivery lot'
    return NextResponse.json(
      { success: false, message },
      { status: message.startsWith('Cannot dispatch:') ? 422 : 500 }
    )
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const authUser = await getUserFromToken(req)
    const companyId = await resolveCompanyScope(req, authUser)
    const url = new URL(req.url)
    const id = url.searchParams.get('id')

    if (!id) {
      return NextResponse.json({ success: false, message: 'Lot ID required' }, { status: 400 })
    }

    if (shouldUseCloudFallback()) {
      await deleteFallbackDeliveryLot(id, companyId)
      return NextResponse.json({ success: true, source: 'company-notes' })
    }

    const { data: lotCheck, error: lotCheckError } = await supabaseAdmin
      .from('delivery_lots')
      .select('id, company_id')
      .eq('id', id)
      .maybeSingle()

    if (isMissingSchemaObject(lotCheckError)) {
      markDedicatedTablesUnavailable()
      await deleteFallbackDeliveryLot(id, companyId)
      return NextResponse.json({ success: true, source: 'company-notes' })
    }
    if (lotCheckError) throw lotCheckError
    if (companyId && lotCheck?.company_id && lotCheck.company_id !== companyId) {
      return NextResponse.json({ success: false, message: 'Lot not found' }, { status: 404 })
    }

    // delivery_lot_orders cascade deletes automatically
    const { error } = await supabaseAdmin
      .from('delivery_lots')
      .delete()
      .eq('id', id)

    if (error && (error.code === 'PGRST205' || error.code === '42P01')) {
      return NextResponse.json({ success: true })
    }
    if (error) throw error

    return NextResponse.json({ success: true })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed to delete delivery lot' },
      { status: 500 }
    )
  }
}
