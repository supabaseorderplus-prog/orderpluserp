import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, getUserFromToken, hasModulePermission, resolveCompanyScope } from '@/lib/supabase-server'

type SupabaseErrorLike = {
  code?: string
  message?: string
  details?: string
}

type CategorySchema = {
  tableExists: boolean
  hasCompanyId: boolean
  hasStatus: boolean
}

const LEGACY_COMPANY_TAG = '__CID__'

function parseLegacyCategoryName(rawName: string): { plainName: string; companyId: string | null } {
  const name = String(rawName || '')
  const idx = name.lastIndexOf(LEGACY_COMPANY_TAG)
  if (idx < 0) return { plainName: name, companyId: null }

  const plainName = name.slice(0, idx).trim()
  const companyId = name.slice(idx + LEGACY_COMPANY_TAG.length).trim() || null
  return {
    plainName: plainName || name,
    companyId,
  }
}

function encodeLegacyCategoryName(plainName: string, companyId: string): string {
  return `${plainName.trim()}${LEGACY_COMPANY_TAG}${companyId}`
}

function isLegacyCategoryOwnedByCompany(rawName: string, companyId: string): boolean {
  const parsed = parseLegacyCategoryName(rawName)
  return parsed.companyId === companyId
}

function isMissingRpc(error: SupabaseErrorLike | null | undefined): boolean {
  return error?.code === 'PGRST202' || errorText(error).includes('exec_sql')
}

async function runExecSql(sql: string): Promise<boolean> {
  const { error } = await supabaseAdmin.rpc('exec_sql', { sql })
  if (!error) return true
  if (isMissingRpc(error)) return false
  console.warn('[PRODUCT CATEGORIES] exec_sql failed:', error.message)
  return false
}

async function tryDirectDbSchemaFix(): Promise<boolean> {
  const dbUrl = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL
  if (!dbUrl || !dbUrl.includes('supabase')) return false

  try {
    const { Client } = await import('pg')
    const client = new Client({ connectionString: dbUrl })
    await client.connect()
    await client.query(`
      ALTER TABLE public.product_categories
      ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES public.parties(id) ON DELETE CASCADE;
      CREATE INDEX IF NOT EXISTS idx_product_categories_company_id ON public.product_categories(company_id);
      NOTIFY pgrst, 'reload schema';
    `)
    await client.end()
    return true
  } catch (err) {
    console.warn('[PRODUCT CATEGORIES] direct DB schema fix failed:', err)
    return false
  }
}

async function backfillLegacyCategoryOwnership(): Promise<void> {
  const { data: uncategorizedRows, error: catErr } = await supabaseAdmin
    .from('product_categories')
    .select('id, name, company_id')
    .is('company_id', null)

  if (catErr || !uncategorizedRows || uncategorizedRows.length === 0) return

  const categoryIds = uncategorizedRows.map((row) => row.id)
  const { data: productRows, error: prodErr } = await supabaseAdmin
    .from('products')
    .select('id, company_id, category_id')
    .in('category_id', categoryIds)
    .not('company_id', 'is', null)

  if (prodErr || !productRows) return

  const companiesByCategory = new Map<string, Set<string>>()
  for (const row of productRows) {
    const categoryId = row.category_id ? String(row.category_id) : null
    const companyId = row.company_id ? String(row.company_id) : null
    if (!categoryId || !companyId) continue
    if (!companiesByCategory.has(categoryId)) companiesByCategory.set(categoryId, new Set<string>())
    companiesByCategory.get(categoryId)!.add(companyId)
  }

  for (const category of uncategorizedRows) {
    const companies = Array.from(companiesByCategory.get(category.id) || [])
    if (companies.length === 0) continue

    if (companies.length === 1) {
      await supabaseAdmin
        .from('product_categories')
        .update({ company_id: companies[0] })
        .eq('id', category.id)
      continue
    }

    companies.sort()
    const ownerCompanyId = companies[0]
    await supabaseAdmin
      .from('product_categories')
      .update({ company_id: ownerCompanyId })
      .eq('id', category.id)

    for (const companyId of companies.slice(1)) {
      let clonedId: string | null = null
      const clone = await supabaseAdmin
        .from('product_categories')
        .insert({ name: category.name, company_id: companyId })
        .select('id')
        .single()

      if (!clone.error && clone.data?.id) {
        clonedId = clone.data.id
      } else {
        const existingClone = await supabaseAdmin
          .from('product_categories')
          .select('id')
          .eq('name', category.name)
          .eq('company_id', companyId)
          .maybeSingle()
        clonedId = existingClone.data?.id || null
      }

      if (clonedId) {
        await supabaseAdmin
          .from('products')
          .update({ category_id: clonedId })
          .eq('category_id', category.id)
          .eq('company_id', companyId)
      }
    }
  }
}

async function ensureCompanyScopedCategorySchema(): Promise<{ ok: boolean; message?: string }> {
  const initial = await getCategorySchema(true)
  if (!initial.tableExists) return { ok: false, message: 'Product categories table does not exist' }
  if (initial.hasCompanyId) return { ok: true }

  const addColumnSql = `
    ALTER TABLE public.product_categories
    ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES public.parties(id) ON DELETE CASCADE;
    CREATE INDEX IF NOT EXISTS idx_product_categories_company_id ON public.product_categories(company_id);
    NOTIFY pgrst, 'reload schema';
  `

  const rpcSucceeded = await runExecSql(addColumnSql)
  if (!rpcSucceeded) {
    await tryDirectDbSchemaFix()
  }

  categorySchema = null
  const refreshed = await getCategorySchema(true)
  if (!refreshed.hasCompanyId) {
    return { ok: false, message: 'Could not auto-enable company-scoped categories. Please run product category migration once.' }
  }

  await backfillLegacyCategoryOwnership()
  return { ok: true }
}

async function upsertLegacyScopedCategory(plainName: string, companyId: string): Promise<{ id: string; name: string }> {
  const scopedName = encodeLegacyCategoryName(plainName, companyId)

  const existing = await supabaseAdmin
    .from('product_categories')
    .select('id, name')
    .eq('name', scopedName)
    .maybeSingle()

  if (existing.data?.id) {
    return { id: existing.data.id, name: parseLegacyCategoryName(existing.data.name).plainName }
  }

  const created = await supabaseAdmin
    .from('product_categories')
    .insert({ name: scopedName })
    .select('id, name')
    .single()

  if (created.error || !created.data?.id) {
    const fallback = await supabaseAdmin
      .from('product_categories')
      .select('id, name')
      .eq('name', scopedName)
      .maybeSingle()

    if (!fallback.data?.id) {
      throw new Error(created.error?.message || 'Failed to create company-scoped category')
    }

    return { id: fallback.data.id, name: parseLegacyCategoryName(fallback.data.name).plainName }
  }

  return { id: created.data.id, name: parseLegacyCategoryName(created.data.name).plainName }
}

async function normalizeLegacyCategoriesForCompany(companyId: string): Promise<void> {
  const { data: productRows, error: productErr } = await supabaseAdmin
    .from('products')
    .select('id, category_id')
    .eq('company_id', companyId)
    .not('category_id', 'is', null)

  if (productErr || !productRows || productRows.length === 0) return

  const categoryIds = [...new Set(productRows.map((row) => row.category_id).filter(Boolean) as string[])]
  if (categoryIds.length === 0) return

  const { data: categoryRows, error: categoryErr } = await supabaseAdmin
    .from('product_categories')
    .select('id, name')
    .in('id', categoryIds)

  if (categoryErr || !categoryRows) return

  const categoryById = new Map<string, { id: string; name: string }>()
  for (const row of categoryRows) {
    categoryById.set(row.id, { id: row.id, name: row.name })
  }

  for (const categoryId of categoryIds) {
    const category = categoryById.get(categoryId)
    if (!category) continue
    if (isLegacyCategoryOwnedByCompany(category.name, companyId)) continue

    const plainName = parseLegacyCategoryName(category.name).plainName
    const cloned = await upsertLegacyScopedCategory(plainName, companyId)

    await supabaseAdmin
      .from('products')
      .update({ category_id: cloned.id })
      .eq('company_id', companyId)
      .eq('category_id', category.id)
  }
}

async function listLegacyCompanyCategories(companyId: string): Promise<Array<{ id: string; name: string }>> {
  await normalizeLegacyCategoriesForCompany(companyId)

  const { data: rows, error } = await supabaseAdmin
    .from('product_categories')
    .select('id, name')
    .order('name')

  if (error || !rows) return []

  return rows
    .filter((row) => isLegacyCategoryOwnedByCompany(row.name, companyId))
    .map((row) => ({ id: row.id, name: parseLegacyCategoryName(row.name).plainName }))
}

async function deleteLegacyScopedCategory(categoryId: string, companyId: string): Promise<{ success: boolean; status: number; message?: string }> {
  const { data: existing, error: findError } = await supabaseAdmin
    .from('product_categories')
    .select('id, name')
    .eq('id', categoryId)
    .maybeSingle()

  if (findError) {
    return { success: false, status: 400, message: findError.message || 'Failed to verify category' }
  }
  if (!existing) {
    return { success: false, status: 404, message: 'Category not found' }
  }
  if (!isLegacyCategoryOwnedByCompany(existing.name, companyId)) {
    return { success: false, status: 403, message: 'Access denied' }
  }

  await supabaseAdmin
    .from('products')
    .update({ category_id: null })
    .eq('company_id', companyId)
    .eq('category_id', categoryId)

  const { error: delError } = await supabaseAdmin
    .from('product_categories')
    .delete()
    .eq('id', categoryId)

  if (delError) {
    return { success: false, status: 400, message: delError.message || 'Failed to delete category' }
  }

  return { success: true, status: 200 }
}

async function resolveCompanyId(req: NextRequest): Promise<string | null> {
  const authUser = await getUserFromToken(req)
  if (!authUser) return null
  let companyId = await resolveCompanyScope(req, authUser)
  if (!companyId && authUser.party_id) companyId = authUser.party_id
  return companyId
}

let categorySchema: CategorySchema | null = null

function errorText(error: SupabaseErrorLike | null | undefined): string {
  return `${error?.code || ''} ${error?.message || ''} ${error?.details || ''}`.toLowerCase()
}

function isMissingColumn(error: SupabaseErrorLike | null | undefined, column: string): boolean {
  const text = errorText(error)
  return text.includes(column.toLowerCase()) && (
    text.includes('could not find') ||
    text.includes('schema cache') ||
    text.includes('does not exist')
  )
}

function isMissingTable(error: SupabaseErrorLike | null | undefined): boolean {
  const text = errorText(error)
  return text.includes('product_categories') && (
    text.includes('could not find the table') ||
    text.includes('schema cache') ||
    text.includes('does not exist')
  )
}

async function getCategorySchema(forceRefresh = false): Promise<CategorySchema> {
  if (categorySchema && !forceRefresh) return categorySchema

  const tableProbe = await supabaseAdmin
    .from('product_categories')
    .select('id, name')
    .limit(0)

  if (tableProbe.error) {
    categorySchema = {
      tableExists: !isMissingTable(tableProbe.error),
      hasCompanyId: false,
      hasStatus: false,
    }
    return categorySchema
  }

  const [companyProbe, statusProbe] = await Promise.all([
    supabaseAdmin.from('product_categories').select('company_id').limit(0),
    supabaseAdmin.from('product_categories').select('status').limit(0),
  ])

  categorySchema = {
    tableExists: true,
    hasCompanyId: !companyProbe.error,
    hasStatus: !statusProbe.error,
  }
  return categorySchema
}

export async function GET(req: NextRequest) {
  try {
    const authUser = await getUserFromToken(req)
    if (!authUser) return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 })
    if (!await hasModulePermission(authUser, 'products', 'can_view')) return NextResponse.json({ success: false, message: 'You do not have permission to view product categories' }, { status: 403 })
    const companyId = await resolveCompanyId(req)
    if (!companyId) {
      return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 })
    }

    let schema = await getCategorySchema()
    if (!schema.tableExists) {
      return NextResponse.json({ success: true, data: [] })
    }

    if (!schema.hasCompanyId) {
      const ensured = await ensureCompanyScopedCategorySchema()
      if (ensured.ok) {
        schema = await getCategorySchema(true)
      }
    }

    if (!schema.hasCompanyId) {
      const legacyRows = await listLegacyCompanyCategories(companyId)
      return NextResponse.json({ success: true, data: legacyRows })
    }

    let query = supabaseAdmin
      .from('product_categories')
      .select('id, name')
      .order('name')

    if (schema.hasStatus) query = query.neq('status', 'DELETED')
    query = query.eq('company_id', companyId)

    let { data, error } = await query

    if (error && schema.hasCompanyId && isMissingColumn(error, 'company_id')) {
      const ensured = await ensureCompanyScopedCategorySchema()
      if (!ensured.ok) {
        const legacyRows = await listLegacyCompanyCategories(companyId)
        return NextResponse.json({ success: true, data: legacyRows })
      }
      schema = await getCategorySchema(true)
      let retryQuery = supabaseAdmin
        .from('product_categories')
        .select('id, name')
        .order('name')
        .eq('company_id', companyId)
      if (schema.hasStatus) retryQuery = retryQuery.neq('status', 'DELETED')
      const retry = await retryQuery
      data = retry.data
      error = retry.error
    }

    if (error && schema.hasStatus && isMissingColumn(error, 'status')) {
      let retryQuery = supabaseAdmin
        .from('product_categories')
        .select('id, name')
        .order('name')
      retryQuery = retryQuery.eq('company_id', companyId)
      const retry = await retryQuery
      data = retry.data
      error = retry.error
    }

    if (error) {
      if (isMissingTable(error)) return NextResponse.json({ success: true, data: [] })
      throw error
    }

    const normalized = (data || []).map((row) => {
      const parsed = parseLegacyCategoryName(row.name)
      return {
        id: row.id,
        name: parsed.plainName,
      }
    })

    return NextResponse.json({ success: true, data: normalized })
  } catch (err) {
    return NextResponse.json({ success: false, message: err instanceof Error ? err.message : 'Failed to fetch categories' }, { status: 400 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const authUser = await getUserFromToken(request)
    if (!authUser) return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 })
    if (!await hasModulePermission(authUser, 'products', 'can_create')) return NextResponse.json({ success: false, message: 'You do not have permission to create product categories' }, { status: 403 })
    const companyId = await resolveCompanyId(request)
    if (!companyId) {
      return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 })
    }

    const body = await request.json()
    const name = (body.name || '').trim()
    if (!name) return NextResponse.json({ success: false, message: 'Category name is required' }, { status: 400 })

    let schema = await getCategorySchema()
    if (!schema.tableExists) {
      return NextResponse.json({ success: false, message: 'Product categories are not set up yet' }, { status: 400 })
    }
    if (!schema.hasCompanyId) {
      const ensured = await ensureCompanyScopedCategorySchema()
      if (!ensured.ok) {
        const legacy = await upsertLegacyScopedCategory(name, companyId)
        return NextResponse.json({ success: true, data: legacy })
      }
      schema = await getCategorySchema(true)
    }

    const insertPayload: Record<string, unknown> = { name }
    insertPayload.company_id = companyId

    let { data, error } = await supabaseAdmin
      .from('product_categories')
      .insert(insertPayload)
      .select('id, name')
      .single()

    if (error && schema.hasCompanyId && isMissingColumn(error, 'company_id')) {
      const ensured = await ensureCompanyScopedCategorySchema()
      if (!ensured.ok) {
        const legacy = await upsertLegacyScopedCategory(name, companyId)
        return NextResponse.json({ success: true, data: legacy })
      }

      const retry = await supabaseAdmin
        .from('product_categories')
        .insert({ name, company_id: companyId })
        .select('id, name')
        .single()
      data = retry.data
      error = retry.error
    }

    if (error) throw error
    return NextResponse.json({ success: true, data })
  } catch (err) {
    return NextResponse.json({ success: false, message: (err as { message?: string })?.message || 'Failed to create category' }, { status: 400 })
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const authUser = await getUserFromToken(request)
    if (!authUser) return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 })
    if (!await hasModulePermission(authUser, 'products', 'can_delete')) return NextResponse.json({ success: false, message: 'You do not have permission to delete product categories' }, { status: 403 })
    const companyId = await resolveCompanyId(request)
    if (!companyId) {
      return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 })
    }

    const body = await request.json()
    if (!body.id) return NextResponse.json({ success: false, message: 'Category id is required' }, { status: 400 })

    let schema = await getCategorySchema()
    if (!schema.tableExists) {
      return NextResponse.json({ success: true })
    }
    if (!schema.hasCompanyId) {
      const ensured = await ensureCompanyScopedCategorySchema()
      if (!ensured.ok) {
        const deleted = await deleteLegacyScopedCategory(body.id, companyId)
        if (!deleted.success) {
          return NextResponse.json({ success: false, message: deleted.message || 'Failed to delete category' }, { status: deleted.status })
        }
        return NextResponse.json({ success: true })
      }
      schema = await getCategorySchema(true)
    }

    // Verify the category exists and the caller is allowed to delete it
    const { data: existing } = await supabaseAdmin
      .from('product_categories')
      .select('id, company_id')
      .eq('id', body.id)
      .maybeSingle()

    if (!existing) {
      return NextResponse.json({ success: false, message: 'Category not found' }, { status: 404 })
    }

    // Strict isolation: never allow deleting null-company or foreign-company categories.
    if (existing.company_id !== companyId) {
      return NextResponse.json({ success: false, message: 'Access denied' }, { status: 403 })
    }

    // Unlink all products from this category first (to avoid FK constraint failure)
    const unlinkResult = await supabaseAdmin
      .from('products')
      .update({ category_id: null })
      .eq('category_id', body.id)
      .eq('company_id', companyId)

    if (unlinkResult.error) {
      console.warn('[CATEGORY DELETE] unlink warning:', unlinkResult.error.message)
    }

    // Delete by id only — ownership already verified above
    const { error } = await supabaseAdmin
      .from('product_categories')
      .delete()
      .eq('id', body.id)
      .eq('company_id', companyId)

    if (error) throw error
    return NextResponse.json({ success: true })
  } catch (err) {
    return NextResponse.json({ success: false, message: (err as { message?: string })?.message || 'Failed to delete category' }, { status: 400 })
  }
}
