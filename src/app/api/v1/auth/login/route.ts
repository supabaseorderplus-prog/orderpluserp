import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-server'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!

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
  'DRIVER': ['DRIVER', 'SALESMAN'],
}

async function fetchPublicUserProfile(userId: string, emailFallback?: string) {
  const headers = {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    'Content-Profile': 'public',
    'Accept-Profile': 'public',
    Accept: 'application/json',
  }

  // Fetch user — try app_users first, then users table (dual-table support)
  const byIdUrl = `${SUPABASE_URL}/rest/v1/app_users?id=eq.${userId}&select=id,name,email,phone,role_id,party_id,status&limit=1`
  console.log('[fetchPublicUserProfile] Fetching user:', byIdUrl)
  
  let userRes = await fetch(byIdUrl, { headers, cache: 'no-store' })
  if (!userRes.ok) {
    console.log('[fetchPublicUserProfile] User fetch failed:', userRes.status)
    return null
  }
  
  let users = await userRes.json()
  
  // If not found in app_users, try users table
  if (!Array.isArray(users) || users.length === 0) {
    const byIdUrlFallback = `${SUPABASE_URL}/rest/v1/users?id=eq.${userId}&select=id,name,email,phone,role_id,party_id,status&limit=1`
    console.log('[fetchPublicUserProfile] Not found in app_users, trying users table:', byIdUrlFallback)
    const fallbackRes = await fetch(byIdUrlFallback, { headers, cache: 'no-store' })
    if (fallbackRes.ok) {
      const fallbackUsers = await fallbackRes.json()
      if (Array.isArray(fallbackUsers) && fallbackUsers.length > 0) {
        users = fallbackUsers
      }
    }
  }
  console.log('[fetchPublicUserProfile] Users response:', JSON.stringify(users, null, 2))
  
  if (!Array.isArray(users) || users.length === 0) {
    console.log('[fetchPublicUserProfile] No users found')
    return null
  }
  
  const user = users[0]
  
  // Fetch role separately
  let roleData = null
  if (user.role_id) {
    const roleUrl = `${SUPABASE_URL}/rest/v1/roles?id=eq.${user.role_id}&select=id,name&limit=1`
    const roleRes = await fetch(roleUrl, { headers, cache: 'no-store' })
    if (roleRes.ok) {
      const roles = await roleRes.json()
      if (Array.isArray(roles) && roles.length > 0) {
        roleData = roles[0]
      }
    }
  }
  
  // Fetch party separately
  let partyData = null
  if (user.party_id) {
    const partyUrl = `${SUPABASE_URL}/rest/v1/parties?id=eq.${user.party_id}&select=id,name,party_code&limit=1`
    const partyRes = await fetch(partyUrl, { headers, cache: 'no-store' })
    if (partyRes.ok) {
      const parties = await partyRes.json()
      if (Array.isArray(parties) && parties.length > 0) {
        partyData = parties[0]
      }
    }
  }
  
  return {
    ...user,
    roles: roleData,
    parties: partyData
  }
}

type PhoneLookupRow = {
  id: string
  name: string
  email: string
  phone: string | null
  party_id: string | null
  status: string | null
  roles: { id: string; name: string } | { id: string; name: string }[] | null
  parties: { id: string; name: string; party_code: string } | { id: string; name: string; party_code: string }[] | null
}

function normalizeRoleName(roleName?: string | null) {
  return (roleName || '').trim().toUpperCase()
}

function extractRoleName(row: PhoneLookupRow) {
  return Array.isArray(row.roles) ? row.roles[0]?.name || '' : row.roles?.name || ''
}

function normalizePhone(phone?: string | null) {
  return String(phone || '').replace(/[^0-9]/g, '')
}

// Return a human display name — skip values that are purely numeric (phone stored as name)
// and skip portal-email prefixes like "9876543210_abcd1234"
function resolveDisplayName(name: string | null | undefined, email: string | null | undefined): string {
  if (name) {
    const stripped = name.replace(/[\s\-().+]/g, '')
    if (!/^\d{7,}$/.test(stripped)) return name
  }
  const emailPrefix = email?.split('@')[0] || ''
  if (emailPrefix && !/^\d+_[a-f0-9]{6,}$/.test(emailPrefix) && !/^\d{7,}$/.test(emailPrefix)) {
    return emailPrefix
  }
  return 'User'
}

function buildPortalEmailCandidates(params: {
  email?: string | null
  phone?: string | null
  partyId?: string | null
}) {
  const candidates = new Set<string>()
  const trimmedEmail = String(params.email || '').trim()
  const normalizedPhone = normalizePhone(params.phone)
  const partyId = String(params.partyId || '').trim()

  if (trimmedEmail) candidates.add(trimmedEmail)
  if (normalizedPhone && partyId) {
    candidates.add(`${normalizedPhone}_${partyId.substring(0, 8)}@portal.internal`)
  }
  if (normalizedPhone) {
    candidates.add(`${normalizedPhone}@portal.internal`)
  }

  return Array.from(candidates)
}

async function trySignInWithCandidates(password: string, candidates: string[]) {
  // De-dupe case-insensitively while preserving order
  const seen = new Set<string>()
  const uniqueCandidates = candidates.filter((c) => {
    const key = (c || '').toLowerCase()
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })

  for (const attemptEmail of uniqueCandidates) {
    const { data, error } = await supabaseAdmin.auth.signInWithPassword({
      email: attemptEmail,
      password,
    })
    if (data?.user) {
      return { data, email: attemptEmail }
    }
    if (error) {
      console.log('[LOGIN] Candidate failed:', { email: attemptEmail, error: error.message })
    }
  }
  return null
}

// The portal-email candidates are *reconstructed* from phone + party id, which only
// works when the auth user was created with that exact synthetic email. Older / manually
// created accounts can have a real email (e.g. sale@hometech.com) or a UUID-based portal
// email that no reconstruction will ever match, even though the app_users row id always
// equals the auth user id. Resolving the real auth email by id guarantees we authenticate
// against the correct auth user after an admin password reset.
async function getAuthEmailById(userId: string): Promise<string | null> {
  try {
    const { data, error } = await supabaseAdmin.auth.admin.getUserById(userId)
    if (error || !data?.user) return null
    return data.user.email ?? null
  } catch {
    return null
  }
}

function roleMatchesPortal(roleName: string, portalRole: string): boolean {
  const normalizedRole = roleName.toUpperCase()
  const normalizedPortal = portalRole.toUpperCase().replace(/-/g, '_')
  const allowedRoles = ROLE_PORTAL_MAP[normalizedPortal] || [normalizedPortal]
  return allowedRoles.includes(normalizedRole)
}

function isActiveAccount(row: { status?: string | null } | null | undefined) {
  return String(row?.status || 'ACTIVE').toUpperCase() === 'ACTIVE'
}

function inactiveLoginResponse() {
  return NextResponse.json(
    { success: false, message: 'This user account is inactive. Please contact your administrator.' },
    { status: 403 },
  )
}

// Party type → role mapping
const PARTY_TYPE_ROLE_MAP: Record<string, string> = {
  COMPANY: 'ADMIN',
  CNF: 'CNF_USER',
  SUPER_DEALER: 'SUPER_DEALER_USER',
  RETAILER: 'RETAILER_USER',
  MANUFACTURER: 'ADMIN',
}

/**
 * Auto-provisions a Supabase Auth user for a party that was registered
 * without auth provisioning (no app_users/users record exists).
 * This allows parties created without a password to be retroactively provisioned.
 */
async function autoProvisionPartyUser(partyId: string, password: string, portalRole?: string): Promise<{
  accessToken: string
  refreshToken: string
  user: {
    id: string
    name: string
    email: string
    phone: string
    role: string
    role_id: string | null
    party_id: string | null
    party_name: string | null
    party_code: string | null
  }
} | null> {
  // Fetch the party — use select=* to avoid column-existence errors across schema variants
  // (some DBs have 'phone', others 'contact_phone', others 'portal_phone')
  const partyUrl = `${SUPABASE_URL}/rest/v1/parties?id=eq.${partyId}&select=*&limit=1`
  const partyRes = await fetch(partyUrl, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, Accept: 'application/json' },
    cache: 'no-store',
  })
  if (!partyRes.ok) return null
  const partyRows = await partyRes.json()
  if (!Array.isArray(partyRows) || partyRows.length === 0) return null

  const party = partyRows[0] as {
    id: string
    name: string
    party_code: string
    party_type_id: string
    status: string
    contact_person: string | null
    portal_phone?: string | null
    contact_phone?: string | null
    phone?: string | null
  }
  if (party.status !== 'ACTIVE') return null

  // Look up party type name
  const typeUrl = `${SUPABASE_URL}/rest/v1/party_types?id=eq.${party.party_type_id}&select=id,name&limit=1`
  const typeRes = await fetch(typeUrl, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, Accept: 'application/json' },
    cache: 'no-store',
  })
  let typeName = ''
  if (typeRes.ok) {
    const typeRows = await typeRes.json()
    if (Array.isArray(typeRows) && typeRows.length > 0) {
      typeName = typeRows[0].name
    }
  }

  const roleName = PARTY_TYPE_ROLE_MAP[typeName] || 'SALESMAN'

  // Look up the role ID
  const roleUrl = `${SUPABASE_URL}/rest/v1/roles?select=id,name&name=eq.${roleName}&limit=1`
  const roleRes = await fetch(roleUrl, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, Accept: 'application/json' },
    cache: 'no-store',
  })
  let roleId: string | null = null
  if (roleRes.ok) {
    const roleRows = await roleRes.json()
    if (Array.isArray(roleRows) && roleRows.length > 0) {
      roleId = roleRows[0].id
    }
  }

  const matchedPhone = normalizePhone(party.portal_phone || party.contact_phone || party.phone || '')
  if (!matchedPhone) {
    console.log('[AUTO_PROVISION] Party has no phone number:', partyId)
    return null
  }

  // Build the portal email
  const portalEmail = `${matchedPhone}_${partyId.substring(0, 8)}@portal.internal`
  const userName = (party.contact_person || party.name || 'Portal User').trim()

  // Create the Supabase Auth user (idempotent: if already exists, sign in directly)
  const { data: authCreated, error: authErr } = await supabaseAdmin.auth.admin.createUser({
    email: portalEmail,
    password,
    email_confirm: true,
  })

  if (authErr || !authCreated?.user) {
    // If the user already exists from a prior provisioning attempt, just sign in
    if (authErr?.message?.toLowerCase().includes('already') || authErr?.message?.toLowerCase().includes('registered') || authErr?.status === 422) {
      console.log('[AUTO_PROVISION] User already exists, attempting direct sign-in:', portalEmail)
      const { data: existingSignIn, error: existingSignInErr } = await supabaseAdmin.auth.signInWithPassword({
        email: portalEmail,
        password,
      })
      if (existingSignIn?.user && existingSignIn.session) {
        return {
          accessToken: existingSignIn.session.access_token,
          refreshToken: existingSignIn.session.refresh_token,
          user: {
            id: existingSignIn.user.id,
            name: userName,
            email: portalEmail,
            phone: matchedPhone,
            role: roleName,
            role_id: roleId,
            party_id: partyId,
            party_name: party.name,
            party_code: party.party_code,
          },
        }
      }
      console.error('[AUTO_PROVISION] Existing user sign-in also failed:', existingSignInErr?.message)
    } else {
      console.error('[AUTO_PROVISION] Auth user creation failed:', authErr?.message)
    }
    return null
  }

  // Insert record into app_users (with fallback to users)
  const adminRecord = {
    id: authCreated.user.id,
    name: userName,
    email: portalEmail,
    phone: matchedPhone,
    role_id: roleId,
    party_id: partyId,
    status: 'ACTIVE',
  }

  let usersErr: { message?: string } | null = null
  const { error: appErr } = await supabaseAdmin.from('app_users').insert(adminRecord)
  if (appErr) {
    console.log('[AUTO_PROVISION] app_users insert failed, retrying with users table:', appErr.message)
    const { error: retryErr } = await supabaseAdmin.from('users').insert(adminRecord)
    usersErr = retryErr
  }

  if (usersErr) {
    console.error('[AUTO_PROVISION] Failed to insert user record:', usersErr.message)
    // Rollback auth user
    await supabaseAdmin.auth.admin.deleteUser(authCreated.user.id)
    return null
  }

  console.log('[AUTO_PROVISION] Successfully provisioned user for party:', partyId)

  // Sign in with the newly created credentials
  const { data: authData, error: signInErr } = await supabaseAdmin.auth.signInWithPassword({
    email: portalEmail,
    password,
  })

  if (signInErr || !authData?.user || !authData.session) {
    console.error('[AUTO_PROVISION] Sign in failed after provisioning:', signInErr?.message)
    // We created the user, so return their data even if sign-in fails
    return {
      accessToken: '',
      refreshToken: '',
      user: {
        id: authCreated.user.id,
        name: userName,
        email: portalEmail,
        phone: matchedPhone,
        role: roleName,
        role_id: roleId,
        party_id: partyId,
        party_name: party.name,
        party_code: party.party_code,
      },
    }
  }

  return {
    accessToken: authData.session.access_token,
    refreshToken: authData.session.refresh_token,
    user: {
      id: authData.user.id,
      name: userName,
      email: portalEmail,
      phone: matchedPhone,
      role: roleName,
      role_id: roleId,
      party_id: partyId,
      party_name: party.name,
      party_code: party.party_code,
    },
  }
}

export async function POST(req: NextRequest) {
  try {
    const { email, phone, password, role, partyId, userId } = await req.json()
    console.log('[LOGIN] Request:', { email, phone, role, partyId, userId })

    if ((!email && !phone) || !password) {
      return NextResponse.json({ success: false, message: 'Mobile number and password required' }, { status: 400 })
    }

    let loginEmail = email

    // If userId is explicitly provided (user selected a specific account from picker),
    // skip the phone lookup and directly get the auth email for that user
    if (userId) {
      console.log('[LOGIN] Using userId mode:', userId)
      // First, get the users row to find the email
      try {
        // Try app_users first, then users table (dual-table support)
        let appUserRes = await fetch(`${SUPABASE_URL}/rest/v1/app_users?id=eq.${userId}&select=id,name,email,phone,party_id,status,roles(id,name)&limit=1`, {
          headers: {
            apikey: SERVICE_KEY,
            Authorization: `Bearer ${SERVICE_KEY}`,
            'Accept-Profile': 'public',
            Accept: 'application/json',
          },
          cache: 'no-store',
        })
        
        let appUserData: unknown[] | null = null
        if (appUserRes.ok) {
          appUserData = await appUserRes.json()
        }
        
        // If not found in app_users, try users table
        if (!appUserData || !Array.isArray(appUserData) || appUserData.length === 0) {
          console.log('[LOGIN] userId not found in app_users, trying users table')
          const fallbackRes = await fetch(`${SUPABASE_URL}/rest/v1/users?id=eq.${userId}&select=id,name,email,phone,party_id,status,roles(id,name)&limit=1`, {
            headers: {
              apikey: SERVICE_KEY,
              Authorization: `Bearer ${SERVICE_KEY}`,
              'Accept-Profile': 'public',
              Accept: 'application/json',
            },
            cache: 'no-store',
          })
          if (fallbackRes.ok) {
            appUserData = await fallbackRes.json()
          }
        }
        
        if (appUserData && Array.isArray(appUserData) && appUserData.length > 0) {
          console.log('[LOGIN] Found users for userId:', appUserData)
          const appUser = appUserData[0] as { id: string; name: string; email: string | null; phone: string | null; party_id: string | null; status?: string | null }
          if (!isActiveAccount(appUser)) return inactiveLoginResponse()
          // app_users.id === auth.users.id, so the real auth email is the most reliable
          // sign-in identity. Put it first; fall back to reconstructed portal-email candidates.
          const realAuthEmail = await getAuthEmailById(appUser.id)
          const loginCandidates = [
            ...(realAuthEmail ? [realAuthEmail] : []),
            ...buildPortalEmailCandidates({
              email: appUser.email,
              phone: appUser.phone,
              partyId: appUser.party_id,
            }),
          ]
            // Keep first candidate for legacy direct-auth fallback path
            loginEmail = loginCandidates[0]
            console.log('[LOGIN] Built login candidates for userId mode:', loginCandidates)

            const signedIn = await trySignInWithCandidates(password, loginCandidates)
            if (signedIn) {
              const authData = signedIn.data
              const profile = await fetchPublicUserProfile(authData.user.id, authData.user.email)
              if (!isActiveAccount(profile)) return inactiveLoginResponse()

              let roleName = 'SALESMAN'
              if (profile?.roles) {
                if (Array.isArray(profile.roles)) {
                  roleName = profile.roles[0]?.name || 'SALESMAN'
                } else if (typeof profile.roles === 'object' && profile.roles.name) {
                  roleName = profile.roles.name
                }
              }
              const displayRole = authData.user.user_metadata?.display_role
              if (displayRole) roleName = displayRole

              const partyName = profile?.parties
                ? (Array.isArray(profile.parties) ? profile.parties[0]?.name : profile.parties?.name) || null
                : null
              const partyCode = profile?.parties
                ? (Array.isArray(profile.parties) ? profile.parties[0]?.party_code : profile.parties?.party_code) || null
                : null

              return NextResponse.json({
                success: true,
                data: {
                  accessToken: authData.session?.access_token || '',
                  refreshToken: authData.session?.refresh_token || '',
                  user: {
                    id: authData.user.id,
                    name: resolveDisplayName(profile?.name, authData.user.email),
                    email: profile?.email || authData.user.email || email,
                    phone: profile?.phone || '',
                    role: roleName,
                    role_id: profile?.role_id || null,
                    territoryId: profile?.territory_id || null,
                    party_id: profile?.party_id || null,
                    party_name: partyName,
                    party_code: partyCode,
                  },
                },
              })
            }
          if (loginEmail) {
            // successfully found a candidate email, continue to direct auth fallback below
          }
        }
        
        if (!loginEmail) {
          // Auto-provision: userId might be a party ID from the parties fallback
          console.log('[LOGIN] No auth user found for userId, checking parties table for auto-provision:', userId)
          try {
            const provisionResult = await autoProvisionPartyUser(userId, password, role)
            if (provisionResult) {
              return NextResponse.json({
                success: true,
                data: provisionResult,
              })
            }
          } catch (e) {
            console.error('[LOGIN] Auto-provision failed:', e)
          }
          console.log('[LOGIN] No email found for userId:', userId)
          return NextResponse.json({ success: false, message: 'Could not find account email for selected user' }, { status: 401 })
        }
      } catch (err) {
        console.error('[LOGIN] Error fetching user by userId:', err)
        return NextResponse.json({ success: false, message: 'Could not find account for selected user' }, { status: 401 })
      }
    } else if (phone && !email) {
      // Phone lookup - no userId provided, need to find account by phone
      const normalizedPhone = normalizePhone(phone)

      // Query app_users with FK joins (canonical table)
      async function queryLoginAppUsers(): Promise<PhoneLookupRow[] | null> {
        const url = `${SUPABASE_URL}/rest/v1/app_users?select=id,name,email,phone,party_id,status,roles(id,name),parties!users_party_id_fkey(id,name,party_code,status)`
        const res = await fetch(url, {
          headers: {
            apikey: SERVICE_KEY,
            Authorization: `Bearer ${SERVICE_KEY}`,
            'Content-Profile': 'public',
            'Accept-Profile': 'public',
            Accept: 'application/json',
          },
          cache: 'no-store',
        })
        if (!res.ok) return null
        return await res.json() as PhoneLookupRow[]
      }

      // Fallback: query users table without FK joins (may lack FK constraints),
      // then resolve party info separately
      async function queryLoginUsersFallback(): Promise<PhoneLookupRow[] | null> {
        const fallbackHeaders = {
          apikey: SERVICE_KEY,
          Authorization: `Bearer ${SERVICE_KEY}`,
          'Content-Profile': 'public',
          'Accept-Profile': 'public',
          Accept: 'application/json',
        }
        const url = `${SUPABASE_URL}/rest/v1/users?select=id,name,email,phone,party_id,role_id,status`
        const res = await fetch(url, { headers: fallbackHeaders, cache: 'no-store' })
        if (!res.ok) return null
        const rawRows: Array<{
          id: string
          name: string
          email: string | null
          phone: string | null
          party_id: string | null
          role_id: string | null
          status: string | null
        }> = await res.json()
        if (rawRows.length === 0) return []

        // Batch-fetch roles and parties
        const roleIds = [...new Set(rawRows.map(r => r.role_id).filter(Boolean))] as string[]
        const partyIds = [...new Set(rawRows.map(r => r.party_id).filter(Boolean))] as string[]
        const [roleRows, partyRows] = await Promise.all([
          roleIds.length > 0
            ? fetch(`${SUPABASE_URL}/rest/v1/roles?select=id,name&id=in.(${roleIds.map(id => encodeURIComponent(id)).join(',')})`, { headers: fallbackHeaders }).then(r => r.ok ? r.json() : [])
            : Promise.resolve([]),
          partyIds.length > 0
            ? fetch(`${SUPABASE_URL}/rest/v1/parties?select=id,name,party_code,status&id=in.(${partyIds.map(id => encodeURIComponent(id)).join(',')})`, { headers: fallbackHeaders }).then(r => r.ok ? r.json() : [])
            : Promise.resolve([]),
        ])
        const roleMap: Record<string, { id: string; name: string }> = {}
        for (const r of (roleRows as Array<{ id: string; name: string }>)) roleMap[r.id] = r
        const partyMap: Record<string, { id: string; name: string; party_code: string; status?: string }> = {}
        for (const p of (partyRows as Array<{ id: string; name: string; party_code: string; status?: string }>)) partyMap[p.id] = p

        return rawRows.map(r => ({
          id: r.id,
          name: r.name,
          email: r.email,
          phone: r.phone,
          party_id: r.party_id,
          status: r.status,
          roles: r.role_id ? roleMap[r.role_id] || null : null,
          parties: r.party_id ? partyMap[r.party_id] || null : null,
        })) as PhoneLookupRow[]
      }

      let allRows = await queryLoginAppUsers()
      if (allRows === null) {
        return NextResponse.json({ success: false, message: 'Failed to look up account by mobile number' }, { status: 500 })
      }
      if (allRows.length === 0) {
        console.log('[LOGIN] No results in app_users, trying users table')
        allRows = await queryLoginUsersFallback() ?? []
      }
      const rows = allRows.filter((row) => {
        const rowPhone = normalizePhone(row.phone)
        const phoneMatch = rowPhone === normalizedPhone || rowPhone.endsWith(normalizedPhone) || normalizedPhone.endsWith(rowPhone)
        if (!phoneMatch) return false
        if (!isActiveAccount(row)) return false
        // Exclude orphaned users (party hard-deleted) or users from deleted/inactive companies
        const party = Array.isArray(row.parties) ? row.parties[0] : row.parties
        if (!party) return false
        if ((party as Record<string, unknown>).status !== 'ACTIVE') return false
        return true
      })

      if (rows.length === 0) {
        return NextResponse.json({ success: false, message: 'No account found with this mobile number' }, { status: 401 })
      }

      // Fetch display_role overrides
      const displayRoleMap: Record<string, string> = {}
      try {
        const authRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?per_page=1000`, {
          headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
        })
        if (authRes.ok) {
          const authData = await authRes.json()
          const userIds = rows.map(r => r.id)
          for (const au of authData.users || []) {
            if (userIds.includes(au.id) && au.user_metadata?.display_role) {
              displayRoleMap[au.id] = au.user_metadata.display_role
            }
          }
        }
      } catch { /* non-fatal */ }

      const enrichedRows = rows.map(r => ({
        ...r,
        effectiveRole: displayRoleMap[r.id] || extractRoleName(r),
      }))

      // Resolve by role
      const normalizedRole = normalizeRoleName(role)
      let matchingRows = normalizedRole
        ? enrichedRows.filter((row) => roleMatchesPortal(row.effectiveRole, normalizedRole))
        : enrichedRows

      if (partyId && matchingRows.length > 1) {
        const narrowed = matchingRows.filter((row) => row.party_id === partyId)
        if (narrowed.length > 0) matchingRows = narrowed
      }

      if (!Array.isArray(matchingRows) || matchingRows.length === 0 || !matchingRows[0]?.email) {
        const allRoles = [...new Set(enrichedRows.map(r => r.effectiveRole))]
        return NextResponse.json({
          success: false,
          message: `No account found with this mobile number for the ${role || 'selected'} portal`,
          hint: enrichedRows.length > 0
            ? `Found ${enrichedRows.length} account(s) with this phone for portal(s): ${allRoles.join(', ')}`
            : undefined,
          accounts: enrichedRows.map((row) => {
            const party = Array.isArray(row.parties) ? row.parties[0] : row.parties
            return {
              userId: row.id,
              name: row.name,
              email: row.email,
              role: normalizeRoleName(row.effectiveRole),
              party_id: row.party_id,
              companyName: party?.name || 'No Company',
            }
          }),
        }, { status: 300 })
      }

      // Try password against each matching account
      for (const matchingRow of matchingRows) {
        // app_users.id === auth.users.id, so resolve the real auth email first — it covers
        // accounts whose stored email can't be reconstructed from phone/party.
        const realAuthEmail = await getAuthEmailById(matchingRow.id)
        const loginCandidates = [
          ...(realAuthEmail ? [realAuthEmail] : []),
          ...buildPortalEmailCandidates({
            email: matchingRow.email,
            phone: matchingRow.phone,
            partyId: matchingRow.party_id,
          }),
        ]

        const signedIn = await trySignInWithCandidates(password, loginCandidates)
        const authData = signedIn?.data

        if (authData?.user) {
          loginEmail = signedIn!.email

          const profile = await fetchPublicUserProfile(authData.user.id, authData.user.email)
          if (!isActiveAccount(profile)) return inactiveLoginResponse()
          let roleName = 'SALESMAN'
          if (profile?.roles) {
            if (Array.isArray(profile.roles)) {
              roleName = profile.roles[0]?.name || 'SALESMAN'
            } else if (typeof profile.roles === 'object' && profile.roles.name) {
              roleName = profile.roles.name
            }
          }
          const displayRole = authData.user.user_metadata?.display_role
          if (displayRole) roleName = displayRole
          if (role && !roleMatchesPortal(roleName, role)) {
            continue
          }
          const partyName = profile?.parties
            ? (Array.isArray(profile.parties) ? profile.parties[0]?.name : profile.parties?.name) || null
            : null
          const partyCode = profile?.parties
            ? (Array.isArray(profile.parties) ? profile.parties[0]?.party_code : profile.parties?.party_code) || null
            : null
          return NextResponse.json({
            success: true,
            data: {
              accessToken: authData.session?.access_token || '',
              refreshToken: authData.session?.refresh_token || '',
              user: {
                id: authData.user.id,
                name: profile?.name || authData.user.email?.split('@')[0] || 'User',
                email: profile?.email || authData.user.email || email,
                phone: profile?.phone || '',
                role: roleName,
                role_id: profile?.role_id || null,
                territoryId: profile?.territory_id || null,
                party_id: profile?.party_id || null,
                party_name: partyName,
                party_code: partyCode,
              },
            },
          })
        }
      }
      return NextResponse.json({ success: false, message: 'Invalid credentials. Please check your password.' }, { status: 401 })
    }

    // Direct auth with email or reconstructed email
    console.log('[LOGIN] Direct auth with email:', loginEmail)
    const { data: authData, error: authError } = await supabaseAdmin.auth.signInWithPassword({
      email: loginEmail,
      password,
    })

    console.log('[LOGIN] Auth result:', { success: !!authData?.user, error: authError?.message })
        if (authError || !authData.user) {
          console.error('[LOGIN] Direct auth failed:', { email: loginEmail, error: authError?.message })
          return NextResponse.json({ 
            success: false, 
            message: `Invalid credentials. Please check your password. (Auth error: ${authError?.message || 'No user returned'})` 
          }, { status: 401 })
        }

    const profile = await fetchPublicUserProfile(authData.user.id, authData.user.email)
    if (!isActiveAccount(profile)) return inactiveLoginResponse()
    console.log('[LOGIN] Profile:', JSON.stringify(profile, null, 2))

    let roleName = 'SALESMAN'
    if (profile?.roles) {
      console.log('[LOGIN] Roles type:', typeof profile.roles, Array.isArray(profile.roles))
      if (Array.isArray(profile.roles)) {
        roleName = profile.roles[0]?.name || 'SALESMAN'
      } else if (typeof profile.roles === 'object' && profile.roles.name) {
        roleName = profile.roles.name
      }
    }
    console.log('[LOGIN] Role name:', roleName)

    const displayRole = authData.user.user_metadata?.display_role
    if (displayRole) roleName = displayRole

    // When userId was explicitly selected, skip role verification
    if (role && !userId && !roleMatchesPortal(roleName, role)) {
      return NextResponse.json({
        success: false,
        message: `This account (${roleName}) does not belong to the ${role} portal`,
        actualRole: roleName,
      }, { status: 401 })
    }

    const partyName = profile?.parties
      ? (Array.isArray(profile.parties) ? profile.parties[0]?.name : profile.parties?.name) || null
      : null
    const partyCode = profile?.parties
      ? (Array.isArray(profile.parties) ? profile.parties[0]?.party_code : profile.parties?.party_code) || null
      : null

    return NextResponse.json({
      success: true,
      data: {
        accessToken: authData.session?.access_token || '',
        refreshToken: authData.session?.refresh_token || '',
        user: {
          id: authData.user.id,
          name: profile?.name || authData.user.email?.split('@')[0] || 'User',
          email: profile?.email || authData.user.email || email,
          phone: profile?.phone || '',
          role: roleName,
          role_id: profile?.role_id || null,
          territoryId: profile?.territory_id || null,
          party_id: profile?.party_id || null,
          party_name: partyName,
          party_code: partyCode,
        },
      },
    })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Login failed' },
      { status: 500 }
    )
  }
}
