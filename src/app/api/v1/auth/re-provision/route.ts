import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, getUserFromToken } from '@/lib/supabase-server'

/**
 * POST /api/v1/auth/re-provision
 * Re-provisions the admin auth account for a company whose admin user
 * was not created (or was created incorrectly) during company registration.
 *
 * Body: { company_id: string, password?: string }
 * - company_id: The party ID of the company
 * - password: Optional new password. If not provided, uses the existing portal_password_hash
 *
 * Requires SUPER_ADMIN auth.
 */
export async function POST(req: NextRequest) {
  try {
    const caller = await getUserFromToken(req)
    if (!caller || caller.role !== 'SUPER_ADMIN') {
      return NextResponse.json({ success: false, message: 'Unauthorized - SUPER_ADMIN required' }, { status: 401 })
    }

    const body = await req.json()
    const { company_id, password: rawPassword } = body

    if (!company_id) {
      return NextResponse.json({ success: false, message: 'company_id is required' }, { status: 400 })
    }

    // Step 1: Look up the company
    const { data: company, error: companyErr } = await supabaseAdmin
      .from('parties')
      .select('id, name, party_code, portal_phone, portal_password_hash, status')
      .eq('id', company_id)
      .single()

    if (companyErr || !company) {
      return NextResponse.json({ success: false, message: 'Company not found' }, { status: 404 })
    }

    if (company.status === 'DELETED') {
      return NextResponse.json({ success: false, message: 'Company is deleted' }, { status: 400 })
    }

    if (!company.portal_phone) {
      return NextResponse.json({ success: false, message: 'Company has no portal_phone set. Cannot provision admin account.' }, { status: 400 })
    }

    // Normalize phone
    const phone = String(company.portal_phone).replace(/[^0-9]/g, '')

    // Step 2: Find ADMIN role
    const { data: roleRow, error: roleErr } = await supabaseAdmin
      .from('roles')
      .select('id')
      .eq('name', 'ADMIN')
      .single()

    if (roleErr || !roleRow) {
      return NextResponse.json({ success: false, message: 'ADMIN role not found in database' }, { status: 500 })
    }

    // Step 3: Check if admin user already exists for this company
    const { data: existingUsers } = await supabaseAdmin
      .from('users')
      .select('id, email, phone, party_id, role_id, roles:role_id(name)')
      .eq('party_id', company_id)

    const existingAdmin = (existingUsers || []).find(u => {
      const roleName = Array.isArray(u.roles) ? u.roles[0]?.name : (u.roles as { name: string } | null)?.name
      return roleName === 'ADMIN'
    })

    // Also check for any user with matching phone
    const phoneMatch = (existingUsers || []).find(u => {
      if (!u.phone) return false
      const uPhone = u.phone.replace(/[^0-9]/g, '')
      return uPhone === phone
    })

    const portalEmail = `${phone}_${company_id.substring(0, 8)}@portal.internal`
    const password = rawPassword || null

    let authUserId: string | null = null
    const actions: string[] = []

    if (existingAdmin) {
      authUserId = existingAdmin.id
      actions.push(`Found existing admin user (${existingAdmin.id.substring(0, 8)}...)`)

      // Update email if wrong format
      if (existingAdmin.email !== portalEmail) {
        await supabaseAdmin.from('users').update({ email: portalEmail }).eq('id', existingAdmin.id)
        actions.push(`Updated email from ${existingAdmin.email} to ${portalEmail}`)
      }

      // Update phone if missing/wrong
      if (existingAdmin.phone !== phone) {
        await supabaseAdmin.from('users').update({ phone }).eq('id', existingAdmin.id)
        actions.push(`Updated phone from ${existingAdmin.phone} to ${phone}`)
      }

      // Update password if provided
      if (password) {
        const { error: pwErr } = await supabaseAdmin.auth.admin.updateUserById(existingAdmin.id, { password })
        if (pwErr) {
          return NextResponse.json({ success: false, message: `Failed to update password: ${pwErr.message}` }, { status: 500 })
        }
        actions.push('Updated auth password')
      }
    } else if (phoneMatch) {
      // User exists with this phone but not as admin for this company - update to be admin
      authUserId = phoneMatch.id
      actions.push(`Found user with matching phone (${phoneMatch.id.substring(0, 8)}...), promoting to admin`)

      await supabaseAdmin.from('users').update({
        email: portalEmail,
        phone,
        role_id: roleRow.id,
        party_id: company_id,
        status: 'ACTIVE',
      }).eq('id', phoneMatch.id)
      actions.push('Updated user record with ADMIN role and correct party_id')

      if (password) {
        const { error: pwErr } = await supabaseAdmin.auth.admin.updateUserById(phoneMatch.id, { password })
        if (pwErr) {
          return NextResponse.json({ success: false, message: `Failed to update password: ${pwErr.message}` }, { status: 500 })
        }
        actions.push('Updated auth password')
      }
    } else {
      // No admin user exists at all - create one
      actions.push('No admin user found, creating new one')

      if (!password) {
        return NextResponse.json({
          success: false,
          message: 'No existing admin user found and no password provided. Please provide a password to create the admin account.',
        }, { status: 400 })
      }

      // Create auth user
      const { data: authCreated, error: authErr } = await supabaseAdmin.auth.admin.createUser({
        email: portalEmail,
        password,
        email_confirm: true,
      })

      if (authErr || !authCreated?.user) {
        return NextResponse.json({ success: false, message: `Auth user creation failed: ${authErr?.message}` }, { status: 500 })
      }

      authUserId = authCreated.user.id
      actions.push(`Created auth user (${authUserId.substring(0, 8)}...)`)

      // Create users record
      const { error: usersErr } = await supabaseAdmin.from('users').insert({
        id: authUserId,
        name: company.name || 'Company Admin',
        email: portalEmail,
        phone,
        role_id: roleRow.id,
        party_id: company_id,
        status: 'ACTIVE',
      })

      if (usersErr) {
        // Rollback auth user
        await supabaseAdmin.auth.admin.deleteUser(authUserId)
        return NextResponse.json({ success: false, message: `Users record creation failed: ${usersErr.message}` }, { status: 500 })
      }

      actions.push('Created users record with ADMIN role')
    }

    // Update party portal_password_hash if new password provided
    if (password) {
      const { createHash } = await import('crypto')
      const hash = createHash('sha256').update(password).digest('hex')
      await supabaseAdmin.from('parties').update({
        portal_password_hash: hash,
        portal_phone: phone,
      }).eq('id', company_id)
      actions.push('Updated party portal credentials')
    }

    return NextResponse.json({
      success: true,
      message: 'Admin account re-provisioned successfully',
      data: {
        company_id,
        company_name: company.name,
        company_code: company.party_code,
        phone,
        email: portalEmail,
        actions,
      },
    })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Re-provisioning failed' },
      { status: 500 }
    )
  }
}
