import { NextRequest, NextResponse } from 'next/server'
import { getUserFromToken, supabaseAdmin } from '@/lib/supabase-server'
import { buildWhatsAppUrl, canUseSupport, isSupportAdmin, loadPartyContact, resolveSupportCompanyId } from '@/lib/support-chat'

async function authorizedConversation(req: NextRequest, id: string) {
  const user = await getUserFromToken(req)
  if (!canUseSupport(user)) return { user, conversation: null, status: user ? 403 : 401 }
  const companyId = await resolveSupportCompanyId(user, req.headers.get('x-company-id'))
  if (!companyId) return { user, conversation: null, status: 403 }
  let query = supabaseAdmin.from('support_conversations').select('*').eq('id', id).eq('company_id', companyId)
  if (!isSupportAdmin(user.role)) query = query.eq('party_id', user.party_id as string)
  const { data } = await query.maybeSingle()
  return { user, conversation: data, status: data ? 200 : 404 }
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const access = await authorizedConversation(req, id)
    if (!access.conversation || !access.user) {
      return NextResponse.json({ success: false, message: access.status === 401 ? 'Unauthorized' : 'Conversation not found' }, { status: access.status })
    }

    const admin = isSupportAdmin(access.user.role)
    const [{ data: messages, error }, { data: party }, companyContact] = await Promise.all([
      supabaseAdmin.from('support_messages').select('*').eq('conversation_id', id).order('created_at'),
      supabaseAdmin.from('parties').select('*').eq('id', access.conversation.party_id).maybeSingle(),
      loadPartyContact(access.conversation.company_id),
    ])
    if (error) throw error

    await supabaseAdmin.from('support_conversations').update(admin
      ? { admin_unread_count: 0, admin_last_read_at: new Date().toISOString() }
      : { party_unread_count: 0, party_last_read_at: new Date().toISOString() }
    ).eq('id', id)

    const partyPhone = String(party?.portal_phone || party?.contact_phone || party?.phone || '').replace(/\D/g, '') || null
    const phone = admin ? partyPhone : companyContact?.phone || null
    return NextResponse.json({
      success: true,
      data: {
        ...access.conversation,
        party,
        messages: messages || [],
        whatsapp_url: buildWhatsAppUrl({
          phone,
          ticketNumber: access.conversation.ticket_number,
          subject: access.conversation.subject,
          accessKey: access.conversation.access_key,
        }),
      },
    })
  } catch (error) {
    return NextResponse.json({ success: false, message: error instanceof Error ? error.message : 'Failed to load conversation' }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const access = await authorizedConversation(req, id)
    if (!access.conversation || !access.user) {
      return NextResponse.json({ success: false, message: access.status === 401 ? 'Unauthorized' : 'Conversation not found' }, { status: access.status })
    }
    if (!isSupportAdmin(access.user.role)) {
      return NextResponse.json({ success: false, message: 'Only company administrators can manage a chat' }, { status: 403 })
    }

    const body = await req.json()
    const updates: Record<string, unknown> = {}
    const status = body?.status ? String(body.status).toUpperCase() : null
    const priority = body?.priority ? String(body.priority).toUpperCase() : null
    if (status && ['OPEN', 'WAITING', 'RESOLVED', 'CLOSED'].includes(status)) {
      updates.status = status
      updates.closed_at = status === 'CLOSED' || status === 'RESOLVED' ? new Date().toISOString() : null
      updates.closed_by_user_id = status === 'CLOSED' || status === 'RESOLVED' ? access.user.id : null
    }
    if (priority && ['LOW', 'NORMAL', 'HIGH', 'URGENT'].includes(priority)) updates.priority = priority
    if (body?.assign_to_me === true) {
      updates.assigned_to_user_id = access.user.id
      updates.assigned_to_name = access.user.name || 'Administrator'
    }
    if (body?.assign_to_me === false) {
      updates.assigned_to_user_id = null
      updates.assigned_to_name = null
    }
    if (Object.keys(updates).length === 0) return NextResponse.json({ success: false, message: 'No valid changes supplied' }, { status: 400 })

    const { data, error } = await supabaseAdmin.from('support_conversations').update(updates).eq('id', id).select('*').single()
    if (error) throw error

    if (status && status !== access.conversation.status) {
      const label = status === 'OPEN' ? 'reopened' : status === 'WAITING' ? 'placed on hold' : status === 'RESOLVED' ? 'resolved' : 'closed'
      await supabaseAdmin.from('support_messages').insert({
        conversation_id: id,
        company_id: access.conversation.company_id,
        sender_user_id: access.user.id,
        sender_name: access.user.name || 'Administrator',
        sender_role: access.user.role,
        sender_type: 'SYSTEM',
        message_type: 'SYSTEM',
        body: `Chat ${label} by ${access.user.name || 'administrator'}.`,
      })
    }

    return NextResponse.json({ success: true, data })
  } catch (error) {
    return NextResponse.json({ success: false, message: error instanceof Error ? error.message : 'Failed to update conversation' }, { status: 500 })
  }
}
