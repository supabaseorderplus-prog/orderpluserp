import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-server'
import { createPasswordAuthClient, getAuthProfile, phoneVariants } from '@/lib/supabase-auth-api'

type LoginBody = {
  email?: string
  phone?: string
  userId?: string
  password?: string
  role?: string
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as LoginBody
    if (!body.password || body.password.length < 6) {
      return NextResponse.json({ success: false, message: 'Invalid credentials' }, { status: 401 })
    }

    let email = body.email?.trim().toLowerCase() || ''
    let selectedProfile = body.userId ? await getAuthProfile(body.userId) : null

    if (body.userId) {
      if (!selectedProfile || selectedProfile.status !== 'ACTIVE') {
        return NextResponse.json({ success: false, message: 'Invalid credentials' }, { status: 401 })
      }
      const submittedPhones = phoneVariants(body.phone || '')
      const storedPhones = phoneVariants(selectedProfile.phone || '')
      if (body.phone && !submittedPhones.some((phone) => storedPhones.includes(phone))) {
        return NextResponse.json({ success: false, message: 'Invalid credentials' }, { status: 401 })
      }
      const { data, error } = await supabaseAdmin.auth.admin.getUserById(body.userId)
      if (error || !data.user?.email) {
        return NextResponse.json({ success: false, message: 'Invalid credentials' }, { status: 401 })
      }
      email = data.user.email
    }

    if (!email) {
      return NextResponse.json({ success: false, message: 'Email or account is required' }, { status: 400 })
    }

    const authClient = createPasswordAuthClient()
    const { data, error } = await authClient.auth.signInWithPassword({ email, password: body.password })
    if (error || !data.user || !data.session) {
      return NextResponse.json({ success: false, message: 'Invalid credentials' }, { status: 401 })
    }

    selectedProfile = selectedProfile || await getAuthProfile(data.user.id)
    if (!selectedProfile || selectedProfile.status !== 'ACTIVE') {
      return NextResponse.json({ success: false, message: 'Account is inactive or unavailable' }, { status: 403 })
    }

    const metadataRole = data.user.user_metadata?.display_role || data.user.user_metadata?.role
    const role = String(metadataRole || selectedProfile.role).trim().toUpperCase()
    if (body.role === 'SUPER_ADMIN' && role !== 'SUPER_ADMIN') {
      return NextResponse.json({ success: false, message: 'Invalid credentials' }, { status: 401 })
    }

    return NextResponse.json({
      success: true,
      data: {
        accessToken: data.session.access_token,
        refreshToken: data.session.refresh_token,
        user: {
          id: data.user.id,
          name: selectedProfile.name,
          email: data.user.email || selectedProfile.email || '',
          phone: selectedProfile.phone || '',
          role,
          role_id: selectedProfile.roleId,
          zoneId: null,
          party_id: selectedProfile.partyId,
          party_name: selectedProfile.partyName,
        },
      },
      message: 'Login successful',
    })
  } catch (error) {
    console.error('[AUTH LOGIN] Failed:', error)
    return NextResponse.json({ success: false, message: 'Authentication service unavailable' }, { status: 503 })
  }
}
