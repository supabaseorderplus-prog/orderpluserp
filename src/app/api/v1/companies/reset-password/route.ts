import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, getUserFromToken } from '@/lib/supabase-server'
import * as crypto from 'crypto'

function normalizePhone(phone: string | null): string | null {
  if (!phone) return null
  return phone.replace(/[^0-9]/g, '')
}

type UserTableName = 'app_users' | 'users'
type AdminUserRow = {
  id: string
  email: string | null
  phone: string | null
  role_id: string | null
}

async function resolveUserTable(): Promise<UserTableName> {
  const { error: appUsersError } = await supabaseAdmin.from('app_users').select('id').limit(0)
  return appUsersError ? 'users' : 'app_users'
}

async function findAdminUserInBothTables(companyId: string, roleId: string): Promise<{ user: AdminUserRow; table: UserTableName } | null> {
  const [appRes, usersRes] = await Promise.all([
    supabaseAdmin.from('app_users').select('id, email, phone, role_id').eq('party_id', companyId).eq('role_id', roleId),
    supabaseAdmin.from('users').select('id, email, phone, role_id').eq('party_id', companyId).eq('role_id', roleId),
  ])
  const appUser = (appRes.data || [])[0] as AdminUserRow | undefined
  if (appUser) return { user: appUser, table: 'app_users' }
  const usersUser = (usersRes.data || [])[0] as AdminUserRow | undefined
  if (usersUser) return { user: usersUser, table: 'users' }
  return null
}

async function findAuthUserByEmail(email: string): Promise<{ id: string; email?: string } | null> {
  const { data, error } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 })
  if (error) return null

  const target = email.toLowerCase()
  const user = data.users.find((u) => (u.email || '').toLowerCase() === target)
  return user ? { id: user.id, email: user.email } : null
}

export async function POST(req: NextRequest) {
  const caller = await getUserFromToken(req)
  if (!caller || caller.role !== 'SUPER_ADMIN') {
    return NextResponse.json({ success: false, message: 'Forbidden' }, { status: 403 })
  }

  const body = await req.json()
  const { company_id, new_password } = body

  if (!company_id || !new_password || new_password.length < 6) {
    return NextResponse.json({ success: false, message: 'company_id and new_password (min 6 chars) required' }, { status: 400 })
  }

  const hash = crypto.createHash('sha256').update(new_password).digest('hex')

  const { data: company, error: companyError } = await supabaseAdmin
    .from('parties')
    .select('id, portal_phone, name')
    .eq('id', company_id)
    .single()

  if (companyError || !company) {
    return NextResponse.json({ success: false, message: 'Company not found' }, { status: 404 })
  }

  const normalizedPhone = normalizePhone(company.portal_phone)

  const { error: partyUpdateError } = await supabaseAdmin
    .from('parties')
    .update({ portal_password_hash: hash, portal_phone: normalizedPhone, updated_at: new Date().toISOString() })
    .eq('id', company_id)

  if (partyUpdateError) {
    return NextResponse.json({ success: false, message: partyUpdateError.message }, { status: 500 })
  }

  const fallbackEmail = normalizedPhone ? `${normalizedPhone}_${company_id.substring(0, 8)}@portal.internal` : null
  const userTable = await resolveUserTable()

  const { data: roleRow, error: roleLookupError } = await supabaseAdmin
    .from('roles')
    .select('id')
    .eq('name', 'ADMIN')
    .single()

  if (roleLookupError || !roleRow?.id) {
    return NextResponse.json({ success: false, message: 'ADMIN role not found' }, { status: 500 })
  }

  // Check both tables — admin may live in either app_users or users
  const found = await findAdminUserInBothTables(company_id, roleRow.id)
  const adminUser = found?.user || null
  const adminTable = found?.table || userTable
  const authUserId = adminUser?.id || null

  if (authUserId && adminUser) {
    const { error: authUpdateError } = await supabaseAdmin.auth.admin.updateUserById(authUserId, {
      password: new_password,
    })

    if (authUpdateError) {
      return NextResponse.json({ success: false, message: authUpdateError.message }, { status: 500 })
    }

    // Sync email/phone in the user record if out of date
    if (normalizedPhone) {
      const correctEmail = `${normalizedPhone}_${company_id.substring(0, 8)}@portal.internal`
      if (adminUser.email !== correctEmail || adminUser.phone !== normalizedPhone) {
        await supabaseAdmin
          .from(adminTable)
          .update({ email: correctEmail, phone: normalizedPhone })
          .eq('id', authUserId)
        // Also update Supabase Auth email to stay in sync
        await supabaseAdmin.auth.admin.updateUserById(authUserId, { email: correctEmail })
          .catch(() => null)
      }
    }
  } else if (fallbackEmail && normalizedPhone) {
    // No admin user exists - create one
    let authUserIdForInsert: string | null = null
    let authEmailForInsert = fallbackEmail
    let createdNewAuthUser = false

    const { data: createdUser, error: createAuthError } = await supabaseAdmin.auth.admin.createUser({
      email: fallbackEmail,
      password: new_password,
      email_confirm: true,
    })

    if (createAuthError) {
      const message = createAuthError.message || ''
      if (message.toLowerCase().includes('already') || message.toLowerCase().includes('duplicate')) {
        const existingAuthUser = await findAuthUserByEmail(fallbackEmail)
        if (!existingAuthUser) {
          return NextResponse.json({ success: false, message }, { status: 500 })
        }

        const { error: authUpdateError } = await supabaseAdmin.auth.admin.updateUserById(existingAuthUser.id, {
          password: new_password,
        })
        if (authUpdateError) {
          return NextResponse.json({ success: false, message: authUpdateError.message }, { status: 500 })
        }
        authUserIdForInsert = existingAuthUser.id
        authEmailForInsert = existingAuthUser.email || fallbackEmail
      } else {
        return NextResponse.json({ success: false, message }, { status: 500 })
      }
    } else {
      authUserIdForInsert = createdUser.user.id
      authEmailForInsert = createdUser.user.email || fallbackEmail
      createdNewAuthUser = true
    }

    const { error: appUserInsertError } = await supabaseAdmin
      .from(userTable)
      .insert({
        id: authUserIdForInsert,
        name: company.name || 'Company Admin',
        email: authEmailForInsert,
        phone: normalizedPhone,
        role_id: roleRow.id,
        party_id: company_id,
        status: 'ACTIVE',
      })

    if (appUserInsertError) {
      if (createdNewAuthUser && authUserIdForInsert) {
        await supabaseAdmin.auth.admin.deleteUser(authUserIdForInsert)
      }
      return NextResponse.json({ success: false, message: appUserInsertError.message }, { status: 500 })
    }
  } else {
    return NextResponse.json({ success: false, message: 'Company has no portal_phone set. Cannot create admin account.' }, { status: 400 })
  }

  return NextResponse.json({ success: true, message: 'Password updated and admin account provisioned successfully' })
}
