import fs from 'node:fs'
import path from 'node:path'

import { runDirectSql } from '@/lib/direct-sql'
import { supabaseAdmin, type AuthUser } from '@/lib/supabase-server'

export const SUPPORT_ADMIN_ROLES = new Set(['ADMIN', 'SUPER_ADMIN'])
export const SUPPORT_STAFF_ROLES = new Set([
  'SALESMAN',
  'DRIVER',
  'SALES_MANAGER',
  'TERRITORY_MANAGER',
  'WAREHOUSE_MANAGER',
  'ACCOUNTS_MANAGER',
  'AUDITOR',
])

const SUPPORT_CHAT_SCHEMA_NOT_READY_MESSAGE = 'Support chat database migration has not been applied yet.'

let supportSchemaEnsurePromise: Promise<boolean> | null = null
let supportSchemaEnsured = false

function supportMigrationSql(): string {
  return fs.readFileSync(
    path.join(process.cwd(), 'supabase/migrations/20260705050000_create_support_chat.sql'),
    'utf8',
  )
}

function errorText(error: unknown): string {
  if (!error || typeof error !== 'object') return ''
  const candidate = error as { message?: unknown; details?: unknown; hint?: unknown }
  return [candidate.message, candidate.details, candidate.hint]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join(' | ')
}

function isMissingExecSql(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: string }).code === 'PGRST202'
}

export function isSupportSchemaGap(error: unknown): boolean {
  const text = errorText(error)
  return text.includes('support_conversations')
    || text.includes('support_messages')
    || text.includes('schema cache')
    || text.includes(SUPPORT_CHAT_SCHEMA_NOT_READY_MESSAGE)
    || (typeof error === 'object' && error !== null && 'code' in error && (error as { code?: string }).code === 'PGRST205')
}

async function runSupportSchemaSql(sql: string): Promise<boolean> {
  const { error } = await supabaseAdmin.rpc('exec_sql', { sql })
  if (!error) return true
  if (!isMissingExecSql(error)) {
    console.warn('[support-chat] exec_sql failed:', errorText(error))
  }
  return runDirectSql(sql)
}

async function supportTablesExist(): Promise<boolean> {
  const { error } = await supabaseAdmin.from('support_conversations').select('id').limit(1)
  return !error
}

export async function ensureSupportChatSchema(): Promise<boolean> {
  if (supportSchemaEnsured) return true
  if (supportSchemaEnsurePromise) return supportSchemaEnsurePromise

  supportSchemaEnsurePromise = (async () => {
    if (await supportTablesExist()) {
      supportSchemaEnsured = true
      return true
    }

    try {
      const sql = supportMigrationSql()
      const applied = await runSupportSchemaSql(sql)
      if (!applied) return false
      const ready = await supportTablesExist()
      supportSchemaEnsured = ready
      return ready
    } catch (error) {
      console.warn('[support-chat] schema ensure failed:', errorText(error) || error)
      return false
    } finally {
      supportSchemaEnsurePromise = null
    }
  })()

  return supportSchemaEnsurePromise
}

export { SUPPORT_CHAT_SCHEMA_NOT_READY_MESSAGE }

export function isSupportAdmin(role: string) {
  return SUPPORT_ADMIN_ROLES.has(role)
}

export function canUseSupport(user: AuthUser | null): user is AuthUser {
  if (!user) return false
  return isSupportAdmin(user.role) || !SUPPORT_STAFF_ROLES.has(user.role)
}

export async function resolveSupportCompanyId(
  user: AuthUser,
  requestedCompanyId: string | null,
): Promise<string | null> {
  if (user.role === 'SUPER_ADMIN') return requestedCompanyId
  if (!user.party_id) return null

  let current = user.party_id
  const visited = new Set<string>()
  for (let depth = 0; depth < 12; depth++) {
    if (visited.has(current)) return current
    visited.add(current)
    const { data, error } = await supabaseAdmin
      .from('parties')
      .select('parent_party_id')
      .eq('id', current)
      .maybeSingle()
    if (error || !data?.parent_party_id) return current
    current = data.parent_party_id
  }
  return current
}

export async function loadPartyContact(partyId: string | null) {
  if (!partyId) return null
  const { data } = await supabaseAdmin.from('parties').select('*').eq('id', partyId).maybeSingle()
  if (!data) return null
  return {
    id: String(data.id),
    name: String(data.name || 'Party'),
    code: data.party_code ? String(data.party_code) : null,
    phone: String(data.portal_phone || data.contact_phone || data.phone || '').replace(/\D/g, '') || null,
  }
}

export function buildWhatsAppUrl(input: {
  phone: string | null
  ticketNumber: string
  subject: string
  accessKey: string
}) {
  if (!input.phone) return null
  const site = (process.env.NEXT_PUBLIC_SITE_URL || '').replace(/\/$/, '')
  const deepLink = site ? `${site}/dashboard/support?ticket=${encodeURIComponent(input.ticketNumber)}` : ''
  const message = [
    `Hello, I want to continue support ticket ${input.ticketNumber} on WhatsApp.`,
    `Subject: ${input.subject}`,
    deepLink ? `Open secure chat: ${deepLink}` : '',
    `Reference: ${input.accessKey.slice(0, 8)}`,
  ].filter(Boolean).join('\n')
  return `https://wa.me/${input.phone}?text=${encodeURIComponent(message)}`
}

export async function notifyCompanyAdmins(input: {
  companyId: string
  ticketNumber: string
  partyName: string
  subject: string
}) {
  try {
    const { data: roles } = await supabaseAdmin.from('roles').select('id').eq('name', 'ADMIN')
    const roleIds = (roles || []).map((role) => role.id)
    if (roleIds.length === 0) return

    let admins: { id: string }[] = []
    for (const table of ['app_users', 'users'] as const) {
      const { data, error } = await supabaseAdmin
        .from(table)
        .select('id')
        .in('role_id', roleIds)
        .eq('party_id', input.companyId)
      if (!error && data) admins.push(...data)
    }
    admins = [...new Map(admins.map((admin) => [admin.id, admin])).values()]
    if (admins.length === 0) return

    const rows = admins.map((admin) => ({
      user_id: admin.id,
      company_id: input.companyId,
      type: 'SUPPORT_CHAT',
      title: `New support chat ${input.ticketNumber}`,
      message: `${input.partyName}: ${input.subject}`,
      is_read: false,
    }))
    const full = await supabaseAdmin.from('notifications').insert(rows)
    if (!full.error) return
    await supabaseAdmin.from('notifications').insert(rows.map((row) => ({
      user_id: row.user_id,
      company_id: row.company_id,
      type: row.type,
      message: row.message,
    })))
  } catch {
    // The support inbox has its own unread counter, so notification schema
    // differences must never prevent a party from opening a conversation.
  }
}
