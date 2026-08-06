import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, getUserFromToken, resolveCompanyScope } from '@/lib/supabase-server'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { visit_id, notes } = body

    if (!visit_id) {
      return NextResponse.json({ success: false, message: 'visit_id required' }, { status: 400 })
    }

    const authUser = await getUserFromToken(req)
    const companyId = await resolveCompanyScope(req, authUser)

    // Verify company access before update
    if (companyId) {
      const { data: existingVisit } = await supabaseAdmin
        .from('party_visits')
        .select('company_id')
        .eq('id', visit_id)
        .single()

      if (!existingVisit || existingVisit.company_id !== companyId) {
        return NextResponse.json({ success: false, message: 'Visit not found or access denied' }, { status: 403 })
      }
    }

    const { data, error } = await supabaseAdmin
      .from('party_visits')
      .update({
        check_out_time: new Date().toISOString(),
        notes,
        updated_at: new Date().toISOString(),
      })
      .eq('id', visit_id)
      .select()
      .single()

    if (error) throw error

    return NextResponse.json({ success: true, data })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Checkout failed' },
      { status: 500 }
    )
  }
}
