import { NextRequest, NextResponse } from 'next/server'
import { createHash } from 'crypto'
import { getPartyDescendants, getUserFromToken, resolveCompanyScope, supabaseAdmin } from '@/lib/supabase-server'

type UserTableName = 'app_users' | 'users'

type PartyRow = {
  id: string
  name: string | null
  party_code: string | null
  party_type_id: string | null
  status: string | null
  contact_person?: string | null
  portal_phone?: string | null
  contact_phone?: string | null
  phone?: string | null
}

type PortalUserRow = {
  id: string
  name: string | null
  email: string | null
  phone: string | null
  role_id: string | null
  party_id: string | null
}

const PARTY_TYPE_ROLE_MAP: Record<string, string> = {
  COMPANY: 'ADMIN',
  MANUFACTURER: 'ADMIN',
  CNF: 'CNF_USER',
  SUPER_DEALER: 'SUPER_DEALER_USER',
  RETAILER: 'RETAILER_USER',
}

function normalizePhone(phone: unknown): string {
  return String(phone || '').replace(/[^0-9]/g, '')
}

function hashPassword(password: string): string {
  return createHash('sha256').update(password).digest('hex')
}

function isMissingColumnError(error: { code?: string; message?: string } | null | undefined): boolean {
  const message = (error?.message || '').toLowerCase()
  return (
    error?.code === '42703' ||
    error?.code === 'PGRST204' ||
    message.includes('column') ||
    message.includes('schema cache')
  )
}

async function tableExists(tableName: UserTableName): Promise<boolean> {
  const { error } = await supabaseAdmin.from(tableName).select('id').limit(0)
  return !error
}

async function getAvailableUserTables(): Promise<UserTableName[]> {
  const [hasAppUsers, hasUsers] = await Promise.all([
    tableExists('app_users'),
    tableExists('users'),
  ])

  const tables: UserTableName[] = []
  if (hasAppUsers) tables.push('app_users')
  if (hasUsers) tables.push('users')
  return tables
}

async function findAuthUserByEmail(email: string): Promise<{ id: string; email?: string } | null> {
  const { data, error } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 })
  if (error) return null

  const target = email.toLowerCase()
  const user = data.users.find((u) => (u.email || '').toLowerCase() === target)
  return user ? { id: user.id, email: user.email } : null
}

async function assertPartyAccess(req: NextRequest, partyId: string) {
  const caller = await getUserFromToken(req)
  if (!caller || (caller.role !== 'ADMIN' && caller.role !== 'SUPER_ADMIN')) {
    return { ok: false as const, response: NextResponse.json({ success: false, message: 'Forbidden' }, { status: 403 }) }
  }

  const companyId = await resolveCompanyScope(req, caller)
  if (caller.role === 'SUPER_ADMIN' && !companyId) {
    return { ok: true as const, caller, companyId }
  }

  if (!companyId) {
    return { ok: false as const, response: NextResponse.json({ success: false, message: 'Company scope is required' }, { status: 400 }) }
  }

  if (partyId === companyId) {
    return { ok: true as const, caller, companyId }
  }

  const descendants = await getPartyDescendants(companyId)
  if (!descendants.some((row) => row.id === partyId)) {
    return { ok: false as const, response: NextResponse.json({ success: false, message: 'Party not found or access denied' }, { status: 403 }) }
  }

  return { ok: true as const, caller, companyId }
}

async function fetchParty(partyId: string): Promise<PartyRow | null> {
  const { data, error } = await supabaseAdmin
    .from('parties')
    .select('*')
    .eq('id', partyId)
    .maybeSingle()

  if (error) throw new Error(error.message)
  return (data as PartyRow | null) || null
}

async function resolvePartyTypeName(partyTypeId: string | null): Promise<string> {
  if (!partyTypeId) return ''

  const { data, error } = await supabaseAdmin
    .from('party_types')
    .select('name')
    .eq('id', partyTypeId)
    .maybeSingle()

  if (error) throw new Error(error.message)
  return (data?.name || '').toUpperCase()
}

async function fetchPortalUsers(tableName: UserTableName, partyId: string): Promise<PortalUserRow[]> {
  const { data, error } = await supabaseAdmin
    .from(tableName)
    .select('id, name, email, phone, role_id, party_id')
    .eq('party_id', partyId)

  if (error) {
    console.warn(`[PARTY PASSWORD] ${tableName} lookup failed:`, error.message)
    return []
  }

  return (data || []) as PortalUserRow[]
}

async function updatePartyPortalFields(partyId: string, phone: string, password: string) {
  const [portalPhoneProbe, portalPasswordProbe, updatedAtProbe] = await Promise.all([
    supabaseAdmin.from('parties').select('portal_phone').limit(0),
    supabaseAdmin.from('parties').select('portal_password_hash').limit(0),
    supabaseAdmin.from('parties').select('updated_at').limit(0),
  ])

  const payload: Record<string, unknown> = {}
  if (!portalPhoneProbe.error) payload.portal_phone = phone
  if (!portalPasswordProbe.error) payload.portal_password_hash = hashPassword(password)
  if (!updatedAtProbe.error) payload.updated_at = new Date().toISOString()
  if (Object.keys(payload).length === 0) return

  const { error } = await supabaseAdmin
    .from('parties')
    .update(payload)
    .eq('id', partyId)

  if (error && !isMissingColumnError(error)) {
    throw new Error(error.message)
  }
}

async function upsertPortalUserRecord(params: {
  tableName: UserTableName
  authUserId: string
  name: string
  email: string
  phone: string
  roleId: string
  partyId: string
}) {
  const payload = {
    id: params.authUserId,
    name: params.name,
    email: params.email,
    phone: params.phone,
    role_id: params.roleId,
    party_id: params.partyId,
    status: 'ACTIVE',
  }

  const { error } = await supabaseAdmin
    .from(params.tableName)
    .upsert(payload, { onConflict: 'id' })

  if (error) throw new Error(error.message)
}

async function updateExistingPortalUserRecords(params: {
  tables: UserTableName[]
  existingRows: Array<PortalUserRow & { tableName: UserTableName }>
  name: string
  email: string
  phone: string
  roleId: string
  partyId: string
}) {
  await Promise.all(params.existingRows.map(async (row) => {
    const { error } = await supabaseAdmin
      .from(row.tableName)
      .update({
        name: row.name || params.name,
        email: row.email || params.email,
        phone: params.phone,
        role_id: params.roleId,
        party_id: params.partyId,
        status: 'ACTIVE',
      })
      .eq('id', row.id)

    if (error) {
      console.warn(`[PARTY PASSWORD] ${row.tableName} update failed:`, error.message)
    }
  }))

  const primaryTable = params.tables[0]
  const hasPrimaryRow = params.existingRows.some((row) => row.tableName === primaryTable)
  if (!hasPrimaryRow && params.existingRows[0]) {
    await upsertPortalUserRecord({
      tableName: primaryTable,
      authUserId: params.existingRows[0].id,
      name: params.name,
      email: params.existingRows[0].email || params.email,
      phone: params.phone,
      roleId: params.roleId,
      partyId: params.partyId,
    })
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: partyId } = await params
    const access = await assertPartyAccess(req, partyId)
    if (!access.ok) return access.response

    const body = await req.json()
    const newPassword = String(body.new_password || body.password || '')
    if (newPassword.length < 6) {
      return NextResponse.json({ success: false, message: 'New password must be at least 6 characters' }, { status: 400 })
    }

    const party = await fetchParty(partyId)
    if (!party || party.status === 'DELETED') {
      return NextResponse.json({ success: false, message: 'Party not found' }, { status: 404 })
    }

    const phone = normalizePhone(body.phone || party.portal_phone || party.contact_phone || party.phone)
    if (phone.length < 10) {
      return NextResponse.json({ success: false, message: 'A valid party mobile number is required before setting a password' }, { status: 400 })
    }

    const typeName = await resolvePartyTypeName(party.party_type_id)
    const roleName = PARTY_TYPE_ROLE_MAP[typeName] || (typeName ? `${typeName}_USER` : '')
    if (!roleName) {
      return NextResponse.json({ success: false, message: 'No portal role is configured for this party type' }, { status: 400 })
    }

    const { data: roleRow, error: roleError } = await supabaseAdmin
      .from('roles')
      .select('id')
      .eq('name', roleName)
      .maybeSingle()

    if (roleError || !roleRow?.id) {
      return NextResponse.json({ success: false, message: `${roleName} role not found` }, { status: 500 })
    }

    const userTables = await getAvailableUserTables()
    if (userTables.length === 0) {
      return NextResponse.json({ success: false, message: 'No user table is available for portal accounts' }, { status: 500 })
    }

    const userRowsByTable = await Promise.all(userTables.map(async (tableName) => {
      const rows = await fetchPortalUsers(tableName, partyId)
      return rows.map((row) => ({ ...row, tableName }))
    }))
    const existingRows = userRowsByTable.flat()
    const roleMatchedRows = existingRows.filter((row) => row.role_id === roleRow.id)
    const phoneMatchedRows = existingRows.filter((row) => normalizePhone(row.phone) === phone)
    const selectedRow = roleMatchedRows[0] || phoneMatchedRows[0] || null

    const portalEmail = `${phone}_${partyId.substring(0, 8)}@portal.internal`
    const displayName = (party.contact_person || party.name || 'Portal User').trim()
    let authUserId = selectedRow?.id || null
    let authEmail = selectedRow?.email || portalEmail
    let createdAuthUser = false

    if (authUserId) {
      const { error: authUpdateError } = await supabaseAdmin.auth.admin.updateUserById(authUserId, {
        password: newPassword,
      })

      if (authUpdateError) {
        return NextResponse.json({ success: false, message: authUpdateError.message }, { status: 500 })
      }
    } else {
      const { data: createdUser, error: createAuthError } = await supabaseAdmin.auth.admin.createUser({
        email: portalEmail,
        password: newPassword,
        email_confirm: true,
      })

      if (createAuthError) {
        const message = createAuthError.message || ''
        if (message.toLowerCase().includes('already') || message.toLowerCase().includes('duplicate') || createAuthError.status === 422) {
          const existingAuthUser = await findAuthUserByEmail(portalEmail)
          if (!existingAuthUser) {
            return NextResponse.json({ success: false, message }, { status: 500 })
          }

          const { error: authUpdateError } = await supabaseAdmin.auth.admin.updateUserById(existingAuthUser.id, {
            password: newPassword,
          })
          if (authUpdateError) {
            return NextResponse.json({ success: false, message: authUpdateError.message }, { status: 500 })
          }

          authUserId = existingAuthUser.id
          authEmail = existingAuthUser.email || portalEmail
        } else {
          return NextResponse.json({ success: false, message }, { status: 500 })
        }
      } else if (createdUser?.user) {
        authUserId = createdUser.user.id
        authEmail = createdUser.user.email || portalEmail
        createdAuthUser = true
      }
    }

    if (!authUserId) {
      return NextResponse.json({ success: false, message: 'Could not create or update portal auth user' }, { status: 500 })
    }

    try {
      if (selectedRow) {
        await updateExistingPortalUserRecords({
          tables: userTables,
          existingRows: roleMatchedRows.length > 0 ? roleMatchedRows : [selectedRow],
          name: displayName,
          email: authEmail,
          phone,
          roleId: roleRow.id,
          partyId,
        })
      } else {
        await upsertPortalUserRecord({
          tableName: userTables[0],
          authUserId,
          name: displayName,
          email: authEmail,
          phone,
          roleId: roleRow.id,
          partyId,
        })
      }
    } catch (userRecordError) {
      if (createdAuthUser) {
        await supabaseAdmin.auth.admin.deleteUser(authUserId).catch(() => null)
      }
      throw userRecordError
    }

    await updatePartyPortalFields(partyId, phone, newPassword)

    return NextResponse.json({
      success: true,
      message: 'Party password updated successfully',
      data: {
        party_id: partyId,
        phone,
        role: roleName,
      },
    })
  } catch (err) {
    console.error('[PARTY PASSWORD] Error:', err)
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed to update party password' },
      { status: 500 }
    )
  }
}
