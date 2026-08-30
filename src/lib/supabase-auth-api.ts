import { createClient } from '@supabase/supabase-js'
import { supabaseAdmin } from '@/lib/supabase-server'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? ''

export type AuthProfile = {
  id: string
  name: string
  email: string | null
  phone: string | null
  roleId: string | null
  role: string
  partyId: string | null
  partyName: string | null
  status: string
}

type ProfileRow = {
  id: string
  name: string | null
  email: string | null
  phone: string | null
  role_id: string | null
  party_id: string | null
  status: string | null
  roles?: { name?: string | null } | Array<{ name?: string | null }> | null
}

function isMissingTable(error: { code?: string } | null) {
  return error?.code === 'PGRST205' || error?.code === '42P01'
}

function roleName(row: ProfileRow) {
  const roles = row.roles
  const value = Array.isArray(roles) ? roles[0]?.name : roles?.name
  return String(value || 'SALESMAN').trim().toUpperCase()
}

export function createPasswordAuthClient() {
  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error('Supabase authentication is not configured')
  }
  return createClient(supabaseUrl, supabaseAnonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

export function phoneVariants(value: string) {
  const trimmed = value.trim()
  const digits = trimmed.replace(/\D/g, '')
  const local = digits.length > 10 ? digits.slice(-10) : digits
  return [...new Set([
    trimmed,
    digits,
    local,
    local ? `91${local}` : '',
    local ? `+91${local}` : '',
  ].filter(Boolean))]
}

export function roleMatchesGroup(role: string, group: string | null) {
  if (!group) return true
  const normalized = role.toUpperCase()
  if (group === 'ADMIN') return normalized === 'ADMIN' || normalized === 'SUPER_ADMIN'
  if (group === 'PARTY') return ['RETAILER_USER', 'SUPER_DEALER_USER', 'CNF_USER'].includes(normalized)
  if (group === 'STAFF') return !['ADMIN', 'SUPER_ADMIN', 'RETAILER_USER', 'SUPER_DEALER_USER', 'CNF_USER'].includes(normalized)
  return true
}

export async function getAuthProfile(userId: string): Promise<AuthProfile | null> {
  let row: ProfileRow | null = null

  for (const table of ['app_users', 'users'] as const) {
    const result = await supabaseAdmin
      .from(table)
      .select('id,name,email,phone,role_id,party_id,status,roles(name)')
      .eq('id', userId)
      .maybeSingle()

    if (!result.error && result.data) {
      row = result.data as unknown as ProfileRow
      break
    }
    if (result.error && !isMissingTable(result.error)) throw result.error
  }

  if (!row) return null

  let partyName: string | null = null
  if (row.party_id) {
    const { data } = await supabaseAdmin
      .from('parties')
      .select('name')
      .eq('id', row.party_id)
      .maybeSingle()
    partyName = data?.name ?? null
  }

  return {
    id: row.id,
    name: row.name || row.email?.split('@')[0] || 'User',
    email: row.email,
    phone: row.phone,
    roleId: row.role_id,
    role: roleName(row),
    partyId: row.party_id,
    partyName,
    status: row.status || 'ACTIVE',
  }
}

export async function listProfilesByPhone(phone: string): Promise<AuthProfile[]> {
  const variants = phoneVariants(phone)
  let rows: ProfileRow[] = []

  for (const table of ['app_users', 'users'] as const) {
    const result = await supabaseAdmin
      .from(table)
      .select('id,name,email,phone,role_id,party_id,status,roles(name)')
      .in('phone', variants)
      .eq('status', 'ACTIVE')

    if (!result.error) {
      rows = (result.data || []) as unknown as ProfileRow[]
      if (rows.length > 0 || table === 'app_users') break
    } else if (!isMissingTable(result.error)) {
      throw result.error
    }
  }

  const partyIds = [...new Set(rows.map((row) => row.party_id).filter((id): id is string => Boolean(id)))]
  const partyNameById = new Map<string, string>()
  if (partyIds.length > 0) {
    const { data } = await supabaseAdmin.from('parties').select('id,name').in('id', partyIds)
    for (const party of data || []) partyNameById.set(party.id, party.name)
  }

  return Promise.all(rows.map(async (row) => {
    const { data } = await supabaseAdmin.auth.admin.getUserById(row.id)
    const metadataRole = data.user?.user_metadata?.display_role || data.user?.user_metadata?.role
    return {
      id: row.id,
      name: row.name || row.email?.split('@')[0] || 'User',
      email: row.email,
      phone: row.phone,
      roleId: row.role_id,
      role: String(metadataRole || roleName(row)).trim().toUpperCase(),
      partyId: row.party_id,
      partyName: row.party_id ? partyNameById.get(row.party_id) || null : null,
      status: row.status || 'ACTIVE',
    }
  }))
}
