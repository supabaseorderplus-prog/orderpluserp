import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, getUserFromToken, resolveCompanyScope } from '@/lib/supabase-server'
import * as XLSX from 'xlsx'

/**
 * GET /api/v1/export/excel?type=invoices|payments|ledger|outstanding|receipts&party_id=...&from=...&to=...
 * Returns an .xlsx file for download.
 */
export async function GET(req: NextRequest) {
  try {
    const authUser = await getUserFromToken(req)
    const companyId = await resolveCompanyScope(req, authUser)

    const url = new URL(req.url)
    const type = url.searchParams.get('type') || 'invoices'
    const partyId = url.searchParams.get('party_id')
    const from = url.searchParams.get('from')
    const to = url.searchParams.get('to')

    let rows: Record<string, unknown>[] = []
    let sheetName = type.charAt(0).toUpperCase() + type.slice(1)
    let filename = `${type}-export-${new Date().toISOString().split('T')[0]}.xlsx`

    if (type === 'invoices') {
      let q = supabaseAdmin
        .from('invoices')
        .select('invoice_number, invoice_date, billing_party_id, grand_total, amount_paid, amount_outstanding, payment_status, order_status, is_cancelled, created_at')
        .order('invoice_date', { ascending: false })
        .limit(5000)
      if (companyId) q = q.eq('company_id', companyId)
      if (partyId) q = q.eq('billing_party_id', partyId)
      if (from) q = q.gte('invoice_date', from)
      if (to) q = q.lte('invoice_date', to)
      const { data } = await q
      rows = (data || []).map(r => ({
        'Invoice No.': r.invoice_number,
        'Date': r.invoice_date,
        'Party ID': r.billing_party_id,
        'Grand Total (₹)': r.grand_total,
        'Paid (₹)': r.amount_paid,
        'Outstanding (₹)': r.amount_outstanding,
        'Payment Status': r.payment_status,
        'Order Status': r.order_status,
        'Cancelled': r.is_cancelled ? 'Yes' : 'No',
        'Created At': r.created_at,
      }))
      sheetName = 'Invoices'
    }

    else if (type === 'payments' || type === 'receipts') {
      const tableName = type === 'receipts' ? 'receipts' : 'payments'
      let q = supabaseAdmin
        .from(tableName)
        .select('*')
        .order('created_at', { ascending: false })
        .limit(5000)
      if (companyId) q = q.eq('company_id', companyId)
      if (partyId) q = q.eq('party_id', partyId)
      if (from) q = q.gte('created_at', from)
      if (to) q = q.lte('created_at', to)
      const { data } = await q

      if (type === 'receipts') {
        rows = (data || []).map((r: Record<string, unknown>) => ({
          'Receipt No.': r.receipt_number,
          'Date': r.receipt_date,
          'Party ID': r.party_id,
          'Amount (₹)': r.amount,
          'Mode': r.payment_mode,
          'Reference': r.reference_number,
          'Status': r.approval_status,
          'Approved At': r.approval_time,
          'Notes': r.notes,
        }))
        sheetName = 'Receipts'
      } else {
        rows = (data || []).map((r: Record<string, unknown>) => ({
          'Payment No.': r.payment_number,
          'Date': r.payment_date,
          'Party ID': r.party_id,
          'Amount (₹)': r.amount,
          'Mode': r.payment_mode,
          'Reference': r.reference_number,
          'Status': r.status,
          'Notes': r.notes,
        }))
        sheetName = 'Payments'
      }
    }

    else if (type === 'ledger') {
      if (!partyId) {
        return NextResponse.json({ success: false, message: 'party_id is required for ledger export' }, { status: 400 })
      }
      let q = supabaseAdmin
        .from('ledger_entries')
        .select('*')
        .eq('party_id', partyId)
        .order('entry_date', { ascending: true })
        .limit(5000)
      if (companyId) q = q.eq('company_id', companyId)
      if (from) q = q.gte('entry_date', from)
      if (to) q = q.lte('entry_date', to)
      const { data } = await q
      rows = (data || []).map(r => ({
        'Date': r.entry_date,
        'Type': r.type,
        'Amount (₹)': r.amount,
        'Balance After (₹)': r.balance_after,
        'Reference Type': r.reference_type,
        'Narration': r.narration,
        'Fiscal Year': r.fiscal_year,
      }))
      sheetName = 'Ledger'
      filename = `ledger-${partyId.slice(0, 8)}-${new Date().toISOString().split('T')[0]}.xlsx`
    }

    else if (type === 'outstanding') {
      let q = supabaseAdmin
        .from('invoices')
        .select('invoice_number, invoice_date, billing_party_id, grand_total, amount_paid, amount_outstanding, due_date')
        .in('payment_status', ['UNPAID', 'PARTIAL'])
        .not('is_cancelled', 'eq', true)
        .order('invoice_date', { ascending: true })
        .limit(5000)
      if (companyId) q = q.eq('company_id', companyId)
      if (partyId) q = q.eq('billing_party_id', partyId)
      if (from) q = q.gte('invoice_date', from)
      if (to) q = q.lte('invoice_date', to)
      const { data } = await q
      rows = (data || []).map(r => ({
        'Invoice No.': r.invoice_number,
        'Invoice Date': r.invoice_date,
        'Due Date': r.due_date,
        'Party ID': r.billing_party_id,
        'Grand Total (₹)': r.grand_total,
        'Paid (₹)': r.amount_paid,
        'Outstanding (₹)': r.amount_outstanding,
      }))
      sheetName = 'Outstanding'
    }

    else if (type === 'procurement') {
      let q = supabaseAdmin
        .from('procurement_orders')
        .select('*, procurement_order_items(*)')
        .order('created_at', { ascending: false })
        .limit(2000)
      if (companyId) q = q.eq('company_id', companyId)
      if (from) q = q.gte('created_at', from)
      if (to) q = q.lte('created_at', to)
      const { data } = await q
      rows = (data || []).flatMap((po: Record<string, unknown>) =>
        ((po.procurement_order_items as Record<string, unknown>[]) || []).map(item => ({
          'PO Number': po.procurement_number,
          'Supplier': po.supplier_name,
          'Status': po.status,
          'Expected Date': po.expected_date,
          'Product': item.product_name || item.product_id,
          'SKU': item.sku,
          'Qty Ordered': item.quantity_ordered,
          'Qty Received': item.quantity_received,
          'Unit Cost (₹)': item.unit_cost,
          'Line Total (₹)': item.line_total,
        }))
      )
      sheetName = 'Procurement'
    }

    // Build workbook
    const wb = XLSX.utils.book_new()
    const ws = XLSX.utils.json_to_sheet(rows.length > 0 ? rows : [{ Note: 'No data found for selected filters' }])
    XLSX.utils.book_append_sheet(wb, ws, sheetName)

    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })

    return new NextResponse(buffer, {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Export failed' },
      { status: 500 }
    )
  }
}
