import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, getUserFromToken } from '@/lib/supabase-server'

/**
 * POST /api/v1/auth/fix-user-company
 * Fixes users linked to deleted companies by moving them to active companies with the same phone
 * 
 * Body: { phone: string }
 */
export async function POST(req: NextRequest) {
  try {
    const caller = await getUserFromToken(req)
    if (!caller || caller.role !== 'SUPER_ADMIN') {
      return NextResponse.json({ success: false, message: 'Unauthorized - SUPER_ADMIN required' }, { status: 401 })
    }
    
    const body = await req.json()
    const { phone } = body
    
    if (!phone) {
      return NextResponse.json({ success: false, message: 'phone is required' }, { status: 400 })
    }
    
    const normalizedPhone = phone.replace(/[^0-9]/g, '')
    
    //1. Find ALL companies with this phone
    const { data: companies, error: companiesError } = await supabaseAdmin
      .from('parties')
      .select('id, name, party_code, portal_phone, party_type_id, status')
      .or(`portal_phone.eq.${phone},portal_phone.eq.${normalizedPhone},portal_phone.ilike.%${normalizedPhone}%`)
      
    if (companiesError) {
      return NextResponse.json({ success: false, message: `Database error: ${companiesError.message}` }, { status: 500 })
    }
    
    //2. Find activecompany (preferably COMPANY type)
    const activeCompanies = (companies || []).filter(c => c.status === 'ACTIVE')
    const activeCompany = activeCompanies.find(c => c.party_type_id === 'fdcc59d3-fdc1-4700-94eb-3c2cf7e28c03') 
      || activeCompanies[0]
    
    if (!activeCompany) {
      return NextResponse.json({ 
        success: false, 
        message: 'No active company found with this phone number',
        companies: companies?.map(c => ({id: c.id, name: c.name, status: c.status }))
      }, { status: 404 })
    }
    
    // 3. Find existing user with this phone
    const { data: users, error: usersError } = await supabaseAdmin
      .from('users')
      .select('id, name, email, phone, party_id, role_id, roles(name)')
      .or(`phone.eq.${phone},phone.eq.${normalizedPhone},phone.ilike.%${normalizedPhone}%`)
      
    if (usersError) {
      return NextResponse.json({ success: false, message: `Database error: ${usersError.message}` }, { status: 500 })
    }
    
    const existingUser = users?.[0]
    
    if (!existingUser) {
      return NextResponse.json({ 
        success: false, 
        message: 'No user found with this phone number. Use provision-admin to create one.'
      }, { status: 404 })
    }
    
    // 4. Update user to link to active company
    const roles = existingUser.roles as { name: string } | { name: string }[] | null
    const roleName = Array.isArray(roles) ? roles[0]?.name : roles?.name
    
    // Get ADMIN role if user doesn't have it
    const { data: adminRole } = await supabaseAdmin
      .from('roles')
      .select('id')
      .eq('name', 'ADMIN')
      .single()
    
    const correctEmail = `${normalizedPhone}_${activeCompany.id.substring(0, 8)}@portal.internal`
    
    const updateData: Record<string, unknown> = {
      party_id: activeCompany.id,
      phone: normalizedPhone,
      email: correctEmail,
    }
    
    if (adminRole && roleName !== 'ADMIN') {
      updateData.role_id = adminRole.id
    }
    
    const { error: updateError } = await supabaseAdmin
      .from('users')
      .update(updateData)
      .eq('id', existingUser.id)
      
    if (updateError) {
      return NextResponse.json({ success: false, message: `Failed to update user: ${updateError.message}` }, { status: 500 })
    }
    
    // 5. Update auth user email
    try {
      await supabaseAdmin.auth.admin.updateUserById(existingUser.id, {
        email: correctEmail,
      })
    } catch (e) {
      console.error('[FIX-USER] Auth email update failed:', e)
    }
    
    return NextResponse.json({
      success: true,
      message: 'User fixed successfully',
      data: {
        user_id: existingUser.id,
        user_name: existingUser.name,
        old_party_id: existingUser.party_id,
        new_party_id: activeCompany.id,
        company_name: activeCompany.name,
        company_code: activeCompany.party_code,
        phone: normalizedPhone,
        email: correctEmail,
        role: 'ADMIN'
      }
    })
    
  } catch (err) {
    console.error('[FIX-USER-COMPANY] Error:', err)
    return NextResponse.json({
      success: false,
      message: err instanceof Error ? err.message : 'Unknown error'
    }, { status: 500 })
  }
}