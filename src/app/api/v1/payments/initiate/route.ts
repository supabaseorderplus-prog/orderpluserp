import { NextRequest, NextResponse } from 'next/server'
import { getPartyDescendants, getUserFromToken, resolveCompanyScope, supabaseAdmin } from '@/lib/supabase-server'
import {
  createPaymentApproval,
  type PaymentApprovalInvoice,
  type PaymentApprovalScheme,
  type PendingPaymentPayload,
} from '@/lib/payment-approval-links'
import { WhatsAppAutomationError } from '@/lib/whatsapp-automation'
import { sendTrackedWhatsAppMessage } from '@/lib/whatsapp-message-log'

type InvoiceSnapshot = {
  id: string
  invoice_number?: string
  invoice_date?: string
  grand_total?: number
  amount_outstanding?: number
}

type SchemeSnapshot = {
  id: string
  name?: string
  target_value?: number
  end_date?: string
  reward_description?: string | null
  progress?: { current_value?: number; target_value?: number; progress_percent?: number; is_achieved?: boolean }
}

const pickPhone = (party: Record<string, unknown>) => {
  for (const key of ['phone', 'contact_phone', 'portal_phone', 'mobile', 'whatsapp']) {
    const value = party[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

const appBaseUrl = (req: NextRequest) => {
  const configured = process.env.NEXT_PUBLIC_SITE_URL || process.env.NEXT_PUBLIC_APP_URL
  if (configured) return configured.replace(/\/$/, '')
  const forwardedHost = req.headers.get('x-forwarded-host')
  const forwardedProto = req.headers.get('x-forwarded-proto') || 'https'
  return forwardedHost ? `${forwardedProto}://${forwardedHost}` : new URL(req.url).origin
}

export async function POST(req: NextRequest) {
  try {
    const authUser = await getUserFromToken(req)
    if (!authUser) return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 })
    const companyId = await resolveCompanyScope(req, authUser)
    const raw = await req.json() as PendingPaymentPayload & {
      invoice_snapshots?: InvoiceSnapshot[]
      scheme_snapshots?: SchemeSnapshot[]
    }
    const amount = Number(raw.amount)
    if (!raw.party_id || !Number.isFinite(amount) || amount <= 0 || !raw.payment_mode) {
      return NextResponse.json({ success: false, message: 'Party, valid amount, and payment mode are required.' }, { status: 400 })
    }

    if (companyId) {
      const allowed = (await getPartyDescendants(companyId)).map((row) => row.id)
      if (!allowed.includes(companyId)) allowed.push(companyId)
      if (!allowed.includes(raw.party_id)) {
        return NextResponse.json({ success: false, message: 'Party not found or access denied.' }, { status: 403 })
      }
    }

    const [{ data: party, error: partyError }, { data: company }] = await Promise.all([
      supabaseAdmin.from('parties').select('*').eq('id', raw.party_id).maybeSingle(),
      companyId
        ? supabaseAdmin.from('parties').select('id, name').eq('id', companyId).maybeSingle()
        : Promise.resolve({ data: null }),
    ])
    if (partyError || !party) return NextResponse.json({ success: false, message: 'Party not found.' }, { status: 404 })
    if (party.is_verified === false) {
      return NextResponse.json({ success: false, message: 'Party must be verified before initiating a payment.' }, { status: 400 })
    }
    const phone = pickPhone(party as Record<string, unknown>)
    if (!phone.replace(/\D/g, '')) {
      return NextResponse.json({ success: false, message: `Add a WhatsApp/mobile number to ${party.name || 'this party'} before initiating payment approval.` }, { status: 400 })
    }

    const adjustments = (raw.adjustments || [])
      .filter((item) => item?.invoiceId && Number(item.amount) > 0)
      .map((item) => ({ invoiceId: String(item.invoiceId), amount: Number(item.amount) }))
    const snapshotMap = new Map((raw.invoice_snapshots || []).map((item) => [String(item.id), item]))
    const invoiceIds = [...new Set(adjustments.map((item) => item.invoiceId))]
    const { data: realInvoices } = invoiceIds.length
      ? await supabaseAdmin.from('invoices').select('id, invoice_number, invoice_date, grand_total, amount_outstanding').in('id', invoiceIds)
      : { data: [] }
    const realMap = new Map((realInvoices || []).map((item) => [String(item.id), item]))
    const invoices: PaymentApprovalInvoice[] = adjustments.map((allocation) => {
      const db = realMap.get(allocation.invoiceId)
      const snap = snapshotMap.get(allocation.invoiceId)
      const before = Math.max(0, Number(db?.amount_outstanding ?? snap?.amount_outstanding ?? allocation.amount))
      const applied = Math.min(allocation.amount, before || allocation.amount)
      const after = Math.max(0, before - applied)
      return {
        id: allocation.invoiceId,
        invoice_number: String(db?.invoice_number || snap?.invoice_number || allocation.invoiceId),
        invoice_date: String(db?.invoice_date || snap?.invoice_date || '') || null,
        invoice_total: Number(db?.grand_total ?? snap?.grand_total ?? before),
        outstanding_before: before,
        allocation: applied,
        outstanding_after: after,
        status_after: after <= 0.005 ? 'PAID' : applied > 0 ? 'PARTIAL' : 'UNPAID',
      }
    })

    const selectedSchemeIds = new Set(raw.skip_party_scheme ? [] : (raw.applied_scheme_ids || []))
    const schemes: PaymentApprovalScheme[] = (raw.scheme_snapshots || [])
      .filter((scheme) => selectedSchemeIds.has(scheme.id))
      .map((scheme) => {
        const target = Math.max(0, Number(scheme.progress?.target_value ?? scheme.target_value ?? 0))
        const current = Math.max(0, Number(scheme.progress?.current_value ?? 0))
        const projected = current + amount
        const before = target > 0 ? Math.min(100, current / target * 100) : 0
        const after = target > 0 ? Math.min(100, projected / target * 100) : 0
        return {
          id: scheme.id,
          name: scheme.name || 'Scheme',
          target_value: target,
          current_value: current,
          payment_credit: amount,
          projected_value: projected,
          progress_before: before,
          progress_after: after,
          status_before: current >= target && target > 0 ? 'ACHIEVED' : 'IN PROGRESS',
          status_after: projected >= target && target > 0 ? 'ACHIEVED' : 'IN PROGRESS',
          end_date: scheme.end_date || null,
          reward_description: scheme.reward_description || null,
        }
      })

    const payload: PendingPaymentPayload = {
      party_id: raw.party_id,
      amount,
      payment_mode: String(raw.payment_mode).toUpperCase(),
      reference_number: raw.reference_number || null,
      bank_name: raw.bank_name || null,
      proof_url: raw.proof_url || null,
      is_advance: Boolean(raw.is_advance),
      notes: raw.notes || null,
      adjustments,
      skip_party_scheme: Boolean(raw.skip_party_scheme),
      applied_scheme_ids: [...selectedSchemeIds],
    }
    const balanceBefore = Number(party.opening_balance || 0) + Number(party.wallet_balance || 0)
    const allocated = invoices.reduce((sum, invoice) => sum + invoice.allocation, 0)
    const requestNumber = `PAY-REQ-${Date.now().toString(36).toUpperCase()}`
    const record = await createPaymentApproval({
      request_number: requestNumber,
      company_id: companyId || null,
      company_name: String(company?.name || 'HomeTech Chemical'),
      party_id: raw.party_id,
      party_name: String(party.name || 'Party'),
      party_code: String(party.party_code || ''),
      party_phone: phone,
      collector_id: authUser.app_user_id || authUser.id,
      collector_name: authUser.name || authUser.email || 'Staff',
      auth_user: authUser,
      payload,
      invoices,
      schemes,
      balance_before: balanceBefore,
      balance_after: balanceBefore + amount,
      unallocated_amount: Math.max(0, amount - allocated),
    })

    const base = appBaseUrl(req)
    const approvalUrl = `${base}/approve-payment/${record.token}`
    const pdfUrl = `${base}/api/v1/public/payment-approval/${record.token}/pdf`
    const displayAmount = `Rs ${new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 }).format(amount)}`
    const invoiceText = invoices.length
      ? `${invoices.length} invoice${invoices.length === 1 ? '' : 's'}: ${invoices.map((item) => item.invoice_number).join(', ')}`
      : 'Advance / unallocated payment'
    const message = `Hello ${record.party_name},\n\n` +
      `${record.company_name} has initiated payment acknowledgement *${record.request_number}* for *${displayAmount}*.\n` +
      `${invoiceText}${schemes.length ? `\nScheme: ${schemes.map((item) => item.name).join(', ')}` : ''}\n\n` +
      `*Review detailed PDF:*\n${pdfUrl}\n\n` +
      `*Approve payment (no login needed):*\n${approvalUrl}\n\n` +
      `The payment will be posted only after your approval. Both secure links expire immediately after approval or automatically in 72 hours.`
    const delivery = await sendTrackedWhatsAppMessage({
      to: phone,
      message,
      companyId: companyId || null,
      partyId: raw.party_id,
      partyName: record.party_name,
      recipientName: record.party_name,
      messageType: 'PAYMENT_APPROVAL',
      referenceType: 'PAYMENT',
      referenceNumber: record.request_number,
      createdByUserId: authUser.app_user_id || authUser.id,
    })

    return NextResponse.json({
      success: true,
      data: {
        request_number: record.request_number,
        approval_url: approvalUrl,
        pdf_url: pdfUrl,
        whatsapp_delivery: delivery,
        expires_at: record.expires_at,
        party: { id: record.party_id, name: record.party_name, phone: record.party_phone },
      },
      message: 'Payment approval request created and sent automatically on WhatsApp.',
    }, { status: 201 })
  } catch (error) {
    const whatsappError = error instanceof WhatsAppAutomationError ? error : null
    return NextResponse.json(
      { success: false, message: error instanceof Error ? error.message : 'Failed to initiate payment approval.', code: whatsappError?.code },
      { status: whatsappError?.status || 500 },
    )
  }
}
