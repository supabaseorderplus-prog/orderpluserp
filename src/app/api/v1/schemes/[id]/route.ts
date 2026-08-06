import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, getUserFromToken, resolveCompanyScope } from '@/lib/supabase-server'
import { mapSchemeScopeForResponse } from '@/lib/scheme-scope'

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params

    // CRITICAL: Enforce company isolation - users can only see schemes for their company
    const authUser = await getUserFromToken(req)
    const companyId = await resolveCompanyScope(req, authUser)

    // Fail closed: non-SUPER_ADMIN with no resolvable company cannot access any scheme
    if (!companyId && authUser?.role !== 'SUPER_ADMIN') {
      return NextResponse.json({ success: false, message: 'Scheme not found' }, { status: 404 })
    }

    let schemeQuery = supabaseAdmin
      .from('schemes')
      .select('*, territories(name)')
      .eq('id', id)

    if (companyId) {
      schemeQuery = schemeQuery.eq('company_id', companyId)
    }

    const { data, error } = await schemeQuery.single()

    if (error) throw error

    // Get progress for all parties
    let progressQuery = supabaseAdmin
      .from('scheme_progress')
      .select('*, parties(name, party_code, party_types(name))')
      .eq('scheme_id', id)
      .order('current_value', { ascending: false })

    // CRITICAL: Filter progress by company_id through parties
    if (companyId) {
      progressQuery = progressQuery.eq('parties.company_id', companyId)
    }

    const { data: progress } = await progressQuery

    return NextResponse.json({
      success: true,
      data: { ...mapSchemeScopeForResponse(data), progress: progress || [] },
    })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed to fetch scheme' },
      { status: 500 }
    )
  }
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const body = await req.json()

    // CRITICAL: Enforce company isolation - users can only update schemes for their company
    const authUser = await getUserFromToken(req)
    const companyId = await resolveCompanyScope(req, authUser)

    // Fail closed: non-SUPER_ADMIN with no resolvable company cannot modify any scheme
    if (!companyId && authUser?.role !== 'SUPER_ADMIN') {
      return NextResponse.json({ success: false, message: 'Access denied' }, { status: 403 })
    }

    let updateQuery = supabaseAdmin
      .from('schemes')
      .update({ ...body, updated_at: new Date().toISOString() })
      .eq('id', id)

    if (companyId) {
      updateQuery = updateQuery.eq('company_id', companyId)
    }

    const { data, error } = await updateQuery.select().single()

    if (error) throw error
    return NextResponse.json({ success: true, data })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed to update scheme' },
      { status: 500 }
    )
  }
}
