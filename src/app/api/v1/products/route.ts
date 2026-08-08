import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, getUserFromToken, hasModulePermission, resolveCompanyScope } from '@/lib/supabase-server'
import { applyPartyEffectivePrices } from '@/lib/product-pricing'

let tableFixed = false

const PRODUCT_UNITS = ['KG', 'LITRE', 'BAG', 'PIECE', 'SET', 'BOX', 'DRUM', 'MT', 'UNIT', 'TON', 'GRAM', 'ML', 'CARTON', 'PACK']
const LEGACY_PRODUCT_UNITS = new Set(['KG', 'LITRE', 'BAG', 'PIECE', 'SET'])
const UNIT_FALLBACK = 'PIECE'
const LEGACY_COMPANY_TAG = '__CID__'

function normalizeUnitOfMeasure(value: unknown): string {
  const normalized = String(value || 'KG').trim().toUpperCase() || 'KG'
  return PRODUCT_UNITS.includes(normalized) ? normalized : 'KG'
}

function displayProductUnit<T extends Record<string, unknown>>(product: T): T {
  const specs = product.technical_specs
  if (!specs || typeof specs !== 'object') return product

  const requestedUnit = (specs as Record<string, unknown>).requested_unit_of_measure
  if (typeof requestedUnit !== 'string' || !PRODUCT_UNITS.includes(requestedUnit)) return product

  return {
    ...product,
    unit_of_measure: requestedUnit,
  }
}

function withLegacyUnitFallback(payload: Record<string, unknown>, requestedUnit: string): Record<string, unknown> {
  if (LEGACY_PRODUCT_UNITS.has(requestedUnit)) return payload

  const specs = payload.technical_specs && typeof payload.technical_specs === 'object'
    ? payload.technical_specs as Record<string, unknown>
    : {}

  return {
    ...payload,
    unit_of_measure: UNIT_FALLBACK,
    technical_specs: {
      ...specs,
      requested_unit_of_measure: requestedUnit,
    },
  }
}

async function ensureProductsTable(): Promise<void> {
  if (tableFixed) return

  const dbUrl = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL
  if (!dbUrl || !dbUrl.includes('supabase')) { tableFixed = true; return }

  try {
    const { Client } = await import('pg')
    const client = new Client({ connectionString: dbUrl })
    await client.connect()
    await client.query(`
      ALTER TABLE public.products ADD COLUMN IF NOT EXISTS company_id UUID;
      ALTER TABLE public.products ADD COLUMN IF NOT EXISTS trade_name VARCHAR(255);
      ALTER TABLE public.products ADD COLUMN IF NOT EXISTS is_scheme_eligible BOOLEAN DEFAULT true;
      ALTER TABLE public.products ADD COLUMN IF NOT EXISTS created_by UUID;
      ALTER TABLE public.products ADD COLUMN IF NOT EXISTS category_id UUID;
      ALTER TABLE public.products ADD COLUMN IF NOT EXISTS hsn_code_id UUID;
      ALTER TABLE public.products ADD COLUMN IF NOT EXISTS technical_specs JSONB;
      ALTER TABLE public.products ADD COLUMN IF NOT EXISTS pack_size NUMERIC DEFAULT 1;
      ALTER TABLE public.products ADD COLUMN IF NOT EXISTS mrp NUMERIC;
      ALTER TABLE public.products ADD COLUMN IF NOT EXISTS base_price NUMERIC;
      ALTER TABLE public.products ADD COLUMN IF NOT EXISTS sku VARCHAR(100);
      ALTER TABLE public.products ADD COLUMN IF NOT EXISTS unit_of_measure VARCHAR(20) DEFAULT 'KG';
      ALTER TABLE public.products ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'ACTIVE';
      ALTER TABLE public.products ADD COLUMN IF NOT EXISTS image_url TEXT;
      DO $$ DECLARE r RECORD;
      BEGIN
        FOR r IN SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'products' AND is_nullable = 'NO' AND column_name NOT IN ('id', 'name')
        LOOP
          EXECUTE 'ALTER TABLE public.products ALTER COLUMN ' || quote_ident(r.column_name) || ' DROP NOT NULL';
        END LOOP;
      END $$;
      CREATE INDEX IF NOT EXISTS idx_products_company_id ON public.products(company_id);
      ALTER TABLE public.products DROP CONSTRAINT IF EXISTS products_unit_of_measure_check;
      ALTER TABLE public.products ADD CONSTRAINT products_unit_of_measure_check
        CHECK (unit_of_measure IN ('KG', 'LITRE', 'BAG', 'PIECE', 'SET', 'BOX', 'DRUM', 'MT', 'UNIT', 'TON', 'GRAM', 'ML', 'CARTON', 'PACK'));
    `)
    await client.end()
    tableFixed = true
  } catch (e) {
    console.error('[ensureProductsTable] migration failed:', e)
  }
}



async function resolveFallbackCompanyId(): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from('users')
    .select('party_id')
    .not('party_id', 'is', null)
    .limit(1)
    .single()
  return data?.party_id ?? null
}

function cleanNumber(value: unknown): number | null {
  if (value === '' || value === null || value === undefined) return null
  const parsed = typeof value === 'number' ? value : parseFloat(String(value))
  return Number.isFinite(parsed) ? parsed : null
}

function parseLegacyCategoryName(rawName: string): { plainName: string; companyId: string | null } {
  const name = String(rawName || '')
  const idx = name.lastIndexOf(LEGACY_COMPANY_TAG)
  if (idx < 0) return { plainName: name, companyId: null }

  const plainName = name.slice(0, idx).trim()
  const companyId = name.slice(idx + LEGACY_COMPANY_TAG.length).trim() || null
  return { plainName: plainName || name, companyId }
}

function isLegacyCategoryOwnedByCompany(rawName: string, companyId: string): boolean {
  return parseLegacyCategoryName(rawName).companyId === companyId
}

function isMissingColumn(err: { code?: string; message?: string } | null | undefined, column: string): boolean {
  const text = `${err?.code || ''} ${err?.message || ''}`.toLowerCase()
  return text.includes(column.toLowerCase()) && (
    text.includes('could not find') ||
    text.includes('schema cache') ||
    text.includes('does not exist')
  )
}

async function assertCategoryOwnedByCompany(categoryId: string, companyId: string): Promise<{ ok: true } | { ok: false; status: number; message: string }> {
  const result = await supabaseAdmin
    .from('product_categories')
    .select('id, company_id, name')
    .eq('id', categoryId)
    .maybeSingle()

  if (result.error) {
    if (isMissingColumn(result.error, 'company_id')) {
      const legacyResult = await supabaseAdmin
        .from('product_categories')
        .select('id, name')
        .eq('id', categoryId)
        .maybeSingle()

      if (legacyResult.error) {
        return {
          ok: false,
          status: 400,
          message: legacyResult.error.message || 'Failed to validate category ownership',
        }
      }
      if (!legacyResult.data) {
        return { ok: false, status: 404, message: 'Selected category not found' }
      }
      if (!isLegacyCategoryOwnedByCompany(legacyResult.data.name, companyId)) {
        return { ok: false, status: 403, message: 'Selected category is outside your company scope' }
      }
      return {
        ok: true,
      }
    }
    return {
      ok: false,
      status: 400,
      message: result.error.message || 'Failed to validate category ownership',
    }
  }

  if (!result.data) {
    return { ok: false, status: 404, message: 'Selected category not found' }
  }

  if (result.data.company_id !== companyId) {
    return { ok: false, status: 403, message: 'Selected category is outside your company scope' }
  }

  return { ok: true }
}

async function resolveInsertCompanyId(req: NextRequest) {
  const authUser = await getUserFromToken(req)
  if (!authUser) return { authUser: null, companyId: null }

  let companyId = await resolveCompanyScope(req, authUser)
  if (!companyId && authUser.party_id) companyId = authUser.party_id
  if (!companyId) companyId = await resolveFallbackCompanyId()

  return { authUser, companyId }
}

export async function GET(req: NextRequest) {
  try {
    const { authUser, companyId } = await resolveInsertCompanyId(req)
    if (!authUser) return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 })
    if (!await hasModulePermission(authUser, 'products', 'can_view')) return NextResponse.json({ success: false, message: 'You do not have permission to view products' }, { status: 403 })
    if (!companyId) return NextResponse.json({ success: false, message: 'Company not found' }, { status: 403 })

    await ensureProductsTable()

    const url = new URL(req.url)
    const search = url.searchParams.get('search') || ''
    const category = url.searchParams.get('category') || ''
    const partyId = url.searchParams.get('partyId') || ''
    const page = parseInt(url.searchParams.get('page') || '1')
    const limit = parseInt(url.searchParams.get('limit') || '20')
    const offset = (page - 1) * limit

    // Try with joins first, fall back to simple query if joins fail
    let data: Record<string, unknown>[] | null = null
    let count: number | null = null
    let error: { message?: string } | null = null

    // First try with company_id filter
    const joinQuery = supabaseAdmin
      .from('products')
      .select('*, product_categories(name), hsn_codes(hsn_code, gst_rate, cess_rate)', { count: 'exact' })
      .eq('company_id', companyId)
      .order('name')
      .range(offset, offset + limit - 1)

    const joinResult = search
      ? await joinQuery.ilike('name', `%${search}%`)
      : category
      ? await joinQuery.eq('category_id', category)
      : await joinQuery

    if (!joinResult.error) {
      data = joinResult.data as Record<string, unknown>[] | null
      count = joinResult.count
    } else {
      // Fallback: simple query without joins
      const simpleQuery = supabaseAdmin
        .from('products')
        .select('*', { count: 'exact' })
        .eq('company_id', companyId)
        .order('name')
        .range(offset, offset + limit - 1)

      const simpleResult = search
        ? await simpleQuery.ilike('name', `%${search}%`)
        : category
        ? await simpleQuery.eq('category_id', category)
        : await simpleQuery

      data = simpleResult.data as Record<string, unknown>[] | null
      count = simpleResult.count
      error = simpleResult.error
    }

    if (error) throw error

    let enriched = data || []
    const categoryCompanyProbe = await supabaseAdmin
      .from('product_categories')
      .select('company_id')
      .limit(0)
    const hasCategoryCompanyScope = !categoryCompanyProbe.error

    if (enriched.length > 0 && enriched[0].product_categories) {
      enriched = enriched.map((product) => {
        const category = product.product_categories as { name?: string } | null
        if (!category?.name) return product

        const parsed = parseLegacyCategoryName(category.name)
        if (!hasCategoryCompanyScope) {
          if (parsed.companyId !== companyId) {
            return { ...product, product_categories: null }
          }
          return { ...product, product_categories: { ...category, name: parsed.plainName } }
        }

        if (parsed.companyId === companyId) {
          return { ...product, product_categories: { ...category, name: parsed.plainName } }
        }
        return product
      })
    }

    // Enrich products with category and HSN data if joins weren't used
    if (enriched.length > 0 && !enriched[0].product_categories) {
      const catIds = [...new Set(enriched.map((p) => p.category_id).filter(Boolean) as string[])]
      const hsnIds = [...new Set(enriched.map((p) => p.hsn_code_id).filter(Boolean) as string[])]

      const catMap: Record<string, { name: string }> = {}
      const hsnMap: Record<string, { hsn_code: string; gst_rate: number; cess_rate: number | null }> = {}

      if (catIds.length > 0) {
        const catCompanyProbe = await supabaseAdmin
          .from('product_categories')
          .select('company_id')
          .limit(0)
        const canScopeCategories = !catCompanyProbe.error

        let catQuery = supabaseAdmin
          .from('product_categories')
          .select('id, name')
          .in('id', catIds)
        if (canScopeCategories) {
          catQuery = catQuery.eq('company_id', companyId)
        }
        const { data: cats } = await catQuery
        for (const c of cats || []) {
          if (!canScopeCategories) {
            if (!isLegacyCategoryOwnedByCompany(c.name, companyId)) continue
            catMap[c.id] = { name: parseLegacyCategoryName(c.name).plainName }
            continue
          }
          catMap[c.id] = { name: c.name }
        }
      }

      if (hsnIds.length > 0) {
        const { data: hsns } = await supabaseAdmin
          .from('hsn_codes')
          .select('id, hsn_code, gst_rate, cess_rate')
          .in('id', hsnIds)
        for (const h of hsns || []) hsnMap[h.id] = { hsn_code: h.hsn_code, gst_rate: h.gst_rate, cess_rate: h.cess_rate }
      }

      enriched = enriched.map((p) => ({
        ...p,
        product_categories: p.category_id ? catMap[p.category_id as string] || null : null,
        hsn_codes: p.hsn_code_id ? hsnMap[p.hsn_code_id as string] || null : null,
      }))
    }

    if (partyId && enriched.length > 0) {
      enriched = await applyPartyEffectivePrices(
        enriched.map((product) => ({
          ...product,
          id: String(product.id),
          base_price: product.base_price,
        })),
        partyId,
      )
    }

    return NextResponse.json({
      success: true,
      data: enriched.map(displayProductUnit),
      pagination: { page, limit, total: count || 0, pages: Math.ceil((count || 0) / limit) },
    })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed to fetch products' },
      { status: 500 }
    )
  }
}

export async function POST(req: NextRequest) {
  try {
    const { authUser, companyId } = await resolveInsertCompanyId(req)
    if (!authUser) return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 })
    if (!await hasModulePermission(authUser, 'products', 'can_create')) return NextResponse.json({ success: false, message: 'You do not have permission to create products' }, { status: 403 })
    if (!companyId) return NextResponse.json({ success: false, message: 'Company not found' }, { status: 403 })

    await ensureProductsTable()

    const body = await req.json()
    const name = String(body?.name || '').trim()
    const sku = String(body?.sku || '').trim()
    const unitOfMeasure = normalizeUnitOfMeasure(body?.unit_of_measure)
    const basePrice = cleanNumber(body?.base_price)
    const mrp = cleanNumber(body?.mrp)
    const packSize = cleanNumber(body?.pack_size)
      const categoryId = body?.category_id ? String(body.category_id) : null
      const technicalSpecs = typeof body?.technical_specs === 'object' && body?.technical_specs !== null
        ? { ...(body.technical_specs as Record<string, unknown>) }
        : null
      const hsnCode = body?.hsn_code ? String(body.hsn_code).trim() : null
      const imageUrl = body?.image_url ? String(body.image_url).trim() : null


    if (!name) {
      return NextResponse.json({ success: false, message: 'Product name is required' }, { status: 400 })
    }
    if (!sku) {
      return NextResponse.json({ success: false, message: 'SKU is required' }, { status: 400 })
    }
    if (basePrice === null) {
      return NextResponse.json({ success: false, message: 'Base price is required' }, { status: 400 })
    }

    const normalizedPackSize = packSize ?? 1
    const normalizedMrp = mrp ?? basePrice

    const insertPayload: Record<string, unknown> = {
      name,
      trade_name: name,
      sku,
      unit_of_measure: unitOfMeasure,
      base_price: basePrice,
      mrp: normalizedMrp,
      pack_size: normalizedPackSize,
      is_scheme_eligible: true,
      company_id: companyId,
      created_by: authUser.id,
      status: 'ACTIVE',
    }

      if (categoryId) {
        const ownershipCheck = await assertCategoryOwnedByCompany(categoryId, companyId)
        if (!ownershipCheck.ok) {
          return NextResponse.json(
            { success: false, message: ownershipCheck.message },
            { status: ownershipCheck.status }
          )
        }
        insertPayload.category_id = categoryId
      }
      const mergedSpecs = {
        ...(technicalSpecs || {}),
        ...(imageUrl ? { image_url: imageUrl } : {}),
      }
      if (Object.keys(mergedSpecs).length > 0) insertPayload.technical_specs = mergedSpecs

      // Look up or create HSN code record
      if (hsnCode) {
        const { data: existing } = await supabaseAdmin
          .from('hsn_codes')
          .select('id')
          .eq('hsn_code', hsnCode)
          .limit(1)
          .maybeSingle()

        if (existing) {
          insertPayload.hsn_code_id = existing.id
        } else {
          const { data: created } = await supabaseAdmin
            .from('hsn_codes')
            .insert({ hsn_code: hsnCode, gst_rate: 18, cess_rate: 0, description: name, status: 'ACTIVE', effective_from: new Date().toISOString().split('T')[0] })
            .select('id')
            .single()
          if (created) insertPayload.hsn_code_id = created.id
        }
      }

      const { data, error } = await supabaseAdmin

      .from('products')
      .insert(insertPayload)
      .select()
      .single()

    if (error) {
      if (error.code === '23505') {
        return NextResponse.json({ success: false, message: 'A product with this SKU already exists' }, { status: 400 })
      }
      // Constraint violation on unit_of_measure — auto-fix and retry once
      if (error.code === '23514' && error.message?.includes('unit_of_measure')) {
        tableFixed = false
        await ensureProductsTable()
        const { data: retryData, error: retryError } = await supabaseAdmin
          .from('products').insert(insertPayload).select().single()
        if (retryError) {
          if (retryError.code === '23514' && retryError.message?.includes('unit_of_measure') && !LEGACY_PRODUCT_UNITS.has(unitOfMeasure)) {
            const fallbackPayload = withLegacyUnitFallback(insertPayload, unitOfMeasure)
            const { data: fallbackData, error: fallbackError } = await supabaseAdmin
              .from('products').insert(fallbackPayload).select().single()

            if (!fallbackError) {
              return NextResponse.json({ success: true, data: displayProductUnit(fallbackData) }, { status: 201 })
            }
          }

          return NextResponse.json({ success: false, message: retryError.message || 'Failed to create product' }, { status: 400 })
        }
        return NextResponse.json({ success: true, data: displayProductUnit(retryData) }, { status: 201 })
      }
      return NextResponse.json(
        { success: false, message: error.message || 'Failed to create product' },
        { status: 400 }
      )
    }

    return NextResponse.json({ success: true, data: displayProductUnit(data) }, { status: 201 })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed to create product' },
      { status: 500 }
    )
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const { authUser, companyId } = await resolveInsertCompanyId(req)
    if (!authUser) return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 })
    if (!await hasModulePermission(authUser, 'products', 'can_edit')) return NextResponse.json({ success: false, message: 'You do not have permission to edit products' }, { status: 403 })
    if (!companyId) return NextResponse.json({ success: false, message: 'Company not found' }, { status: 403 })

    const body = await req.json()
    const id = body?.id
    if (!id) return NextResponse.json({ success: false, message: 'id required' }, { status: 400 })

    const { data: existing } = await supabaseAdmin
      .from('products')
      .select('id, technical_specs')
      .eq('id', id)
      .eq('company_id', companyId)
      .maybeSingle()

    if (!existing) {
      return NextResponse.json({ success: false, message: 'Product not found or access denied' }, { status: 404 })
    }

    const has = (key: string) => Object.prototype.hasOwnProperty.call(body, key)

    const updatePayload: Record<string, unknown> = {}
    let requestedUnit: string | null = null

    if (has('name')) {
      const name = String(body.name || '').trim()
      if (!name) return NextResponse.json({ success: false, message: 'Product name cannot be empty' }, { status: 400 })
      updatePayload.name = name
      updatePayload.trade_name = name
    }

    if (has('base_price')) {
      const basePrice = cleanNumber(body.base_price)
      if (basePrice === null) return NextResponse.json({ success: false, message: 'Base price must be a valid number' }, { status: 400 })
      updatePayload.base_price = basePrice
      updatePayload.mrp = basePrice
    }
    if (has('mrp')) {
      const mrp = cleanNumber(body.mrp)
      if (mrp !== null) updatePayload.mrp = mrp
    }

    if (has('unit_of_measure')) {
      requestedUnit = normalizeUnitOfMeasure(body.unit_of_measure)
      updatePayload.unit_of_measure = requestedUnit
    }

    if (has('pack_size')) {
      updatePayload.pack_size = cleanNumber(body.pack_size) ?? 1
    }

    if (has('category_id')) {
      const categoryId = body.category_id ? String(body.category_id) : null
      if (categoryId) {
        const ownershipCheck = await assertCategoryOwnedByCompany(categoryId, companyId)
        if (!ownershipCheck.ok) {
          return NextResponse.json({ success: false, message: ownershipCheck.message }, { status: ownershipCheck.status })
        }
      }
      updatePayload.category_id = categoryId
    }

    if (has('hsn_code')) {
      const hsnCode = body.hsn_code ? String(body.hsn_code).trim() : null
      if (hsnCode) {
        const { data: existingHsn } = await supabaseAdmin
          .from('hsn_codes')
          .select('id')
          .eq('hsn_code', hsnCode)
          .limit(1)
          .maybeSingle()

        if (existingHsn) {
          updatePayload.hsn_code_id = existingHsn.id
        } else {
          const { data: created } = await supabaseAdmin
            .from('hsn_codes')
            .insert({ hsn_code: hsnCode, gst_rate: 18, cess_rate: 0, description: hsnCode, status: 'ACTIVE', effective_from: new Date().toISOString().split('T')[0] })
            .select('id')
            .single()
          if (created) updatePayload.hsn_code_id = created.id
        }
      } else {
        updatePayload.hsn_code_id = null
      }
    }

    // Merge technical_specs (net weight) and image into the existing JSONB so nothing is lost.
    const currentSpecs = (existing.technical_specs as Record<string, unknown>) || {}
    const mergedSpecs: Record<string, unknown> = { ...currentSpecs }
    let specsChanged = false

    if (has('technical_specs') && typeof body.technical_specs === 'object' && body.technical_specs !== null) {
      Object.assign(mergedSpecs, body.technical_specs as Record<string, unknown>)
      specsChanged = true
    }

    const hasImage = has('image_url')
    const imageUrl = hasImage ? (body.image_url ? String(body.image_url).trim() : null) : undefined
    if (hasImage) {
      mergedSpecs.image_url = imageUrl
      specsChanged = true
    }

    if (specsChanged) updatePayload.technical_specs = mergedSpecs

    if (Object.keys(updatePayload).length === 0) {
      return NextResponse.json({ success: false, message: 'No fields to update' }, { status: 400 })
    }

    const applyUpdate = (payload: Record<string, unknown>) =>
      supabaseAdmin.from('products').update(payload).eq('id', id).eq('company_id', companyId)

    // Also write the dedicated image_url column when present, but degrade gracefully
    // if that column doesn't exist (technical_specs already carries the value).
    const runUpdate = async (base: Record<string, unknown>) => {
      const withImageColumn = hasImage ? { ...base, image_url: imageUrl } : base
      let res = await applyUpdate(withImageColumn)
      if (res.error && hasImage && (isMissingColumn(res.error, 'image_url') || (res.error as { code?: string }).code === 'PGRST204')) {
        res = await applyUpdate(base)
      }
      return res
    }

    let { error } = await runUpdate(updatePayload)

    // unit_of_measure CHECK constraint on legacy schemas — fall back to a legacy unit
    // and remember the requested unit in technical_specs (mirrors POST behavior).
    if (
      error &&
      requestedUnit &&
      (error as { code?: string }).code === '23514' &&
      String(error.message || '').includes('unit_of_measure') &&
      !LEGACY_PRODUCT_UNITS.has(requestedUnit)
    ) {
      const fallbackPayload = {
        ...updatePayload,
        unit_of_measure: UNIT_FALLBACK,
        technical_specs: { ...mergedSpecs, requested_unit_of_measure: requestedUnit },
      }
      ;({ error } = await runUpdate(fallbackPayload))
    }

    if (error) {
      const msg = (error as { message?: string })?.message || 'Failed to update product'
      return NextResponse.json({ success: false, message: msg }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('[PRODUCT PATCH] error:', err)
    const message = err instanceof Error ? err.message
      : (err as { message?: string })?.message || 'Failed to update product'
    return NextResponse.json({ success: false, message }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const { authUser, companyId } = await resolveInsertCompanyId(req)
    if (!authUser) return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 })
    if (!await hasModulePermission(authUser, 'products', 'can_delete')) return NextResponse.json({ success: false, message: 'You do not have permission to delete products' }, { status: 403 })
    if (!companyId) return NextResponse.json({ success: false, message: 'Company not found' }, { status: 403 })

    await ensureProductsTable()

    const { id } = await req.json()
    if (!id) return NextResponse.json({ success: false, message: 'id required' }, { status: 400 })

    const { error: delError } = await supabaseAdmin
      .from('products')
      .delete()
      .eq('id', id)
      .eq('company_id', companyId)

    if (delError) {
      const isFkError = delError.code === '23503' || (delError.message || '').includes('foreign key')
      const message = isFkError
        ? 'This product is used in existing invoices or orders and cannot be deleted.'
        : delError.message || 'Failed to delete product'
      console.error('[PRODUCT DELETE] error:', delError.code, delError.message)
      return NextResponse.json({ success: false, message }, { status: isFkError ? 409 : 500 })
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    const message = err instanceof Error ? err.message
      : typeof err === 'object' && err !== null && 'message' in err
        ? String((err as Record<string, unknown>).message)
        : 'Failed to delete product'
    console.error('[PRODUCT DELETE] caught:', message)
    return NextResponse.json({ success: false, message }, { status: 500 })
  }
}
