import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, getUserFromToken, resolveCompanyScope } from '@/lib/supabase-server'

export async function GET(req: NextRequest) {
  try {
    const authUser = await getUserFromToken(req)
    const companyId = await resolveCompanyScope(req, authUser)

    let query = supabaseAdmin
      .from('hsn_codes')
      .select('id, hsn_code, gst_rate, cess_rate, description')
      .eq('status', 'ACTIVE')
      
    if (companyId) {
      query = query.eq('company_id', companyId)
    }

    const { data, error } = await query
      .order('gst_rate')
      .order('hsn_code')
    if (error) throw error
    return NextResponse.json({ success: true, data: data || [] })
  } catch (err) {
    return NextResponse.json({ success: false, message: err instanceof Error ? err.message : 'Failed to fetch HSN codes' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { hsn_code, gst_rate, cess_rate, description } = body

    if (!hsn_code || gst_rate === undefined || gst_rate === null) {
      return NextResponse.json({ success: false, message: 'hsn_code and gst_rate are required' }, { status: 400 })
    }

    const insertPayload: Record<string, unknown> = {
      hsn_code: String(hsn_code).trim(),
      gst_rate: Number(gst_rate),
      cess_rate: cess_rate !== undefined ? Number(cess_rate) : 0,
      description: description ? String(description).trim() : '',
      status: 'ACTIVE',
      effective_from: new Date().toISOString().split('T')[0],
    }

    const authUser = await getUserFromToken(req)
    const companyId = await resolveCompanyScope(req, authUser)
    if (companyId) {
      insertPayload.company_id = companyId
    }

    const { data, error } = await supabaseAdmin
      .from('hsn_codes')
      .insert(insertPayload)
      .select()
      .single()

    if (error) throw error
    return NextResponse.json({ success: true, data })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : (err as { message?: string })?.message || 'Failed to create HSN code'
    console.error('[HSN POST]', err)
    return NextResponse.json({ success: false, message: msg }, { status: 500 })
  }
}
