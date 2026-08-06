import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, getUserFromToken } from '@/lib/supabase-server'
import { createHash } from 'crypto'

function hashPassword(plain: string): string {
  return createHash('sha256').update(plain).digest('hex')
}

export async function POST(req: NextRequest) {
  try {
    const caller = await getUserFromToken(req)
    if (!caller || caller.role !== 'SUPER_ADMIN') {
      return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 })
    }

    const { party_id, phone: rawPhone, password } = await req.json()
    if (!party_id || !rawPhone || !password) {
      return NextResponse.json({ success: false, message: 'party_id, phone, and password are required' }, { status: 400 })
    }
    // Normalize phone: strip non-digit characters
    const phone = String(rawPhone).replace(/[^0-9]/g, '')

    // Get the company (party)
    const { data: party, error: partyErr } = await supabaseAdmin
      .from('parties')
      .select('id, name, party_code')
      .eq('id', party_id)
      .single()

    if (partyErr || !party) {
      return NextResponse.json({ success: false, message: 'Company not found' }, { status: 404 })
    }

    // Find ADMIN role
    const { data: roleRow } = await supabaseAdmin
      .from('roles')
      .select('id')
      .eq('name', 'ADMIN')
      .single()

    if (!roleRow) {
      return NextResponse.json({ success: false, message: 'ADMIN role not found in database' }, { status: 500 })
    }

    // Check if users record already exists with this phone for this party
    const { data: existingUsers } = await supabaseAdmin
      .from('users')
      .select('id, email, phone, party_id')
      .eq('phone', phone)
      .eq('party_id', party_id)

    const existingUser = existingUsers && existingUsers.length > 0 ? existingUsers[0] : null

    // Generate portal email
    const companySuffix = party_id.substring(0, 8)
    const portalEmail = `${phone}_${companySuffix}@portal.internal`

    let authUserId: string

    if (existingUser) {
      // Update existing auth user's password
      const { error: updateErr } = await supabaseAdmin.auth.admin.updateUserById(existingUser.id, { password })
      if (updateErr) {
        return NextResponse.json({ success: false, message: `Failed to update auth user: ${updateErr.message}` }, { status: 500 })
      }
      authUserId = existingUser.id

      // Update users record if needed
      if (!existingUser.email || !existingUser.email.includes(portalEmail)) {
        await supabaseAdmin.from('users').update({
          email: portalEmail,
          party_id: party_id,
          role_id: roleRow.id,
          status: 'ACTIVE',
        }).eq('id', existingUser.id)
      }
    } else {
      // Create new auth user
      const { data: authCreated, error: authErr } = await supabaseAdmin.auth.admin.createUser({
        email: portalEmail,
        password,
        email_confirm: true,
      })

      if (authErr) {
        return NextResponse.json({ success: false, message: `Auth user creation failed: ${authErr.message}` }, { status: 500 })
      }

      if (!authCreated?.user) {
        return NextResponse.json({ success: false, message: 'Auth user creation returned no user' }, { status: 500 })
      }

      authUserId = authCreated.user.id

      // Create users record
      const { error: usersErr } = await supabaseAdmin.from('users').insert({
        id: authUserId,
        name: party.name || 'Company Admin',
        email: portalEmail,
        phone,
        role_id: roleRow.id,
        party_id: party_id,
        status: 'ACTIVE',
      })

      if (usersErr) {
        // Rollback auth user
        await supabaseAdmin.auth.admin.deleteUser(authUserId)
        return NextResponse.json({ success: false, message: `Users record creation failed: ${usersErr.message}` }, { status: 500 })
      }
    }

    // Update party with portal credentials
    await supabaseAdmin.from('parties').update({
      portal_phone: phone,
      portal_password_hash: hashPassword(password),
    }).eq('id', party_id)

    return NextResponse.json({
      success: true,
      message: 'Admin account provisioned successfully',
      data: {
        email: portalEmail,
        phone,
        party_id,
        party_name: party.name,
      }
    })
  } catch (err) {
    return NextResponse.json({ success: false, message: err instanceof Error ? err.message : 'Failed' }, { status: 500 })
  }
}
