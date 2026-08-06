import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-server'

export async function POST(req: NextRequest) {
  try {
    const { email } = await req.json()
    const origin = req.nextUrl.origin
    const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || origin

    if (!email || typeof email !== 'string') {
      return NextResponse.json(
        { success: false, message: 'Email is required' },
        { status: 400 }
      )
    }

    // Check if user exists and is ACTIVE
    const { data: userRow } = await supabaseAdmin
      .from('users')
      .select('id, email, status')
      .eq('email', email)
      .single()

    if (userRow && userRow.status === 'ACTIVE') {
      // Use Supabase's built-in password reset email
      await supabaseAdmin.auth.resetPasswordForEmail(email, {
        redirectTo: `${siteUrl}/reset-password`,
      })
    }

    // Always return success to prevent email enumeration
    return NextResponse.json({
      success: true,
      data: null,
      message: 'If the email exists, a password reset link has been sent',
    })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Request failed' },
      { status: 500 }
    )
  }
}
