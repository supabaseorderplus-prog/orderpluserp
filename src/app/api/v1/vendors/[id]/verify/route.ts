import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, getUserFromToken, resolveCompanyScope } from '@/lib/supabase-server'
import { ensureVendorsSchema, getFallbackVendorById, isMissingColumnError, isMissingTableError, updateFallbackVendor } from '@/lib/vendors'

export const dynamic = 'force-dynamic'

async function resolveScope(req: NextRequest): Promise<{ authUser: Awaited<ReturnType<typeof getUserFromToken>>; companyId: string | null }> {
  const authUser = await getUserFromToken(req)
  let companyId = await resolveCompanyScope(req, authUser)
  if (!companyId && authUser?.role === 'SALESMAN') {
    const salesmanUserId = authUser.app_user_id || authUser.id
    const { data: userRow } = await supabaseAdmin.from('users').select('party_id').eq('id', salesmanUserId).maybeSingle()
    if (userRow?.party_id) companyId = userRow.party_id as string
  }
  return { authUser, companyId }
}

// Mark a vendor verified / unverified. Admin-only, fail-closed on company scope.
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const { authUser, companyId } = await resolveScope(req)
    if (!authUser) return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 })
    if (!['SUPER_ADMIN', 'ADMIN'].includes(authUser.role)) {
      return NextResponse.json({ success: false, message: 'Only admins can verify vendors' }, { status: 403 })
    }
    if (!companyId) return NextResponse.json({ success: false, message: 'Company not found' }, { status: 403 })

    // Optional body { verified: boolean } — defaults to verifying.
    let verified = true
    try {
      const body = await req.json()
      if (typeof body?.verified === 'boolean') verified = body.verified
    } catch { /* empty body — verify */ }

    // Confirm the vendor belongs to this company (fail-closed).
    const { data: existing, error: loadErr } = await supabaseAdmin
      .from('vendors')
      .select('id, company_id')
      .eq('id', id)
      .maybeSingle()
    if (loadErr && isMissingTableError(loadErr)) {
      const schemaReady = await ensureVendorsSchema()
      if (schemaReady) {
        const retry = await supabaseAdmin
          .from('vendors')
          .select('id, company_id')
          .eq('id', id)
          .maybeSingle()
        if (!retry.error) {
          if (!retry.data || retry.data.company_id !== companyId) {
            return NextResponse.json({ success: false, message: 'Vendor not found' }, { status: 404 })
          }
        } else if (!isMissingTableError(retry.error)) {
          throw retry.error
        }
      }
    }
    if (loadErr) {
      if (isMissingTableError(loadErr)) {
        const fallbackVendor = await getFallbackVendorById(companyId, id)
        if (!fallbackVendor) return NextResponse.json({ success: false, message: 'Vendor not found' }, { status: 404 })
        const updated = await updateFallbackVendor(companyId, id, {
          is_verified: verified,
          verified_at: verified ? new Date().toISOString() : null,
          verified_by: verified ? (authUser.app_user_id || authUser.id) : null,
          updated_at: new Date().toISOString(),
        })
        return NextResponse.json({ success: true, data: updated, storage: 'company_notes_fallback' })
      }
      throw loadErr
    }
    if (!existing || existing.company_id !== companyId) {
      return NextResponse.json({ success: false, message: 'Vendor not found' }, { status: 404 })
    }

    const fullPayload: Record<string, unknown> = {
      is_verified: verified,
      verified_at: verified ? new Date().toISOString() : null,
      verified_by: verified ? (authUser.app_user_id || authUser.id) : null,
      updated_at: new Date().toISOString(),
    }

    let { data, error } = await supabaseAdmin
      .from('vendors')
      .update(fullPayload)
      .eq('id', id)
      .select('id, name, is_verified, verified_at, verified_by')
      .single()

    // Older deployments may have is_verified but not verified_at/verified_by.
    if (error && (isMissingColumnError(error, 'verified_by') || isMissingColumnError(error, 'verified_at'))) {
      const retry = await supabaseAdmin
        .from('vendors')
        .update({ is_verified: verified, updated_at: new Date().toISOString() })
        .eq('id', id)
        .select('id, name, is_verified')
        .single()
      data = retry.data as typeof data
      error = retry.error
    }

    if (error) {
      if (isMissingColumnError(error, 'is_verified')) {
        return NextResponse.json(
          { success: false, message: 'Vendor verification is not set up yet. Run the verification ALTER in CREATE_VENDORS_TABLES.sql.' },
          { status: 400 },
        )
      }
      throw error
    }

    return NextResponse.json({ success: true, data })
  } catch (err) {
    console.error('[PUT /api/v1/vendors/[id]/verify]', err)
    return NextResponse.json({ success: false, message: err instanceof Error ? err.message : 'Failed to verify vendor' }, { status: 500 })
  }
}
