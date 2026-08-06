import { NextRequest, NextResponse } from 'next/server'
import {
  supabaseAdmin,
  getUserFromToken,
  resolveCompanyScope,
  resolveUserDisplayMap,
  getPartyDescendants,
} from '@/lib/supabase-server'
import { fetchAllInChunks, fetchAllInChunksPaged, chunkIds } from '@/lib/supabase-in-chunks'
import { ensureGroupsSchema, hasGroupsSchema, isGroupsSchemaGap, partitionRequestedMembers } from '@/lib/groups'
import { createFallbackGroup, listFallbackGroups } from '@/lib/groups-fallback'

type GroupRow = {
  id: string
  company_id: string | null
  name: string
  code: string | null
  salesman_id: string | null
  status: string
  notes: string | null
  created_at: string
  updated_at: string
}

async function getCompanyDescendantIds(companyId: string): Promise<string[]> {
  try {
    const tree = await getPartyDescendants(companyId)
    return [companyId, ...((tree || []) as { id: string }[]).map((t) => t.id)]
  } catch {
    return [companyId]
  }
}

// GET /api/v1/groups — list groups for the caller's company with member counts,
// assigned salesman, and linked price list.
export async function GET(req: NextRequest) {
  try {
    const authUser = await getUserFromToken(req)
    if (!authUser) {
      return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 })
    }
    await ensureGroupsSchema()

    const companyId = await resolveCompanyScope(req, authUser)
    if (!companyId && authUser.role !== 'SUPER_ADMIN') {
      return NextResponse.json({ success: true, data: [] })
    }

    // A salesman may only see the groups they are assigned to — never the whole
    // company's groups. salesman_id is a globally-unique user id, so we scope on it
    // directly rather than company_id (salesmen can share a party_id, which would
    // over- or under-filter the company scope). Fail-closed: no id → no groups.
    const salesmanScopeId = authUser.role === 'SALESMAN' ? authUser.id : null

    let q = supabaseAdmin
      .from('groups')
      .select('*')
      .neq('status', 'DELETED')
      .order('created_at', { ascending: false })
    if (salesmanScopeId) {
      q = q.eq('salesman_id', salesmanScopeId)
    } else if (companyId) {
      q = q.eq('company_id', companyId)
    }

    const { data: groups, error } = await q
    if (error) {
      if (isGroupsSchemaGap(error)) {
        const fallback = await listFallbackGroups(companyId)
        const scopedFallback = salesmanScopeId
          ? fallback.filter((g) => g.salesman_id === salesmanScopeId)
          : fallback
        return NextResponse.json({ success: true, data: scopedFallback })
      }
      throw error
    }

    const groupRows = (groups || []) as GroupRow[]
    const groupIds = groupRows.map((g) => g.id)

    const memberCount: Record<string, number> = {}
    const memberIdsByGroup: Record<string, string[]> = {}
    if (groupIds.length > 0) {
      // A company's total membership routinely exceeds PostgREST's 1000-row max-rows
      // cap, and an unranged scan truncates arbitrarily — the groups that lose their
      // rows report a member_count of 0. Page every chunk so counts stay exact.
      const { data: members } = await fetchAllInChunksPaged<{ group_id: string; party_id: string }>(
        groupIds,
        (chunk, from, to) =>
          supabaseAdmin
            .from('group_members')
            .select('group_id, party_id')
            .in('group_id', chunk)
            .order('id')
            .range(from, to),
      )
      for (const m of members || []) {
        memberCount[m.group_id] = (memberCount[m.group_id] || 0) + 1
        ;(memberIdsByGroup[m.group_id] ||= []).push(m.party_id)
      }
    }

    const salesmanIds = [...new Set(groupRows.map((g) => g.salesman_id).filter(Boolean) as string[])]
    const salesmanMap = salesmanIds.length ? await resolveUserDisplayMap(salesmanIds) : {}

    const priceListByGroup: Record<string, { id: string; name: string }> = {}
    if (groupIds.length > 0) {
      const { data: pls, error: plErr } = await fetchAllInChunks<{ id: string; name: string; group_id: string }>(
        groupIds,
        (chunk) => supabaseAdmin.from('price_lists').select('id, name, group_id').in('group_id', chunk).neq('status', 'DELETED'),
      )
      if (!plErr) {
        for (const pl of pls || []) {
          if (pl.group_id && !priceListByGroup[pl.group_id]) priceListByGroup[pl.group_id] = { id: pl.id, name: pl.name }
        }
      }
    }

    const data = groupRows.map((g) => ({
      ...g,
      member_count: memberCount[g.id] || 0,
      member_ids: memberIdsByGroup[g.id] || [],
      salesman_name: g.salesman_id ? (salesmanMap[g.salesman_id]?.name ?? null) : null,
      price_list: priceListByGroup[g.id] ?? null,
    }))

    return NextResponse.json({ success: true, data })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed to list groups' },
      { status: 500 },
    )
  }
}

// POST /api/v1/groups — create a group, optionally with a salesman and members.
export async function POST(req: NextRequest) {
  try {
    const authUser = await getUserFromToken(req)
    if (!authUser) {
      return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 })
    }

    await ensureGroupsSchema()

    const companyId = await resolveCompanyScope(req, authUser)
    if (!companyId && authUser.role !== 'SUPER_ADMIN') {
      return NextResponse.json({ success: false, message: 'Select a company before creating a group' }, { status: 403 })
    }

    const body = await req.json()
    const name = String(body.name || '').trim()
    if (!name) {
      return NextResponse.json({ success: false, message: 'Group name is required' }, { status: 400 })
    }

    const salesmanId = body.salesman_id ? String(body.salesman_id) : null
    const requestedPartyIds: string[] = Array.isArray(body.party_ids) ? body.party_ids.map(String) : []
    const scopeIds = companyId ? new Set(await getCompanyDescendantIds(companyId)) : null
    const { valid: validPartyIds, rejected } = partitionRequestedMembers(requestedPartyIds, [], scopeIds)
    if (rejected.length > 0) {
      return NextResponse.json(
        {
          success: false,
          message: `${rejected.length} selected part${rejected.length === 1 ? 'y is' : 'ies are'} not in this company — the group was not created.`,
          rejected_party_ids: rejected,
        },
        { status: 400 },
      )
    }

    if (!(await hasGroupsSchema())) {
      let code = body.code ? String(body.code).trim() : ''
      if (!code) {
        const existing = await listFallbackGroups(companyId)
        code = `GRP-${String(existing.length + 1).padStart(4, '0')}`
      }
      const group = await createFallbackGroup({
        companyId,
        name,
        code,
        salesman_id: salesmanId,
        notes: body.notes ? String(body.notes) : null,
        party_ids: validPartyIds,
      })
      return NextResponse.json({ success: true, data: group, storage: 'company_notes_fallback' }, { status: 201 })
    }

    let code = body.code ? String(body.code).trim() : ''
    if (!code) {
      let countQuery = supabaseAdmin.from('groups').select('*', { count: 'exact', head: true })
      if (companyId) countQuery = countQuery.eq('company_id', companyId)
      const { count, error: countError } = await countQuery
      if (countError) throw countError
      code = `GRP-${String((count || 0) + 1).padStart(4, '0')}`
    }

    const insertPayload = {
      company_id: companyId,
      name,
      code,
      salesman_id: salesmanId,
      notes: body.notes ? String(body.notes) : null,
      status: 'ACTIVE',
    }
    const { data: group, error } = await supabaseAdmin.from('groups').insert(insertPayload).select().single()
    if (error) throw error

    if (validPartyIds.length > 0) {
      for (const chunk of chunkIds(validPartyIds)) {
        const { error: clearError } = await supabaseAdmin.from('group_members').delete().in('party_id', chunk)
        if (clearError) throw clearError
      }
      const rows = validPartyIds.map((pid) => ({ group_id: group.id, party_id: pid }))
      const { error: memberInsertError } = await supabaseAdmin.from('group_members').insert(rows)
      if (memberInsertError) throw memberInsertError
    }

    return NextResponse.json({ success: true, data: group }, { status: 201 })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed to create group' },
      { status: 500 },
    )
  }
}
