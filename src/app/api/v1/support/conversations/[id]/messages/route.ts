import { NextRequest, NextResponse } from 'next/server'
import { getUserFromToken, supabaseAdmin } from '@/lib/supabase-server'
import {
  buildSupportWhatsAppMessage,
  canUseSupport,
  isSupportAdmin,
  loadPartyContact,
  resolveSupportCompanyId,
} from '@/lib/support-chat'
import { sendWhatsAppMessage } from '@/lib/whatsapp-automation'

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const user = await getUserFromToken(req)
    if (!canUseSupport(user)) {
      return NextResponse.json({ success: false, message: user ? 'Support chat is not available for this role' : 'Unauthorized' }, { status: user ? 403 : 401 })
    }
    const companyId = await resolveSupportCompanyId(user, req.headers.get('x-company-id'))
    if (!companyId) return NextResponse.json({ success: false, message: 'Company scope is required' }, { status: 403 })

    let query = supabaseAdmin.from('support_conversations').select('*').eq('id', id).eq('company_id', companyId)
    const admin = isSupportAdmin(user.role)
    if (!admin) query = query.eq('party_id', user.party_id as string)
    const { data: conversation } = await query.maybeSingle()
    if (!conversation) return NextResponse.json({ success: false, message: 'Conversation not found' }, { status: 404 })
    if (['CLOSED', 'RESOLVED'].includes(String(conversation.status))) {
      return NextResponse.json({ success: false, message: 'Reopen this conversation before sending another message.' }, { status: 409 })
    }

    const body = await req.json()
    const message = String(body?.message || '').trim()
    if (!message || message.length > 4000) {
      return NextResponse.json({ success: false, message: 'Message must be between 1 and 4000 characters.' }, { status: 400 })
    }
    const senderName = user.name || (admin ? 'Administrator' : 'Party user')
    const senderType = admin ? 'ADMIN' : 'PARTY'
    const { data: saved, error } = await supabaseAdmin.from('support_messages').insert({
      conversation_id: id,
      company_id: companyId,
      sender_user_id: user.id,
      sender_name: senderName,
      sender_role: user.role,
      sender_type: senderType,
      body: message,
    }).select('*').single()
    if (error) throw error

    await supabaseAdmin.from('support_conversations').update({
      last_message_preview: message.slice(0, 180),
      last_message_at: new Date().toISOString(),
      ...(admin
        ? { party_unread_count: Number(conversation.party_unread_count || 0) + 1 }
        : { admin_unread_count: Number(conversation.admin_unread_count || 0) + 1 }),
    }).eq('id', id)

    const recipient = admin
      ? await loadPartyContact(conversation.party_id)
      : await loadPartyContact(companyId)
    let whatsappDelivery: unknown = null
    let whatsappWarning: string | null = null
    if (recipient?.phone) {
      try {
        whatsappDelivery = await sendWhatsAppMessage({
          to: recipient.phone,
          message: buildSupportWhatsAppMessage({
            ticketNumber: conversation.ticket_number,
            subject: conversation.subject,
            accessKey: conversation.access_key,
            senderName,
            body: message,
          }),
        })
      } catch (deliveryError) {
        whatsappWarning = deliveryError instanceof Error ? deliveryError.message : 'The WhatsApp notification could not be sent.'
      }
    }

    return NextResponse.json({ success: true, data: saved, whatsapp_delivery: whatsappDelivery, whatsapp_warning: whatsappWarning }, { status: 201 })
  } catch (error) {
    return NextResponse.json({ success: false, message: error instanceof Error ? error.message : 'Message could not be sent.' }, { status: 500 })
  }
}
