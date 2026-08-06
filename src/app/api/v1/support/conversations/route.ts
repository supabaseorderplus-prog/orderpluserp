import { NextRequest, NextResponse } from 'next/server'
import { getUserFromToken, supabaseAdmin } from '@/lib/supabase-server'
import {
  buildWhatsAppUrl,
  canUseSupport,
  ensureSupportChatSchema,
  isSupportSchemaGap,
  isSupportAdmin,
  loadPartyContact,
  notifyCompanyAdmins,
  resolveSupportCompanyId,
} from '@/lib/support-chat'

export const dynamic = 'force-dynamic'

function apiError(error: unknown, fallback: string) {
  const record = error && typeof error === 'object'
    ? error as { code?: unknown; message?: unknown; details?: unknown; hint?: unknown }
    : null
  const message = error instanceof Error
    ? error.message
    : typeof record?.message === 'string' && record.message.trim()
      ? record.message
      : fallback
  const code = typeof record?.code === 'string' ? record.code : null
  const missingSchema = isSupportSchemaGap(error)
  return NextResponse.json(
    {
      success: false,
      message: missingSchema ? 'Support chat database migration has not been applied yet.' : message,
      ...(code ? { code } : {}),
    },
    { status: missingSchema ? 503 : 500 },
  )
}

export async function GET(req: NextRequest) {
  try {
    await ensureSupportChatSchema()

    const user = await getUserFromToken(req)
    if (!canUseSupport(user)) {
      return NextResponse.json({ success: false, message: user ? 'Support chat is not available for this role' : 'Unauthorized' }, { status: user ? 403 : 401 })
    }

    const companyId = await resolveSupportCompanyId(user, req.headers.get('x-company-id'))
    if (!companyId) return NextResponse.json({ success: true, data: [], summary: { open: 0, waiting: 0, resolved: 0, unread: 0 } })

    let query = supabaseAdmin
      .from('support_conversations')
      .select('*')
      .eq('company_id', companyId)
      .order('last_message_at', { ascending: false })

    if (!isSupportAdmin(user.role)) query = query.eq('party_id', user.party_id as string)

    const { data, error } = await query
    if (error) throw error
    const rows = data || []

    const partyIds = [...new Set(rows.map((row) => String(row.party_id)))]
    const { data: parties } = partyIds.length
      ? await supabaseAdmin.from('parties').select('*').in('id', partyIds)
      : { data: [] }
    const partyMap = new Map((parties || []).map((party) => [String(party.id), party]))
    const companyContact = await loadPartyContact(companyId)
    const admin = isSupportAdmin(user.role)

    const hydrated = rows.map((row) => {
      const party = partyMap.get(String(row.party_id))
      const phone = admin
        ? String(party?.portal_phone || party?.contact_phone || party?.phone || '').replace(/\D/g, '') || null
        : companyContact?.phone || null
      return {
        ...row,
        party: party ? {
          id: party.id,
          name: party.name || row.created_by_name,
          code: party.party_code || null,
          phone,
        } : { id: row.party_id, name: row.created_by_name, code: null, phone },
        whatsapp_url: buildWhatsAppUrl({
          phone,
          ticketNumber: row.ticket_number,
          subject: row.subject,
          accessKey: row.access_key,
        }),
      }
    })

    const unreadKey = admin ? 'admin_unread_count' : 'party_unread_count'
    return NextResponse.json({
      success: true,
      data: hydrated,
      summary: {
        open: rows.filter((row) => row.status === 'OPEN').length,
        waiting: rows.filter((row) => row.status === 'WAITING').length,
        resolved: rows.filter((row) => row.status === 'RESOLVED' || row.status === 'CLOSED').length,
        unread: rows.reduce((total, row) => total + Number(row[unreadKey] || 0), 0),
      },
      viewer: { is_admin: admin, company_id: companyId },
    })
  } catch (error) {
    return apiError(error, 'Failed to load support conversations')
  }
}

export async function POST(req: NextRequest) {
  try {
    await ensureSupportChatSchema()

    const user = await getUserFromToken(req)
    if (!canUseSupport(user)) {
      return NextResponse.json({ success: false, message: user ? 'Support chat is not available for this role' : 'Unauthorized' }, { status: user ? 403 : 401 })
    }
    if (isSupportAdmin(user.role)) {
      return NextResponse.json({ success: false, message: 'New chats are initiated from a party account' }, { status: 403 })
    }
    if (!user.party_id) return NextResponse.json({ success: false, message: 'Your account is not linked to a party' }, { status: 400 })

    const companyId = await resolveSupportCompanyId(user, null)
    if (!companyId) return NextResponse.json({ success: false, message: 'Could not resolve your company' }, { status: 400 })

    const body = await req.json()
    const subject = String(body?.subject || '').trim()
    const initialMessage = String(body?.message || '').trim()
    const category = String(body?.category || 'GENERAL').toUpperCase()
    const priority = String(body?.priority || 'NORMAL').toUpperCase()
    const validCategories = new Set(['ORDER', 'PAYMENT', 'PRODUCT', 'TECHNICAL', 'GENERAL'])
    const validPriorities = new Set(['LOW', 'NORMAL', 'HIGH', 'URGENT'])

    if (subject.length < 4 || subject.length > 120) {
      return NextResponse.json({ success: false, message: 'Subject must be between 4 and 120 characters' }, { status: 400 })
    }
    if (initialMessage.length < 2 || initialMessage.length > 4000) {
      return NextResponse.json({ success: false, message: 'Message must be between 2 and 4000 characters' }, { status: 400 })
    }
    if (!validCategories.has(category) || !validPriorities.has(priority)) {
      return NextResponse.json({ success: false, message: 'Invalid category or priority' }, { status: 400 })
    }

    const party = await loadPartyContact(user.party_id)
    const creatorName = user.name || party?.name || 'Party user'
    const { data: conversation, error: conversationError } = await supabaseAdmin
      .from('support_conversations')
      .insert({
        company_id: companyId,
        party_id: user.party_id,
        subject,
        category,
        priority,
        created_by_user_id: user.id,
        created_by_name: creatorName,
        created_by_role: user.role,
        admin_unread_count: 1,
        last_message_preview: initialMessage.slice(0, 180),
      })
      .select('*')
      .single()
    if (conversationError || !conversation) throw conversationError || new Error('Conversation could not be created')

    const { error: messageError } = await supabaseAdmin.from('support_messages').insert({
      conversation_id: conversation.id,
      company_id: companyId,
      sender_user_id: user.id,
      sender_name: creatorName,
      sender_role: user.role,
      sender_type: 'PARTY',
      body: initialMessage,
    })
    if (messageError) {
      await supabaseAdmin.from('support_conversations').delete().eq('id', conversation.id)
      throw messageError
    }

    await notifyCompanyAdmins({
      companyId,
      ticketNumber: conversation.ticket_number,
      partyName: party?.name || creatorName,
      subject,
    })

    return NextResponse.json({ success: true, data: conversation }, { status: 201 })
  } catch (error) {
    return apiError(error, 'Failed to start support chat')
  }
}
