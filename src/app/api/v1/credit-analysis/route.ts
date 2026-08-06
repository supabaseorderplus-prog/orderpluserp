import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, getUserFromToken, resolveCompanyScope, getPartyDescendants } from '@/lib/supabase-server'
import { loadConfirmedInvoiceRequests } from '@/lib/invoice-requests-source'

/**
 * Credit analysis — data-driven creditworthiness for a party.
 *
 * Scores 5 weighted factors (raw 0-100 → 300-900 scale):
 *   1. Repayment Rate (30)        — how much of what they were billed they have paid.
 *   2. Outstanding Age (25)       — how OLD their unpaid dues are; decays as invoices
 *                                   age, so an idle account's score falls over time.
 *   3. Payment Consistency (15)   — how regularly (which months) they pay.
 *   4. Order Frequency & Recency (18) — how often and how recently they buy.
 *   5. Purchasing Power & Growth (12) — order volume and whether it is growing.
 *
 * Purchasing power also drives the suggested credit limit (monthly order value ×
 * band multiplier × repayment behaviour). Reads the REAL sources in this schema:
 * `payments`, confirmed invoice requests (table + company_notes fallback), and
 * `orders` — not the empty/absent invoices/wallet_transactions tables.
 */

const MS_PER_DAY = 1000 * 60 * 60 * 24

function monthKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}`
}

function monthsBetween(from: Date, to: Date): number {
  return Math.max(1, (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth()) + 1)
}

type Band = 'EXCELLENT' | 'GOOD' | 'FAIR' | 'POOR' | 'VERY_POOR'

function bandFor(score: number): Band {
  if (score >= 750) return 'EXCELLENT'
  if (score >= 650) return 'GOOD'
  if (score >= 550) return 'FAIR'
  if (score >= 450) return 'POOR'
  return 'VERY_POOR'
}

function recommendationFor(band: Band): string {
  switch (band) {
    case 'EXCELLENT':
      return 'Highly trustworthy. Safe to extend significant credit with standard terms.'
    case 'GOOD':
      return 'Good track record. Credit can be extended with normal terms.'
    case 'FAIR':
      return 'Moderate risk. Consider shorter credit periods or partial advance.'
    case 'POOR':
      return 'High risk. Limit credit exposure and monitor closely.'
    default:
      return 'Very high risk. Avoid extending credit or require full advance payment.'
  }
}

export async function GET(req: NextRequest) {
  let stage = 'init'
  try {
    stage = 'auth'
    const authUser = await getUserFromToken(req)
    const companyId = await resolveCompanyScope(req, authUser)

    const url = new URL(req.url)
    const partyId = url.searchParams.get('party_id')
    if (!partyId) {
      return NextResponse.json({ success: false, message: 'party_id required' }, { status: 400 })
    }

    // Lenient company-scope guard (party rows may legitimately have null company_id).
    stage = 'party-verify'
    const { data: partyRow } = await supabaseAdmin
      .from('parties')
      .select('opening_balance, company_id')
      .eq('id', partyId)
      .maybeSingle()

    const partyCompanyId = (partyRow as { company_id?: string | null } | null)?.company_id || null
    if (companyId && partyRow && partyCompanyId && partyCompanyId !== companyId) {
      const tree = await getPartyDescendants(companyId)
      const treeIds = (tree && tree.length > 0 ? tree.map((r: { id: string }) => r.id) : []) as string[]
      if (!treeIds.includes(companyId)) treeIds.push(companyId)
      if (!treeIds.includes(partyId)) {
        return NextResponse.json({ success: false, message: 'Party not found or access denied' }, { status: 403 })
      }
    }

    const openingBalance = Number((partyRow as { opening_balance?: number } | null)?.opening_balance || 0)
    const today = new Date()

    // ── Load every real source in parallel (all tolerant of missing tables) ──
    stage = 'load'
    const [invoicesRes, paymentsRes, ordersRes, confirmedReqs] = await Promise.all([
      supabaseAdmin
        .from('invoices')
        .select('invoice_number, invoice_date, grand_total, amount_paid')
        .eq('billing_party_id', partyId)
        .or('is_cancelled.is.null,is_cancelled.eq.false'),
      supabaseAdmin
        .from('payments')
        .select('amount, payment_date, created_at, status')
        .eq('party_id', partyId),
      supabaseAdmin
        .from('orders')
        .select('id, grand_total, status, created_at')
        .eq('billing_party_id', partyId),
      loadConfirmedInvoiceRequests(partyId).catch(() => []),
    ])

    const realInvoices = (invoicesRes.data || []) as Record<string, unknown>[]

    const payments = ((paymentsRes.data || []) as Record<string, unknown>[])
      .filter((p) => String(p.status || '').toUpperCase() !== 'CANCELLED')
      .map((p) => ({
        amount: Math.abs(Number(p.amount || 0)),
        date: new Date(String(p.payment_date || p.created_at || today.toISOString())),
      }))
      .filter((p) => p.amount > 0 && !Number.isNaN(p.date.getTime()))
      .sort((a, b) => a.date.getTime() - b.date.getTime())

    const orders = ((ordersRes.data || []) as Record<string, unknown>[])
      .filter((o) => String(o.status || '').toUpperCase() !== 'CANCELLED')
      .map((o) => ({
        id: String(o.id),
        amount: Number(o.grand_total || 0),
        date: new Date(String(o.created_at || today.toISOString())),
      }))
      .filter((o) => !Number.isNaN(o.date.getTime()))
      .sort((a, b) => a.date.getTime() - b.date.getTime())
    const orderTotalById = new Map(orders.map((o) => [o.id, o.amount]))

    // ── Billed events = real invoices + confirmed requests (deduped by number) ──
    type BilledEvent = { date: Date; amount: number; amountPaid: number }
    const billedNumbers = new Set(
      realInvoices.map((i) => String(i.invoice_number || '').trim()).filter(Boolean)
    )
    const billed: BilledEvent[] = []

    for (const inv of realInvoices) {
      billed.push({
        date: new Date(String(inv.invoice_date || today.toISOString())),
        amount: Number(inv.grand_total || 0),
        amountPaid: Number(inv.amount_paid || 0),
      })
    }
    for (const req of confirmedReqs) {
      const num = String(req.invoice_number || '').trim()
      if (num && billedNumbers.has(num)) continue // already counted as a real invoice
      billed.push({
        date: new Date(String(req.confirmed_at || today.toISOString())),
        amount: orderTotalById.get(req.order_id) || 0,
        amountPaid: 0,
      })
    }
    billed
      .filter((b) => !Number.isNaN(b.date.getTime()))
      .sort((a, b) => a.date.getTime() - b.date.getTime())

    const totalBilled = billed.reduce((s, b) => s + b.amount, 0)
    const totalPayments = payments.reduce((s, p) => s + p.amount, 0)

    // Nothing to assess at all.
    if (billed.length === 0 && orders.length === 0 && payments.length === 0) {
      return NextResponse.json({
        success: true,
        data: {
          party_id: partyId,
          score: null,
          raw_score: null,
          band: null,
          recommendation: 'No order, payment or invoice history yet. Cannot assess creditworthiness.',
          score_components: null,
          metrics: null,
          suggested_credit_limit: 0,
          yearly_breakdown: [],
        },
      })
    }

    // ── Settle billed dues FIFO against available credit (payments + advance) ──
    // Tells us how much is still owed and HOW OLD that unpaid balance is.
    let creditPool = totalPayments + Math.max(0, openingBalance)
    let unpaidAmount = 0
    let unpaidCount = 0
    let oldestUnpaidDays = 0
    let weightedUnpaidDays = 0
    for (const ev of billed) {
      const due = Math.max(0, ev.amount - ev.amountPaid)
      const applied = Math.min(creditPool, due)
      creditPool -= applied
      const remaining = due - applied
      if (remaining > 0.01) {
        const ageDays = Math.max(0, Math.floor((today.getTime() - ev.date.getTime()) / MS_PER_DAY))
        unpaidAmount += remaining
        unpaidCount += 1
        weightedUnpaidDays += ageDays * remaining
        if (ageDays > oldestUnpaidDays) oldestUnpaidDays = ageDays
      }
    }
    const avgUnpaidDays = unpaidAmount > 0 ? Math.round(weightedUnpaidDays / unpaidAmount) : 0
    const repaymentRate = totalBilled > 0
      ? Math.min(120, (totalPayments / totalBilled) * 100)
      : totalPayments > 0 ? 100 : 0

    // ── Order activity (purchasing power, frequency, recency, growth) ──
    const firstActivity = billed[0]?.date || orders[0]?.date || payments[0]?.date || today
    const activeMonths = monthsBetween(firstActivity, today)
    const orderCount = orders.length
    const totalOrderValue = orders.reduce((s, o) => s + o.amount, 0)
    const avgOrderValue = orderCount > 0 ? totalOrderValue / orderCount : 0
    const ordersPerMonth = orderCount / activeMonths
    const avgMonthlyOrderValue = totalOrderValue / activeMonths
    const lastOrderDate = orders.length ? orders[orders.length - 1].date : null
    const daysSinceLastOrder = lastOrderDate
      ? Math.floor((today.getTime() - lastOrderDate.getTime()) / MS_PER_DAY)
      : 9999
    const ninetyDaysAgo = new Date(today.getTime() - 90 * MS_PER_DAY)
    const recentOrderValue = orders.filter((o) => o.date >= ninetyDaysAgo).reduce((s, o) => s + o.amount, 0)
    const priorOrderValue = totalOrderValue - recentOrderValue

    const monthsWithPayment = new Set(payments.map((p) => monthKey(p.date))).size
    const paymentFrequency = Math.min(100, (monthsWithPayment / activeMonths) * 100)

    // ── Scoring (raw points) ──
    // 1. Repayment rate (30)
    let sRepay: number
    if (repaymentRate >= 98) sRepay = 30
    else if (repaymentRate >= 85) sRepay = 26
    else if (repaymentRate >= 70) sRepay = 21
    else if (repaymentRate >= 50) sRepay = 15
    else if (repaymentRate >= 30) sRepay = 9
    else if (repaymentRate >= 15) sRepay = 5
    else sRepay = Math.max(0, (repaymentRate / 15) * 5)

    // 2. Outstanding age (25) — older unpaid dues drag the score down over time
    let sAging: number
    if (unpaidAmount <= 0) sAging = 25
    else if (avgUnpaidDays <= 15) sAging = 22
    else if (avgUnpaidDays <= 30) sAging = 18
    else if (avgUnpaidDays <= 60) sAging = 12
    else if (avgUnpaidDays <= 90) sAging = 7
    else if (avgUnpaidDays <= 180) sAging = 3
    else sAging = 0

    // 3. Payment consistency (15)
    let sFreq: number
    if (paymentFrequency >= 80) sFreq = 15
    else if (paymentFrequency >= 60) sFreq = 12
    else if (paymentFrequency >= 40) sFreq = 8
    else if (paymentFrequency >= 20) sFreq = 4
    else sFreq = Math.max(0, (paymentFrequency / 20) * 4)

    // 4. Order frequency & recency (18)
    let sOrders = 0
    if (ordersPerMonth >= 4) sOrders += 10
    else if (ordersPerMonth >= 2) sOrders += 8
    else if (ordersPerMonth >= 1) sOrders += 6
    else if (ordersPerMonth >= 0.5) sOrders += 4
    else if (orderCount > 0) sOrders += 2
    if (daysSinceLastOrder <= 30) sOrders += 8
    else if (daysSinceLastOrder <= 60) sOrders += 6
    else if (daysSinceLastOrder <= 120) sOrders += 3
    else if (daysSinceLastOrder <= 240) sOrders += 1

    // 5. Purchasing power & growth (12)
    let sPower = 0
    if (avgMonthlyOrderValue >= 100000) sPower += 8
    else if (avgMonthlyOrderValue >= 50000) sPower += 6
    else if (avgMonthlyOrderValue >= 20000) sPower += 4
    else if (avgMonthlyOrderValue >= 5000) sPower += 2
    else if (avgMonthlyOrderValue > 0) sPower += 1
    if (priorOrderValue > 0) {
      if (recentOrderValue >= priorOrderValue * 1.2) sPower += 4
      else if (recentOrderValue >= priorOrderValue * 0.8) sPower += 2
    } else if (recentOrderValue > 0) {
      sPower += 2
    }

    const rawScore = Math.round(sRepay + sAging + sFreq + sOrders + sPower)
    const creditScore = Math.round(300 + (rawScore / 100) * 600)
    const band = bandFor(creditScore)
    const recommendation = recommendationFor(band)

    // ── Suggested credit limit: purchasing power × band × repayment behaviour ──
    const bandMultiplier: Record<Band, number> = { EXCELLENT: 3, GOOD: 2, FAIR: 1, POOR: 0.5, VERY_POOR: 0 }
    const rawLimit = avgMonthlyOrderValue * bandMultiplier[band] * Math.min(1, repaymentRate / 100)
    const suggestedCreditLimit = Math.max(0, Math.round(rawLimit / 1000) * 1000)
    const exposure = Math.max(0, totalBilled - totalPayments - Math.max(0, openingBalance))

    // ── Yearly breakdown (kept for the payments-page credit detail view) ──
    const yearlyMap = new Map<number, { invoiced: number; paid: number; invoice_count: number; payment_count: number; payment_amount: number }>()
    const yearEntry = (year: number) =>
      yearlyMap.get(year) || { invoiced: 0, paid: 0, invoice_count: 0, payment_count: 0, payment_amount: 0 }
    for (const ev of billed) {
      const y = ev.date.getFullYear()
      const e = yearEntry(y)
      e.invoiced += ev.amount
      e.paid += ev.amountPaid
      e.invoice_count += 1
      yearlyMap.set(y, e)
    }
    for (const p of payments) {
      const y = p.date.getFullYear()
      const e = yearEntry(y)
      e.payment_count += 1
      e.payment_amount += p.amount
      yearlyMap.set(y, e)
    }
    const yearlyBreakdown = Array.from(yearlyMap.entries())
      .sort(([a], [b]) => a - b)
      .map(([year, d]) => ({
        year,
        ...d,
        payment_rate: d.invoiced > 0 ? Math.round((d.paid / d.invoiced) * 1000) / 10 : 0,
        avg_monthly_repayment: Math.round(d.payment_amount / 12),
      }))

    return NextResponse.json({
      success: true,
      data: {
        party_id: partyId,
        score: creditScore,
        raw_score: rawScore,
        band,
        recommendation,
        suggested_credit_limit: suggestedCreditLimit,
        score_components: {
          repayment_rate: { score: Math.round(sRepay * 10) / 10, max: 30, label: 'Repayment Rate' },
          outstanding_age: { score: Math.round(sAging * 10) / 10, max: 25, label: 'Outstanding Age' },
          payment_consistency: { score: Math.round(sFreq * 10) / 10, max: 15, label: 'Payment Consistency' },
          order_activity: { score: Math.round(sOrders * 10) / 10, max: 18, label: 'Order Frequency & Recency' },
          purchasing_power: { score: Math.round(sPower * 10) / 10, max: 12, label: 'Purchasing Power' },
        },
        metrics: {
          // Preserved keys (consumed by payments + invoices pages)
          total_invoices: billed.length,
          total_invoiced: Math.round(totalBilled),
          total_paid: Math.round(totalPayments),
          total_outstanding: Math.round(unpaidAmount),
          payment_rate: Math.round(repaymentRate * 10) / 10,
          avg_outstanding_days: avgUnpaidDays,
          payment_frequency: Math.round(paymentFrequency),
          avg_monthly_invoiced: Math.round(avgMonthlyOrderValue), // purchasing power → drives suggested limit
          avg_monthly_payment: Math.round(totalPayments / activeMonths),
          avg_monthly_repayment_yearly: Math.round(totalPayments / activeMonths),
          avg_monthly_invoice_count: Math.round((billed.length / activeMonths) * 10) / 10,
          avg_monthly_payment_count: Math.round((payments.length / activeMonths) * 10) / 10,
          active_months: activeMonths,
          unpaid_invoice_count: unpaidCount,
          // New, richer signals
          order_count: orderCount,
          total_order_value: Math.round(totalOrderValue),
          avg_order_value: Math.round(avgOrderValue),
          orders_per_month: Math.round(ordersPerMonth * 10) / 10,
          days_since_last_order: daysSinceLastOrder === 9999 ? null : daysSinceLastOrder,
          oldest_unpaid_days: oldestUnpaidDays,
          exposure: Math.round(exposure),
          suggested_credit_limit: suggestedCreditLimit,
        },
        yearly_breakdown: yearlyBreakdown,
      },
    })
  } catch (err) {
    let errorMessage = 'Credit analysis failed'
    if (err instanceof Error) errorMessage = err.message || errorMessage
    console.error('Credit analysis error at stage:', stage, err)
    return NextResponse.json({ success: false, message: errorMessage }, { status: 500 })
  }
}
