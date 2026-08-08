import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, getUserFromToken, resolveCompanyScope, getAllowedPartyIds, getPartyDescendants, loadActivePartyRows } from '@/lib/supabase-server'
import { getScopedPartyIdsForUser } from '@/lib/party-scope'
import { IN_FILTER_MAX_IDS, fetchAllInChunks, fetchAllRows } from '@/lib/supabase-in-chunks'
import { computeCurrentBalances } from '@/lib/party-balance'
import { parseWalletAdjustNote, WALLET_ADJUST_NOTE_PREFIX } from '@/lib/wallet-adjust-fallback'
import { ensureGroupsSchema, hasGroupsSchema } from '@/lib/groups'
import { getFallbackGroup, updateFallbackGroup } from '@/lib/groups-fallback'
import { validateRequiredCoordinates } from '@/lib/location-coordinates'
import { createHash } from 'crypto'

// Party creation (and especially COMPANY creation, which provisions a Supabase Auth
// admin account) makes several serial round trips to a DB ~450ms away. Under Vercel's
// default function timeout (10s) those slow-but-valid requests get killed mid-flight,
// surfacing to the user as "can't create party". Give the route real headroom so a
// completing request is never cut off. (Capped to the plan's max; harmless if lower.)
export const maxDuration = 60
// Never statically optimize — every request must run the handler fresh.
export const dynamic = 'force-dynamic'

function hashPassword(plain: string): string {
  return createHash('sha256').update(plain).digest('hex')
}

// Build the PostgREST `.or()` search filter for a party search term.
// The ilike value is wrapped in double quotes (and embedded backslashes/quotes
// escaped) so reserved characters in the term — especially commas, which
// PostgREST treats as logic-tree separators — don't break filter parsing.
// Without this, searching a name like "ABC Traders, Pvt Ltd" returns a 400
// (PGRST100) and the whole search appears broken.
function buildPartySearchFilter(
  search: string,
  phoneColumn: string | null,
  includePortalPhone: boolean,
): string {
  const value = `"%${search.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}%"`
  const parts = [
    `name.ilike.${value}`,
    `party_code.ilike.${value}`,
    `gstin.ilike.${value}`,
  ]
  if (phoneColumn) parts.push(`${phoneColumn}.ilike.${value}`)
  if (includePortalPhone) parts.push(`portal_phone.ilike.${value}`)
  return parts.join(',')
}

const TAX_TEMPLATE_NOTE_PREFIX = 'SYSTEM_DEFAULT_TAX_TEMPLATE::'

// Which optional `parties` columns this deployment's schema actually has.
// The layout is fixed for the life of a deployment, so probing it on every
// POST (8 serialized-await PostgREST calls to a ~450ms-away DB) is pure waste.
// We probe once, cache the result, and reuse it. Cached for the process; a new
// deploy restarts the process and re-probes.
interface PartiesSchemaShape {
  useNewStyle: boolean
  hasAddressLine1: boolean
  hasVerificationCols: boolean
  hasPortalCols: boolean
  hasOpeningBalance: boolean
  hasWalletBalance: boolean
  hasBalanceCols: boolean
  hasLatitude: boolean
  hasLongitude: boolean
}
let partiesSchemaCache: PartiesSchemaShape | null = null
let partiesSchemaInflight: Promise<PartiesSchemaShape> | null = null

async function getPartiesSchema(): Promise<PartiesSchemaShape> {
  if (partiesSchemaCache) return partiesSchemaCache
  if (partiesSchemaInflight) return partiesSchemaInflight
  partiesSchemaInflight = (async () => {
    const [contactProbe, addressLineProbe, verificationProbe, portalProbe, obProbe, wbProbe, latitudeProbe, longitudeProbe] = await Promise.all([
      supabaseAdmin.from('parties').select('contact_phone').limit(0),
      supabaseAdmin.from('parties').select('address_line1').limit(0),
      supabaseAdmin.from('parties').select('is_verified').limit(0),
      supabaseAdmin.from('parties').select('portal_password_hash').limit(0),
      supabaseAdmin.from('parties').select('opening_balance').limit(0),
      supabaseAdmin.from('parties').select('wallet_balance').limit(0),
      supabaseAdmin.from('parties').select('latitude').limit(0),
      supabaseAdmin.from('parties').select('longitude').limit(0),
    ])
    const hasOpeningBalance = !obProbe.error
    const hasWalletBalance = !wbProbe.error
    const shape: PartiesSchemaShape = {
      useNewStyle: !contactProbe.error,
      hasAddressLine1: !addressLineProbe.error,
      hasVerificationCols: !verificationProbe.error,
      hasPortalCols: !portalProbe.error,
      hasOpeningBalance,
      hasWalletBalance,
      hasBalanceCols: hasOpeningBalance || hasWalletBalance,
      hasLatitude: !latitudeProbe.error,
      hasLongitude: !longitudeProbe.error,
    }
    partiesSchemaCache = shape
    return shape
  })()
  try {
    return await partiesSchemaInflight
  } finally {
    partiesSchemaInflight = null
  }
}

// ── GET-path immutable lookups ───────────────────────────────────────────────
// The list endpoint resolved these on EVERY request: 5 column probes + the
// COMPANY party-type id. Both are fixed for the life of a deployment, yet each
// added a serial round-trip to a ~450ms-away DB — the dominant share of the
// "parties take too long to reflect" latency. Probe once, cache for the process.
interface GetColumnsShape {
  hasVerificationColumn: boolean
  verificationColumn: 'is_verified' | 'gstin_verified' | null
  phoneColumn: 'phone' | 'contact_phone' | null
  hasPortalPhone: boolean
}
let getColumnsCache: GetColumnsShape | null = null
let getColumnsInflight: Promise<GetColumnsShape> | null = null

async function getGetColumns(): Promise<GetColumnsShape> {
  if (getColumnsCache) return getColumnsCache
  if (getColumnsInflight) return getColumnsInflight
  getColumnsInflight = (async () => {
    const [verificationProbe, gstinProbe, phoneProbe, contactPhoneProbe, portalPhoneProbe] = await Promise.all([
      supabaseAdmin.from('parties').select('is_verified').limit(0),
      supabaseAdmin.from('parties').select('gstin_verified').limit(0),
      supabaseAdmin.from('parties').select('phone').limit(0),
      supabaseAdmin.from('parties').select('contact_phone').limit(0),
      supabaseAdmin.from('parties').select('portal_phone').limit(0),
    ])
    const hasVerificationColumn = !verificationProbe.error
    const shape: GetColumnsShape = {
      hasVerificationColumn,
      verificationColumn: hasVerificationColumn
        ? 'is_verified'
        : !gstinProbe.error
        ? 'gstin_verified'
        : null,
      phoneColumn: !phoneProbe.error ? 'phone' : (!contactPhoneProbe.error ? 'contact_phone' : null),
      hasPortalPhone: !portalPhoneProbe.error,
    }
    getColumnsCache = shape
    return shape
  })()
  try {
    return await getColumnsInflight
  } finally {
    getColumnsInflight = null
  }
}

// The COMPANY party-type id never changes. Cache it so the "exclude companies"
// filter doesn't cost a round-trip on every list load.
let companyTypeIdCache: string | null = null
async function getCompanyTypeId(): Promise<string | null> {
  if (companyTypeIdCache) return companyTypeIdCache
  const { data } = await supabaseAdmin
    .from('party_types')
    .select('id')
    .eq('name', 'COMPANY')
    .single()
  companyTypeIdCache = data?.id ?? null
  return companyTypeIdCache
}

// Short-TTL cache for the resolved company scope (the full descendant id set).
// getPartyDescendants/loadActivePartyRows are already cached, but the companyRow
// code lookup and the BFS rebuild still ran per request. Caching the assembled
// result collapses repeat loads (polling, multiple users on the same company)
// to a single computation per company per window.
const COMPANY_SCOPE_TTL_MS = Number(process.env.COMPANY_SCOPE_TTL_MS || 30_000)
const companyScopeCache = new Map<string, { ids: string[]; expires: number }>()

async function getCompanyPartyIds(companyId: string): Promise<string[]> {
  const now = Date.now()
  const cached = companyScopeCache.get(companyId)
  if (cached && cached.expires > now) return cached.ids
  const ids = await computeCompanyPartyIds(companyId)
  companyScopeCache.set(companyId, { ids, expires: now + COMPANY_SCOPE_TTL_MS })
  return ids
}

async function computeCompanyPartyIds(companyId: string): Promise<string[]> {
  const ids = new Set<string>([companyId])
  let companyCode = ''

  try {
    const tree = await getPartyDescendants(companyId)
    for (const row of tree || []) {
      if ((row as { id?: string }).id) ids.add((row as { id: string }).id)
    }
  } catch (e) {
    console.warn('[PARTIES GET] get_party_descendants failed, falling back to parent_party_id tree', e)
  }

  const { data: companyRow } = await supabaseAdmin
    .from('parties')
    .select('party_code')
    .eq('id', companyId)
    .maybeSingle()
  companyCode = (companyRow?.party_code || '').trim().toUpperCase()

  // Reuse the shared, cached active-party edge list instead of re-paging the whole
  // `parties` table here. getPartyDescendants() above already triggered this same
  // scan in this request, so loadActivePartyRows() returns from cache — turning what
  // was a second multi-second full-table scan (the dominant cost that pushed this
  // endpoint to 15-30s and made it time out to a 500) into an in-memory hit.
  const rows = await loadActivePartyRows()
  if (!rows) {
    console.warn('[PARTIES GET] active party rows unavailable; returning descendant scope only')
    return Array.from(ids)
  }

  const childrenByParent = new Map<string, string[]>()
  for (const row of (rows || []) as { id: string; parent_party_id: string | null; party_code: string | null }[]) {
    const partyCode = (row.party_code || '').trim().toUpperCase()
    if (!row.parent_party_id && companyCode && row.id !== companyId && partyCode.startsWith(companyCode)) {
      ids.add(row.id)
    }
    if (!row.parent_party_id) continue
    const children = childrenByParent.get(row.parent_party_id) || []
    children.push(row.id)
    childrenByParent.set(row.parent_party_id, children)
  }

  // Seed the BFS frontier with EVERY id already known to be in-company — the
  // company root, all get_party_descendants rows, and any root-less party whose
  // code carries the company prefix — not just companyId. The descendants RPC
  // truncates at 1000 rows and can return a parent (e.g. a CNF) while cutting off
  // its own children (that CNF's super dealers). Reusing the result set as the
  // BFS "visited" guard while seeding only from companyId makes those truncated
  // parents test as already-seen, so they're never enqueued and their stranded
  // sub-trees never get walked — silently dropping whole branches of the tree.
  // Exploring children of every seeded node rescues them. A child of an
  // in-company node is itself in-company, so this never leaks other companies.
  const queue = Array.from(ids)
  for (let head = 0; head < queue.length; head++) {
    const parentId = queue[head]
    for (const childId of childrenByParent.get(parentId) || []) {
      if (ids.has(childId)) continue
      ids.add(childId)
      queue.push(childId)
    }
  }

  return Array.from(ids)
}

export async function GET(req: NextRequest) {
  try {
    let stage = 'init'
    const url = new URL(req.url)
    const search = url.searchParams.get('search') || ''
    const partyType = url.searchParams.get('party_type') || ''
    const typeName  = url.searchParams.get('type_name')  || ''
    const territoryId = url.searchParams.get('territory_id') || ''
    const isVerified = url.searchParams.get('is_verified')
    const routePlanning = url.searchParams.has('route_planning')
    // Lightweight mode: skip per-party balance derivation and tax-template
    // enrichment. Used by selector/picker UIs that only render name + code,
    // where computing balances for 1000+ parties is pure latency.
    const minimal = url.searchParams.has('minimal')
    const page = parseInt(url.searchParams.get('page') || '1')
    const limit = parseInt(url.searchParams.get('limit') || '20')
    const offset = (page - 1) * limit
    // Column shape is fixed per deployment — resolved once and cached (see
    // getGetColumns) instead of re-probing the DB on every list load.
    const { hasVerificationColumn, verificationColumn, phoneColumn, hasPortalPhone } = await getGetColumns()

      // Identify the calling user
      stage = 'auth'
      const authUser = await getUserFromToken(req)
      if (!authUser) {
        return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 })
      }

      // Company scope: SUPER_ADMIN uses x-company-id header; ADMIN auto-scopes to own party_id
      const companyId = await resolveCompanyScope(req, authUser)

    // CRITICAL: First, get all party IDs under this company to ensure data isolation
    // This prevents users from seeing parties from other companies
    let companyPartyIds: string[] | null = null
    if (companyId) {
      companyPartyIds = await getCompanyPartyIds(companyId)
    }

    // Get allowed party IDs based on user's role permission scope
    // Uses PARTY/TERRITORY scope from permissions table - user only sees parties in their assigned downline
    let allowedPartyIds: string[] | null = null
    if (authUser && authUser.role !== 'ADMIN') {
      try {
        allowedPartyIds = await getAllowedPartyIds(authUser.id, authUser.role, authUser.party_id, companyId, 'parties')
      } catch (e) {
        // Fail open to company scope instead of crashing endpoint
        console.warn('[PARTIES GET] getAllowedPartyIds failed, skipping permission scope filter', e)
        allowedPartyIds = null
      }
    }

    // Combine company scope with permission scope
    // If companyPartyIds is set, we must filter by it first
    // Then apply allowedPartyIds if it's set (permission-based filtering)
    let finalPartyIds: string[] | null = null
    if (companyPartyIds !== null) {
      if (allowedPartyIds !== null) {
        // Intersection of company parties and allowed parties
        finalPartyIds = companyPartyIds.filter(id => allowedPartyIds.includes(id))
      } else {
        // Only company filtering (e.g., SUPER_ADMIN with ALL scope)
        finalPartyIds = companyPartyIds
      }
    } else if (allowedPartyIds !== null) {
      // Only permission filtering (no company scope)
      finalPartyIds = allowedPartyIds
    }

    // SALESMAN: override finalPartyIds using the authoritative party_salesman junction table.
    // The salesman_id column on parties may be stale or NULL; the junction table is the
    // canonical source (same one the Downline page uses).
    // Skip scope override for route_planning requests — salesmen need to see all company
    // parties when building route stops, but company isolation still applies.
    if (authUser?.role === 'SALESMAN' && !routePlanning) {
      finalPartyIds = await getScopedPartyIdsForUser(authUser, companyId)
    }

    if (finalPartyIds !== null && finalPartyIds.length === 0) {
      return NextResponse.json({ success: true, data: [], pagination: { page, limit, total: 0, pages: 0 } })
    }

    // Resolve the requested party type into a party_type_id UUID.
    // `party_type` may arrive as either a UUID (company/parent pickers) or a
    // type NAME (the SUPER_DEALER/CNF/RETAILER filter buttons). Passing a name
    // straight into .eq('party_type_id', …) makes Postgres 500 with "invalid
    // input syntax for type uuid", so names must be looked up first. Unknown
    // names resolve to '' (no type filter), matching the type_name behaviour.
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    let resolvedPartyTypeId = ''
    if (partyType && UUID_RE.test(partyType)) {
      resolvedPartyTypeId = partyType
    } else {
      const typeNameToResolve = partyType || typeName
      if (typeNameToResolve) {
        const { data: typeRow } = await supabaseAdmin
          .from('party_types')
          .select('id')
          .ilike('name', typeNameToResolve)
          .maybeSingle()
        if (typeRow?.id) resolvedPartyTypeId = typeRow.id
      }
    }

    // Exclude COMPANY-type parties — those are companies, not trade parties.
    // The id is immutable, so it's resolved once and cached (see getCompanyTypeId).
    const companyType = { id: await getCompanyTypeId() }

    // Legacy schemas without verification columns cannot have verified parties.
    if (!verificationColumn && isVerified === 'true') {
      return NextResponse.json({ success: true, data: [], pagination: { page, limit, total: 0, pages: 0 } })
    }

    // Large company scopes cannot be passed to a single .in() filter — PostgREST puts
    // the IDs in the request URL and ~400+ UUIDs overflow undici's 16KB header limit
    // (UND_ERR_HEADERS_OVERFLOW). Pre-resolve the matching page with chunked id-only
    // queries, then run the full row query against just that page's IDs.
    let pagePartyIds = finalPartyIds
    let pageOffset = offset
    let chunkedTotal: number | null = null
    if (finalPartyIds !== null && finalPartyIds.length > IN_FILTER_MAX_IDS) {
      stage = 'chunked-id-prefilter'
      const { data: idRows, error: idError } = await fetchAllInChunks(finalPartyIds, (chunk) => {
        let idQuery = supabaseAdmin
          .from('parties')
          .select('id, name')
          .eq('status', 'ACTIVE')
          .in('id', chunk)
        if (companyType?.id && !resolvedPartyTypeId) idQuery = idQuery.neq('party_type_id', companyType.id)
        if (search) {
          idQuery = idQuery.or(buildPartySearchFilter(search, phoneColumn, hasPortalPhone))
        }
        if (resolvedPartyTypeId) idQuery = idQuery.eq('party_type_id', resolvedPartyTypeId)
        if (territoryId) idQuery = idQuery.eq('territory_id', territoryId)
        if (verificationColumn) {
          if (isVerified === 'false') idQuery = idQuery.or(`${verificationColumn}.is.null,${verificationColumn}.eq.false`)
          else if (isVerified === 'true') idQuery = idQuery.eq(verificationColumn, true)
          else if (isVerified !== 'all') idQuery = idQuery.eq(verificationColumn, true)
        }
        return idQuery
      })
      if (idError) {
        console.error('[PARTIES GET] stage:', stage, 'error:', JSON.stringify(idError, null, 2))
        throw idError
      }
      const matched = ((idRows || []) as { id: string; name: string | null }[])
        .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')))
      chunkedTotal = matched.length
      pagePartyIds = matched.slice(offset, offset + limit).map((r) => r.id)
      pageOffset = 0
      if (pagePartyIds.length === 0) {
        return NextResponse.json({
          success: true,
          data: [],
          pagination: { page, limit, total: chunkedTotal, pages: Math.ceil(chunkedTotal / limit) },
        })
      }
    }

    // Thenable shape shared by every stage's query builder so runPageQuery can
    // chunk or paginate them uniformly.
    interface PartyPageQuery extends PromiseLike<{
      data: Record<string, unknown>[] | null
      count: number | null
      error: { code?: string; message?: string } | null
    }> {
      in(column: string, values: string[]): PartyPageQuery
      range(from: number, to: number): PartyPageQuery
    }

    // Executes one page query. When the page's own ID list exceeds the URL-safe
    // .in() size (large `limit` requests against a chunked-prefiltered scope),
    // fetch the rows chunk by chunk, merge and re-sort instead of paginating.
    const runPageQuery = async (build: () => PartyPageQuery) => {
      if (pagePartyIds !== null && pagePartyIds.length > IN_FILTER_MAX_IDS) {
        const { data, error } = await fetchAllInChunks(pagePartyIds, (chunk) => build().in('id', chunk))
        if (error) return { data: null, count: null, error }
        const rows = [...(data || [])]
        rows.sort((a, b) => String(a.name ?? '').localeCompare(String(b.name ?? '')))
        return { data: rows, count: chunkedTotal, error: null }
      }
      // A single .range() is still capped by PostgREST's max-rows (1000 by
      // default), so a large `limit` (the dues/wallet screens request 5000)
      // silently truncates the page — dropping parties, and with them any dues
      // they carry. Sub-paginate the requested window in <=1000-row slices so
      // every row in the page is returned regardless of how big `limit` is.
      const windowEnd = pageOffset + limit - 1
      const SLICE = 1000
      const merged: Record<string, unknown>[] = []
      let total: number | null = null
      for (let from = pageOffset; from <= windowEnd; from += SLICE) {
        const to = Math.min(from + SLICE - 1, windowEnd)
        const query = pagePartyIds !== null ? build().in('id', pagePartyIds) : build()
        const { data, count, error } = await query.range(from, to)
        if (error) return { data: null, count: null, error }
        if (count != null) total = count
        const slice = (data || []) as Record<string, unknown>[]
        merged.push(...slice)
        if (slice.length < to - from + 1) break // short slice → no more rows
      }
      return { data: merged, count: total, error: null }
    }

    // Applies every filter shared by all three query stages (verification default:
    // operational modules only see verified parties unless explicitly overridden).
    const applyPartyFilters = (query: PartyPageQuery, { includePortalPhoneSearch = true } = {}) => {
      // The builder type intentionally only exposes in/range; cast through the
      // loose supabase builder shape for the filter methods.
      let q = query as unknown as {
        neq(c: string, v: string): unknown
        eq(c: string, v: string | boolean): unknown
        or(f: string): unknown
      }
      // Only exclude COMPANY type when no specific type filter is requested.
      // When party_type param is set (e.g. company picker passing COMPANY type ID), trust the caller.
      if (companyType?.id && !resolvedPartyTypeId) q = q.neq('party_type_id', companyType.id) as typeof q
      if (search) {
        q = q.or(buildPartySearchFilter(search, phoneColumn, includePortalPhoneSearch && hasPortalPhone)) as typeof q
      }
      if (resolvedPartyTypeId) q = q.eq('party_type_id', resolvedPartyTypeId) as typeof q
      if (territoryId) q = q.eq('territory_id', territoryId) as typeof q
      if (verificationColumn) {
        if (isVerified === 'false') q = q.or(`${verificationColumn}.is.null,${verificationColumn}.eq.false`) as typeof q
        else if (isVerified === 'true') q = q.eq(verificationColumn, true) as typeof q
        else if (isVerified !== 'all') q = q.eq(verificationColumn, true) as typeof q
      }
      return q as unknown as PartyPageQuery
    }

    stage = 'query-with-relations'
    let { data, count, error } = await runPageQuery(() =>
      applyPartyFilters(
        supabaseAdmin
          .from('parties')
          .select('*, party_types(name), salesman:salesman_id(id, name), verifier:verified_by(id, name)', { count: 'exact' })
          .eq('status', 'ACTIVE')
          .order('name') as unknown as PartyPageQuery
      )
    )
    if (error && (error.code === 'PGRST200' || error.code === 'PGRST204' || error.code === '42703')) {
      stage = 'fallback-minimal-select'
      ;({ data, count, error } = await runPageQuery(() =>
        applyPartyFilters(
          supabaseAdmin
            .from('parties')
            .select('*', { count: 'exact' })
            .eq('status', 'ACTIVE')
            .order('name') as unknown as PartyPageQuery
        )
      ))
    }
    if (error && error.code === '42703') {
      stage = 'fallback-without-optional-columns'
      ;({ data, count, error } = await runPageQuery(() =>
        applyPartyFilters(
          supabaseAdmin
            .from('parties')
            .select('*', { count: 'exact' })
            .eq('status', 'ACTIVE')
            .order('name') as unknown as PartyPageQuery,
          { includePortalPhoneSearch: false }
        )
      ))
    }
    if (error) {
      console.error('[PARTIES GET] stage:', stage, 'error:', JSON.stringify(error, null, 2))
      throw error
    }

    const rows = (data || []) as Record<string, unknown>[]
    const missingTypeIds = [...new Set(
      rows
        .filter((r) => !r.party_types && !!r.party_type_id)
        .map((r) => String(r.party_type_id))
    )]
    const partyTypeMap: Record<string, { id: string; name: string }> = {}
    if (missingTypeIds.length > 0) {
      const { data: ptRows } = await supabaseAdmin
        .from('party_types')
        .select('id, name')
        .in('id', missingTypeIds)
      for (const pt of ptRows || []) {
        partyTypeMap[pt.id] = { id: pt.id, name: pt.name }
      }
    }

    // Fetch balance columns via direct SQL if * select missed them (stale PostgREST schema cache)
    const sampleRow = rows[0] as Record<string, unknown> | undefined
    const balanceMissing = rows.length > 0 && (sampleRow?.opening_balance === undefined || sampleRow?.wallet_balance === undefined)
    const balanceMap: Record<string, { opening_balance: number; wallet_balance: number }> = {}
    if (balanceMissing) {
      const ids = rows.map((r: Record<string, unknown>) => `'${r.id}'`).join(',')
      const balResult = await supabaseAdmin.rpc('exec_sql', {
        sql: `SELECT id, COALESCE(opening_balance,0) AS opening_balance, COALESCE(wallet_balance,0) AS wallet_balance FROM public.parties WHERE id IN (${ids})`
      })
      const { data: balRows } = balResult.error ? { data: null } : balResult
      for (const br of (balRows as { id: string; opening_balance: number; wallet_balance: number }[] | null) || []) {
        balanceMap[br.id] = { opening_balance: Number(br.opening_balance), wallet_balance: Number(br.wallet_balance) }
      }
    }

    // Compatibility: older databases may not have parties.wallet_balance or
    // wallet_transactions. In that case derive wallet credit from saved payments
    // so party balances still move immediately after recording a payment.
    const paymentCreditMap: Record<string, number> = {}
    const manualAdjustMap: Record<string, number> = {}
    if (balanceMissing && rows.length > 0) {
      const rowIds = rows.map((r) => String(r.id)).filter(Boolean)
      const rowIdSet = new Set(rowIds)
      const { data: paymentRows } = await supabaseAdmin
        .from('payments')
        .select('party_id, amount')
        .in('party_id', rowIds)
      for (const payment of paymentRows || []) {
        const partyId = String(payment.party_id || '')
        if (!partyId) continue
        paymentCreditMap[partyId] = (paymentCreditMap[partyId] || 0) + Number(payment.amount || 0)
      }

      const { data: noteRows } = await supabaseAdmin
        .from('company_notes')
        .select('note')
        .like('note', `${WALLET_ADJUST_NOTE_PREFIX}%`)
        .limit(5000)
      for (const row of (noteRows || []) as { note: string | null }[]) {
        const parsed = parseWalletAdjustNote(row.note)
        if (!parsed) continue
        if (!rowIdSet.has(parsed.party_id)) continue
        manualAdjustMap[parsed.party_id] = (manualAdjustMap[parsed.party_id] || 0) + Number(parsed.delta || 0)
      }
    }

    const normalized = rows.map((row: Record<string, unknown>) => {
      const partyTypesRaw = row.party_types as unknown
      const salesmanRaw = row.salesman as unknown
      const verifierRaw = row.verifier as unknown

      let party_types = Array.isArray(partyTypesRaw)
        ? (partyTypesRaw[0] as { name?: string } | undefined) || null
        : (partyTypesRaw as { name?: string } | null)
      if (!party_types && row.party_type_id) {
        party_types = partyTypeMap[String(row.party_type_id)] || null
      }

      const salesman = Array.isArray(salesmanRaw)
        ? (salesmanRaw[0] as { id?: string; name?: string } | undefined) || null
        : (salesmanRaw as { id?: string; name?: string } | null)

      const verifier = Array.isArray(verifierRaw)
        ? (verifierRaw[0] as { id?: string; name?: string } | undefined) || null
        : (verifierRaw as { id?: string; name?: string } | null)

      const id = String(row.id)
      const bal = balanceMap[id]
      const derivedPaymentCredit = paymentCreditMap[id] || 0

      return {
        ...row,
        opening_balance: bal ? bal.opening_balance : Number(row.opening_balance ?? 0),
        wallet_balance: bal ? bal.wallet_balance : Number(row.wallet_balance ?? (derivedPaymentCredit + (manualAdjustMap[id] || 0))),
        ...(!hasVerificationColumn
          ? {
              is_verified: verificationColumn === 'gstin_verified' ? row.gstin_verified === true : false,
              verified_by: null,
              verified_at: verificationColumn === 'gstin_verified' ? row.gstin_verified_at || null : null,
            }
          : {}),
        party_types,
        salesman,
        verifier,
      }
    })

    // Attach the true derived current balance (opening + payments − invoices,
    // including confirmed invoice_requests). There is no maintained wallet_balance
    // column, so we also fold the derived delta back into wallet_balance — that way
    // every existing consumer that computes `opening_balance + wallet_balance` gets
    // the correct current balance without each having to change.
    // Balance derivation and the tax-template-note fallback are independent reads,
    // so fire them concurrently instead of one-after-the-other — both run only on
    // non-minimal loads and previously stacked their latency serially.
    const balancePromise = !minimal
      ? computeCurrentBalances(
          (normalized as Record<string, unknown>[]).map((r) => ({
            id: String(r.id || ''),
            opening_balance: Number(r.opening_balance ?? 0),
          }))
        ).catch((e) => {
          console.warn('[PARTIES GET] current balance derivation failed', e)
          return null
        })
      : null
    const taxNotesPromise = (companyId && !minimal)
      ? supabaseAdmin
          .from('company_notes')
          .select('note')
          .eq('company_id', companyId)
          .like('note', `${TAX_TEMPLATE_NOTE_PREFIX}%`)
          .then((r) => r.data)
          .catch(() => null)
      : null

    if (balancePromise) {
      const currentBalances = await balancePromise
      if (currentBalances) {
        for (const r of normalized as Record<string, unknown>[]) {
          const id = String(r.id || '')
          const opening = Number(r.opening_balance ?? 0)
          const current = currentBalances[id] ?? opening
          r.current_balance = current
          r.wallet_balance = current - opening
        }
      }
    }

    // Fallback for schemas without parties.default_tax_template_id:
    // read per-party mappings from company_notes system markers.
    if (taxNotesPromise) {
      const noteRows = await taxNotesPromise
      const map = new Map<string, string | null>()
      for (const row of noteRows || []) {
        const note = String((row as { note?: string }).note || '')
        if (!note.startsWith(TAX_TEMPLATE_NOTE_PREFIX)) continue
        const rest = note.slice(TAX_TEMPLATE_NOTE_PREFIX.length)
        const parts = rest.split('::')
        if (parts.length < 2) continue
        const partyId = parts[0]
        const tplId = parts.slice(1).join('::') || null
        if (partyId) map.set(partyId, tplId)
      }

      if (map.size > 0) {
        for (const row of normalized as Record<string, unknown>[]) {
          const partyId = String(row.id || '')
          if (!partyId) continue
          if (map.has(partyId)) {
            row.default_tax_template_id = map.get(partyId) || null
          }
        }
      }
    }

    return NextResponse.json({
      success: true,
      data: normalized,
      pagination: {
        page,
        limit,
        total: chunkedTotal ?? (count || 0),
        pages: Math.ceil((chunkedTotal ?? (count || 0)) / limit),
      },
    })
  } catch (err) {
    console.error('[PARTIES GET] caught:', err)
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed to fetch parties' },
      { status: 500 }
    )
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    console.log('[PARTIES POST] Received body:', JSON.stringify(body, null, 2))

    const locationResult = validateRequiredCoordinates(body.latitude, body.longitude)
    if (!locationResult.success) {
      return NextResponse.json(
        { success: false, message: locationResult.message },
        { status: 400 },
      )
    }
    const latitudeVal = locationResult.coordinates.latitude
    const longitudeVal = locationResult.coordinates.longitude

    // Identify the calling user and resolve company scope
    const authUser = await getUserFromToken(req)
    const companyId = await resolveCompanyScope(req, authUser)

    // For SALESMAN: resolveCompanyScope only uses the x-company-id header, which the salesman
    // app doesn't set. Fall back to looking up the salesman's own party_id from the users table.
    let effectiveCompanyId = companyId
    if (authUser?.role === 'SALESMAN' && !effectiveCompanyId) {
      const salesmanUserId = authUser.app_user_id || authUser.id
      const { data: userRow } = await supabaseAdmin
        .from('users')
        .select('party_id')
        .eq('id', salesmanUserId)
        .maybeSingle()
      if (userRow?.party_id) effectiveCompanyId = userRow.party_id
    }

    // GSTIN validation if provided
    if (body.gstin) {
      const gstinPattern = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/
      if (!gstinPattern.test(body.gstin)) {
        return NextResponse.json(
          { success: false, message: 'Invalid GSTIN format. Expected: 2-digit state code + PAN + 3 chars' },
          { status: 400 }
        )
      }
      // Verify state code matches party state
      if (body.state_id) {
        const { data: state } = await supabaseAdmin
          .from('states')
          .select('gstin_prefix')
          .eq('id', body.state_id)
          .single()
        if (state && body.gstin.substring(0, 2) !== state.gstin_prefix) {
          return NextResponse.json(
            { success: false, message: `GSTIN state code ${body.gstin.substring(0, 2)} does not match selected state prefix ${state.gstin_prefix}` },
            { status: 400 }
          )
        }
      }
    }

      // Detect which optional `parties` columns this deployment has. Cached at the
      // module level after the first probe — the schema doesn't change between
      // requests, so this is a no-op (cache hit) on every POST after the first.
      const {
        useNewStyle,
        hasAddressLine1,
        hasVerificationCols,
        hasPortalCols,
        hasBalanceCols,
        hasOpeningBalance,
        hasWalletBalance,
        hasLatitude,
        hasLongitude,
      } = await getPartiesSchema()

      const phoneVal = body.contact_phone || body.phone || null
      const emailVal = body.contact_email || body.email || null
      const addressVal = body.address_line1 || body.address || null
      const cityVal = body.city || addressVal || null
      // `address_line1` carries a NOT NULL constraint in some schemas, so it must never
      // be inserted as null. Fall back to an empty string when no address was provided.
      const addressLine1Val = addressVal ?? ''
      // Enforce one-party-per-mobile-number within the company. The mobile number
      // doubles as the portal Login ID, so the same number must not register two
      // parties in the same company. We compare on normalized digits because the
      // contact phone may be stored formatted (spaces, +91) while portal_phone is
      // stored digits-only.
      const phoneDigits = String(phoneVal || '').replace(/[^0-9]/g, '')
      if (phoneDigits && effectiveCompanyId) {
        const phoneCol = useNewStyle ? 'contact_phone' : 'phone'
        const selectCols = ['id', 'name', 'party_code', phoneCol, ...(hasPortalCols ? ['portal_phone'] : [])].join(', ')
        // Targeted lookup instead of fetching EVERY party in the company and scanning
        // them in JS (which scaled with company size and dominated this endpoint's
        // latency). Phone numbers are ~unique, so matching on the digit form returns
        // a tiny candidate set; portal_phone is always stored digits-only, so an exact
        // match catches every party created through this app, and we also match the
        // contact column on its digit form for rows stored without separators. We then
        // keep only candidates that fall inside this company's scope. phoneDigits is
        // pure digits, so it's safe to interpolate into the PostgREST .or() filter.
        const orParts = [`${phoneCol}.eq.${phoneDigits}`]
        if (hasPortalCols) orParts.push(`portal_phone.eq.${phoneDigits}`)
        const { data: candidateRows } = await supabaseAdmin
          .from('parties')
          .select(selectCols)
          .eq('status', 'ACTIVE')
          .or(orParts.join(','))
          .limit(100)
        const candidates = (candidateRows || []) as unknown as Record<string, unknown>[]
        // Only resolve the (cached) company scope if there's actually a phone match to
        // disambiguate — avoids the descendant walk entirely on the common no-dup path.
        const companyIdSet = candidates.length > 0
          ? new Set(await getCompanyPartyIds(effectiveCompanyId))
          : new Set<string>()
        const dup = candidates.find((r) => {
          if (!companyIdSet.has(String(r.id))) return false
          const cp = String(r[phoneCol] ?? '').replace(/[^0-9]/g, '')
          const pp = String(r.portal_phone ?? '').replace(/[^0-9]/g, '')
          return cp === phoneDigits || pp === phoneDigits
        })
        if (dup) {
          return NextResponse.json(
            {
              success: false,
              message: `This mobile number is already registered to ${dup.name} (${dup.party_code}) in this company. Each party must have a unique mobile number.`,
            },
            { status: 409 }
          )
        }
      }

      // Build insert payload with only the contact columns that actually exist in the DB
      const insertPayload: Record<string, unknown> = {
        name: body.name,
        party_code: body.party_code || null,
        party_type_id: body.party_type_id || null,
        gstin: body.gstin || null,
        status: 'ACTIVE',
        created_by: authUser?.id || null,
        // Contact fields — layout chosen based on probe above
        ...(useNewStyle
          ? { contact_phone: phoneVal, contact_email: emailVal, city: cityVal }
          : { phone: phoneVal, email: emailVal, address: addressVal }),
        ...(hasAddressLine1 ? { address_line1: addressLine1Val } : {}),
        ...(hasVerificationCols ? { is_verified: false, verified_by: null, verified_at: null } : {}),
      }

      // Optional columns — add only if value is non-empty
      if (body.trade_name) insertPayload.trade_name = body.trade_name
      if (body.pin_code) insertPayload.pin_code = body.pin_code
      if (body.contact_person) insertPayload.contact_person = body.contact_person
      if (body.pan) insertPayload.pan = body.pan
      if (body.parent_party_id) insertPayload.parent_party_id = body.parent_party_id
      if (body.territory_id) insertPayload.territory_id = body.territory_id
      if (body.state_id) insertPayload.state_id = body.state_id
      if (body.district_id) insertPayload.district_id = body.district_id
      // A grouped party inherits salesman access from its group. Keep the legacy
      // direct assignment only for callers creating an ungrouped party.
      if (!body.group_id && body.salesman_id) insertPayload.salesman_id = body.salesman_id
      if (body.price_list_id) insertPayload.price_list_id = body.price_list_id
      if (body.contact_aadhaar_url) insertPayload.contact_aadhaar_url = body.contact_aadhaar_url
      if (hasOpeningBalance && body.opening_balance !== undefined && body.opening_balance !== null && body.opening_balance !== '') {
        insertPayload.opening_balance = parseFloat(String(body.opening_balance)) || 0
      }
      if (hasWalletBalance) {
        insertPayload.wallet_balance = 0
      }
      if (hasLatitude) insertPayload.latitude = latitudeVal
      if (hasLongitude) insertPayload.longitude = longitudeVal

      // Auto-set parent_party_id to the company for non-COMPANY party types
      // This ensures the party appears in the company's hierarchy tree
      const COMPANY_TYPE_ID = 'fdcc59d3-fdc1-4700-94eb-3c2cf7e28c03'
      if (!insertPayload.parent_party_id && effectiveCompanyId && body.party_type_id !== COMPANY_TYPE_ID) {
        insertPayload.parent_party_id = effectiveCompanyId
      }

      // Handle portal credentials — only add if the columns exist in this DB schema
      const plainPassword = typeof body.portal_password === 'string' ? body.portal_password : null
      if (hasPortalCols) {
        if (plainPassword) {
          insertPayload.portal_password_hash = hashPassword(plainPassword)
        }
        if (body.portal_phone) {
          // Normalize phone: strip non-digit characters to prevent login lookup mismatches
          insertPayload.portal_phone = String(body.portal_phone).replace(/[^0-9]/g, '')
        }
      }

      // Sanitize UUID fields — empty string causes DB type error; remove undefined ones entirely
      const uuidFields = ['party_type_id', 'state_id', 'district_id', 'territory_id', 'salesman_id', 'parent_party_id', 'price_list_id']
      for (const f of uuidFields) {
        if (insertPayload[f] === '') {
          insertPayload[f] = null
        } else if (insertPayload[f] === undefined) {
          delete insertPayload[f]   // don't send undefined UUID fields to PostgREST
        }
      }

      // Pull out provision_auth_user flag — not a DB column
      const provisionAuthUser = !!body.provision_auth_user

      // Validate party_type_id exists; if not, fall back to looking up by name.
      // Fetch id + name in one shot and reuse the name below (code generation and
      // auth provisioning both need it) instead of re-querying party_types 2 more
      // times — three serialized round-trips to a ~450ms-away DB collapse into one.
      // Kick off the parent company's party_code fetch NOW, in parallel with the
      // party_type lookup below. Auto-generated codes for non-company parties need
      // this (e.g. C001RT01), and it depends only on effectiveCompanyId — not on the
      // party type — so there's no reason to wait for the type lookup to finish first.
      // Collapses two serial ~450ms round trips into one on every create.
      const companyCodePromise = (effectiveCompanyId && !insertPayload.party_code)
        ? supabaseAdmin
            .from('parties')
            .select('party_code')
            .eq('id', effectiveCompanyId)
            .single()
        : null

      let partyTypeName = ''
      if (insertPayload.party_type_id) {
        const { data: typeCheck } = await supabaseAdmin
          .from('party_types')
          .select('id, name')
          .eq('id', insertPayload.party_type_id)
          .single()
        if (typeCheck) {
          partyTypeName = (typeCheck as { name?: string }).name ?? ''
        } else {
          // Provided ID doesn't exist — try to find COMPANY type by name
          const { data: fallback } = await supabaseAdmin
            .from('party_types')
            .select('id, name')
            .eq('name', 'COMPANY')
            .single()
          if (fallback) {
            insertPayload.party_type_id = fallback.id
            partyTypeName = (fallback as { name?: string }).name ?? 'COMPANY'
          } else {
            return NextResponse.json(
              { success: false, message: 'Invalid party_type_id and no COMPANY type found in database' },
              { status: 400 }
            )
          }
        }
      }

        // Ungrouped parties created by a salesman retain the legacy fallback.
        // Grouped parties are assigned exclusively through group membership.
        if (authUser?.role === 'SALESMAN' && !body.group_id) {
          insertPayload.salesman_id = authUser.app_user_id || authUser.id
        }

        // Auto-generate a meaningful party_code based on party type
        if (!insertPayload.party_code && insertPayload.party_type_id) {
          const prefixMap: Record<string, string> = {
            COMPANY: 'C',
            CNF: 'CNF',
            SUPER_DEALER: 'SD',
            RETAILER: 'RT',
            MANUFACTURER: 'MFR',
          }
          // Reuse the name already fetched during validation — no extra round-trip.
          const typeName = partyTypeName
          const typePrefix = typeName ? (prefixMap[typeName] ?? typeName.substring(0, 3).toUpperCase()) : 'PTY'
          const isCompanyType = typeName === 'COMPANY'

          // For non-company parties, prepend the parent company's party_code (e.g. C001RT01).
          // Reuse the fetch we kicked off in parallel with the party_type lookup above.
          let companyCode = ''
          if (!isCompanyType && effectiveCompanyId && companyCodePromise) {
            const { data: companyRow } = await companyCodePromise
            companyCode = (companyRow?.party_code || '').toUpperCase()
          }

          const fullPrefix = `${companyCode}${typePrefix}`

          // Find the highest existing sequence number for this prefix (scoped to company).
          // MUST page through every match: an unranged PostgREST select silently caps at
          // 1000 rows, so for companies with >1000 sub-parties the true max would be missed
          // and we'd regenerate a code that already exists (duplicate-key 409). Order by
          // party_code so pages are stable.
          const { data: existingCodes } = await fetchAllRows<{ party_code: string }>(
            (from, to) =>
              supabaseAdmin
                .from('parties')
                .select('party_code')
                .ilike('party_code', `${fullPrefix}%`)
                .order('party_code', { ascending: true })
                .range(from, to),
          )

          let maxSeq = 0
          for (const row of (existingCodes || [])) {
            const code = ((row as { party_code: string }).party_code || '').toUpperCase()
            const numPart = code.replace(new RegExp(fullPrefix, 'i'), '')
            const num = parseInt(numPart, 10)
            if (!isNaN(num) && num > maxSeq) maxSeq = num
          }

          // Companies get 3-digit seq (C001), sub-parties get 2-digit (C001RT01)
          const seq = String(maxSeq + 1).padStart(isCompanyType ? 3 : 2, '0')
          insertPayload.party_code = `${fullPrefix}${seq}`
        }

        console.log('[PARTIES POST] Final insert payload:', JSON.stringify(insertPayload, null, 2))

        // Check for duplicate party_code before insert — check ALL records including soft-deleted
        if (insertPayload.party_code) {
          const { data: existing } = await supabaseAdmin
            .from('parties')
            .select('id, status')
            .eq('party_code', insertPayload.party_code)
            .maybeSingle()
          if (existing) {
            // If found a soft-deleted record, permanently delete it to free up the code
            if (existing.status === 'DELETED') {
              const { error: deleteError } = await supabaseAdmin
                .from('parties')
                .delete()
                .eq('id', existing.id)
              if (deleteError) {
                console.error('[PARTIES POST] Failed to clean up deleted party:', deleteError)
                return NextResponse.json(
                  { success: false, message: `Party code "${insertPayload.party_code}" is still in use. Please use a different code.` },
                  { status: 409 }
                )
              }
            } else {
              return NextResponse.json(
                { success: false, message: `Party code "${insertPayload.party_code}" already exists. Please use a different code.` },
                { status: 409 }
              )
            }
          }
        }

        let data: Record<string, unknown> | null = null
        let error: { message?: string; code?: string } | null = null
        // Retry loop for auto-generated party_code collisions
        const wasAutoGenerated = !body.party_code
        const maxRetries = 5
        for (let attempt = 0; attempt < maxRetries; attempt++) {
          const insertResult = await supabaseAdmin.from('parties').insert(insertPayload).select().single()
          data = insertResult.data as Record<string, unknown> | null
          error = insertResult.error as { message?: string; code?: string } | null

          // Safety net: if a column error still occurs (unexpected optional field),
          // strip the offending column(s) and retry with only the known-safe core.
          if (error && (error.message?.includes('schema cache') || error.message?.includes('column'))) {
            console.warn('[PARTIES POST] Unexpected column error after probe, stripping to core:', error.message)
            const coreOnly: Record<string, unknown> = {
              name: insertPayload.name,
              party_code: insertPayload.party_code,
              party_type_id: insertPayload.party_type_id,
              status: insertPayload.status ?? 'ACTIVE',
              ...(useNewStyle
                ? { contact_phone: phoneVal, contact_email: emailVal, city: cityVal }
                : { phone: phoneVal, email: emailVal, address: addressVal }),
              ...(hasAddressLine1 ? { address_line1: addressLine1Val } : {}),
              ...(hasVerificationCols ? { is_verified: false, verified_by: null, verified_at: null } : {}),
            }
            if (insertPayload.created_by != null) coreOnly.created_by = insertPayload.created_by
            if (insertPayload.gstin != null) coreOnly.gstin = insertPayload.gstin
            if (insertPayload.contact_person != null) coreOnly.contact_person = insertPayload.contact_person
            if (insertPayload.parent_party_id != null) coreOnly.parent_party_id = insertPayload.parent_party_id
            if (insertPayload.salesman_id != null) coreOnly.salesman_id = insertPayload.salesman_id
            if (insertPayload.territory_id != null) coreOnly.territory_id = insertPayload.territory_id
            // Only carry balance columns in the fallback if the probe confirmed they exist
            if (hasBalanceCols && insertPayload.opening_balance != null) coreOnly.opening_balance = insertPayload.opening_balance
            if (hasBalanceCols && insertPayload.wallet_balance != null) coreOnly.wallet_balance = insertPayload.wallet_balance
            if (hasLatitude && insertPayload.latitude != null) coreOnly.latitude = insertPayload.latitude
            if (hasLongitude && insertPayload.longitude != null) coreOnly.longitude = insertPayload.longitude
            const coreResult = await supabaseAdmin.from('parties').insert(coreOnly).select().single()
            data = coreResult.data as Record<string, unknown> | null
            error = coreResult.error as { message?: string; code?: string } | null
          }

          // If success or non-duplicate error, break out of retry loop
          if (!error || !(error.code === '23505' || error.message?.includes('duplicate key'))) {
            break
          }

          // Duplicate key on auto-generated code — find max seq and increment
          if (wasAutoGenerated && insertPayload.party_type_id) {
            const currentCode = String(insertPayload.party_code || '')
            const prefix = currentCode.replace(/\d+$/, '') || 'PTY'
            // Page through all matches — unranged selects cap at 1000 rows and would
            // otherwise keep regenerating colliding codes for large companies.
            const { data: retryCodes } = await fetchAllRows<{ party_code: string }>(
              (from, to) =>
                supabaseAdmin
                  .from('parties')
                  .select('party_code')
                  .ilike('party_code', `${prefix}%`)
                  .order('party_code', { ascending: true })
                  .range(from, to),
            )
            let maxSeq = 0
            for (const row of (retryCodes || [])) {
              const code = (row as { party_code: string }).party_code || ''
              const num = parseInt(code.replace(prefix, ''), 10)
              if (!isNaN(num) && num > maxSeq) maxSeq = num
            }
            const nextSeq = String(maxSeq + 1 + attempt).padStart(3, '0')
            insertPayload.party_code = `${prefix}${nextSeq}`
            console.log(`[PARTIES POST] Duplicate code, retrying with ${insertPayload.party_code} (attempt ${attempt + 1})`)
            continue
          }

          // User-provided code has duplicate — don't retry
          break
        }

      console.log('[PARTIES POST] Supabase insert result:', { data, error })
      if (error) {
        console.error('[PARTIES POST] Supabase error:', JSON.stringify(error, null, 2))

        // User-friendly error messages for common errors
        let errorMsg = error.message || 'Database insert failed'
        if (error.code === '23505' || errorMsg.includes('duplicate key')) {
          errorMsg = `Party code "${insertPayload.party_code}" already exists. Please use a different code.`
        } else if (error.code === '23503' || errorMsg.includes('foreign key')) {
          errorMsg = 'Invalid reference. Please check your selections and try again.'
        } else if (error.code === '23502' || errorMsg.includes('null value')) {
          const col = errorMsg.match(/column "([^"]+)"/)?.[1]
          errorMsg = col
            ? `Database column "${col}" requires a value but none was provided. Please contact support.`
            : 'A required field is missing. Please fill in all required fields.'
        }

        return NextResponse.json(
          { success: false, message: errorMsg },
          { status: 400 }
        )
      }

      const partyId = (data as Record<string, unknown>)?.id as string

      // Post-insert side effects run concurrently — they're independent and each is
      // non-fatal (the party itself is already created). Previously these were three
      // serialized round-trips to a ~450ms-away DB.
      const sideEffects: Promise<unknown>[] = []

      // opening_balance + GPS both patch the SAME row via direct SQL (bypasses the
      // PostgREST schema cache). Fold them into ONE UPDATE so we make a single
      // round-trip and avoid same-row lock contention from two concurrent updates.
      const openingBalVal = parseFloat(String(body.opening_balance ?? 0)) || 0
      if (partyId) {
        const setClauses: string[] = []
        if (openingBalVal !== 0) {
          setClauses.push(`opening_balance = ${openingBalVal}`, `wallet_balance = COALESCE(wallet_balance, 0)`)
        }
        setClauses.push(`latitude = ${latitudeVal}`, `longitude = ${longitudeVal}`)
        if (setClauses.length > 0) {
          sideEffects.push(
            supabaseAdmin
              .rpc('exec_sql', { sql: `UPDATE public.parties SET ${setClauses.join(', ')} WHERE id = '${partyId}'` })
              .then((r) => {
                if (r.error) console.warn('[PARTIES POST] Direct balance/GPS update skipped:', r.error.message)
              })
          )
        }
      }

      // CRITICAL: If salesman_id is set, also create entry in party_salesman junction
      // table (different table → safe to run alongside the row UPDATE above) so the
      // party appears in the salesman's downline.
      if (!body.group_id && insertPayload.salesman_id && partyId) {
        sideEffects.push(
          supabaseAdmin
            .from('party_salesman')
            .insert({ party_id: partyId, salesman_id: insertPayload.salesman_id })
            .then((r) => {
              // Log but don't fail - party was created successfully
              if (r.error) console.error('Failed to create party_salesman junction:', r.error)
            })
        )
      }

      if (sideEffects.length > 0) await Promise.all(sideEffects)

      // If a group was selected on the create form, fold this party into that group.
      // A party belongs to AT MOST ONE group (UNIQUE on group_members.party_id), so we
      // clear any prior membership first. Non-fatal: the party itself was created OK.
      if (body.group_id && partyId) {
        const groupId = String(body.group_id)
        try {
          await ensureGroupsSchema()
          if (await hasGroupsSchema()) {
            await supabaseAdmin.from('group_members').delete().eq('party_id', partyId)
            const { error: groupMemberError } = await supabaseAdmin
              .from('group_members')
              .insert({ group_id: groupId, party_id: partyId })
            if (groupMemberError) {
              console.error('[PARTIES POST] Failed to add party to group:', groupMemberError)
            }
          } else {
            // Schema-less deployment: groups live in the company_notes fallback store.
            const existing = await getFallbackGroup(groupId, effectiveCompanyId)
            if (existing) {
              const memberIds = Array.from(new Set([...(existing.member_ids || []), partyId]))
              await updateFallbackGroup(groupId, effectiveCompanyId, { member_ids: memberIds })
            }
          }
        } catch (groupErr) {
          console.error('[PARTIES POST] Group assignment error:', groupErr)
        }
      }

      // For parties with portal credentials — provision a real Supabase Auth user
      // so they can log in to their respective portal (admin, cnf, super_dealer, retailer)
      // Supports multi-account: same phone can have accounts in multiple companies
      if (provisionAuthUser && insertPayload.portal_phone && plainPassword && partyId) {
        const authErrors: string[] = []

        // Step 1: Determine the correct role based on party type
        const partyTypeRoleMap: Record<string, string> = {
          COMPANY: 'ADMIN',
          CNF: 'CNF_USER',
          SUPER_DEALER: 'SUPER_DEALER_USER',
          RETAILER: 'RETAILER_USER',
        }
        // Reuse the party type name already fetched during validation.
        const roleName = partyTypeRoleMap[partyTypeName] || 'ADMIN'

        // Steps 1 + 2 are independent reads — run them concurrently instead of paying
        // two serial ~450ms round trips back-to-back on the auth-provisioning path.
        const [roleResult, phoneUsersResult] = await Promise.all([
          supabaseAdmin
            .from('roles')
            .select('id')
            .eq('name', roleName)
            .single(),
          supabaseAdmin
            .from('users')
            .select('id, email, party_id, parties!users_party_id_fkey(id, status)')
            .eq('phone', insertPayload.portal_phone),
        ])
        const roleRow = roleResult.data
        const existingPhoneUsers = phoneUsersResult.data

        if (!roleRow) {
          console.error(`[PARTIES POST] Auth provisioning failed: ${roleName} role not found`)
          authErrors.push(`${roleName} role not found in database`)
        }

        // Step 2b: Clean up orphaned users from deleted companies with the same phone
        // This prevents stale auth users from interfering with new company login
        let cleanedUpOrphan = false
        for (const orphan of (existingPhoneUsers || [])) {
          const orphanParty = Array.isArray(orphan.parties) ? orphan.parties[0] : orphan.parties
          // If the user's party doesn't exist (hard-deleted) or is DELETED/INACTIVE, clean them up
          if (!orphanParty || (orphanParty as Record<string, unknown>).status !== 'ACTIVE') {
            console.log(`[PARTIES POST] Cleaning up orphaned user ${orphan.id} (phone: ${insertPayload.portal_phone}, party: ${orphan.party_id})`)
            try {
              await supabaseAdmin.auth.admin.deleteUser(orphan.id)
            } catch (e) {
              console.warn('[PARTIES POST] Failed to delete orphaned auth user:', e)
            }
            await supabaseAdmin.from('users').delete().eq('id', orphan.id)
            cleanedUpOrphan = true
          }
        }

        // Step 3: Generate unique portal email
        const companySuffix = partyId.substring(0, 8)
        const portalEmail = `${insertPayload.portal_phone}_${companySuffix}@portal.internal`

        // Step 4: Check if user already exists for this company. Only re-query when we
        // actually deleted an orphan above (which would have changed the result set) —
        // on the common path nothing was cleaned up, so reuse the rows already fetched
        // and save a redundant round trip.
        let remainingPhoneUsers: { id: string; email: string | null; party_id: string | null }[] | null
        if (cleanedUpOrphan) {
          const recheck = await supabaseAdmin
            .from('users')
            .select('id, email, party_id')
            .eq('phone', insertPayload.portal_phone)
          remainingPhoneUsers = recheck.data as typeof remainingPhoneUsers
        } else {
          remainingPhoneUsers = (existingPhoneUsers || []).map((u) => ({
            id: u.id as string,
            email: (u.email as string | null) ?? null,
            party_id: (u.party_id as string | null) ?? null,
          }))
        }
        const existingInCompany = (remainingPhoneUsers || []).find(u => u.party_id === partyId)

        if (existingInCompany) {
          // Update existing user's password
          const { error: updateErr } = await supabaseAdmin.auth.admin.updateUserById(existingInCompany.id, { password: plainPassword })
          if (updateErr) {
            console.error('[PARTIES POST] Failed to update auth user password:', updateErr)
            authErrors.push(`Failed to update password: ${updateErr.message}`)
          }
        } else {
          // Create new auth user
          const { data: authCreated, error: authErr } = await supabaseAdmin.auth.admin.createUser({
            email: portalEmail,
            password: plainPassword,
            email_confirm: true,
          })

          if (authErr) {
            console.error('[PARTIES POST] Failed to create auth user:', authErr)
            authErrors.push(`Auth user creation failed: ${authErr.message}`)
          } else if (authCreated?.user) {
            // Step 5: Create users table record
            const adminName = (body.contact_person as string)?.trim() || body.name || 'Portal User'
            const adminRecord = {
              id: authCreated.user.id,
              name: adminName,
              email: authCreated.user.email,
              phone: insertPayload.portal_phone,
              role_id: roleRow?.id || null,
              party_id: partyId,
              status: 'ACTIVE',
            }

            // Try 'app_users' first (the active table in most deployments), fall back to 'users'
            let { error: usersErr } = await supabaseAdmin.from('app_users').insert(adminRecord)

            if (usersErr) {
              console.log('[PARTIES POST] app_users insert failed, retrying with users table:', usersErr.message)
              const retry = await supabaseAdmin.from('users').insert(adminRecord)
              usersErr = retry.error
            }

            if (usersErr) {
              console.error('[PARTIES POST] Failed to insert admin user record into both tables:', usersErr)
              authErrors.push(`Admin record creation failed: ${usersErr.message}`)
            }
          }
        }

        // If auth provisioning failed, surface the error to the caller
        if (authErrors.length > 0) {
          console.error('[PARTIES POST] Auth provisioning failed:', authErrors)
          return NextResponse.json({
            success: false,
            message: `Company created but admin account provisioning failed: ${authErrors.join('; ')}. Please use the re-provision endpoint or contact support.`,
            data,
            authErrors,
          }, { status: 207 })
        }
      }

      return NextResponse.json({ success: true, data }, { status: 201 })
  } catch (err: unknown) {
    console.error('[PARTIES POST] Unexpected error:', err)
    const errorMessage = err instanceof Error ? err.message : 'Failed to create party'
    return NextResponse.json(
      { success: false, message: errorMessage },
      { status: 500 }
    )
  }
}
