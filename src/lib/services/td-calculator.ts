import { supabaseAdmin } from '@/lib/supabase-server'

export interface TDResult {
  tdAmount: number
  tdPercent: number
  baseAmount: number
  partyId: string
  partyType: 'CNF' | 'SUPER_DEALER'
  configId: string | null
}

export async function calculateTD(params: {
  invoiceId: string
  billingPath: 'A' | 'B' | 'C' | 'D'
  cnfId: string | null
  superDealerId: string | null
  invoiceDate: string
  invoiceItems: { td_base_amount: number }[]
}): Promise<TDResult | null> {
  const { billingPath, cnfId, superDealerId, invoiceDate, invoiceItems } = params

  // No TD for paths C and D
  if (billingPath === 'C' || billingPath === 'D') return null

  let targetPartyId: string | null = null
  let partyType: 'CNF' | 'SUPER_DEALER' = 'CNF'

  if (billingPath === 'A' && cnfId) {
    targetPartyId = cnfId
    partyType = 'CNF'
  } else if (billingPath === 'B' && superDealerId) {
    targetPartyId = superDealerId
    partyType = 'SUPER_DEALER'
  }

  if (!targetPartyId) return null

  // Find applicable TD config (party-specific first, then global)
  const { data: configs } = await supabaseAdmin
    .from('td_config')
    .select('*')
    .eq('applicable_party_type', partyType)
    .lte('valid_from', invoiceDate)
    .eq('status', 'ACTIVE')
    .order('party_id', { ascending: true, nullsFirst: false })

  const config = configs?.find(c => c.party_id === targetPartyId) || configs?.find(c => !c.party_id) || null
  if (!config) return null

  // Check valid_to
  if (config.valid_to && config.valid_to < invoiceDate) return null

  const baseAmount = invoiceItems.reduce((sum, item) => sum + (Number(item.td_base_amount) || 0), 0)
  const tdPercent = Number(config.td_percent)
  const tdAmount = Math.round(baseAmount * tdPercent) / 100

  if (tdAmount <= 0) return null

  return {
    tdAmount,
    tdPercent,
    baseAmount,
    partyId: targetPartyId,
    partyType,
    configId: config.id,
  }
}

export async function creditTD(params: {
  partyId: string
  partyType: 'CNF' | 'SUPER_DEALER'
  invoiceId: string
  tdConfigId: string
  tdPercent: number
  baseAmount: number
  tdAmount: number
  invoiceNumber: string
  invoiceDate: string
}): Promise<void> {
  const { partyId, partyType, invoiceId, tdConfigId, tdPercent, baseAmount, tdAmount, invoiceNumber, invoiceDate } = params

  // Get current balance
  const { data: lastEntry } = await supabaseAdmin
    .from('td_ledger')
    .select('balance')
    .eq('party_id', partyId)
    .order('created_at', { ascending: false })
    .limit(1)
    .single()

  const prevBalance = Number(lastEntry?.balance || 0)
  const newBalance = prevBalance + tdAmount

  const now = new Date()
  const fiscalYear = now.getMonth() >= 3
    ? `${now.getFullYear()}-${String(now.getFullYear() + 1).slice(2)}`
    : `${now.getFullYear() - 1}-${String(now.getFullYear()).slice(2)}`

  await supabaseAdmin.from('td_ledger').insert({
    party_id: partyId,
    party_type: partyType,
    entry_type: 'CREDIT',
    trigger_invoice_id: invoiceId,
    td_config_id: tdConfigId,
    td_percent: tdPercent,
    base_amount: baseAmount,
    td_amount: tdAmount,
    narration: `Auto TD on Invoice ${invoiceNumber}`,
    balance: newBalance,
    fiscal_year: fiscalYear,
    transaction_date: invoiceDate,
  })

  // Update invoice
  await supabaseAdmin.from('invoices').update({
    td_triggered: true,
    td_amount: tdAmount,
    td_credited_at: new Date().toISOString(),
  }).eq('id', invoiceId)

  // Audit log
  await supabaseAdmin.from('td_audit_log').insert({
    party_id: partyId,
    invoice_id: invoiceId,
    action: 'AUTO_CREDIT',
    new_amount: tdAmount,
    reason: `TD ${tdPercent}% auto-credited on invoice ${invoiceNumber}`,
  })
}
