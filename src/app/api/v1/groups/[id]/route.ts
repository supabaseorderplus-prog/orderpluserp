import { NextRequest, NextResponse } from 'next/server'
import {
  supabaseAdmin,
  getUserFromToken,
  resolveCompanyScope,
  getPartyDescendants,
} from '@/lib/supabase-server'
import { ensureGroupsSchema, hasGroupsSchema, isGroupsSchemaGap, partitionRequestedMembers } from '@/lib/groups'
import { chunkIds, fetchAllRows } from '@/lib/supabase-in-chunks'
import { deleteFallbackGroup, getFallbackGroup, hydrateFallbackGroupDetail, updateFallbackGroup, type GroupFallbackRecord } from '@/lib/groups-fallback'

async function getCompanyDescendantIds(companyId: string): Promise<string[]> {
  try {
    const tree = await getPartyDescendants(companyId)
    return [companyId, ...((tree || []) as { id: string }[]).map((t) => t.id)]
  } catch {
    return [companyId]
  }
}

async function loadAccessibleGroup(req: NextRequest, id: string) {
  const authUser = await getUserFromToken(req)
  if (!authUser) return { error: 'Unauthorized' as const, status: 401, group: null, companyId: null, authUser: null, fallback: false }

  const companyId = await resolveCompanyScope(req, authUser)

  if (!(await hasGroupsSchema())) {
    const group = await getFallbackGroup(id, companyId)
    if (!group || group.status === 'DELETED') return { error: 'Group not found', status: 404, group: null, companyId, authUser, fallback: true }
    if (authUser.role !== 'SUPER_ADMIN' && companyId && group.company_id && group.company_id !== companyId) {
      return { error: 'Access denied', status: 403, group: null, companyId, authUser, fallback: true }
    }
    return { error: null, status: 200, group, companyId, authUser, fallback: true }
  }

  const { data: group, error } = await supabaseAdmin
    .from('groups')
    .select('*')
    .eq('id', id)
    .maybeSingle()
  if (error) {
    if (isGroupsSchemaGap(error)) {
      const fallbackGroup = await getFallbackGroup(id, companyId)
      if (!fallbackGroup || fallbackGroup.status === 'DELETED') return { error: 'Group not found', status: 404, group: null, companyId, authUser, fallback: true }
      return { error: null, status: 200, group: fallbackGroup, companyId, authUser, fallback: true }
    }
    return { error: error.message, status: 500, group: null, companyId, authUser, fallback: false }
  }
  if (!group || group.status === 'DELETED') return { error: 'Group not found', status: 404, group: null, companyId, authUser, fallback: false }

  if (authUser.role !== 'SUPER_ADMIN' && companyId && group.company_id && group.company_id !== companyId) {
    return { error: 'Access denied', status: 403, group: null, companyId, authUser, fallback: false }
  }
  return { error: null, status: 200, group, companyId, authUser, fallback: false }
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    await ensureGroupsSchema()
    const { error, status, group, fallback } = await loadAccessibleGroup(req, id)
    if (error || !group) return NextResponse.json({ success: false, message: error }, { status })

    if (fallback) {
      const data = await hydrateFallbackGroupDetail(group as GroupFallbackRecord)
      return NextResponse.json({ success: true, data })
    }

    // Unranged, this silently stops at PostgREST's 1000-row max-rows cap and the
    // group detail drops every member past the first thousand. A read failure must
    // surface too: the members dialog seeds from this response and PATCHes it back,
    // so a silently-empty list would wipe the group on the next save.
    const { data: memberRows, error: memberErr } = await fetchAllRows<{ party_id: string }>((from, to) =>
      supabaseAdmin.from('group_members').select('party_id').eq('group_id', id).order('id').range(from, to),
    )
    if (memberErr) throw new Error(memberErr.message || 'Failed to load group members')
    const memberIds = (memberRows || []).map((m) => m.party_id)

    let members: Record<string, unknown>[] = []
    if (memberIds.length > 0) {
      const { fetchAllInChunks } = await import('@/lib/supabase-in-chunks')
      const { data, error: partyErr } = await fetchAllInChunks<Record<string, unknown>>(
        memberIds,
        (chunk) => supabaseAdmin.from('parties').select('id, name, party_code, parent_party_id, party_types(name)').in('id', chunk),
      )
      if (partyErr) throw new Error(partyErr.message || 'Failed to load group members')
      members = (data || []).sort((a, b) => String(a.name ?? '').localeCompare(String(b.name ?? '')))
    }

    let priceList: { id: string; name: string } | null = null
    try {
      const { data } = await supabaseAdmin
        .from('price_lists')
        .select('id, name')
        .eq('group_id', id)
        .neq('status', 'DELETED')
        .maybeSingle()
      priceList = (data as { id: string; name: string } | null) ?? null
    } catch {
      priceList = null
    }

    const { resolveUserDisplayMap } = await import('@/lib/supabase-server')
    const salesmanMap = group.salesman_id ? await resolveUserDisplayMap([group.salesman_id]) : {}

    return NextResponse.json({
      success: true,
      data: {
        ...group,
        members,
        salesman_name: group.salesman_id ? (salesmanMap[group.salesman_id]?.name ?? null) : null,
        price_list: priceList,
      },
    })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed to load group' },
      { status: 500 },
    )
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    await ensureGroupsSchema()
    const { error, status, group, companyId, fallback } = await loadAccessibleGroup(req, id)
    if (error || !group) return NextResponse.json({ success: false, message: error }, { status })

    const body = await req.json()

    if (fallback) {
      const scopeIds = companyId ? new Set(await getCompanyDescendantIds(companyId)) : null
      const requested = Array.isArray(body.party_ids) ? body.party_ids.map(String) : undefined
      let valid: string[] | undefined
      if (requested) {
        const existingIds = (group as GroupFallbackRecord).member_ids ?? []
        const partitioned = partitionRequestedMembers(requested, existingIds, scopeIds)
        if (partitioned.rejected.length > 0) {
          return NextResponse.json(
            {
              success: false,
              message: `${partitioned.rejected.length} selected part${partitioned.rejected.length === 1 ? 'y is' : 'ies are'} not in this company — members were not changed.`,
              rejected_party_ids: partitioned.rejected,
            },
            { status: 400 },
          )
        }
        valid = partitioned.valid
      }
      const updated = await updateFallbackGroup(id, companyId, {
        name: body.name !== undefined ? String(body.name).trim() : undefined,
        code: body.code !== undefined ? (body.code ? String(body.code).trim() : null) : undefined,
        salesman_id: body.salesman_id !== undefined ? (body.salesman_id || null) : undefined,
        notes: body.notes !== undefined ? (body.notes ? String(body.notes) : null) : undefined,
        status: body.status !== undefined ? String(body.status) : undefined,
        member_ids: valid,
        price_list_id: body.price_list_id !== undefined ? (body.price_list_id || null) : undefined,
      })
      if (!updated) {
        return NextResponse.json({ success: false, message: 'Group not found' }, { status: 404 })
      }
      return NextResponse.json({ success: true, data: updated, storage: 'company_notes_fallback' })
    }

    // Validate the member list before ANY write, so a rejected id can't leave the name
    // or price-list change committed against an unchanged membership.
    let validMembers: string[] | undefined
    if (Array.isArray(body.party_ids)) {
      const scopeIds = companyId ? new Set(await getCompanyDescendantIds(companyId)) : null
      const { data: existingRows } = await fetchAllRows<{ party_id: string }>((from, to) =>
        supabaseAdmin.from('group_members').select('party_id').eq('group_id', id).order('id').range(from, to),
      )
      const { valid, rejected } = partitionRequestedMembers(
        body.party_ids.map(String),
        (existingRows || []).map((r) => r.party_id),
        scopeIds,
      )
      if (rejected.length > 0) {
        return NextResponse.json(
          {
            success: false,
            message: `${rejected.length} selected part${rejected.length === 1 ? 'y is' : 'ies are'} not in this company — nothing was changed.`,
            rejected_party_ids: rejected,
          },
          { status: 400 },
        )
      }
      validMembers = valid
    }

    const update: Record<string, unknown> = {}
    if (body.name !== undefined) update.name = String(body.name).trim()
    if (body.code !== undefined) update.code = body.code ? String(body.code).trim() : null
    if (body.salesman_id !== undefined) update.salesman_id = body.salesman_id || null
    if (body.notes !== undefined) update.notes = body.notes ? String(body.notes) : null
    if (body.status !== undefined) update.status = String(body.status)
    if (Object.keys(update).length > 0) {
      update.updated_at = new Date().toISOString()
      const { error: updErr } = await supabaseAdmin.from('groups').update(update).eq('id', id)
      if (updErr) throw updErr
    }

    if (body.price_list_id !== undefined) {
      try {
        await supabaseAdmin.from('price_lists').update({ group_id: null }).eq('group_id', id)
        if (body.price_list_id) {
          await supabaseAdmin
            .from('price_lists')
            .update({ group_id: id, applicable_party_type: 'GROUP', party_id: null })
            .eq('id', String(body.price_list_id))
        }
      } catch {
      }
    }

    if (validMembers) {
      await supabaseAdmin.from('group_members').delete().eq('group_id', id)
      for (const chunk of chunkIds(validMembers)) {
        await supabaseAdmin.from('group_members').delete().in('party_id', chunk)
      }
      if (validMembers.length > 0) {
        await supabaseAdmin.from('group_members').insert(validMembers.map((pid) => ({ group_id: id, party_id: pid })))
      }
    }

    const { data: updated } = await supabaseAdmin.from('groups').select('*').eq('id', id).maybeSingle()
    return NextResponse.json({ success: true, data: updated ?? group })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed to update group' },
      { status: 500 },
    )
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    await ensureGroupsSchema()
    const { error, status, group, companyId, fallback } = await loadAccessibleGroup(req, id)
    if (error || !group) return NextResponse.json({ success: false, message: error }, { status })

    if (fallback) {
      await deleteFallbackGroup(id, companyId)
      return NextResponse.json({ success: true, storage: 'company_notes_fallback' })
    }

    try {
      await supabaseAdmin.from('price_lists').update({ group_id: null }).eq('group_id', id)
    } catch {
    }
    await supabaseAdmin.from('group_members').delete().eq('group_id', id)
    const { error: delErr } = await supabaseAdmin.from('groups').delete().eq('id', id)
    if (delErr) throw delErr

    return NextResponse.json({ success: true })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed to delete group' },
      { status: 500 },
    )
  }
}
