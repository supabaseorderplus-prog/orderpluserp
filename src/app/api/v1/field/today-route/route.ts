import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, getUserFromToken, resolveCompanyScope } from '@/lib/supabase-server'

// Field app: get today's route for salesman
export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url)
    const salesmanId = url.searchParams.get('salesmanId')

    if (!salesmanId) {
      return NextResponse.json({ success: false, message: 'salesmanId required' }, { status: 400 })
    }

    const authUser = await getUserFromToken(req)
    const companyId = await resolveCompanyScope(req, authUser)

    const today = new Date()
    const dayOfWeek = today.getDay() // 0=Sun, 1=Mon...

    // Get routes for this salesman
    let routesQuery = supabaseAdmin
      .from('routes')
      .select(`
        *,
        territories(name, code),
        route_parties(
          id, stop_order, geofence_lat, geofence_lng, geofence_radius_m,
          parties(id, name, party_code, contact_person, contact_phone, address_line1, city,
            party_types(name))
        )
      `)
      .eq('salesman_id', salesmanId)
      .eq('status', 'ACTIVE')
      .contains('schedule_days', [dayOfWeek])
      .order('name')

    if (companyId) {
      routesQuery = routesQuery.eq('company_id', companyId)
    }

    const { data: routes, error } = await routesQuery

    if (error) throw error

    // Get today's visits for this salesman
    const todayStr = today.toISOString().split('T')[0]
    const { data: visits } = await supabaseAdmin
      .from('party_visits')
      .select('party_id, check_in_time, check_out_time, order_id, payment_id')
      .eq('salesman_id', salesmanId)
      .eq('visit_date', todayStr)

    const visitMap = new Map(visits?.map(v => [v.party_id, v]) || [])

    // Enrich routes with visit status
    const enrichedRoutes = (routes || []).map(route => ({
      ...route,
      route_parties: ((route.route_parties as Record<string, unknown>[]) || [])
        .sort((a, b) => (a.stop_order as number) - (b.stop_order as number))
        .map(rp => ({
          ...rp,
          visit: visitMap.get((rp.parties as Record<string, unknown>)?.id as string) || null,
          is_visited: visitMap.has((rp.parties as Record<string, unknown>)?.id as string),
        })),
    }))

    return NextResponse.json({ success: true, data: enrichedRoutes })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed to fetch route' },
      { status: 500 }
    )
  }
}
