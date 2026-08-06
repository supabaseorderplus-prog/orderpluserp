import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, getUserFromToken, resolveCompanyScope, getPartyDescendants, listAllAuthUsers } from '@/lib/supabase-server'
import { computeCurrentBalances } from '@/lib/party-balance'
import { fetchAllInChunks, fetchAllInChunksPaged } from '@/lib/supabase-in-chunks'
import { ensureGroupsSchema } from '@/lib/groups'
import { listFallbackGroups } from '@/lib/groups-fallback'

// GET — list salesmen with their assigned party + all party assignments via party_salesman join table.
export async function GET(req: NextRequest) {
  try {
    const caller = await getUserFromToken(req)
    const companyPartyId = await resolveCompanyScope(req, caller)

    let allowedPartyIds: string[] | null = null
    if (companyPartyId) {
      // getPartyDescendants returns the complete subtree (root + all descendants) via a
      // cycle-safe parent_party_id BFS — the get_party_descendants RPC caps at 1000 and
      // would drop super dealers (and their retailers) once the company exceeds that.
      const descendants = await getPartyDescendants(companyPartyId)
      allowedPartyIds = [...new Set([companyPartyId, ...descendants.map((d) => d.id)])]
    }

    // Get salesman role id
    const { data: roleData } = await supabaseAdmin
      .from('roles')
      .select('id')
      .eq('name', 'SALESMAN')
      .single()

    if (!roleData?.id) {
      return NextResponse.json({ success: true, data: { salesmen: [], allParties: [], salesmanToParties: {}, isScopedToSelf: caller?.role === 'SALESMAN' } })
    }

    // Resolve which table name to use — 'users' or 'app_users' depending on schema cache
    const usersTableProbe = await supabaseAdmin.from('users').select('id').limit(0)
    const isMissingUsersTable = usersTableProbe.error?.code === 'PGRST205' ||
      (usersTableProbe.error?.message || '').includes('Could not find the table')
    const usersTable = isMissingUsersTable ? 'app_users' : 'users'

    // Probe for optional columns
    const empCodeProbe = await supabaseAdmin.from(usersTable).select('employee_code').limit(0)
    const hasEmployeeCode = !empCodeProbe.error

    // Fetch salesmen scoped to this company
    const userSelect = ['id', 'name', 'email', 'phone', 'status', 'party_id', hasEmployeeCode ? 'employee_code' : null]
      .filter(Boolean).join(', ')
    // Chunked: large company scopes overflow PostgREST's URL-encoded .in() filter
    // (undici 16KB header limit ≈ 400+ UUIDs → 500). Merge + re-sort by name.
    const baseSalesmenQuery = () => supabaseAdmin
      .from(usersTable as 'users')
      .select(userSelect)
      .eq('role_id', roleData.id)

    let salesmen: Record<string, unknown>[] | null
    let error: { code?: string; message?: string } | null = null
    if (caller?.role === 'SALESMAN') {
      const res = await baseSalesmenQuery().eq('id', caller.id).order('name')
      salesmen = res.data as Record<string, unknown>[] | null
      error = res.error
    } else if (allowedPartyIds) {
      const res = await fetchAllInChunks<Record<string, unknown>>(allowedPartyIds, (chunk) =>
        baseSalesmenQuery().in('party_id', chunk),
      )
      salesmen = res.data
      error = res.error
      if (salesmen) salesmen.sort((a, b) => String(a?.name ?? '').localeCompare(String(b?.name ?? '')))
    } else {
      const res = await baseSalesmenQuery().order('name')
      salesmen = res.data as Record<string, unknown>[] | null
      error = res.error
    }
    if (error) throw error

    // DRIVER users are not a separate DB role — they share the SALESMAN role_id and
    // are distinguished only by auth user_metadata.display_role === 'DRIVER'. Exclude
    // them so this list (and the group salesman dropdown it feeds) shows true salesmen
    // only. Fail-open: if the auth lookup fails, keep the unfiltered list rather than
    // dropping everyone.
    try {
      // Must paginate every auth page — listUsers({ perPage: 1000 }) misses drivers
      // beyond the first 1000 auth users, letting them leak into the salesman list.
      const authUsers = await listAllAuthUsers()
      const driverAuthIds = new Set(
        authUsers.filter((u) => u.user_metadata?.display_role === 'DRIVER').map((u) => u.id),
      )
      if (driverAuthIds.size > 0 && salesmen) {
        salesmen = salesmen.filter((s) => !driverAuthIds.has(String(s.id)))
      }
    } catch (e) {
      console.warn('[SALESMAN-DOWNLINE] driver filter skipped (auth lookup failed):', e instanceof Error ? e.message : e)
    }

    // Fetch parties scoped to this company — use * to avoid schema-cache column misses.
    // Chunked when scoped so large id sets don't overflow the .in() URL.
    const fetchScopedParties = async (
      sel: string,
    ): Promise<{ data: any[] | null; error: { code?: string; message?: string } | null }> => {
      if (allowedPartyIds) {
        const res = await fetchAllInChunks<any>(allowedPartyIds, (chunk) =>
          supabaseAdmin.from('parties').select(sel).neq('status', 'DELETED').in('id', chunk),
        )
        if (res.data) res.data.sort((a, b) => String(a?.name ?? '').localeCompare(String(b?.name ?? '')))
        return res
      }
      return (await supabaseAdmin
        .from('parties')
        .select(sel)
        .neq('status', 'DELETED')
        .order('name')) as { data: any[] | null; error: { code?: string; message?: string } | null }
    }

    let { data: allParties, error: partiesError } = await fetchScopedParties('*, party_types(name)')

    // Fallback: drop the relation join if it caused an error
    if (partiesError) {
      console.warn('[SALESMAN-DOWNLINE] parties with relation failed, retrying without join:', partiesError.code, partiesError.message)
      const fallback = await fetchScopedParties('*')
      allParties = fallback.data
    }

    // Fetch all party_salesman assignments — query by salesman IDs so we never miss
    // assignments even when allParties is empty due to scope/cache issues
    const salesmanIds = ((salesmen || []) as unknown as { id: string }[]).map((sm) => sm.id)
    let partySalesmanRows: { party_id: string; salesman_id: string }[] = []
    if (salesmanIds.length > 0) {
      const { data: ps, error: psError } = await fetchAllInChunks<{ party_id: string; salesman_id: string }>(
        salesmanIds,
        (chunk) => supabaseAdmin.from('party_salesman').select('party_id, salesman_id').in('salesman_id', chunk),
      )
      if (psError) console.warn('[SALESMAN-DOWNLINE] party_salesman query error:', psError.message)
      partySalesmanRows = ps ?? []
    }

    // Group assignments: parties in a group assigned to a salesman are part of that
    // salesman's downline (additive to direct party_salesman rows). Merge them into
    // partySalesmanRows so the tree + maps reflect the group, and return group
    // metadata so the UI can show and reassign groups.
    type GroupInfo = { id: string; name: string; salesman_id: string | null; party_ids: string[] }
    let groupsForSalesmen: GroupInfo[] = []
    if (salesmanIds.length > 0) {
      const salesmanIdSet = new Set(salesmanIds)
      let groupsTableFailed = false
      try {
        await ensureGroupsSchema()
        const { data: groupRows, error: groupErr } = await supabaseAdmin
          .from('groups')
          .select('id, name, salesman_id')
          .in('salesman_id', salesmanIds)
          .neq('status', 'DELETED')
        if (groupErr) throw groupErr
        const grows = (groupRows || []) as { id: string; name: string; salesman_id: string | null }[]
        if (grows.length > 0) {
          // Paged: an unranged scan caps at PostgREST's 1000-row max-rows limit and
          // silently empties the party_ids of whichever groups lose the race.
          const { data: memberRows } = await fetchAllInChunksPaged<{ group_id: string; party_id: string }>(
            grows.map((g) => g.id),
            (chunk, from, to) =>
              supabaseAdmin
                .from('group_members')
                .select('group_id, party_id')
                .in('group_id', chunk)
                .order('id')
                .range(from, to),
          )
          const membersByGroup: Record<string, string[]> = {}
          for (const m of (memberRows || [])) (membersByGroup[m.group_id] ||= []).push(m.party_id)
          groupsForSalesmen = grows.map((g) => ({
            id: g.id, name: g.name, salesman_id: g.salesman_id, party_ids: membersByGroup[g.id] || [],
          }))
        }
      } catch (e) {
        groupsTableFailed = true
        console.warn('[SALESMAN-DOWNLINE] groups table read failed, will try fallback:', e instanceof Error ? e.message : e)
      }

      // Groups created through /api/v1/groups land in the company_notes fallback store
      // when the real groups table isn't queryable (e.g. no SUPABASE_DB_URL / schema not
      // in the PostgREST cache). The Groups page reads that store, so the Downline page
      // must too — otherwise assigned groups never surface here. Consult it whenever the
      // real table failed or returned nothing, and merge (dedup by id, scoped to these
      // salesmen so it stays company-safe).
      if (groupsTableFailed || groupsForSalesmen.length === 0) {
        try {
          const haveIds = new Set(groupsForSalesmen.map((g) => g.id))
          const fb = await listFallbackGroups(companyPartyId)
          for (const g of fb) {
            if (haveIds.has(g.id)) continue
            if (!g.salesman_id || !salesmanIdSet.has(g.salesman_id)) continue
            groupsForSalesmen.push({ id: g.id, name: g.name, salesman_id: g.salesman_id, party_ids: g.member_ids })
          }
        } catch (e) {
          console.warn('[SALESMAN-DOWNLINE] groups fallback read skipped:', e instanceof Error ? e.message : e)
        }
      }

      // Fold every group's members (real + fallback) into the salesman's downline scope.
      for (const g of groupsForSalesmen) {
        if (!g.salesman_id) continue
        for (const pid of g.party_ids) partySalesmanRows.push({ party_id: pid, salesman_id: g.salesman_id })
      }
    }

    // De-duplicate (a party may be both directly assigned and group-assigned).
    {
      const seen = new Set<string>()
      partySalesmanRows = partySalesmanRows.filter((r) => {
        const key = `${r.party_id}|${r.salesman_id}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
    }

    // Fetch any assigned parties (direct or via groups) not already present in allParties.
    {
      const haveIds = new Set(((allParties ?? []) as { id: string }[]).map((p) => p.id))
      const missingIds = [...new Set(partySalesmanRows.map((r) => r.party_id))].filter((id) => !haveIds.has(id))
      if (missingIds.length > 0) {
        const { data: extra } = await fetchAllInChunks<any>(
          missingIds,
          (chunk) =>
            supabaseAdmin.from('parties').select('*, party_types(name)').neq('status', 'DELETED').in('id', chunk),
        )
        allParties = [...((allParties ?? []) as any[]), ...((extra as any[]) ?? [])]
      }
    }

    // Build a map: party_id → salesman_id[] and salesman_id → party_id[]
    const partyToSalesmen: Record<string, string[]> = {}
    const salesmanToParties: Record<string, string[]> = {}
    partySalesmanRows.forEach(({ party_id, salesman_id }) => {
      if (!partyToSalesmen[party_id]) partyToSalesmen[party_id] = []
      partyToSalesmen[party_id].push(salesman_id)
      if (!salesmanToParties[salesman_id]) salesmanToParties[salesman_id] = []
      salesmanToParties[salesman_id].push(party_id)
    })

    // Derive each party's true current balance (opening + payments − invoices);
    // there is no maintained wallet_balance column to read.
    const balanceMap = await computeCurrentBalances((allParties ?? []) as { id: string; opening_balance?: number | string | null }[])

    // Attach salesman_ids array to each party and normalise phone → contact_phone for frontend
    const partiesWithSalesmen = (allParties ?? []).map((p: any) => ({
      ...p,
      contact_phone: p.phone ?? null,
      salesman_ids: partyToSalesmen[p.id] ?? [],
      current_balance: balanceMap[p.id] ?? Number(p.opening_balance ?? 0),
    }))

    // Build partyById lookup for enriching salesman data
    const partyById: Record<string, typeof partiesWithSalesmen[number]> = {}
    partiesWithSalesmen.forEach((p) => { partyById[p.id] = p })

    // Enrich salesmen with assigned_party_id and parties object
    // The "assigned party" is the first party in their party_salesman assignments
    const enrichedSalesmen = ((salesmen || []) as unknown as { id: string; party_id: string | null }[]).map((sm) => {
      const assignedPartyIds = salesmanToParties[sm.id] ?? []
      const assignedPartyId = assignedPartyIds[0] ?? null
      const assignedParty = assignedPartyId ? partyById[assignedPartyId] ?? null : null
      return {
        ...sm,
        assigned_party_id: assignedPartyId,
        parties: assignedParty,
      }
    })

    return NextResponse.json({
      success: true,
      data: {
        salesmen: enrichedSalesmen,
        allParties: partiesWithSalesmen,
        salesmanToParties,
        groups: groupsForSalesmen,
        isScopedToSelf: caller?.role === 'SALESMAN',
      },
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : typeof err === 'object' ? JSON.stringify(err) : String(err)
    console.error('[SALESMAN-DOWNLINE GET]', msg)
    return NextResponse.json({ success: false, message: msg }, { status: 500 })
  }
}

// PATCH — two modes:
//   1. { user_id, assigned_party_id }      → set salesman's root CNF assignment
//   2. { user_id, party_ids: string[] }    → sync party_salesman rows for this salesman
export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json()
    const { user_id } = body
    if (!user_id) return NextResponse.json({ success: false, message: 'user_id required' }, { status: 400 })

    // Mode 2: sync party assignments via junction table
    if (Array.isArray(body.party_ids)) {
      const { party_ids } = body as { user_id: string; party_ids: string[] }

      // Delete rows no longer in the list
      const { error: delErr } = await supabaseAdmin
        .from('party_salesman')
        .delete()
        .eq('salesman_id', user_id)
        .not('party_id', 'in', party_ids.length > 0 ? `(${party_ids.map(id => `"${id}"`).join(',')})` : '("__none__")')

      if (delErr) throw delErr

      // Upsert new rows
      if (party_ids.length > 0) {
        const rows = party_ids.map(pid => ({ party_id: pid, salesman_id: user_id }))
        const { error: upsertErr } = await supabaseAdmin
          .from('party_salesman')
          .upsert(rows, { onConflict: 'party_id,salesman_id' })
        if (upsertErr) throw upsertErr
      }

      return NextResponse.json({ success: true })
    }

    // Mode 1: set assigned_party_id (root CNF) — no exclusivity check, multiple allowed
    const { assigned_party_id } = body
    const patchTableProbe = await supabaseAdmin.from('users').select('id').limit(0)
    const patchTable = (patchTableProbe.error?.code === 'PGRST205' || (patchTableProbe.error?.message || '').includes('Could not find the table'))
      ? 'app_users' : 'users'
    const { error } = await supabaseAdmin
      .from(patchTable as 'users')
      .update({ assigned_party_id: assigned_party_id || null })
      .eq('id', user_id)

    if (error) throw error

    return NextResponse.json({ success: true })
  } catch (err) {
    return NextResponse.json({ success: false, message: err instanceof Error ? err.message : 'Failed' }, { status: 500 })
  }
}
