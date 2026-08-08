import { NextRequest, NextResponse } from 'next/server'
import { getUserFromToken } from '@/lib/supabase-server'
import {
  getWhatsAppConnection,
  startWhatsAppConnection,
  WhatsAppAutomationError,
} from '@/lib/whatsapp-automation'

export const dynamic = 'force-dynamic'

async function authorize(req: NextRequest) {
  const user = await getUserFromToken(req)
  if (!user) return { error: NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 }) }
  if (!['ADMIN', 'SUPER_ADMIN'].includes(user.role)) {
    return { error: NextResponse.json({ success: false, message: 'Only administrators can pair the company WhatsApp number.' }, { status: 403 }) }
  }
  return { user }
}

export async function GET(req: NextRequest) {
  const auth = await authorize(req)
  if ('error' in auth) return auth.error
  return NextResponse.json({ success: true, data: await getWhatsAppConnection() })
}

export async function POST(req: NextRequest) {
  try {
    const auth = await authorize(req)
    if ('error' in auth) return auth.error
    return NextResponse.json({ success: true, data: await startWhatsAppConnection() })
  } catch (error) {
    const known = error instanceof WhatsAppAutomationError ? error : null
    return NextResponse.json(
      { success: false, message: known?.message || 'WhatsApp connection could not be started.', code: known?.code },
      { status: known?.status || 500 },
    )
  }
}
