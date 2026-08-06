import { NextRequest, NextResponse } from 'next/server'
import { getUserFromToken, resolveCompanyScope } from '@/lib/supabase-server'
import {
  isInvoiceApprovalRequiredForParty,
  setInvoiceApprovalRequiredForParty,
  getPartiesWithApprovalDisabled,
} from '@/lib/invoice-approval-setting'

const ADMIN_ROLES = ['SUPER_ADMIN', 'ADMIN']

function isAdmin(role: string | null | undefined): boolean {
  return ADMIN_ROLES.includes(String(role || '').toUpperCase())
}

// GET — per-party kill-switch state.
//   ?party_id=<id>  → { approval_required } for that one party
//   (no param)      → { disabled_party_ids } for the caller's company
export async function GET(req: NextRequest) {
  try {
    const authUser = await getUserFromToken(req)
    const companyId = await resolveCompanyScope(req, authUser)
    const partyId = new URL(req.url).searchParams.get('party_id')

    if (partyId) {
      const approvalRequired = await isInvoiceApprovalRequiredForParty(partyId)
      return NextResponse.json({ success: true, data: { approval_required: approvalRequired } })
    }

    const disabledPartyIds = await getPartiesWithApprovalDisabled(companyId)
    return NextResponse.json({ success: true, data: { disabled_party_ids: disabledPartyIds } })
  } catch (err) {
    console.error('[settings/invoice-approval][GET] failed:', err)
    // Fail safe — report nothing disabled / approval required.
    return NextResponse.json({ success: true, data: { disabled_party_ids: [], approval_required: true } })
  }
}

// PUT — flip the kill switch for one party. Admins only.
export async function PUT(req: NextRequest) {
  try {
    const authUser = await getUserFromToken(req)
    if (!authUser || !isAdmin(authUser.role)) {
      return NextResponse.json(
        { success: false, message: 'Only admins can change invoice approval settings.' },
        { status: 403 },
      )
    }

    const body = await req.json().catch(() => ({}))
    const partyId = body?.party_id
    const approvalRequired = body?.approval_required
    if (typeof partyId !== 'string' || !partyId) {
      return NextResponse.json({ success: false, message: 'party_id is required.' }, { status: 400 })
    }
    if (typeof approvalRequired !== 'boolean') {
      return NextResponse.json(
        { success: false, message: 'approval_required (boolean) is required.' },
        { status: 400 },
      )
    }

    const companyId = await resolveCompanyScope(req, authUser)
    const actorId = authUser.app_user_id || authUser.id || null

    await setInvoiceApprovalRequiredForParty(partyId, approvalRequired, companyId, actorId)

    return NextResponse.json({
      success: true,
      data: { party_id: partyId, approval_required: approvalRequired },
      message: approvalRequired
        ? 'Approval required — this party must confirm before invoices generate.'
        : 'Approval disabled — invoices for this party generate instantly.',
    })
  } catch (err) {
    console.error('[settings/invoice-approval][PUT] failed:', err)
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed to update setting.' },
      { status: 500 },
    )
  }
}
