import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { NextRequest } from 'next/server'
import { fetchAllRows } from '@/lib/supabase-in-chunks'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''

// Lazy-init so module import never crashes
let _admin: SupabaseClient | null = null
function getAdmin(): SupabaseClient {
  if (!_admin) {
    if (!supabaseUrl || !supabaseServiceKey) {
      throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
    }
    _admin = createClient(supabaseUrl, supabaseServiceKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    })
  }
  return _admin
}

export const supabaseAdmin = new Proxy({} as SupabaseClient, {
  get(_target, prop) {
    const client = getAdmin() as unknown as Record<string | symbol, unknown>
    const val = client[prop]
    if (typeof val === 'function') return val.bind(client)
    return val
  },
})

let _public: SupabaseClient | null = null
export function getSupabasePublic(): SupabaseClient {
  if (!_public) {
    if (!supabaseUrl || !supabaseServiceKey) {
      throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
    }
    _public = createClient(supabaseUrl, supabaseServiceKey, { db: { schema: 'public' } })
  }
  return _public
}

export const supabasePublic = new Proxy({} as SupabaseClient, {
  get(_target, prop) {
    const client = getSupabasePublic() as unknown as Record<string | symbol, unknown>
    const val = client[prop]
    if (typeof val === 'function') return val.bind(client)
    return val
  },
})

// Supabase's auth.admin.listUsers() caps `perPage` at 1000 and returns only ONE
// page per call. Callers that did `listUsers({ perPage: 1000 })` silently lost
// every auth user beyond the first 1000 — which on a multi-company instance
// dropped recently-created DRIVER accounts out of the dropdown entirely. This
// helper walks every page so the full auth user set is returned.
type AuthAdminUser = Awaited<
  ReturnType<SupabaseClient['auth']['admin']['listUsers']>
>['data']['users'][number]

export async function listAllAuthUsers(): Promise<AuthAdminUser[]> {
  const PER_PAGE = 1000
  const MAX_PAGES = 100 // safety bound (≤100k users) so a bad cursor can't loop forever
  const all: AuthAdminUser[] = []
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: PER_PAGE })
    if (error) throw error
    const users = data?.users || []
    all.push(...users)
    if (users.length < PER_PAGE) break
  }
  return all
}

// Per-request cache: avoids duplicate HTTP round-trips within a single request.
const requestUserCache = new WeakMap<NextRequest, AuthUser>()

// Short-lived token → user cache. Every API route resolves the caller from the
// bearer token, which used to cost 2-3 sequential network round-trips to
// Supabase (auth.getUser + app_users lookup) on EVERY request. Polling screens
// (15-30s intervals) multiplied that across users into a constant auth load.
// Caching the resolved user for a short TTL collapses that to one resolution
// per token per window; role/party changes propagate within TOKEN_USER_TTL_MS.
const TOKEN_USER_TTL_MS = Number(process.env.AUTH_CACHE_TTL_MS || 60_000)
const tokenUserCache = new Map<string, { user: AuthUser; expires: number }>()

export function clearAuthUserCacheForUser(userId: string) {
  for (const [token, cached] of tokenUserCache) {
    if (cached.user.id === userId || cached.user.app_user_id === userId) {
      tokenUserCache.delete(token)
    }
  }
}

// Module-level cache for the party subtree (tree rarely changes)
const PARTY_CACHE_TTL_MS = Number(process.env.PARTY_TREE_CACHE_TTL_MS || 60_000)
const partyDescendantsCache = new Map<string, { data: { id: string }[]; expires: number }>()

// Shared cache of EVERY active party's (id, parent) edge — the only network cost
// inside getPartyDescendants. The subtree for any root is then computed in-memory.
// Because the row set is identical regardless of root, every distinct root (and the
// several callers that resolve a tree within a single request — orders, payments,
// wallets, party-scope) reuses one fetch instead of repaging the whole `parties`
// table each time. `activePartyRowsInflight` is a single-flight guard so a burst of
// concurrent requests on a cold cache collapses to ONE fetch rather than N parallel
// full-table scans (the multi-user "everything gets slow" amplifier).
export type PartyEdge = { id: string; parent_party_id: string | null; party_code: string | null }
let activePartyRowsCache: { rows: PartyEdge[]; expires: number } | null = null
let activePartyRowsInflight: Promise<PartyEdge[] | null> | null = null

// Exported so route handlers that need the full active-party edge list (e.g. the
// company-scope builder in /parties) reuse this one cached/single-flighted scan
// instead of re-paging the whole `parties` table themselves. `party_code` is carried
// alongside the parent edge so prefix-based company scoping needs no extra query.
export async function loadActivePartyRows(): Promise<PartyEdge[] | null> {
  if (activePartyRowsCache && activePartyRowsCache.expires > Date.now()) {
    return activePartyRowsCache.rows
  }
  if (activePartyRowsInflight) return activePartyRowsInflight

  activePartyRowsInflight = (async () => {
    try {
      const { data: rows, error } = await fetchAllRows<PartyEdge>(
        (from, to) => supabaseAdmin
          .from('parties')
          .select('id, parent_party_id, party_code')
          .eq('status', 'ACTIVE')
          .order('id')
          .range(from, to),
      )
      if (error || !rows) return null
      activePartyRowsCache = { rows, expires: Date.now() + PARTY_CACHE_TTL_MS }
      return rows
    } finally {
      activePartyRowsInflight = null
    }
  })()

  return activePartyRowsInflight
}

/**
 * Returns the company/party subtree rooted at `rootId` — the root itself plus every
 * descendant — as `{ id }[]`. The underlying party edge-list is fetched once and shared
 * across all roots/callers (see loadActivePartyRows); the per-root BFS result is then
 * memoised for PARTY_CACHE_TTL_MS.
 *
 * Historically this called the `get_party_descendants` RPC, but that RPC is hard-capped
 * at PostgREST's max-rows (1000) and cannot be paged (Range is ignored on the function),
 * so once a company exceeds ~1000 parties it silently truncates the tree and drops whole
 * branches — e.g. super dealers sitting under a CNF vanish from every scoped view
 * (downline, groups, salesman parties, allowed-party-id filters). We instead build the
 * subtree from `parent_party_id`: a complete, cycle-safe BFS over every active party,
 * paged via fetchAllRows so nothing is capped. The root id is included to match the
 * RPC's original contract.
 */
export async function getPartyDescendants(rootId: string): Promise<{ id: string }[]> {
  const cached = partyDescendantsCache.get(rootId)
  if (cached && cached.expires > Date.now()) return cached.data

  // Never throw: callers historically used `supabaseAdmin.rpc(...)` which returns
  // { data, error } and silently degraded to an empty/best-effort scope on failure.
  // Routing those call sites here must keep that contract — a transient network
  // error must not turn a scoped list into a 500. On any unexpected failure we
  // return the root alone, matching the old `treeIds=[] -> push(root)` fallback.
  try {
    const rows = await loadActivePartyRows()

    if (!rows) {
      // Last-resort fallback to the (truncated) RPC so callers still get a best-effort set.
      const { data } = await supabaseAdmin.rpc('get_party_descendants', { root_id: rootId })
      const fallback = (data as { id: string }[] | null) ?? [{ id: rootId }]
      partyDescendantsCache.set(rootId, { data: fallback, expires: Date.now() + PARTY_CACHE_TTL_MS })
      return fallback
    }

    const childrenByParent = new Map<string, string[]>()
    for (const row of rows) {
      if (!row.parent_party_id) continue
      const list = childrenByParent.get(row.parent_party_id) || []
      list.push(row.id)
      childrenByParent.set(row.parent_party_id, list)
    }

    // BFS from rootId. The visited set keeps it cycle-safe; the root id is included.
    const result: { id: string }[] = [{ id: rootId }]
    const visited = new Set<string>([rootId])
    const queue: string[] = [rootId]
    while (queue.length > 0) {
      const parentId = queue.shift() as string
      for (const childId of childrenByParent.get(parentId) || []) {
        if (visited.has(childId)) continue
        visited.add(childId)
        result.push({ id: childId })
        queue.push(childId)
      }
    }

    partyDescendantsCache.set(rootId, { data: result, expires: Date.now() + PARTY_CACHE_TTL_MS })
    return result
  } catch (e) {
    console.warn('[getPartyDescendants] failed, returning root-only scope', e)
    return [{ id: rootId }]
  }
}

export interface AuthUser {
  id: string
  app_user_id: string | null
  name: string | null
  email: string | null
  role: string
  role_id: string | null
  party_id: string | null
}

interface PublicAppUserProfile {
  id: string
  name: string | null
  email: string | null
  role_id: string | null
  role_name: string | null
  party_id: string | null
  status: string | null
}

/**
 * Direct REST fetch from public.users — bypasses supabase-js schema routing.
 */
async function fetchAppUserByUrl(url: string): Promise<PublicAppUserProfile | null> {
  const res = await fetch(url, {
    headers: {
      apikey: supabaseServiceKey,
      Authorization: `Bearer ${supabaseServiceKey}`,
      Accept: 'application/json',
    },
    cache: 'no-store',
  })
  if (!res.ok) return null
  const rows = await res.json()
  if (!Array.isArray(rows) || rows.length === 0) return null
  const row = rows[0]
  const roles = row.roles
  let role_name: string | null = null
  if (Array.isArray(roles) && roles[0]?.name) role_name = roles[0].name
  else if (roles && typeof roles === 'object' && roles.name) role_name = roles.name
  return {
    id: row.id,
    name: row.name ?? null,
    email: row.email ?? null,
    role_id: row.role_id ?? null,
    role_name,
    party_id: row.party_id ?? null,
    status: row.status ?? null,
  }
}

async function fetchAppUser(userId: string): Promise<PublicAppUserProfile | null> {
  for (const table of ['app_users', 'users'] as const) {
    const byId = await fetchAppUserByUrl(
      `${supabaseUrl}/rest/v1/${table}?id=eq.${userId}&select=id,name,email,role_id,party_id,status,roles(name)&limit=1`
    )
    if (byId) return byId
  }

  const authRes = await fetch(`${supabaseUrl}/auth/v1/admin/users/${userId}`, {
    headers: {
      apikey: supabaseServiceKey,
      Authorization: `Bearer ${supabaseServiceKey}`,
    },
    cache: 'no-store',
  })
  if (!authRes.ok) return null
  const authUser = await authRes.json()
  const email: string | null = authUser?.email ?? null
  if (!email) return null

  for (const table of ['app_users', 'users'] as const) {
    const byEmail = await fetchAppUserByUrl(
      `${supabaseUrl}/rest/v1/${table}?email=eq.${encodeURIComponent(email)}&select=id,name,email,role_id,party_id,status,roles(name)&limit=1`
    )
    if (byEmail) return byEmail
  }

  return null
}

function normalizeRoleName(roleName: string | null | undefined): string {
  return (roleName || 'SALESMAN')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

export async function resolveUserDisplayMap(userIds: string[]): Promise<Record<string, { id: string; name: string }>> {
  const uniqueIds = [...new Set(userIds.filter(Boolean))]
  if (uniqueIds.length === 0) return {}

  const map: Record<string, { id: string; name: string }> = {}

  const { data: directUsers } = await supabaseAdmin
    .from('users')
    .select('id, name, email')
    .in('id', uniqueIds)

  for (const user of directUsers || []) {
    map[user.id] = { id: user.id, name: user.name || user.email || 'Unknown user' }
  }

  const unresolvedIds = uniqueIds.filter(id => !map[id])
  if (unresolvedIds.length === 0) return map

  const authUsers = await Promise.all(
    unresolvedIds.map(async (authUserId) => {
      const res = await fetch(`${supabaseUrl}/auth/v1/admin/users/${authUserId}`, {
        headers: {
          apikey: supabaseServiceKey,
          Authorization: `Bearer ${supabaseServiceKey}`,
        },
        cache: 'no-store',
      })

      if (!res.ok) return null

      const authUser = await res.json()
      return {
        authUserId,
        email: authUser?.email ?? null,
      }
    })
  )

  const emailToAuthIds: Record<string, string[]> = {}
  for (const authUser of authUsers) {
    if (!authUser?.email) continue
    if (!emailToAuthIds[authUser.email]) emailToAuthIds[authUser.email] = []
    emailToAuthIds[authUser.email].push(authUser.authUserId)
  }

  const emails = Object.keys(emailToAuthIds)
  if (emails.length > 0) {
    const { data: emailUsers } = await supabaseAdmin
      .from('users')
      .select('id, name, email')
      .in('email', emails)

    for (const user of emailUsers || []) {
      if (!user.email) continue
      for (const authUserId of emailToAuthIds[user.email] || []) {
        map[authUserId] = { id: user.id, name: user.name || user.email || 'Unknown user' }
      }
    }
  }

  for (const authUser of authUsers) {
    if (!authUser || map[authUser.authUserId]) continue
    const fallbackName = authUser.email ? authUser.email.split('@')[0] : 'Unknown user'
    map[authUser.authUserId] = { id: authUser.authUserId, name: fallbackName }
  }

  return map
}

export async function getUserFromToken(req: NextRequest): Promise<AuthUser | null> {
  const cachedForReq = requestUserCache.get(req)
  if (cachedForReq) return cachedForReq

  const auth = req.headers.get('authorization') || ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null
  if (!token) return null

  const cachedForToken = tokenUserCache.get(token)
  if (cachedForToken && cachedForToken.expires > Date.now()) {
    requestUserCache.set(req, cachedForToken.user)
    return cachedForToken.user
  }

  const { data: { user }, error } = await supabaseAdmin.auth.getUser(token)
  if (error || !user) return null

  const profile = await fetchAppUser(user.id)
  if (profile && (profile.status || 'ACTIVE') !== 'ACTIVE') return null
  const fallbackName = user.email?.split('@')[0] || 'User'

  const metadataRole = user.user_metadata?.display_role || user.user_metadata?.role
  const roleName = normalizeRoleName(metadataRole || profile?.role_name)

  const resolved: AuthUser = {
    id: user.id,
    app_user_id: profile?.id ?? null,
    name: profile?.name || fallbackName,
    email: profile?.email || user.email || null,
    role: roleName,
    role_id: profile?.role_id ?? null,
    party_id: profile?.party_id ?? null,
  }

  requestUserCache.set(req, resolved)
  tokenUserCache.set(token, { user: resolved, expires: Date.now() + TOKEN_USER_TTL_MS })

  // Bound memory: sweep expired entries when the map grows large.
  if (tokenUserCache.size > 5000) {
    const now = Date.now()
    for (const [key, value] of tokenUserCache) {
      if (value.expires <= now) tokenUserCache.delete(key)
    }
  }

  return resolved
}

export function getCompanyScope(req: NextRequest): string | null {
  return req.headers.get('x-company-id') || null
}

export async function resolveCompanyScope(req: NextRequest, authUser?: AuthUser | null): Promise<string | null> {
  const headerCompanyId = req.headers.get('x-company-id') || null

  if (!authUser) return headerCompanyId
  if (authUser.role === 'SUPER_ADMIN') return headerCompanyId

  // For non-super-admin roles, never trust arbitrary x-company-id from clients.
  // Scope strictly to the party attached to the authenticated account.
  return authUser.party_id || null
}

export async function checkUserPermission(
  userId: string,
  roleId: string | null,
  module: string,
  companyId: string | null
): Promise<{ hasPermission: boolean; scope: 'ALL' | 'PARTY' | 'TERRITORY' }> {
  const { data: userRow } = await supabasePublic
    .from('users')
    .select('id, role_id, party_id, roles(name)')
    .eq('id', userId)
    .single()

  if (!userRow) return { hasPermission: false, scope: 'PARTY' }

  const roleName = Array.isArray(userRow.roles) && userRow.roles[0]?.name
    ? userRow.roles[0].name
    : typeof userRow.roles === 'object' && userRow.roles !== null && 'name' in userRow.roles
    ? (userRow.roles as { name: string }).name
    : null

  if (roleName === 'SUPER_ADMIN') {
    return { hasPermission: true, scope: 'ALL' }
  }

  let permQuery = supabaseAdmin
    .from('permissions')
    .select('can_view, scope')
    .eq('role_id', roleId || userRow.role_id || '')
    .eq('module', module)

  if (companyId) {
    permQuery = permQuery.eq('company_id', companyId)
  } else {
    permQuery = permQuery.is('company_id', null)
  }

  const { data: perm } = await permQuery.single()

  if (!perm || !perm.can_view) {
    return { hasPermission: false, scope: 'PARTY' }
  }

  return {
    hasPermission: true,
    scope: (perm.scope as 'ALL' | 'PARTY' | 'TERRITORY') || 'PARTY'
  }
}

export async function getAllowedPartyIds(
  userId: string,
  roleName: string,
  userPartyId: string | null,
  companyId: string | null,
  module: string
): Promise<string[] | null> {
  if (roleName === 'SUPER_ADMIN') return null

  if (roleName === 'ADMIN') {
    if (userPartyId) {
      const tree = await getPartyDescendants(userPartyId)
      return tree.map((r) => r.id)
    }
    return null
  }

  // For all non-admin roles, look up their role_id and permission scope for this module
  const { data: userRow } = await supabaseAdmin
    .from('users')
    .select('role_id, assigned_party_id')
    .eq('id', userId)
    .maybeSingle()

  const roleId = userRow?.role_id
  const rootId = userRow?.assigned_party_id || userPartyId

  if (!rootId) {
    // No party linked — return empty list (user sees nothing)
    return []
  }

  let permQuery = supabaseAdmin
    .from('permissions')
    .select('scope')
    .eq('role_id', roleId || '')
    .eq('module', module)

  if (companyId) {
    permQuery = permQuery.eq('company_id', companyId)
  } else {
    permQuery = permQuery.is('company_id', null)
  }

  const { data: perm } = await permQuery.maybeSingle()
  // 'all' → see the entire company tree (full admin-like access for this module)
  // 'downline' or anything else → see only own party + descendants
  const scope = perm?.scope || 'downline'

  if (scope === 'all' || scope === 'ALL') {
    return null // no filter = full company access
  }

  // 'downline': return own party + all descendants
  const tree = await getPartyDescendants(rootId)
  const ids = tree.map((r) => r.id)
  if (!ids.includes(rootId)) ids.unshift(rootId)
  return ids
}
