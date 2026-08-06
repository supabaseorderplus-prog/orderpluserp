import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, getUserFromToken, resolveCompanyScope, getPartyDescendants } from '@/lib/supabase-server'

type PartyScopeRow = {
  id: string
  parent_party_id: string | null
  party_code: string | null
}

type SupabaseErrorLike = {
  code?: string
  message?: string
  details?: string
}

function errorText(error: SupabaseErrorLike | null | undefined): string {
  return `${error?.code || ''} ${error?.message || ''} ${error?.details || ''}`.toLowerCase()
}

function isMissingColumn(error: SupabaseErrorLike | null | undefined, column: string): boolean {
  const text = errorText(error)
  return text.includes(column.toLowerCase()) && (
    text.includes('could not find') ||
    text.includes('schema cache') ||
    text.includes('does not exist')
  )
}

async function partyBelongsToCompany(party: PartyScopeRow, companyId: string): Promise<boolean> {
  if (party.id === companyId) return true

  try {
    const tree = await getPartyDescendants(companyId)
    const treeIds = tree && tree.length > 0 ? tree.map((r: { id: string }) => r.id) : []
    if (treeIds.includes(party.id)) return true
  } catch (e) {
    console.warn('[PARTIES VERIFY] get_party_descendants failed, using fallback scope check', e)
  }

  let currentParentId = party.parent_party_id
  const seen = new Set<string>()
  while (currentParentId && !seen.has(currentParentId)) {
    if (currentParentId === companyId) return true
    seen.add(currentParentId)

    const { data: parent } = await supabaseAdmin
      .from('parties')
      .select('id, parent_party_id')
      .eq('id', currentParentId)
      .maybeSingle()

    currentParentId = parent?.parent_party_id || null
  }

  const { data: company } = await supabaseAdmin
    .from('parties')
    .select('party_code')
    .eq('id', companyId)
    .maybeSingle()

  const companyCode = (company?.party_code || '').trim().toUpperCase()
  const partyCode = (party.party_code || '').trim().toUpperCase()
  return !!companyCode && partyCode.startsWith(companyCode)
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const authUser = await getUserFromToken(req)

    if (!authUser) {
      return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 })
    }

    // Only ADMIN, SUPER_ADMIN, or users with edit permission can verify
    if (!['SUPER_ADMIN', 'ADMIN'].includes(authUser.role)) {
      return NextResponse.json({ success: false, message: 'Only admins can verify parties' }, { status: 403 })
    }

    const companyId = await resolveCompanyScope(req, authUser)

    if (companyId) {
      const { data: existingParty } = await supabaseAdmin
        .from('parties')
        .select('id, parent_party_id, party_code')
        .eq('id', id)
        .maybeSingle()

      if (!existingParty) {
        return NextResponse.json({ success: false, message: 'Party not found' }, { status: 404 })
      }

      const hasAccess = await partyBelongsToCompany(existingParty as PartyScopeRow, companyId)
      if (!hasAccess) {
        return NextResponse.json({ success: false, message: 'Access denied' }, { status: 403 })
      }
    }

    const [isVerifiedProbe, verifiedByProbe, verifiedAtProbe, gstinVerifiedProbe, gstinVerifiedAtProbe] = await Promise.all([
      supabaseAdmin.from('parties').select('is_verified').limit(0),
      supabaseAdmin.from('parties').select('verified_by').limit(0),
      supabaseAdmin.from('parties').select('verified_at').limit(0),
      supabaseAdmin.from('parties').select('gstin_verified').limit(0),
      supabaseAdmin.from('parties').select('gstin_verified_at').limit(0),
    ])

    const verificationColumn = isVerifiedProbe.error ? 'gstin_verified' : 'is_verified'
    const verifiedAtColumn = isVerifiedProbe.error ? 'gstin_verified_at' : 'verified_at'

    if (isVerifiedProbe.error && gstinVerifiedProbe.error) {
      return NextResponse.json(
        { success: false, message: 'Party verification columns are not set up yet' },
        { status: 400 }
      )
    }

    // Mark as verified
    const updatePayload: Record<string, unknown> = { [verificationColumn]: true }
    if (!verifiedByProbe.error) updatePayload.verified_by = authUser.app_user_id || authUser.id
    if (verifiedAtColumn === 'verified_at' && !verifiedAtProbe.error) updatePayload.verified_at = new Date().toISOString()
    if (verifiedAtColumn === 'gstin_verified_at' && !gstinVerifiedAtProbe.error) updatePayload.gstin_verified_at = new Date().toISOString()

    let { data, error } = await supabaseAdmin
      .from('parties')
      .update(updatePayload)
      .eq('id', id)
      .select(isVerifiedProbe.error ? 'id, name, gstin_verified, gstin_verified_at' : 'id, name, is_verified, verified_at, verified_by')
      .single()

    if (error && (isMissingColumn(error, 'verified_by') || isMissingColumn(error, 'verified_at') || error.code === '23503')) {
      const retryPayload: Record<string, unknown> = { [verificationColumn]: true }
      if (verifiedAtColumn === 'verified_at' && !verifiedAtProbe.error && !isMissingColumn(error, 'verified_at')) retryPayload.verified_at = new Date().toISOString()
      if (verifiedAtColumn === 'gstin_verified_at' && !gstinVerifiedAtProbe.error) retryPayload.gstin_verified_at = new Date().toISOString()

      const retry = await supabaseAdmin
        .from('parties')
        .update(retryPayload)
        .eq('id', id)
        .select(isVerifiedProbe.error ? 'id, name, gstin_verified, gstin_verified_at' : 'id, name, is_verified, verified_at')
        .single()

      data = retry.data as typeof data
      error = retry.error
    }

    if (error && (isMissingColumn(error, 'verified_by') || isMissingColumn(error, 'verified_at'))) {
      const retry = await supabaseAdmin
        .from('parties')
        .update({ [verificationColumn]: true })
        .eq('id', id)
        .select(isVerifiedProbe.error ? 'id, name, gstin_verified' : 'id, name, is_verified')
        .single()

      data = retry.data as typeof data
      error = retry.error
    }

    if (error) {
      console.error('[PARTIES VERIFY] Error:', error)
      throw error
    }

    const normalizedData = data && isVerifiedProbe.error
      ? {
          ...data,
          is_verified: (data as { gstin_verified?: boolean | null }).gstin_verified === true,
          verified_at: (data as { gstin_verified_at?: string | null }).gstin_verified_at || null,
          verified_by: null,
        }
      : data

    return NextResponse.json({ success: true, data: normalizedData })
  } catch (err: unknown) {
    console.error('[PARTIES VERIFY] Route Catch Error:', err)
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed to verify party' },
      { status: 500 }
    )
  }
}
