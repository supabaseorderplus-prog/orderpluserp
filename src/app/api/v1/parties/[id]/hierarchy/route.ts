import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, getUserFromToken, resolveCompanyScope, getPartyDescendants } from '@/lib/supabase-server'

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params

    const authUser = await getUserFromToken(req)
    const companyId = await resolveCompanyScope(req, authUser)

    // Get the party and its hierarchy
    const { data: party, error } = await supabaseAdmin
      .from('parties')
      .select('*, party_types(name, level_order)')
      .eq('id', id)
      .single()

    if (error) throw error

    // Verify company access
    if (companyId && party.id !== companyId) {
      const tree = await getPartyDescendants(companyId)
      const treeIds = tree && tree.length > 0 ? tree.map((r: { id: string }) => r.id) : []
      if (!treeIds.includes(companyId)) treeIds.push(companyId)

      if (!treeIds.includes(id)) {
        return NextResponse.json({ success: false, message: 'Party not found or access denied' }, { status: 403 })
      }
    }

    const tree: Record<string, unknown>[] = []
    const billingPath = party.billing_path || 'A'

    // Build hierarchy tree upward (to parent) and downward (to children)
    // Upward: follow parent_party_id
    let currentId: string | null = party.parent_party_id
    const ancestors: Record<string, unknown>[] = []
    while (currentId) {
      const { data: parent } = await supabaseAdmin
        .from('parties')
        .select('id, name, party_code, party_type_id, parent_party_id, party_types(name, level_order)')
        .eq('id', currentId)
        .single()
      if (!parent) break
      ancestors.unshift(parent)
      currentId = parent.parent_party_id
    }

    // Downward: find children
    let childrenQuery = supabaseAdmin
      .from('parties')
      .select('id, name, party_code, party_type_id, party_types(name, level_order)')
      .eq('parent_party_id', id)
      .eq('status', 'ACTIVE')
      .eq('is_verified', true)
      .order('name')

    // Children are inherently in the company if the parent is.

    const { data: children } = await childrenQuery

    return NextResponse.json({
      success: true,
      data: {
        party: { id: party.id, name: party.name, party_code: party.party_code, type: party.party_types?.name },
        billing_path: billingPath,
        ancestors,
        children: children || [],
        hierarchy_levels: [...ancestors, {
          id: party.id, name: party.name, party_code: party.party_code,
          type: party.party_types?.name, is_current: true,
        }, ...(children || []).map(c => ({ ...c, type: (c as Record<string, unknown>).party_types }))],
      },
    })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed to fetch hierarchy' },
      { status: 500 }
    )
  }
}
