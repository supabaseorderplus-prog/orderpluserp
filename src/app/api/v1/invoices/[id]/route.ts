import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, getUserFromToken, resolveCompanyScope } from '@/lib/supabase-server'

function deriveInvoiceOrderStatus(invoice: { invoice_type?: string | null; is_cancelled?: boolean | null; payment_status?: string | null; order_status?: string | null }) {
  if (invoice.is_cancelled) return 'CANCELLED'
  if (invoice.order_status) return invoice.order_status
  return 'PENDING'
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params

    const authUser = await getUserFromToken(req)
    const companyId = await resolveCompanyScope(req, authUser)

    const { data, error } = await supabaseAdmin
      .from('invoices')
      .select(`
        *,
        billing_party:parties!billing_party_id(id, name, party_code, gstin, address_line1, city, states(name, state_code)),
        supplier:parties!supplier_id(id, name, gstin),
        invoice_items(*, products(name, sku, unit_of_measure))
      `)
      .eq('id', id)
      .single()

    if (error) throw error
    if (!data) return NextResponse.json({ success: false, message: 'Not found' }, { status: 404 })

    // Verify company access
    if (companyId && data.company_id !== companyId) {
      return NextResponse.json({ success: false, message: 'Invoice not found or access denied' }, { status: 403 })
    }

    return NextResponse.json({ success: true, data: { ...data, order_status: deriveInvoiceOrderStatus(data) } })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed' },
      { status: 500 }
    )
  }
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const body = await req.json()

    const authUser = await getUserFromToken(req)
    const companyId = await resolveCompanyScope(req, authUser)

    // Verify company access before update
    if (companyId) {
      const { data: existingInvoiceCheck } = await supabaseAdmin
        .from('invoices')
        .select('company_id')
        .eq('id', id)
        .single()

      if (!existingInvoiceCheck || existingInvoiceCheck.company_id !== companyId) {
        return NextResponse.json({ success: false, message: 'Invoice not found or access denied' }, { status: 403 })
      }
    }

    const { data: existingInvoice, error: existingError } = await supabaseAdmin
      .from('invoices')
      .select('id, grand_total, amount_paid, amount_outstanding, payment_status, is_cancelled, cancel_reason, cancelled_by, cancelled_at')
      .eq('id', id)
      .single()

    if (existingError) throw existingError
    if (!existingInvoice) return NextResponse.json({ success: false, message: 'Not found' }, { status: 404 })

    const allowed = ['supply_date', 'due_date', 'dispatch_reference', 'transporter', 'lr_number', 'notes']
    const updates: Record<string, unknown> = {}
    for (const key of allowed) {
      if (body[key] !== undefined) updates[key] = body[key]
    }

    if (body.payment_update !== undefined) {
      const newPayStatus = String(body.payment_update.status || '').toUpperCase()
      const grandTotal = Number(existingInvoice.grand_total || 0)
      if (newPayStatus === 'PAID') {
        updates.payment_status = 'PAID'
        updates.amount_paid = grandTotal
        updates.amount_outstanding = 0
      } else if (newPayStatus === 'PARTIAL') {
        const amtPaid = Math.max(0, Math.min(Number(body.payment_update.amount_paid || 0), grandTotal))
        updates.payment_status = 'PARTIAL'
        updates.amount_paid = amtPaid
        updates.amount_outstanding = grandTotal - amtPaid
      } else if (newPayStatus === 'UNPAID') {
        updates.payment_status = 'PARTIAL'
        updates.amount_paid = 0
        updates.amount_outstanding = grandTotal
      }
    }

    if (body.order_status !== undefined) {
      const nextStatus = String(body.order_status).trim().toUpperCase()
      const grandTotal = Number(existingInvoice.grand_total || 0)
      const authUser = await getUserFromToken(req)

      if (nextStatus === 'CANCELLED') {
        updates.is_cancelled = true
        updates.order_status = 'CANCELLED'
        updates.cancelled_at = new Date().toISOString()
        updates.cancelled_by = authUser?.app_user_id || authUser?.id || existingInvoice.cancelled_by || null
        updates.cancel_reason = typeof body.cancel_reason === 'string' && body.cancel_reason.trim()
          ? body.cancel_reason.trim()
          : existingInvoice.cancel_reason || 'Cancelled from order history'
      } else if (nextStatus === 'CONFIRM') {
        updates.is_cancelled = false
        updates.order_status = 'CONFIRM'
        updates.cancelled_at = null
        updates.cancelled_by = null
        updates.cancel_reason = null
      } else {
        // PENDING
        updates.is_cancelled = false
        updates.order_status = 'PENDING'
        updates.cancelled_at = null
        updates.cancelled_by = null
        updates.cancel_reason = null
      }
    }

    updates.updated_at = new Date().toISOString()

    const { data, error } = await supabaseAdmin
      .from('invoices')
      .update(updates)
      .eq('id', id)
      .select()
      .single()

    if (error) throw error
    return NextResponse.json({ success: true, data: { ...data, order_status: deriveInvoiceOrderStatus(data) } })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Update failed' },
      { status: 500 }
    )
  }
}
