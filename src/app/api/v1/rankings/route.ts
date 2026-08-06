import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, getUserFromToken, resolveCompanyScope } from '@/lib/supabase-server'
import { resolveSchemeCompanyId } from '@/lib/scheme-progress'
import { computeRanking, type BoardKind } from '@/lib/services/ranking-engine'

const ADMIN_ROLES = ['ADMIN', 'SUPER_ADMIN']

/** Resolve the root company party id for the caller, regardless of role depth. */
async function resolveRoot(
  role: string,
  partyId: string | null,
  scope: string | null,
): Promise<string | null> {
  if (role === 'SUPER_ADMIN') return scope
  if (!partyId) return scope
  // ADMIN's party_id is already the company root (walk-up returns itself);
  // party/salesman leaves walk up to the company root.
  return resolveSchemeCompanyId(partyId, scope)
}

/** Look up a party's type name. */
async function partyTypeName(partyId: string | null): Promise<string | null> {
  if (!partyId) return null
  const { data } = await supabaseAdmin
    .from('parties')
    .select('party_types(name)')
    .eq('id', partyId)
    .maybeSingle()
  const raw = data?.party_types as unknown
  if (Array.isArray(raw)) return (raw[0] as { name?: string } | undefined)?.name ?? null
  return (raw as { name?: string } | null)?.name ?? null
}

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url)
    const requestedBoard = (url.searchParams.get('board') as BoardKind) || 'party'
    const requestedCategory = url.searchParams.get('category')

    const authUser = await getUserFromToken(req)
    if (!authUser) {
      return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 })
    }

    const scope = await resolveCompanyScope(req, authUser)
    const rootId = await resolveRoot(authUser.role, authUser.party_id, scope)

    // Fail-closed: no company scope = no data.
    if (!rootId) {
      return NextResponse.json({ success: true, data: null })
    }

    const isAdminView = ADMIN_ROLES.includes(authUser.role)
    const selfBoard: BoardKind = authUser.role === 'SALESMAN' ? 'salesman' : 'party'

    // The caller's own category drives the party self-view.
    const selfCategory =
      !isAdminView && selfBoard === 'party'
        ? await partyTypeName(authUser.party_id)
        : null

    // Highlight id: salesman entries key on app_user_id (payments.created_by);
    // party entries key on party_id.
    const selfId =
      selfBoard === 'salesman'
        ? authUser.app_user_id || authUser.id
        : authUser.party_id

    const board = await computeRanking({
      rootId,
      isAdminView,
      selfBoard,
      selfCategory,
      selfId,
      requestedBoard,
      requestedCategory,
    })

    return NextResponse.json({ success: true, data: board })
  } catch (err) {
    const message =
      err instanceof Error
        ? err.message
        : (err as { message?: string })?.message || 'Failed to fetch rankings'
    return NextResponse.json({ success: false, message }, { status: 500 })
  }
}
