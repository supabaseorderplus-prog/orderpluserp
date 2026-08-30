import { NextRequest, NextResponse } from 'next/server'
import { createPasswordAuthClient } from '@/lib/supabase-auth-api'

export async function POST(req: NextRequest) {
  try {
    const { refreshToken } = await req.json() as { refreshToken?: string }
    if (!refreshToken) {
      return NextResponse.json({ success: false, message: 'Refresh token is required' }, { status: 400 })
    }

    const authClient = createPasswordAuthClient()
    const { data, error } = await authClient.auth.refreshSession({ refresh_token: refreshToken })
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
  } catch (error) {
    console.error('[AUTH REFRESH] Failed:', error)
    return NextResponse.json({ success: false, message: 'Session refresh is temporarily unavailable' }, { status: 503 })
  }
}
