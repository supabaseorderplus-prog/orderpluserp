import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-server'

export async function GET() {
  try {
    const { data: states } = await supabaseAdmin
      .from('states')
      .select('*')
      .eq('status', 'ACTIVE')
      .order('name')

    const { data: districts } = await supabaseAdmin
      .from('districts')
      .select('*, states(name, state_code)')
      .eq('status', 'ACTIVE')
      .order('name')

    const { data: territories } = await supabaseAdmin
      .from('territories')
      .select('*, states(name), districts(name)')
      .eq('status', 'ACTIVE')
      .order('name')

    return NextResponse.json({
      success: true,
      data: {
        states: states || [],
        districts: districts || [],
        territories: territories || [],
      },
    })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed to fetch geography' },
      { status: 500 }
    )
  }
}
