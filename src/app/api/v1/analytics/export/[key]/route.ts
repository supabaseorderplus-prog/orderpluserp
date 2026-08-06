import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, getUserFromToken, resolveCompanyScope } from '@/lib/supabase-server'

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ key: string }> }
) {
  try {
    const authUser = await getUserFromToken(req)
    const companyId = await resolveCompanyScope(req, authUser)

    if (!companyId) {
      return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 })
    }

    const { key } = await params

    const exportFns: Record<string, () => Promise<Record<string, unknown>[]>> = {
      orders: async () => {
        const { data } = await supabaseAdmin
          .from('invoices')
          .select('invoice_number, invoice_type, invoice_date, grand_total, payment_status, parties!billing_party_id(name)')
          .eq('company_id', companyId)
          .order('invoice_date', { ascending: false })
          .limit(1000)
        return (data || []) as Record<string, unknown>[]
      },
      products: async () => {
        const { data } = await supabaseAdmin
          .from('products')
          .select('sku, name, trade_name, unit_of_measure, pack_size, mrp, base_price, status')
          .eq('company_id', companyId)
          .order('name')
        return (data || []) as Record<string, unknown>[]
      },
      users: async () => {
        const { data } = await supabaseAdmin
          .from('users')
          .select('name, email, phone, status, roles(name)')
          .eq('party_id', companyId)
          .order('name')
        return (data || []) as Record<string, unknown>[]
      },
      inventory: async () => {
        const { data } = await supabaseAdmin
          .from('inventory')
          .select('quantity, min_quantity, max_quantity, products(name, sku), warehouses(name)')
          .eq('company_id', companyId)
          .order('product_id')
        return (data || []) as Record<string, unknown>[]
      },
      payments: async () => {
        const { data } = await supabaseAdmin
          .from('payments')
          .select('amount, payment_mode, payment_status, reference_number, payment_date')
          .eq('parties.company_id', companyId)
          .order('payment_date', { ascending: false })
          .limit(1000)
        return (data || []) as Record<string, unknown>[]
      },
    }

    const fn = exportFns[key]
    if (!fn) {
      return NextResponse.json({ success: false, message: 'Invalid export type' }, { status: 400 })
    }

    const rows = await fn()

    if (rows.length === 0) {
      return NextResponse.json({ success: false, message: 'No data to export' }, { status: 404 })
    }

    const flattenObj = (obj: Record<string, unknown>, prefix = ''): Record<string, string> => {
      const result: Record<string, string> = {}
      for (const [k, v] of Object.entries(obj)) {
        const key = prefix ? `${prefix}_${k}` : k
        if (v && typeof v === 'object' && !Array.isArray(v)) {
          Object.assign(result, flattenObj(v as Record<string, unknown>, key))
        } else {
          result[key] = String(v ?? '')
        }
      }
      return result
    }

    const flatRows = rows.map(r => flattenObj(r))
    const headers = [...new Set(flatRows.flatMap(r => Object.keys(r)))]
    const csvLines = [
      headers.join(','),
      ...flatRows.map(r => headers.map(h => `"${(r[h] || '').replace(/"/g, '""')}"`).join(','))
    ]
    const csv = csvLines.join('\n')

    return new NextResponse(csv, {
      headers: {
        'Content-Type': 'text/csv',
        'Content-Disposition': `attachment; filename="${key}-export-${new Date().toISOString().split('T')[0]}.csv"`,
      },
    })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Export failed' },
      { status: 500 }
    )
  }
}
