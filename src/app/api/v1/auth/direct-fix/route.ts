import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-server'

/**
 * POST /api/v1/auth/direct-fix
 * Direct fix for user-company link issues
 * This endpoint fixes users linked to deleted companies
 * 
 * Body: { phone: string }
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { phone } = body
    
    if (!phone) {
      return NextResponse.json({ success: false, message: 'phone is required' }, { status: 400 })
    }
    
    const normalizedPhone = phone.replace(/[^0-9]/g, '')
    
    console.log(`[DIRECT-FIX] Fixing user for phone: ${normalizedPhone}`)
    
    // 1. Find ALL companies with this phone
    const { data: companies, error: companiesError } = await supabaseAdmin
      .from('parties')
      .select('id, name, party_code, portal_phone, party_type_id, status')
      .or(`portal_phone.eq.${phone},portal_phone.eq.${normalizedPhone},portal_phone.ilike.%${normalizedPhone}%`)
      
    if (companiesError) {
      return NextResponse.json({ success: false, message: `Database error: ${companiesError.message}` }, { status: 500 })
    }
    
    console.log(`[DIRECT-FIX] Found ${companies?.length || 0} companies`)
    
    // 2. Find ACTIVE company (preferably COMPANY type)
    const COMPANY_TYPE_ID = 'fdcc59d3-fdc1-4700-94eb-3c2cf7e28c03'
    const activeCompanies = (companies || []).filter(c => c.status === 'ACTIVE')
    const activeCompany = activeCompanies.find(c => c.party_type_id === COMPANY_TYPE_ID) 
      || activeCompanies[0]
    
    if (!activeCompany) {
      return NextResponse.json({ 
        success: false, 
        message: 'No ACTIVE company found with this phone number',
        found: companies?.map(c => ({ id: c.id, name: c.name, status: c.status }))
      }, { status: 404 })
    }
    
    console.log(`[DIRECT-FIX] Active company: ${activeCompany.name} (${activeCompany.id})`)
    
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
      // No user exists - need password to create one
      return NextResponse.json({ 
        success: false, 
        message: 'No user found. Please provide a password to create admin account.',
        activeCompany: {
          id: activeCompany.id,
          name: activeCompany.name,
          code: activeCompany.party_code
        }
      }, { status: 404 })
    }
    
    console.log(`[DIRECT-FIX] Found user: ${existingUser.id} linked to party: ${existingUser.party_id}`)
    
    // 4. Get ADMIN role
    const { data: adminRole } = await supabaseAdmin
      .from('roles')
      .select('id')
      .eq('name', 'ADMIN')
      .single()
    
    const correctEmail = `${normalizedPhone}_${activeCompany.id.substring(0, 8)}@portal.internal`
    
    // 5. Update user to link to active company
    const updateData: Record<string, unknown> = {
      party_id: activeCompany.id,
      phone: normalizedPhone,
      email: correctEmail,
      status: 'ACTIVE',
    }
    
    if (adminRole) {
      updateData.role_id = adminRole.id
    }
    
    const { error: updateError } = await supabaseAdmin
      .from('users')
      .update(updateData)
      .eq('id', existingUser.id)
      
    if (updateError) {
      return NextResponse.json({ success: false, message: `Failed to update user: ${updateError.message}` }, { status: 500 })
    }
    
    console.log(`[DIRECT-FIX] Updated user party_id to: ${activeCompany.id}`)
    
    // 6. Update auth user email
    try {
      await supabaseAdmin.auth.admin.updateUserById(existingUser.id, {
        email: correctEmail,
      })
      console.log(`[DIRECT-FIX] Updated auth email to: ${correctEmail}`)
    } catch (e) {
      console.error('[DIRECT-FIX] Auth email update failed:', e)
    }
    
    // 7. Update party portal_phone to ensure it's normalized
    await supabaseAdmin
      .from('parties')
      .update({ portal_phone: normalizedPhone })
      .eq('id', activeCompany.id)
    
    return NextResponse.json({
      success: true,
      message: 'User fixed! You can now login with phone: ' + normalizedPhone,
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
    console.error('[DIRECT-FIX] Error:', err)
    return NextResponse.json({
      success: false,
      message: err instanceof Error ? err.message : 'Unknown error'
    }, { status: 500 })
  }
}