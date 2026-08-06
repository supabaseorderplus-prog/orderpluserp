import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, getUserFromToken } from '@/lib/supabase-server'

// GET /api/v1/companies/audit?company_id=xxx&limit=50
export async function GET(req: NextRequest) {
  const caller = await getUserFromToken(req)
  if (!caller || caller.role !== 'SUPER_ADMIN') {
    return NextResponse.json({ success: false, message: 'Forbidden' }, { status: 403 })
  }

  const companyId = req.nextUrl.searchParams.get('company_id')
  const limit = Math.min(parseInt(req.nextUrl.searchParams.get('limit') || '50'), 200)

  if (!companyId) {
    return NextResponse.json({ success: false, message: 'company_id required' }, { status: 400 })
  }

  // Fetch users belonging to this company
  const { data: users } = await supabaseAdmin
    .from('users')
    .select('id, name')
    .eq('party_id', companyId)

  const userIds = (users || []).map(u => u.id)
  const userMap: Record<string, string> = {}
  ;(users || []).forEach(u => { userMap[u.id] = u.name })

  if (userIds.length === 0) {
    return NextResponse.json({ success: true, data: [] })
  }

  const { data, error } = await supabaseAdmin
    .from('audit_logs')
    .select('id, user_id, action, module, record_id, timestamp')
    .in('user_id', userIds)
    .order('timestamp', { ascending: false })
    .limit(limit)

  if (error) {
    return NextResponse.json({ success: false, message: error.message }, { status: 500 })
  }

  const enriched = (data || []).map(log => ({
    ...log,
    user_name: userMap[log.user_id] || 'Unknown User',
  }))

  return NextResponse.json({ success: true, data: enriched })
}
