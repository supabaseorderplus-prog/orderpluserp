import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, getUserFromToken, resolveCompanyScope } from '@/lib/supabase-server'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { logs } = body

    if (!logs || !Array.isArray(logs) || logs.length === 0) {
      return NextResponse.json({ success: false, message: 'logs array required' }, { status: 400 })
    }

    const authUser = await getUserFromToken(req)
    const companyId = await resolveCompanyScope(req, authUser)

    const gpsEntries = logs.map((log: Record<string, unknown>) => ({
      user_id: log.user_id,
      latitude: log.latitude,
      longitude: log.longitude,
      accuracy: log.accuracy,
      speed_kmph: log.speed_kmph,
      battery_level: log.battery_level,
      route_id: log.route_id,
      company_id: companyId,
      timestamp: log.timestamp || new Date().toISOString(),
    }))

    const { error } = await supabaseAdmin.from('gps_logs').insert(gpsEntries)
    if (error) throw error

    return NextResponse.json({ success: true, ingested: gpsEntries.length })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'GPS ingest failed' },
      { status: 500 }
    )
  }
}
