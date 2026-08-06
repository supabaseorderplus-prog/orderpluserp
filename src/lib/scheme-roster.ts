import { supabaseAdmin, getPartyDescendants } from '@/lib/supabase-server'
import { parseSchemeScopeMeta } from '@/lib/scheme-scope'
import {
  INVOICE_SCHEME_TYPE,
  sumConfirmedInvoiceValueForParty,
} from '@/lib/invoice-scheme-progress'
import { fetchAllInChunks } from '@/lib/supabase-in-chunks'
import { loadSchemeAdjustmentMap } from '@/lib/scheme-adjust-fallback'

/**
 * One member of a scheme's audience, with their progress toward the target.
 *
 * `party_id` is the member's display identity — a `parties.id` for real parties
 * or the salesman's user id for salesman members. It mirrors what the existing
 * `/progress` rows used so the UI keeps a stable key.
 */
export interface SchemeRosterRow {
  party_id: string
  name: string
  party_code: string | null
  party_type: string | null
  is_salesman: boolean
  // Value computed from the scheme's natural metric (payments / invoices).
  auto_value: number
  // Manual admin offset folded on top (can be negative); 0 when none.
  manual_adjustment: number
  // auto_value + manual_adjustment, floored at 0 — what gets displayed.
  current_value: number
  target_value: number
  progress_percent: number
  is_achieved: boolean
}

export interface SchemeForRoster {
  id: string
  scheme_type: string | null
  applicable_party_type: string
  terms_conditions: string | null
  target_value: number | string | null
  start_date: string
  end_date: string
  company_id: string | null
}

type Member = {
  // Identity surfaced to the UI (party id, or salesman user id when no party).
  key: string
  name: string
  party_code: string | null
  party_type: string | null
  is_salesman: boolean
  // A real parties.id, used for INVOICE_SCHEME value summation. Null for
  // salesmen who only exist in the users table.
  partyId: string | null
  // Used to reconcile payment collector ids by email (salesman members).
  email: string | null
}

async function resolveDescendantIds(rootId: string): Promise<string[]> {
  const ids = new Set<string>([rootId])
  try {
    const tree = await getPartyDescendants(rootId)
    for (const row of tree || []) {
      if (row.id) ids.add(row.id)
    }
  } catch {
    /* tolerate — caller still gets at least the root */
  }
  return [...ids]
}

async function resolvePartyTypeId(typeName: string): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from('party_types')
    .select('id')
    .ilike('name', typeName)
    .maybeSingle()
  return data?.id ?? null
}

/** All salesmen (users/app_users with SALESMAN role) within a company tree. */
async function loadSalesmenMembers(treeIds: string[]): Promise<Member[]> {
  const { data: roleData } = await supabaseAdmin
    .from('roles')
    .select('id')
    .eq('name', 'SALESMAN')
    .single()
  if (!roleData?.id) return []

  type Row = { id: string; name: string | null; email: string | null; party_id: string | null }
  const buildQuery = (table: 'users' | 'app_users', chunk: string[]) =>
    supabaseAdmin
      .from(table)
      .select('id, name, email, party_id')
      .eq('role_id', roleData.id)
      .eq('status', 'ACTIVE')
      .in('party_id', chunk)

  let { data, error } = await fetchAllInChunks<Row>(treeIds, (chunk) => buildQuery('users', chunk))
  if (error) {
    ;({ data, error } = await fetchAllInChunks<Row>(treeIds, (chunk) => buildQuery('app_users', chunk)))
  }
  if (error || !data) return []

  const seen = new Set<string>()
  const members: Member[] = []
  for (const s of data) {
    if (seen.has(s.id)) continue
    seen.add(s.id)
    members.push({
      key: s.id,
      name: s.name || s.email || 'Salesman',
      party_code: s.party_id ?? null,
      party_type: 'SALESMAN',
      is_salesman: true,
      partyId: s.party_id ?? null,
      email: s.email ?? null,
    })
  }
  return members
}

/** All parties of a given type (or every non-company party for ALL) in a tree. */
async function loadPartyMembers(
  treeIds: string[],
  partyTypeId: string | null,
): Promise<Member[]> {
  type Row = { id: string; name: string | null; party_code: string | null; party_type_id: string | null; party_types: { name?: string } | { name?: string }[] | null }

  const { data, error } = await fetchAllInChunks<Row>(treeIds, (chunk) => {
    let q = supabaseAdmin
      .from('parties')
      .select('id, name, party_code, party_type_id, party_types(name)')
      .eq('status', 'ACTIVE')
      .in('id', chunk)
    if (partyTypeId) q = q.eq('party_type_id', partyTypeId) as typeof q
    return q
  })
  if (error || !data) return []

  return data.map((p) => {
    const rawPT = p.party_types as unknown
    const typeName = Array.isArray(rawPT)
      ? (rawPT[0]?.name ?? null)
      : ((rawPT as { name?: string } | null)?.name ?? null)
    return {
      key: p.id,
      name: p.name || 'Party',
      party_code: p.party_code,
      party_type: typeName,
      is_salesman: false,
      partyId: p.id,
      email: null,
    }
  })
}

/**
 * Resolve enrolled members of an INDIVIDUAL scheme by NAME — used when the
 * `scheme_parties` table is empty/unavailable but the chosen party names were
 * persisted into the scheme's scope metadata at creation time (the create flow
 * embeds them as a fallback). Matches parties and salesmen within the company
 * tree case-insensitively.
 */
async function loadIndividualMembersByName(
  partyNames: string[],
  companyRoot: string | null,
): Promise<Member[]> {
  const wanted = new Set(partyNames.map((n) => n.trim().toLowerCase()).filter(Boolean))
  if (wanted.size === 0 || !companyRoot) return []

  const treeIds = await resolveDescendantIds(companyRoot)
  const [parties, salesmen] = await Promise.all([
    loadPartyMembers(treeIds, null),
    loadSalesmenMembers(treeIds),
  ])

  const byName = new Map<string, Member>()
  for (const m of [...parties, ...salesmen]) {
    const key = (m.name || '').trim().toLowerCase()
    if (wanted.has(key) && !byName.has(m.key)) byName.set(m.key, m)
  }
  return [...byName.values()]
}

/** Resolve the explicitly enrolled members of an INDIVIDUAL scheme. */
async function loadIndividualMembers(schemeId: string): Promise<Member[]> {
  const { data: rows } = await supabaseAdmin
    .from('scheme_parties')
    .select('party_id')
    .eq('scheme_id', schemeId)
  const ids = [...new Set((rows || []).map((r: { party_id: string }) => r.party_id).filter(Boolean))]
  if (ids.length === 0) return []

  // Enrolled ids may be parties.id OR a salesman user id — resolve both.
  const [partyRes, userRes, appUserRes] = await Promise.all([
    supabaseAdmin.from('parties').select('id, name, party_code, party_types(name)').in('id', ids),
    supabaseAdmin.from('users').select('id, name, email, party_id').in('id', ids).then((r) => (r.error ? { data: [] } : r)),
    supabaseAdmin.from('app_users').select('id, name, email, party_id').in('id', ids).then((r) => (r.error ? { data: [] } : r)),
  ])

  const members = new Map<string, Member>()

  for (const p of (partyRes.data || []) as { id: string; name: string | null; party_code: string | null; party_types: { name?: string } | { name?: string }[] | null }[]) {
    const rawPT = p.party_types as unknown
    const typeName = Array.isArray(rawPT) ? (rawPT[0]?.name ?? null) : ((rawPT as { name?: string } | null)?.name ?? null)
    members.set(p.id, {
      key: p.id,
      name: p.name || 'Party',
      party_code: p.party_code,
      party_type: typeName,
      is_salesman: typeName === 'SALESMAN',
      partyId: p.id,
      email: null,
    })
  }

  for (const u of [...((userRes.data as { id: string; name: string | null; email: string | null; party_id: string | null }[]) || []), ...((appUserRes.data as { id: string; name: string | null; email: string | null; party_id: string | null }[]) || [])]) {
    if (members.has(u.id)) continue // already resolved as a party
    members.set(u.id, {
      key: u.id,
      name: u.name || u.email || 'Salesman',
      party_code: u.party_id ?? null,
      party_type: 'SALESMAN',
      is_salesman: true,
      partyId: u.party_id ?? null,
      email: u.email ?? null,
    })
  }

  return [...members.values()]
}

/**
 * Sum each member's collected payments within the scheme window, keyed by the
 * same `created_by` identity the payments path uses. Resolves collector ids in
 * batch (email for salesmen, party_id → app_users for parties) so the whole
 * roster costs a handful of queries instead of N per member.
 */
async function computePaymentProgress(
  members: Member[],
  startDate: string,
  endDate: string,
): Promise<Map<string, number>> {
  const totals = new Map<string, number>()
  if (members.length === 0) return totals

  const collectorToMember = new Map<string, string>()
  const addCollector = (collectorId: string, memberKey: string) => {
    if (collectorId && !collectorToMember.has(collectorId)) collectorToMember.set(collectorId, memberKey)
  }

  // Salesman members: own user id is a collector id.
  const emails: string[] = []
  for (const m of members) {
    if (m.is_salesman) {
      addCollector(m.key, m.key)
      if (m.email) emails.push(m.email.trim().toLowerCase())
    }
  }

  // app_users sharing a salesman's email also stamp created_by (see collector-ids).
  if (emails.length > 0) {
    const { data } = await fetchAllInChunks<{ id: string; email: string | null }>(
      [...new Set(emails)],
      (chunk) => supabaseAdmin.from('app_users').select('id, email').in('email', chunk),
    )
    const byEmail = new Map<string, string[]>()
    for (const r of data || []) {
      const e = (r.email || '').trim().toLowerCase()
      if (!e || !r.id) continue
      const list = byEmail.get(e) || []
      list.push(r.id)
      byEmail.set(e, list)
    }
    for (const m of members) {
      if (!m.is_salesman || !m.email) continue
      for (const id of byEmail.get(m.email.trim().toLowerCase()) || []) addCollector(id, m.key)
    }
  }

  // Party members: their app_users rows are the collectors of their payments.
  const partyIds = members.filter((m) => !m.is_salesman && m.partyId).map((m) => m.partyId as string)
  if (partyIds.length > 0) {
    const { data } = await fetchAllInChunks<{ id: string; party_id: string | null }>(
      [...new Set(partyIds)],
      (chunk) => supabaseAdmin.from('app_users').select('id, party_id').in('party_id', chunk),
    )
    const byParty = new Map<string, string[]>()
    for (const r of data || []) {
      if (!r.party_id || !r.id) continue
      const list = byParty.get(r.party_id) || []
      list.push(r.id)
      byParty.set(r.party_id, list)
    }
    for (const m of members) {
      if (m.is_salesman || !m.partyId) continue
      for (const id of byParty.get(m.partyId) || []) addCollector(id, m.key)
    }
  }

  const collectorIds = [...collectorToMember.keys()]
  if (collectorIds.length === 0) return totals

  const { data: payments } = await fetchAllInChunks<{ amount: number | string; created_by: string }>(
    collectorIds,
    (chunk) =>
      supabaseAdmin
        .from('payments')
        .select('amount, created_by')
        .gte('payment_date', startDate)
        .lte('payment_date', endDate)
        .in('created_by', chunk),
  )

  for (const p of payments || []) {
    const memberKey = collectorToMember.get(p.created_by)
    if (!memberKey) continue
    totals.set(memberKey, (totals.get(memberKey) || 0) + (Number(p.amount) || 0))
  }
  return totals
}

/**
 * Builds the full audience roster for a scheme with each member's live progress.
 *
 * Unlike reading the `scheme_progress` table (which only holds rows for members
 * who happened to trigger a recompute), this resolves EVERY member the scheme
 * targets — group-by-type or individually enrolled — and computes their value on
 * read using the exact same rules as the member's own "My Schemes" view:
 *   - INVOICE_SCHEME → value of invoices confirmed to the party
 *   - everything else → payments collected by the member
 * so the admin roster and each member's self-view always agree.
 */
export async function computeSchemeRoster(
  scheme: SchemeForRoster,
  fallbackCompanyId: string | null = null,
): Promise<SchemeRosterRow[]> {
  const scope = parseSchemeScopeMeta(scheme.terms_conditions, scheme.applicable_party_type)
  // Schemes created before company_id was populated (or by SUPER_ADMIN without a
  // scoped company) fall back to the caller's resolved company scope so group
  // resolution still finds the tree.
  const companyRoot = scheme.company_id || fallbackCompanyId

  // ── Resolve members ──
  let members: Member[] = []
  if (scope.mode === 'INDIVIDUAL') {
    members = await loadIndividualMembers(scheme.id)
    // Table empty/unavailable — fall back to the names embedded at creation time.
    if (members.length === 0 && scope.partyNames.length > 0) {
      members = await loadIndividualMembersByName(scope.partyNames, companyRoot)
    }
  } else if (companyRoot) {
    const treeIds = await resolveDescendantIds(companyRoot)
    const type = scope.applicablePartyType
    if (type === 'SALESMAN') {
      members = await loadSalesmenMembers(treeIds)
    } else if (type === 'ALL') {
      const [parties, salesmen] = await Promise.all([
        loadPartyMembers(treeIds, null),
        loadSalesmenMembers(treeIds),
      ])
      const salesmanKeys = new Set(salesmen.map((s) => s.key))
      const filteredParties = parties.filter(
        (p) => p.party_type !== 'COMPANY' && p.key !== companyRoot && !salesmanKeys.has(p.key),
      )
      members = [...filteredParties, ...salesmen]
    } else {
      const typeId = await resolvePartyTypeId(type)
      members = await loadPartyMembers(treeIds, typeId)
    }
  }

  if (members.length === 0) return []

  // ── Compute each member's value ──
  const targetValue = Number(scheme.target_value) || 0
  const denom = targetValue || 1
  const totals = new Map<string, number>()

  if (scheme.scheme_type === INVOICE_SCHEME_TYPE) {
    for (const m of members) {
      if (!m.partyId) continue
      totals.set(m.key, await sumConfirmedInvoiceValueForParty(m.partyId, scheme.start_date, scheme.end_date))
    }
  } else {
    const paid = await computePaymentProgress(members, scheme.start_date, scheme.end_date)
    for (const [k, v] of paid) totals.set(k, v)
  }

  // Fold in any manual admin overrides (offset on top of the auto value).
  const adjustments = await loadSchemeAdjustmentMap(scheme.id)

  const rows: SchemeRosterRow[] = members.map((m) => {
    const auto = totals.get(m.key) || 0
    const offset = adjustments.get(m.key) || 0
    const current = Math.max(0, auto + offset)
    return {
      party_id: m.key,
      name: m.name,
      party_code: m.party_code,
      party_type: m.party_type,
      is_salesman: m.is_salesman,
      auto_value: auto,
      manual_adjustment: offset,
      current_value: current,
      target_value: targetValue,
      progress_percent: Math.min(100, (current / denom) * 100),
      is_achieved: targetValue > 0 && current >= targetValue,
    }
  })

  rows.sort((a, b) => b.current_value - a.current_value)
  return rows
}
