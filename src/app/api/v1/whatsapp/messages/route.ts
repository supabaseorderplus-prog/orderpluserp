import { NextRequest, NextResponse } from 'next/server'

import { getUserFromToken, resolveCompanyScope } from '@/lib/supabase-server'
import { listWhatsAppMessageLogs } from '@/lib/whatsapp-message-log'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  try {
    const user = await getUserFromToken(req)
    if (!user) return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 })
    if (!['ADMIN', 'SUPER_ADMIN'].includes(user.role)) {
      return NextResponse.json({ success: false, message: 'Only administrators can view WhatsApp message history.' }, { status: 403 })
    }
    const companyId = await resolveCompanyScope(req, user)
    const rows = await listWhatsAppMessageLogs(companyId, 200)
    const today = new Date()
    today.setHours(0, 0, 0, 0)

    return NextResponse.json({
      success: true,
      data: rows,
      summary: {
        total: rows.length,
        today: rows.filter((row) => new Date(row.created_at).getTime() >= today.getTime()).length,
        delivered: rows.filter((row) => row.status === 'DELIVERED' || row.status === 'READ').length,
        read: rows.filter((row) => row.status === 'READ').length,
        failed: rows.filter((row) => row.status === 'FAILED').length,
      },
    })
  } catch (error) {
    return NextResponse.json(
      { success: false, message: error instanceof Error ? error.message : 'WhatsApp message history could not be loaded.' },
      { status: 500 },
    )
  }
}
