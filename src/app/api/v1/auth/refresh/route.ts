import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-server'

export async function POST(req: NextRequest) {
  try {
    const { refreshToken } = await req.json()
    if (!refreshToken) {
      return NextResponse.json({ success: false, message: 'Refresh token required' }, { status: 400 })
    }

    const { data, error } = await supabaseAdmin.auth.refreshSession({ refresh_token: refreshToken })
    if (error || !data.session) {
      return NextResponse.json({ success: false, message: 'Invalid refresh token' }, { status: 401 })
    }

    return NextResponse.json({
      success: true,
      data: {
        accessToken: data.session.access_token,
        refreshToken: data.session.refresh_token,
      },
    })
  } catch {
    return NextResponse.json({ success: false, message: 'Refresh failed' }, { status: 500 })
  }
}
