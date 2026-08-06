import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, getUserFromToken } from '@/lib/supabase-server'

// GET /api/v1/companies/notes?company_id=xxx
export async function GET(req: NextRequest) {
  const caller = await getUserFromToken(req)
  if (!caller || caller.role !== 'SUPER_ADMIN') {
    return NextResponse.json({ success: false, message: 'Forbidden' }, { status: 403 })
  }

  const companyId = req.nextUrl.searchParams.get('company_id')
  if (!companyId) {
    return NextResponse.json({ success: false, message: 'company_id required' }, { status: 400 })
  }

  const { data, error } = await supabaseAdmin
    .from('company_notes')
    .select('id, note, created_at, updated_at')
    .eq('company_id', companyId)
    .order('created_at', { ascending: false })

  if (error) {
    return NextResponse.json({ success: false, message: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true, data: data || [] })
}

// POST /api/v1/companies/notes
export async function POST(req: NextRequest) {
  const caller = await getUserFromToken(req)
  if (!caller || caller.role !== 'SUPER_ADMIN') {
    return NextResponse.json({ success: false, message: 'Forbidden' }, { status: 403 })
  }

  const body = await req.json()
  const { company_id, note } = body

  if (!company_id || !note?.trim()) {
    return NextResponse.json({ success: false, message: 'company_id and note required' }, { status: 400 })
  }

  const { data, error } = await supabaseAdmin
    .from('company_notes')
    .insert({ company_id, note: note.trim(), created_by: caller.id })
    .select()
    .single()

  if (error) {
    return NextResponse.json({ success: false, message: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true, data })
}
