import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, getUserFromToken, resolveCompanyScope } from '@/lib/supabase-server'
import { schemePartiesTableIsReady } from '@/lib/scheme-parties-schema'
import {
  SCHEME_PARTY_TYPES,
  type SchemePartyType,
  type SchemeScopeMode,
  encodeSchemeScopeTerms,
  mapSchemeScopeForResponse,
  normalizeSchemePartyType,
} from '@/lib/scheme-scope'

function isTokenSchemeRecord(row: { scheme_type?: string | null; reward_type?: string | null }) {
  return row.scheme_type === 'VOLUME_SLAB' && row.reward_type === 'POINTS'
}

function mapSchemeForResponse<T extends {
  scheme_type?: string | null
  reward_type?: string | null
  applicable_party_type?: string | null
  terms_conditions?: string | null
}>(row: T): T {
  const scopedRow = mapSchemeScopeForResponse(row)
  if (!isTokenSchemeRecord(scopedRow)) return scopedRow
  return { ...scopedRow, scheme_type: 'TOKEN_SCHEME' } as T
}

function extractMessage(err: unknown, fallback: string): string {
  if (err instanceof Error) return err.message
  if (err && typeof err === 'object' && 'message' in err) return String((err as { message: unknown }).message)
  return fallback
}

type SchemePartyEnrollmentRow = { scheme_id: string; party_id: string }
type SchemePartyLookupRow = {
  id: string
  name: string | null
}
type SchemeUserLookupRow = {
  id: string
  name: string | null
  email: string | null
}

type DbError = {
  code?: string
  message?: string
  details?: string
  hint?: string
}

function isSchemesPartyTypeConstraintError(error: DbError | null): boolean {
  if (!error || error.code !== '23514') return false
  const text = `${error.message || ''} ${error.details || ''} ${error.hint || ''}`
  return text.includes('schemes_applicable_party_type_check')
}

async function refreshSchemesPartyTypeConstraint() {
  const statements = [
    `ALTER TABLE public.schemes DROP CONSTRAINT IF EXISTS schemes_applicable_party_type_check;`,
    `ALTER TABLE public.schemes ADD CONSTRAINT schemes_applicable_party_type_check CHECK (applicable_party_type IN ('COMPANY','CNF','SUPER_DEALER','RETAILER','SALESMAN','MANUFACTURER','ALL','INDIVIDUAL'));`,
    `NOTIFY pgrst, 'reload schema';`,
  ]

  for (const sql of statements) {
    const { error } = await supabaseAdmin.rpc('exec_sql', { sql })
    if (error) throw error
  }
}

function buildConstraintSafeInsertData(params: {
  insertData: Record<string, unknown>
  applicablePartyType: SchemePartyType
  individualPartyType: SchemePartyType | null
  scopeMode: SchemeScopeMode
  isTokenSchemeRequest: boolean
  originalTermsConditions: unknown
  partyNames?: string[]
}): Record<string, unknown> {
  if (params.isTokenSchemeRequest) {
    return {
      ...params.insertData,
      applicable_party_type: 'ALL',
    }
  }

  return {
    ...params.insertData,
    applicable_party_type: 'ALL',
    terms_conditions: encodeSchemeScopeTerms({
      termsConditions: params.originalTermsConditions,
      mode: params.scopeMode,
      applicablePartyType: params.applicablePartyType,
      individualPartyType: params.individualPartyType,
      partyNames: params.partyNames,
    }),
  }
}

async function resolveCompanyId(req: NextRequest): Promise<{ companyId: string | null; isSuperAdmin: boolean }> {
  const authUser = await getUserFromToken(req)
  const companyId = await resolveCompanyScope(req, authUser)
  return { companyId, isSuperAdmin: authUser?.role === 'SUPER_ADMIN' }
}

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url)
    const type = url.searchParams.get('type')
    const partyType = url.searchParams.get('partyType')
    const active = url.searchParams.get('active')
    const page = parseInt(url.searchParams.get('page') || '1')
    const limit = parseInt(url.searchParams.get('limit') || '20')
    const offset = (page - 1) * limit

    // CRITICAL: Get company scope to ensure data isolation
    const authUser = await getUserFromToken(req)
    const companyId = await resolveCompanyScope(req, authUser)

    // Fail closed: non-SUPER_ADMIN with no resolvable company sees nothing
    if (!companyId && authUser?.role !== 'SUPER_ADMIN') {
      return NextResponse.json({
        success: true,
        data: [],
        pagination: { page, limit, total: 0, pages: 0 },
      })
    }

    let query = supabaseAdmin
      .from('schemes')
      .select('*, territories(name)', { count: 'exact' })
      .order('start_date', { ascending: false })
      .range(offset, offset + limit - 1)

    if (companyId) {
      query = query.eq('company_id', companyId)
    }

    if (type === 'TOKEN_SCHEME') {
      query = query.eq('scheme_type', 'VOLUME_SLAB').eq('reward_type', 'POINTS')
    } else if (type) {
      query = query.eq('scheme_type', type)
    }

    if (active === 'true') {
      const today = new Date().toISOString().split('T')[0]
      query = query.lte('start_date', today).gte('end_date', today).eq('status', 'ACTIVE')
    }

    const { data, count, error } = await query
    if (error) throw error

    const mappedData = (data || []).map(mapSchemeForResponse)
    const normalizedPartyType = normalizeSchemePartyType(partyType)
    const filteredData = normalizedPartyType
      ? mappedData.filter((scheme) => scheme.applicable_party_type === normalizedPartyType)
      : mappedData

    // Attach enrolled party names for INDIVIDUAL schemes
    const individualIds = filteredData
      .filter((s) => s.applicable_party_type === 'INDIVIDUAL')
      .map((s) => s.id)

    const partyNamesMap: Record<string, string[]> = {}
    if (individualIds.length > 0 && await schemePartiesTableIsReady()) {
      const { data: spRows, error: spErr } = await supabaseAdmin
        .from('scheme_parties')
        .select('scheme_id, party_id')
        .in('scheme_id', individualIds)
      const enrollmentRows = spErr ? [] : ((spRows || []) as SchemePartyEnrollmentRow[])
      const enrolledIds = [...new Set(enrollmentRows.map((row) => row.party_id).filter(Boolean))]

      if (enrolledIds.length > 0) {
        const [partyRes, userRes, appUserRes] = await Promise.all([
          supabaseAdmin.from('parties').select('id, name').in('id', enrolledIds),
          supabaseAdmin.from('users').select('id, name, email').in('id', enrolledIds).then((r) => (r.error ? { data: [] } : r)),
          supabaseAdmin.from('app_users').select('id, name, email').in('id', enrolledIds).then((r) => (r.error ? { data: [] } : r)),
        ])
        const namesById = new Map<string, string>()
        for (const party of (partyRes.data || []) as SchemePartyLookupRow[]) {
          if (party.name) namesById.set(party.id, party.name)
        }
        for (const user of [
          ...(((userRes.data || []) as SchemeUserLookupRow[])),
          ...(((appUserRes.data || []) as SchemeUserLookupRow[])),
        ]) {
          if (!namesById.has(user.id)) namesById.set(user.id, user.name || user.email || 'Salesman')
        }

        for (const row of enrollmentRows) {
          const name = namesById.get(row.party_id)
          if (!name) continue
          if (!partyNamesMap[row.scheme_id]) partyNamesMap[row.scheme_id] = []
          partyNamesMap[row.scheme_id].push(name)
        }
      }
    }

    const enrichedData = filteredData.map((s) => {
      if (s.applicable_party_type !== 'INDIVIDUAL') return s
      // Prefer live scheme_parties data; fall back to names embedded in terms_conditions by mapSchemeForResponse
      const liveNames = partyNamesMap[s.id]
      const fallbackNames = (s as Record<string, unknown>).enrolled_party_names as string[] | undefined
      return { ...s, enrolled_party_names: (liveNames && liveNames.length > 0) ? liveNames : (fallbackNames ?? []) }
    })

    return NextResponse.json({
      success: true,
      data: enrichedData,
      pagination: { page, limit, total: count || 0, pages: Math.ceil((count || 0) / limit) },
    })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed to fetch schemes' },
      { status: 500 }
    )
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as Record<string, unknown>

    if (!body.name || !body.scheme_type || !body.applicable_party_type || !body.start_date || !body.end_date) {
      return NextResponse.json(
        { success: false, message: 'name, scheme_type, applicable_party_type, start_date, end_date required' },
        { status: 400 }
      )
    }

    const applicablePartyType = normalizeSchemePartyType(body.applicable_party_type)
    if (!applicablePartyType) {
      return NextResponse.json(
        {
          success: false,
          message: `Invalid applicable_party_type. Use one of: ${SCHEME_PARTY_TYPES.join(', ')}`,
        },
        { status: 400 }
      )
    }
    body.applicable_party_type = applicablePartyType
    const originalTermsConditions = body.terms_conditions
    const individualPartyType = normalizeSchemePartyType(body.individual_party_type)
    const scopeMode: SchemeScopeMode =
      body.scope_mode === 'INDIVIDUAL' || applicablePartyType === 'INDIVIDUAL'
        ? 'INDIVIDUAL'
        : 'GROUP'
    const partyNames = Array.isArray(body.party_names)
      ? (body.party_names as unknown[]).filter((n): n is string => typeof n === 'string')
      : []
    delete body.scope_mode
    delete body.individual_party_type
    delete body.party_names

    const { companyId } = await resolveCompanyId(req)

    const isTokenSchemeRequest = body.scheme_type === 'TOKEN_SCHEME'
    if (isTokenSchemeRequest) {
      body.scheme_type = 'VOLUME_SLAB'
      body.reward_type = 'POINTS'
      body.target_type = body.target_type || 'VALUE'
      body.reward_value = Number(body.reward_value || 1)
    }

    const seq = Date.now().toString(36).toUpperCase()
    const codeType = isTokenSchemeRequest ? 'TOK' : String(body.scheme_type).substring(0, 3)
    body.scheme_code = body.scheme_code || `SCH-${codeType}-${seq}`

    // Always encode scope metadata for INDIVIDUAL schemes so party names survive even if scheme_parties table is unavailable
    if (scopeMode === 'INDIVIDUAL' && !isTokenSchemeRequest) {
      body.terms_conditions = encodeSchemeScopeTerms({
        termsConditions: originalTermsConditions,
        mode: 'INDIVIDUAL',
        applicablePartyType,
        individualPartyType,
        partyNames,
      })
    }

    const insertData: Record<string, unknown> = { ...body }
    if (companyId) {
      insertData.company_id = companyId
    }

    let { data, error } = await supabaseAdmin.from('schemes').insert(insertData).select().single()
    if (isSchemesPartyTypeConstraintError(error)) {
      try {
        await refreshSchemesPartyTypeConstraint()
        const retry = await supabaseAdmin.from('schemes').insert(insertData).select().single()
        data = retry.data
        error = retry.error
      } catch (constraintErr) {
        console.error('[POST /api/v1/schemes] Constraint refresh failed:', constraintErr)
      }
    }
    if (isSchemesPartyTypeConstraintError(error)) {
      const fallbackInsertData = buildConstraintSafeInsertData({
        insertData,
        applicablePartyType,
        individualPartyType,
        scopeMode,
        isTokenSchemeRequest,
        originalTermsConditions,
        partyNames,
      })
      const fallback = await supabaseAdmin.from('schemes').insert(fallbackInsertData).select().single()
      data = fallback.data
      error = fallback.error
    }

    if (error) {
      console.error('[POST /api/v1/schemes] Supabase error:', JSON.stringify(error))
      return NextResponse.json(
        { success: false, message: error.message || error.details || 'Failed to create scheme' },
        { status: 500 }
      )
    }

    return NextResponse.json({ success: true, data: mapSchemeForResponse(data) }, { status: 201 })
  } catch (err) {
    console.error('[POST /api/v1/schemes] Error:', err)
    return NextResponse.json(
      { success: false, message: extractMessage(err, 'Failed to create scheme') },
      { status: 500 }
    )
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json()
    const { id, ...fields } = body
    if (!id) return NextResponse.json({ success: false, message: 'id required' }, { status: 400 })

    const { companyId, isSuperAdmin } = await resolveCompanyId(req)

    // Fail closed: non-SUPER_ADMIN with no resolvable company cannot modify any scheme
    if (!companyId && !isSuperAdmin) {
      return NextResponse.json({ success: false, message: 'Scheme not found or access denied' }, { status: 403 })
    }

    if (companyId) {
      const { data: scheme } = await supabaseAdmin
        .from('schemes')
        .select('company_id')
        .eq('id', id)
        .single()

      if (!scheme) {
        return NextResponse.json({ success: false, message: 'Scheme not found' }, { status: 404 })
      }
      if (scheme.company_id !== companyId) {
        return NextResponse.json({ success: false, message: 'Scheme not found or access denied' }, { status: 403 })
      }
    }

    const { data, error } = await supabaseAdmin.from('schemes').update(fields).eq('id', id).select().single()
    if (error) throw error

    return NextResponse.json({ success: true, data })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed to update scheme' },
      { status: 500 }
    )
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const id = new URL(req.url).searchParams.get('id')
    if (!id) return NextResponse.json({ success: false, message: 'id required' }, { status: 400 })

    const { companyId, isSuperAdmin } = await resolveCompanyId(req)

    // Fail closed: non-SUPER_ADMIN with no resolvable company cannot delete any scheme
    if (!companyId && !isSuperAdmin) {
      return NextResponse.json({ success: false, message: 'Scheme not found or access denied' }, { status: 403 })
    }

    if (companyId) {
      const { data: scheme } = await supabaseAdmin
        .from('schemes')
        .select('company_id')
        .eq('id', id)
        .single()

      if (!scheme) {
        return NextResponse.json({ success: false, message: 'Scheme not found' }, { status: 404 })
      }
      if (scheme.company_id !== companyId) {
        return NextResponse.json({ success: false, message: 'Scheme not found or access denied' }, { status: 403 })
      }
    }

    // Delete all related records that may have FK constraints
    await supabaseAdmin.from('scheme_progress').delete().eq('scheme_id', id)
    await supabaseAdmin.from('token_balances').delete().eq('scheme_id', id)
    await supabaseAdmin.from('scheme_parties').delete().eq('scheme_id', id)

    const { error } = await supabaseAdmin.from('schemes').delete().eq('id', id)
    if (error) {
      console.error('[DELETE /api/v1/schemes] Supabase error:', JSON.stringify(error))
      return NextResponse.json(
        { success: false, message: error.message || error.details || 'Failed to delete scheme' },
        { status: 500 }
      )
    }

    return NextResponse.json({ success: true })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : typeof err === 'object' && err !== null && 'message' in err ? String((err as { message: string }).message) : 'Failed to delete scheme'
    console.error('[DELETE /api/v1/schemes] Error:', err)
    return NextResponse.json(
      { success: false, message },
      { status: 500 }
    )
  }
}
