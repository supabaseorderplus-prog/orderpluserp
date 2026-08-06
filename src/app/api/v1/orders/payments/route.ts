import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, getUserFromToken, resolveCompanyScope } from '@/lib/supabase-server'

export async function GET(req: NextRequest) {
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

    const url = new URL(req.url)
    const search = url.searchParams.get('search') || ''
    const limit = parseInt(url.searchParams.get('limit') || '50')

    let query = supabaseAdmin
      .from('payments')
      .select('id, invoice_id, amount, payment_mode, payment_status, reference_number, payment_date, invoices(invoice_number), parties:invoices(billing_party_id, parties(name))')
      .order('payment_date', { ascending: false })
      .limit(limit)

    if (search) {
      query = query.ilike('reference_number', `%${search}%`)
    }

    // CRITICAL: Filter by company_id through parties relationship for data isolation
    if (companyId) {
      query = query.eq('parties.company_id', companyId)
    }

    const { data, error } = await query
    if (error) throw error

    const payments = (data || []).map((p: Record<string, unknown>) => ({
      id: p.id,
      order: p.invoices && typeof p.invoices === 'object' && 'invoice_number' in (p.invoices as Record<string, unknown>)
        ? { orderNumber: (p.invoices as Record<string, unknown>).invoice_number }
        : null,
      payer: null,
      amount: Number(p.amount || 0),
      mode: p.payment_mode || 'CASH',
      status: p.payment_status || 'COMPLETED',
      referenceNo: p.reference_number || null,
      createdAt: p.payment_date,
    }))

    return NextResponse.json({ data: payments })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed to fetch payments' },
      { status: 500 }
    )
  }
}
