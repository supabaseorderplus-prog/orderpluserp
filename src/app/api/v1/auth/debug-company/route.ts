import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-server'

/**
 * Debug endpoint to check company and admin user status
 * GET /api/v1/auth/debug-company?phone=XXX
 */
export async function GET(req: NextRequest) {
  const phone = req.nextUrl.searchParams.get('phone')
  
  if (!phone) {
    return NextResponse.json({ error: 'phone parameter required' }, { status: 400 })
  }
  
  const normalizedPhone = phone.replace(/[^0-9]/g, '')
  
  // 1. Find company with this portal_phone
  const { data: companies, error: companiesError } = await supabaseAdmin
    .from('parties')
    .select('id, name, party_code, portal_phone, portal_password_hash, status, party_type_id')
    .or(`portal_phone.eq.${phone},portal_phone.eq.${normalizedPhone},portal_phone.ilike.%${normalizedPhone}%`)
    
  // 2. Find users with this phone
  const { data: users, error: usersError } = await supabaseAdmin
    .from('users')
    .select('id, name, email, phone, party_id, role_id, roles(name)')
    .or(`phone.eq.${phone},phone.eq.${normalizedPhone},phone.ilike.%${normalizedPhone}%`)
    
  // 3. Find auth users
  const { data: authUsers } = await supabaseAdmin.auth.admin.listUsers()
  
  const matchingAuthUsers = (authUsers?.users || []).filter(u => {
    const authPhone = u.phone?.replace(/[^0-9]/g, '') || ''
    const authEmailPhone = u.email?.split('_')[0] || ''
    return authPhone === normalizedPhone || authEmailPhone === normalizedPhone
  })
  
  // 4. Get ADMIN role
  const { data: adminRole } = await supabaseAdmin
    .from('roles')
    .select('id, name')
    .eq('name', 'ADMIN')
    .single()
  
  return NextResponse.json({
    searchPhone: phone,
    normalizedPhone,
    companies: {
      error: companiesError?.message,
      count: companies?.length || 0,
      data: companies?.map(c => ({
        id: c.id,
        name: c.name,
        party_code: c.party_code,
        portal_phone: c.portal_phone,
        has_password: !!c.portal_password_hash,
        status: c.status
      }))
    },
    users: {
      error: usersError?.message,
      count: users?.length || 0,
      data: users?.map(u => ({
        id: u.id,
        name: u.name,
        email: u.email,
        phone: u.phone,
        party_id: u.party_id,
        role: u.roles
      }))
    },
    authUsers: {
      count: matchingAuthUsers.length,
      data: matchingAuthUsers.map(u => ({
        id: u.id,
        email: u.email,
        phone: u.phone,
        created_at: u.created_at
      }))
    },
    adminRole: adminRole ? { id: adminRole.id, name: adminRole.name } : null,
    diagnosis: {
      companyFound: (companies?.length || 0) > 0,
      userFound: (users?.length || 0) > 0,
      authUserFound: matchingAuthUsers.length > 0,
      canFix: (companies?.length || 0) > 0 && adminRole
    }
  })
}