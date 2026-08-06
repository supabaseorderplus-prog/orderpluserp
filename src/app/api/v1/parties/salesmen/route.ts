import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, getUserFromToken, resolveCompanyScope, getPartyDescendants, listAllAuthUsers } from '@/lib/supabase-server'
import { IN_FILTER_MAX_IDS, fetchAllInChunks } from '@/lib/supabase-in-chunks'

// GET /api/v1/parties/salesmen — list salesmen for the current company scope
export async function GET(req: NextRequest) {
  try {
    const isMissingUsersTable = (err: { code?: string; message?: string } | null | undefined) =>
      !!err && (err.code === 'PGRST205' || err.message?.includes("Could not find the table 'public.users'"))

    const caller = await getUserFromToken(req)
    const companyPartyId = await resolveCompanyScope(req, caller)

    // Get salesman role id
    const { data: roleData } = await supabaseAdmin
      .from('roles')
      .select('id')
      .eq('name', 'SALESMAN')
      .single()

    if (!roleData?.id) {
      return NextResponse.json({ data: [] })
    }

    // Resolve the company's party tree once; both the primary and fallback table
    // queries scope salesmen to it.
    let treeIds: string[] = []
    if (companyPartyId) {
      try {
        const tree = await getPartyDescendants(companyPartyId)
        treeIds = tree && tree.length > 0 ? tree.map((r: { id: string }) => r.id) : []
      } catch {
        treeIds = []
      }
      if (!treeIds.includes(companyPartyId)) treeIds.push(companyPartyId)
    }

    type SalesmanRow = { id: string; name: string; email: string | null; phone: string | null; status: string; party_id: string | null }

    // Large party trees overflow PostgREST's URL limit when passed to a single
    // .in() filter (UND_ERR_HEADERS_OVERFLOW), so split the scope into chunked
    // queries and merge. Merged chunks lose the per-query ORDER BY, so re-sort.
    const fetchSalesmen = async (table: 'users' | 'app_users') => {
      const buildQuery = (partyIds: string[] | null) => {
        let q = supabaseAdmin
          .from(table)
          .select('id, name, email, phone, status, party_id')
          .eq('role_id', roleData.id)
          .eq('status', 'ACTIVE')
          .order('name')
        if (partyIds) q = q.in('party_id', partyIds) as typeof q
        if (caller?.role === 'SALESMAN') q = q.eq('id', caller.id)
        return q
      }
      if (treeIds.length > IN_FILTER_MAX_IDS) {
        const { data, error } = await fetchAllInChunks(treeIds, (chunk) => buildQuery(chunk))
        const sorted = data
          ? [...(data as SalesmanRow[])].sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')))
          : null
        return { data: sorted, error }
      }
      return await buildQuery(treeIds.length > 0 ? treeIds : null)
    }

    let { data: salesmen, error } = await fetchSalesmen('users')
    if (error && isMissingUsersTable(error)) {
      ;({ data: salesmen, error } = await fetchSalesmen('app_users'))
    }
    if (error) {
      console.error('[PARTIES SALESMEN] Query error:', error)
      return NextResponse.json({ data: [] })
    }

    // DRIVER users are not a separate DB role — they are created with the SALESMAN
    // role_id and distinguished only by auth user_metadata.display_role === 'DRIVER'.
    // Exclude them so this list returns true salesmen only (drivers must not be
    // enrollable in salesman schemes). If the auth lookup fails, fall back to the
    // unfiltered list rather than dropping everyone.
    let driverAuthIds = new Set<string>()
    try {
      // Must paginate every auth page — listUsers({ perPage: 1000 }) misses drivers
      // beyond the first 1000 auth users, letting them leak into the salesman list.
      const authUsers = await listAllAuthUsers()
      driverAuthIds = new Set(
        authUsers.filter(u => u.user_metadata?.display_role === 'DRIVER').map(u => u.id)
      )
    } catch (e) {
      console.warn('[PARTIES SALESMEN] driver filter skipped (auth lookup failed):', e)
    }

    // Use user id as the unique identifier so all salesmen appear even if they share or lack a party_id.
    // party_id is kept as a separate field for scheme enrollment.
    const result = (salesmen || [])
      .filter(s => !driverAuthIds.has(s.id))
      .map(s => ({
        id: s.id,
        user_id: s.id,
        name: s.name,
        party_code: s.party_id ?? s.id,
        party_id: s.party_id ?? null,
        email: s.email,
      }))

    return NextResponse.json({ data: result })
  } catch (err) {
    console.error('[PARTIES SALESMEN] Error:', err)
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed to fetch salesmen' },
      { status: 500 }
    )
  }
}
