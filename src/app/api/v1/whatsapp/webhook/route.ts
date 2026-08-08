import { NextRequest, NextResponse } from 'next/server'

import { applyWhatsAppDeliveryWebhook } from '@/lib/whatsapp-message-log'

export const dynamic = 'force-dynamic'

function authorized(req: NextRequest): boolean {
  const expected = (process.env.WHATSAPP_WEBHOOK_SECRET || process.env.WHATSAPP_API_KEY || '').trim()
  if (!expected) return false
  const raw = req.headers.get('authorization') || ''
  const received = raw.replace(/^Bearer\s+/i, '').trim()
  return received.length === expected.length && received === expected
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ success: false, message: 'Unauthorized webhook' }, { status: 401 })
  }

  try {
    const payload = await req.json()
    const updated = await applyWhatsAppDeliveryWebhook(payload)
    return NextResponse.json({ success: true, updated })
  } catch (error) {
    return NextResponse.json(
      { success: false, message: error instanceof Error ? error.message : 'Delivery update could not be processed.' },
      { status: 500 },
    )
  }
}
