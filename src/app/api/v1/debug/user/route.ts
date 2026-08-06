import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-server'

export async function GET(req: NextRequest) {
  const phone = req.nextUrl.searchParams.get('phone')
  const password = req.nextUrl.searchParams.get('password')
  
  if (!phone) {
    return NextResponse.json({ error: 'Phone parameter required' }, { status: 400 })
  }

  const normalizedPhone = phone.replace(/[^0-9]/g, '')
  
  // Find users with this phone - without embed to avoid relationship ambiguity
  const { data: users, error: usersError } = await supabaseAdmin
    .from('users')
    .select('id, name, email, phone, role_id, party_id, status')
    .eq('phone', normalizedPhone)

  // Get role names separately
  const roleIds = (users || []).map(u => u.role_id).filter(Boolean)
  let rolesMap: Record<string, string> = {}
  if (roleIds.length > 0) {
    const { data: roles } = await supabaseAdmin.from('roles').select('id, name').in('id', roleIds)
    for (const r of roles || []) {
      rolesMap[r.id] = r.name
    }
  }

  // Get party names separately
  const partyIds = (users || []).map(u => u.party_id).filter(Boolean)
  let partiesMap: Record<string, string> = {}
  if (partyIds.length > 0) {
    const { data: parties } = await supabaseAdmin.from('parties').select('id, name').in('id', partyIds)
    for (const p of parties || []) {
      partiesMap[p.id] = p.name
    }
  }

  const usersWithDetails = (users || []).map(u => ({
    id: u.id,
    name: u.name,
    email: u.email,
    phone: u.phone,
    role: rolesMap[u.role_id || ''] || null,
    role_id: u.role_id,
    party_id: u.party_id,
    party_name: u.party_id ? partiesMap[u.party_id] : null,
    status: u.status,
  }))

  // Find auth users
  const { data: authUsers, error: authError } = await supabaseAdmin.auth.admin.listUsers()
  
  const matchingAuthUsers = (authUsers?.users || []).filter(u => {
    const emailPhone = u.email?.split('_')[0]
    return emailPhone === normalizedPhone || u.email?.includes(normalizedPhone)
  })

  // Test login if password provided
  let loginTest = null
  if (password && matchingAuthUsers.length > 0) {
    const authUser = matchingAuthUsers[0]
    const { data: loginData, error: loginError } = await supabaseAdmin.auth.signInWithPassword({
      email: authUser.email!,
      password,
    })
    loginTest = {
      success: !!loginData?.user,
      error: loginError?.message,
      userId: loginData?.user?.id,
    }
  }

  return NextResponse.json({
    searchPhone: phone,
    normalizedPhone,
    usersTable: usersWithDetails,
    usersError: usersError?.message,
    authUsersCount: matchingAuthUsers.length,
    authUsers: matchingAuthUsers.map(u => ({
      id: u.id,
      email: u.email,
      created_at: u.created_at,
    })),
    authError: authError?.message,
    loginTest,
  })
}