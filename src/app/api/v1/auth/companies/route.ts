import { NextRequest, NextResponse } from 'next/server'
import { listProfilesByPhone, roleMatchesGroup } from '@/lib/supabase-auth-api'

export async function GET(req: NextRequest) {
  try {
    const phone = req.nextUrl.searchParams.get('phone')?.trim() || ''
    const group = req.nextUrl.searchParams.get('group')
    if (!phone) {
      return NextResponse.json({ success: false, message: 'Mobile number is required' }, { status: 400 })
    }

    const profiles = (await listProfilesByPhone(phone)).filter((profile) => roleMatchesGroup(profile.role, group))
    if (profiles.length === 0) {
      return NextResponse.json({ success: false, message: 'No account found with this mobile number' })
    }

    const accounts = profiles.map((profile) => ({
      userId: profile.id,
      name: profile.name,
      email: profile.email,
      phone: profile.phone,
      role: profile.role,
      partyId: profile.partyId,
      partyName: profile.partyName,
      companyName: profile.partyName || profile.name,
      companyCode: null,
    }))

    return NextResponse.json({
      success: true,
      data: {
        accounts,
        multiple: accounts.length > 1,
        totalCompanies: new Set(accounts.map((account) => account.partyId || account.userId)).size,
      },
    })
  } catch (error) {
    console.error('[AUTH COMPANIES] Failed:', error)
    return NextResponse.json({ success: false, message: 'Account lookup is temporarily unavailable' }, { status: 503 })
  }
}
