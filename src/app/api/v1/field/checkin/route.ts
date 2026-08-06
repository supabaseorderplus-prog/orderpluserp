import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, getUserFromToken, resolveCompanyScope } from '@/lib/supabase-server'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { salesman_id, party_id, route_id, latitude, longitude } = body

    if (!salesman_id || !party_id) {
      return NextResponse.json({ success: false, message: 'salesman_id and party_id required' }, { status: 400 })
    }

    // CRITICAL: Enforce company isolation - check-ins must be scoped to the user's company
    const authUser = await getUserFromToken(req)
    const companyId = await resolveCompanyScope(req, authUser)

    // Geofence validation
    let isWithinGeofence = true
    let deviationMeters = 0

    if (route_id && latitude && longitude) {
      const { data: rp } = await supabaseAdmin
        .from('route_parties')
        .select('geofence_lat, geofence_lng, geofence_radius_m')
        .eq('route_id', route_id)
        .eq('party_id', party_id)
        .single()

      if (rp && rp.geofence_lat && rp.geofence_lng) {
        const R = 6371e3
        const lat1 = Number(rp.geofence_lat) * Math.PI / 180
        const lat2 = Number(latitude) * Math.PI / 180
        const dLat = (Number(latitude) - Number(rp.geofence_lat)) * Math.PI / 180
        const dLng = (Number(longitude) - Number(rp.geofence_lng)) * Math.PI / 180
        const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
        deviationMeters = Math.round(R * c)
        isWithinGeofence = deviationMeters <= (rp.geofence_radius_m || 100)
      }
    }

    const insertData: any = {
      salesman_id,
      party_id,
      route_id,
      visit_date: new Date().toISOString().split('T')[0],
      check_in_time: new Date().toISOString(),
      check_in_lat: latitude,
      check_in_lng: longitude,
      is_within_geofence: isWithinGeofence,
      deviation_meters: deviationMeters,
    }

    // CRITICAL: Associate visit with company
    if (companyId) {
      insertData.company_id = companyId
    }

    const { data, error } = await supabaseAdmin
      .from('party_visits')
      .insert(insertData)
      .select()
      .single()

    if (error) throw error

    // Log GPS
    if (latitude && longitude) {
      const gpsData: any = {
        user_id: salesman_id,
        latitude,
        longitude,
        route_id,
      }

      // CRITICAL: Associate GPS log with company
      if (companyId) {
        gpsData.company_id = companyId
      }

      await supabaseAdmin.from('gps_logs').insert(gpsData)
    }

    return NextResponse.json({
      success: true,
      data,
      geofence: { isWithinGeofence, deviationMeters },
    }, { status: 201 })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Check-in failed' },
      { status: 500 }
    )
  }
}
