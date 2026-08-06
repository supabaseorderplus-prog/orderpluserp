import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, getUserFromToken, resolveCompanyScope } from '@/lib/supabase-server'
import { computeSchemeRoster, type SchemeForRoster } from '@/lib/scheme-roster'
import { saveSchemeAdjustment } from '@/lib/scheme-adjust-fallback'

const ADMIN_ROLES = new Set(['SUPER_ADMIN', 'ADMIN'])

async function loadScopedScheme(req: NextRequest, id: string) {
  const authUser = await getUserFromToken(req)
  const companyId = await resolveCompanyScope(req, authUser)
  const isAdmin = authUser?.role ? ADMIN_ROLES.has(authUser.role) : false

  if (!companyId && authUser?.role !== 'SUPER_ADMIN') {
    return { authUser, companyId, isAdmin, scheme: null as SchemeForRoster | null, denied: false }
  }

  const { data: scheme } = await supabaseAdmin
    .from('schemes')
    .select('id, scheme_type, applicable_party_type, terms_conditions, target_value, start_date, end_date, company_id')
    .eq('id', id)
    .maybeSingle()

  if (!scheme) return { authUser, companyId, isAdmin, scheme: null, denied: false }
  // Company isolation — a scoped admin can only touch their own schemes.
  if (companyId && scheme.company_id && scheme.company_id !== companyId) {
    return { authUser, companyId, isAdmin, scheme: null, denied: true }
  }
  return { authUser, companyId, isAdmin, scheme: scheme as SchemeForRoster, denied: false }
}

// GET /api/v1/schemes/[id]/progress
// Returns the scheme's FULL audience roster — every party/salesman the scheme
// targets — with each member's live progress (auto value + any manual override).
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const { scheme, denied, companyId } = await loadScopedScheme(req, id)

    if (denied) return NextResponse.json({ success: false, message: 'Scheme not found' }, { status: 404 })
    if (!scheme) return NextResponse.json({ success: true, data: [] })

    const roster = await computeSchemeRoster(scheme, companyId)

    // Shape each member as a legacy scheme_progress row so the existing UI keeps
    // working, while carrying the richer detail + manual-override fields.
    const data = roster.map((m) => ({
      id: `${id}:${m.party_id}`,
      scheme_id: id,
      party_id: m.party_id,
      auto_value: m.auto_value,
      manual_adjustment: m.manual_adjustment,
      current_value: m.current_value,
      target_value: m.target_value,
      progress_percent: m.progress_percent,
      current_slab: 0,
      is_eligible: true,
      is_achieved: m.is_achieved,
      parties: {
        name: m.name,
        party_code: m.party_code,
        party_types: m.party_type ? { name: m.party_type } : null,
      },
      is_salesman: m.is_salesman,
    }))

    return NextResponse.json({ success: true, data })
  } catch (err) {
    console.error('[progress GET] caught:', err)
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed to fetch progress' },
      { status: 500 }
    )
  }
}

// PATCH /api/v1/schemes/[id]/progress
// Manually override one party's progress for this scheme. Accepts either an
// absolute value or a target percent; stored as an additive offset over the
// auto-computed value so the bar continues to move with the scheme's metric.
// Body: { party_id, progress_percent?: number, current_value?: number }
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const body = await req.json().catch(() => ({})) as {
      party_id?: string
      progress_percent?: number | string
      current_value?: number | string
    }

    const partyId = String(body.party_id || '').trim()
    if (!partyId) {
      return NextResponse.json({ success: false, message: 'party_id required' }, { status: 400 })
    }

    const { authUser, companyId, isAdmin, scheme, denied } = await loadScopedScheme(req, id)
    if (denied || !scheme) {
      return NextResponse.json({ success: false, message: 'Scheme not found' }, { status: 404 })
    }
    if (!isAdmin) {
      return NextResponse.json({ success: false, message: 'Only admins can edit scheme progress' }, { status: 403 })
    }

    const target = Number(scheme.target_value) || 0

    // Resolve the desired absolute value from either input.
    let desiredValue: number
    if (body.current_value !== undefined && body.current_value !== null && body.current_value !== '') {
      desiredValue = Number(body.current_value)
    } else if (body.progress_percent !== undefined && body.progress_percent !== null && body.progress_percent !== '') {
      desiredValue = (Number(body.progress_percent) / 100) * target
    } else {
      return NextResponse.json({ success: false, message: 'progress_percent or current_value required' }, { status: 400 })
    }
    if (!Number.isFinite(desiredValue) || desiredValue < 0) {
      return NextResponse.json({ success: false, message: 'Invalid value' }, { status: 400 })
    }

    // Compute this member's CURRENT auto value (sans any prior override) so the
    // stored offset lands the displayed value exactly on the desired number.
    const roster = await computeSchemeRoster(scheme, companyId)
    const member = roster.find((r) => r.party_id === partyId)
    if (!member) {
      return NextResponse.json({ success: false, message: 'Party is not part of this scheme' }, { status: 404 })
    }

    const offset = desiredValue - member.auto_value

    const saved = await saveSchemeAdjustment({
      schemeId: id,
      partyId,
      offset,
      createdBy: authUser?.app_user_id || authUser?.id || null,
      companyId: scheme.company_id ?? companyId ?? null,
    })
    if (!saved) {
      return NextResponse.json({ success: false, message: 'Failed to save adjustment' }, { status: 500 })
    }

    const denom = target || 1
    const current = Math.max(0, desiredValue)
    return NextResponse.json({
      success: true,
      data: {
        party_id: partyId,
        auto_value: member.auto_value,
        manual_adjustment: offset,
        current_value: current,
        target_value: target,
        progress_percent: Math.min(100, (current / denom) * 100),
        is_achieved: target > 0 && current >= target,
      },
    })
  } catch (err) {
    console.error('[progress PATCH] caught:', err)
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed to update progress' },
      { status: 500 }
    )
  }
}
