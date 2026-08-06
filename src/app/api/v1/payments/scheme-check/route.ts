import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, getUserFromToken, resolveCompanyScope } from '@/lib/supabase-server'
import { parseSchemeScopeMeta, getSchemePartyTypesForUser } from '@/lib/scheme-scope'
import { resolveSchemeCompanyId } from '@/lib/scheme-progress'
import { loadSchemeAdjustments } from '@/lib/scheme-adjust-fallback'
import { computeSchemeRoster, type SchemeForRoster } from '@/lib/scheme-roster'

type DbError = { code?: string; message?: string; details?: string }
type SchemeRow = {
  id: string
  name?: string | null
  description?: string | null
  scheme_type?: string | null
  reward_type?: string | null
  reward_description?: string | null
  target_value?: number | string | null
  start_date?: string | null
  end_date?: string | null
  company_id?: string | null
  applicable_party_type?: string | null
  terms_conditions?: string | null
}

function isMissingSchemaPiece(error: DbError | null | undefined, column?: string) {
  if (!error) return false
  const text = `${error.message || ''} ${error.details || ''}`.toLowerCase()
  return (
    error.code === '42P01' ||
    error.code === '42703' ||
    error.code === 'PGRST200' ||
    error.code === 'PGRST204' ||
    error.code === 'PGRST205' ||
    text.includes('schema cache') ||
    text.includes('could not find') ||
    (column ? text.includes(column.toLowerCase()) : text.includes('column'))
  )
}

async function fetchActiveSchemes(companyId: string | null, today: string) {
  const selectAttempts = [
    'id, name, description, scheme_type, reward_type, target_value, start_date, end_date, applicable_party_type, terms_conditions, reward_description',
    'id, name, description, scheme_type, reward_type, target_value, start_date, end_date, applicable_party_type, terms_conditions',
    'id, name, scheme_type, target_value, start_date, end_date, applicable_party_type, terms_conditions',
    'id, name, target_value, start_date, end_date, applicable_party_type',
    'id, name, target_value, end_date, applicable_party_type',
  ]

  let lastError: DbError | null = null
  for (const selectClause of selectAttempts) {
    for (const includeCompanyScope of [Boolean(companyId), false]) {
      let query = supabaseAdmin
        .from('schemes')
        .select(selectClause)
        .eq('status', 'ACTIVE')

      if (selectClause.includes('start_date')) query = query.lte('start_date', today)
      if (selectClause.includes('end_date')) query = query.gte('end_date', today)
      if (includeCompanyScope && companyId) query = query.eq('company_id', companyId)

      const { data, error } = await query
      if (!error) return { data: (data || []) as unknown as SchemeRow[], error: null }

      lastError = error
      if (!isMissingSchemaPiece(error)) return { data: [] as SchemeRow[], error }
    }
  }

  return { data: [] as SchemeRow[], error: lastError }
}

// GET /api/v1/payments/scheme-check?party_id=XXX
// Returns active schemes applicable to the given party so the UI can
// ask the user whether to apply the incoming payment toward a scheme.
export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url)
    const partyId = url.searchParams.get('party_id')
    if (!partyId) {
      return NextResponse.json({ success: false, message: 'party_id required' }, { status: 400 })
    }

    const authUser = await getUserFromToken(req)
    const scopeId = await resolveCompanyScope(req, authUser)
    // Schemes are stored under the paid party's ROOT company, which is not
    // necessarily the collector's own scope. Walk up to it so the scheme query
    // matches — mirroring GET /api/v1/schemes/my (resolveSchemeCompanyId).
    const companyId = await resolveSchemeCompanyId(partyId, scopeId)

    const today = new Date().toISOString().split('T')[0]

    // Get the party's type + name. If the relationship is not available in an
    // older schema, continue with null type so ALL/individual schemes still work.
    const { data: partyRow, error: partyErr } = await supabaseAdmin
      .from('parties')
      .select('id, name, party_types(name)')
      .eq('id', partyId)
      .maybeSingle()
    if (partyErr && !isMissingSchemaPiece(partyErr)) throw partyErr

    const rawPT = partyRow?.party_types as unknown
    const partyTypeName: string | null = Array.isArray(rawPT)
      ? (rawPT[0]?.name ?? null)
      : ((rawPT as { name: string } | null)?.name ?? null)
    // Normalize the raw party-type name (e.g. "Super Dealer") to the scheme enum
    // form (e.g. "SUPER_DEALER") so type-scoped schemes actually match. The old
    // raw-string equality never matched and silently hid every type scheme.
    const matchingPartyTypes = getSchemePartyTypesForUser({ partyTypeName })
    // Names used to match INDIVIDUAL schemes that embed party names in
    // terms_conditions at creation time (same fallback as /schemes/my).
    const partyName: string | null = partyRow?.name ?? null
    const partyNameKeys = new Set(
      [partyName].filter((v): v is string => Boolean(v)).map((v) => v.trim().toLowerCase()),
    )

    const [schemesResult, enrolledResult] = await Promise.all([
      fetchActiveSchemes(companyId, today),
      supabaseAdmin.from('scheme_parties').select('scheme_id').eq('party_id', partyId),
    ])

    if (schemesResult.error) {
      if (isMissingSchemaPiece(schemesResult.error)) {
        return NextResponse.json({ success: true, data: [], warning: schemesResult.error.message || 'Scheme schema unavailable' })
      }
      throw schemesResult.error
    }

    const allSchemes = schemesResult.data || []
    const enrolledRows = enrolledResult.error ? [] : (enrolledResult.data || [])
    const enrolledIds = new Set((enrolledRows || []).map((e: { scheme_id: string }) => e.scheme_id))

    const applicable = (allSchemes || []).filter(
      (s: SchemeRow) => {
        if (enrolledIds.has(s.id)) return true
        const scope = parseSchemeScopeMeta(s.terms_conditions, s.applicable_party_type || 'ALL')
        // INDIVIDUAL schemes: primary match is scheme_parties enrollment (checked
        // above); fallback is party names embedded in terms_conditions. This
        // mirrors /schemes/my — dropping them here hid name-assigned schemes.
        if (scope.mode === 'INDIVIDUAL') {
          return scope.partyNames.some((name) => partyNameKeys.has(name.trim().toLowerCase()))
        }
        return (
          scope.applicablePartyType === 'ALL' ||
          matchingPartyTypes.includes(scope.applicablePartyType)
        )
      },
    )

    if (applicable.length === 0) {
      return NextResponse.json({ success: true, data: [] })
    }

    // Fetch current progress for each applicable scheme for this party
    const schemeIds = applicable.map((s: { id: string }) => s.id)
    const { data: progressRows, error: progressErr } = await supabaseAdmin
      .from('scheme_progress')
      .select('scheme_id, current_value, target_value, progress_percent, is_achieved')
      .eq('party_id', partyId)
      .in('scheme_id', schemeIds)
    const safeProgressRows = progressErr && isMissingSchemaPiece(progressErr) ? [] : (progressRows || [])
    if (progressErr && !isMissingSchemaPiece(progressErr)) throw progressErr

    type ProgressRow = { scheme_id: string; current_value: number; target_value: number; progress_percent: number; is_achieved: boolean }
    const progressMap = new Map(
      safeProgressRows.map((p: ProgressRow) => [p.scheme_id, p]),
    )

    // Admin progress edits are stored as offsets over the automatically tracked
    // value. The scheme dashboard and "My Schemes" already fold these in; the
    // payment popup must do the same or a manually completed scheme appears as
    // 0% here and can incorrectly be selected for another payment.
    const adjustmentRows = await loadSchemeAdjustments(schemeIds)
    const adjustmentMap = new Map(
      adjustmentRows
        .filter((adjustment) => adjustment.party_id === partyId)
        .map((adjustment) => [adjustment.scheme_id, adjustment.offset]),
    )

    // An offset is based on the live auto-computed value at the time the admin
    // edits progress. Rebuild those adjusted schemes from the canonical roster
    // calculation instead of combining the offset with a possibly stale/missing
    // scheme_progress row.
    const adjustedSchemes = applicable.filter((scheme) => adjustmentMap.has(scheme.id))
    const liveProgressRows = await Promise.all(adjustedSchemes.map(async (scheme) => {
      const rosterScheme: SchemeForRoster = {
        id: scheme.id,
        scheme_type: scheme.scheme_type ?? null,
        applicable_party_type: scheme.applicable_party_type || 'ALL',
        terms_conditions: scheme.terms_conditions ?? null,
        target_value: scheme.target_value ?? 0,
        start_date: scheme.start_date || today,
        end_date: scheme.end_date || today,
        company_id: scheme.company_id ?? companyId,
      }
      const roster = await computeSchemeRoster(rosterScheme, companyId)
      return [scheme.id, roster.find((member) => member.party_id === partyId)] as const
    }))
    const liveProgressMap = new Map(liveProgressRows)

    const result = applicable.map((s: Record<string, unknown>) => {
      const prog = progressMap.get(s.id as string)
      const liveProgress = liveProgressMap.get(s.id as string)
      const target = Number(s.target_value) || Number(prog?.target_value) || 0
      const current = liveProgress
        ? liveProgress.current_value
        : Math.max(
            0,
            (Number(prog?.current_value) || 0) + (adjustmentMap.get(s.id as string) || 0),
          )
      const progressPercent = target > 0 ? Math.min(100, (current / target) * 100) : 0
      return {
        id: s.id,
        name: s.name || 'Scheme',
        description: s.description ?? null,
        scheme_type: s.scheme_type || 'SALES_TARGET',
        reward_type: s.reward_type ?? null,
        reward_description: s.reward_description ?? null,
        target_value: target,
        end_date: s.end_date || today,
        progress: {
          current_value: current,
          target_value: target,
          progress_percent: progressPercent,
          is_achieved: target > 0 && current >= target,
        },
      }
    })

    return NextResponse.json({ success: true, data: result })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed to check schemes' },
      { status: 500 },
    )
  }
}
