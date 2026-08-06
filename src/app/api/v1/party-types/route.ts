import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-server'

export async function GET() {
  try {
    const { data, error } = await supabaseAdmin
      .from('party_types')
      .select('id, name')
      .eq('status', 'ACTIVE')
      .order('name')
    if (error) throw error
    return NextResponse.json({ success: true, data: data || [] })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed to fetch party types' },
      { status: 500 }
    )
  }
}
