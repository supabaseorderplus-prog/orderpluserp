import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, getUserFromToken } from '@/lib/supabase-server'
import * as crypto from 'crypto'

/**
 * POST /api/v1/auth/provision-admin
 * Provision admin user for a company that doesn't have one
 * 
 * Body: { phone: string, password?: string }
 * - phone: The phone number to search for/create admin
 * - password: Optional password. If not provided and company has portal_password_hash, uses that
 */
export async function POST(req: NextRequest) {
  try {
    const caller = await getUserFromToken(req)
    if (!caller || caller.role !== 'SUPER_ADMIN') {
      return NextResponse.json({ success: false, message: 'Unauthorized - SUPER_ADMIN required' }, { status: 401 })
    }
    
    const body = await req.json()
    const { phone, password: rawPassword } = body
    
    if (!phone) {
      return NextResponse.json({ success: false, message: 'phone is required' }, { status: 400 })
    }
    
    const normalizedPhone = phone.replace(/[^0-9]/g, '')
    
    // 1. Find company with this portal_phone
    const { data: companies, error: companiesError } = await supabaseAdmin
      .from('parties')
      .select('id, name, party_code, portal_phone, portal_password_hash, party_type_id')
      .or(`portal_phone.eq.${phone},portal_phone.eq.${normalizedPhone},portal_phone.ilike.%${normalizedPhone}%`)
      .eq('status', 'ACTIVE')
      
    if (companiesError) {
      return NextResponse.json({ success: false, message: `Database error: ${companiesError.message}` }, { status: 500 })
    }
    
    if (!companies || companies.length === 0) {
      return NextResponse.json({ 
        success: false, 
        message: `No active company found with phone ${phone}`,
        hint: 'Make sure the company is registered with this phone as portal_phone'
      }, { status: 404 })
    }
    
    const company = companies[0]
    
    // 2. Check if admin user already exists for this company
    const { data: existingUsers } = await supabaseAdmin
      .from('users')
      .select('id, name, email, phone, party_id, role_id, roles(name)')
      .eq('party_id', company.id)
      
    const existingAdmin = (existingUsers || []).find(u => {
      const roles = u.roles as { name: string } | { name: string }[] | null
      const roleName = Array.isArray(roles) ? roles[0]?.name : roles?.name
      return roleName === 'ADMIN'
    })
    
    if (existingAdmin) {
      // Admin exists - update password if provided
      if (rawPassword) {
        await supabaseAdmin.auth.admin.updateUserById(existingAdmin.id, { password: rawPassword })
        const hash = crypto.createHash('sha256').update(rawPassword).digest('hex')
        await supabaseAdmin.from('parties').update({ portal_password_hash: hash }).eq('id', company.id)
      }
      
      // Ensure phone and email are correct
      const correctEmail = `${normalizedPhone}_${company.id.substring(0, 8)}@portal.internal`
      if (existingAdmin.phone !== normalizedPhone || existingAdmin.email !== correctEmail) {
        await supabaseAdmin.from('users')
          .update({ phone: normalizedPhone, email: correctEmail })
          .eq('id', existingAdmin.id)
      }
      
      return NextResponse.json({
        success: true,
        message: 'Admin user already exists. Password updated.',
        data: {
          company_id: company.id,
          company_name: company.name,
          user_id: existingAdmin.id,
          email: correctEmail,
          phone: normalizedPhone
        }
      })
    }
    
    // 3. No admin user - create one
    // Password priority: provided > portal_password_hash (can't decrypt) > require password
    if (!rawPassword) {
      return NextResponse.json({
        success: false,
        message: 'No admin user exists for this company. Please provide a password to create one.',
        company_id: company.id,
        company_name: company.name,
        portal_phone: company.portal_phone
      }, { status: 400 })
    }
    
    // Get ADMIN role
    const { data: adminRole } = await supabaseAdmin
      .from('roles')
      .select('id')
      .eq('name', 'ADMIN')
      .single()
      
    if (!adminRole) {
      return NextResponse.json({ success: false, message: 'ADMIN role not found in database' }, { status: 500 })
    }
    
    // Create auth user
    const portalEmail = `${normalizedPhone}_${company.id.substring(0, 8)}@portal.internal`
    
    const { data: authCreated, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email: portalEmail,
      password: rawPassword,
      email_confirm: true,
    })
    
    if (authError || !authCreated?.user) {
      return NextResponse.json({ success: false, message: `Auth user creation failed: ${authError?.message}` }, { status: 500 })
    }
    
    // Create users table record
    const { error: usersError } = await supabaseAdmin.from('users').insert({
      id: authCreated.user.id,
      name: company.name || 'Company Admin',
      email: portalEmail,
      phone: normalizedPhone,
      role_id: adminRole.id,
      party_id: company.id,
      status: 'ACTIVE',
    })
    
    if (usersError) {
      // Rollback auth user
      await supabaseAdmin.auth.admin.deleteUser(authCreated.user.id)
      return NextResponse.json({ success: false, message: `Users record creation failed: ${usersError.message}` }, { status: 500 })
    }
    
    // Update party portal_password_hash
    const hash = crypto.createHash('sha256').update(rawPassword).digest('hex')
    await supabaseAdmin.from('parties')
      .update({ portal_password_hash: hash, portal_phone: normalizedPhone })
      .eq('id', company.id)
    
    return NextResponse.json({
      success: true,
      message: 'Admin user created successfully',
      data: {
        company_id: company.id,
        company_name: company.name,
        user_id: authCreated.user.id,
        email: portalEmail,
        phone: normalizedPhone,
        role: 'ADMIN'
      }
    })
    
  } catch (err) {
    console.error('[PROVISION-ADMIN] Error:', err)
    return NextResponse.json({
      success: false,
      message: err instanceof Error ? err.message : 'Unknown error'
    }, { status: 500 })
  }
}