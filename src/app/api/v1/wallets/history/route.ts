import { NextRequest, NextResponse } from 'next/server'
import { getUserFromToken, resolveCompanyScope, supabaseAdmin, getPartyDescendants } from '@/lib/supabase-server'
import { loadCompanyTransfers } from '@/lib/wallet-transfers'
import { fetchAllInChunks } from '@/lib/supabase-in-chunks'
import { effectivePaymentMode } from '@/lib/payment-mode'

type AppUserRow = {
  id: string
  name: string | null
  email: string | null
  role_id: string | null
  party_id: string | null
  status?: string | null
  roles?: { name?: string } | { name?: string }[] | null
}

// A single statement line. `credit`/`debit`/`balance` are the running-ledger
// figures a bank-style statement needs; `type` keeps the legacy single-amount
// shape working for older callers.
interface StatementRow {
  id: string
  created_at: string
  date: string
  amount: number
  payment_mode: string
  type: 'CREDIT' | 'DEBIT'
  party_name: string
  party_code: string
  description: string
  reference: string
  credit: number
  debit: number
  balance: number
}

const isSchemaCompatError = (err: { code?: string; message?: string } | null | undefined) =>
  !!err && (
    err.code === 'PGRST200' ||
    err.code === 'PGRST204' ||
    err.code === 'PGRST205' ||
    err.code === '42703' ||
    err.code === '42P01' ||
    (err.message || '').includes('schema cache') ||
    (err.message || '').includes("Could not find the table 'public.")
  )

function roleNameFromRow(user: AppUserRow | null): string {
  if (!user?.roles) return 'UNKNOWN'
  if (Array.isArray(user.roles)) return user.roles[0]?.name || 'UNKNOWN'
  return user.roles.name || 'UNKNOWN'
}

// The real payments table exposes `reference_number` / `payment_number`. The old
// route asked for `reference_no` / `receipt_number`, which do not exist (42703) —
// and because the LEGACY query had no schema-compat retry the error was silently
// swallowed, wiping every salesman's history even while the board showed a balance.
const PAYMENT_SELECT_FULL =
  'id,party_id,amount,payment_mode,bank_name,payment_date,created_at,notes,reference_number,payment_number,created_by,parties:party_id(name,party_code)'
const PAYMENT_SELECT_MIN =
  'id,party_id,amount,payment_mode,bank_name,payment_date,created_at,created_by'

type RawPayment = {
  id: string
  party_id?: string | null
  payment_date?: string | null
  created_at: string
  amount: number | string | null
  payment_mode: string | null
  bank_name?: string | null
  notes?: string | null
  reference_number?: string | null
  payment_number?: string | null
  parties?: { name?: string | null; party_code?: string | null } | Array<{ name?: string | null; party_code?: string | null }> | null
}

const partyName = (p: RawPayment) =>
  Array.isArray(p.parties) ? p.parties[0]?.name || '' : p.parties?.name || ''
const partyCode = (p: RawPayment) =>
  Array.isArray(p.parties) ? p.parties[0]?.party_code || '' : p.parties?.party_code || ''

export async function GET(req: NextRequest) {
  try {
    const authUser = await getUserFromToken(req)
    if (!authUser) {
      return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 })
    }
    const companyId = await resolveCompanyScope(req, authUser)
    const { searchParams } = new URL(req.url)
    const userId = searchParams.get('user_id')
    const fromParam = searchParams.get('from') // inclusive ISO date (YYYY-MM-DD)
    const toParam = searchParams.get('to')     // inclusive ISO date (YYYY-MM-DD)

    if (!userId) {
      return NextResponse.json({ success: false, message: 'user_id is required' }, { status: 400 })
    }

    // Parse the requested window. `to` is made inclusive by pushing to the end of
    // that calendar day.
    const fromTime = fromParam ? new Date(`${fromParam}T00:00:00+05:30`).getTime() : null
    const toTime = toParam ? new Date(`${toParam}T23:59:59.999+05:30`).getTime() : null

    let user: AppUserRow | null = null
    let userQuery = await supabaseAdmin
      .from('users')
      .select('id,name,email,role_id,party_id,status,roles:role_id(name)')
      .eq('id', userId)
      .single()
    if (!userQuery.error) user = userQuery.data as AppUserRow
    if (userQuery.error && isSchemaCompatError(userQuery.error)) {
      userQuery = await supabaseAdmin
        .from('app_users')
        .select('id,name,email,role_id,party_id,status,roles:role_id(name)')
        .eq('id', userId)
        .single()
      if (!userQuery.error) user = userQuery.data as AppUserRow
    }

    if (!user) {
      return NextResponse.json({ success: true, data: [], meta: null })
    }
    if (String(user.status || 'ACTIVE').toUpperCase() !== 'ACTIVE') {
      return NextResponse.json({ success: false, message: 'This wallet is inactive because the user is inactive' }, { status: 403 })
    }

    // Resolve the role robustly (the embedded relation can be null when the FK is
    // missing from PostgREST's schema cache).
    let roleName = roleNameFromRow(user).toUpperCase()
    if (roleName === 'UNKNOWN' && user.role_id) {
      const { data: roleRow } = await supabaseAdmin
        .from('roles')
        .select('name')
        .eq('id', user.role_id)
        .maybeSingle()
      if (roleRow?.name) roleName = String(roleRow.name).toUpperCase()
    }

    // Resolve ALL ids this user may appear under in payments.created_by.
    const collectorIdSet = new Set<string>([userId, user.id].filter(Boolean) as string[])
    if (user.id) {
      const [auById, userEmailRow] = await Promise.all([
        supabaseAdmin.from('app_users').select('id').eq('id', user.id).maybeSingle(),
        supabaseAdmin.from('users').select('email').eq('id', user.id).maybeSingle(),
      ])
      if (auById.data?.id) collectorIdSet.add(auById.data.id)
      const resolvedEmail = user.email || userEmailRow.data?.email
      if (resolvedEmail) {
        const { data: auByEmail } = await supabaseAdmin
          .from('app_users').select('id').eq('email', resolvedEmail)
        for (const r of auByEmail || []) if (r?.id) collectorIdSet.add(r.id)
      }
    }
    const collectorIds = [...collectorIdSet]

    let allowedPartyIds: string[] | null = null
    let companyName = ''
    if (companyId) {
      const [tree, companyRow] = await Promise.all([
        getPartyDescendants(companyId),
        supabaseAdmin.from('parties').select('name').eq('id', companyId).maybeSingle(),
      ])
      const ids = tree && tree.length > 0 ? tree.map((r: { id: string }) => r.id) : []
      if (!ids.includes(companyId)) ids.push(companyId)
      allowedPartyIds = ids
      companyName = companyRow.data?.name || ''
    }

    // Salesman party links: party_salesman table OR parties.salesman_id column.
    const salesmanPartyIds = new Set<string>()
    const [linkRes, directRes] = await Promise.all([
      supabaseAdmin.from('party_salesman').select('party_id').eq('salesman_id', user.id),
      supabaseAdmin.from('parties').select('id').eq('salesman_id', user.id),
    ])
    if (!linkRes.error) {
      for (const r of (linkRes.data || []) as { party_id: string | null }[]) {
        if (r.party_id) salesmanPartyIds.add(r.party_id)
      }
    }
    if (!directRes.error) {
      for (const r of (directRes.data || []) as { id: string | null }[]) {
        if (r.id) salesmanPartyIds.add(r.id)
      }
    }

    const isSalesman = roleName === 'SALESMAN' || salesmanPartyIds.size > 0

    let partyIds: string[] = []
    if (isSalesman) {
      partyIds = [...salesmanPartyIds]
      if (partyIds.length === 0 && user.party_id) partyIds = [user.party_id]
    } else if (user.party_id) {
      partyIds = [user.party_id]
    }
    if (allowedPartyIds) {
      const scoped = partyIds.filter((id) => allowedPartyIds!.includes(id))
      if (scoped.length > 0) partyIds = scoped
    }

    // ── Primary: payments this user explicitly collected (created_by) ──────────
    const collected: RawPayment[] = []
    if (collectorIds.length > 0) {
      let primary = await fetchAllInChunks<RawPayment>(collectorIds, (chunk) =>
        supabaseAdmin.from('payments').select(PAYMENT_SELECT_FULL).in('created_by', chunk))
      if (primary.error && isSchemaCompatError(primary.error)) {
        primary = await fetchAllInChunks<RawPayment>(collectorIds, (chunk) =>
          supabaseAdmin.from('payments').select(PAYMENT_SELECT_MIN).in('created_by', chunk))
      }
      if (primary.error && !isSchemaCompatError(primary.error)) throw primary.error
      collected.push(...(primary.data || []))
    }

    // ── Legacy: NULL-created_by payments on this user's assigned parties ───────
    // Chunked + schema-tolerant (the missing-column retry is what was absent
    // before — its omission is the bug that emptied the statement).
    if (partyIds.length > 0) {
      let legacy = await fetchAllInChunks<RawPayment>(partyIds, (chunk) =>
        supabaseAdmin.from('payments').select(PAYMENT_SELECT_FULL).in('party_id', chunk).is('created_by', null))
      if (legacy.error && isSchemaCompatError(legacy.error)) {
        legacy = await fetchAllInChunks<RawPayment>(partyIds, (chunk) =>
          supabaseAdmin.from('payments').select(PAYMENT_SELECT_MIN).in('party_id', chunk).is('created_by', null))
      }
      if (!legacy.error) {
        const seen = new Set(collected.map((p) => p.id))
        for (const p of legacy.data || []) if (!seen.has(p.id)) collected.push(p)
      }
    }

    // Backfill any party names the embedded join could not resolve.
    const missingIds = [...new Set(
      collected.filter((p) => !partyName(p) && p.party_id).map((p) => p.party_id as string),
    )]
    if (missingIds.length > 0) {
      const namesRes = await fetchAllInChunks<{ id: string; name: string | null; party_code: string | null }>(
        missingIds, (chunk) => supabaseAdmin.from('parties').select('id, name, party_code').in('id', chunk))
      const map = new Map((namesRes.data || []).map((p) => [p.id, p]))
      for (const p of collected) {
        if (!partyName(p) && p.party_id) {
          const m = map.get(p.party_id)
          if (m) p.parties = { name: m.name, party_code: m.party_code }
        }
      }
    }

    // Build CREDIT entries from payments.
    const entries: Omit<StatementRow, 'credit' | 'debit' | 'balance'>[] = collected.map((p) => ({
      id: p.id,
      created_at: p.created_at,
      date: p.payment_date || p.created_at,
      amount: Number(p.amount || 0),
      payment_mode: effectivePaymentMode(p.payment_mode, p.bank_name) || 'N/A',
      type: 'CREDIT',
      party_name: partyName(p),
      party_code: partyCode(p),
      description: p.notes || 'Payment received',
      reference: p.payment_number || p.reference_number || '',
    }))

    // ── Fold in approval-based wallet transfers ───────────────────────────────
    try {
      const identityIds = new Set(collectorIds)
      const transfers = await loadCompanyTransfers(null)
      const involved = transfers.filter(
        (t) => identityIds.has(t.from_user_id) || identityIds.has(t.to_user_id),
      )
      const counterpartyIds = [
        ...new Set(involved.flatMap((t) => [t.from_user_id, t.to_user_id]).filter((id) => id && !identityIds.has(id))),
      ]
      const nameById = new Map<string, string>()
      if (counterpartyIds.length > 0) {
        const lookups = await Promise.all([
          supabaseAdmin.from('app_users').select('id,name').in('id', counterpartyIds),
          supabaseAdmin.from('users').select('id,name').in('id', counterpartyIds),
        ])
        for (const res of lookups) {
          for (const r of (res.data || []) as { id: string; name: string | null }[]) {
            if (r.id && r.name && !nameById.has(r.id)) nameById.set(r.id, r.name)
          }
        }
      }
      const bucketMode: Record<string, string> = { cash: 'CASH', bank: 'BANK', coupon: 'COUPON' }
      for (const t of involved) {
        const isSender = identityIds.has(t.from_user_id)
        const isRecipient = identityIds.has(t.to_user_id)
        if (isSender && (t.status === 'PENDING' || t.status === 'ACCEPTED')) {
          const toName = nameById.get(t.to_user_id) || 'User'
          const at = t.decided_at || t.created_at
          entries.push({
            id: `transfer-out-${t.id}`,
            created_at: at,
            date: at,
            amount: Number(t.amount) || 0,
            payment_mode: bucketMode[t.bucket] || 'BANK',
            type: 'DEBIT',
            party_name: toName,
            party_code: '',
            description: t.status === 'PENDING' ? `Transfer to ${toName} (pending)` : `Transfer to ${toName}`,
            reference: '',
          })
        }
        if (isRecipient && t.status === 'ACCEPTED') {
          const fromName = nameById.get(t.from_user_id) || 'User'
          const at = t.decided_at || t.created_at
          entries.push({
            id: `transfer-in-${t.id}`,
            created_at: at,
            date: at,
            amount: Number(t.amount) || 0,
            payment_mode: bucketMode[t.bucket] || 'BANK',
            type: 'CREDIT',
            party_name: fromName,
            party_code: '',
            description: `Transfer from ${fromName}`,
            reference: '',
          })
        }
      }
    } catch (transferErr) {
      console.warn('[wallets/history] transfer fold-in skipped:', transferErr instanceof Error ? transferErr.message : transferErr)
    }

    // ── Running balance over the FULL ledger (oldest → newest) ─────────────────
    // Computed before any date filter so the in-range opening balance is correct.
    const ascending = [...entries].sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    )
    let running = 0
    const withBalance: StatementRow[] = ascending.map((e) => {
      const credit = e.type === 'CREDIT' ? e.amount : 0
      const debit = e.type === 'DEBIT' ? e.amount : 0
      running += credit - debit
      return { ...e, credit, debit, balance: running }
    })
    const closingBalance = running

    // Opening balance for the window = running balance of the last entry BEFORE it.
    let openingBalance = 0
    for (const r of withBalance) {
      const t = new Date(r.created_at).getTime()
      if (fromTime !== null && t < fromTime) openingBalance = r.balance
    }

    // Apply the date window (if any), then return newest-first for display.
    const inWindow = withBalance.filter((r) => {
      const t = new Date(r.created_at).getTime()
      if (fromTime !== null && t < fromTime) return false
      if (toTime !== null && t > toTime) return false
      return true
    })
    const totalCredit = inWindow.reduce((s, r) => s + r.credit, 0)
    const totalDebit = inWindow.reduce((s, r) => s + r.debit, 0)

    const result = [...inWindow].sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    )

    return NextResponse.json({
      success: true,
      data: result,
      meta: {
        user_name: user.name || 'User',
        role_name: roleName,
        company_name: companyName,
        from: fromParam || null,
        to: toParam || null,
        opening_balance: openingBalance,
        closing_balance: fromTime === null && toTime === null ? closingBalance : openingBalance + totalCredit - totalDebit,
        total_credit: totalCredit,
        total_debit: totalDebit,
        count: result.length,
        generated_at: new Date().toISOString(),
      },
    })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed to fetch wallet history' },
      { status: 500 }
    )
  }
}
