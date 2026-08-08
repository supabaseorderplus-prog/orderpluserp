import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, getUserFromToken, hasModulePermission, resolveCompanyScope } from '@/lib/supabase-server'
import {
  deleteFallbackVendor,
  getFallbackVendorBalances,
  getFallbackVendorById,
  listFallbackVendorTransactions,
  updateFallbackVendor,
  VENDOR_PUBLIC_COLUMNS,
  currentVendorBalance,
  ensureVendorsSchema,
  hashVendorPassword,
  isMissingTableError,
  normalizeCoordinate,
  validateGstin,
  type VendorRow,
  type VendorTransactionRow,
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

async function loadOwnedVendor(id: string, companyId: string): Promise<VendorRow | null> {
  let { data, error } = await supabaseAdmin
    .from('vendors')
    .select(VENDOR_PUBLIC_COLUMNS)
    .eq('id', id)
    .maybeSingle()

  if (error && isMissingTableError(error)) {
    const schemaReady = await ensureVendorsSchema()
    if (schemaReady) {
      const retry = await supabaseAdmin
        .from('vendors')
        .select(VENDOR_PUBLIC_COLUMNS)
        .eq('id', id)
        .maybeSingle()
      data = retry.data
      error = retry.error
    }
  }

  if (error) {
    if (isMissingTableError(error)) return await getFallbackVendorById(companyId, id)
    throw error
  }
  if (!data) return null

  const row = data as unknown as VendorRow
  if (row.company_id !== companyId) return null
  return row
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const { authUser, companyId } = await resolveScope(req)
    if (!authUser) return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 })
    if (!await hasModulePermission(authUser, 'vendors', 'can_view')) return NextResponse.json({ success: false, message: 'You do not have permission to view vendors' }, { status: 403 })
    if (!companyId) return NextResponse.json({ success: false, message: 'Company not found' }, { status: 403 })

    const vendor = await loadOwnedVendor(id, companyId)
    if (!vendor) return NextResponse.json({ success: false, message: 'Vendor not found' }, { status: 404 })

    let { data: txns, error: txnErr } = await supabaseAdmin
      .from('vendor_transactions')
      .select('txn_type, amount')
      .eq('vendor_id', id)

    if (txnErr && isMissingTableError(txnErr)) {
      const schemaReady = await ensureVendorsSchema()
      if (schemaReady) {
        const retry = await supabaseAdmin
          .from('vendor_transactions')
          .select('txn_type, amount')
          .eq('vendor_id', id)
        txns = retry.data
        txnErr = retry.error
      }
    }

    if (txnErr && !isMissingTableError(txnErr)) throw txnErr

    const txnRows = txnErr && isMissingTableError(txnErr)
      ? await listFallbackVendorTransactions(companyId, id)
      : ((txns || []) as Pick<VendorTransactionRow, 'txn_type' | 'amount'>[])
    const balance = currentVendorBalance(vendor.opening_balance, txnRows)
    return NextResponse.json({ success: true, data: { ...vendor, current_balance: balance } })
  } catch (err) {
    console.error('[GET /api/v1/vendors/[id]]', err)
    return NextResponse.json({ success: false, message: err instanceof Error ? err.message : 'Failed to fetch vendor' }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const { authUser, companyId } = await resolveScope(req)
    if (!authUser) return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 })
    if (!await hasModulePermission(authUser, 'vendors', 'can_edit')) return NextResponse.json({ success: false, message: 'You do not have permission to edit vendors' }, { status: 403 })
    if (!companyId) return NextResponse.json({ success: false, message: 'Company not found' }, { status: 403 })

    const existing = await loadOwnedVendor(id, companyId)
    if (!existing) return NextResponse.json({ success: false, message: 'Vendor not found' }, { status: 404 })

    const body = await req.json()

    if (body.gstin && !validateGstin(String(body.gstin))) {
      return NextResponse.json({ success: false, message: 'Invalid GSTIN format.' }, { status: 400 })
    }

    const update: Record<string, unknown> = { updated_at: new Date().toISOString() }
    const setText = (key: string, value: unknown) => {
      if (value !== undefined) update[key] = value === '' ? null : (typeof value === 'string' ? value.trim() : value)
    }

    setText('name', body.name)
    setText('trade_name', body.trade_name)
    setText('gstin', body.gstin)
    setText('pan', body.pan)
    setText('address_line1', body.address_line1)
    setText('city', body.city)
    setText('pin_code', body.pin_code)
    setText('contact_person', body.contact_person)
    setText('contact_phone', body.contact_phone)
    setText('contact_email', body.contact_email)
    setText('contact_aadhaar_url', body.contact_aadhaar_url)
    setText('notes', body.notes)

    if (body.vendor_type === 'CREDITOR' || body.vendor_type === 'DEBTOR') update.vendor_type = body.vendor_type
    if (body.credit_limit !== undefined) update.credit_limit = Number(body.credit_limit) || 0
    if (body.payment_terms_days !== undefined) update.payment_terms_days = parseInt(String(body.payment_terms_days), 10) || 0
    if (body.opening_balance !== undefined) update.opening_balance = Number(body.opening_balance) || 0
    if (body.latitude !== undefined) update.latitude = normalizeCoordinate(body.latitude, -90, 90)
    if (body.longitude !== undefined) update.longitude = normalizeCoordinate(body.longitude, -180, 180)

    if (body.portal_phone !== undefined) {
      const portalPhone = body.portal_phone ? String(body.portal_phone).replace(/[^0-9]/g, '') : null
      if (portalPhone) {
        const { data: dup } = await supabaseAdmin
          .from('vendors')
          .select('id')
          .eq('company_id', companyId)
          .eq('status', 'ACTIVE')
          .eq('portal_phone', portalPhone)
          .neq('id', id)
          .limit(1)
        if (dup && dup.length > 0) {
          return NextResponse.json({ success: false, message: 'Portal phone already used by another vendor.' }, { status: 409 })
        }
      }
      update.portal_phone = portalPhone
    }

    if (body.portal_password) update.portal_password_hash = hashVendorPassword(String(body.portal_password))

    let { data, error } = await supabaseAdmin
      .from('vendors')
      .update(update)
      .eq('id', id)
      .select(VENDOR_PUBLIC_COLUMNS)
      .single()

    if (error && isMissingTableError(error)) {
      const schemaReady = await ensureVendorsSchema()
      if (schemaReady) {
        const retry = await supabaseAdmin
          .from('vendors')
          .update(update)
          .eq('id', id)
          .select(VENDOR_PUBLIC_COLUMNS)
          .single()
        data = retry.data
        error = retry.error
      }
    }

    if (error) {
      if (isMissingTableError(error)) {
        const updated = await updateFallbackVendor(companyId, id, update as Partial<VendorRow>)
        if (!updated) return NextResponse.json({ success: false, message: 'Vendor not found' }, { status: 404 })
        const balances = await getFallbackVendorBalances([id], { [id]: Number(updated.opening_balance || 0) }, companyId)
        return NextResponse.json({ success: true, data: { ...updated, current_balance: balances[id] ?? Number(updated.opening_balance || 0) }, storage: 'company_notes_fallback' })
      }
      throw error
    }

    return NextResponse.json({ success: true, data })
  } catch (err) {
    console.error('[PATCH /api/v1/vendors/[id]]', err)
    return NextResponse.json({ success: false, message: err instanceof Error ? err.message : 'Failed to update vendor' }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const { authUser, companyId } = await resolveScope(req)
    if (!authUser) return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 })
    if (!await hasModulePermission(authUser, 'vendors', 'can_delete')) return NextResponse.json({ success: false, message: 'You do not have permission to delete vendors' }, { status: 403 })
    if (!companyId) return NextResponse.json({ success: false, message: 'Company not found' }, { status: 403 })

    const existing = await loadOwnedVendor(id, companyId)
    if (!existing) return NextResponse.json({ success: false, message: 'Vendor not found' }, { status: 404 })

    let { error } = await supabaseAdmin
      .from('vendors')
      .update({ status: 'DELETED', updated_at: new Date().toISOString() })
      .eq('id', id)

    if (error && isMissingTableError(error)) {
      const schemaReady = await ensureVendorsSchema()
      if (schemaReady) {
        const retry = await supabaseAdmin
          .from('vendors')
          .update({ status: 'DELETED', updated_at: new Date().toISOString() })
          .eq('id', id)
        error = retry.error
      }
    }

    if (error) {
      if (isMissingTableError(error)) {
        const deleted = await deleteFallbackVendor(companyId, id)
        if (!deleted) return NextResponse.json({ success: false, message: 'Vendor not found' }, { status: 404 })
        return NextResponse.json({ success: true, storage: 'company_notes_fallback' })
      }
      throw error
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('[DELETE /api/v1/vendors/[id]]', err)
    return NextResponse.json({ success: false, message: err instanceof Error ? err.message : 'Failed to delete vendor' }, { status: 500 })
  }
}
