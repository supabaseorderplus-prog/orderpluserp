import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, getUserFromToken, resolveCompanyScope, getPartyDescendants, type AuthUser } from '@/lib/supabase-server'
import { getScopedPartyIdsForUser } from '@/lib/party-scope'
import { createApprovalToken, getApprovalSummaries } from '@/lib/order-approval-links'
import { normalizeWhatsAppNumber, sendWhatsAppMessage, WhatsAppAutomationError } from '@/lib/whatsapp-automation'

// Approval links live under the *minter's* party scope, so the confirmation
// status must be read across the whole party tree (same scope as the orders
// list) — not a single company_id — or a genuinely-confirmed order can still
// read back as "awaiting". Widen the scoped tree to include the resolved company
// scope itself so a self-minted link is never missed.
async function approvalScope(authUser: AuthUser | null, companyId: string | null): Promise<string[] | null> {
  const scoped = await getScopedPartyIdsForUser(authUser, companyId)
  if (scoped === null) return null
  if (companyId && !scoped.includes(companyId)) return [...scoped, companyId]
  return scoped
}

function pickPhone(party: Record<string, unknown> | null): string {
  if (!party) return ''
  for (const key of ['phone', 'contact_phone', 'portal_phone', 'mobile', 'whatsapp']) {
    const v = party[key]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return ''
}

function baseUrl(req: NextRequest): string {
  const env = process.env.NEXT_PUBLIC_SITE_URL || process.env.NEXT_PUBLIC_APP_URL
  if (env) return env.replace(/\/$/, '')
  return new URL(req.url).origin
}

async function loadOrderInScope(req: NextRequest) {
  const authUser = await getUserFromToken(req)
  if (!authUser) return { error: NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 }) }

  let companyId = await resolveCompanyScope(req, authUser)
  if (!companyId && authUser.role !== 'SUPER_ADMIN') companyId = authUser.party_id || null
  if (!companyId && authUser.role !== 'SUPER_ADMIN') {
    return { error: NextResponse.json({ success: false, message: 'Company scope is required' }, { status: 403 }) }
  }
  return { authUser, companyId }
}

// GET — current party-confirmation summary for this order.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const scope = await loadOrderInScope(req)
    if ('error' in scope) return scope.error
    const { id } = await params
    const summaries = await getApprovalSummaries(await approvalScope(scope.authUser, scope.companyId ?? null))
    return NextResponse.json({ success: true, data: summaries[id] || null })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed to load approval status' },
      { status: 500 },
    )
  }
}

// POST — mint a fresh party approval link and build the WhatsApp share payload.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const scope = await loadOrderInScope(req)
    if ('error' in scope) return scope.error
    const { authUser, companyId } = scope
    const { id } = await params
    const body = await req.json().catch(() => ({})) as { purpose?: string; invoice_request_id?: string | null }
    const purpose = body.purpose === 'INVOICE' ? 'INVOICE' : 'ORDER'

    // select('*') — never 42703 on schemas where buyer_id/company_id/seller_id
    // are absent (legacy schemas only have billing_party_id).
    const { data: order, error } = await supabaseAdmin
      .from('orders')
      .select('*')
      .eq('id', id)
      .maybeSingle()
    if (error || !order) {
      return NextResponse.json({ success: false, message: 'Order not found' }, { status: 404 })
    }

    const partyId =
      (order.buyer_id as string) || (order.billing_party_id as string) || null
    const orderStatus = String(order.status || order.order_status || 'PENDING').toUpperCase()

    // Access check — same shape as the staff approve route.
    if (companyId) {
      const directMatch =
        (order.company_id && order.company_id === companyId) || (order.seller_id && order.seller_id === companyId)
      if (!directMatch) {
        if (!partyId) {
          return NextResponse.json({ success: false, message: 'Access denied' }, { status: 403 })
        }
        const tree = await getPartyDescendants(companyId)
        const treeIds = tree.length > 0 ? tree.map((r) => r.id) : []
        if (!treeIds.includes(companyId)) treeIds.push(companyId)
        if (!treeIds.includes(partyId)) {
          return NextResponse.json({ success: false, message: 'Access denied' }, { status: 403 })
        }
      }
    }

    // Only PENDING/CANCELLED orders can't be sent for party confirmation. Everything
    // from APPROVED onward (procurement/dispatched/delivered) is shareable so the
    // button never dead-ends on an already-progressed order.
    if (orderStatus === 'PENDING' || orderStatus === 'CANCELLED') {
      return NextResponse.json(
        { success: false, message: 'Approve the order before sending it to the party for confirmation.' },
        { status: 400 },
      )
    }

    // Resolve party + company display info (defensive select('*') avoids 42703 on
    // schemas where an optional phone column is missing).
    const [{ data: party }, { data: company }] = await Promise.all([
      partyId
        ? supabaseAdmin.from('parties').select('*').eq('id', partyId).maybeSingle()
        : Promise.resolve({ data: null }),
      companyId
        ? supabaseAdmin.from('parties').select('id, name').eq('id', companyId).maybeSingle()
        : Promise.resolve({ data: null }),
    ])

    const partyName = (party?.name as string) || 'Party'
    const partyPhone = pickPhone(party as Record<string, unknown> | null)
    const companyName = (company?.name as string) || ''

    if (!normalizeWhatsAppNumber(partyPhone)) {
      return NextResponse.json(
        { success: false, message: `Add a WhatsApp/mobile number to ${partyName} before sending this order.` },
        { status: 400 },
      )
    }

    const existingApproval = (
      await getApprovalSummaries(await approvalScope(authUser, companyId ?? null), purpose)
    )[id]
    if (existingApproval?.status === 'APPROVED') {
      return NextResponse.json(
        { success: false, message: `This order was already confirmed by ${existingApproval.approved_name || partyName}.` },
        { status: 409 },
      )
    }

    const record = await createApprovalToken({
      orderId: id,
      orderNumber: (order.order_number as string) || id,
      companyId: companyId ?? null,
      companyName,
      partyId,
      partyName,
      partyPhone,
      grandTotal: Number(order.grand_total) || 0,
      createdBy: authUser?.app_user_id || authUser?.id || null,
      purpose,
      invoiceRequestId: purpose === 'INVOICE' ? body.invoice_request_id || null : null,
    })

    const approvalUrl = `${baseUrl(req)}/approve/${record.token}`
    const pdfUrl = `${baseUrl(req)}/api/v1/public/order-approval/${record.token}/pdf`
    const waNumber = normalizeWhatsAppNumber(partyPhone)
    const money = 'Rs ' + new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(record.grand_total)
    const message = purpose === 'INVOICE'
      ? `Hello ${partyName},\n\n` +
        `Please review invoice *${record.order_number}* (${money})${companyName ? ` from ${companyName}` : ''}. It includes every item, quantity and price.\n\n` +
        `*Invoice review PDF:*\n${pdfUrl}\n\n` +
        `*Confirm invoice (no login needed):*\n${approvalUrl}\n\n` +
        `The invoice will be generated only after you confirm. This secure link expires after confirmation or in 14 days.`
      :
      `Hello ${partyName},\n\n` +
      `Your order *${record.order_number}* (${money})${companyName ? ` from ${companyName}` : ''} has been approved and is ready for your confirmation.\n\n` +
      `*Order PDF:*\n${pdfUrl}\n\n` +
      `*Review & confirm (no login needed):*\n${approvalUrl}\n\n` +
      `Both secure links expire immediately after confirmation.`
    const delivery = await sendWhatsAppMessage({ to: waNumber, message })

    return NextResponse.json({
      success: true,
      data: {
        token: record.token,
        approval_url: approvalUrl,
        pdf_url: pdfUrl,
        whatsapp_delivery: delivery,
        message,
        order_number: record.order_number,
        grand_total: record.grand_total,
        party: { id: partyId, name: partyName, phone: partyPhone, whatsapp_number: waNumber },
        company_name: companyName,
        expires_at: record.expires_at,
        purpose,
      },
    })
  } catch (err) {
    const whatsappError = err instanceof WhatsAppAutomationError ? err : null
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed to create approval link', code: whatsappError?.code },
      { status: whatsappError?.status || 500 },
    )
  }
}
