import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, getUserFromToken, resolveCompanyScope } from '@/lib/supabase-server'

export async function GET(req: NextRequest) {
  try {
    // CRITICAL: Get authenticated user and resolve company scope for data isolation
    const authUser = await getUserFromToken(req)
    const companyId = await resolveCompanyScope(req, authUser)

    let query = supabaseAdmin
      .from('location_logs')
      .select('id, user_id, latitude, longitude, recorded_at, users(name, roles(name))')
      .order('recorded_at', { ascending: false })
      .limit(100)

    // CRITICAL: Filter by company_id to ensure strict data isolation
    if (companyId) {
      query = query.eq('company_id', companyId)
    }

    const { data, error } = await query
    if (error) throw error

    // Deduplicate by user, keeping most recent
    const userMap = new Map()
    for (const loc of data || []) {
      if (!userMap.has(loc.user_id)) {
        const user = Array.isArray(loc.users) ? loc.users[0] : loc.users
        const roleData = Array.isArray(user?.roles) ? user.roles[0] : user?.roles
        const role = roleData?.name || 'SALESMAN'
        userMap.set(loc.user_id, {
          id: loc.id,
          user: { name: user?.name || 'Unknown', role },
          lat: Number(loc.latitude || 0),
          lng: Number(loc.longitude || 0),
          lastSeen: loc.recorded_at,
          status: 'ONLINE',
        })
      }
    }

    return NextResponse.json({ data: Array.from(userMap.values()) })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed' },
      { status: 500 }
    )
  }
}
