import { supabaseAdmin } from '@/lib/supabase-server'

export interface CDResult {
  slab: string
  daysTaken: number
  cdPercent: number
  cdAmount: number
  configId: string
}

export function determineCDSlab(daysTaken: number): string | null {
  if (daysTaken <= 0) return 'ADVANCE'
  if (daysTaken <= 7) return 'WITHIN_7'
  if (daysTaken <= 14) return 'WITHIN_14'
  if (daysTaken <= 21) return 'WITHIN_21'
  return null // No CD beyond 21 days
}

export async function calculateCD(params: {
  invoiceValue: number     // Excl. GST (taxable_amount)
  invoiceDate: string
  paymentDate: string
  partyId: string
  partyType: string
}): Promise<CDResult | null> {
  const { invoiceValue, invoiceDate, paymentDate, partyId, partyType } = params

  const invDate = new Date(invoiceDate)
  const payDate = new Date(paymentDate)
  const daysTaken = Math.floor((payDate.getTime() - invDate.getTime()) / (1000 * 60 * 60 * 24))

  const slab = determineCDSlab(daysTaken)
  if (!slab) return null

  // Find applicable CD config
  const { data: configs } = await supabaseAdmin
    .from('cd_config')
    .select('*')
    .eq('slab_name', slab)
    .eq('status', 'ACTIVE')
    .lte('valid_from', invoiceDate)
    .order('party_id', { ascending: true, nullsFirst: false })

  // Party-specific first, then type-specific, then global
  const config = configs?.find(c => c.party_id === partyId)
    || configs?.find(c => !c.party_id && c.applicable_party_type === partyType)
    || configs?.find(c => !c.party_id)
    || null

  if (!config) return null
  if (config.valid_to && config.valid_to < invoiceDate) return null

  const cdPercent = Number(config.cd_percent)
  const cdAmount = Math.round(invoiceValue * cdPercent) / 100

  if (cdAmount <= 0) return null

  return {
    slab,
    daysTaken,
    cdPercent,
    cdAmount,
    configId: config.id,
  }
}

export async function creditCD(params: {
  partyId: string
  partyType: string
  paymentId: string
  invoiceId: string
  cdConfigId: string
  cdSlab: string
  cdPercent: number
  invoiceValue: number
  cdAmount: number
  paymentDate: string
  invoiceDate: string
  daysTaken: number
  invoiceNumber: string
}): Promise<void> {
  const { partyId, partyType, paymentId, invoiceId, cdConfigId, cdSlab, cdPercent, invoiceValue, cdAmount, paymentDate, invoiceDate, daysTaken, invoiceNumber } = params

  const { data: lastEntry } = await supabaseAdmin
    .from('cd_ledger')
    .select('balance')
    .eq('party_id', partyId)
    .order('created_at', { ascending: false })
    .limit(1)
    .single()

  const prevBalance = Number(lastEntry?.balance || 0)
  const newBalance = prevBalance + cdAmount

  const now = new Date()
  const fiscalYear = now.getMonth() >= 3
    ? `${now.getFullYear()}-${String(now.getFullYear() + 1).slice(2)}`
    : `${now.getFullYear() - 1}-${String(now.getFullYear()).slice(2)}`

  await supabaseAdmin.from('cd_ledger').insert({
    party_id: partyId,
    party_type: partyType,
    entry_type: 'CREDIT',
    payment_id: paymentId,
    invoice_id: invoiceId,
    cd_config_id: cdConfigId,
    cd_slab: cdSlab,
    cd_percent: cdPercent,
    invoice_value: invoiceValue,
    cd_amount: cdAmount,
    payment_date: paymentDate,
    invoice_date: invoiceDate,
    days_taken: daysTaken,
    narration: `CD ${cdSlab} on Inv ${invoiceNumber} (${daysTaken} days)`,
    balance: newBalance,
    fiscal_year: fiscalYear,
    transaction_date: paymentDate,
  })
}
