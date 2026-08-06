import { NextRequest, NextResponse } from 'next/server'
import { getUserFromToken, resolveCompanyScope, supabaseAdmin, getPartyDescendants } from '@/lib/supabase-server'

type UserRow = {
  id: string
  name: string | null
  role_id: string | null
  party_id: string | null
  parent_user_id: string | null
  status: string | null
}

type RoleRow = {
  id: string
  name: string
}

type HierarchyNode = {
  id: string
  name: string
  role: string
  children: HierarchyNode[]
}

const isMissingUsersTable = (err: { code?: string; message?: string } | null | undefined) =>
  !!err && (
    err.code === 'PGRST205' ||
    err.code === '42P01' ||
    (err.message || '').includes("Could not find the table 'public.users'")
  )

async function resolveUsersTable(): Promise<'users' | 'app_users'> {
  const probe = await supabaseAdmin.from('users').select('id').limit(0)
  return isMissingUsersTable(probe.error) ? 'app_users' : 'users'
}

async function getCompanyPartyIds(companyId: string | null): Promise<string[] | null> {
  if (!companyId) return null
  const tree = await getPartyDescendants(companyId)
  const ids = tree && tree.length > 0 ? tree.map((r: { id: string }) => r.id) : []
  if (!ids.includes(companyId)) ids.push(companyId)
  return ids
}

function inCompanyScope(companyPartyIds: string[] | null, partyId: string | null): boolean {
  if (!companyPartyIds) return true
  if (!partyId) return false
  return companyPartyIds.includes(partyId)
}

async function fetchUserById(userId: string, table: 'users' | 'app_users'): Promise<UserRow | null> {
  const { data } = await supabaseAdmin
    .from(table as 'users')
    .select('id, name, role_id, party_id, parent_user_id, status')
    .eq('id', userId)
    .maybeSingle()

  if (!data) return null
  return {
    id: data.id,
    name: data.name || null,
    role_id: data.role_id || null,
    party_id: data.party_id || null,
    parent_user_id: data.parent_user_id || null,
    status: data.status || null,
  }
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const authUser = await getUserFromToken(req)
    if (!authUser) {
      return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 })
    }

    const { id } = await params

    let companyId = await resolveCompanyScope(req, authUser)
    if (!companyId && authUser.role !== 'SUPER_ADMIN') {
      companyId = authUser.party_id || null
    }
    if (!companyId && authUser.role !== 'SUPER_ADMIN') {
      return NextResponse.json({ success: false, message: 'Company scope is required' }, { status: 403 })
    }

    const usersTable = await resolveUsersTable()
    const rootUser = await fetchUserById(id, usersTable)
    if (!rootUser || rootUser.status === 'DELETED') {
      return NextResponse.json({ success: false, message: 'User not found' }, { status: 404 })
    }

    const companyPartyIds = await getCompanyPartyIds(companyId)
    if (!inCompanyScope(companyPartyIds, rootUser.party_id) && rootUser.id !== authUser.id) {
      return NextResponse.json({ success: false, message: 'User not found or access denied' }, { status: 403 })
    }

    const { data: roles } = await supabaseAdmin.from('roles').select('id, name')
    const roleMap = new Map<string, string>()
    for (const role of (roles || []) as RoleRow[]) {
      roleMap.set(role.id, role.name)
    }

    const visited = new Set<string>()

    const buildNode = async (user: UserRow): Promise<HierarchyNode> => {
      const roleName = user.role_id ? (roleMap.get(user.role_id) || 'SALESMAN') : 'SALESMAN'
      if (visited.has(user.id)) {
        return { id: user.id, name: user.name || 'Unnamed', role: roleName, children: [] }
      }
      visited.add(user.id)

      let childQuery = supabaseAdmin
        .from(usersTable as 'users')
        .select('id, name, role_id, party_id, parent_user_id, status')
        .eq('parent_user_id', user.id)
        .neq('status', 'DELETED')
        .order('name')

      if (companyPartyIds) {
        childQuery = childQuery.in('party_id', companyPartyIds)
      }

      const { data: children } = await childQuery
      const childRows = (children || []) as UserRow[]
      const childNodes = await Promise.all(
        childRows
          .filter((child) => inCompanyScope(companyPartyIds, child.party_id))
          .map((child) => buildNode(child))
      )

      return {
        id: user.id,
        name: user.name || 'Unnamed',
        role: roleName,
        children: childNodes,
      }
    }

    const tree = await buildNode(rootUser)
    return NextResponse.json({ success: true, data: tree })
  } catch (err) {
    console.error('[users/hierarchy] error:', err)
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed to fetch hierarchy' },
      { status: 500 }
    )
  }
}
