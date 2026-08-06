import { NextRequest, NextResponse } from 'next/server'
import { randomUUID } from 'crypto'
import { supabaseAdmin, supabasePublic, getUserFromToken, resolveCompanyScope, getPartyDescendants, listAllAuthUsers } from '@/lib/supabase-server'
import { fetchAllInChunks } from '@/lib/supabase-in-chunks'

const isMissingUsersTable = (err: { code?: string; message?: string } | null | undefined) =>
  !!err && (
    err.code === 'PGRST205' ||
    err.code === '42P01' ||
    (err.message || '').includes("Could not find the table 'public.users'")
  )

type DbError = {
  code?: string
  message?: string
  details?: string
  hint?: string
} | null | undefined

type UserListRow = {
  id: string
  name: string
  email: string | null
  phone: string | null
  status: string
  created_at: string
  role_id?: string | null
  party_id?: string | null
  parent_user_id?: string | null
  roles?: { name?: string } | { name?: string }[] | null
  employee_code?: string | null
  photo_url?: string | null
}

const USER_SELECT = 'id, name, email, phone, status, created_at, role_id'

function getUnknownMessage(err: unknown, fallback: string) {
  if (err instanceof Error) return err.message
  if (typeof err === 'object' && err !== null && 'message' in err) {
    const value = (err as { message?: unknown }).message
    if (typeof value === 'string') return value
  }
  return fallback
}

function isDuplicateError(err: DbError) {
  const msg = `${err?.message || ''} ${err?.details || ''}`
  return err?.code === '23505' || msg.includes('duplicate key')
}

function isPhoneDuplicateError(err: DbError) {
  const msg = `${err?.message || ''} ${err?.details || ''}`.toLowerCase()
  return isDuplicateError(err) && msg.includes('phone')
}

function isEmployeeCodeDuplicateError(err: DbError) {
  const msg = `${err?.message || ''} ${err?.details || ''}`.toLowerCase()
  return isDuplicateError(err) && msg.includes('employee')
}

function employeeCodePrefix(companyName: string) {
  return `${companyName.substring(0, 2).toUpperCase()}EMP`
}

async function getNextEmployeeCode(tableName: 'users' | 'app_users', partyId: string) {
  const { data: partyRow } = await supabaseAdmin
    .from('parties')
    .select('name')
    .eq('id', partyId)
    .single()

  if (!partyRow?.name) return null

  const prefix = employeeCodePrefix(partyRow.name)
  const { data: codeRows, error: codeErr } = await supabasePublic
    .from(tableName)
    .select('employee_code')
    .ilike('employee_code', `${prefix}%`)

  if (codeErr) {
    if (isMissingUsersTable(codeErr)) throw codeErr
    return `${prefix}001`
  }

  let maxSeq = 0
  for (const row of ((codeRows || []) as unknown as { employee_code?: string | null }[])) {
    const code = String(row.employee_code || '').toUpperCase()
    if (!code.startsWith(prefix)) continue
    const seq = Number.parseInt(code.slice(prefix.length), 10)
    if (Number.isFinite(seq) && seq > maxSeq) maxSeq = seq
  }

  return `${prefix}${String(maxSeq + 1).padStart(3, '0')}`
}

async function dropLegacyPhoneUniqueConstraint() {
  const { error } = await supabaseAdmin.rpc('exec_sql', {
    sql: `
      ALTER TABLE IF EXISTS public.users DROP CONSTRAINT IF EXISTS users_phone_key;
      ALTER TABLE IF EXISTS public.users DROP CONSTRAINT IF EXISTS users_phone_unique;
      ALTER TABLE IF EXISTS public.app_users DROP CONSTRAINT IF EXISTS app_users_phone_key;
      ALTER TABLE IF EXISTS public.app_users DROP CONSTRAINT IF EXISTS app_users_phone_unique;
      DROP INDEX IF EXISTS public.users_phone_key;
      DROP INDEX IF EXISTS public.users_phone_idx;
      DROP INDEX IF EXISTS public.idx_users_phone;
      DROP INDEX IF EXISTS public.app_users_phone_key;
      DROP INDEX IF EXISTS public.app_users_phone_idx;
      DROP INDEX IF EXISTS public.idx_app_users_phone;
      DO $$
      BEGIN
        IF to_regclass('public.users') IS NOT NULL THEN
          CREATE INDEX IF NOT EXISTS idx_users_phone_lookup ON public.users(phone);
        END IF;
        IF to_regclass('public.app_users') IS NOT NULL THEN
          CREATE INDEX IF NOT EXISTS idx_app_users_phone_lookup ON public.app_users(phone);
        END IF;
      END $$;
      NOTIFY pgrst, 'reload schema';
    `,
  })

  if (error) {
    console.warn('[USERS POST] Could not drop legacy phone uniqueness constraint:', error)
    return false
  }
  return true
}

export async function POST(req: NextRequest) {
  let stage = 'init'
  try {
    stage = 'parse-body'
    const body = await req.json()
      const { name, email, phone, role_id, status, password, parent_user_id, party_id, aadhaar_number, photo_url } = body

    const isDriverRole = role_id === '__DRIVER__'

    if (!name || !role_id) {
        return NextResponse.json({ success: false, message: 'Name and role are required' }, { status: 400 })
      }

    // CRITICAL: Get authenticated user and resolve company scope for data isolation
    stage = 'resolve-scope'
    const authUser = await getUserFromToken(req)
    const companyId = await resolveCompanyScope(req, authUser)

    // Verify the party belongs to the user's company if party_id is provided
    if (companyId && party_id) {
      const tree = await getPartyDescendants(companyId)
      const treeIds = tree && tree.length > 0 ? tree.map((r: { id: string }) => r.id) : []
      if (!treeIds.includes(companyId)) {
        treeIds.push(companyId)
      }
      
      if (!treeIds.includes(party_id)) {
        return NextResponse.json({ success: false, message: 'Party not found or access denied' }, { status: 403 })
      }
    }

      // Check if creating SUPER_ADMIN - email is required only for Super Admin
      stage = 'resolve-role'
      const { data: roleRow } = await supabaseAdmin.from('roles').select('name').eq('id', role_id).single()
      const isSuperAdmin = roleRow?.name === 'SUPER_ADMIN'

      if (isSuperAdmin && !email) {
        return NextResponse.json({ success: false, message: 'Email is required for Super Admin' }, { status: 400 })
      }

      // For non-Super Admin users, generate a unique placeholder email using phone + random UUID
      // This ensures no conflicts even if same phone is used for different accounts
      let userEmail = email
      if (!userEmail) {
        // Always generate a unique email using UUID to guarantee uniqueness
        userEmail = `${randomUUID()}@portal.internal`
      }

      if (!isSuperAdmin && !phone) {
        return NextResponse.json({ success: false, message: 'Phone number is required' }, { status: 400 })
      }
      if (!password || password.length < 6) {
        return NextResponse.json({ success: false, message: 'Password must be at least 6 characters' }, { status: 400 })
      }

      // Do not block phone reuse here. The login flow supports an account picker for
      // multiple accounts on the same mobile number, including multiple salesmen.

      let resolvedRoleId = role_id
      if (isDriverRole) {
        // DRIVER is not in DB roles table — use SALESMAN as the DB role, mark via auth metadata
        const { data: fallback } = await supabaseAdmin.from('roles').select('id').eq('name', 'SALESMAN').single()
        if (!fallback?.id) return NextResponse.json({ success: false, message: 'Could not resolve base role for DRIVER' }, { status: 500 })
        resolvedRoleId = fallback.id
      }

      if (!isDriverRole) {
        // Guard: only SUPER_ADMIN can create an ADMIN account
        if (roleRow?.name === 'ADMIN') {
          const authUser = await getUserFromToken(req)
          if (!authUser || authUser.role !== 'SUPER_ADMIN') {
            return NextResponse.json({ success: false, message: 'Only Super Admin can create a Company Admin account' }, { status: 403 })
          }
        }
      }

    // Create Supabase Auth user so they can log in
    stage = 'create-auth-user'
    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email: userEmail,
      password,
      email_confirm: true,
      user_metadata: isDriverRole ? { display_role: 'DRIVER' } : undefined,
    })

    if (authError) {
      return NextResponse.json({ success: false, message: authError.message }, { status: 400 })
    }

    const userId = authData.user.id

    const coreInsert = {
      id: userId,
      name,
      email: userEmail,
      phone: phone || null,
      role_id: resolvedRoleId,
      status: status || 'ACTIVE',
      parent_user_id: parent_user_id || null,
      party_id: party_id || null,
    }

    stage = 'insert-public-user'
    let userTable: 'users' | 'app_users' = 'users'
    let employeeCode: string | null = null
    try {
      if (party_id) employeeCode = await getNextEmployeeCode(userTable, party_id)
    } catch (err) {
      if (isMissingUsersTable(err as DbError)) {
        userTable = 'app_users'
        if (party_id) employeeCode = await getNextEmployeeCode(userTable, party_id)
      }
    }

    let insertPayload = {
      ...coreInsert,
      ...(employeeCode ? { employee_code: employeeCode } : {}),
      ...(aadhaar_number ? { aadhaar_number } : {}),
      ...(photo_url ? { photo_url } : {}),
    }

    let { data, error } = await supabasePublic
      .from(userTable)
      .insert(insertPayload)
      .select(USER_SELECT)
      .single()

    if (error && isMissingUsersTable(error)) {
      userTable = 'app_users'
      employeeCode = party_id ? await getNextEmployeeCode(userTable, party_id) : null
      insertPayload = {
        ...coreInsert,
        ...(employeeCode ? { employee_code: employeeCode } : {}),
        ...(aadhaar_number ? { aadhaar_number } : {}),
        ...(photo_url ? { photo_url } : {}),
      }
      const retryTable = await supabasePublic
        .from(userTable)
        .insert(insertPayload)
        .select(USER_SELECT)
        .single()
      data = retryTable.data
      error = retryTable.error
    }

    for (let attempt = 0; isEmployeeCodeDuplicateError(error) && party_id && attempt < 5; attempt++) {
      employeeCode = await getNextEmployeeCode(userTable, party_id)
      insertPayload = {
        ...coreInsert,
        ...(employeeCode ? { employee_code: employeeCode } : {}),
        ...(aadhaar_number ? { aadhaar_number } : {}),
        ...(photo_url ? { photo_url } : {}),
      }
      const retryEmployeeCode = await supabasePublic
        .from(userTable)
        .insert(insertPayload)
        .select(USER_SELECT)
        .single()
      data = retryEmployeeCode.data
      error = retryEmployeeCode.error
    }

    if (isPhoneDuplicateError(error)) {
      const dropped = await dropLegacyPhoneUniqueConstraint()
      if (dropped) {
        const retryAfterConstraintDrop = await supabasePublic
          .from(userTable)
          .insert(insertPayload)
          .select(USER_SELECT)
          .single()
        data = retryAfterConstraintDrop.data
        error = retryAfterConstraintDrop.error
      }
    }

    // If the insert failed because aadhaar_number/photo_url columns don't exist yet, retry without them
    if (error && (error.message?.includes('column') || error.message?.includes('schema cache') || error.code === 'PGRST204')) {
      const retry = await supabasePublic
        .from(userTable)
        .insert(coreInsert)
        .select(USER_SELECT)
        .single()
      data = retry.data
      error = retry.error
    }

    for (let attempt = 0; isEmployeeCodeDuplicateError(error) && party_id && attempt < 5; attempt++) {
      employeeCode = await getNextEmployeeCode(userTable, party_id)
      const retryEmployeeCode = await supabasePublic
        .from(userTable)
        .insert({ ...coreInsert, ...(employeeCode ? { employee_code: employeeCode } : {}) })
        .select(USER_SELECT)
        .single()
      data = retryEmployeeCode.data
      error = retryEmployeeCode.error
    }

    if (isPhoneDuplicateError(error)) {
      const dropped = await dropLegacyPhoneUniqueConstraint()
      if (dropped) {
        const retryAfterConstraintDrop = await supabasePublic
          .from(userTable)
          .insert(coreInsert)
          .select(USER_SELECT)
          .single()
        data = retryAfterConstraintDrop.data
        error = retryAfterConstraintDrop.error
      }
    }

    if (error) {
      // Rollback auth user if DB insert fails
      await supabaseAdmin.auth.admin.deleteUser(userId)
      // Surface meaningful constraint errors
      const msg = `${(error as { message?: string }).message || ''} ${(error as { details?: string }).details || ''}`.toLowerCase()
      if ((error as { code?: string }).code === '23505' || msg.includes('duplicate key')) {
        if (msg.includes('email')) return NextResponse.json({ success: false, message: 'A user with this email already exists' }, { status: 400 })
        if (msg.includes('phone')) return NextResponse.json({ success: false, message: 'The database still has a legacy unique constraint on phone. Run the drop-phone-unique-constraint migration, then create the salesman again.' }, { status: 400 })
        if (msg.includes('employee')) return NextResponse.json({ success: false, message: 'Employee ID already exists. Please reopen Create User to refresh the next Employee ID and try again.' }, { status: 400 })
        return NextResponse.json({ success: false, message: 'A user with these details already exists' }, { status: 400 })
      }
      return NextResponse.json({ success: false, message: (error as { message?: string }).message || 'Failed to create user record' }, { status: 500 })
    }

    return NextResponse.json({ success: true, data }, { status: 201 })
  } catch (err) {
    console.error('[USERS POST] Stage:', stage)
    console.error('[USERS POST] Raw error:', JSON.stringify(err, null, 2))
    console.error('[USERS POST] Error:', err)
    const message = getUnknownMessage(err, 'Failed to create user')
    return NextResponse.json(
      { success: false, message },
      { status: 500 }
    )
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const url = new URL(req.url)
    const id = url.searchParams.get('id')
    if (!id) return NextResponse.json({ success: false, message: 'User id is required' }, { status: 400 })

    // CRITICAL: Get authenticated user and resolve company scope for data isolation
    const authUser = await getUserFromToken(req)
    const companyId = await resolveCompanyScope(req, authUser)

    // Verify the user belongs to the user's company
    if (companyId) {
      const { data: user } = await supabasePublic
        .from('users')
        .select('party_id')
        .eq('id', id)
        .single()
      
      if (!user) {
        return NextResponse.json({ success: false, message: 'User not found' }, { status: 404 })
      }

      // If user has a party_id, verify it belongs to the company using party hierarchy
      if (user.party_id) {
        const tree = await getPartyDescendants(companyId)
        const treeIds = tree && tree.length > 0 ? tree.map((r: { id: string }) => r.id) : []
        if (!treeIds.includes(companyId)) {
          treeIds.push(companyId)
        }
        
        if (!treeIds.includes(user.party_id)) {
          return NextResponse.json({ success: false, message: 'User not found or access denied' }, { status: 403 })
        }
      }
    }

    // Delete from public users table first
    const { error: dbError } = await supabasePublic.from('users').delete().eq('id', id)
    if (dbError) throw dbError

    // Delete Supabase Auth user (best-effort)
    await supabaseAdmin.auth.admin.deleteUser(id)

    return NextResponse.json({ success: true })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed to delete user' },
      { status: 500 }
    )
  }
}

export async function GET(req: NextRequest) {
    let stage = 'init'
    try {
      const url = new URL(req.url)

      // Quick batch-lookup by IDs (used to resolve creator names)
      const idsParam = url.searchParams.get('ids')
      if (idsParam) {
        const ids = idsParam.split(',').filter(Boolean)
        if (ids.length === 0) return NextResponse.json({ success: true, data: [] })

        // Creators may live in `users` (company staff) OR `app_users` (party
        // users). Query both and merge so every id — and its party_id — resolves,
        // which is what lets the UI flag party-placed orders. party_id may be
        // absent on older schemas, so fall back to name-only per table.
        type CreatorRow = { id: string; name: string; party_id?: string | null }

        const lookup = async (table: 'users' | 'app_users'): Promise<CreatorRow[]> => {
          const withParty = await supabasePublic.from(table).select('id, name, party_id').in('id', ids)
          if (!withParty.error) return (withParty.data || []) as CreatorRow[]
          if ((withParty.error.message || '').includes('party_id')) {
            const nameOnly = await supabasePublic.from(table).select('id, name').in('id', ids)
            return (nameOnly.data || []) as CreatorRow[]
          }
          return [] // missing table / other error — non-critical lookup
        }

        const [usersRows, appRows] = await Promise.all([lookup('users'), lookup('app_users')])

        const byId = new Map<string, CreatorRow>()
        for (const row of [...appRows, ...usersRows]) {
          if (row?.id) byId.set(row.id, row) // users win on conflict (listed last)
        }

        return NextResponse.json({ success: true, data: [...byId.values()] })
      }

      stage = 'parse-query'
      const search = url.searchParams.get('search') || ''
      const role = url.searchParams.get('role') || ''
      const excludeRoles = url.searchParams.get('exclude_roles')?.split(',').filter(Boolean) || []
      const page = parseInt(url.searchParams.get('page') || '1')
      const limit = parseInt(url.searchParams.get('limit') || '20')
      const offset = (page - 1) * limit

      // Company scope: SUPER_ADMIN uses x-company-id header; ADMIN auto-scopes to own party_id
      stage = 'resolve-company-scope'
      const authUser = await getUserFromToken(req)
      const companyId = await resolveCompanyScope(req, authUser)
    let companyPartyIds: string[] | null = null
    if (companyId) {
      const tree = await getPartyDescendants(companyId)
      const treeIds = tree && tree.length > 0 ? tree.map((r: { id: string }) => r.id) : []
      // Always include the root company ID so the company ADMIN user (whose party_id = companyId) is returned
      if (!treeIds.includes(companyId)) treeIds.push(companyId)
      companyPartyIds = treeIds
    }

      // Special handling: DRIVER role lives in auth metadata, not the DB roles table
      stage = 'driver-special-case'
      if (role === 'DRIVER') {
        const authUsersList = await listAllAuthUsers()
        const driverIds = authUsersList
          .filter(u => u.user_metadata?.display_role === 'DRIVER')
          .map(u => u.id)
        if (driverIds.length === 0) {
          return NextResponse.json({ data: [], meta: { total: 0, page: 1, totalPages: 0 } })
        }

        // Scope to the current company's party tree in memory. The tree can hold
        // hundreds of party UUIDs; combining it with driverIds in a single
        // `.in('party_id', ...)` filter overflows PostgREST's URL header limit
        // (UND_ERR_HEADERS_OVERFLOW → 500). Filter by id (chunked) only, then
        // intersect party_id against the scope set here.
        const companyPartySet = companyPartyIds !== null ? new Set(companyPartyIds) : null
        if (companyPartySet !== null && companyPartySet.size === 0) {
          return NextResponse.json({ data: [], meta: { total: 0, page: 1, totalPages: 0 } })
        }

        type DriverRow = { id: string; name: string; email: string; phone: string; status: string; created_at: string; party_id: string | null }
        const fetchDriversFromTable = (tableName: 'users' | 'app_users') =>
          fetchAllInChunks<DriverRow>(driverIds, (chunk) =>
            supabasePublic
              .from(tableName)
              .select('id, name, email, phone, status, created_at, party_id')
              .in('id', chunk)
          )

        let { data: driverUsers, error: driverUsersErr } = await fetchDriversFromTable('users')
        if (driverUsersErr && isMissingUsersTable(driverUsersErr)) {
          const fallbackRes = await fetchDriversFromTable('app_users')
          driverUsers = fallbackRes.data
          driverUsersErr = fallbackRes.error
        }
        if (driverUsersErr) {
          throw driverUsersErr
        }

        const scopedDrivers = companyPartySet === null
          ? (driverUsers || [])
          : (driverUsers || []).filter(u => u.party_id != null && companyPartySet.has(u.party_id))

        const drivers = scopedDrivers.map(u => ({
          id: u.id, name: u.name, email: u.email, phone: u.phone,
          role: 'DRIVER', companyName: null, isActive: u.status === 'ACTIVE', createdAt: u.created_at,
        }))
        return NextResponse.json({ data: drivers, meta: { total: drivers.length, page: 1, totalPages: 1 } })
      }

      // Build filters
      stage = 'resolve-role-filter'
      let roleId: string | null = null
      if (role) {
        const { data: roleRow } = await supabaseAdmin.from('roles').select('id').eq('name', role).single()
        roleId = roleRow?.id || null
        if (!roleId) {
          return NextResponse.json({ data: [], meta: { total: 0, page, totalPages: 0 } })
        }
      }

      // Use raw SQL via rpc-style query to avoid ambiguity between auth.users and public.users
      stage = 'build-queries'

      let tableName: 'users' | 'app_users' = 'users'
      let countQuery = supabasePublic
        .from(tableName)
        .select('id', { count: 'exact', head: true })
      const baseSelect = 'id, name, email, phone, status, created_at, role_id, party_id, parent_user_id'
      const withRolesSelect = `${baseSelect}, roles(name)`
      const buildDataQuery = (selectCols: string) => supabasePublic
        .from(tableName)
        .select(selectCols)
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1)
      let dataQuery = buildDataQuery(withRolesSelect)

      // Scope to the company root party only — internal staff (ADMIN, SALESMAN, etc.) always
      // have party_id = companyId. Party portal users (RETAILER_USER, CNF_USER, SUPER_DEALER_USER)
      // have party_id = their own sub-party, so they are naturally excluded here.
      if (companyId) {
        countQuery = countQuery.eq('party_id', companyId)
        dataQuery = dataQuery.eq('party_id', companyId)
      } else if (companyPartyIds !== null) {
        if (companyPartyIds.length === 0) {
          return NextResponse.json({ data: [], meta: { total: 0, page, totalPages: 0 } })
        }
        countQuery = countQuery.in('party_id', companyPartyIds)
        dataQuery = dataQuery.in('party_id', companyPartyIds)
      }

      if (search) {
        countQuery = countQuery.or(`name.ilike.%${search}%,email.ilike.%${search}%`)
        dataQuery = dataQuery.or(`name.ilike.%${search}%,email.ilike.%${search}%`)
      }
        if (roleId) {
          countQuery = countQuery.eq('role_id', roleId)
          dataQuery = dataQuery.eq('role_id', roleId)
        }

        // Exclude roles by name (e.g. CNF_USER, SUPER_DEALER_USER, RETAILER_USER)
        if (excludeRoles.length > 0) {
          const { data: excludeRoleRows } = await supabaseAdmin
            .from('roles')
            .select('id')
            .in('name', excludeRoles)
          const excludeRoleIds = (excludeRoleRows || []).map(r => r.id)
          if (excludeRoleIds.length > 0) {
            for (const eid of excludeRoleIds) {
              countQuery = countQuery.neq('role_id', eid)
              dataQuery = dataQuery.neq('role_id', eid)
            }
          }
        }

      stage = 'fetch-count-and-users'
      let [{ count, error: countError }, firstDataRes] = await Promise.all([countQuery, dataQuery])
      if (countError && isMissingUsersTable(countError)) {
        tableName = 'app_users'
        countQuery = supabasePublic.from(tableName).select('id', { count: 'exact', head: true })
        dataQuery = buildDataQuery(withRolesSelect)
        if (companyId) {
          countQuery = countQuery.eq('party_id', companyId)
          dataQuery = dataQuery.eq('party_id', companyId)
        } else if (companyPartyIds !== null) {
          if (companyPartyIds.length === 0) {
            return NextResponse.json({ data: [], meta: { total: 0, page, totalPages: 0 } })
          }
          countQuery = countQuery.in('party_id', companyPartyIds)
          dataQuery = dataQuery.in('party_id', companyPartyIds)
        }
        if (search) {
          countQuery = countQuery.or(`name.ilike.%${search}%,email.ilike.%${search}%`)
          dataQuery = dataQuery.or(`name.ilike.%${search}%,email.ilike.%${search}%`)
        }
        if (roleId) {
          countQuery = countQuery.eq('role_id', roleId)
          dataQuery = dataQuery.eq('role_id', roleId)
        }
        if (excludeRoles.length > 0) {
          const { data: excludeRoleRows } = await supabaseAdmin
            .from('roles')
            .select('id')
            .in('name', excludeRoles)
          const excludeRoleIds = (excludeRoleRows || []).map(r => r.id)
          if (excludeRoleIds.length > 0) {
            for (const eid of excludeRoleIds) {
              countQuery = countQuery.neq('role_id', eid)
              dataQuery = dataQuery.neq('role_id', eid)
            }
          }
        }
        ;[{ count, error: countError }, firstDataRes] = await Promise.all([countQuery, dataQuery])
      }
      if (firstDataRes.error && isMissingUsersTable(firstDataRes.error)) {
        tableName = 'app_users'
        countQuery = supabasePublic.from(tableName).select('id', { count: 'exact', head: true })
        dataQuery = buildDataQuery(withRolesSelect)
        if (companyId) {
          countQuery = countQuery.eq('party_id', companyId)
          dataQuery = dataQuery.eq('party_id', companyId)
        } else if (companyPartyIds !== null) {
          if (companyPartyIds.length === 0) {
            return NextResponse.json({ data: [], meta: { total: 0, page, totalPages: 0 } })
          }
          countQuery = countQuery.in('party_id', companyPartyIds)
          dataQuery = dataQuery.in('party_id', companyPartyIds)
        }
        if (search) {
          countQuery = countQuery.or(`name.ilike.%${search}%,email.ilike.%${search}%`)
          dataQuery = dataQuery.or(`name.ilike.%${search}%,email.ilike.%${search}%`)
        }
        if (roleId) {
          countQuery = countQuery.eq('role_id', roleId)
          dataQuery = dataQuery.eq('role_id', roleId)
        }
        if (excludeRoles.length > 0) {
          const { data: excludeRoleRows } = await supabaseAdmin
            .from('roles')
            .select('id')
            .in('name', excludeRoles)
          const excludeRoleIds = (excludeRoleRows || []).map(r => r.id)
          if (excludeRoleIds.length > 0) {
            for (const eid of excludeRoleIds) {
              countQuery = countQuery.neq('role_id', eid)
              dataQuery = dataQuery.neq('role_id', eid)
            }
          }
        }
        ;[{ count, error: countError }, firstDataRes] = await Promise.all([countQuery, dataQuery])
      }
      if (countError) throw countError

      let data = firstDataRes.data
      let dataError = firstDataRes.error
      let usedRolesRelation = true

      // Fallback for schema/cache drift where relational select roles(name) fails.
      if (dataError && (dataError.code === 'PGRST200' || dataError.code === 'PGRST204' || dataError.code === '42703')) {
        usedRolesRelation = false
        let retryQuery = buildDataQuery(baseSelect)
        if (companyId) {
          retryQuery = retryQuery.eq('party_id', companyId)
        } else if (companyPartyIds !== null) {
          if (companyPartyIds.length === 0) {
            return NextResponse.json({ data: [], meta: { total: 0, page, totalPages: 0 } })
          }
          retryQuery = retryQuery.in('party_id', companyPartyIds)
        }
        if (search) retryQuery = retryQuery.or(`name.ilike.%${search}%,email.ilike.%${search}%`)
        if (roleId) retryQuery = retryQuery.eq('role_id', roleId)
        if (excludeRoles.length > 0) {
          const { data: excludeRoleRows } = await supabaseAdmin
            .from('roles')
            .select('id')
            .in('name', excludeRoles)
          const excludeRoleIds = (excludeRoleRows || []).map(r => r.id)
          for (const eid of excludeRoleIds) retryQuery = retryQuery.neq('role_id', eid)
        }
        const retryRes = await retryQuery
        data = retryRes.data
        dataError = retryRes.error
      }

      if (dataError) {
        const msg = (dataError as { message?: string }).message || 'Failed to fetch users'
        return NextResponse.json({ success: false, message: msg }, { status: 500 })
      }

      // Always also query the other table so users created in app_users are visible even when
      // the users table exists (and vice-versa). Dedup by id after merging.
      const otherTable: 'users' | 'app_users' = tableName === 'users' ? 'app_users' : 'users'
      try {
        const { data: otherData } = await supabasePublic
          .from(otherTable)
          .select(baseSelect)
          .order('created_at', { ascending: false })
          .eq('party_id', companyId || '')
        if (otherData && otherData.length > 0) {
          const existingIds = new Set(((data || []) as unknown as { id: string }[]).map(u => u.id))
          const newRows = (otherData as unknown as { id: string }[]).filter(u => !existingIds.has(u.id))
          if (newRows.length > 0) {
            data = [...((data || []) as unknown as object[]), ...newRows] as typeof data
            count = (count || 0) + newRows.length
          }
        }
      } catch { /* non-fatal: other table may not exist */ }

      // Fetch employee_code + photo_url separately — columns may not exist yet; non-fatal
      const empCodeMap: Record<string, string | null> = {}
      const photoUrlMap: Record<string, string | null> = {}
      const userRows = ((data || []) as unknown as UserListRow[])
      try {
        const userIds = userRows.map(u => u.id)
        if (userIds.length > 0) {
          const { data: extRows } = await supabasePublic
            .from('users')
            .select('id, employee_code, photo_url')
            .in('id', userIds)
          for (const r of ((extRows || []) as Pick<UserListRow, 'id' | 'employee_code' | 'photo_url'>[])) {
            empCodeMap[r.id] = r.employee_code || null
            photoUrlMap[r.id] = r.photo_url || null
          }
        }
      } catch { /* columns don't exist yet */ }

      // Fetch party names separately to avoid PostgREST ambiguity with auth.users
      const partyIds = [...new Set(userRows.map(u => u.party_id).filter(Boolean))]
      const partyMap: Record<string, string> = {}
      if (partyIds.length > 0) {
        const { data: parties } = await supabasePublic.from('parties').select('id, name').in('id', partyIds)
        for (const p of parties || []) partyMap[p.id] = p.name
      }

      const total = count || 0
      const totalPages = Math.ceil(total / limit)

      stage = 'resolve-role-names'
      const roleNameMap: Record<string, string> = {}
      if (!usedRolesRelation) {
        const roleIds = [...new Set(userRows.map(u => u.role_id).filter(Boolean))]
        if (roleIds.length > 0) {
          const { data: roleRows } = await supabaseAdmin.from('roles').select('id, name').in('id', roleIds)
          for (const r of roleRows || []) roleNameMap[r.id] = r.name
        }
      }

      // Fetch auth metadata to resolve display_role overrides (e.g. DRIVER).
      // MUST paginate every page: listUsers({ perPage: 1000 }) returns only the
      // first 1000 auth users, so on a multi-company instance a driver whose auth
      // record sits beyond page 1 loses its display_role and mis-renders as SALESMAN.
      const displayRoleMap: Record<string, string> = {}
      try {
        const authUsers = await listAllAuthUsers()
        for (const au of authUsers) {
          if (au.user_metadata?.display_role) {
            displayRoleMap[au.id] = au.user_metadata.display_role
          }
        }
      } catch { /* non-fatal */ }

      stage = 'build-response'
      const users = userRows.map(u => ({
        id: u.id,
        name: u.name,
        email: u.email,
        phone: u.phone,
        role: displayRoleMap[u.id]
          || (u.roles && typeof u.roles === 'object' && 'name' in u.roles ? (u.roles as { name: string }).name : null)
          || roleNameMap[u.role_id || '']
          || 'SALESMAN',
        companyName: u.party_id ? (partyMap[u.party_id] || null) : null,
        isActive: u.status === 'ACTIVE',
        createdAt: u.created_at,
        parent_user_id: u.parent_user_id || null,
        employee_code: empCodeMap[u.id] || null,
        photo_url: photoUrlMap[u.id] || null,
      }))

    return NextResponse.json({ data: users, meta: { total, page, totalPages } })
  } catch (err) {
    console.error('[USERS GET] caught:', { stage, err })
    const msg = getUnknownMessage(err, 'Failed to fetch users')
    return NextResponse.json({
      success: false,
      message: msg,
      stage: process.env.NODE_ENV === 'development' ? stage : undefined,
    }, { status: 500 })
  }
}
