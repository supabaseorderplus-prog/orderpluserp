type JsonRecord = Record<string, unknown>

export type WhatsAppDelivery = {
  status: 'sent'
  provider: 'evolution'
  to: string
  message_id: string | null
}

export type WhatsAppConnection = {
  configured: boolean
  connected: boolean
  state: string
  instance_name: string
  provider: 'evolution'
  qr_code: string | null
  message: string
}

export class WhatsAppAutomationError extends Error {
  readonly status: number
  readonly code: string

  constructor(message: string, options: { status?: number; code?: string } = {}) {
    super(message)
    this.name = 'WhatsAppAutomationError'
    this.status = options.status || 503
    this.code = options.code || 'WHATSAPP_AUTOMATION_ERROR'
  }
}

const evolutionConfig = () => ({
  baseUrl: (process.env.WHATSAPP_API_URL || 'http://127.0.0.1:8080').replace(/\/$/, ''),
  apiKey: (process.env.WHATSAPP_API_KEY || '').trim(),
  instanceName: (process.env.WHATSAPP_INSTANCE_NAME || 'hometech').trim(),
  appOrigin: (process.env.WHATSAPP_APP_ORIGIN || 'http://localhost:3001').trim(),
})

let webhookConfigured = false
let webhookConfigurationPromise: Promise<boolean> | null = null

export function normalizeWhatsAppNumber(raw: string): string {
  const digits = String(raw || '').replace(/\D/g, '')
  if (!digits) return ''
  if (digits.length === 10) return `91${digits}`
  if (digits.length === 11 && digits.startsWith('0')) return `91${digits.slice(1)}`
  return digits
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null
}

function findString(value: unknown, keys: string[], depth = 0): string | null {
  if (depth > 5) return null
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findString(item, keys, depth + 1)
      if (found) return found
    }
    return null
  }
  const record = asRecord(value)
  if (!record) return null
  for (const key of keys) {
    const candidate = record[key]
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
  }
  for (const candidate of Object.values(record)) {
    const found = findString(candidate, keys, depth + 1)
    if (found) return found
  }
  return null
}

function qrDataUri(value: string | null): string | null {
  if (!value) return null
  if (value.startsWith('data:image/')) return value
  // Evolution commonly returns a base64 PNG under qrcode.base64.
  if (/^[A-Za-z0-9+/=\r\n]+$/.test(value) && value.length > 200) {
    return `data:image/png;base64,${value.replace(/\s/g, '')}`
  }
  return null
}

async function evolutionRequest<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const config = evolutionConfig()
  if (!config.apiKey) {
    throw new WhatsAppAutomationError(
      'WhatsApp automation is not configured. Add WHATSAPP_API_KEY and pair the business number in WhatsApp Automation.',
      { code: 'WHATSAPP_NOT_CONFIGURED' },
    )
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15_000)
  try {
    const response = await fetch(`${config.baseUrl}${path}`, {
      ...init,
      cache: 'no-store',
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Origin: config.appOrigin,
        apikey: config.apiKey,
        ...init.headers,
      },
    })
    const text = await response.text()
    let body: unknown = null
    try { body = text ? JSON.parse(text) : null } catch { body = text }

    if (!response.ok) {
      const providerMessage = findString(body, ['message', 'error'])
      throw new WhatsAppAutomationError(
        providerMessage || `WhatsApp service returned ${response.status}.`,
        { status: response.status >= 400 && response.status < 500 ? 400 : 503, code: 'WHATSAPP_PROVIDER_ERROR' },
      )
    }
    return body as T
  } catch (error) {
    if (error instanceof WhatsAppAutomationError) throw error
    if (error instanceof Error && error.name === 'AbortError') {
      throw new WhatsAppAutomationError('WhatsApp service timed out. Check the Evolution API connection.', { code: 'WHATSAPP_TIMEOUT' })
    }
    throw new WhatsAppAutomationError('WhatsApp service is unavailable. Check the Evolution API container and connection.', { code: 'WHATSAPP_UNAVAILABLE' })
  } finally {
    clearTimeout(timer)
  }
}

function connectionState(body: unknown): string {
  return (findString(body, ['state', 'connectionStatus', 'status']) || 'unknown').toLowerCase()
}

function isConnectedState(state: string): boolean {
  return ['open', 'connected', 'online'].includes(state.toLowerCase())
}

function deliveryWebhookUrl(): string {
  const config = evolutionConfig()
  const configured = (process.env.WHATSAPP_WEBHOOK_URL || '').trim()
  const target = new URL(configured || '/api/v1/whatsapp/webhook', config.appOrigin)
  // Evolution runs in Docker locally, where localhost points back to the
  // container. host.docker.internal reaches this Next.js application.
  if (!configured && ['localhost', '127.0.0.1'].includes(target.hostname)) {
    target.hostname = 'host.docker.internal'
  }
  return target.toString()
}

export async function ensureWhatsAppDeliveryWebhook(): Promise<boolean> {
  if (webhookConfigured) return true
  if (webhookConfigurationPromise) return webhookConfigurationPromise
  const config = evolutionConfig()
  if (!config.apiKey) return false

  webhookConfigurationPromise = (async () => {
    await evolutionRequest(`/webhook/set/${encodeURIComponent(config.instanceName)}`, {
      method: 'POST',
      body: JSON.stringify({
        webhook: {
          enabled: true,
          url: deliveryWebhookUrl(),
          webhookByEvents: false,
          webhookBase64: false,
          events: ['MESSAGES_UPDATE', 'SEND_MESSAGE'],
          headers: { Authorization: `Bearer ${process.env.WHATSAPP_WEBHOOK_SECRET || config.apiKey}` },
        },
      }),
    })
    webhookConfigured = true
    return true
  })().catch((error) => {
    console.warn('[whatsapp] delivery webhook configuration failed:', error instanceof Error ? error.message : error)
    return false
  }).finally(() => { webhookConfigurationPromise = null })

  return webhookConfigurationPromise
}

export async function getWhatsAppConnection(): Promise<WhatsAppConnection> {
  const config = evolutionConfig()
  if (!config.apiKey) {
    return {
      configured: false,
      connected: false,
      state: 'not_configured',
      instance_name: config.instanceName,
      provider: 'evolution',
      qr_code: null,
      message: 'Add WHATSAPP_API_KEY to connect the WhatsApp automation service.',
    }
  }

  try {
    const body = await evolutionRequest(`/instance/connectionState/${encodeURIComponent(config.instanceName)}`, { method: 'GET' })
    const state = connectionState(body)
    if (isConnectedState(state)) await ensureWhatsAppDeliveryWebhook()
    return {
      configured: true,
      connected: isConnectedState(state),
      state,
      instance_name: config.instanceName,
      provider: 'evolution',
      qr_code: qrDataUri(findString(body, ['base64', 'qrcode', 'qrCode', 'code'])),
      message: isConnectedState(state) ? 'WhatsApp is connected and automatic sending is ready.' : 'WhatsApp is not connected yet.',
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'WhatsApp connection could not be checked.'
    return {
      configured: true,
      connected: false,
      state: 'unavailable',
      instance_name: config.instanceName,
      provider: 'evolution',
      qr_code: null,
      message,
    }
  }
}

export async function startWhatsAppConnection(): Promise<WhatsAppConnection> {
  const config = evolutionConfig()
  let body: unknown

  try {
    body = await evolutionRequest(`/instance/connect/${encodeURIComponent(config.instanceName)}`, { method: 'GET' })
  } catch (error) {
    const providerError = error instanceof WhatsAppAutomationError ? error : null
    if (providerError?.status !== 400 || !/does not exist|not found/i.test(providerError.message)) throw error
    body = await evolutionRequest('/instance/create', {
      method: 'POST',
      body: JSON.stringify({
        instanceName: config.instanceName,
        integration: 'WHATSAPP-BAILEYS',
        qrcode: true,
        readMessages: false,
        groupsIgnore: true,
      }),
    })
  }

  const state = connectionState(body)
  const qr = qrDataUri(findString(body, ['base64', 'qrcode', 'qrCode', 'code']))
  if (isConnectedState(state)) await ensureWhatsAppDeliveryWebhook()
  return {
    configured: true,
    connected: isConnectedState(state),
    state,
    instance_name: config.instanceName,
    provider: 'evolution',
    qr_code: qr,
    message: isConnectedState(state)
      ? 'WhatsApp is connected and automatic sending is ready.'
      : qr
        ? 'Scan this QR code once from WhatsApp → Linked devices.'
        : 'Connection started. Refresh in a few seconds to load the QR code.',
  }
}

export async function sendWhatsAppMessage(input: { to: string; message: string }): Promise<WhatsAppDelivery> {
  const to = normalizeWhatsAppNumber(input.to)
  const message = String(input.message || '').trim()
  if (!to) throw new WhatsAppAutomationError('A valid WhatsApp/mobile number is required.', { status: 400, code: 'WHATSAPP_INVALID_NUMBER' })
  if (!message) throw new WhatsAppAutomationError('A WhatsApp message is required.', { status: 400, code: 'WHATSAPP_EMPTY_MESSAGE' })

  const config = evolutionConfig()
  const body = await evolutionRequest(`/message/sendText/${encodeURIComponent(config.instanceName)}`, {
    method: 'POST',
    body: JSON.stringify({ number: to, text: message, linkPreview: true }),
  })
  const messageId = findString(body, ['id', 'messageId', 'message_id'])
  return { status: 'sent', provider: 'evolution', to, message_id: messageId }
}
