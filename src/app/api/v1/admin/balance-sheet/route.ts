import { NextRequest, NextResponse } from 'next/server'
import {
  supabaseAdmin,
  getUserFromToken,
  resolveCompanyScope,
  getPartyDescendants,
} from '@/lib/supabase-server'
import { fetchAllInChunks } from '@/lib/supabase-in-chunks'
import { effectivePaymentMode } from '@/lib/payment-mode'
import { expenseAccountingDate, loadCompanyExpenses, realizedExpenseAmount } from '@/lib/expenses'
import { istDayKey, istToday } from '@/lib/datetime'

/**
 * Cash-book / balance-sheet feed.
 *
 * Returns, for a date range, the money COLLECTED (payments, split by collector
 * and bucket) and SPENT (wallet expenses), plus a per-day movement series from
 * the range start through *today*. The client anchors the latest day's CLOSING
 * balance to the live treasury (sum of wallet balances) and walks backwards by
 * each day's net movement (collection − expense) to derive every opening/closing
 * — so the cash book always reconciles with the Wallets board.
 *
 * Collection scope mirrors the Wallets board exactly: a salesman's collection is
 * the union of payments stamped with any of their collector ids PLUS legacy
 * NULL-created_by payments on parties assigned to them. This is the only scoping
 * that matches what actually landed in their wallet (company_id on a payment is
 * unreliable for field-collected cash). Fail-closed: an unresolved company scope
 * returns empty rather than leaking another company's collections.
 */

const WALLET_ROLE_NAMES = ['SALESMAN', 'ACCOUNTS_MANAGER', 'ADMIN', 'SUPER_ADMIN']
const BANK_MODES = ['UPI', 'NEFT', 'CHEQUE', 'BANK', 'RTGS', 'IMPS']
const CASH_MODES = ['CASH']
const COUPON_MODES = ['COUPON', 'VOUCHER', 'TOKEN']

type Bucket = 'cash' | 'bank' | 'coupon'

function bucketOf(mode: unknown): Bucket {
  const m = String(mode || '').toUpperCase()
  if (CASH_MODES.includes(m)) return 'cash'
  if (COUPON_MODES.includes(m)) return 'coupon'
  // Default unknown modes to bank, mirroring the Wallets board.
  return 'bank'
}

function isSchemaCompatError(err: { code?: string; message?: string } | null | undefined): boolean {
  return (
    !!err &&
    (err.code === 'PGRST200' ||
      err.code === 'PGRST204' ||
      err.code === 'PGRST205' ||
      err.code === '42703' ||
      err.code === '42P01' ||
      (err.message || '').includes('schema cache') ||
      (err.message || '').includes('Could not find'))
  )
}

interface CollectorAgg {
  user_id: string
  name: string
  cash: number
  bank: number
  coupon: number
  total: number
  count: number
}

interface DayMovement {
  date: string
  cash: number
  bank: number
  coupon: number
  collection: number
  expense: number
}

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url)
    const today = istToday()
    const from = (url.searchParams.get('from') || '').trim() || today
    const to = (url.searchParams.get('to') || '').trim() || today

    const authUser = await getUserFromToken(req)
    const companyId = await resolveCompanyScope(req, authUser)

    // Window we must pull movements for: range start → today (so the client can
    // back-walk from the live treasury). Use an exclusive upper bound one day
    // past the later of `to`/today so the full final day is captured.
    const fetchEndDay = to > today ? to : today
    const endExclusive = `${fetchEndDay}T23:59:59.999+05:30`
    const startInclusive = `${from}T00:00:00.000+05:30`

    // ── Resolve the scoped company's wallet users (salesmen carry collections) ──
    const { data: walletRoles } = await supabaseAdmin
      .from('roles')
      .select('id, name')
      .in('name', WALLET_ROLE_NAMES)
    const walletRoleIds = (walletRoles || []).map((r: { id: string }) => r.id)
    const roleNameById = Object.fromEntries(
      (walletRoles || []).map((r: { id: string; name: string }) => [r.id, r.name]),
    ) as Record<string, string>

    let scopePartyIds: string[] | null = companyId ? [companyId] : null
    if (companyId) {
      try {
        const ids = (await getPartyDescendants(companyId)).map((r) => r.id)
        if (!ids.includes(companyId)) ids.push(companyId)
        scopePartyIds = ids
      } catch {
        scopePartyIds = [companyId]
      }
    } else if (authUser?.role !== 'SUPER_ADMIN' && authUser?.party_id) {
      scopePartyIds = [authUser.party_id]
    }

    const fetchUsers = async (table: 'users' | 'app_users') => {
      const select = 'id,name,email,role_id,status'
      const build = () => {
        let q = supabaseAdmin.from(table).select(select).eq('status', 'ACTIVE')
        if (walletRoleIds.length > 0) q = q.in('role_id', walletRoleIds)
        return q
      }
      if (scopePartyIds && scopePartyIds.length > 0) {
        return fetchAllInChunks<Record<string, any>>(scopePartyIds, (chunk) =>
          build().in('party_id', chunk),
        )
      }
      return build()
    }

    let usersRes = await fetchUsers('users')
    if (usersRes.error && isSchemaCompatError(usersRes.error)) usersRes = await fetchUsers('app_users')
    const users = (usersRes.data || []) as Array<{
      id: string
      name: string
      email: string | null
      role_id: string
    }>

    const roleOf = (u: { role_id: string }) => roleNameById[u.role_id] || 'UNKNOWN'
    const nameById: Record<string, string> = {}
    for (const u of users) nameById[u.id] = u.name
    const salesmen = users.filter((u) => roleOf(u) === 'SALESMAN')
    const salesmanIds = [...new Set(salesmen.map((u) => u.id).filter(Boolean))]

    // Expenses reduce the treasury per the PAYER's identity (the Wallets board nets
    // them by user, never by company_id — a fallback-note expense can carry a null
    // company_id yet still subtract from a scoped wallet). Mirror that: load every
    // expense, keep only those paid by a wallet user in this company's scope. When
    // scope is open (single-company deploy / unscoped super admin), keep them all.
    const scopedUserIds = new Set(users.map((u) => u.id))
    const expenseInScope = (payerId: string | null | undefined): boolean =>
      !companyId || (!!payerId && scopedUserIds.has(payerId))

    if (companyId && salesmanIds.length === 0) {
      // Scoped company with no salesmen → nothing collected. Still report expenses.
      return emptyCollectionResponse(from, to, today, fetchEndDay, expenseInScope, nameById)
    }

    // Collector id union per salesman: own id + every app_users row sharing their
    // email (created_by may be stamped under any of these). Mirrors Wallets board.
    const collectorIdsByUser: Record<string, Set<string>> = {}
    for (const s of salesmen) collectorIdsByUser[s.id] = new Set<string>([s.id])
    const partyIdsByUser: Record<string, string[]> = {}

    if (salesmanIds.length > 0) {
      const [usersEmailRes, linkRes, directPartyRes] = await Promise.all([
        fetchAllInChunks<{ id: string; email: string | null }>(salesmanIds, (chunk) =>
          supabaseAdmin.from('users').select('id, email').in('id', chunk),
        ),
        fetchAllInChunks<{ salesman_id: string; party_id: string | null }>(salesmanIds, (chunk) =>
          supabaseAdmin.from('party_salesman').select('salesman_id, party_id').in('salesman_id', chunk),
        ),
        fetchAllInChunks<{ id: string; salesman_id: string | null }>(salesmanIds, (chunk) =>
          supabaseAdmin.from('parties').select('id, salesman_id').in('salesman_id', chunk),
        ),
      ])

      const emailById: Record<string, string> = {}
      for (const r of usersEmailRes.data || []) if (r.email) emailById[r.id] = r.email
      for (const l of linkRes.data || []) {
        if (l.party_id) (partyIdsByUser[l.salesman_id] ||= []).push(l.party_id)
      }
      if (!directPartyRes.error) {
        for (const p of directPartyRes.data || []) {
          if (p.id && p.salesman_id) (partyIdsByUser[p.salesman_id] ||= []).push(p.id)
        }
      }

      const emailSet = new Set<string>()
      const emailByUser: Record<string, string> = {}
      for (const s of salesmen) {
        const e = emailById[s.id] || s.email
        if (e) {
          emailByUser[s.id] = e
          emailSet.add(e)
        }
      }
      const emails = [...emailSet]
      if (emails.length > 0) {
        const auByEmailRes = await fetchAllInChunks<{ id: string; email: string | null }>(emails, (chunk) =>
          supabaseAdmin.from('app_users').select('id, email').in('email', chunk),
        )
        const idsByEmail: Record<string, string[]> = {}
        for (const r of auByEmailRes.data || []) {
          if (r.email && r.id) (idsByEmail[r.email] ||= []).push(r.id)
        }
        for (const s of salesmen) {
          const e = emailByUser[s.id]
          if (e) for (const id of idsByEmail[e] || []) collectorIdsByUser[s.id].add(id)
        }
      }
    }

    // Reverse map: collector id → owning salesman id (for attributing each payment).
    const ownerByCollectorId: Record<string, string> = {}
    for (const s of salesmen) {
      for (const cid of collectorIdsByUser[s.id]) ownerByCollectorId[cid] = s.id
    }
    const ownerByPartyId: Record<string, string> = {}
    for (const s of salesmen) {
      for (const pid of new Set(partyIdsByUser[s.id] || [])) ownerByPartyId[pid] = s.id
    }

    const allCollectorIds = [...new Set(Object.keys(ownerByCollectorId))]
    const legacyPartyIds = [...new Set(Object.keys(ownerByPartyId))]

    // ── Pull windowed payments (primary by collector + legacy by party) ──────────
    type PayRow = { amount: any; payment_mode: string; bank_name: string | null; created_by: string | null; party_id: string | null; payment_date: string }
    const select = 'amount, payment_mode, bank_name, created_by, party_id, payment_date'
    const inWindow = (q: any) => q.gte('payment_date', startInclusive).lte('payment_date', endExclusive)

    let primary: PayRow[] = []
    if (allCollectorIds.length > 0) {
      const res = await fetchAllInChunks<PayRow>(allCollectorIds, (chunk) =>
        inWindow(supabaseAdmin.from('payments').select(select).in('created_by', chunk)),
      )
      if (res.error && !isSchemaCompatError(res.error)) throw res.error
      primary = res.data || []
    }
    let legacy: PayRow[] = []
    if (legacyPartyIds.length > 0) {
      const res = await fetchAllInChunks<PayRow>(legacyPartyIds, (chunk) =>
        inWindow(supabaseAdmin.from('payments').select(select).in('party_id', chunk)).is('created_by', null),
      )
      if (res.error && !isSchemaCompatError(res.error)) throw res.error
      legacy = res.data || []
    }

    // ── Aggregate collections by collector + by day ──────────────────────────────
    const collectorAgg: Record<string, CollectorAgg> = {}
    const dayMap: Record<string, DayMovement> = {}
    const ensureDay = (d: string): DayMovement =>
      (dayMap[d] ||= { date: d, cash: 0, bank: 0, coupon: 0, collection: 0, expense: 0 })
    const ensureCollector = (uid: string): CollectorAgg =>
      (collectorAgg[uid] ||= {
        user_id: uid,
        name: nameById[uid] || 'Collector',
        cash: 0,
        bank: 0,
        coupon: 0,
        total: 0,
        count: 0,
      })

    const inRange = (d: string) => d >= from && d <= to

    const applyPayment = (row: PayRow, ownerId: string) => {
      const day = istDayKey(row.payment_date)
      if (!day) return
      const amt = parseFloat(row.amount) || 0
      if (!amt) return
      const b = bucketOf(effectivePaymentMode(row.payment_mode, row.bank_name))
      const dm = ensureDay(day)
      dm[b] += amt
      dm.collection += amt
      // Per-collector breakdown only covers the *selected* range.
      if (inRange(day)) {
        const c = ensureCollector(ownerId)
        c[b] += amt
        c.total += amt
        c.count += 1
      }
    }

    for (const row of primary) {
      const owner = row.created_by ? ownerByCollectorId[row.created_by] : null
      if (owner) applyPayment(row, owner)
    }
    for (const row of legacy) {
      const owner = row.party_id ? ownerByPartyId[row.party_id] : null
      if (owner) applyPayment(row, owner)
    }

    // ── Expenses in window (reduce treasury, fold into day movements) ────────────
    const allExpenses = await loadCompanyExpenses(null).catch(() => [])
    const byCategory: Record<string, number> = {}
    const byUser: Record<string, { user_id: string; name: string; amount: number }> = {}
    const expenseList: Array<Record<string, unknown>> = []
    let expenseTotal = 0
    let expenseCount = 0
    for (const e of allExpenses) {
      if (!expenseInScope(e.user_id)) continue
      const amt = realizedExpenseAmount(e)
      if (amt <= 0) continue
      const accountingDate = expenseAccountingDate(e)
      const day = istDayKey(accountingDate)
      if (!day || day < from || day > fetchEndDay) continue
      ensureDay(day).expense += amt
      if (inRange(day)) {
        expenseTotal += amt
        expenseCount += 1
        byCategory[e.category] = (byCategory[e.category] || 0) + amt
        const uid = e.user_id || 'unknown'
        const name = e.user_name || nameById[uid] || 'User'
        byUser[uid] = { user_id: uid, name, amount: (byUser[uid]?.amount || 0) + amt }
        expenseList.push({
          id: e.id,
          user_name: name,
          category: e.category,
          bucket: e.bucket,
          amount: amt,
          created_at: accountingDate,
          note: e.note,
        })
      }
    }
    expenseList.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))

    // ── Collection rollups over the selected range ──────────────────────────────
    const byCollector = Object.values(collectorAgg).sort((a, b) => b.total - a.total)
    const collection = byCollector.reduce(
      (acc, c) => ({
        cash: acc.cash + c.cash,
        bank: acc.bank + c.bank,
        coupon: acc.coupon + c.coupon,
        total: acc.total + c.total,
        count: acc.count + c.count,
      }),
      { cash: 0, bank: 0, coupon: 0, total: 0, count: 0 },
    )

    const days = Object.values(dayMap).sort((a, b) => a.date.localeCompare(b.date))

    return NextResponse.json({
      success: true,
      range: { from, to, today },
      collection: { ...collection, byCollector },
      expense: {
        total: expenseTotal,
        count: expenseCount,
        byCategory: Object.entries(byCategory)
          .map(([category, amount]) => ({ category, amount }))
          .sort((a, b) => b.amount - a.amount),
        byUser: Object.values(byUser).sort((a, b) => b.amount - a.amount),
        list: expenseList,
      },
      days,
    })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed to build balance sheet' },
      { status: 500 },
    )
  }
}

/** Expenses-only response when a scoped company has no salesmen/collections. */
async function emptyCollectionResponse(
  from: string,
  to: string,
  today: string,
  fetchEndDay: string,
  expenseInScope: (payerId: string | null | undefined) => boolean,
  nameById: Record<string, string>,
) {
  const allExpenses = await loadCompanyExpenses(null).catch(() => [])
  const dayMap: Record<string, DayMovement> = {}
  const byCategory: Record<string, number> = {}
  const byUser: Record<string, { user_id: string; name: string; amount: number }> = {}
  const list: Array<Record<string, unknown>> = []
  let total = 0
  let count = 0
  for (const e of allExpenses) {
    if (!expenseInScope(e.user_id)) continue
    const amt = realizedExpenseAmount(e)
    if (amt <= 0) continue
    const accountingDate = expenseAccountingDate(e)
    const day = istDayKey(accountingDate)
    if (!day || day < from || day > fetchEndDay) continue
    ;(dayMap[day] ||= { date: day, cash: 0, bank: 0, coupon: 0, collection: 0, expense: 0 }).expense += amt
    if (day >= from && day <= to) {
      total += amt
      count += 1
      byCategory[e.category] = (byCategory[e.category] || 0) + amt
      const uid = e.user_id || 'unknown'
      const name = e.user_name || nameById[uid] || 'User'
      byUser[uid] = { user_id: uid, name, amount: (byUser[uid]?.amount || 0) + amt }
      list.push({ id: e.id, user_name: name, category: e.category, bucket: e.bucket, amount: amt, created_at: accountingDate, note: e.note })
    }
  }
  return NextResponse.json({
    success: true,
    range: { from, to, today },
    collection: { cash: 0, bank: 0, coupon: 0, total: 0, count: 0, byCollector: [] },
    expense: {
      total,
      count,
      byCategory: Object.entries(byCategory).map(([category, amount]) => ({ category, amount })).sort((a, b) => b.amount - a.amount),
      byUser: Object.values(byUser).sort((a, b) => b.amount - a.amount),
      list: list.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))),
    },
    days: Object.values(dayMap).sort((a, b) => a.date.localeCompare(b.date)),
  })
}
