import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, getUserFromToken, hasModulePermission, resolveCompanyScope } from '@/lib/supabase-server'
import {
  createFallbackVendorTransaction,
  ensureVendorsSchema,
  getFallbackVendorById,
  isMissingTableError,
  listFallbackVendorTransactions,
  newVendorTxnId,
  type VendorTransactionRow,
  type VendorTxnType,
} from '@/lib/vendors'

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

async function loadVendorScope(id: string, companyId: string): Promise<{ opening_balance: number } | null> {
  let { data, error } = await supabaseAdmin
    .from('vendors')
    .select('company_id, opening_balance')
    .eq('id', id)
    .maybeSingle()

  if (error && isMissingTableError(error)) {
    const schemaReady = await ensureVendorsSchema()
    if (schemaReady) {
      const retry = await supabaseAdmin
        .from('vendors')
        .select('company_id, opening_balance')
        .eq('id', id)
        .maybeSingle()
      data = retry.data
      error = retry.error
    }
  }

  if (error) {
    if (isMissingTableError(error)) {
      const fallback = await getFallbackVendorById(companyId, id)
      if (!fallback) return null
      return { opening_balance: Number(fallback.opening_balance || 0) }
    }
    throw error
  }
  if (!data || data.company_id !== companyId) return null
  return { opening_balance: Number(data.opening_balance || 0) }
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const { authUser, companyId } = await resolveScope(req)
    if (!authUser) return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 })
    if (!await hasModulePermission(authUser, 'vendors', 'can_view')) return NextResponse.json({ success: false, message: 'You do not have permission to view vendor ledgers' }, { status: 403 })
    if (!companyId) return NextResponse.json({ success: false, message: 'Company not found' }, { status: 403 })

    const vendor = await loadVendorScope(id, companyId)
    if (!vendor) return NextResponse.json({ success: false, message: 'Vendor not found' }, { status: 404 })

    let { data, error } = await supabaseAdmin
      .from('vendor_transactions')
      .select('*')
      .eq('vendor_id', id)
      .order('txn_date', { ascending: true })
      .order('created_at', { ascending: true })

    if (error && isMissingTableError(error)) {
      const schemaReady = await ensureVendorsSchema()
      if (schemaReady) {
        const retry = await supabaseAdmin
          .from('vendor_transactions')
          .select('*')
          .eq('vendor_id', id)
          .order('txn_date', { ascending: true })
          .order('created_at', { ascending: true })
        data = retry.data
        error = retry.error
      }
    }

    if (error) {
      if (isMissingTableError(error)) {
        const fallbackRows = await listFallbackVendorTransactions(companyId, id)
        let running = vendor.opening_balance
        const rows = fallbackRows.map((t) => {
          const amt = Number(t.amount) || 0
          running = Number((running + (t.txn_type === 'PAYMENT' ? -amt : amt)).toFixed(2))
          return { ...t, running_balance: running }
        })
        return NextResponse.json({ success: true, data: rows, opening_balance: vendor.opening_balance, current_balance: running, storage: 'company_notes_fallback' })
      }
      throw error
    }

    let running = vendor.opening_balance
    const rows = ((data || []) as VendorTransactionRow[]).map((t) => {
      const amt = Number(t.amount) || 0
      running = Number((running + (t.txn_type === 'PAYMENT' ? -amt : amt)).toFixed(2))
      return { ...t, running_balance: running }
    })

    return NextResponse.json({ success: true, data: rows, opening_balance: vendor.opening_balance, current_balance: running })
  } catch (err) {
    console.error('[GET /api/v1/vendors/[id]/ledger]', err)
    return NextResponse.json({ success: false, message: err instanceof Error ? err.message : 'Failed to fetch ledger' }, { status: 500 })
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const { authUser, companyId } = await resolveScope(req)
    if (!authUser) return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 })
    if (!await hasModulePermission(authUser, 'vendors', 'can_create')) return NextResponse.json({ success: false, message: 'You do not have permission to add vendor ledger entries' }, { status: 403 })
    if (!companyId) return NextResponse.json({ success: false, message: 'Company not found' }, { status: 403 })

    const vendor = await loadVendorScope(id, companyId)
    if (!vendor) return NextResponse.json({ success: false, message: 'Vendor not found' }, { status: 404 })

    const body = await req.json()
    const txnType = String(body.txn_type || '').toUpperCase() as VendorTxnType
    if (!['BILL', 'PAYMENT', 'ADJUSTMENT'].includes(txnType)) {
      return NextResponse.json({ success: false, message: 'txn_type must be BILL, PAYMENT, or ADJUSTMENT' }, { status: 400 })
    }

    const amount = Number(body.amount)
    if (!Number.isFinite(amount) || amount === 0) {
      return NextResponse.json({ success: false, message: 'A non-zero amount is required' }, { status: 400 })
    }
    if ((txnType === 'BILL' || txnType === 'PAYMENT') && amount < 0) {
      return NextResponse.json({ success: false, message: `${txnType} amount must be positive` }, { status: 400 })
    }

    const payload = {
      vendor_id: id,
      company_id: companyId,
      txn_type: txnType,
      amount,
      txn_date: body.txn_date || new Date().toISOString().slice(0, 10),
      reference_number: body.reference_number?.trim() || null,
      description: body.description?.trim() || null,
      created_by: authUser.id || null,
    }

    let { data, error } = await supabaseAdmin
      .from('vendor_transactions')
      .insert(payload)
      .select('*')
      .single()

    if (error && isMissingTableError(error)) {
      const schemaReady = await ensureVendorsSchema()
      if (schemaReady) {
        const retry = await supabaseAdmin
          .from('vendor_transactions')
          .insert(payload)
          .select('*')
          .single()
        data = retry.data
        error = retry.error
      }
    }

    if (error) {
      if (isMissingTableError(error)) {
        const created = await createFallbackVendorTransaction(companyId, {
          id: newVendorTxnId(),
          vendor_id: id,
          company_id: companyId,
          txn_type: txnType,
          amount,
          txn_date: payload.txn_date,
          reference_number: payload.reference_number,
          description: payload.description,
        })
        return NextResponse.json({ success: true, data: created, storage: 'company_notes_fallback' }, { status: 201 })
      }
      throw error
    }

    return NextResponse.json({ success: true, data }, { status: 201 })
  } catch (err) {
    console.error('[POST /api/v1/vendors/[id]/ledger]', err)
    return NextResponse.json({ success: false, message: err instanceof Error ? err.message : 'Failed to add transaction' }, { status: 500 })
  }
}
