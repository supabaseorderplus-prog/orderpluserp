import { supabaseAdmin } from '@/lib/supabase-server'

export interface CreditCheckResult {
  allowed: boolean
  effectiveLimit: number
  currentOutstanding: number
  availableCredit: number
  newInvoiceAmount: number
  requiresOverride: boolean
}

export async function checkCreditLimit(params: {
  partyId: string
  newInvoiceAmount: number
  companyId?: string | null
}): Promise<CreditCheckResult> {
  const { partyId, newInvoiceAmount, companyId } = params

  // Get party details
  let partyQuery = supabaseAdmin
    .from('parties')
    .select('id, credit_limit, credit_multiplier, use_security_for_credit, company_id')
    .eq('id', partyId)

  // CRITICAL: Filter by company_id to prevent cross-company data access
  if (companyId) {
    partyQuery = partyQuery.eq('company_id', companyId)
  }

  const { data: party } = await partyQuery.single()

  if (!party) {
    return { allowed: false, effectiveLimit: 0, currentOutstanding: 0, availableCredit: 0, newInvoiceAmount, requiresOverride: true }
  }

  // Calculate effective credit limit
  let effectiveLimit = Number(party.credit_limit) || 0

  if (party.use_security_for_credit) {
    const { data: secEntry } = await supabaseAdmin
      .from('security_ledger')
      .select('balance')
      .eq('party_id', partyId)
      .order('created_at', { ascending: false })
      .limit(1)
      .single()

    const secBalance = Number(secEntry?.balance || 0)
    const multiplier = Number(party.credit_multiplier) || 3
    effectiveLimit = Math.max(effectiveLimit, secBalance * multiplier)
  }

  // Calculate current outstanding
  let outstandingQuery = supabaseAdmin
    .from('invoices')
    .select('amount_outstanding')
    .eq('billing_party_id', partyId)
    .in('payment_status', ['UNPAID', 'PARTIAL'])
    .eq('is_cancelled', false)

  // CRITICAL: Filter by company_id to prevent cross-company data access
  if (companyId) {
    outstandingQuery = outstandingQuery.eq('company_id', companyId)
  }

  const { data: outstandingData } = await outstandingQuery

  const currentOutstanding = (outstandingData || []).reduce((sum, inv) => sum + Number(inv.amount_outstanding), 0)
  const availableCredit = effectiveLimit - currentOutstanding
  const allowed = (currentOutstanding + newInvoiceAmount) <= effectiveLimit
  const requiresOverride = !allowed

  return {
    allowed,
    effectiveLimit,
    currentOutstanding,
    availableCredit,
    newInvoiceAmount,
    requiresOverride,
  }
}

export async function logCreditEvent(params: {
  partyId: string
  eventType: 'LIMIT_CHECK' | 'LIMIT_BREACHED' | 'INVOICE_BLOCKED' | 'OVERRIDE_GRANTED'
  invoiceId: string
  creditLimit: number
  outstanding: number
  invoiceAmount: number
  companyId?: string | null
  overrideBy?: string
  overrideReason?: string
}): Promise<void> {
  const insertData: any = {
    party_id: params.partyId,
    event_type: params.eventType,
    invoice_id: params.invoiceId,
    credit_limit_at_event: params.creditLimit,
    current_outstanding: params.outstanding,
    invoice_amount: params.invoiceAmount,
    override_by: params.overrideBy || null,
    override_reason: params.overrideReason || null,
  }

  // CRITICAL: Associate credit event with the company
  if (params.companyId) {
    insertData.company_id = params.companyId
  }

  await supabaseAdmin.from('credit_control_events').insert(insertData)
}
