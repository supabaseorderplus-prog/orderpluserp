import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, getUserFromToken, resolveCompanyScope, type AuthUser } from '@/lib/supabase-server'

type DbError = { code?: string; message?: string }
type RouteAssignmentColumn = 'salesman_id' | 'assigned_user_id'

function isSchemaGap(error: DbError | null | undefined): boolean {
  if (!error) return false
  const msg = String(error.message || '').toLowerCase()
  return (
    error.code === '42P01' ||
    error.code === 'PGRST200' ||
    error.code === 'PGRST204' ||
    error.code === 'PGRST205' ||
    msg.includes('does not exist') ||
    msg.includes('schema cache') ||
    msg.includes('could not find')
  )
}

async function addUserIdsFromTable(tableName: 'users' | 'app_users', authUser: AuthUser, ids: Set<string>) {
  const directIds = [authUser.id, authUser.app_user_id].filter((id): id is string => Boolean(id))

  if (directIds.length > 0) {
    const { data, error } = await supabaseAdmin
      .from(tableName)
      .select('id')
      .in('id', directIds)

    if (!error) {
      for (const row of data || []) ids.add(row.id)
    } else if (!isSchemaGap(error)) {
      console.warn(`[ROUTES GET] Could not resolve salesman IDs from ${tableName}:`, error)
    }
  }

  if (authUser.email) {
    const { data, error } = await supabaseAdmin
      .from(tableName)
      .select('id')
      .eq('email', authUser.email)

    if (!error) {
      for (const row of data || []) ids.add(row.id)
    } else if (!isSchemaGap(error)) {
      console.warn(`[ROUTES GET] Could not resolve salesman email from ${tableName}:`, error)
    }
  }
}

async function resolveSalesmanFilterIds(authUser: AuthUser) {
  const ids = new Set<string>()
  if (authUser.id) ids.add(authUser.id)
  if (authUser.app_user_id) ids.add(authUser.app_user_id)

  await addUserIdsFromTable('users', authUser, ids)
  await addUserIdsFromTable('app_users', authUser, ids)

  return [...ids]
}

// Resolves all user IDs that belong to a company (via party_id).
// Used as a proxy company filter when the routes.company_id column doesn't exist.
async function getCompanyUserIds(companyId: string): Promise<string[]> {
  const ids = new Set<string>()
  for (const table of ['users', 'app_users'] as const) {
    const { data } = await supabaseAdmin.from(table).select('id').eq('party_id', companyId)
    for (const row of data || []) ids.add(row.id)
  }
  return [...ids]
}

async function readRoutesByAssignmentColumn(
  assignmentColumn: RouteAssignmentColumn,
  salesmanFilterIds: string[] | null,
  companyId: string | null,
  // Pre-resolved user IDs for the target company, used as a proxy when
  // the routes.company_id column doesn't exist in this schema.
  companyUserIds: string[] | null,
) {
  const fullCols = assignmentColumn === 'assigned_user_id'
    ? 'id, name, code, is_active, assigned_user_id, status, created_by'
    : 'id, name, is_active, salesman_id, status, created_by'
  const minimalCols = assignmentColumn === 'assigned_user_id'
    ? 'id, name, assigned_user_id'
    : 'id, name, salesman_id'

  const runQuery = (cols: string, withCompany: boolean) => {
    let q = supabaseAdmin.from('routes').select(cols).order('name')
    if (salesmanFilterIds) {
      q = q.in(assignmentColumn, salesmanFilterIds)
    } else if (!withCompany && companyUserIds !== null) {
      // company_id column absent: scope to this company's users instead. A route is
      // owned by either its assignee (salesman_id/assigned_user_id) OR its creator
      // (created_by), so match on both — matching only the assignment column drops
      // every route whose assignee is null (the common case on the live schema).
      // Empty array means the company has no users → no routes should match.
      if (companyUserIds.length > 0) {
        const ids = companyUserIds.join(',')
        q = q.or(`${assignmentColumn}.in.(${ids}),created_by.in.(${ids})`)
      } else {
        q = q.in(assignmentColumn, ['__no_match__'])
      }
    }
    if (withCompany && companyId) q = q.eq('company_id', companyId)
    return q
  }

  const mapRows = (data: unknown[], code: string | null) =>
    (data as Record<string, unknown>[]).map((row) => ({
      ...row,
      code: code ?? (typeof row.code === 'string' ? row.code : ''),
      salesman_id: row[assignmentColumn],
      is_active: code !== null ? true : row.is_active !== false,
    }))

  // Tier 1: full cols + company_id filter
  const full = await runQuery(fullCols, true)
  if (!full.error) return mapRows(full.data as unknown[], null)
  if (!isSchemaGap(full.error)) throw full.error

  // Tier 2: minimal cols + company_id filter
  const minimal = await runQuery(minimalCols, true)
  if (!minimal.error) return mapRows(minimal.data as unknown[], '')
  if (!isSchemaGap(minimal.error)) throw minimal.error

  // Tier 3: full cols, no company_id (column absent) — use companyUserIds proxy
  const fullNoCompany = await runQuery(fullCols, false)
  if (!fullNoCompany.error) return mapRows(fullNoCompany.data as unknown[], null)
  if (!isSchemaGap(fullNoCompany.error)) throw fullNoCompany.error

  // Tier 4: minimal cols, no company_id — use companyUserIds proxy
  const minimalNoCompany = await runQuery(minimalCols, false)
  if (!minimalNoCompany.error) return mapRows(minimalNoCompany.data as unknown[], '')
  if (isSchemaGap(minimalNoCompany.error)) return null
  throw minimalNoCompany.error
}

export async function DELETE(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url)
    const id = searchParams.get('id')
    if (!id) return NextResponse.json({ success: false, message: 'id is required' }, { status: 400 })

    const authUser = await getUserFromToken(req)
    if (!authUser) return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 })

    const companyId = await resolveCompanyScope(req, authUser)
    if (!companyId && authUser.role !== 'SUPER_ADMIN') {
      return NextResponse.json({ success: false, message: 'Forbidden' }, { status: 403 })
    }

    // Remove dependent stops first. The routes/beat_routes schema usually cascades
    // this via FK, but deleting explicitly keeps things consistent when it doesn't.
    // A schema gap (table/column absent in this deployment) is non-fatal; so is an
    // RLS/permission hiccup here — the route delete below is the user-visible action.
    const { error: stopsError } = await supabaseAdmin.from('route_stops').delete().eq('route_id', id)
    if (stopsError && !isSchemaGap(stopsError)) {
      console.warn('[ROUTES DELETE] Could not remove route_stops:', stopsError)
    }

    // Delete the route. Prefer the company_id-scoped delete for isolation, but the
    // `routes` table is a view over beat_routes in some deployments and doesn't always
    // expose company_id — fall back to an id-only delete when that column is absent
    // (mirrors the GET/POST/PUT schema-gap handling above).
    const runDelete = (withCompany: boolean) => {
      let q = supabaseAdmin.from('routes').delete().eq('id', id)
      if (withCompany && companyId) q = q.eq('company_id', companyId)
      return q
    }

    if (companyId) {
      const scoped = await runDelete(true)
      if (!scoped.error) return NextResponse.json({ success: true })
      if (!isSchemaGap(scoped.error)) throw scoped.error
    }

    const fallback = await runDelete(false)
    if (fallback.error) throw fallback.error

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('[ROUTES DELETE] Error:', err)
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed' },
      { status: 500 },
    )
  }
}

export async function GET(req: NextRequest) {
  try {
    const authUser = await getUserFromToken(req)
    if (!authUser) {
      return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 })
    }

    const companyId = await resolveCompanyScope(req, authUser)

    // Fail-closed: non-SUPER_ADMIN without a company scope gets nothing
    if (!companyId && authUser.role !== 'SUPER_ADMIN') {
      return NextResponse.json({ data: [] })
    }

    const salesmanFilterIds = authUser.role === 'SALESMAN'
      ? await resolveSalesmanFilterIds(authUser)
      : null

    // Resolved once and reused for both column variants.
    // null means "no company scope needed" (SUPER_ADMIN with no company selected).
    const companyUserIds = companyId ? await getCompanyUserIds(companyId) : null

    const routeMap = new Map<string, Record<string, unknown>>()

    const reads = await Promise.all([
      readRoutesByAssignmentColumn('salesman_id', salesmanFilterIds, companyId, companyUserIds),
      readRoutesByAssignmentColumn('assigned_user_id', salesmanFilterIds, companyId, companyUserIds),
    ])

    for (const rows of reads) {
      for (const row of rows || []) {
        const id = (row as Record<string, unknown>).id as string | undefined
        if (!id) continue
        const existing = routeMap.get(id)
        routeMap.set(id, {
          ...existing,
          ...row,
          salesman_id: existing?.salesman_id || row.salesman_id,
          code: row.code || existing?.code || '',
        })
      }
    }

    const routesData = [...routeMap.values()]
    const routeIds = routesData.map((r) => r.id as string)
    const stopsMap: Record<string, number> = {}
    if (routeIds.length > 0) {
      const { data: stopsData, error: stopsError } = await supabaseAdmin
        .from('route_stops')
        .select('route_id')
        .in('route_id', routeIds)
      if (!stopsError) {
        for (const stop of stopsData || []) {
          stopsMap[stop.route_id] = (stopsMap[stop.route_id] || 0) + 1
        }
      }
    }

    const salesmanIds = [
      ...new Set(routesData.map((r) => r.salesman_id as string).filter(Boolean)),
    ]
    const nameMap: Record<string, string> = {}
    if (salesmanIds.length > 0) {
      for (const tableName of ['users', 'app_users'] as const) {
        const { data: usersData, error: usersError } = await supabaseAdmin
          .from(tableName)
          .select('id, name')
          .in('id', salesmanIds)
        if (usersError && !isSchemaGap(usersError)) {
          console.warn(`[ROUTES GET] Could not fetch salesman names from ${tableName}:`, usersError)
        }
        for (const u of usersData || []) nameMap[u.id] = u.name
      }
    }

    const routes = routesData.map((r) => ({
      id: r.id,
      name: r.name,
      code: typeof r.code === 'string' ? r.code : '',
      salesman_id: r.salesman_id || null,
      salesman: r.salesman_id ? { name: nameMap[r.salesman_id as string] || 'Unknown' } : null,
      stops: stopsMap[r.id as string] || 0,
      isActive: r.is_active !== false,
    }))

    return NextResponse.json({ data: routes })
  } catch (err) {
    console.error('[ROUTES GET] Error:', err)
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed' },
      { status: 500 },
    )
  }
}

export async function PUT(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url)
    const id = searchParams.get('id')
    if (!id) return NextResponse.json({ success: false, message: 'id is required' }, { status: 400 })

    const body = await req.json()
    const { name, assigned_user_id, is_active } = body
    if (!name) return NextResponse.json({ success: false, message: 'Name is required' }, { status: 400 })

    const authUser = await getUserFromToken(req)
    if (!authUser) return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 })

    const companyId = await resolveCompanyScope(req, authUser)
    if (!companyId && authUser.role !== 'SUPER_ADMIN') {
      return NextResponse.json({ success: false, message: 'Forbidden' }, { status: 403 })
    }

    const updateAttempts: Record<string, unknown>[] = [
      { name, is_active: is_active !== false, ...(assigned_user_id ? { salesman_id: assigned_user_id } : {}) },
      { name, is_active: is_active !== false, ...(assigned_user_id ? { assigned_user_id } : {}) },
      { name, ...(assigned_user_id ? { salesman_id: assigned_user_id } : {}) },
      { name, ...(assigned_user_id ? { assigned_user_id } : {}) },
    ]

    for (const updateData of updateAttempts) {
      let q = supabaseAdmin.from('routes').update(updateData).eq('id', id)
      if (companyId) q = q.eq('company_id', companyId)
      const result = await q.select().single()
      if (!result.error) return NextResponse.json({ success: true, data: result.data })
      if (!isSchemaGap(result.error)) throw result.error
    }

    return NextResponse.json({ success: false, message: 'Routes table schema is missing required columns' }, { status: 500 })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed' },
      { status: 500 },
    )
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { name, assigned_user_id, is_active, code, group_id } = body
    if (!name) return NextResponse.json({ success: false, message: 'Name is required' }, { status: 400 })

    const authUser = await getUserFromToken(req)
    if (!authUser) return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 })

    const companyId = await resolveCompanyScope(req, authUser)
    if (!companyId && authUser.role !== 'SUPER_ADMIN') {
      return NextResponse.json({ success: false, message: 'Forbidden' }, { status: 403 })
    }

    const appUserId = authUser.app_user_id || authUser.id
    const assignedUserId = assigned_user_id || appUserId

    // `code` carries the route's weekday (e.g. "MON"); kept in every insert tier so it
    // survives whichever schema variant wins. `group_id` is best-effort metadata — it only
    // appears in the rich tiers, so a deployment without that column simply falls through.
    const routeCode = code ? String(code) : ''
    const groupFields = group_id ? { group_id: String(group_id) } : {}

    // zone_id — try to resolve but treat as optional (column may not exist)
    let zoneId: string | null = body.zone_id || null
    if (!zoneId) {
      const { data: zones } = await supabaseAdmin
        .from('zones')
        .select('id')
        .eq('is_active', true)
        .limit(1)
      zoneId = zones?.[0]?.id || null
    }

    const cFields = companyId ? { company_id: companyId } : {}

    // Build two tiers: with company_id first (preferred for isolation),
    // then without (fallback if the column doesn't exist in this schema).
    const withCompany: Record<string, unknown>[] = companyId ? [
      {
        name,
        code: routeCode,
        is_active: is_active !== false,
        created_by: appUserId,
        salesman_id: assignedUserId,
        schedule_type: body.schedule_type || 'DAILY',
        status: 'ACTIVE',
        ...cFields,
        ...groupFields,
        ...(zoneId ? { zone_id: zoneId } : {}),
      },
      {
        name,
        code: routeCode,
        assigned_user_id: assignedUserId,
        territory_id: body.territory_id || null,
        is_active: is_active !== false,
        status: 'ACTIVE',
        ...cFields,
        ...groupFields,
      },
      // Salesman-bearing tiers without group_id: keep the route assigned even when the
      // group_id column is absent (the rich tiers above would have schema-gapped).
      { name, code: routeCode, created_by: appUserId, salesman_id: assignedUserId, status: 'ACTIVE', ...cFields },
      { name, code: routeCode, assigned_user_id: assignedUserId, is_active: is_active !== false, ...cFields },
      { name, code: routeCode, ...cFields },
      // Owner-bearing tier without code/is_active — persists attribution on schemas that
      // lack those columns (the live `routes` table has neither). Without this the insert
      // falls through to name-only, leaving salesman_id/created_by null so the route can
      // never be scoped to a company on read.
      { name, created_by: appUserId, salesman_id: assignedUserId, status: 'ACTIVE', ...cFields },
      { name, ...cFields },
    ] : []

    const withoutCompany: Record<string, unknown>[] = [
      {
        name,
        code: routeCode,
        is_active: is_active !== false,
        created_by: appUserId,
        salesman_id: assignedUserId,
        schedule_type: body.schedule_type || 'DAILY',
        status: 'ACTIVE',
        ...groupFields,
        ...(zoneId ? { zone_id: zoneId } : {}),
      },
      {
        name,
        code: routeCode,
        assigned_user_id: assignedUserId,
        territory_id: body.territory_id || null,
        is_active: is_active !== false,
        status: 'ACTIVE',
        ...groupFields,
      },
      { name, code: routeCode, created_by: appUserId, salesman_id: assignedUserId, status: 'ACTIVE' },
      { name, code: routeCode, assigned_user_id: assignedUserId, is_active: is_active !== false },
      { name, code: routeCode },
      // Owner-bearing, code-free fallback (see withCompany note above).
      { name, created_by: appUserId, salesman_id: assignedUserId, status: 'ACTIVE' },
      { name },
    ]

    for (const insertData of [...withCompany, ...withoutCompany]) {
      const result = await supabaseAdmin.from('routes').insert(insertData).select().single()
      if (!result.error) return NextResponse.json({ success: true, data: result.data })
      if (!isSchemaGap(result.error)) {
        console.error('[ROUTES POST] Supabase error:', result.error)
        return NextResponse.json({ success: false, message: result.error.message || 'Database error' }, { status: 500 })
      }
    }

    return NextResponse.json({ success: false, message: 'Routes table schema is missing required columns' }, { status: 500 })
  } catch (err) {
    console.error('[ROUTES POST] Error:', err)
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed' },
      { status: 500 },
    )
  }
}
