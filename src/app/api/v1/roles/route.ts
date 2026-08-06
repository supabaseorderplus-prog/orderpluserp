import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-server'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const name = String(body.name || '').toUpperCase().trim()
    if (!name) return NextResponse.json({ success: false, message: 'Role name is required' }, { status: 400 })

    // Upsert: insert only if not already present
    const { data: existing } = await supabaseAdmin.from('roles').select('id, name').eq('name', name).single()
    if (existing) return NextResponse.json({ success: true, data: existing })

    const { data, error } = await supabaseAdmin.from('roles').insert({ name }).select('id, name').single()
    if (error) throw error
    return NextResponse.json({ success: true, data }, { status: 201 })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed to create role' },
      { status: 500 }
    )
  }
}

export async function GET() {
  try {
    const { data, error } = await supabaseAdmin
      .from('roles')
      .select('id, name')
      .order('name')

    if (error) throw error
    return NextResponse.json({ data: data || [] })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed to fetch roles' },
      { status: 500 }
    )
  }
}
