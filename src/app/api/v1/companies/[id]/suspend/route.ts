import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, getUserFromToken } from '@/lib/supabase-server'

// POST /api/v1/companies/[id]/suspend
// Body: { action: 'suspend' | 'activate' }
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const caller = await getUserFromToken(req)
  if (!caller || caller.role !== 'SUPER_ADMIN') {
    return NextResponse.json({ success: false, message: 'Forbidden' }, { status: 403 })
  }

  const { id } = await params
  const body = await req.json()
  const action: 'suspend' | 'activate' = body.action

  if (!action || !['suspend', 'activate'].includes(action)) {
    return NextResponse.json({ success: false, message: 'action must be suspend or activate' }, { status: 400 })
  }

  const newStatus = action === 'suspend' ? 'SUSPENDED' : 'ACTIVE'

  const { data, error } = await supabaseAdmin
    .from('parties')
    .update({ status: newStatus, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('id, name, status')
    .single()

  if (error) {
    return NextResponse.json({ success: false, message: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true, data })
}
