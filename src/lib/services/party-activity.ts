import { supabaseAdmin } from '@/lib/supabase-server'
import { fetchAllInChunks } from '@/lib/supabase-in-chunks'
import { getPartyGroupInfoMap } from '@/lib/groups'

/**
 * Party Activity engine — the data behind the "Party Activity & Order Report".
 *
 * A party is "active" when *something happened* for them recently: they placed an
 * order (or a salesman/admin placed one on their behalf) OR a payment was recorded
 * against their account. We measure recency over a rolling 28-day window and decay
 * an activity score by 25% for every 7-day bucket without activity:
 *
 *   • activity in the last  7 days → 100%  (ACTIVE)
 *   • last activity  8–14 days ago →  75%  (SLOWING)
 *   • last activity 15–21 days ago →  50%  (AT_RISK)
 *   • last activity 22–28 days ago →  25%  (CRITICAL)
 *   • no activity in the last 28 days →  0% (DORMANT)
 *
 * Everything is DERIVED on read from `orders` and `payments` — the same
 * compute-on-read pattern the wallet, rankings and scheme-progress features use.
 * Callers pass the already-scoped party ids (company tree / salesman downline) so
 * this stays a pure aggregation with no scope leakage of its own.
 */

export const ACTIVITY_WINDOW_DAYS = 28
const DAY_MS = 24 * 60 * 60 * 1000

export type ActivityTier = 'ACTIVE' | 'SLOWING' | 'AT_RISK' | 'CRITICAL' | 'DORMANT'

export const TIER_ORDER: ActivityTier[] = ['ACTIVE', 'SLOWING', 'AT_RISK', 'CRITICAL', 'DORMANT']

export interface PartyActivityRow {
  id: string
  name: string
  code: string | null
  type: string | null
  groupId: string | null
  groupName: string | null
  salesmanId: string | null
  salesmanName: string | null
  lastOrderDate: string | null
  lastPaymentDate: string | null
  lastActivityDate: string | null
  daysSinceActivity: number | null
  orderCount28d: number
  orderValue28d: number
  paymentCount28d: number
  paymentValue28d: number
  activityPct: number
  tier: ActivityTier
}

export interface PartyActivitySummary {
  totalParties: number
  activeParties: number
  dormantParties: number
  avgActivityPct: number
  orderCount28d: number
  orderValue28d: number
  paymentValue28d: number
  byTier: Record<ActivityTier, number>
}

export interface PartyActivityReport {
  generatedAt: string
  windowDays: number
  rows: PartyActivityRow[]
  summary: PartyActivitySummary
}

type SchemaError = { code?: string; message?: string } | null | undefined

const isSchemaError = (err: SchemaError) =>
  !!err &&
  (err.code === 'PGRST200' ||
    err.code === 'PGRST204' ||
    err.code === 'PGRST205' ||
    err.code === '42703' ||
    err.code === '42P01' ||
    (err.message || '').includes('schema cache') ||
    (err.message || '').includes('does not exist'))

/** Map "days since last activity" to the decayed activity score + tier. */
function classify(daysSince: number | null): { pct: number; tier: ActivityTier } {
  if (daysSince === null) return { pct: 0, tier: 'DORMANT' }
  if (daysSince <= 7) return { pct: 100, tier: 'ACTIVE' }
  if (daysSince <= 14) return { pct: 75, tier: 'SLOWING' }
  if (daysSince <= 21) return { pct: 50, tier: 'AT_RISK' }
  if (daysSince <= 28) return { pct: 25, tier: 'CRITICAL' }
  return { pct: 0, tier: 'DORMANT' }
}

function typeName(raw: unknown): string | null {
  if (Array.isArray(raw)) return (raw[0] as { name?: string } | undefined)?.name ?? null
  return (raw as { name?: string } | null)?.name ?? null
}

interface PartyMeta {
  id: string
  name: string | null
  party_code: string | null
  status: string | null
  party_types: unknown
}

/**
 * Fetch order rows scoped to the given parties. Orders link to a party via
 * `billing_party_id` on the canonical schema; older/newer schemas use `buyer_id`.
 * We try the canonical column and fall back on schema errors so the report never
 * 500s on a divergent deployment.
 */
async function fetchOrders(ids: string[]): Promise<{ party: string; date: string; total: number; cancelled: boolean }[]> {
  const map = (
    rows: Record<string, unknown>[] | null,
    column: 'billing_party_id' | 'buyer_id',
  ) =>
    (rows || [])
      .map((r) => ({
        party: String(r[column] || ''),
        date: String(r.created_at || ''),
        total: Number(r.grand_total) || 0,
        cancelled: String(r.status || '').toUpperCase() === 'CANCELLED',
      }))
      .filter((r) => r.party && r.date)

  const primary = await fetchAllInChunks<Record<string, unknown>>(ids, (chunk) =>
    supabaseAdmin
      .from('orders')
      .select('billing_party_id, created_at, grand_total, status')
      .in('billing_party_id', chunk),
  )
  if (!primary.error) return map(primary.data, 'billing_party_id')
  if (!isSchemaError(primary.error)) return []

  const fallback = await fetchAllInChunks<Record<string, unknown>>(ids, (chunk) =>
    supabaseAdmin
      .from('orders')
      .select('buyer_id, created_at, grand_total, status')
      .in('buyer_id', chunk),
  )
  if (fallback.error) return []
  return map(fallback.data, 'buyer_id')
}

/** Fetch payment rows scoped to the given parties. */
async function fetchPayments(ids: string[]): Promise<{ party: string; date: string; amount: number }[]> {
  const { data, error } = await fetchAllInChunks<Record<string, unknown>>(ids, (chunk) =>
    supabaseAdmin
      .from('payments')
      .select('party_id, payment_date, amount, created_at')
      .in('party_id', chunk),
  )
  if (error) return []
  return (data || [])
    .map((r) => ({
      party: String(r.party_id || ''),
      date: String(r.payment_date || r.created_at || ''),
      amount: Number(r.amount) || 0,
    }))
    .filter((r) => r.party && r.date)
}

/** Compute the full party-activity report for an already-scoped set of party ids. */
export async function computePartyActivity(partyIds: string[]): Promise<PartyActivityReport> {
  const now = Date.now()
  const windowStart = now - ACTIVITY_WINDOW_DAYS * DAY_MS

  const empty: PartyActivityReport = {
    generatedAt: new Date(now).toISOString(),
    windowDays: ACTIVITY_WINDOW_DAYS,
    rows: [],
    summary: {
      totalParties: 0,
      activeParties: 0,
      dormantParties: 0,
      avgActivityPct: 0,
      orderCount28d: 0,
      orderValue28d: 0,
      paymentValue28d: 0,
      byTier: { ACTIVE: 0, SLOWING: 0, AT_RISK: 0, CRITICAL: 0, DORMANT: 0 },
    },
  }
  if (!partyIds || partyIds.length === 0) return empty

  // Party metadata. Exclude the company root itself and any non-trade COMPANY rows;
  // only ACTIVE parties belong on a behaviour report.
  const { data: partyRows } = await fetchAllInChunks<PartyMeta>(partyIds, (chunk) =>
    supabaseAdmin
      .from('parties')
      .select('id, name, party_code, status, party_types(name)')
      .in('id', chunk),
  )

  const parties = (partyRows || []).filter((p) => {
    const status = (p.status ?? 'ACTIVE').toUpperCase()
    if (status !== 'ACTIVE') return false
    return typeName(p.party_types) !== 'COMPANY'
  })
  const ids = parties.map((p) => p.id)
  if (ids.length === 0) return empty

  const [orders, payments, groupInfo] = await Promise.all([
    fetchOrders(ids),
    fetchPayments(ids),
    getPartyGroupInfoMap(ids),
  ])

  // Aggregate per party.
  interface Agg {
    lastOrder: number | null
    lastPayment: number | null
    orderCount28d: number
    orderValue28d: number
    paymentCount28d: number
    paymentValue28d: number
  }
  const agg = new Map<string, Agg>()
  for (const id of ids) {
    agg.set(id, {
      lastOrder: null,
      lastPayment: null,
      orderCount28d: 0,
      orderValue28d: 0,
      paymentCount28d: 0,
      paymentValue28d: 0,
    })
  }

  for (const o of orders) {
    const a = agg.get(o.party)
    if (!a) continue
    const t = Date.parse(o.date)
    if (Number.isNaN(t)) continue
    if (a.lastOrder === null || t > a.lastOrder) a.lastOrder = t
    if (!o.cancelled && t >= windowStart) {
      a.orderCount28d += 1
      a.orderValue28d += o.total
    }
  }

  for (const p of payments) {
    const a = agg.get(p.party)
    if (!a) continue
    const t = Date.parse(p.date)
    if (Number.isNaN(t)) continue
    if (a.lastPayment === null || t > a.lastPayment) a.lastPayment = t
    if (t >= windowStart) {
      a.paymentCount28d += 1
      a.paymentValue28d += p.amount
    }
  }

  const rows: PartyActivityRow[] = parties.map((p) => {
    const a = agg.get(p.id)!
    const lastActivity =
      a.lastOrder === null && a.lastPayment === null
        ? null
        : Math.max(a.lastOrder ?? 0, a.lastPayment ?? 0)
    const daysSince = lastActivity === null ? null : Math.floor((now - lastActivity) / DAY_MS)
    const { pct, tier } = classify(daysSince)
    const group = groupInfo.get(p.id)
    return {
      id: p.id,
      name: p.name || p.party_code || 'Unnamed',
      code: p.party_code ?? null,
      type: typeName(p.party_types),
      groupId: group?.groupId ?? null,
      groupName: group?.groupName ?? null,
      salesmanId: group?.salesmanId ?? null,
      salesmanName: group?.salesmanName ?? null,
      lastOrderDate: a.lastOrder === null ? null : new Date(a.lastOrder).toISOString(),
      lastPaymentDate: a.lastPayment === null ? null : new Date(a.lastPayment).toISOString(),
      lastActivityDate: lastActivity === null ? null : new Date(lastActivity).toISOString(),
      daysSinceActivity: daysSince,
      orderCount28d: a.orderCount28d,
      orderValue28d: Math.round(a.orderValue28d),
      paymentCount28d: a.paymentCount28d,
      paymentValue28d: Math.round(a.paymentValue28d),
      activityPct: pct,
      tier,
    }
  })

  // Sort: most-at-risk-but-not-dead first is less useful than a clear ranking —
  // list highest activity first, then by recent value, so the healthy roster reads
  // top-down and dormant parties sink to the bottom.
  rows.sort(
    (x, y) =>
      y.activityPct - x.activityPct ||
      y.orderValue28d + y.paymentValue28d - (x.orderValue28d + x.paymentValue28d) ||
      x.name.localeCompare(y.name),
  )

  const byTier: Record<ActivityTier, number> = {
    ACTIVE: 0,
    SLOWING: 0,
    AT_RISK: 0,
    CRITICAL: 0,
    DORMANT: 0,
  }
  let pctSum = 0
  let orderCount28d = 0
  let orderValue28d = 0
  let paymentValue28d = 0
  for (const r of rows) {
    byTier[r.tier] += 1
    pctSum += r.activityPct
    orderCount28d += r.orderCount28d
    orderValue28d += r.orderValue28d
    paymentValue28d += r.paymentValue28d
  }

  return {
    generatedAt: new Date(now).toISOString(),
    windowDays: ACTIVITY_WINDOW_DAYS,
    rows,
    summary: {
      totalParties: rows.length,
      activeParties: byTier.ACTIVE,
      dormantParties: byTier.DORMANT,
      avgActivityPct: rows.length ? Math.round(pctSum / rows.length) : 0,
      orderCount28d,
      orderValue28d,
      paymentValue28d,
      byTier,
    },
  }
}
