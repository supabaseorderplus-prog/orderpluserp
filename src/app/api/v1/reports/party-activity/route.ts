import { NextRequest, NextResponse } from 'next/server'
import { getUserFromToken, resolveCompanyScope } from '@/lib/supabase-server'
import { getScopedPartyIdsForUser } from '@/lib/party-scope'
import { computePartyActivity } from '@/lib/services/party-activity'

/**
 * GET /api/v1/reports/party-activity
 *
 * Returns the per-party activity analysis (order + payment behaviour over a rolling
 * 28-day window) plus roster-level summary KPIs. Scoped exactly like the parties
 * list: SUPER_ADMIN uses the x-company-id header, ADMIN auto-scopes to its company
 * tree, SALESMAN to their downline. Fail-closed — no resolvable company scope
 * returns an empty report rather than leaking cross-company data.
 */
export async function GET(req: NextRequest) {
  try {
    const authUser = await getUserFromToken(req)
    if (!authUser) {
      return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 })
    }

    const companyId = await resolveCompanyScope(req, authUser)
    const partyIds = await getScopedPartyIdsForUser(authUser, companyId)

    // null scope = SUPER_ADMIN with no company selected → fail closed (empty).
    const report = await computePartyActivity(partyIds ?? [])

    return NextResponse.json({ success: true, data: report })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to build party activity report'
    console.error('[REPORTS party-activity] error:', err)
    return NextResponse.json({ success: false, message }, { status: 500 })
  }
}
