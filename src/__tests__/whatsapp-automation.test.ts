import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizeWhatsAppNumber, sendWhatsAppMessage } from '@/lib/whatsapp-automation'

describe('WhatsApp automation', () => {
  beforeEach(() => {
    process.env.WHATSAPP_API_URL = 'http://evolution.test:8080'
    process.env.WHATSAPP_API_KEY = 'test-key'
    process.env.WHATSAPP_INSTANCE_NAME = 'hometech-test'
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.WHATSAPP_API_URL
    delete process.env.WHATSAPP_API_KEY
    delete process.env.WHATSAPP_INSTANCE_NAME
  })

  it('normalizes Indian mobile numbers without changing explicit country codes', () => {
    expect(normalizeWhatsAppNumber('98765 43210')).toBe('919876543210')
    expect(normalizeWhatsAppNumber('09876543210')).toBe('919876543210')
    expect(normalizeWhatsAppNumber('+44 7700 900123')).toBe('447700900123')
  })

  it('sends text through Evolution API instead of returning a wa.me link', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ key: { id: 'MSG-123' } }), { status: 201 }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await sendWhatsAppMessage({ to: '9876543210', message: 'Approval link' })

    expect(result).toEqual({ status: 'sent', provider: 'evolution', to: '919876543210', message_id: 'MSG-123' })
    expect(fetchMock).toHaveBeenCalledWith(
      'http://evolution.test:8080/message/sendText/hometech-test',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ number: '919876543210', text: 'Approval link', linkPreview: true }),
        headers: expect.objectContaining({
          apikey: 'test-key',
          'ngrok-skip-browser-warning': 'true',
        }),
      }),
    )
  })
})
