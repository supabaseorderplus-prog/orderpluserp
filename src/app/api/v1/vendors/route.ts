import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, getUserFromToken, resolveCompanyScope } from '@/lib/supabase-server'
import {
  createFallbackVendor,
  generateFallbackVendorCode,
  VENDOR_PUBLIC_COLUMNS,
  VENDOR_PUBLIC_COLUMNS_WITH_VERIFICATION,
  VENDORS_TABLE_MISSING_MESSAGE,
  ensureVendorsSchema,
  errorMessage,
  generateVendorCode,
  getFallbackVendorBalances,
  getVendorBalances,
  hashVendorPassword,
  isMissingColumnError,
  isMissingTableError,
  listFallbackVendors,
  newVendorId,
  normalizeCoordinate,
  validateGstin,
  type VendorRow,
  type VendorType,
} from '@/lib/vendors'
import { queryDirectSql } from '@/lib/direct-sql'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const PAGE_SIZE = 50

// Salesmen don't send x-company-id; fall back to their own party_id (same as parties route).
async function resolveScope(req: NextRequest): Promise<{ authUser: Awaited<ReturnType<typeof getUserFromToken>>; companyId: string | null }> {
  const authUser = await getUserFromToken(req)
  let companyId = await resolveCompanyScope(req, authUser)
  if (!companyId && authUser?.role === 'SALESMAN') {
    const salesmanUserId = authUser.app_user_id || authUser.id
    const { data: userRow } = await supabaseAdmin
      .from('users')
      .select('party_id')
      .eq('id', salesmanUserId)
      .maybeSingle()
    if (userRow?.party_id) companyId = userRow.party_id as string
  }
  return { authUser, companyId }
}

function buildVendorSearch(search: string): string {
  const value = `"%${search.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}%"`
  return [
    `name.ilike.${value}`,
    `vendor_code.ilike.${value}`,
    `trade_name.ilike.${value}`,
    `gstin.ilike.${value}`,
    `contact_phone.ilike.${value}`,
  ].join(',')
}

// Escape a value for inline use in a raw SQL string literal (queryDirectSql does
// not support bound parameters). Single quotes are doubled per SQL standard.
function sqlQuote(value: string): string {
  return `'${String(value).replace(/'/g, "''")}'`
}

// Build the WHERE clause for the raw-SQL fallback used when the PostgREST schema
// cache hasn't picked up the vendors table yet. Mirrors buildQuery()'s filters.
function sqlNumber(value: unknown): string {
  const num = Number(value)
  return Number.isFinite(num) ? String(num) : '0'
}

function sqlNullable(value: string | null): string {
  return value == null || value === '' ? 'NULL' : sqlQuote(value)
}

function buildDirectVendorWhere(opts: {
  companyId: string
  search: string
  typeFilter: string
  verificationFilter: 'true' | 'false' | 'all'
}): string {
  const { companyId, search, typeFilter, verificationFilter } = opts
  const clauses = [`company_id = ${sqlQuote(companyId)}`, `status = 'ACTIVE'`]

  if (search) {
    const like = sqlQuote(`%${search.replace(/[%_]/g, (m) => `\\${m}`)}%`)
    clauses.push(
      `(name ILIKE ${like} OR vendor_code ILIKE ${like} OR trade_name ILIKE ${like} OR gstin ILIKE ${like} OR contact_phone ILIKE ${like})`,
    )
  }
  if (typeFilter === 'CREDITOR' || typeFilter === 'DEBTOR') {
    clauses.push(`vendor_type = ${sqlQuote(typeFilter)}`)
  }
  if (verificationFilter === 'true') clauses.push('is_verified = true')
  else if (verificationFilter === 'false') clauses.push('is_verified = false')

  return clauses.join(' AND ')
}

export async function GET(req: NextRequest) {
  try {
    const { authUser, companyId } = await resolveScope(req)
    if (!authUser) return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 })
    if (authUser.role === 'SALESMAN') return NextResponse.json({ success: false, message: 'Vendors are not available for salesman accounts' }, { status: 403 })
    if (!companyId) return NextResponse.json({ success: false, message: 'Company not found' }, { status: 403 })

    const url = new URL(req.url)
    const search = (url.searchParams.get('search') || '').trim()
    const typeFilter = (url.searchParams.get('vendor_type') || '').trim().toUpperCase()
    // Verification view: 'true' (verified), 'false' (unverified), or 'all'.
    // Salesmen always see every vendor regardless of status.
    const verifiedParam = (url.searchParams.get('is_verified') || 'all').trim().toLowerCase()
    const verificationFilter: 'true' | 'false' | 'all' =
      authUser.role === 'SALESMAN' ? 'all'
      : verifiedParam === 'true' ? 'true'
      : verifiedParam === 'false' ? 'false'
      : 'all'
    const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10) || 1)
    const limit = Math.min(150, Math.max(1, parseInt(url.searchParams.get('limit') || String(PAGE_SIZE), 10) || PAGE_SIZE))
    const from = (page - 1) * limit
    const to = from + limit - 1

    // Build the list query. `withVerification` selects + filters on the
    // verification columns; if they don't exist yet we retry without them so the
    // list still renders (every vendor treated as unverified until the ALTER runs).
    const buildQuery = (withVerification: boolean) => {
      let q = supabaseAdmin
        .from('vendors')
        .select(withVerification ? VENDOR_PUBLIC_COLUMNS_WITH_VERIFICATION : VENDOR_PUBLIC_COLUMNS, { count: 'exact' })
        .eq('company_id', companyId)
        .eq('status', 'ACTIVE')
        .order('created_at', { ascending: false })
        .range(from, to)
      if (search) q = q.or(buildVendorSearch(search))
      if (typeFilter === 'CREDITOR' || typeFilter === 'DEBTOR') q = q.eq('vendor_type', typeFilter)
      if (withVerification && verificationFilter !== 'all') {
        q = verificationFilter === 'true' ? q.eq('is_verified', true) : q.eq('is_verified', false)
      }
      return q
    }

    let verificationAvailable = true
    let { data, error, count } = await buildQuery(true)
    if (error && isMissingTableError(error)) {
      const schemaReady = await ensureVendorsSchema()
      if (schemaReady) {
        ;({ data, error, count } = await buildQuery(true))
      }
    }
    if (error && isMissingColumnError(error)) {
      // Verification columns not migrated yet — fall back to the base columns.
      verificationAvailable = false
      ;({ data, error, count } = await buildQuery(false))
    }
    if (error) {
      if (isMissingTableError(error)) {
        const whereSql = buildDirectVendorWhere({ companyId, search, typeFilter, verificationFilter })
        const directRows = await queryDirectSql<VendorRow>(`SELECT id, company_id, vendor_code, name, trade_name, vendor_type, gstin, pan, address_line1, city, pin_code, contact_person, contact_phone, contact_email, contact_aadhaar_url, credit_limit, payment_terms_days, opening_balance, latitude, longitude, portal_phone, notes, status, is_verified, verified_at, verified_by, created_at, updated_at FROM public.vendors WHERE ${whereSql} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${from}`)
        const totalRows = await queryDirectSql<{ total: number }>(`SELECT COUNT(*)::int AS total FROM public.vendors WHERE ${whereSql}`)

        if (!directRows) {
          const fallbackRows = await listFallbackVendors(companyId, {
            search,
            vendor_type: typeFilter,
            is_verified: verificationFilter,
          })
          const paged = fallbackRows.slice(from, from + limit)
          const openingById: Record<string, number> = {}
          for (const row of paged) openingById[row.id] = Number(row.opening_balance || 0)
          const balances = await getFallbackVendorBalances(paged.map((row) => row.id), openingById, companyId)

          return NextResponse.json({
            success: true,
            data: paged.map((row) => ({
              ...row,
              is_verified: row.is_verified ?? false,
              current_balance: balances[row.id] ?? Number(row.opening_balance || 0),
            })),
            meta: { total: fallbackRows.length, page, limit, pages: Math.ceil(fallbackRows.length / limit) },
            migration_required: false,
            verification_available: true,
            storage: 'company_notes_fallback',
          })
        }

        data = directRows as unknown as typeof data
        count = totalRows?.[0]?.total ?? directRows.length
        error = null
        verificationAvailable = true
      } else {
        throw error
      }
    }

    const rows = (data || []) as unknown as VendorRow[]
    const openingById: Record<string, number> = {}
    for (const r of rows) openingById[r.id] = Number(r.opening_balance || 0)
    const balances = await getVendorBalances(rows.map((r) => r.id), openingById)

    const enriched = rows.map((r) => ({
      ...r,
      is_verified: verificationAvailable ? (r.is_verified ?? false) : false,
      current_balance: balances[r.id] ?? Number(r.opening_balance || 0),
    }))

    return NextResponse.json({
      success: true,
      data: enriched,
      verification_available: verificationAvailable,
      meta: { total: count || 0, page, limit, pages: Math.ceil((count || 0) / limit) },
    })
  } catch (err) {
    console.error('[GET /api/v1/vendors]', err)
    // A missing table thrown from deep in the query path still deserves the
    // friendly migration notice rather than a hard 500.
    if (isMissingTableError(err)) {
      return NextResponse.json({ success: true, data: [], meta: { total: 0, page: 1, limit: PAGE_SIZE, pages: 0 }, migration_required: true, message: VENDORS_TABLE_MISSING_MESSAGE })
    }
    return NextResponse.json({ success: false, message: errorMessage(err, 'Failed to fetch vendors') }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const { authUser, companyId } = await resolveScope(req)
    if (!authUser) return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 })
    if (authUser.role === 'SALESMAN') return NextResponse.json({ success: false, message: 'Vendors are not available for salesman accounts' }, { status: 403 })
    if (!companyId) return NextResponse.json({ success: false, message: 'Company not found' }, { status: 403 })

    const body = await req.json()

    const name = String(body.name || '').trim()
    if (!name) return NextResponse.json({ success: false, message: 'Vendor name is required' }, { status: 400 })

    const vendorType: VendorType = body.vendor_type === 'DEBTOR' ? 'DEBTOR' : 'CREDITOR'

    if (body.gstin && !validateGstin(String(body.gstin))) {
      return NextResponse.json({ success: false, message: 'Invalid GSTIN format. Expected: 2-digit state code + PAN + 3 chars' }, { status: 400 })
    }

    const latitude = normalizeCoordinate(body.latitude, -90, 90)
    const longitude = normalizeCoordinate(body.longitude, -180, 180)
    const hasLat = body.latitude !== undefined && body.latitude !== null && String(body.latitude).trim() !== ''
    const hasLng = body.longitude !== undefined && body.longitude !== null && String(body.longitude).trim() !== ''
    if ((hasLat && latitude === null) || (hasLng && longitude === null)) {
      return NextResponse.json({ success: false, message: 'Invalid GPS coordinates.' }, { status: 400 })
    }

    const portalPhone = body.portal_phone ? String(body.portal_phone).replace(/[^0-9]/g, '') : null

    // Enforce unique portal login phone within the company (matches the DB unique index).
    if (portalPhone) {
      const { data: dup, error: dupErr } = await supabaseAdmin
        .from('vendors')
        .select('id, name, vendor_code')
        .eq('company_id', companyId)
        .eq('status', 'ACTIVE')
        .eq('portal_phone', portalPhone)
        .limit(1)
      if (dupErr && !isMissingTableError(dupErr)) throw dupErr
      if (dup && dup.length > 0) {
        return NextResponse.json(
          { success: false, message: `Portal phone already used by ${dup[0].name} (${dup[0].vendor_code}).` },
          { status: 409 },
        )
      }
      if (dupErr && isMissingTableError(dupErr)) {
        const directDup = await queryDirectSql<{ id: string; name: string; vendor_code: string }>(
          `SELECT id, name, vendor_code FROM public.vendors WHERE company_id = ${sqlQuote(companyId)} AND status = 'ACTIVE' AND portal_phone = ${sqlQuote(portalPhone)} LIMIT 1`
        )
        if (directDup && directDup.length > 0) {
          return NextResponse.json(
            { success: false, message: `Portal phone already used by ${directDup[0].name} (${directDup[0].vendor_code}).` },
            { status: 409 },
          )
        }
      }
    }

    let vendorCode = body.vendor_code && String(body.vendor_code).trim()
    if (!vendorCode) {
      try {
        vendorCode = await generateVendorCode(companyId)
      } catch (err) {
        if (!isMissingTableError(err) || !(await ensureVendorsSchema())) throw err
        vendorCode = await generateVendorCode(companyId)
      }
    }

    const insertPayload: Record<string, unknown> = {
      company_id: companyId,
      vendor_code: vendorCode,
      name,
      trade_name: body.trade_name?.trim() || null,
      vendor_type: vendorType,
      gstin: body.gstin?.trim() || null,
      pan: body.pan?.trim() || null,
      address_line1: body.address_line1?.trim() || null,
      city: body.city?.trim() || null,
      pin_code: body.pin_code?.trim() || null,
      contact_person: body.contact_person?.trim() || null,
      contact_phone: body.contact_phone?.trim() || null,
      contact_aadhaar_url: body.contact_aadhaar_url?.trim() || null,
      credit_limit: Number.isFinite(Number(body.credit_limit)) ? Number(body.credit_limit) : 0,
      payment_terms_days: Number.isFinite(Number(body.payment_terms_days)) ? parseInt(String(body.payment_terms_days), 10) : 21,
      opening_balance: Number.isFinite(Number(body.opening_balance)) ? Number(body.opening_balance) : 0,
      latitude,
      longitude,
      portal_phone: portalPhone,
      notes: body.notes?.trim() || null,
      status: 'ACTIVE',
      // New vendors enter the unverified queue (mirrors how parties are created).
      is_verified: false,
      created_by: authUser.id || null,
    }
    if (body.portal_password) {
      insertPayload.portal_password_hash = hashVendorPassword(String(body.portal_password))
    }

    const insertVendor = (payload: Record<string, unknown>) =>
      supabaseAdmin.from('vendors').insert(payload).select(VENDOR_PUBLIC_COLUMNS).single()

    let { data, error } = await insertVendor(insertPayload)
    if (error && isMissingTableError(error)) {
      const schemaReady = await ensureVendorsSchema()
      if (schemaReady) {
        ;({ data, error } = await insertVendor(insertPayload))
      }
    }
    if (error && isMissingColumnError(error, 'is_verified')) {
      // Verification column not migrated yet — insert without it.
      const { is_verified, ...rest } = insertPayload
      void is_verified
      ;({ data, error } = await insertVendor(rest))
    }
    if (error) {
      if (isMissingTableError(error)) {
        const createdBy = authUser.id || null
        const insertSql = `
          INSERT INTO public.vendors (
            company_id, vendor_code, name, trade_name, vendor_type, gstin, pan,
            address_line1, city, pin_code, contact_person, contact_phone,
            contact_aadhaar_url, credit_limit, payment_terms_days, opening_balance,
            latitude, longitude, portal_phone, portal_password_hash, notes, status,
            is_verified, created_by
          ) VALUES (
            ${sqlQuote(companyId)},
            ${sqlQuote(String(vendorCode))},
            ${sqlQuote(name)},
            ${sqlNullable((insertPayload.trade_name as string | null) ?? null)},
            ${sqlQuote(vendorType)},
            ${sqlNullable((insertPayload.gstin as string | null) ?? null)},
            ${sqlNullable((insertPayload.pan as string | null) ?? null)},
            ${sqlNullable((insertPayload.address_line1 as string | null) ?? null)},
            ${sqlNullable((insertPayload.city as string | null) ?? null)},
            ${sqlNullable((insertPayload.pin_code as string | null) ?? null)},
            ${sqlNullable((insertPayload.contact_person as string | null) ?? null)},
            ${sqlNullable((insertPayload.contact_phone as string | null) ?? null)},
            ${sqlNullable((insertPayload.contact_aadhaar_url as string | null) ?? null)},
            ${sqlNumber(insertPayload.credit_limit)},
            ${sqlNumber(insertPayload.payment_terms_days)},
            ${sqlNumber(insertPayload.opening_balance)},
            ${insertPayload.latitude == null ? 'NULL' : sqlNumber(insertPayload.latitude)},
            ${insertPayload.longitude == null ? 'NULL' : sqlNumber(insertPayload.longitude)},
            ${sqlNullable(portalPhone)},
            ${sqlNullable((insertPayload.portal_password_hash as string | null) ?? null)},
            ${sqlNullable((insertPayload.notes as string | null) ?? null)},
            'ACTIVE',
            false,
            ${createdBy ? sqlQuote(createdBy) : 'NULL'}
          )
          RETURNING id, company_id, vendor_code, name, trade_name, vendor_type, gstin, pan, address_line1, city, pin_code, contact_person, contact_phone, contact_email, contact_aadhaar_url, credit_limit, payment_terms_days, opening_balance, latitude, longitude, portal_phone, notes, status, is_verified, verified_at, verified_by, created_at, updated_at
        `
        const directInsert = await queryDirectSql<VendorRow>(insertSql)
        if (!directInsert || directInsert.length === 0) {
          const fallbackCode = vendorCode || (await generateFallbackVendorCode(companyId))
          const fallbackVendor = await createFallbackVendor(companyId, {
            id: newVendorId(),
            company_id: companyId,
            vendor_code: String(fallbackCode),
            name,
            trade_name: (insertPayload.trade_name as string | null) ?? null,
            vendor_type: vendorType,
            gstin: (insertPayload.gstin as string | null) ?? null,
            pan: (insertPayload.pan as string | null) ?? null,
            address_line1: (insertPayload.address_line1 as string | null) ?? null,
            city: (insertPayload.city as string | null) ?? null,
            pin_code: (insertPayload.pin_code as string | null) ?? null,
            contact_person: (insertPayload.contact_person as string | null) ?? null,
            contact_phone: (insertPayload.contact_phone as string | null) ?? null,
            contact_email: null,
            contact_aadhaar_url: (insertPayload.contact_aadhaar_url as string | null) ?? null,
            credit_limit: Number(insertPayload.credit_limit || 0),
            payment_terms_days: Number(insertPayload.payment_terms_days || 21),
            opening_balance: Number(insertPayload.opening_balance || 0),
            latitude: insertPayload.latitude == null ? null : Number(insertPayload.latitude),
            longitude: insertPayload.longitude == null ? null : Number(insertPayload.longitude),
            portal_phone: portalPhone,
            notes: (insertPayload.notes as string | null) ?? null,
            status: 'ACTIVE',
            is_verified: false,
            verified_at: null,
            verified_by: null,
          })
          return NextResponse.json(
            { success: true, data: { ...fallbackVendor, current_balance: Number(fallbackVendor.opening_balance || 0) }, storage: 'company_notes_fallback' },
            { status: 201 },
          )
        }
        data = directInsert[0] as unknown as typeof data
        error = null
      } else {
        throw error
      }
    }

    const row = data as unknown as VendorRow
    return NextResponse.json({ success: true, data: { ...row, is_verified: false, current_balance: Number(row.opening_balance || 0) } }, { status: 201 })
  } catch (err) {
    console.error('[POST /api/v1/vendors]', err)
    return NextResponse.json({ success: false, message: errorMessage(err, 'Failed to create vendor') }, { status: 500 })
  }
}
