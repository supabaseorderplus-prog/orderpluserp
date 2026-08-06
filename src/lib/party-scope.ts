import { AuthUser, getPartyDescendants, supabaseAdmin } from '@/lib/supabase-server'
import { getGroupMemberIdsForSalesmen } from '@/lib/groups'
import { fetchAllRows } from '@/lib/supabase-in-chunks'

function normalizeRole(role: string | null | undefined) {
  return (role || '').trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_')
}

async function getDescendantIds(rootId: string) {
  const ids = new Set<string>([rootId])

  try {
    const tree = await getPartyDescendants(rootId)
    for (const row of tree || []) {
      if (row.id) ids.add(row.id)
    }
    if (ids.size > 1) return [...ids]
  } catch (err) {
    console.warn('[party-scope] get_party_descendants failed:', err)
  }

  // Page through every active party — an unbounded select caps at PostgREST's
  // max-rows (1000) and truncates the descendant tree once the table exceeds it.
  const { data: rows, error } = await fetchAllRows<{ id: string; parent_party_id: string | null }>(
    (from, to) => supabaseAdmin
      .from('parties')
      .select('id, parent_party_id')
      .eq('status', 'ACTIVE')
      .order('id')
      .range(from, to)
  )

  if (error) return [...ids]

  const childrenByParent = new Map<string, string[]>()
  for (const row of (rows || []) as { id: string; parent_party_id: string | null }[]) {
    if (!row.parent_party_id) continue
    const children = childrenByParent.get(row.parent_party_id) || []
    children.push(row.id)
    childrenByParent.set(row.parent_party_id, children)
  }

  const queue = [rootId]
  while (queue.length > 0) {
    const parentId = queue.shift()
    if (!parentId) continue
    for (const childId of childrenByParent.get(parentId) || []) {
      if (ids.has(childId)) continue
      ids.add(childId)
      queue.push(childId)
    }
  }

  return [...ids]
}

async function getCompanyPartyIds(companyId: string | null) {
  if (!companyId) return null
  return getDescendantIds(companyId)
}

async function getSalesmanPartyIds(authUser: AuthUser, companyPartyIds: string[] | null) {
  const salesmanIds = [...new Set([authUser.app_user_id, authUser.id].filter((id): id is string => Boolean(id)))]
  if (salesmanIds.length === 0) return []

  const rootIds = new Set<string>()
  const directPartyIds = new Set<string>()

  const { data: userRows } = await supabaseAdmin
    .from('users')
    .select('id, assigned_party_id')
    .in('id', salesmanIds)

  for (const row of (userRows || []) as { assigned_party_id?: string | null }[]) {
    if (row.assigned_party_id) rootIds.add(row.assigned_party_id)
  }

  const { data: junctionRows, error: junctionErr } = await supabaseAdmin
    .from('party_salesman')
    .select('party_id')
    .in('salesman_id', salesmanIds)
  if (!junctionErr) {
    for (const row of (junctionRows || []) as { party_id: string }[]) {
      if (row.party_id) directPartyIds.add(row.party_id)
    }
  }

  const { data: legacyRows, error: legacyErr } = await supabaseAdmin
    .from('parties')
    .select('id')
    .in('salesman_id', salesmanIds)
    .eq('status', 'ACTIVE')
  if (!legacyErr) {
    for (const row of (legacyRows || []) as { id: string }[]) {
      if (row.id) directPartyIds.add(row.id)
    }
  }

  // Group assignments: any party in a group assigned to this salesman is part of
  // their downline. Additive on top of the direct party_salesman assignments.
  for (const partyId of await getGroupMemberIdsForSalesmen(salesmanIds)) {
    directPartyIds.add(partyId)
  }

  const visibleIds = new Set<string>(directPartyIds)
  for (const rootId of rootIds) {
    const descendants = await getDescendantIds(rootId)
    for (const id of descendants) visibleIds.add(id)
  }

  const result = [...visibleIds]
  if (!companyPartyIds) return result
  const companySet = new Set(companyPartyIds)
  return result.filter((id) => companySet.has(id))
}

export async function getScopedPartyIdsForUser(authUser: AuthUser | null, companyId: string | null) {
  const companyPartyIds = await getCompanyPartyIds(companyId)
  if (!authUser) return companyPartyIds

  const role = normalizeRole(authUser.role)
  if (role === 'SUPER_ADMIN') return companyPartyIds
  if (role === 'SALESMAN') return getSalesmanPartyIds(authUser, companyPartyIds)

  return companyPartyIds
}
