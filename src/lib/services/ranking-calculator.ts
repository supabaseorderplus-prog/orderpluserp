import { supabaseAdmin } from '@/lib/supabase-server'

export interface RankingResult {
  paymentScore: number
  volumeScore: number
  liftingScore: number
  totalScore: number
  rank: number
  avgPaymentDays: number
  totalBusinessValue: number
  totalLiftingValue: number
}

export async function calculateRanking(params: {
  partyId: string
  fiscalYear: string
}): Promise<RankingResult> {
  const { partyId, fiscalYear } = params

  // Get ranking config
  const { data: party } = await supabaseAdmin
    .from('parties')
    .select('party_type_id, party_types(name)')
    .eq('id', partyId)
    .single()

  const partyTypeData = Array.isArray(party?.party_types) ? party.party_types[0] : party?.party_types
  const partyType = partyTypeData?.name || 'CNF'

  const { data: config } = await supabaseAdmin
    .from('ranking_config')
    .select('*')
    .eq('fiscal_year', fiscalYear)
    .eq('party_type', partyType)
    .single()

  const weights = {
    payment: Number(config?.payment_performance_weight || 40),
    volume: Number(config?.business_volume_weight || 40),
    lifting: Number(config?.material_lifting_weight || 20),
  }
  const maxPayDays = config?.avg_payment_days_max || 7

  // Fiscal year date range (April-March)
  const [startYear] = fiscalYear.split('-').map(Number)
  const fyStart = `${startYear}-04-01`
  const fyEnd = `${startYear + 1}-03-31`

  // 1. Payment performance: avg days to pay
  const { data: paidInvoices } = await supabaseAdmin
    .from('payment_invoice_links')
    .select('adjustment_date, invoices!inner(invoice_date, billing_party_id)')
    .gte('adjustment_date', fyStart)
    .lte('adjustment_date', fyEnd)

  const partyPayments = (paidInvoices || []).filter((payment) => {
    const invoice = Array.isArray(payment.invoices) ? payment.invoices[0] : payment.invoices
    return invoice?.billing_party_id === partyId
  })

  let avgPaymentDays = 0
  if (partyPayments.length > 0) {
    const totalDays = partyPayments.reduce((sum, p) => {
      const invoice = Array.isArray(p.invoices) ? p.invoices[0] : p.invoices
      const invDate = new Date(invoice?.invoice_date || p.adjustment_date)
      const payDate = new Date(p.adjustment_date)
      return sum + Math.max(0, (payDate.getTime() - invDate.getTime()) / 86400000)
    }, 0)
    avgPaymentDays = totalDays / partyPayments.length
  }

  // Payment score: 100 if avg days <= maxPayDays, linear decay
  const paymentScore = avgPaymentDays <= maxPayDays ? 100 : Math.max(0, 100 - ((avgPaymentDays - maxPayDays) * 3))

  // 2. Business volume: total invoiced value
  const { data: invoiceSum } = await supabaseAdmin
    .from('invoices')
    .select('grand_total')
    .eq('billing_party_id', partyId)
    .gte('invoice_date', fyStart)
    .lte('invoice_date', fyEnd)
    .eq('status', 'ACTIVE')
    .not('is_cancelled', 'eq', true)

  const totalBusinessValue = (invoiceSum || []).reduce((s, i) => s + Number(i.grand_total), 0)

  // Get all parties of same type for relative scoring
  const { data: allParties } = await supabaseAdmin
    .from('parties')
    .select('id')
    .eq('party_type_id', party?.party_type_id || '')
    .eq('status', 'ACTIVE')

  // Get max business for normalization (simplified - use this party's value vs 10M benchmark)
  const volumeBenchmark = 10000000 // 1 crore benchmark
  const volumeScore = Math.min(100, (totalBusinessValue / volumeBenchmark) * 100)

  // 3. Material lifting (same as volume for construction chemicals)
  const totalLiftingValue = totalBusinessValue
  const liftingScore = volumeScore

  // Weighted total
  const totalScore = Math.round(
    (paymentScore * weights.payment / 100) +
    (volumeScore * weights.volume / 100) +
    (liftingScore * weights.lifting / 100)
  )

  return {
    paymentScore: Math.round(paymentScore * 100) / 100,
    volumeScore: Math.round(volumeScore * 100) / 100,
    liftingScore: Math.round(liftingScore * 100) / 100,
    totalScore,
    rank: 0, // Will be set after comparing all parties
    avgPaymentDays: Math.round(avgPaymentDays * 100) / 100,
    totalBusinessValue,
    totalLiftingValue,
  }
}

export function getFiscalYear(date?: Date): string {
  const d = date || new Date()
  const month = d.getMonth() // 0-indexed
  const year = d.getFullYear()
  if (month >= 3) {
    return `${year}-${String(year + 1).slice(2)}`
  }
  return `${year - 1}-${String(year).slice(2)}`
}

export function formatIndianCurrency(amount: number): string {
  if (amount < 0) return `-${formatIndianCurrency(-amount)}`
  if (amount >= 10000000) return `${(amount / 10000000).toFixed(2)} Cr`
  if (amount >= 100000) return `${(amount / 100000).toFixed(2)} L`
  // Indian number format
  const parts = amount.toFixed(2).split('.')
  const intPart = parts[0]
  const decPart = parts[1]
  let result = ''
  const len = intPart.length
  if (len <= 3) {
    result = intPart
  } else {
    result = intPart.slice(-3)
    let remaining = intPart.slice(0, -3)
    while (remaining.length > 2) {
      result = remaining.slice(-2) + ',' + result
      remaining = remaining.slice(0, -2)
    }
    if (remaining.length > 0) {
      result = remaining + ',' + result
    }
  }
  return `${result}.${decPart}`
}
