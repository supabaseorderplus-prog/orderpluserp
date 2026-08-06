import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, getUserFromToken, resolveCompanyScope } from '@/lib/supabase-server'

export async function GET(req: NextRequest) {
  try {
    const authUser = await getUserFromToken(req)
    const companyId = await resolveCompanyScope(req, authUser)

    let query = supabaseAdmin
      .from('td_config')
      .select('*, parties(name, party_code)')
      .eq('status', 'ACTIVE')
      .order('created_at', { ascending: false })

    if (companyId) {
      query = query.eq('company_id', companyId)
    }

    const { data, error } = await query
    if (error) throw error
    return NextResponse.json({ success: true, data: data || [] })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed' },
      { status: 500 }
    )
  }
}

export async function POST(req: NextRequest) {
  try {
    const authUser = await getUserFromToken(req)
    const companyId = await resolveCompanyScope(req, authUser)

    const body = await req.json()
    const insertData: Record<string, unknown> = { ...body }
    if (companyId) {
      insertData.company_id = companyId
    }
    const { data, error } = await supabaseAdmin.from('td_config').insert(insertData).select().single()
    if (error) throw error
    return NextResponse.json({ success: true, data }, { status: 201 })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed' },
      { status: 500 }
    )
  }
}
