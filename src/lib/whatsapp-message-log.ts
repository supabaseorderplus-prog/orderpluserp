import 'server-only'

import { supabaseAdmin } from '@/lib/supabase-server'
import {
  normalizeWhatsAppNumber,
  sendWhatsAppMessage,
  type WhatsAppDelivery,
} from '@/lib/whatsapp-automation'

export const WHATSAPP_LOG_PREFIX = 'SYSTEM_WHATSAPP_LOG::'

export type WhatsAppMessageStatus = 'QUEUED' | 'SENDING' | 'SENT' | 'DELIVERED' | 'READ' | 'FAILED'
export type WhatsAppMessageType = 'ORDER_APPROVAL' | 'INVOICE_REVIEW' | 'PAYMENT_APPROVAL' | 'SUPPORT_NOTIFICATION'
export type WhatsAppReferenceType = 'ORDER' | 'INVOICE' | 'PAYMENT' | 'SUPPORT'

export type TrackedWhatsAppInput = {
  to: string
  message: string
  companyId: string | null
  partyId?: string | null
  partyName: string
  recipientName?: string | null
  messageType: WhatsAppMessageType
  referenceType: WhatsAppReferenceType
  referenceId?: string | null
  referenceNumber?: string | null
  createdByUserId?: string | null
}

export type WhatsAppMessageLog = {
  id: string
  company_id: string | null
  party_id: string | null
  party_name: string
  recipient_name: string | null
  recipient_number: string
  message_type: WhatsAppMessageType
  reference_type: WhatsAppReferenceType
  reference_id: string | null
  reference_number: string | null
  provider: 'evolution'
  provider_message_id: string | null
  status: WhatsAppMessageStatus
  attempt_count: number
  error_message: string | null
  sent_at: string | null
  delivered_at: string | null
  read_at: string | null
  failed_at: string | null
  created_by_user_id: string | null
  created_at: string
  updated_at: string
  message_body: string
}

type NoteRow = { id: string; company_id?: string | null; note: string | null }

function encode(log: WhatsAppMessageLog): string {
  return `${WHATSAPP_LOG_PREFIX}${JSON.stringify(log)}`
}

function decode(note: string | null): WhatsAppMessageLog | null {
  if (!note?.startsWith(WHATSAPP_LOG_PREFIX)) return null
  try {
    const parsed = JSON.parse(note.slice(WHATSAPP_LOG_PREFIX.length)) as WhatsAppMessageLog
    return parsed?.id && parsed?.recipient_number && parsed?.status ? parsed : null
  } catch {
    return null
  }
}

async function save(noteRowId: string, log: WhatsAppMessageLog): Promise<boolean> {
  const { error } = await supabaseAdmin.from('company_notes').update({ note: encode(log) }).eq('id', noteRowId)
  if (error) console.warn('[whatsapp-log] status could not be saved:', error.message)
  return !error
}

export async function listWhatsAppMessageLogs(companyId: string | null, limit = 200): Promise<WhatsAppMessageLog[]> {
  let query = supabaseAdmin
    .from('company_notes')
    .select('id, company_id, note')
    .like('note', `${WHATSAPP_LOG_PREFIX}%`)
    .order('id', { ascending: false })
    .limit(Math.max(1, Math.min(limit, 500)))
  if (companyId) query = query.eq('company_id', companyId)
  const { data, error } = await query
  if (error) throw error
  return ((data || []) as NoteRow[])
    .map((row) => decode(row.note))
    .filter((log): log is WhatsAppMessageLog => Boolean(log))
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
}

export async function sendTrackedWhatsAppMessage(input: TrackedWhatsAppInput): Promise<WhatsAppDelivery> {
  const now = new Date().toISOString()
  const log: WhatsAppMessageLog = {
    id: crypto.randomUUID(),
    company_id: input.companyId,
    party_id: input.partyId || null,
    party_name: input.partyName || 'Party',
    recipient_name: input.recipientName || input.partyName || 'Party',
    recipient_number: normalizeWhatsAppNumber(input.to),
    message_type: input.messageType,
    reference_type: input.referenceType,
    reference_id: input.referenceId || null,
    reference_number: input.referenceNumber || null,
    message_body: input.message,
    provider: 'evolution',
    provider_message_id: null,
    status: 'SENDING',
    attempt_count: 1,
    error_message: null,
    sent_at: null,
    delivered_at: null,
    read_at: null,
    failed_at: null,
    created_by_user_id: input.createdByUserId || null,
    created_at: now,
    updated_at: now,
  }

  const { data: noteRow, error: insertError } = await supabaseAdmin
    .from('company_notes')
    .insert({ company_id: input.companyId, note: encode(log) })
    .select('id')
    .single()
  if (insertError || !noteRow) throw insertError || new Error('WhatsApp history entry could not be created.')

  try {
    const delivery = await sendWhatsAppMessage({ to: log.recipient_number, message: input.message })
    const sent: WhatsAppMessageLog = {
      ...log,
      status: 'SENT',
      provider_message_id: delivery.message_id,
      sent_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }
    await save(noteRow.id, sent)
    return delivery
  } catch (error) {
    const failedAt = new Date().toISOString()
    await save(noteRow.id, {
      ...log,
      status: 'FAILED',
      error_message: error instanceof Error ? error.message.slice(0, 1000) : 'WhatsApp delivery failed.',
      failed_at: failedAt,
      updated_at: failedAt,
    })
    throw error
  }
}

const STATUS_RANK: Record<WhatsAppMessageStatus, number> = {
  QUEUED: 0,
  SENDING: 1,
  SENT: 2,
  DELIVERED: 3,
  READ: 4,
  FAILED: 5,
}

function providerStatus(value: unknown): WhatsAppMessageStatus | null {
  if (typeof value === 'number') {
    if (value >= 4) return 'READ'
    if (value === 3) return 'DELIVERED'
    if (value === 2) return 'SENT'
    if (value === 0) return 'FAILED'
    return null
  }
  const normalized = String(value || '').trim().toUpperCase().replace(/[.\s-]+/g, '_')
  if (!normalized) return null
  if (['READ', 'PLAYED', 'MESSAGE_READ'].includes(normalized)) return 'READ'
  if (['DELIVERED', 'DELIVERY_ACK', 'MESSAGE_DELIVERED'].includes(normalized)) return 'DELIVERED'
  if (['SENT', 'SERVER_ACK', 'MESSAGE_SENT'].includes(normalized)) return 'SENT'
  if (['FAILED', 'ERROR', 'DELETED'].includes(normalized)) return 'FAILED'
  if (/^\d+$/.test(normalized)) return providerStatus(Number(normalized))
  return null
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function deepValue(value: unknown, keys: string[], depth = 0): unknown {
  if (depth > 6) return null
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = deepValue(item, keys, depth + 1)
      if (found !== null && found !== undefined && found !== '') return found
    }
    return null
  }
  const item = record(value)
  if (!item) return null
  for (const key of keys) {
    if (item[key] !== null && item[key] !== undefined && item[key] !== '') return item[key]
  }
  for (const child of Object.values(item)) {
    const found = deepValue(child, keys, depth + 1)
    if (found !== null && found !== undefined && found !== '') return found
  }
  return null
}

export async function applyWhatsAppDeliveryWebhook(payload: unknown): Promise<number> {
  const root = record(payload)
  const rawData = root?.data ?? payload
  const updates = Array.isArray(rawData) ? rawData : [rawData]
  let updated = 0

  for (const item of updates) {
    const messageId = String(deepValue(item, ['messageId', 'message_id']) || deepValue(record(item)?.key, ['id']) || '').trim()
    const nextStatus = providerStatus(deepValue(item, ['status', 'messageStatus', 'message_status']))
    if (!messageId || !nextStatus) continue

    const { data } = await supabaseAdmin
      .from('company_notes')
      .select('id, company_id, note')
      .like('note', `${WHATSAPP_LOG_PREFIX}%${messageId}%`)
      .limit(20)
    const row = ((data || []) as NoteRow[]).find((candidate) => decode(candidate.note)?.provider_message_id === messageId)
    const current = row ? decode(row.note) : null
    if (!row || !current) continue
    if (nextStatus !== 'FAILED' && STATUS_RANK[nextStatus] <= STATUS_RANK[current.status]) continue

    const changedAt = new Date().toISOString()
    const next: WhatsAppMessageLog = { ...current, status: nextStatus, updated_at: changedAt }
    if (nextStatus === 'DELIVERED') next.delivered_at = changedAt
    if (nextStatus === 'READ') {
      next.read_at = changedAt
      next.delivered_at ||= changedAt
    }
    if (nextStatus === 'FAILED') {
      next.failed_at = changedAt
      next.error_message = String(deepValue(item, ['error', 'message', 'reason']) || 'WhatsApp reported delivery failure.').slice(0, 1000)
    }
    if (await save(row.id, next)) updated += 1
  }

  return updated
}
