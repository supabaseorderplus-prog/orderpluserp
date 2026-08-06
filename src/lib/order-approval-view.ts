import 'server-only'

import { supabaseAdmin } from '@/lib/supabase-server'

type SchemaErr = { code?: string; message?: string } | null | undefined

const isSchemaErr = (error: SchemaErr) =>
  !!error &&
  (error.code === 'PGRST200' ||
    error.code === 'PGRST204' ||
    error.code === 'PGRST205' ||
    error.code === '42703' ||
    error.code === '42P01')

export interface PublicOrderItem {
  name: string
  sku: string
  quantity: number
  unit_price: number
  line_total: number
  unit?: string
}

export async function loadOrderApprovalView(orderId: string) {
  const { data: order, error: orderError } = await supabaseAdmin
    .from('orders')
    .select('id, order_number, created_at, grand_total, status')
    .eq('id', orderId)
    .maybeSingle()

  if (orderError) throw orderError
  if (!order) return { order: null, items: [] as PublicOrderItem[] }

  // Optional product columns differ between deployed schemas, so progressively
  // fall back while always keeping the commercial values from order_items.
  const selects = [
    'quantity, unit_price, line_total, products(name, sku, unit_of_measure, technical_specs)',
    'quantity, unit_price, line_total, products(name, sku)',
    'quantity, unit_price, line_total, product_id',
  ]
  let rows: Record<string, unknown>[] = []
  for (const select of selects) {
    const { data, error } = await supabaseAdmin.from('order_items').select(select).eq('order_id', orderId)
    if (!error) {
      rows = (data || []) as unknown as Record<string, unknown>[]
      break
    }
    if (!isSchemaErr(error)) throw error
  }

  const items: PublicOrderItem[] = rows.map((row) => {
    const product = (row.products || null) as Record<string, unknown> | null
    const quantity = Number(row.quantity) || 0
    const unitPrice = Number(row.unit_price) || 0
    return {
      name: (product?.name as string) || (row.product_id as string) || 'Item',
      sku: (product?.sku as string) || '',
      quantity,
      unit_price: unitPrice,
      line_total: Number(row.line_total) || quantity * unitPrice,
      unit: (product?.unit_of_measure as string) || undefined,
    }
  })

  return { order, items }
}
