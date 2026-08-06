import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-server'

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url)
    const phone = searchParams.get('phone')

    if (!phone) {
      return NextResponse.json({ 
        success: false, 
        message: 'phone query param required',
        debug: {
          partiesWithPortalPhone: null,
          usersWithPhone: null,
        }
      }, { status: 400 })
    }

    const normalizedPhone = phone.replace(/[^0-9]/g, '')

    // Check parties table
    const { data: parties } = await supabaseAdmin
      .from('parties')
      .select('id, name, portal_phone, party_type_id')
      .not('portal_phone', 'is', null)
    
    const matchingParties = (parties || []).filter(p => {
      if (!p.portal_phone) return false
      const pPhone = p.portal_phone.replace(/[^0-9]/g, '')
      return pPhone === normalizedPhone || pPhone.endsWith(normalizedPhone) || normalizedPhone.endsWith(pPhone)
    })

    // Check users table directly
    const { data: allUsers } = await supabaseAdmin
      .from('users')
      .select('id, name, phone, party_id, roles:role_id(id, name)')
      .not('phone', 'is', null)

    const matchingUsers = (allUsers || []).filter(u => {
      if (!u.phone) return false
      const uPhone = u.phone.replace(/[^0-9]/g, '')
      return uPhone === normalizedPhone || uPhone.endsWith(normalizedPhone) || normalizedPhone.endsWith(uPhone)
    })

    // Get role names for matching users
    const roleIds = (matchingUsers as any[]).map(u => u.roles?.id).filter(Boolean)
    const { data: roles } = await supabaseAdmin
      .from('roles')
      .select('id, name')
      .in('id', roleIds)
    
    const roleMap: Record<string, string> = {}
    for (const r of roles || []) {
      roleMap[r.id] = r.name
    }

    const usersWithRoleNames = (matchingUsers as any[]).map(u => ({
      id: u.id,
      name: u.name,
      phone: u.phone,
      party_id: u.party_id,
      role_id: u.roles?.id,
      role_name: roleMap[u.roles?.id] || 'UNKNOWN'
    }))

    // Check if any matching users have ADMIN role
    const adminUsers = usersWithRoleNames.filter(u => u.role_name === 'ADMIN')

    // Check parties table directly for the company
    const { data: bloomParty } = await supabaseAdmin
      .from('parties')
      .select('id, name, portal_phone')
      .ilike('name', '%BLOOM%')

    return NextResponse.json({
      success: true,
      debug: {
        searchedPhone: phone,
        normalizedPhone,
        matchingParties,
        matchingUsers: usersWithRoleNames,
        adminUsers,
        bloomParty,
        allPartiesWithPortalPhone: parties,
      }
    })
  } catch (err) {
    return NextResponse.json({
      success: false,
      message: err instanceof Error ? err.message : 'Debug failed',
    }, { status: 500 })
  }
}
