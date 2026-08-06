import { NextRequest, NextResponse } from 'next/server'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!

const headers = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  'Accept-Profile': 'public',
  Accept: 'application/json',
}

// Role to portal mapping for filtering - allows multiple role names to map to same portal
const ROLE_PORTAL_MAP: Record<string, string[]> = {
  'SUPER_ADMIN': ['SUPER_ADMIN'],
  'ADMIN': ['ADMIN'],
  'SALES_MANAGER': ['SALES_MANAGER'],
  'TERRITORY_MANAGER': ['TERRITORY_MANAGER'],
  'SALESMAN': ['SALESMAN'],
  'CNF_USER': ['CNF_USER', 'CNF'],
  'CNF': ['CNF_USER', 'CNF'],
  'SUPER_DEALER_USER': ['SUPER_DEALER_USER', 'SUPER_DEALER'],
  'SUPER_DEALER': ['SUPER_DEALER_USER', 'SUPER_DEALER'],
  'RETAILER_USER': ['RETAILER_USER', 'RETAILER'],
  'RETAILER': ['RETAILER_USER', 'RETAILER'],
  'WAREHOUSE_MANAGER': ['WAREHOUSE_MANAGER'],
  'ACCOUNTS_MANAGER': ['ACCOUNTS_MANAGER'],
  'AUDITOR': ['AUDITOR'],
  'DRIVER': ['DRIVER', 'SALESMAN'], // DRIVER uses SALESMAN role in DB but display_role override
}

// Portal groups: which roles belong to each login window.
// Party window is the catch-all for every customer/vendor role, so it is defined
// as "anything that is NOT staff, admin, or super admin" — this way brand-new party
// types (dealers, distributors, wholesalers, etc.) work without touching this list.
const STAFF_ROLES = ['SALESMAN', 'DRIVER', 'SALES_MANAGER', 'TERRITORY_MANAGER', 'WAREHOUSE_MANAGER', 'ACCOUNTS_MANAGER', 'AUDITOR']
const ADMIN_ROLES = ['ADMIN']
const SUPER_ADMIN_ROLES = ['SUPER_ADMIN']

function roleInGroup(roleName: string, groupName: string): boolean {
  const r = (roleName || '').toUpperCase()
  const g = (groupName || '').toUpperCase()
  if (g === 'STAFF') return STAFF_ROLES.includes(r)
  if (g === 'ADMIN') return ADMIN_ROLES.includes(r)
  if (g === 'PARTY') {
    return !STAFF_ROLES.includes(r) && !ADMIN_ROLES.includes(r) && !SUPER_ADMIN_ROLES.includes(r)
  }
  return true // unknown group → no filtering
}

/**
 * Resolves the parent COMPANY (root ancestor) for each party by walking up the
 * parent_party_id chain. Returns a map of partyId -> { id, name } of its root company.
 * Parties are stored as a tree whose top node (parent_party_id = null) is the COMPANY;
 * a retailer/dealer/CNF's OWN name differs from the company it is registered under,
 * so the login picker needs both.
 */
async function resolveRootCompanies(
  partyIds: string[]
): Promise<Record<string, { id: string; name: string }>> {
  const result: Record<string, { id: string; name: string }> = {}
  if (partyIds.length === 0) return result

  // id -> { name, parent } cache, filled level-by-level to bound round-trips
  const cache = new Map<string, { name: string; parent: string | null }>()

  async function fetchParties(ids: string[]): Promise<void> {
    const missing = [...new Set(ids)].filter((id) => !cache.has(id))
    if (missing.length === 0) return
    const url = `${SUPABASE_URL}/rest/v1/parties?select=id,name,parent_party_id&id=in.(${missing.map((id) => encodeURIComponent(id)).join(',')})`
    const res = await fetch(url, { headers })
    if (!res.ok) return
    const rows: Array<{ id: string; name: string; parent_party_id: string | null }> = await res.json()
    for (const r of rows) cache.set(r.id, { name: r.name, parent: r.parent_party_id })
  }

  let frontier = [...new Set(partyIds)]
  await fetchParties(frontier)
  for (let level = 0; level < 6; level++) {
    const parents = frontier
      .map((id) => cache.get(id)?.parent)
      .filter((p): p is string => Boolean(p))
    if (parents.length === 0) break
    await fetchParties(parents)
    frontier = [...new Set(parents)]
  }

  for (const pid of partyIds) {
    let cur = pid
    for (let i = 0; i < 8; i++) {
      const node = cache.get(cur)
      if (!node || !node.parent) break
      cur = node.parent
    }
    const rootNode = cache.get(cur)
    if (rootNode) result[pid] = { id: cur, name: rootNode.name }
  }
  return result
}

/**
 * GET /api/v1/auth/companies?phone=XXX&role=SALESMAN
 * Returns ALL accounts (across all roles and companies) for a phone number.
 * Used to show an account picker when the same phone is linked to multiple accounts
 * (same or different roles, same or different companies).
 *
 * Supports multi-account scenario where one phone number can be registered
 * with multiple companies or have multiple roles.
 */
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url)
    const phone = searchParams.get('phone')
    const role = searchParams.get('role') // optional — portal role to filter by
    const group = searchParams.get('group') // optional — portal group: PARTY | STAFF | ADMIN

    if (!phone) {
      return NextResponse.json({ success: false, message: 'phone is required' }, { status: 400 })
    }

    // Normalize phone for lookup (remove non-digits)
    const normalizedPhone = phone.replace(/[^0-9]/g, '')
    const lookupPhone: string = phone

    type UserRow = {
      id: string
      name: string
      email: string | null
      phone: string | null
      party_id: string | null
      roles: { id: string; name: string } | { id: string; name: string }[] | null
      parties: { id: string; name: string; party_code: string; party_type_id?: string; status?: string } | { id: string; name: string; party_code: string; party_type_id?: string; status?: string }[] | null
    }

    // Query app_users with full FK joins (canonical table)
    async function queryAppUsers(): Promise<UserRow[] | null> {
      const url = `${SUPABASE_URL}/rest/v1/app_users?or=(phone.eq.${encodeURIComponent(lookupPhone)},phone.ilike.*${normalizedPhone}*)&select=id,name,email,phone,party_id,roles(id,name),parties!users_party_id_fkey(id,name,party_code,party_type_id,status)&order=created_at.asc`
      const res = await fetch(url, { headers })
      if (!res.ok) return null
      return await res.json() as UserRow[]
    }

    // Fallback: query users table without FK joins (users may lack FK constraints),
    // then resolve party/role info separately
    async function queryUsersFallback(): Promise<UserRow[] | null> {
      const url = `${SUPABASE_URL}/rest/v1/users?or=(phone.eq.${encodeURIComponent(lookupPhone)},phone.ilike.*${normalizedPhone}*)&select=id,name,email,phone,party_id,role_id&order=created_at.asc`
      const res = await fetch(url, { headers })
      if (!res.ok) return null
      const rawRows: Array<{
        id: string
        name: string
        email: string | null
        phone: string | null
        party_id: string | null
        role_id: string | null
      }> = await res.json()
      if (rawRows.length === 0) return []

      // Batch-fetch roles and parties to attach to the results
      const roleIds = [...new Set(rawRows.map(r => r.role_id).filter(Boolean))] as string[]
      const partyIds = [...new Set(rawRows.map(r => r.party_id).filter(Boolean))] as string[]
      const [roleRows, partyRows] = await Promise.all([
        roleIds.length > 0
          ? fetch(`${SUPABASE_URL}/rest/v1/roles?select=id,name&id=in.(${roleIds.map(id => encodeURIComponent(id)).join(',')})`, { headers }).then(r => r.ok ? r.json() : [])
          : Promise.resolve([]),
        partyIds.length > 0
          ? fetch(`${SUPABASE_URL}/rest/v1/parties?select=id,name,party_code,party_type_id,status&id=in.(${partyIds.map(id => encodeURIComponent(id)).join(',')})`, { headers }).then(r => r.ok ? r.json() : [])
          : Promise.resolve([]),
      ])
      const roleMap: Record<string, { id: string; name: string }> = {}
      for (const r of (roleRows as Array<{ id: string; name: string }>)) roleMap[r.id] = r
      const partyMap: Record<string, UserRow['parties']> = {}
      for (const p of (partyRows as Array<{ id: string; name: string; party_code: string; party_type_id?: string; status?: string }>)) partyMap[p.id] = p

      return rawRows.map(r => ({
        id: r.id,
        name: r.name,
        email: r.email,
        phone: r.phone,
        party_id: r.party_id,
        roles: r.role_id ? roleMap[r.role_id] || null : null,
        parties: r.party_id ? partyMap[r.party_id] || null : null,
      })) as UserRow[]
    }

    // Party type → role mapping (mirrors the one in parties/route.ts)
    const PARTY_TYPE_ROLE_MAP: Record<string, string> = {
      COMPANY: 'ADMIN',
      CNF: 'CNF_USER',
      SUPER_DEALER: 'SUPER_DEALER_USER',
      RETAILER: 'RETAILER_USER',
      MANUFACTURER: 'ADMIN',
    }

    // Last resort: check parties table directly for parties that were registered
    // without auth provisioning (no app_users/users record exists).
    // Returns synthetic "needs provisioning" accounts.
    async function queryPartiesFallback(): Promise<UserRow[] | null> {
      // Probe which phone columns actually exist in this DB (schema varies across deployments)
      const [phoneProbe, contactPhoneProbe, portalPhoneProbe] = await Promise.all([
        fetch(`${SUPABASE_URL}/rest/v1/parties?select=phone&limit=0`, { headers }),
        fetch(`${SUPABASE_URL}/rest/v1/parties?select=contact_phone&limit=0`, { headers }),
        fetch(`${SUPABASE_URL}/rest/v1/parties?select=portal_phone&limit=0`, { headers }),
      ])
      const existingPhoneCols: string[] = []
      if (phoneProbe.ok) existingPhoneCols.push('phone')
      if (contactPhoneProbe.ok) existingPhoneCols.push('contact_phone')
      if (portalPhoneProbe.ok) existingPhoneCols.push('portal_phone')

      if (existingPhoneCols.length === 0) return null

      const orClauses = existingPhoneCols.map(col => `${col}.ilike.*${normalizedPhone}*`).join(',')
      const phoneSelectCols = existingPhoneCols.join(',')
      const url = `${SUPABASE_URL}/rest/v1/parties?or=(${orClauses})&select=id,name,party_code,party_type_id,status,contact_person,${phoneSelectCols}&status=eq.ACTIVE&limit=20`
      const res = await fetch(url, { headers })
      if (!res.ok) return null
      const partyRows: Array<{
        id: string
        name: string
        party_code: string
        party_type_id: string
        status: string
        contact_person: string | null
        portal_phone?: string | null
        contact_phone?: string | null
        phone?: string | null
      }> = await res.json()
      if (partyRows.length === 0) return []

      // Filter by phone match (same flexible logic as above)
      const matched = partyRows.filter(p => {
        const pPhone = normalizePortalPhone(p.portal_phone || p.contact_phone || p.phone || '')
        if (!pPhone) return false
        return pPhone === normalizedPhone ||
               pPhone.endsWith(normalizedPhone) ||
               normalizedPhone.endsWith(pPhone) ||
               pPhone === '91' + normalizedPhone ||
               pPhone === '+91' + normalizedPhone ||
               ('91' + pPhone) === normalizedPhone
      })
      if (matched.length === 0) return []

      // Pre-fetch all party type names to resolve roles
      const typeIds = [...new Set(matched.map(p => p.party_type_id).filter(Boolean))]
      const typeNameMap: Record<string, string> = {}
      if (typeIds.length > 0) {
        const typeRes = await fetch(`${SUPABASE_URL}/rest/v1/party_types?select=id,name&id=in.(${typeIds.map(id => encodeURIComponent(id)).join(',')})`, { headers })
        if (typeRes.ok) {
          const types: Array<{ id: string; name: string }> = await typeRes.json()
          for (const t of types) typeNameMap[t.id] = t.name
        }
      }

      return matched.map(p => {
        const typeName = typeNameMap[p.party_type_id] || ''
        const roleName = PARTY_TYPE_ROLE_MAP[typeName] || 'SALESMAN'
        const matchedPhone = normalizePortalPhone(p.portal_phone || p.contact_phone || p.phone || '')
        // Fetch or build role info for this party
        return {
          id: p.id,
          name: p.contact_person || p.name,
          email: null,
          phone: matchedPhone,
          party_id: p.id,
          roles: [{ id: '', name: roleName }],
          parties: [{
            id: p.id,
            name: p.name,
            party_code: p.party_code,
            party_type_id: p.party_type_id,
            status: p.status,
          }],
        } as UserRow
      })
    }

    function normalizePortalPhone(phoneVal: string) {
      return phoneVal.replace(/[^0-9]/g, '')
    }

    // Fetch from app_users first (with FK joins)
    let rows = await queryAppUsers()
    // Fall back to users table if app_users query failed or returned no results
    if (!rows || rows.length === 0) {
      console.log('[auth/companies] No results in app_users, trying users table')
      rows = await queryUsersFallback()
      if (!rows) {
        rows = []
      }
    }

    // Last resort: check parties table for un-provisioned parties (party exists but no auth user was created)
    if (rows.length === 0) {
      console.log('[auth/companies] No auth user found, checking parties table directly')
      rows = await queryPartiesFallback()
      if (!rows) rows = []
    }

    console.log('[auth/companies] Phone lookup:', { 
      inputPhone: phone, 
      normalizedPhone,
      rowsFound: rows.length,
      rows: rows.map(r => ({ id: r.id.substring(0,8), phone: r.phone, party_id: r.party_id?.substring(0,8) }))
    })

    // Filter rows to match the exact normalized phone (handle country code variations)
    // Also check if phone might be stored with +91 or 91 prefix
    let matchingRows = rows.filter((row) => {
      if (!row.phone) return false
      const rowPhone = (row.phone || '').replace(/[^0-9]/g, '')
      // Match if phones are identical, or one ends with the other (handles +91 prefix)
      // Also handle case where user enters 10-digit without country code
      return rowPhone === normalizedPhone || 
             rowPhone.endsWith(normalizedPhone) || 
             normalizedPhone.endsWith(rowPhone) ||
             rowPhone === '91' + normalizedPhone ||
             rowPhone === '+91' + normalizedPhone ||
             ('91' + rowPhone) === normalizedPhone
    })

    // Filter out users linked to deleted/missing companies
    matchingRows = matchingRows.filter((row) => {
      const party = Array.isArray(row.parties) ? row.parties[0] : row.parties
      // Exclude users whose party was hard-deleted (orphaned users)
      // or soft-deleted — they should NOT appear in login
      if (!party) return false
      return party.status === 'ACTIVE'
    })

    if (matchingRows.length === 0) {
      return NextResponse.json({ success: false, message: 'No account found with this mobile number' })
    }

    // Fetch auth users to check for display_role overrides (e.g., DRIVER role stored as SALESMAN)
    const displayRoleMap: Record<string, string> = {}
    try {
      const userIds = matchingRows.map(r => r.id)
      const authRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?per_page=1000`, {
        headers: {
          apikey: SERVICE_KEY,
          Authorization: `Bearer ${SERVICE_KEY}`,
        },
      })
      if (authRes.ok) {
        const authData = await authRes.json()
        for (const au of authData.users || []) {
          if (userIds.includes(au.id) && au.user_metadata?.display_role) {
            displayRoleMap[au.id] = au.user_metadata.display_role
          }
        }
      }
    } catch { /* non-fatal - continue without display_role info */ }

    // Build account list with full details
    const accounts = matchingRows.map((r) => {
      const party = Array.isArray(r.parties) ? r.parties[0] : r.parties
      const roleData = Array.isArray(r.roles) ? r.roles[0] : r.roles
      const roleName = displayRoleMap[r.id] || roleData?.name || 'SALESMAN'
      return {
        userId: r.id,
        name: r.name,
        email: r.email,
        phone: r.phone,
        role: roleName.toUpperCase(),
        roleId: roleData?.id || null,
        partyId: party?.id ?? r.party_id ?? null,
        companyName: party?.name ?? 'No Company Assigned',
        companyCode: party?.party_code ?? null,
        partyTypeId: party?.party_type_id ?? null,
      }
    })

    // Filter by role/portal if specified
    let filtered = accounts
    if (role) {
      const normalizedRole = role.toUpperCase().replace(/-/g, '_')
      const allowedRoles = ROLE_PORTAL_MAP[normalizedRole] || [normalizedRole]
      filtered = accounts.filter(a => allowedRoles.includes(a.role))
    }

    // Filter by portal group (PARTY / STAFF / ADMIN) if specified
    if (group) {
      filtered = filtered.filter(a => roleInGroup(a.role, group))
    }

    if (filtered.length === 0) {
      // Provide helpful error message showing what roles ARE available for this phone
      const availableRoles = [...new Set(accounts.map(a => a.role))]
      const portalLabel = group === 'PARTY' ? 'Party / Vendor'
        : group === 'STAFF' ? 'Team'
        : group === 'ADMIN' ? 'Admin'
        : role || 'selected'
      return NextResponse.json({
        success: false,
        message: `No account found with this mobile number for the ${portalLabel} portal`,
        hint: accounts.length > 0
          ? `Found ${accounts.length} account(s) with this phone for portal(s): ${availableRoles.join(', ')}`
          : undefined,
        availableRoles,
        allAccounts: accounts,
        debug: {
          searchedPhone: phone,
          normalizedPhone,
          rowsFound: rows.length,
          matchingRows: matchingRows.length,
          deletedFiltered: accounts.length,
          requestedRole: role,
          allowedRoles: role ? (ROLE_PORTAL_MAP[role.toUpperCase().replace(/-/g, '_')] || [role]) : [],
        }
      })
    }

    // Resolve the parent company for each account so the picker shows BOTH the
    // party's own name (partyName) and the company it belongs to (companyName).
    const partyIdsToResolve = [...new Set(
      filtered.map((a) => a.partyId).filter((id): id is string => Boolean(id))
    )]
    const rootCompanyMap = await resolveRootCompanies(partyIdsToResolve)

    const enriched = filtered.map((a) => {
      const ownName = a.companyName // party's own name from the parties join
      const root = a.partyId ? rootCompanyMap[a.partyId] : null
      return {
        ...a,
        partyName: ownName,
        companyName: root?.name || ownName,
        companyId: root?.id || a.partyId || null,
      }
    })

    // Group accounts by the resolved parent company for easier UI display
    const byCompany: Record<string, typeof enriched> = {}
    for (const acc of enriched) {
      const key = acc.companyId || acc.partyId || 'no-company'
      if (!byCompany[key]) byCompany[key] = []
      byCompany[key].push(acc)
    }

    return NextResponse.json({
      success: true,
      data: {
        accounts: enriched,
        multiple: enriched.length > 1,
        byCompany,
        totalCompanies: Object.keys(byCompany).length,
      }
    })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed to fetch companies' },
      { status: 500 }
    )
  }
}