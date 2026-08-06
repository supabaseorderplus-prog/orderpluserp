import { supabaseAdmin } from '@/lib/supabase-server'
import { getSchemePartyTypesForUser, parseSchemeScopeMeta } from '@/lib/scheme-scope'
import {
  INVOICE_SCHEME_TYPE,
  sumConfirmedInvoiceValueForParty,
} from '@/lib/invoice-scheme-progress'
import { resolveSelfCollectorIds } from '@/lib/collector-ids'

// Minimal shape we need from getUserFromToken() — kept loose so callers can pass
// the auth user straight through without re-mapping.
export type SalesmanAuthUser = {
  id?: string | null
  app_user_id?: string | null
  party_id?: string | null
  role?: string | null
  name?: string | null
  email?: string | null
}

type SchemeRow = {
  id: string
  start_date: string
  end_date: string
  target_value: number | string | null
  scheme_type?: string | null
  applicable_party_type: string
  terms_conditions?: string | null
}

// Walk up parent_party_id chain to find the root company party_id.
// Schemes are stored with company_id = root company's party_id, but
// resolveCompanyScope returns the party's OWN party_id for non-admin users.
export async function resolveSchemeCompanyId(
  partyId: string,
  scopeId: string | null,
): Promise<string | null> {
  // If scope already differs from party (e.g. SUPER_ADMIN with x-company-id header), trust it.
  if (scopeId && scopeId !== partyId) return scopeId

  // Walk up the hierarchy — stop when we reach a party with no parent (the root/company).
  let current = partyId
  for (let i = 0; i < 6; i++) {
    const { data } = await supabaseAdmin
      .from('parties')
      .select('parent_party_id')
      .eq('id', current)
      .maybeSingle()
    if (!data?.parent_party_id) return current // root found
    current = data.parent_party_id
  }
  return current
}

/**
 * Resolves the logged-in party's company scope and the set of ACTIVE schemes
 * that apply to them — using the SAME matching rules as GET /api/v1/schemes/my
 * (group-by-type, enrolled via scheme_parties, or matched by name embedded in
 * terms_conditions). Shared by both the payments and invoice recompute paths so
 * the two metrics stay perfectly in sync on which schemes are "visible".
 */
async function loadRelevantSchemesForParty(
  authUser: SalesmanAuthUser,
  scopeId: string | null,
): Promise<{ partyId: string; companyId: string | null; schemes: SchemeRow[] }> {
  const partyId = authUser.party_id as string
  const companyId = await resolveSchemeCompanyId(partyId, scopeId)

  const enrollmentLookupIds = [...new Set(
    [partyId, authUser.id, authUser.app_user_id].filter((id): id is string => Boolean(id)),
  )]

  const { data: partyData } = await supabaseAdmin
    .from('parties')
    .select('id, name, party_types(name)')
    .eq('id', partyId)
    .maybeSingle()

  const rawPT = partyData?.party_types as unknown
  const partyTypeName: string | null = Array.isArray(rawPT)
    ? (rawPT[0]?.name ?? null)
    : ((rawPT as { name: string } | null)?.name ?? null)

  const matchingPartyTypes = getSchemePartyTypesForUser({ role: authUser.role, partyTypeName })

  const today = new Date().toISOString().split('T')[0]

  const [enrolledResult, schemesResult] = await Promise.all([
    supabaseAdmin.from('scheme_parties').select('scheme_id').in('party_id', enrollmentLookupIds),
    (() => {
      let q = supabaseAdmin
        .from('schemes')
        .select('*')
        .eq('status', 'ACTIVE')
        .lte('start_date', today)
        .gte('end_date', today)
      if (companyId) q = q.eq('company_id', companyId)
      return q
    })(),
  ])

  const enrolledIds = new Set(
    (enrolledResult.error ? [] : (enrolledResult.data ?? [])).map(
      (e: { scheme_id: string }) => e.scheme_id,
    ),
  )

  const partyName: string | null = partyData?.name ?? null
  const userNames = new Set(
    [partyName, authUser.name, authUser.email]
      .filter((v): v is string => Boolean(v))
      .map((v) => v.trim().toLowerCase()),
  )

  const schemes = ((schemesResult.data || []) as SchemeRow[]).filter((s) => {
    if (enrolledIds.has(s.id)) return true
    const scope = parseSchemeScopeMeta(s.terms_conditions, s.applicable_party_type)
    if (scope.mode === 'INDIVIDUAL') {
      return scope.partyNames.some((name) => userNames.has(name.trim().toLowerCase()))
    }
    return (
      scope.applicablePartyType === 'ALL' ||
      matchingPartyTypes.includes(scope.applicablePartyType)
    )
  })

  return { partyId, companyId, schemes }
}

/**
 * Full recompute + upsert of one scheme_progress row for `partyId`, given the
 * already-summed current value. Idempotent and self-healing. Retries with
 * progressively fewer optional columns on schema mismatch so it works across
 * deployments with differing scheme_progress shapes.
 */
async function upsertSchemeProgress(
  scheme: SchemeRow,
  partyId: string,
  companyId: string | null,
  totalValue: number,
): Promise<void> {
  const targetValue = Number(scheme.target_value) || 1
  const progressPercent = Math.min(100, (totalValue / targetValue) * 100)
  const isAchieved = totalValue >= targetValue

  const { data: existing } = await supabaseAdmin
    .from('scheme_progress')
    .select('id')
    .eq('scheme_id', scheme.id)
    .eq('party_id', partyId)
    .maybeSingle()

  if (existing) {
    await supabaseAdmin.from('scheme_progress').update({
      current_value: totalValue,
      target_value: targetValue,
      progress_percent: progressPercent,
      is_achieved: isAchieved,
    }).eq('id', existing.id)
    return
  }

  // Only create a new record once there is something to count.
  if (totalValue <= 0) return

  const fullInsert: Record<string, unknown> = {
    scheme_id: scheme.id,
    party_id: partyId,
    current_value: totalValue,
    target_value: targetValue,
    progress_percent: progressPercent,
    is_achieved: isAchieved,
    is_eligible: true,
    current_slab: 0,
    ...(companyId ? { company_id: companyId } : {}),
  }
  const r1 = await supabaseAdmin.from('scheme_progress').insert(fullInsert)
  if (!r1.error) return

  // Retry without optional columns on schema mismatch.
  const coreInsert: Record<string, unknown> = {
    scheme_id: scheme.id,
    party_id: partyId,
    current_value: totalValue,
    target_value: targetValue,
    progress_percent: progressPercent,
    is_achieved: isAchieved,
    ...(companyId ? { company_id: companyId } : {}),
  }
  const r2 = await supabaseAdmin.from('scheme_progress').insert(coreInsert)
  if (!r2.error) return

  await supabaseAdmin.from('scheme_progress').insert({
    scheme_id: scheme.id,
    party_id: partyId,
    current_value: totalValue,
    target_value: targetValue,
    progress_percent: progressPercent,
    is_achieved: isAchieved,
  })
}

/**
 * Recomputes the logged-in salesman's scheme progress from the payments they
 * have actually collected within each scheme's active window.
 *
 * This is the single source of truth for "collect money → scheme bar moves".
 * INVOICE_SCHEME schemes are intentionally SKIPPED here — they are driven by
 * confirmed invoices via recalcPartySchemesFromInvoices, not payments, so the
 * two metrics never overwrite each other.
 *
 * Safe to fire-and-forget: returns a summary and never throws for the common
 * "no party / no schemes" cases.
 */
export async function recalcSalesmanSchemesFromPayments(
  authUser: SalesmanAuthUser | null,
  scopeId: string | null,
): Promise<{ updated: number; schemes: string[] }> {
  if (!authUser?.party_id) return { updated: 0, schemes: [] }

  // CRITICAL — per-collector isolation:
  // Salesmen frequently SHARE (or lack) a company party_id, so company/party
  // scope cannot tell two collectors apart — summing by company_id would pool
  // every salesman's collections into one shared scheme bar (the same bug that
  // pooled their wallets). created_by is the only reliable per-collector identity
  // and is set on every payment going forward, so we sum strictly by it. We also
  // STORE each salesman's progress under their own unique user id (not the shared
  // party_id) so two salesmen on the same party never overwrite each other.
  // Match the FULL collector-id set (incl. email-resolved app_users rows), same as
  // the wallet read — so the scheme bar sums exactly the payments the salesman's
  // wallet shows. A narrow [app_user_id, id] set misses divergent created_by ids
  // and silently under-counts (the same bug that zeroed the wallet).
  const createdByIds = await resolveSelfCollectorIds(authUser)
  // Mirror how payments persist created_by (app_user_id || id) for the storage key.
  const progressKey = authUser.app_user_id || authUser.id || null
  if (createdByIds.length === 0 || !progressKey) return { updated: 0, schemes: [] }

  const { companyId, schemes } = await loadRelevantSchemesForParty(authUser, scopeId)

  const paymentSchemes = schemes.filter((s) => s.scheme_type !== INVOICE_SCHEME_TYPE)
  if (paymentSchemes.length === 0) return { updated: 0, schemes: [] }

  const updatedSchemes: string[] = []

  for (const scheme of paymentSchemes) {
    const { data: paymentRows } = await supabaseAdmin
      .from('payments')
      .select('amount')
      .gte('payment_date', scheme.start_date)
      .lte('payment_date', scheme.end_date)
      .in('created_by', createdByIds)

    const totalAmount = (paymentRows || []).reduce(
      (sum: number, p: { amount: number }) => sum + (Number(p.amount) || 0),
      0,
    )

    await upsertSchemeProgress(scheme, progressKey, companyId, totalAmount)
    updatedSchemes.push(scheme.id)
  }

  return { updated: updatedSchemes.length, schemes: updatedSchemes }
}

/**
 * Recomputes a party's INVOICE_SCHEME progress from the value of invoices
 * CONFIRMED *to* that party within each scheme's active window. The invoice
 * value is the linked order's grand_total (see sumConfirmedInvoiceValueForParty).
 *
 * Mirrors the payments recompute: idempotent, self-healing, fire-and-forget.
 * Only INVOICE_SCHEME schemes are touched — payment-driven schemes are left to
 * recalcSalesmanSchemesFromPayments.
 */
export async function recalcPartySchemesFromInvoices(
  authUser: SalesmanAuthUser | null,
  scopeId: string | null,
): Promise<{ updated: number; schemes: string[] }> {
  if (!authUser?.party_id) return { updated: 0, schemes: [] }

  const { partyId, companyId, schemes } = await loadRelevantSchemesForParty(authUser, scopeId)

  const invoiceSchemes = schemes.filter((s) => s.scheme_type === INVOICE_SCHEME_TYPE)
  if (invoiceSchemes.length === 0) return { updated: 0, schemes: [] }

  const updatedSchemes: string[] = []

  for (const scheme of invoiceSchemes) {
    const totalValue = await sumConfirmedInvoiceValueForParty(
      partyId,
      scheme.start_date,
      scheme.end_date,
    )

    await upsertSchemeProgress(scheme, partyId, companyId, totalValue)
    updatedSchemes.push(scheme.id)
  }

  return { updated: updatedSchemes.length, schemes: updatedSchemes }
}
