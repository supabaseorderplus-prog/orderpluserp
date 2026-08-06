import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, getUserFromToken, resolveCompanyScope } from '@/lib/supabase-server'

// GST Templates are stored in the `hsn_codes` table.
// transaction_type is encoded into the description field as "ProductName||TXN:inter" or "ProductName||TXN:intra"
// to completely avoid PostgREST schema cache issues with a separate column.

const TXN_SEPARATOR = '||TXN:'
const COMPANY_SEPARATOR = '||CID:'
const GST_SCOPE_MIGRATION_MESSAGE = 'GST templates are not company-scoped yet. Run HSN company-scope migration once.'

let hsnCompanyScopeEnsured = false

function isMissingCompanyScopeColumn(err: { code?: string; message?: string } | null | undefined): boolean {
  const text = `${err?.code || ''} ${err?.message || ''}`.toLowerCase()
  return (
    err?.code === '42703' ||
    (text.includes('company_id') && (text.includes('schema cache') || text.includes('does not exist') || text.includes('could not find')))
  )
}

async function ensureHsnCompanyScopeColumn(force = false): Promise<boolean> {
  if (!force && hsnCompanyScopeEnsured) return true

  const statements = [
    `ALTER TABLE public.hsn_codes ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES public.parties(id) ON DELETE CASCADE;`,
    `CREATE INDEX IF NOT EXISTS idx_hsn_codes_company_id ON public.hsn_codes(company_id);`,
    `NOTIFY pgrst, 'reload schema';`,
  ]

  let migrated = false
  const dbUrl = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL

  // Path 1: direct SQL via pg
  if (dbUrl && dbUrl.includes('supabase')) {
    try {
      const { Client } = await import('pg')
      const client = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } })
      await client.connect()
      for (const sql of statements) {
        await client.query(sql)
      }
      await client.end()
      migrated = true
    } catch (e) {
      console.warn('[ensureHsnCompanyScopeColumn] pg migration failed, falling back to exec_sql:', e)
    }
  }

  // Path 2: fallback via exec_sql RPC
  if (!migrated) {
    const probe = await supabaseAdmin.rpc('exec_sql', { sql: 'SELECT 1;' })
    if (!probe.error) {
      let hadError = false
      for (const sql of statements) {
        const { error } = await supabaseAdmin.rpc('exec_sql', { sql })
        if (error) {
          hadError = true
          console.warn('[ensureHsnCompanyScopeColumn] exec_sql statement failed:', error.message)
          break
        }
      }
      migrated = !hadError
    } else {
      console.warn('[ensureHsnCompanyScopeColumn] exec_sql unavailable:', probe.error?.message)
    }
  }

  if (migrated) hsnCompanyScopeEnsured = true
  return migrated
}

function encodeDescription(productName: string, txnType: string, companyId?: string): string {
  const safeTxn = txnType === 'inter' ? 'inter' : 'intra'
  const safeName = String(productName).replaceAll(TXN_SEPARATOR, ' ').replaceAll(COMPANY_SEPARATOR, ' ').trim()
  const scopedName = companyId ? `${safeName}${COMPANY_SEPARATOR}${companyId}` : safeName
  // Only add suffix for inter-state; intra is the default
  return safeTxn === 'inter' ? `${scopedName}${TXN_SEPARATOR}inter` : scopedName
}

function decodeDescription(description: string | null): { productName: string; transactionType: 'intra' | 'inter'; companyId: string | null } {
  if (!description) return { productName: '', transactionType: 'intra', companyId: null }

  let productName = description
  let transactionType: 'intra' | 'inter' = 'intra'

  const txnIdx = productName.indexOf(TXN_SEPARATOR)
  if (txnIdx !== -1) {
    transactionType = productName.substring(txnIdx + TXN_SEPARATOR.length) === 'inter' ? 'inter' : 'intra'
    productName = productName.substring(0, txnIdx)
  }

  let companyId: string | null = null
  const companyIdx = productName.indexOf(COMPANY_SEPARATOR)
  if (companyIdx !== -1) {
    companyId = productName.substring(companyIdx + COMPANY_SEPARATOR.length) || null
    productName = productName.substring(0, companyIdx)
  }

  return {
    productName,
    transactionType,
    companyId,
  }
}

export async function GET(req: NextRequest) {
  try {
    const authUser = await getUserFromToken(req)
    if (!authUser) return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 })

    const companyId = await resolveCompanyScope(req, authUser)
    if (!companyId) return NextResponse.json({ success: false, message: 'Company not found' }, { status: 403 })

    await ensureHsnCompanyScopeColumn()

    let data: {
      id: string
      hsn_code: string
      description: string | null
      gst_rate: number | string | null
      cess_rate: number | string | null
      created_at: string
    }[] | null = null
    let error: { code?: string; message?: string } | null = null

    let scoped = await supabaseAdmin
      .from('hsn_codes')
      .select('id, hsn_code, description, gst_rate, cess_rate, created_at')
      .eq('status', 'ACTIVE')
      .eq('company_id', companyId)
      .order('created_at', { ascending: false })

    if (scoped.error && isMissingCompanyScopeColumn(scoped.error)) {
      await ensureHsnCompanyScopeColumn(true)
      scoped = await supabaseAdmin
        .from('hsn_codes')
        .select('id, hsn_code, description, gst_rate, cess_rate, created_at')
        .eq('status', 'ACTIVE')
        .eq('company_id', companyId)
        .order('created_at', { ascending: false })
    }

    data = scoped.data
    error = scoped.error

    if (error && isMissingCompanyScopeColumn(error)) {
      const legacy = await supabaseAdmin
        .from('hsn_codes')
        .select('id, hsn_code, description, gst_rate, cess_rate, created_at')
        .eq('status', 'ACTIVE')
        .order('created_at', { ascending: false })

      if (legacy.error) throw legacy.error
      data = (legacy.data || []).filter(row => decodeDescription(row.description).companyId === companyId)
      error = null
    }

    if (error) throw error

    // Include company-tagged legacy rows created before PostgREST learned about hsn_codes.company_id.
    const legacyTagged = await supabaseAdmin
      .from('hsn_codes')
      .select('id, hsn_code, description, gst_rate, cess_rate, created_at')
      .eq('status', 'ACTIVE')
      .ilike('description', `%${COMPANY_SEPARATOR}${companyId}%`)
      .order('created_at', { ascending: false })
    if (!legacyTagged.error && legacyTagged.data) {
      const seen = new Set((data || []).map(row => row.id))
      const extra = legacyTagged.data.filter(row => !seen.has(row.id) && decodeDescription(row.description).companyId === companyId)
      data = [...(data || []), ...extra]
    }

    return NextResponse.json({
      success: true,
      data: (data || []).map(row => {
        const { productName, transactionType } = decodeDescription(row.description)
        return {
          id: row.id,
          product_name: productName || row.hsn_code,
          hsn_code: row.hsn_code,
          gst_rate: parseFloat(row.gst_rate) || 0,
          gst_category: 'goods',
          cess_rate: parseFloat(row.cess_rate) || 0,
          transaction_type: transactionType,
          created_at: row.created_at,
        }
      })
    })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed to fetch templates' },
      { status: 500 }
    )
  }
}

export async function POST(req: NextRequest) {
  try {
    const authUser = await getUserFromToken(req)
    if (!authUser) return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 })

    const companyId = await resolveCompanyScope(req, authUser)
    if (!companyId) return NextResponse.json({ success: false, message: 'Company not found' }, { status: 403 })

    await ensureHsnCompanyScopeColumn()

    const body = await req.json()
    const { product_name, gst_rate, cess_rate, hsn_code, transaction_type } = body
    if (!product_name || gst_rate === undefined) {
      return NextResponse.json({ success: false, message: 'product_name and gst_rate required' }, { status: 400 })
    }
    // Generate a unique hsn_code if not provided (unique constraint on column)
    const resolvedHsnCode = hsn_code && String(hsn_code).trim()
      ? String(hsn_code).trim()
      : `TPL-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

    const finalTransactionType = transaction_type === 'inter' ? 'inter' : 'intra'
    
    const insertPayload = {
      hsn_code: resolvedHsnCode,
      description: encodeDescription(product_name, finalTransactionType),
      gst_rate: gst_rate,
      cess_rate: cess_rate || 0,
      status: 'ACTIVE',
      effective_from: new Date().toISOString().split('T')[0],
      ...(companyId && { company_id: companyId }),
    }

    let { data, error } = await supabaseAdmin
      .from('hsn_codes')
      .insert(insertPayload)
      .select('id, hsn_code, description, gst_rate, cess_rate, created_at')
      .single()

    if (error && isMissingCompanyScopeColumn(error)) {
      await ensureHsnCompanyScopeColumn(true)
      const retry = await supabaseAdmin
        .from('hsn_codes')
        .insert(insertPayload)
        .select('id, hsn_code, description, gst_rate, cess_rate, created_at')
        .single()
      data = retry.data
      error = retry.error
    }

    if (error && isMissingCompanyScopeColumn(error)) {
      const { company_id, ...legacyPayload } = {
        ...insertPayload,
        description: encodeDescription(product_name, finalTransactionType, companyId),
      }
      void company_id
      const legacyRetry = await supabaseAdmin
        .from('hsn_codes')
        .insert(legacyPayload)
        .select('id, hsn_code, description, gst_rate, cess_rate, created_at')
        .single()
      data = legacyRetry.data
      error = legacyRetry.error
    }

    if (error) {
      if (isMissingCompanyScopeColumn(error)) {
        return NextResponse.json({ success: false, message: GST_SCOPE_MIGRATION_MESSAGE }, { status: 400 })
      }
      console.error('[POST /api/v1/gst-templates] Insert error:', error)
      throw error
    }

    const decoded = decodeDescription(data.description)

    return NextResponse.json({
      success: true,
      data: {
        id: data.id,
        product_name: decoded.productName,
        hsn_code: data.hsn_code,
        gst_rate: parseFloat(data.gst_rate) || 0,
        gst_category: 'goods',
        cess_rate: parseFloat(data.cess_rate) || 0,
        transaction_type: decoded.transactionType,
        created_at: data.created_at,
      }
    }, { status: 201 })
  } catch (err: unknown) {
    console.error('[POST /api/v1/gst-templates] Error:', JSON.stringify(err))
    const message = err instanceof Error ? err.message : typeof err === 'object' && err !== null && 'message' in err ? String((err as { message: string }).message) : 'Failed to create template'
    return NextResponse.json(
      { success: false, message },
      { status: 500 }
    )
  }
}

export async function PUT(req: NextRequest) {
  try {
    const authUser = await getUserFromToken(req)
    if (!authUser) return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 })

    const companyId = await resolveCompanyScope(req, authUser)
    if (!companyId) return NextResponse.json({ success: false, message: 'Company not found' }, { status: 403 })

    await ensureHsnCompanyScopeColumn()

    const body = await req.json()
    const { id, product_name, gst_rate, cess_rate, hsn_code, transaction_type } = body
    if (!id) return NextResponse.json({ success: false, message: 'id required' }, { status: 400 })

    // Verify the template belongs to the user's company
    let existingRes = await supabaseAdmin
      .from('hsn_codes')
      .select('company_id')
      .eq('id', id)
      .eq('company_id', companyId)
      .maybeSingle()

    if (existingRes.error && isMissingCompanyScopeColumn(existingRes.error)) {
      await ensureHsnCompanyScopeColumn(true)
      existingRes = await supabaseAdmin
        .from('hsn_codes')
        .select('company_id')
        .eq('id', id)
        .eq('company_id', companyId)
        .maybeSingle()
    }

    let legacyMode = false
    if (existingRes.error && isMissingCompanyScopeColumn(existingRes.error)) {
      const legacyExisting = await supabaseAdmin
        .from('hsn_codes')
        .select('description')
        .eq('id', id)
        .maybeSingle()
      if (legacyExisting.error) throw legacyExisting.error
      if (decodeDescription(legacyExisting.data?.description || null).companyId !== companyId) {
        return NextResponse.json({ success: false, message: 'Template not found or access denied' }, { status: 403 })
      }
      legacyMode = true
    }

    if (!legacyMode && !existingRes.data) {
      return NextResponse.json({ success: false, message: 'Template not found or access denied' }, { status: 403 })
    }

    // Keep transaction_type out of Supabase client payload — encode in description
    const updateFields: Record<string, unknown> = {}
    if (gst_rate !== undefined) updateFields.gst_rate = gst_rate
    if (cess_rate !== undefined) updateFields.cess_rate = cess_rate
    if (hsn_code !== undefined) updateFields.hsn_code = hsn_code

    // Always re-encode description with the transaction type
    if (product_name !== undefined || transaction_type !== undefined) {
      // Need to read current description to get existing values if not provided
      const { data: current } = await supabaseAdmin
        .from('hsn_codes')
        .select('description')
        .eq('id', id)
        .single()
      const currentDecoded = decodeDescription(current?.description || '')
      const newName = product_name !== undefined ? product_name : currentDecoded.productName
      const newTxn = (transaction_type === 'inter' || transaction_type === 'intra') ? transaction_type : currentDecoded.transactionType
      updateFields.description = encodeDescription(newName, newTxn, legacyMode ? companyId : undefined)
    }

    let { data, error } = await supabaseAdmin
      .from('hsn_codes')
      .update(updateFields)
      .eq('id', id)
      .eq('company_id', companyId)
      .select('id, hsn_code, description, gst_rate, cess_rate, created_at')
      .single()

    if (error && isMissingCompanyScopeColumn(error)) {
      await ensureHsnCompanyScopeColumn(true)
      const retry = await supabaseAdmin
        .from('hsn_codes')
        .update(updateFields)
        .eq('id', id)
        .eq('company_id', companyId)
        .select('id, hsn_code, description, gst_rate, cess_rate, created_at')
        .single()
      data = retry.data
      error = retry.error
    }

    if (error && isMissingCompanyScopeColumn(error)) {
      const legacyRetry = await supabaseAdmin
        .from('hsn_codes')
        .update(updateFields)
        .eq('id', id)
        .select('id, hsn_code, description, gst_rate, cess_rate, created_at')
        .single()
      data = legacyRetry.data
      error = legacyRetry.error
    }

    if (error && isMissingCompanyScopeColumn(error)) {
      return NextResponse.json({ success: false, message: GST_SCOPE_MIGRATION_MESSAGE }, { status: 400 })
    }
    if (error) throw error

    const decoded = decodeDescription(data.description)

    return NextResponse.json({
      success: true,
      data: {
        id: data.id,
        product_name: decoded.productName,
        hsn_code: data.hsn_code,
        gst_rate: parseFloat(data.gst_rate) || 0,
        gst_category: 'goods',
        cess_rate: parseFloat(data.cess_rate) || 0,
        transaction_type: decoded.transactionType,
        created_at: data.created_at,
      }
    })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed to update template' },
      { status: 500 }
    )
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const authUser = await getUserFromToken(req)
    if (!authUser) return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 })

    const companyId = await resolveCompanyScope(req, authUser)
    if (!companyId) return NextResponse.json({ success: false, message: 'Company not found' }, { status: 403 })

    await ensureHsnCompanyScopeColumn()

    const id = new URL(req.url).searchParams.get('id')
    if (!id) return NextResponse.json({ success: false, message: 'id required' }, { status: 400 })

    // Verify the template belongs to the user's company
    let existingRes = await supabaseAdmin
      .from('hsn_codes')
      .select('company_id')
      .eq('id', id)
      .eq('company_id', companyId)
      .maybeSingle()

    if (existingRes.error && isMissingCompanyScopeColumn(existingRes.error)) {
      await ensureHsnCompanyScopeColumn(true)
      existingRes = await supabaseAdmin
        .from('hsn_codes')
        .select('company_id')
        .eq('id', id)
        .eq('company_id', companyId)
        .maybeSingle()
    }

    let legacyMode = false
    if (existingRes.error && isMissingCompanyScopeColumn(existingRes.error)) {
      const legacyExisting = await supabaseAdmin
        .from('hsn_codes')
        .select('description')
        .eq('id', id)
        .maybeSingle()
      if (legacyExisting.error) throw legacyExisting.error
      if (decodeDescription(legacyExisting.data?.description || null).companyId !== companyId) {
        return NextResponse.json({ success: false, message: 'Template not found or access denied' }, { status: 403 })
      }
      legacyMode = true
    }

    if (!legacyMode && !existingRes.data) {
      return NextResponse.json({ success: false, message: 'Template not found or access denied' }, { status: 403 })
    }

    // Soft-delete: set status to INACTIVE
    let { error } = await supabaseAdmin
      .from('hsn_codes')
      .update({ status: 'INACTIVE' })
      .eq('id', id)
      .eq('company_id', companyId)

    if (error && isMissingCompanyScopeColumn(error)) {
      await ensureHsnCompanyScopeColumn(true)
      const retry = await supabaseAdmin
        .from('hsn_codes')
        .update({ status: 'INACTIVE' })
        .eq('id', id)
        .eq('company_id', companyId)
      error = retry.error
    }

    if (error && isMissingCompanyScopeColumn(error)) {
      const legacyRetry = await supabaseAdmin
        .from('hsn_codes')
        .update({ status: 'INACTIVE' })
        .eq('id', id)
      error = legacyRetry.error
    }

    if (error && isMissingCompanyScopeColumn(error)) {
      return NextResponse.json({ success: false, message: GST_SCOPE_MIGRATION_MESSAGE }, { status: 400 })
    }
    if (error) throw error
    return NextResponse.json({ success: true })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed to delete template' },
      { status: 500 }
    )
  }
}
