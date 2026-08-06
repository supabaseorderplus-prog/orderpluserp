import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, getUserFromToken, resolveCompanyScope, getPartyDescendants, clearAuthUserCacheForUser } from '@/lib/supabase-server'

type UserTable = 'users' | 'app_users'
type BasicUserRow = { id: string; party_id: string | null; status?: string | null }

async function fetchBasicUser(id: string): Promise<{ table: UserTable; user: BasicUserRow } | null> {
  for (const table of ['users', 'app_users'] as const) {
    const { data, error } = await supabaseAdmin
      .from(table)
      .select('id, party_id, status')
      .eq('id', id)
      .maybeSingle()
    if (!error && data) return { table, user: data as BasicUserRow }
  }
  return null
}

async function assertUserInScope(user: BasicUserRow, companyId: string | null) {
  if (!companyId || !user.party_id) return true

  const tree = await getPartyDescendants(companyId)
  const treeIds = tree && tree.length > 0 ? tree.map((r: { id: string }) => r.id) : []
  if (!treeIds.includes(companyId)) treeIds.push(companyId)

  return treeIds.includes(user.party_id)
}

async function updateUserStatus(table: UserTable, id: string, status: string, updatedAt: string) {
  const withUpdatedAt = await supabaseAdmin
    .from(table)
    .update({ status, updated_at: updatedAt }, { count: 'exact' })
    .eq('id', id)

  if (!withUpdatedAt.error) return withUpdatedAt

  const message = withUpdatedAt.error.message || ''
  if (withUpdatedAt.error.code !== 'PGRST204' && !message.includes('updated_at') && !message.includes('schema cache')) {
    return withUpdatedAt
  }

  return supabaseAdmin
    .from(table)
    .update({ status }, { count: 'exact' })
    .eq('id', id)
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const authUser = await getUserFromToken(req)
    if (!authUser || (authUser.role !== 'SUPER_ADMIN' && authUser.role !== 'ADMIN')) {
      return NextResponse.json({ success: false, message: 'Forbidden' }, { status: 403 })
    }

    const companyId = await resolveCompanyScope(req, authUser)

    const { id } = await params
    const body = await req.json()

    const requestedStatus = 'status' in body
      ? String(body.status).toUpperCase()
      : 'isActive' in body
        ? (body.isActive ? 'ACTIVE' : 'INACTIVE')
        : null

    if (!requestedStatus || !['ACTIVE', 'INACTIVE'].includes(requestedStatus)) {
      return NextResponse.json({ success: false, message: 'status must be ACTIVE or INACTIVE' }, { status: 400 })
    }

    if (id === authUser.id || id === authUser.app_user_id) {
      return NextResponse.json({ success: false, message: 'You cannot change your own active status' }, { status: 400 })
    }

    const found = await fetchBasicUser(id)
    if (!found) {
      return NextResponse.json({ success: false, message: 'User not found' }, { status: 404 })
    }

    if (!(await assertUserInScope(found.user, companyId))) {
      return NextResponse.json({ success: false, message: 'User not found or access denied' }, { status: 403 })
    }

    const now = new Date().toISOString()
    let updated = false
    let lastError: { message?: string } | null = null

    for (const table of ['users', 'app_users'] as const) {
      const { error, count } = await updateUserStatus(table, id, requestedStatus, now)

      if (!error && (count || 0) > 0) updated = true
      if (error) lastError = error
    }

    if (!updated) {
      return NextResponse.json({ success: false, message: lastError?.message || 'User not found' }, { status: 404 })
    }

    const { error: authUpdateError } = await supabaseAdmin.auth.admin.updateUserById(id, {
      ban_duration: requestedStatus === 'ACTIVE' ? 'none' : '876000h',
    })

    if (authUpdateError) {
      return NextResponse.json({ success: false, message: authUpdateError.message }, { status: 500 })
    }

    clearAuthUserCacheForUser(id)

    return NextResponse.json({
      success: true,
      data: {
        id,
        status: requestedStatus,
        isActive: requestedStatus === 'ACTIVE',
        walletActive: requestedStatus === 'ACTIVE',
      },
    })
  } catch (err) {
    return NextResponse.json({ success: false, message: err instanceof Error ? err.message : 'Failed' }, { status: 500 })
  }
}

type UserRow = {
  id: string
  name: string
  email: string | null
  phone: string | null
  status: string
  created_at: string
  last_login: string | null
  role_id: string | null
  party_id: string | null
  parent_user_id?: string | null
  employee_code?: string | null
  photo_url?: string | null
  roles?: { name?: string } | null
}

async function fetchUserById(id: string): Promise<UserRow | null> {
  const select = 'id, name, email, phone, status, created_at, last_login, role_id, party_id, parent_user_id, employee_code, photo_url, roles(name)'
  const { data, error } = await supabaseAdmin.from('users').select(select).eq('id', id).single()
  if (!error && data) return data as UserRow
  const { data: data2, error: error2 } = await supabaseAdmin.from('app_users').select(select).eq('id', id).single()
  if (!error2 && data2) return data2 as UserRow
  return null
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const authUser = await getUserFromToken(req)
    const companyId = await resolveCompanyScope(req, authUser)

    const { id } = await params

    const user = await fetchUserById(id)

    if (!user) {
      return NextResponse.json({ success: false, message: 'User not found' }, { status: 404 })
    }

    // Verify user belongs to company
    if (companyId && user.party_id) {
      const tree = await getPartyDescendants(companyId)
      const treeIds = tree && tree.length > 0 ? tree.map((r: { id: string }) => r.id) : []
      if (!treeIds.includes(companyId)) treeIds.push(companyId)

      if (!treeIds.includes(user.party_id)) {
        return NextResponse.json({ success: false, message: 'User not found or access denied' }, { status: 403 })
      }
    }

    const roleName = user.roles && typeof user.roles === 'object' && 'name' in user.roles
      ? (user.roles as { name: string }).name : 'SALESMAN'

    // Fetch parent user if present
    let parentUser: { name: string; role: string } | null = null
    if (user.parent_user_id) {
      const parent = await fetchUserById(user.parent_user_id)
      if (parent) {
        const parentRole = parent.roles && typeof parent.roles === 'object' && 'name' in parent.roles
          ? (parent.roles as { name: string }).name : ''
        parentUser = { name: parent.name, role: parentRole }
      }
    }

    return NextResponse.json({
      data: {
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: roleName,
        status: user.status,
        isActive: user.status === 'ACTIVE',
        isVerified: user.status === 'ACTIVE',
        createdAt: user.created_at,
        lastLogin: user.last_login,
        employee_code: user.employee_code ?? null,
        photo_url: user.photo_url ?? null,
        parentUser,
        zone: null,
      },
    })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed' },
      { status: 500 }
    )
  }
}
