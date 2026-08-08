import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, getUserFromToken, hasModulePermission, resolveCompanyScope } from '@/lib/supabase-server'
import { getVendorBalances, isMissingTableError, type VendorRow } from '@/lib/vendors'

export const dynamic = 'force-dynamic'

async function resolveScope(req: NextRequest): Promise<{ authUser: Awaited<ReturnType<typeof getUserFromToken>>; companyId: string | null }> {
  const authUser = await getUserFromToken(req)
  let companyId = await resolveCompanyScope(req, authUser)
  if (!companyId && authUser?.role === 'SALESMAN') {
    const salesmanUserId = authUser.app_user_id || authUser.id
    const { data: userRow } = await supabaseAdmin.from('users').select('party_id').eq('id', salesmanUserId).maybeSingle()
    if (userRow?.party_id) companyId = userRow.party_id as string
  }
  return { authUser, companyId }
}

// Aggregate outstanding payables (creditors) and receivables (debtors) for the company.
export async function GET(req: NextRequest) {
  try {
    const { authUser, companyId } = await resolveScope(req)
    if (!authUser) return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 })
    if (!await hasModulePermission(authUser, 'vendors', 'can_view')) return NextResponse.json({ success: false, message: 'You do not have permission to view vendor balances' }, { status: 403 })
    if (!companyId) return NextResponse.json({ success: false, message: 'Company not found' }, { status: 403 })

    const { data, error } = await supabaseAdmin
      .from('vendors')
      .select('id, vendor_code, name, trade_name, vendor_type, opening_balance, contact_phone, payment_terms_days')
      .eq('company_id', companyId)
      .eq('status', 'ACTIVE')
    if (error) {
      if (isMissingTableError(error)) {
        return NextResponse.json({ success: true, data: { payable: [], receivable: [], total_payable: 0, total_receivable: 0 }, migration_required: true })
      }
      throw error
    }

    const rows = (data || []) as unknown as VendorRow[]
    const openingById: Record<string, number> = {}
    for (const r of rows) openingById[r.id] = Number(r.opening_balance || 0)
    const balances = await getVendorBalances(rows.map((r) => r.id), openingById)

    const payable: Array<Record<string, unknown>> = []
    const receivable: Array<Record<string, unknown>> = []
    let totalPayable = 0
    let totalReceivable = 0

    for (const r of rows) {
      const bal = balances[r.id] ?? Number(r.opening_balance || 0)
      if (Math.abs(bal) < 0.005) continue
      const entry = {
        id: r.id,
        vendor_code: r.vendor_code,
        name: r.name,
        trade_name: r.trade_name,
        vendor_type: r.vendor_type,
        contact_phone: r.contact_phone,
        payment_terms_days: r.payment_terms_days,
        balance: bal,
      }
      if (r.vendor_type === 'CREDITOR') {
        if (bal > 0) { payable.push(entry); totalPayable += bal }
        else { receivable.push(entry); totalReceivable += -bal }
      } else {
        if (bal > 0) { receivable.push(entry); totalReceivable += bal }
        else { payable.push(entry); totalPayable += -bal }
      }
    }

    payable.sort((a, b) => Math.abs(Number(b.balance)) - Math.abs(Number(a.balance)))
    receivable.sort((a, b) => Math.abs(Number(b.balance)) - Math.abs(Number(a.balance)))

    return NextResponse.json({
      success: true,
      data: {
        payable,
        receivable,
        total_payable: Number(totalPayable.toFixed(2)),
        total_receivable: Number(totalReceivable.toFixed(2)),
      },
    })
  } catch (err) {
    console.error('[GET /api/v1/vendors/outstanding]', err)
    return NextResponse.json({ success: false, message: err instanceof Error ? err.message : 'Failed to fetch outstanding' }, { status: 500 })
  }
}
