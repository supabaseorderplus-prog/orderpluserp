import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, getUserFromToken, resolveCompanyScope } from '@/lib/supabase-server'
import {
  getSchemePartyTypesForUser,
  mapSchemeScopeForResponse,
  parseSchemeScopeMeta,
} from '@/lib/scheme-scope'
import {
  recalcSalesmanSchemesFromPayments,
  recalcPartySchemesFromInvoices,
  resolveSchemeCompanyId,
} from '@/lib/scheme-progress'
import { loadSchemeAdjustments } from '@/lib/scheme-adjust-fallback'

// GET /api/v1/schemes/my
// Returns active schemes the logged-in party is enrolled in, with progress
export async function GET(req: NextRequest) {
  try {
    const authUser = await getUserFromToken(req)
    if (!authUser) {
      return NextResponse.json({ success: true, data: [] })
    }

    const scopeId = await resolveCompanyScope(req, authUser)
    const partyId = authUser.party_id
    const enrollmentLookupIds = [...new Set([
      partyId,
      authUser.id,
      authUser.app_user_id,
    ].filter((id): id is string => Boolean(id)))]

    // Resolve party info + root company_id in parallel
    const [partyResult, companyId, enrolledResult] = await Promise.all([
      partyId
        ? supabaseAdmin
          .from('parties')
          .select('id, name, party_types(name)')
          .eq('id', partyId)
          .maybeSingle()
        : Promise.resolve({ data: null }),
      partyId ? resolveSchemeCompanyId(partyId, scopeId) : Promise.resolve(scopeId),
      enrollmentLookupIds.length > 0
        ? supabaseAdmin.from('scheme_parties').select('scheme_id').in('party_id', enrollmentLookupIds)
        : Promise.resolve({ data: [], error: null }),
    ])

    const party = partyResult.data
    const rawPT = party?.party_types as unknown
    const partyTypeName: string | null = Array.isArray(rawPT)
      ? (rawPT[0]?.name ?? null)
      : ((rawPT as { name: string } | null)?.name ?? null)
    const partyName: string | null = party?.name ?? null
    const userNames = new Set(
      [partyName, authUser.name, authUser.email]
        .filter((value): value is string => Boolean(value))
        .map((value) => value.trim().toLowerCase()),
    )
    const matchingPartyTypes = getSchemePartyTypesForUser({
      role: authUser.role,
      partyTypeName,
    })

    const today = new Date().toISOString().split('T')[0]
    const enrolledRows = enrolledResult.error ? [] : (enrolledResult.data ?? [])
    const enrolledIds = new Set((enrolledRows || []).map((e: { scheme_id: string }) => e.scheme_id))

    // Fetch all active schemes scoped to this company
    let schemesQuery = supabaseAdmin
      .from('schemes')
      .select('*')
      .eq('status', 'ACTIVE')
      .lte('start_date', today)
      .gte('end_date', today)

    if (companyId) schemesQuery = schemesQuery.eq('company_id', companyId)
    else if (enrolledIds.size > 0) schemesQuery = schemesQuery.in('id', [...enrolledIds])
    else return NextResponse.json({ success: true, data: [] })

    const { data: allSchemes } = await schemesQuery

    const relevantSchemes = (allSchemes || []).filter(
      (s: { id: string; applicable_party_type: string; terms_conditions?: string | null }) => {
        if (enrolledIds.has(s.id)) return true

        const scope = parseSchemeScopeMeta(s.terms_conditions, s.applicable_party_type)

        if (scope.mode === 'INDIVIDUAL') {
          // Primary: scheme_parties (already checked above via enrolledIds).
          // Fallback: party names embedded in terms_conditions at creation time.
          return scope.partyNames.some((name) => userNames.has(name.trim().toLowerCase()))
        }

        return (
          scope.applicablePartyType === 'ALL' ||
          matchingPartyTypes.includes(scope.applicablePartyType)
        )
      },
    )

    if (relevantSchemes.length === 0) {
      return NextResponse.json({ success: true, data: [] })
    }

    const schemeIds = relevantSchemes.map((s: { id: string }) => s.id)

    const { data: progressRows } = await supabaseAdmin
      .from('scheme_progress')
      .select('*')
      .in('scheme_id', schemeIds)
      .in('party_id', enrollmentLookupIds)
      .then((r) => (r.error ? { data: [] } : r))

    // Prefer the caller's OWN unique-user-id progress row over a shared party_id
    // row. Salesmen share a company party_id, so payment-driven progress is now
    // stored under the collector's user id (see recalcSalesmanSchemesFromPayments);
    // ranking user ids first ensures each salesman reads their own bar, not a
    // stale shared one. Real party users only ever have a party_id row, so this
    // ordering is harmless for them.
    const progressPreference = [authUser.app_user_id, authUser.id, partyId]
      .filter((id): id is string => Boolean(id))
    const progressPriority = new Map<string, number>()
    progressPreference.forEach((id, index) => {
      if (!progressPriority.has(id)) progressPriority.set(id, index)
    })
    const progressMap = new Map<string, Record<string, unknown>>()
    for (const progress of progressRows || []) {
      const existing = progressMap.get(progress.scheme_id)
      const currentRank = progressPriority.get(progress.party_id) ?? Number.MAX_SAFE_INTEGER
      const existingRank = existing ? (progressPriority.get(existing.party_id as string) ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER
      if (!existing || currentRank < existingRank) progressMap.set(progress.scheme_id, progress)
    }

    // Manual admin overrides for these schemes, matched to ANY of the caller's
    // identity ids (the offset is keyed by the member's roster identity — their
    // party_id, or their user id for salesmen). Folded on top of the auto value
    // so the party sees the exact status the admin set, then it keeps moving.
    const identityIds = new Set(enrollmentLookupIds)
    const adjustmentNotes = await loadSchemeAdjustments(schemeIds)
    const offsetByScheme = new Map<string, number>()
    for (const note of adjustmentNotes) {
      if (!identityIds.has(note.party_id)) continue
      offsetByScheme.set(note.scheme_id, note.offset) // loader already keeps the latest
    }

    const result = relevantSchemes.map((scheme: Record<string, unknown>) => {
      const prog = progressMap.get(scheme.id as string)
      const target = Number(scheme.target_value) || 0
      const offset = offsetByScheme.get(scheme.id as string) || 0

      const baseValue = prog ? Number(prog.current_value) || 0 : 0
      const current = Math.max(0, baseValue + offset)
      const denom = target || 1

      const progress = offset !== 0
        ? {
            ...(prog || {}),
            current_value: current,
            target_value: target,
            progress_percent: Math.min(100, (current / denom) * 100),
            is_achieved: target > 0 && current >= target,
            is_eligible: true,
          }
        : prog
          ? prog
          : {
              current_value: 0,
              target_value: scheme.target_value ?? 0,
              progress_percent: 0,
              is_achieved: false,
              is_eligible: true,
            }

      return {
        ...mapSchemeScopeForResponse(scheme),
        progress,
      }
    })

    return NextResponse.json({ success: true, data: result })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed to fetch schemes' },
      { status: 500 },
    )
  }
}

// POST /api/v1/schemes/my/recalculate
// Recalculates scheme progress for the logged-in salesman from their existing payments.
// Needed when payments were collected before scheme progress tracking was in place.
export async function POST(req: NextRequest) {
  try {
    const authUser = await getUserFromToken(req)
    if (!authUser) {
      return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 })
    }

    if (!authUser.party_id) {
      return NextResponse.json({ success: false, message: 'No party record found for user' }, { status: 400 })
    }

    const scopeId = await resolveCompanyScope(req, authUser)
    // Self-heal BOTH metrics: payment-driven schemes from collected payments, and
    // INVOICE_SCHEME schemes from confirmed invoices issued to this party. Each
    // call only touches the schemes it owns, so they never overwrite each other.
    const [payments, invoices] = await Promise.all([
      recalcSalesmanSchemesFromPayments(authUser, scopeId),
      recalcPartySchemesFromInvoices(authUser, scopeId),
    ])

    return NextResponse.json({
      success: true,
      data: {
        updated: payments.updated + invoices.updated,
        schemes: [...payments.schemes, ...invoices.schemes],
      },
    })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed to recalculate schemes' },
      { status: 500 },
    )
  }
}
