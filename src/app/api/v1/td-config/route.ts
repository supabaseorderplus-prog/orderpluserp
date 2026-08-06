import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, getUserFromToken, resolveCompanyScope } from '@/lib/supabase-server'

type DbErrorLike = { code?: string; message?: string; details?: string; hint?: string } | null | undefined

const SCHEMA_ERROR_CODES = new Set(['42P01', '42703', 'PGRST200', 'PGRST204'])
const PRICING_SCHEMA_NOT_READY_MESSAGE =
  'Pricing schema is not ready yet for company-scoped pricing. Please run pricing migration once.'

function errorText(err: DbErrorLike): string {
  return `${err?.code || ''} ${err?.message || ''} ${err?.details || ''} ${err?.hint || ''}`.toLowerCase()
}

function isPricingSchemaGap(err: DbErrorLike): boolean {
  if (!err) return false
  if (err.code && SCHEMA_ERROR_CODES.has(err.code)) return true
  const text = errorText(err)
  return text.includes('schema cache') || text.includes('does not exist') || text.includes('relation') || text.includes('could not find') || text.includes('column')
}

function isMissingCompanyIdColumn(err: DbErrorLike): boolean {
  const text = errorText(err)
  return text.includes('company_id') && isPricingSchemaGap(err)
}

async function ensurePricingSchema(): Promise<void> {
  // no-op at request time; API handlers already gracefully handle schema gaps
}

const isRelErr = (err: { code?: string; message?: string } | null | undefined) =>
  !!err && (err.code === 'PGRST200' || err.code === 'PGRST204' || err.code === '42703' ||
    !!(err.message?.includes('relationship') || err.message?.includes('Could not find')))

async function fetchConfigTable(table: 'td_config' | 'cd_config', companyId: string | null, partyType: string, partyId: string) {
  const build = (select: string) => {
    let q = supabaseAdmin.from(table).select(select).eq('status', 'ACTIVE').order('created_at', { ascending: false })
    if (companyId) q = q.eq('company_id', companyId)
    if (partyType) q = q.eq('applicable_party_type', partyType)
    if (partyId) q = q.eq('party_id', partyId)
    return q
  }
  let { data, error } = await build('*, parties(name, party_code)')
  if (error && isRelErr(error as { code?: string; message?: string })) {
    const retry = await build('*')
    data = retry.data; error = retry.error
  }
  if (error) {
    if (isMissingCompanyIdColumn(error as { code?: string; message?: string })) return []
    if (isPricingSchemaGap(error as { code?: string; message?: string })) return []
    throw error
  }
  return data || []
}

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url)
    const partyType = url.searchParams.get('party_type') || ''
    const partyId = url.searchParams.get('party_id') || ''

    const authUser = await getUserFromToken(req)
    if (!authUser) {
      return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 })
    }
    const companyId = await resolveCompanyScope(req, authUser)
    if (!companyId) {
      return NextResponse.json({ success: false, message: 'Select a company to view pricing data' }, { status: 403 })
    }

    await ensurePricingSchema()

    const [tdData, cdData] = await Promise.all([
      fetchConfigTable('td_config', companyId, partyType, partyId),
      fetchConfigTable('cd_config', companyId, partyType, partyId),
    ])

    return NextResponse.json({ success: true, data: { td: tdData, cd: cdData } })
  } catch (err) {
    const msg = (err as { message?: string })?.message || 'Failed to fetch TD/CD config'
    const status = msg === PRICING_SCHEMA_NOT_READY_MESSAGE ? 503 : 500
    return NextResponse.json({ success: false, message: msg }, { status })
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { type, ...configData } = body

    // CRITICAL: Get company scope and stamp it on new records
    const authUser = await getUserFromToken(req)
    if (!authUser) {
      return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 })
    }
    const companyId = await resolveCompanyScope(req, authUser)
    if (!companyId) {
      return NextResponse.json({ success: false, message: 'Select a company before creating pricing config' }, { status: 403 })
    }

    await ensurePricingSchema()

    const insertData: Record<string, unknown> = { ...configData }
    insertData.company_id = companyId

    if (type === 'cd') {
      const { data, error } = await supabaseAdmin.from('cd_config').insert(insertData).select().single()
      if (error) {
        if (isPricingSchemaGap(error as { code?: string; message?: string })) {
          return NextResponse.json({ success: false, message: PRICING_SCHEMA_NOT_READY_MESSAGE }, { status: 503 })
        }
        throw error
      }
      return NextResponse.json({ success: true, data }, { status: 201 })
    }

    const { data, error } = await supabaseAdmin.from('td_config').insert(insertData).select().single()
    if (error) {
      if (isPricingSchemaGap(error as { code?: string; message?: string })) {
        return NextResponse.json({ success: false, message: PRICING_SCHEMA_NOT_READY_MESSAGE }, { status: 503 })
      }
      throw error
    }
    return NextResponse.json({ success: true, data }, { status: 201 })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to create config'
    const status = msg === PRICING_SCHEMA_NOT_READY_MESSAGE ? 503 : 500
    return NextResponse.json({ success: false, message: msg }, { status })
  }
}

export async function PUT(req: NextRequest) {
  try {
    const body = await req.json()
    const { type, id, ...configData } = body

    // CRITICAL: Verify the record belongs to the user's company before updating
    const authUser = await getUserFromToken(req)
    if (!authUser) {
      return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 })
    }
    const companyId = await resolveCompanyScope(req, authUser)
    if (!companyId) {
      return NextResponse.json({ success: false, message: 'Select a company before updating pricing config' }, { status: 403 })
    }

    await ensurePricingSchema()

    const table = type === 'cd' ? 'cd_config' : 'td_config'

    const { data: existing, error: existingError } = await supabaseAdmin
      .from(table)
      .select('company_id')
      .eq('id', id)
      .eq('company_id', companyId)
      .maybeSingle()

    if (existingError && isPricingSchemaGap(existingError as { code?: string; message?: string })) {
      return NextResponse.json({ success: false, message: PRICING_SCHEMA_NOT_READY_MESSAGE }, { status: 503 })
    }

    if (!existing) {
      return NextResponse.json({ success: false, message: 'Config not found or access denied' }, { status: 403 })
    }

    const { data, error } = await supabaseAdmin
      .from(table)
      .update({ ...configData, updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('company_id', companyId)
      .select()
      .single()

    if (error) {
      if (isPricingSchemaGap(error as { code?: string; message?: string })) {
        return NextResponse.json({ success: false, message: PRICING_SCHEMA_NOT_READY_MESSAGE }, { status: 503 })
      }
      throw error
    }
    return NextResponse.json({ success: true, data })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to update config'
    const status = msg === PRICING_SCHEMA_NOT_READY_MESSAGE ? 503 : 500
    return NextResponse.json({ success: false, message: msg }, { status })
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const url = new URL(req.url)
    const id = url.searchParams.get('id')
    const type = url.searchParams.get('type') || 'td'

    if (!id) throw new Error('ID required')

    // CRITICAL: Verify the record belongs to the user's company before deleting
    const authUser = await getUserFromToken(req)
    if (!authUser) {
      return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 })
    }
    const companyId = await resolveCompanyScope(req, authUser)
    if (!companyId) {
      return NextResponse.json({ success: false, message: 'Select a company before deleting pricing config' }, { status: 403 })
    }

    await ensurePricingSchema()

    const table = type === 'cd' ? 'cd_config' : 'td_config'

    const { data: existing, error: existingError } = await supabaseAdmin
      .from(table)
      .select('company_id')
      .eq('id', id)
      .eq('company_id', companyId)
      .maybeSingle()

    if (existingError && isPricingSchemaGap(existingError as { code?: string; message?: string })) {
      return NextResponse.json({ success: false, message: PRICING_SCHEMA_NOT_READY_MESSAGE }, { status: 503 })
    }

    if (!existing) {
      return NextResponse.json({ success: false, message: 'Config not found or access denied' }, { status: 403 })
    }

    const { error } = await supabaseAdmin
      .from(table)
      .update({ status: 'DELETED', updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('company_id', companyId)

    if (error) {
      if (isPricingSchemaGap(error as { code?: string; message?: string })) {
        return NextResponse.json({ success: false, message: PRICING_SCHEMA_NOT_READY_MESSAGE }, { status: 503 })
      }
      throw error
    }
    return NextResponse.json({ success: true })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to delete config'
    const status = msg === PRICING_SCHEMA_NOT_READY_MESSAGE ? 503 : 500
    return NextResponse.json({ success: false, message: msg }, { status })
  }
}
