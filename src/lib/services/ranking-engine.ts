import { supabaseAdmin, getPartyDescendants, listAllAuthUsers } from '@/lib/supabase-server'
import { formatIndianCurrency } from '@/lib/services/ranking-calculator'
import { fetchAllInChunks } from '@/lib/supabase-in-chunks'

/**
 * On-the-fly monthly ranking engine.
 *
 * Unlike the legacy fiscal-year `party_rankings` table (which is not provisioned
 * in this deployment), rankings here are DERIVED on read from `invoices` and
 * `payments` — the same compute-on-read pattern the wallet and scheme-progress
 * features use. Two independent leaderboards:
 *
 *   • Party board   — segmented by party type (SUPER_DEALER / CNF / RETAILER).
 *                     score = invoices generated this month + payments made this month.
 *   • Salesman board — ranked by total payment collected this month.
 *
 * Everything is scoped to the caller's company tree (get_party_descendants),
 * fail-closed when there is no company.
 */

export const RANKABLE_PARTY_TYPES = ['SUPER_DEALER', 'CNF', 'RETAILER'] as const
export type RankablePartyType = (typeof RANKABLE_PARTY_TYPES)[number]

export type BoardKind = 'party' | 'salesman'
export type ViewerScope = 'admin' | 'self'

export interface RankingEntry {
  id: string
  name: string
  code: string | null
  invoiceValue: number
  paymentValue: number
  score: number
  rank: number
  isSelf: boolean
}

export interface RankingBoard {
  board: BoardKind
  category: string | null
  scope: ViewerScope
  period: { from: string; label: string }
  entries: RankingEntry[]
  totalCount: number
  self: RankingEntry | null
  tip: string | null
  categories?: string[]
}

const inr = (n: number) => `₹${formatIndianCurrency(Math.max(0, Math.round(n)))}`

/** First day of the current month (YYYY-MM-DD) and a human label like "June 2026". */
function currentMonthWindow(): { from: string; label: string } {
  const now = new Date()
  const from = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`
  const label = now.toLocaleString('en-US', { month: 'long', year: 'numeric' })
  return { from, label }
}

/** Resolve the party-type name off a Supabase nested relation (array or object). */
function typeName(raw: unknown): string | null {
  if (Array.isArray(raw)) return (raw[0] as { name?: string } | undefined)?.name ?? null
  return (raw as { name?: string } | null)?.name ?? null
}

/** Sum numeric `field` grouped by `keyField` across rows. */
function sumByKey<T extends Record<string, unknown>>(
  rows: T[] | null | undefined,
  keyField: keyof T,
  field: keyof T,
): Map<string, number> {
  const map = new Map<string, number>()
  for (const row of rows || []) {
    const key = row[keyField]
    if (typeof key !== 'string') continue
    map.set(key, (map.get(key) || 0) + (Number(row[field]) || 0))
  }
  return map
}

/** All party ids in the company tree (root included). Empty when no root. */
async function companyTreeIds(rootId: string | null): Promise<string[]> {
  if (!rootId) return []
  const tree = await getPartyDescendants(rootId)
  const ids = tree.map((r) => r.id)
  if (!ids.includes(rootId)) ids.push(rootId)
  return ids
}

/**
 * Sort by score desc (name asc tiebreak) and assign competition ranks — entries
 * with equal scores share a rank, so every party tied at ₹0 sits together at the
 * bottom (e.g. all "#5") rather than being dropped off the board.
 */
function rankEntries(entries: Omit<RankingEntry, 'rank'>[]): RankingEntry[] {
  const sorted = [...entries].sort(
    (a, b) => b.score - a.score || a.name.localeCompare(b.name),
  )
  let lastScore: number | null = null
  let lastRank = 0
  return sorted.map((e, i) => {
    const rank = lastScore !== null && e.score === lastScore ? lastRank : i + 1
    lastScore = e.score
    lastRank = rank
    return { ...e, rank }
  })
}

/**
 * Build the improvement tip for the self entry: the exact amount needed to pass
 * the party/salesman ranked immediately above.
 */
function buildTip(
  board: BoardKind,
  full: RankingEntry[],
  self: RankingEntry | null,
): string | null {
  const noun = board === 'salesman' ? 'collections' : 'invoices or payments'
  const firstAction = board === 'salesman' ? 'collection' : 'sale or payment'

  if (!self) {
    return `Make your first ${firstAction} this month to enter the leaderboard.`
  }

  // The climb target is the nearest entry scoring strictly above self.
  const above = full
    .filter((e) => e.score > self.score)
    .sort((a, b) => a.score - b.score)[0]

  if (!above) {
    // Nobody scores higher — self is at (or tied for) the top.
    if (self.score <= 0) {
      return `Make your first ${firstAction} this month to take the lead.`
    }
    return `You're #1 this month — hold the top spot!`
  }
  const gap = Math.max(1, above.score - self.score + 1)
  return `${inr(gap)} more in ${noun} moves you past ${above.name} to rank ${above.rank}.`
}

/**
 * Compute the party board (optionally filtered to a single category).
 * Returns ALL entries per category in `byCategory`.
 */
async function loadPartyData(
  treeIds: string[],
  monthFrom: string,
): Promise<Map<RankablePartyType, RankingEntry[]>> {
  const result = new Map<RankablePartyType, RankingEntry[]>()
  for (const t of RANKABLE_PARTY_TYPES) result.set(t, [])
  if (treeIds.length === 0) return result

  // Parties in the tree with their type.
  const { data: parties } = await supabaseAdmin
    .from('parties')
    .select('id, name, party_code, status, party_types(name)')
    .in('id', treeIds)

  const activeParties = (parties || []).filter(
    (p) => (p.status ?? 'ACTIVE') === 'ACTIVE',
  )
  const partyIds = activeParties.map((p) => p.id)
  if (partyIds.length === 0) return result

  // Monthly invoices (generated) and payments (made) for those parties.
  const [{ data: invoices }, { data: payments }] = await Promise.all([
    supabaseAdmin
      .from('invoices')
      .select('billing_party_id, grand_total')
      .in('billing_party_id', partyIds)
      .gte('invoice_date', monthFrom)
      .eq('status', 'ACTIVE')
      .not('is_cancelled', 'eq', true),
    supabaseAdmin
      .from('payments')
      .select('party_id, amount')
      .in('party_id', partyIds)
      .gte('payment_date', monthFrom),
  ])

  const invoiceByParty = sumByKey(invoices, 'billing_party_id', 'grand_total')
  const paymentByParty = sumByKey(payments, 'party_id', 'amount')

  for (const p of activeParties) {
    const t = typeName(p.party_types) as RankablePartyType | null
    if (!t || !RANKABLE_PARTY_TYPES.includes(t)) continue
    const invoiceValue = invoiceByParty.get(p.id) || 0
    const paymentValue = paymentByParty.get(p.id) || 0
    const score = invoiceValue + paymentValue
    result.get(t)!.push({
      id: p.id,
      name: p.name || p.party_code || 'Unnamed',
      code: p.party_code ?? null,
      invoiceValue,
      paymentValue,
      score,
      rank: 0,
      isSelf: false,
    })
  }

  for (const t of RANKABLE_PARTY_TYPES) {
    // Every active party in the tree is listed — even at ₹0 this month — so the
    // full roster shows with zero-collectors tied at the bottom, climbing in real
    // time as invoices and payments land. (Dormant/inactive parties are already
    // excluded above by the status filter.)
    result.set(t, rankEntries(result.get(t)!))
  }
  return result
}

/**
 * A salesman on the board. `id` is the canonical identity (app_users.id, used for
 * self-highlight and storage). `matchIds` is EVERY id their payments may have been
 * stamped with — both the app_users id and the auth.users id — because
 * `payments.created_by` is set to `app_user_id || auth_id` and falls back to the
 * auth id whenever the profile wasn't resolved at collection time. Matching only
 * the app_users id silently drops auth-id-stamped collections → everyone at ₹0.
 * This mirrors the wallet's per-collector matching (payments GET matches both ids).
 */
interface Salesman {
  id: string
  name: string
  code: string | null
  email: string | null
  matchIds: string[]
}

/** Salesman roster (app_users / users) under the company tree. */
async function loadSalesmen(treeIds: string[]): Promise<Salesman[]> {
  const { data: roleData } = await supabaseAdmin
    .from('roles')
    .select('id')
    .eq('name', 'SALESMAN')
    .single()
  if (!roleData?.id) return []

  const selectCols = 'id, name, email, party_id'
  const isMissingUsers = (err: { code?: string; message?: string } | null) =>
    !!err &&
    (err.code === 'PGRST205' ||
      (err.message || '').includes("Could not find the table 'public.users'"))

  let { data: rows, error } = await supabaseAdmin
    .from('users')
    .select(selectCols)
    .eq('role_id', roleData.id)
    .eq('status', 'ACTIVE')
  if (error && isMissingUsers(error)) {
    const fallback = await supabaseAdmin
      .from('app_users')
      .select(selectCols)
      .eq('role_id', roleData.id)
      .eq('status', 'ACTIVE')
    rows = fallback.data
  }

  const inTree = (rows || []).filter(
    (u) => treeIds.length === 0 || (u.party_id && treeIds.includes(u.party_id)),
  )

  // Resolve each salesman's auth.users id (keyed by email) so we can both (a) match
  // auth-id-stamped payments and (b) exclude DRIVERs. DRIVER is not a DB role —
  // drivers share the SALESMAN role_id and are marked only by auth
  // user_metadata.display_role. Fail-open (no auth data) if the lookup throws.
  const emailToAuthId = new Map<string, string>()
  const driverAuthIds = new Set<string>()
  try {
    // Must paginate every auth page — listUsers({ perPage: 1000 }) misses auth users
    // beyond the first 1000, which both leaks drivers into the board and drops
    // payment matches for users whose auth id isn't resolved.
    const authUsers = await listAllAuthUsers()
    for (const u of authUsers) {
      const email = u.email?.trim().toLowerCase()
      if (email) emailToAuthId.set(email, u.id)
      if (u.user_metadata?.display_role === 'DRIVER') driverAuthIds.add(u.id)
    }
  } catch {
    /* fail-open: no auth enrichment */
  }

  const salesmen: Salesman[] = []
  for (const u of inTree) {
    const authId = u.email
      ? emailToAuthId.get(u.email.trim().toLowerCase())
      : undefined
    // Exclude drivers, identified by either id space.
    if (driverAuthIds.has(u.id) || (authId && driverAuthIds.has(authId))) continue
    const matchIds = [...new Set([u.id, authId].filter((id): id is string => Boolean(id)))]
    salesmen.push({
      id: u.id,
      name: u.name || u.email?.split('@')[0] || 'Salesman',
      code: null,
      email: u.email ?? null,
      matchIds,
    })
  }
  return salesmen
}

/**
 * Resolve EVERY id each salesman's payments may be stamped under, back to their
 * canonical (app_users) id. `payments.created_by` is set to `app_user_id || auth_id`
 * at collection time, but `app_user_id` is resolved by-id first and by-email as a
 * fallback — so a divergent/duplicate app_users row, or an unresolved profile
 * (auth id stamped), means created_by can be ANY of: the roster app_users id, a
 * different app_users id sharing the email, or the auth id. Matching only the
 * roster id silently drops those collections → the ₹0-for-everyone board.
 *
 * This mirrors the Wallets page's collector-id reconciliation exactly so the
 * leaderboard's "Collected" stays consistent with each salesman's wallet total.
 */
async function buildCollectorIndex(
  salesmen: Salesman[],
): Promise<Map<string, string>> {
  const matchIdToCanonical = new Map<string, string>()
  for (const s of salesmen) {
    for (const mid of s.matchIds) matchIdToCanonical.set(mid, s.id)
  }

  // Add any app_users rows that share a salesman's email (divergent/duplicate ids).
  const emails = [...new Set(
    salesmen.map((s) => s.email?.trim().toLowerCase()).filter((e): e is string => Boolean(e)),
  )]
  if (emails.length > 0) {
    const emailToCanonical = new Map<string, string>()
    for (const s of salesmen) {
      const email = s.email?.trim().toLowerCase()
      if (email && !emailToCanonical.has(email)) emailToCanonical.set(email, s.id)
    }
    const { data: rows } = await supabaseAdmin
      .from('app_users')
      .select('id, email')
      .in('email', emails)
    for (const r of (rows || []) as { id?: string; email?: string | null }[]) {
      const email = r.email?.trim().toLowerCase()
      const canonical = email ? emailToCanonical.get(email) : undefined
      if (r.id && canonical) matchIdToCanonical.set(r.id, canonical)
    }
  }
  return matchIdToCanonical
}

/**
 * Legacy attribution (mirrors the admin Wallets board exactly): many payments were
 * inserted with a NULL `created_by` — the collector was never stamped (older /
 * unauthenticated collection flows). In this deployment most payments are NULL-
 * created_by, so without this path the board reads ₹0 for everyone. Attribute each
 * such payment to a salesman via the parties assigned to them, resolved through BOTH
 * the `party_salesman` link table AND the direct `parties.salesman_id` column.
 * Resolving via `party_salesman` alone (the old behaviour) is exactly why the board
 * showed ₹0 on deployments that assign salesmen through the column.
 *
 * Keyed off the FULL match-id set (mapped back to canonical) so an assignment stamped
 * under a divergent app_users id or auth id still lands. A NULL-created_by payment
 * surfaces only for the salesman its paying party is assigned to, so isolation holds
 * for the normal one-salesman-per-party case (a shared party credits each, matching
 * the board).
 *
 * UNIONed with the primary created_by collections by the caller — never gated on a
 * salesman having zero primary collection. Primary and legacy never overlap (primary
 * requires non-null created_by, legacy requires null), so a salesman's total stays
 * equal to everything they collected even after a stamped payment lands. Current month
 * only. Schema-tolerant: a missing table/column contributes nothing instead of throwing.
 */
async function legacyCollectionByParty(
  salesmen: Salesman[],
  matchIdToCanonical: Map<string, string>,
  monthFrom: string,
): Promise<Map<string, number>> {
  const result = new Map<string, number>()
  const allMatchIds = [...matchIdToCanonical.keys()]
  if (salesmen.length === 0 || allMatchIds.length === 0) return result

  // party id → set of canonical salesman ids it is assigned to (via either source).
  const canonicalsByParty = new Map<string, Set<string>>()
  const addAssignment = (partyId?: string | null, salesmanId?: string | null) => {
    if (!partyId || !salesmanId) return
    const canonical = matchIdToCanonical.get(salesmanId)
    if (!canonical) return
    let set = canonicalsByParty.get(partyId)
    if (!set) {
      set = new Set<string>()
      canonicalsByParty.set(partyId, set)
    }
    set.add(canonical)
  }

  // Assignments via the party_salesman link table (tolerate the table being absent).
  const linkRes = await fetchAllInChunks<{ salesman_id: string; party_id: string | null }>(
    allMatchIds,
    (chunk) => supabaseAdmin.from('party_salesman').select('salesman_id, party_id').in('salesman_id', chunk),
  )
  if (!linkRes.error) {
    for (const l of linkRes.data || []) addAssignment(l.party_id, l.salesman_id)
  }

  // Assignments via the direct parties.salesman_id column (tolerate it being absent).
  const directRes = await fetchAllInChunks<{ id: string; salesman_id: string | null }>(
    allMatchIds,
    (chunk) => supabaseAdmin.from('parties').select('id, salesman_id').in('salesman_id', chunk),
  )
  if (!directRes.error) {
    for (const p of directRes.data || []) addAssignment(p.id, p.salesman_id)
  }

  const allPartyIds = [...canonicalsByParty.keys()]
  if (allPartyIds.length === 0) return result

  const legacyRes = await fetchAllInChunks<{ party_id: string | null; amount: unknown }>(
    allPartyIds,
    (chunk) =>
      supabaseAdmin
        .from('payments')
        .select('party_id, amount')
        .in('party_id', chunk)
        .is('created_by', null)
        .gte('payment_date', monthFrom),
  )
  if (legacyRes.error) return result

  for (const p of legacyRes.data || []) {
    if (!p.party_id) continue
    const canonicals = canonicalsByParty.get(p.party_id)
    if (!canonicals) continue
    const amt = Number(p.amount) || 0
    for (const canonical of canonicals) {
      result.set(canonical, (result.get(canonical) || 0) + amt)
    }
  }
  return result
}

/** Compute the salesman board (everyone, ranked by collection this month). */
async function loadSalesmanBoard(
  treeIds: string[],
  monthFrom: string,
): Promise<RankingEntry[]> {
  const salesmen = await loadSalesmen(treeIds)
  if (salesmen.length === 0) return []

  const matchIdToCanonical = await buildCollectorIndex(salesmen)
  const allMatchIds = [...matchIdToCanonical.keys()]

  // Primary: created_by-stamped collections this month, grouped by canonical id.
  const collectedByCanonical = new Map<string, number>()
  if (allMatchIds.length > 0) {
    const payRes = await fetchAllInChunks<{ created_by: string | null; amount: unknown }>(
      allMatchIds,
      (chunk) =>
        supabaseAdmin
          .from('payments')
          .select('created_by, amount')
          .in('created_by', chunk)
          .gte('payment_date', monthFrom),
    )
    for (const p of payRes.data || []) {
      const canonical = p.created_by ? matchIdToCanonical.get(p.created_by) : undefined
      if (!canonical) continue
      collectedByCanonical.set(
        canonical,
        (collectedByCanonical.get(canonical) || 0) + (Number(p.amount) || 0),
      )
    }
  }

  // Legacy NULL-created_by payments on each salesman's assigned parties, UNIONed with
  // the primary totals (mirrors the admin Wallets board) — NOT gated on zero primary,
  // which used to make earlier NULL-created_by collections vanish once one stamped
  // payment arrived. In this deployment legacy is the bulk of the figure.
  const legacyByCanonical = await legacyCollectionByParty(salesmen, matchIdToCanonical, monthFrom)
  for (const [canonical, amount] of legacyByCanonical) {
    collectedByCanonical.set(canonical, (collectedByCanonical.get(canonical) || 0) + amount)
  }

  const entries: Omit<RankingEntry, 'rank'>[] = salesmen.map((s) => {
    const paymentValue = collectedByCanonical.get(s.id) || 0
    return {
      id: s.id,
      name: s.name,
      code: s.code,
      invoiceValue: 0,
      paymentValue,
      score: paymentValue,
      isSelf: false,
    }
  })

  // Every true salesman is listed — even at ₹0 this month — so the full roster
  // shows with zero-collectors tied at the bottom, climbing in real time as
  // collections land. Drivers are already excluded in loadSalesmen().
  return rankEntries(entries)
}

/** Trim a full board to the self view: top 3 + the self row (deduped, ordered). */
function selfView(full: RankingEntry[], selfId: string | null): RankingEntry[] {
  const top = full.slice(0, 3)
  if (!selfId) return top
  if (top.some((e) => e.id === selfId)) return top
  const selfEntry = full.find((e) => e.id === selfId)
  return selfEntry ? [...top, selfEntry] : top
}

export interface RankingRequest {
  rootId: string | null
  /** ADMIN / SUPER_ADMIN see full boards; everyone else sees their own row only. */
  isAdminView: boolean
  /** The caller's board ('party' for dealers/cnf/retailers, 'salesman' for salesmen). */
  selfBoard: BoardKind
  /** The caller's own party type (for party self-view category). */
  selfCategory: string | null
  /** The caller's own entity id (party_id or app_user_id) for highlighting. */
  selfId: string | null
  /** Admin filters. */
  requestedBoard: BoardKind
  requestedCategory: string | null
}

export async function computeRanking(req: RankingRequest): Promise<RankingBoard> {
  const period = currentMonthWindow()
  const treeIds = await companyTreeIds(req.rootId)

  // ---- Admin view: full board, driven by query params ----
  if (req.isAdminView) {
    if (req.requestedBoard === 'salesman') {
      const full = await loadSalesmanBoard(treeIds, period.from)
      return {
        board: 'salesman',
        category: null,
        scope: 'admin',
        period,
        entries: full,
        totalCount: full.length,
        self: null,
        tip: null,
      }
    }
    const byCat = await loadPartyData(treeIds, period.from)
    const category =
      (req.requestedCategory as RankablePartyType | null) &&
      RANKABLE_PARTY_TYPES.includes(req.requestedCategory as RankablePartyType)
        ? (req.requestedCategory as RankablePartyType)
        : 'SUPER_DEALER'
    const full = byCat.get(category as RankablePartyType) || []
    return {
      board: 'party',
      category,
      scope: 'admin',
      period,
      entries: full,
      totalCount: full.length,
      self: null,
      tip: null,
      categories: [...RANKABLE_PARTY_TYPES],
    }
  }

  // ---- Self view: salesman ----
  // A salesman sees the FULL roster (every salesman + rank), with their own row
  // highlighted — not just the top 3 + self. Party self-view stays trimmed.
  if (req.selfBoard === 'salesman') {
    const full = await loadSalesmanBoard(treeIds, period.from)
    const marked = full.map((e) => ({ ...e, isSelf: e.id === req.selfId }))
    const self = marked.find((e) => e.isSelf) || null
    return {
      board: 'salesman',
      category: null,
      scope: 'self',
      period,
      entries: marked,
      totalCount: marked.length,
      self,
      tip: buildTip('salesman', marked, self),
    }
  }

  // ---- Self view: party (own category only) ----
  const byCat = await loadPartyData(treeIds, period.from)
  const category =
    (req.selfCategory as RankablePartyType | null) &&
    RANKABLE_PARTY_TYPES.includes(req.selfCategory as RankablePartyType)
      ? (req.selfCategory as RankablePartyType)
      : null
  const full = (category ? byCat.get(category) : []) || []
  const marked = full.map((e) => ({ ...e, isSelf: e.id === req.selfId }))
  const self = marked.find((e) => e.isSelf) || null
  return {
    board: 'party',
    category,
    scope: 'self',
    period,
    entries: selfView(marked, req.selfId),
    totalCount: marked.length,
    self,
    tip: buildTip('party', marked, self),
  }
}
