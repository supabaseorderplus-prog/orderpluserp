import { NextRequest, NextResponse } from 'next/server'
import { getUserFromToken, resolveCompanyScope } from '@/lib/supabase-server'
import { getScopedPartyIdsForUser } from '@/lib/party-scope'
import { getApprovalSummaries } from '@/lib/order-approval-links'

// Widen the scoped party-tree ids to always include the resolved company scope
// itself, so a self-minted link (a salesman stores it under their own party id,
// which getSalesmanPartyIds may not list) is never missed. Returns null unchanged
// for an unscoped super-admin read.
function withCompanyScope(scoped: string[] | null, companyId: string | null): string[] | null {
  if (scoped === null) return null
  if (companyId && !scoped.includes(companyId)) return [...scoped, companyId]
  return scoped
}

// Bulk party-confirmation summary for the current company, keyed by order_id.
// Powers the dual-approval badges on the approved-orders list.
export async function GET(req: NextRequest) {
  try {
    const authUser = await getUserFromToken(req)
    if (!authUser) {
      return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 })
    }

    let companyId = await resolveCompanyScope(req, authUser)
    if (!companyId && authUser.role !== 'SUPER_ADMIN') companyId = authUser.party_id || null
    if (!companyId && authUser.role !== 'SUPER_ADMIN') {
      return NextResponse.json({ success: false, message: 'Company scope is required' }, { status: 403 })
    }

    const scopedIds = withCompanyScope(await getScopedPartyIdsForUser(authUser, companyId), companyId ?? null)
    const summaries = await getApprovalSummaries(scopedIds)
    return NextResponse.json({ success: true, data: summaries })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed to load approval statuses' },
      { status: 500 },
    )
  }
}
