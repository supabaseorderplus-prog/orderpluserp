import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, getUserFromToken, resolveCompanyScope, resolveUserDisplayMap, getPartyDescendants, type AuthUser } from '@/lib/supabase-server'
import { parseSchemeScopeMeta } from '@/lib/scheme-scope'
import { recalcSalesmanSchemesFromPayments } from '@/lib/scheme-progress'
import { runDirectSql } from '@/lib/direct-sql'
import {
  recordInvoiceRequestPayment,
  reverseInvoiceRequestPaymentsForPayment,
} from '@/lib/invoice-request-payments'
import { resolveSelfCollectorIds, resolveSelfAssignedPartyIds } from '@/lib/collector-ids'
import { classifyBucket } from '@/lib/wallet-transfers'
import { fetchAllRows } from '@/lib/supabase-in-chunks'
import { invalidateCombinedLedgerCache } from '@/app/api/v1/ledger/combined/route'
import { effectivePaymentMode, paymentModeInsert, visibleBankName } from '@/lib/payment-mode'
import { claimPaymentApproval, completePaymentApproval, releasePaymentApproval } from '@/lib/payment-approval-links'

const fmt = (n: number) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(n)

type DbError = { code?: string; message?: string; details?: string }

function isMissingSchemaPiece(error: DbError | null | undefined, column?: string) {
  if (!error) return false
  const text = `${error.message || ''} ${error.details || ''}`.toLowerCase()
  return (
    error.code === '42P01' ||
    error.code === '42703' ||
    error.code === 'PGRST200' ||
    error.code === 'PGRST204' ||
    error.code === 'PGRST205' ||
    text.includes('schema cache') ||
    text.includes('could not find') ||
    (column ? text.includes(column.toLowerCase()) : text.includes('column'))
  )
}

function isCheckConstraintViolation(error: DbError | null | undefined, constraint: string) {
  if (!error) return false
  const text = `${error.message || ''} ${error.details || ''}`.toLowerCase()
  return error.code === '23514' && text.includes(constraint.toLowerCase())
}

function sqlLiteral(value: string) {
  return `'${value.replace(/'/g, "''")}'`
}

function sqlNullableText(value: unknown) {
  if (value === null || value === undefined || value === '') return 'NULL'
  return sqlLiteral(String(value))
}

function sqlNullableUuid(value: unknown) {
  if (typeof value !== 'string') return 'NULL'
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? sqlLiteral(value)
    : 'NULL'
}

function sqlNullableNumber(value: unknown) {
  if (value === null || value === undefined || value === '') return 'NULL'
  const numeric = Number(value)
  return Number.isFinite(numeric) ? String(numeric) : 'NULL'
}

async function ensurePartyWalletColumns() {
  const sql = `
      ALTER TABLE public.parties ADD COLUMN IF NOT EXISTS opening_balance FLOAT NOT NULL DEFAULT 0;
      ALTER TABLE public.parties ADD COLUMN IF NOT EXISTS wallet_balance FLOAT NOT NULL DEFAULT 0;
      NOTIFY pgrst, 'reload schema';
    `
  const { error } = await supabaseAdmin.rpc('exec_sql', { sql })
  if (!error) return true
  return runDirectSql(sql)
}

async function ensureWalletTransactionsSchema() {
  const sql = `
      CREATE TABLE IF NOT EXISTS public.wallet_transactions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        party_id UUID NOT NULL,
        type TEXT NOT NULL,
        amount FLOAT NOT NULL DEFAULT 0,
        balance_after FLOAT,
        reference_id TEXT,
        reference_type TEXT,
        description TEXT,
        created_by UUID,
        company_id UUID,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      ALTER TABLE public.wallet_transactions ADD COLUMN IF NOT EXISTS party_id UUID;
      ALTER TABLE public.wallet_transactions ADD COLUMN IF NOT EXISTS type TEXT;
      ALTER TABLE public.wallet_transactions ADD COLUMN IF NOT EXISTS amount FLOAT NOT NULL DEFAULT 0;
      ALTER TABLE public.wallet_transactions ADD COLUMN IF NOT EXISTS balance_after FLOAT;
      ALTER TABLE public.wallet_transactions ADD COLUMN IF NOT EXISTS reference_id TEXT;
      ALTER TABLE public.wallet_transactions ADD COLUMN IF NOT EXISTS reference_type TEXT;
      ALTER TABLE public.wallet_transactions ADD COLUMN IF NOT EXISTS description TEXT;
      ALTER TABLE public.wallet_transactions ADD COLUMN IF NOT EXISTS created_by UUID;
      ALTER TABLE public.wallet_transactions ADD COLUMN IF NOT EXISTS company_id UUID;
      ALTER TABLE public.wallet_transactions ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();
      CREATE INDEX IF NOT EXISTS idx_wallet_transactions_party_created ON public.wallet_transactions(party_id, created_at DESC);
      NOTIFY pgrst, 'reload schema';
    `
  const { error } = await supabaseAdmin.rpc('exec_sql', { sql })
  if (!error) return true
  return runDirectSql(sql)
}

// Older deployments shipped a narrow payments_payment_mode_check constraint that
// rejects some of the modes the app sends (e.g. NEFT/CHEQUE mapped from BANK/COUPON).
// Widen it to the canonical set so payments stop bouncing off the check constraint.
async function ensurePaymentModeConstraint() {
  const sql = `
      ALTER TABLE public.payments DROP CONSTRAINT IF EXISTS payments_payment_mode_check;
      ALTER TABLE public.payments ADD CONSTRAINT payments_payment_mode_check
        CHECK (payment_mode IN ('CASH','UPI','CHEQUE','NEFT','RTGS','DD','BANK','BANK_TRANSFER','ONLINE','CARD','COUPON'));
      NOTIFY pgrst, 'reload schema';
    `
  const { error } = await supabaseAdmin.rpc('exec_sql', { sql })
  if (!error) return true
  return runDirectSql(sql)
}

// When we can't ALTER the live check constraint (no DDL privilege on the
// deployment), we still need the payment to land. These ordered fallback lists
// map a UI mode to semantically-equivalent DB values, broadest-first, so we can
// probe the constraint and keep the closest value it actually accepts. CASH is
// always last because it is the most universally-allowed mode.
const PAYMENT_MODE_FALLBACKS: Record<string, string[]> = {
  BANK: ['NEFT', 'RTGS', 'BANK_TRANSFER', 'BANK', 'ONLINE', 'UPI', 'DD', 'CHEQUE', 'CARD', 'CASH'],
  BANK_TRANSFER: ['NEFT', 'RTGS', 'BANK_TRANSFER', 'BANK', 'ONLINE', 'UPI', 'DD', 'CHEQUE', 'CASH'],
  ONLINE: ['UPI', 'ONLINE', 'NEFT', 'RTGS', 'BANK', 'CARD', 'CASH'],
  CARD: ['CARD', 'UPI', 'ONLINE', 'NEFT', 'CASH'],
  // A legacy DB may only accept DD. paymentModeInsert adds an explicit coupon
  // compatibility marker in that case, so it can never surface in Bank.
  COUPON: ['COUPON', 'DD'],
  CASH: ['CASH'],
}

// Build the ordered candidate modes to probe against the live constraint.
// `dbMode` (the normalised value we already tried) goes first, then the
// UI-mode fallback chain, deduped.
function paymentModeCandidates(uiMode: string, dbMode: string): string[] {
  const ui = String(uiMode).toUpperCase()
  const fallbacks = PAYMENT_MODE_FALLBACKS[ui] ?? ['NEFT', 'UPI', 'CHEQUE', 'CASH']
  return [...new Set([dbMode, ...fallbacks])]
}

async function adjustPartyWalletBalance(partyId: string, amount: number) {
  const { data: currentParty, error: fetchBalanceErr } = await supabaseAdmin
    .from('parties')
    .select('wallet_balance')
    .eq('id', partyId)
    .single()

  if (!fetchBalanceErr) {
    const currentBalance = Number(currentParty?.wallet_balance || 0)
    const newBalance = currentBalance + amount

    const { error: updateBalanceErr } = await supabaseAdmin
      .from('parties')
      .update({ wallet_balance: newBalance })
      .eq('id', partyId)
    if (updateBalanceErr && !isMissingSchemaPiece(updateBalanceErr, 'wallet_balance')) {
      throw new Error(`Failed to update party wallet balance: ${updateBalanceErr.message}`)
    }
    return newBalance
  }

  if (!isMissingSchemaPiece(fetchBalanceErr, 'wallet_balance')) {
    throw new Error(`Failed to fetch party balance: ${fetchBalanceErr.message}`)
  }

  // Older deployments may not have wallet columns yet. Create them and apply
  // the balance movement through SQL so this payment still updates the wallet.
  const walletColumnsReady = await ensurePartyWalletColumns()
  if (!walletColumnsReady) return null

  const safeAmount = Number.isFinite(amount) ? amount : 0
  const sql = `
      UPDATE public.parties
      SET wallet_balance = COALESCE(wallet_balance, 0) + ${safeAmount}
      WHERE id = ${sqlLiteral(partyId)};
    `
  const { error: sqlErr } = await supabaseAdmin.rpc('exec_sql', { sql })
  const directOk = sqlErr ? await runDirectSql(sql) : true
  if (sqlErr && !directOk && !isMissingSchemaPiece(sqlErr, 'wallet_balance')) {
    throw new Error(`Failed to update party wallet balance: ${sqlErr.message}`)
  }

  const retry = await supabaseAdmin
    .from('parties')
    .select('wallet_balance')
    .eq('id', partyId)
    .single()
  if (!retry.error) return Number(retry.data?.wallet_balance || 0)
  return null
}

async function insertWalletTransaction(data: Record<string, unknown>) {
  const first = await supabaseAdmin.from('wallet_transactions').insert(data)
  if (!first.error) return
  if (!isMissingSchemaPiece(first.error)) {
    throw new Error(`Failed to record wallet transaction: ${first.error.message}`)
  }

  const schemaReady = await ensureWalletTransactionsSchema()
  if (schemaReady) {
    const retry = await supabaseAdmin.from('wallet_transactions').insert(data)
    if (!retry.error) return
    if (!isMissingSchemaPiece(retry.error)) {
      throw new Error(`Failed to record wallet transaction: ${retry.error.message}`)
    }

    const sql = `
        INSERT INTO public.wallet_transactions
          (party_id, type, amount, balance_after, reference_id, reference_type, description, created_by, company_id)
        VALUES
          (
            ${sqlNullableUuid(data.party_id)},
            ${sqlNullableText(data.type)},
            ${sqlNullableNumber(data.amount)},
            ${sqlNullableNumber(data.balance_after)},
            ${sqlNullableText(data.reference_id)},
            ${sqlNullableText(data.reference_type)},
            ${sqlNullableText(data.description)},
            ${sqlNullableUuid(data.created_by)},
            ${sqlNullableUuid(data.company_id)}
          );
      `
    const { error: sqlErr } = await supabaseAdmin.rpc('exec_sql', { sql })
    if (!sqlErr || await runDirectSql(sql)) return
    if (!isMissingSchemaPiece(sqlErr)) {
      throw new Error(`Failed to record wallet transaction: ${sqlErr.message}`)
    }
  }

  const minimalData = {
    party_id: data.party_id,
    type: data.type,
    amount: data.amount,
  }
  const minimal = await supabaseAdmin.from('wallet_transactions').insert(minimalData)
  if (minimal.error) {
    console.warn('[wallet_tx] persistence unavailable; statement will derive from payments:', minimal.error.message)
  }
}

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url)
    const partyId = url.searchParams.get('party')
    const from = url.searchParams.get('from')
    const to = url.searchParams.get('to')
    const mine = url.searchParams.get('mine') === 'true'
    const page = parseInt(url.searchParams.get('page') || '1')
    const limit = parseInt(url.searchParams.get('limit') || '20')
    const offset = (page - 1) * limit

      // Company scope: SUPER_ADMIN uses x-company-id header; ADMIN auto-scopes to own party_id
      const authUser = await getUserFromToken(req)
      const companyId = await resolveCompanyScope(req, authUser)

    // CRITICAL — per-collector wallet isolation:
    // A salesman's wallet/list must contain ONLY the payments THEY personally
    // collected. Salesmen routinely share (or lack) a company party_id, so
    // company scope cannot tell two collectors apart — created_by (the collector)
    // is the only reliable identity. Self-scope when the caller is a SALESMAN, or
    // when any caller explicitly asks for their own collections (?mine=true).
    const selfScope = mine || authUser?.role === 'SALESMAN'
    // Resolve the FULL set of ids the caller's payments may be stamped under
    // (app_user_id, auth id, AND any app_users row sharing their email). Matching
    // only [app_user_id, id] misses payments whose created_by was stamped with a
    // divergent/email-resolved app_users id — which is exactly why the wallet read
    // ₹0 while the admin Wallets board (which reconciles by email) showed a real
    // balance. Mirrors /api/v1/wallets + ranking-engine collector reconciliation.
    const collectorIds = selfScope ? await resolveSelfCollectorIds(authUser) : []
    if (selfScope && collectorIds.length === 0) {
      // Fail closed: cannot identify the collector → return nothing rather than
      // leaking another salesman's collections into this wallet.
      return NextResponse.json({
        success: true,
        data: [],
        pagination: { page, limit, total: 0, pages: 0 },
      })
    }

    // rows + total are computed by one of two paths below (self-scope wallet vs
    // company-scoped admin list) and then shared by enrichment + pagination.
    let rows: Record<string, unknown>[] = []
    let total = 0
    // Per-bucket collected totals over the FULL self-scope union (never the capped
    // page). The My Wallet cards must equal what the admin Wallets board attributes
    // to this collector; summing only the returned page silently undercounts any
    // salesman with more than `limit` collections. Computed server-side, off the
    // uncapped `allRows`, so the wallet balance is independent of pagination.
    let walletTotals: { cash: number; bank: number; coupon: number } | null = null
    let walletCounts: { cash: number; bank: number; coupon: number } | null = null

    if (selfScope) {
      // CRITICAL — per-collector wallet isolation, mirroring the admin Wallets board
      // so a salesman's OWN wallet equals exactly what the board attributes to them.
      //
      // We must NOT constrain by company_id here: salesmen routinely share or lack a
      // company party_id, and a payment's stored company_id can differ from the
      // caller's currently-resolved party_id — adding it silently drops genuine
      // collections and the wallet shows ₹0. created_by (+ legacy party assignment)
      // is the isolation key.
      //
      // Primary: payments this collector recorded (created_by match, incl.
      // email-resolved ids).
      // Page by unique id (not payment_date, which is non-unique and would
      // skip/repeat rows across pages) so a salesman with >1000 collections is not
      // truncated at PostgREST's max-rows — a truncated union would under-count
      // walletTotals and desync this My-Wallet view from the admin board. Display
      // order is restored by the in-memory payment_date sort below.
      const primaryRes = await fetchAllRows<Record<string, unknown>>((f, t) => {
        let q = supabaseAdmin.from('payments').select('*').in('created_by', collectorIds)
        if (partyId) q = q.eq('party_id', partyId)
        if (from) q = q.gte('payment_date', from)
        if (to) q = q.lte('payment_date', to)
        return q.order('id', { ascending: true }).range(f, t)
      })
      if (primaryRes.error) throw primaryRes.error
      const primaryRows = (primaryRes.data || []) as Record<string, unknown>[]

      // Legacy attribution: older / unauthenticated collection flows inserted
      // payments with a NULL created_by (the collector was never stamped). Attribute
      // those to this salesman ONLY for parties assigned to them — isolation holds
      // because a NULL-created_by payment surfaces only in the wallet of the salesman
      // its paying party is assigned to.
      //
      // We UNION these with the primary (created_by-stamped) rows rather than only
      // using them as a fallback when the primary set is empty. The old "primary
      // empty" gate meant that the moment a salesman collected ONE stamped payment,
      // every earlier NULL-created_by collection silently dropped off their wallet —
      // money they really collected vanished from view. Always merging both sets
      // (deduped by payment id) keeps the wallet equal to everything they collected.
      const assignedPartyIds = await resolveSelfAssignedPartyIds(collectorIds)
      let legacyRows: Record<string, unknown>[] = []
      if (assignedPartyIds.length > 0) {
        const legacyRes = await fetchAllRows<Record<string, unknown>>((f, t) => {
          let q = supabaseAdmin.from('payments').select('*').in('party_id', assignedPartyIds).is('created_by', null)
          if (partyId) q = q.eq('party_id', partyId)
          if (from) q = q.gte('payment_date', from)
          if (to) q = q.lte('payment_date', to)
          return q.order('id', { ascending: true }).range(f, t)
        })
        if (legacyRes.error && !isMissingSchemaPiece(legacyRes.error)) throw legacyRes.error
        legacyRows = (legacyRes.data || []) as Record<string, unknown>[]
      }

      // Merge primary + legacy, dedupe by payment id (a row can never be both —
      // primary requires non-null created_by, legacy requires null — but dedupe
      // defensively), then re-sort by payment_date desc so pagination is stable.
      const seenIds = new Set<string>()
      const allRows: Record<string, unknown>[] = []
      for (const row of [...primaryRows, ...legacyRows]) {
        const rowId = typeof row.id === 'string' ? row.id : null
        if (rowId) {
          if (seenIds.has(rowId)) continue
          seenIds.add(rowId)
        }
        allRows.push(row)
      }
      allRows.sort((a, b) => {
        const da = typeof a.payment_date === 'string' ? a.payment_date : ''
        const db = typeof b.payment_date === 'string' ? b.payment_date : ''
        return db.localeCompare(da)
      })

      total = allRows.length
      rows = allRows.slice(offset, offset + limit)

      // Aggregate the uncapped union into cash/bank/coupon buckets so the wallet
      // balance never depends on how many rows fit in this page. Uses the same
      // classifier as the admin board and wallet transfers (single source of truth).
      const totals = { cash: 0, bank: 0, coupon: 0 }
      const counts = { cash: 0, bank: 0, coupon: 0 }
      for (const r of allRows) {
        const bucket = classifyBucket(
          typeof r.payment_mode === 'string' ? r.payment_mode : null,
          typeof r.bank_name === 'string' ? r.bank_name : null,
        )
        totals[bucket] += Number(r.amount) || 0
        counts[bucket] += 1
      }
      walletTotals = totals
      walletCounts = counts
    } else {
      let query = supabaseAdmin
        .from('payments')
        .select('*', { count: 'exact' })
        .order('payment_date', { ascending: false })
        .range(offset, offset + limit - 1)
      // CRITICAL: Filter by company_id directly on payments table for strict data isolation
      if (companyId) query = query.eq('company_id', companyId)
      if (partyId) query = query.eq('party_id', partyId)
      if (from) query = query.gte('payment_date', from)
      if (to) query = query.lte('payment_date', to)

      const { data, count, error } = await query
      if (error) throw error
      rows = (data || []) as Record<string, unknown>[]
      total = count || 0
    }

    // Enrich with the collector's display name so ledgers/wallets can always show
    // "collected by whom" without each page re-resolving auth ids.
    const creatorIds = [...new Set(
      rows.map((p) => (typeof p.created_by === 'string' ? p.created_by : null)).filter(
        (id): id is string => Boolean(id),
      ),
    )]
    const nameMap = creatorIds.length > 0 ? await resolveUserDisplayMap(creatorIds) : {}
    const enriched = rows.map((p) => {
      const createdBy = typeof p.created_by === 'string' ? p.created_by : null
      return {
        ...p,
        payment_mode: effectivePaymentMode(
          typeof p.payment_mode === 'string' ? p.payment_mode : null,
          typeof p.bank_name === 'string' ? p.bank_name : null,
        ),
        bank_name: visibleBankName(typeof p.bank_name === 'string' ? p.bank_name : null),
        collected_by_name: createdBy ? (nameMap[createdBy]?.name ?? null) : null,
      }
    })

    return NextResponse.json({
      success: true,
      data: enriched,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
      ...(walletTotals ? { walletTotals, walletCounts } : {}),
    })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed to fetch payments' },
      { status: 500 }
    )
  }
}

export async function POST(req: NextRequest) {
  let approvalTokenToRelease: string | null = null
  let postedPaymentForApproval: Record<string, unknown> | null = null
  try {
    const requestBody = await req.json()
    let body = requestBody
    let authUser: AuthUser | null
    let companyId: string | null

    // Public party approval is authenticated by a 256-bit, single-use bearer
    // token. Claim it with compare-and-swap before touching any financial table,
    // then post the exact immutable payload saved by the initiating staff member.
    if (typeof requestBody?.approval_token === 'string') {
      const token = requestBody.approval_token
      const claim = await claimPaymentApproval(token, typeof requestBody.approver_name === 'string' ? requestBody.approver_name : '')
      if (!claim.ok) {
        const status = claim.reason === 'NOT_FOUND' ? 404 : claim.reason === 'PROCESSING' ? 409 : 410
        const message = claim.reason === 'PROCESSING'
          ? 'This payment is already being processed.'
          : claim.reason === 'APPROVED'
            ? 'This payment was already approved and the link has expired.'
            : 'This payment approval link is invalid or expired.'
        return NextResponse.json({ success: false, status: claim.reason, message }, { status })
      }
      approvalTokenToRelease = token
      body = claim.record.payload
      authUser = claim.record.auth_user
      companyId = claim.record.company_id
    } else {
      authUser = await getUserFromToken(req)
      if (!authUser) {
        return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 })
      }
      companyId = await resolveCompanyScope(req, authUser)
    }

    const { party_id, amount, payment_mode, reference_number, bank_name, proof_url, is_advance, notes, adjustments, skip_party_scheme, applied_scheme_ids } = body

    if (!party_id || !amount || !payment_mode) {
      if (approvalTokenToRelease) await releasePaymentApproval(approvalTokenToRelease, 'Saved payment payload is incomplete.')
      approvalTokenToRelease = null
      return NextResponse.json({ success: false, message: 'party_id, amount, and payment_mode required' }, { status: 400 })
    }

    // Verify the party belongs to the user's company and is verified
    if (companyId) {
      const treeIds = (await getPartyDescendants(companyId)).map((r) => r.id)
      if (!treeIds.includes(companyId)) treeIds.push(companyId)

      if (!treeIds.includes(party_id)) {
        if (approvalTokenToRelease) await releasePaymentApproval(approvalTokenToRelease, 'Party is outside the saved company scope.')
        approvalTokenToRelease = null
        return NextResponse.json({ success: false, message: 'Party not found or access denied' }, { status: 403 })
      }

      const { data: party } = await supabaseAdmin
        .from('parties')
        .select('is_verified')
        .eq('id', party_id)
        .maybeSingle()

      if (party && party.is_verified === false) {
        if (approvalTokenToRelease) await releasePaymentApproval(approvalTokenToRelease, 'Party is no longer verified.')
        approvalTokenToRelease = null
        return NextResponse.json({ success: false, message: 'Party must be verified before recording payments' }, { status: 400 })
      }
    }

    // Generate payment number
    const seq = Date.now().toString(36).toUpperCase()
    const payment_number = `RCP/WB/${seq}`

    // Normalise optional fields: empty strings → null so DB constraints are satisfied
    const toNull = (v: unknown) => (v === '' || v === undefined ? null : v)

    // Map UI-friendly mode names to DB-allowed values:
    // payments_payment_mode_check: IN ('CASH','UPI','CHEQUE','NEFT','RTGS','DD')
    //
    // COUPON is intentionally NOT mapped here. It must land as 'COUPON' so the
    // wallet classifier buckets it under the Coupon wallet — mapping it to CHEQUE
    // (a BANK mode) silently mis-filed every coupon collection under Bank. The
    // canonical constraint (see ensurePaymentModeConstraint) already allows
    // 'COUPON'; on any older/narrow deployment the check-constraint auto-heal +
    // fallback probing below still lands the payment.
    const modeMap: Record<string, string> = {
      BANK: 'NEFT',
      BANK_TRANSFER: 'NEFT',
      ONLINE: 'UPI',
      CARD: 'UPI',
    }
    const normalisedMode = modeMap[String(payment_mode).toUpperCase()] ?? payment_mode

    const insertData: Record<string, unknown> = {
      payment_number,
      party_id,
      amount: Number(amount),
      payment_mode: normalisedMode,
      reference_number: toNull(reference_number),
      bank_name: toNull(bank_name),
      proof_url: toNull(proof_url),
      is_advance: is_advance || false,
      notes: toNull(notes),
      payment_date: new Date().toISOString().split('T')[0],
      created_by: authUser?.app_user_id || authUser?.id || null,
    }
    if (companyId) insertData.company_id = companyId

    let { data: payment, error: payErr } = await supabaseAdmin
      .from('payments')
      .insert(insertData)
      .select()
      .maybeSingle()

    // Auto-heal: stale/narrow payment_mode check constraint rejecting the mode.
    // First try to widen the constraint (works only where we have DDL access).
    // Then — regardless of whether that succeeded — probe a prioritized list of
    // semantically-equivalent modes and keep the first one the live constraint
    // actually accepts. This makes the payment succeed even on deployments where
    // the ALTER never lands (e.g. no DDL privilege), which is exactly the case
    // that was surfacing "violates check constraint payments_payment_mode_check".
    if (payErr && isCheckConstraintViolation(payErr, 'payments_payment_mode_check')) {
      await ensurePaymentModeConstraint()
      for (const candidate of paymentModeCandidates(String(payment_mode), normalisedMode)) {
        const attempt = await supabaseAdmin
          .from('payments')
          .insert(paymentModeInsert(insertData, String(payment_mode), candidate))
          .select()
          .maybeSingle()
        if (!attempt.error) {
          payment = attempt.data
          payErr = null
          break
        }
        // A non-constraint error (e.g. missing column) should fall through to the
        // schema-heal block below; stop probing modes for it.
        payErr = attempt.error
        if (!isCheckConstraintViolation(attempt.error, 'payments_payment_mode_check')) break
      }
    }

    // Auto-heal: any missing column → add all optional columns and retry
    if (payErr && isMissingSchemaPiece(payErr)) {
      const healSql = `
        ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS proof_url TEXT;
        ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS bank_name TEXT;
        ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS reference_number TEXT;
        ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS is_advance BOOLEAN NOT NULL DEFAULT false;
        ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS notes TEXT;
        ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS created_by UUID;
        ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS company_id UUID;
        ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS payment_number TEXT;
        ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS payment_date DATE;
        NOTIFY pgrst, 'reload schema';
      `
      await supabaseAdmin.rpc('exec_sql', { sql: healSql }).then(() => null, () => null)
      await runDirectSql(healSql).catch(() => null)

      const retry = await supabaseAdmin.from('payments').insert(insertData).select().maybeSingle()
      if (retry.error) {
        // Last resort: only the columns that must exist
        const baseCoreData: Record<string, unknown> = {
          party_id,
          amount: Number(amount),
          payment_date: insertData.payment_date,
          bank_name: insertData.bank_name,
        }
        if (insertData.payment_number) baseCoreData.payment_number = insertData.payment_number
        if (companyId) baseCoreData.company_id = companyId

        let last = await supabaseAdmin
          .from('payments')
          .insert({ ...baseCoreData, payment_mode: normalisedMode })
          .select()
          .maybeSingle()

        if (last.error && isCheckConstraintViolation(last.error, 'payments_payment_mode_check')) {
          for (const candidate of paymentModeCandidates(String(payment_mode), normalisedMode)) {
            const attempt = await supabaseAdmin
              .from('payments')
              .insert(paymentModeInsert(baseCoreData, String(payment_mode), candidate))
              .select()
              .maybeSingle()
            if (!attempt.error) {
              last = attempt
              break
            }
            last = attempt
            if (!isCheckConstraintViolation(attempt.error, 'payments_payment_mode_check')) break
          }
        }

        if (last.error) {
          const errMsg = last.error.message || last.error.details || 'Insert failed'
          throw new Error(errMsg)
        }
        payment = last.data
        payErr = null
      } else {
        payment = retry.data
        payErr = null
      }
    }

    if (payErr) {
      const errMsg = payErr.message || (payErr as { details?: string }).details || 'Database error'
      throw new Error(errMsg)
    }
    if (!payment) throw new Error('Payment inserted but no data returned')
    if (approvalTokenToRelease) postedPaymentForApproval = payment as Record<string, unknown>

    // Process adjustments (link to REAL invoices only).
    // Confirmed invoice_requests are surfaced in the UI as "invoices" but live in
    // company_notes, not the invoices table — so their ids are not valid
    // invoices.id values. Blindly inserting a payment_invoice_links row for them
    // can violate the FK and fail the whole payment ("can't collect payment").
    // We pre-check which ids are real invoices and only link/update those; the
    // party's receivable for request-based invoices is still reduced by the
    // wallet-balance credit applied below.
    if (adjustments && Array.isArray(adjustments) && adjustments.length > 0) {
      const adjList = (adjustments as { invoiceId: string; amount: number }[])
        .filter((adj) => adj && adj.invoiceId && Number(adj.amount) > 0)
      const adjIds = [...new Set(adjList.map((adj) => adj.invoiceId))]

      const realInvoices = adjIds.length > 0
        ? (await supabaseAdmin
            .from('invoices')
            .select('id, amount_outstanding, amount_paid, grand_total')
            .in('id', adjIds)).data || []
        : []
      const invoiceById = new Map(realInvoices.map((inv) => [String(inv.id), inv]))

      for (const adj of adjList) {
        const inv = invoiceById.get(adj.invoiceId)
        if (!inv) {
          // Request-based invoice (confirmed invoice_request, not an invoices row).
          // The party's overall receivable is reduced by the wallet credit below, but
          // that alone can't tell us WHICH invoice was (partially) paid. Persist the
          // per-invoice allocation so the PARTIAL status and reduced outstanding survive
          // a reload instead of snapping back to the full grand_total.
          await recordInvoiceRequestPayment({
            request_id: adj.invoiceId,
            payment_id: payment.id,
            party_id,
            amount: Number(adj.amount),
            company_id: companyId || null,
          })
          continue
        }

        // Create payment-invoice link
        await supabaseAdmin.from('payment_invoice_links').insert({
          payment_id: payment.id,
          invoice_id: adj.invoiceId,
          adjusted_amount: adj.amount,
        })

        // Update invoice outstanding
        const newPaid = Number(inv.amount_paid) + Number(adj.amount)
        const newOutstanding = Number(inv.grand_total) - newPaid
        const newStatus = newOutstanding <= 0 ? 'PAID' : 'PARTIAL'

        await supabaseAdmin.from('invoices').update({
          amount_paid: newPaid,
          amount_outstanding: Math.max(0, newOutstanding),
          payment_status: newStatus,
        }).eq('id', adj.invoiceId)
      }
    }

    const paymentAmount = Number(amount)
    const newBalance = await adjustPartyWalletBalance(party_id, paymentAmount)

    // Log wallet transaction (non-critical — don't fail the payment if this errors)
    const walletTxData: Record<string, unknown> = {
      party_id,
      type: 'PAYMENT_CREDIT',
      amount: paymentAmount,
      balance_after: newBalance,
      reference_id: payment_number,
      reference_type: 'PAYMENT',
      description: `Payment ${payment_number} received — ${fmt(paymentAmount)} credited`,
      created_by: authUser?.app_user_id || authUser?.id || null,
      company_id: companyId || null,
    }
    await insertWalletTransaction(walletTxData)

    const appliedPartySchemeIds = Array.isArray(applied_scheme_ids)
      ? applied_scheme_ids.filter((id): id is string => typeof id === 'string' && id.length > 0)
      : undefined

    // Fire-and-forget: update the PAYING PARTY's scheme progress (non-blocking)
    updatePartySchemeProgress(
      party_id,
      paymentAmount,
      companyId || null,
      { skipPartyScheme: Boolean(skip_party_scheme), partySchemeIds: appliedPartySchemeIds },
    ).catch(
      (e) => console.warn('[scheme_progress]', e?.message),
    )

    // Fire-and-forget: recompute the COLLECTING SALESMAN's own scheme progress
    // from their payments. The salesman's wallet is the running sum of what they
    // collect, so the scheme bar must mirror that total. A full recompute keeps
    // it self-healing and uses the SAME scheme matching as the My Schemes screen
    // (group-by-type, enrolled, AND name-matched individual schemes) — the old
    // increment path silently skipped name-only individual schemes.
    recalcSalesmanSchemesFromPayments(authUser, companyId || null).catch(
      (e) => console.warn('[scheme_progress salesman]', e?.message),
    )

    // New payment changes the combined ledger — drop the cache so it appears
    // on the next open instead of after the TTL.
    invalidateCombinedLedgerCache()

    if (approvalTokenToRelease) {
      const completed = await completePaymentApproval(approvalTokenToRelease, payment)
      if (!completed) {
        // The money is already posted, so never release the link for a duplicate
        // retry. Surface a hard failure for manual reconciliation instead.
        approvalTokenToRelease = null
        throw new Error('Payment posted, but the approval link could not be closed. Contact an administrator with the payment number.')
      }
      approvalTokenToRelease = null
      postedPaymentForApproval = null
    }

    return NextResponse.json({
      success: true,
      data: {
        ...payment,
        payment_mode: effectivePaymentMode(payment.payment_mode, payment.bank_name),
        bank_name: visibleBankName(payment.bank_name),
      },
    }, { status: 201 })
  } catch (err) {
    let msg = 'Failed to record payment'
    if (err instanceof Error) {
      msg = err.message || msg
    } else if (err && typeof err === 'object') {
      const e = err as Record<string, unknown>
      const candidate = e.message ?? e.details ?? e.hint
      if (typeof candidate === 'string' && candidate.trim()) {
        msg = candidate
      } else {
        try { msg = JSON.stringify(err) || msg } catch { /* non-serializable */ }
      }
    }
    if (approvalTokenToRelease && postedPaymentForApproval) {
      // A payment row already exists. Close the bearer link even if a later
      // enrichment step failed; reopening it would allow a duplicate payment.
      await completePaymentApproval(approvalTokenToRelease, postedPaymentForApproval).catch(() => null)
      approvalTokenToRelease = null
    } else if (approvalTokenToRelease) {
      await releasePaymentApproval(approvalTokenToRelease, msg).catch(() => null)
      approvalTokenToRelease = null
    }
    console.error('[payments POST]', msg)
    return NextResponse.json({ success: false, message: msg }, { status: 500 })
  }
}

// Upserts scheme_progress for the PAYING PARTY whenever a payment is collected.
// The collecting salesman's own schemes are handled separately by
// recalcSalesmanSchemesFromPayments (a full recompute from their collections).
async function updatePartySchemeProgress(
  partyId: string,
  amount: number,
  companyId: string | null,
  opts: { skipPartyScheme?: boolean; partySchemeIds?: string[] } = {},
) {
  const today = new Date().toISOString().split('T')[0]

  // Schemes are stored with company_id = root company's party_id.
  // resolveCompanyScope() returns the caller's own party_id for non-admins,
  // which may be a leaf node several levels below the root. Walk up the party
  // hierarchy to find the root — matching the logic in /api/v1/schemes/my.
  if (companyId) {
    let current = companyId
    for (let i = 0; i < 8; i++) {
      const { data } = await supabaseAdmin
        .from('parties')
        .select('parent_party_id')
        .eq('id', current)
        .maybeSingle()
      if (!data?.parent_party_id) { companyId = current; break }
      current = data.parent_party_id
    }
  }

  async function upsertProgress(
    pid: string,
    typeName: string | null,
    options: { includeGroupSchemes?: boolean; restrictSchemeIds?: Set<string> } = {},
  ) {
    // Find active schemes matching this party's type or individually enrolled
    let schemesQuery = supabaseAdmin
      .from('schemes')
      .select('id, target_value, applicable_party_type, terms_conditions')
      .eq('status', 'ACTIVE')
      .lte('start_date', today)
      .gte('end_date', today)
    if (companyId) schemesQuery = schemesQuery.eq('company_id', companyId)

    const [typeSchemeResult, enrolledResult] = await Promise.all([
      options.includeGroupSchemes === false
        ? Promise.resolve({ data: [], error: null })
        : typeName
          ? schemesQuery.or(`applicable_party_type.eq.${typeName},applicable_party_type.eq.ALL`)
          : schemesQuery.eq('applicable_party_type', 'ALL'),
      supabaseAdmin.from('scheme_parties').select('scheme_id').eq('party_id', pid),
    ])

    const typeSchemes = typeSchemeResult.error && isMissingSchemaPiece(typeSchemeResult.error, 'company_id')
      ? []
      : (typeSchemeResult.data || [])
    const enrolledRows = enrolledResult.error ? [] : (enrolledResult.data || [])
    const enrolledIds = new Set((enrolledRows || []).map((e: { scheme_id: string }) => e.scheme_id))
    const allSchemes = (typeSchemes || []).filter(
      (scheme: { applicable_party_type: string; terms_conditions?: string | null }) => {
        const scope = parseSchemeScopeMeta(scheme.terms_conditions, scheme.applicable_party_type)
        if (scope.mode === 'INDIVIDUAL') return false
        return scope.applicablePartyType === 'ALL' || Boolean(typeName && scope.applicablePartyType === typeName)
      },
    )

    // Fetch individually enrolled schemes if any
    const extraIds = [...enrolledIds].filter(
      (id) => !allSchemes.find((s: { id: string }) => s.id === id),
    )
    if (extraIds.length > 0) {
      const { data: extra } = await supabaseAdmin
        .from('schemes')
        .select('id, target_value, applicable_party_type, terms_conditions')
        .in('id', extraIds)
        .eq('status', 'ACTIVE')
        .lte('start_date', today)
        .gte('end_date', today)
      allSchemes.push(...(extra || []))
    }

    const schemesToUpdate = options.restrictSchemeIds
      ? allSchemes.filter((scheme: { id: string }) => options.restrictSchemeIds?.has(scheme.id))
      : allSchemes

    for (const scheme of schemesToUpdate) {
      const targetValue = Number(scheme.target_value) || 1
      const { data: existing, error: existingErr } = await supabaseAdmin
        .from('scheme_progress')
        .select('id, current_value')
        .eq('scheme_id', scheme.id)
        .eq('party_id', pid)
        .maybeSingle()
      if (existingErr && isMissingSchemaPiece(existingErr)) continue

      if (existing) {
        const newVal = Number(existing.current_value) + amount
        const { error: updateErr } = await supabaseAdmin.from('scheme_progress').update({
          current_value: newVal,
          progress_percent: Math.min(100, (newVal / targetValue) * 100),
          is_achieved: newVal >= targetValue,
        }).eq('id', existing.id)
        if (updateErr && !isMissingSchemaPiece(updateErr)) throw updateErr
      } else {
        const coreProgress = {
          scheme_id: scheme.id,
          party_id: pid,
          current_value: amount,
          target_value: targetValue,
          progress_percent: Math.min(100, (amount / targetValue) * 100),
          is_achieved: amount >= targetValue,
        }

        // Step 1: full insert with optional columns
        const fullInsert: Record<string, unknown> = {
          ...coreProgress,
          is_eligible: true,
          current_slab: 0,
          ...(companyId ? { company_id: companyId } : {}),
        }
        const r1 = await supabaseAdmin.from('scheme_progress').insert(fullInsert)
        if (!r1.error) continue

        if (!isMissingSchemaPiece(r1.error)) { throw r1.error }

        // Step 2: strip current_slab + is_eligible, keep company_id
        const r2Insert: Record<string, unknown> = { ...coreProgress, ...(companyId ? { company_id: companyId } : {}) }
        const r2 = await supabaseAdmin.from('scheme_progress').insert(r2Insert)
        if (!r2.error) continue

        if (!isMissingSchemaPiece(r2.error)) { throw r2.error }

        // Step 3: also strip company_id
        const r3 = await supabaseAdmin.from('scheme_progress').insert(coreProgress)
        if (!r3.error) continue

        if (!isMissingSchemaPiece(r3.error)) { throw r3.error }

        // Step 4: minimal insert only (schema is severely degraded — log and move on)
        console.error('[scheme_progress] all insert attempts failed with schema errors for scheme', scheme.id)
      }
    }
  }

  // Get paying party's type
  const { data: payingParty } = await supabaseAdmin
    .from('parties')
    .select('id, party_types(name)')
    .eq('id', partyId)
    .maybeSingle()

  const rawPT = payingParty?.party_types as unknown
  const payingTypeName: string | null = Array.isArray(rawPT)
    ? (rawPT[0]?.name ?? null)
    : ((rawPT as { name: string } | null)?.name ?? null)

  // Only update the paying party's scheme progress if the user confirmed scheme availing
  if (!opts.skipPartyScheme) {
    const restrictSchemeIds = opts.partySchemeIds && opts.partySchemeIds.length > 0
      ? new Set(opts.partySchemeIds)
      : undefined
    await upsertProgress(partyId, payingTypeName, { restrictSchemeIds })
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const url = new URL(req.url)
    const id = url.searchParams.get('id')
    if (!id) return NextResponse.json({ success: false, message: 'Payment id required' }, { status: 400 })

    // CRITICAL: Get authenticated user and resolve company scope for data isolation
    const authUser = await getUserFromToken(req)
    const companyId = await resolveCompanyScope(req, authUser)

    // Only ADMIN / SUPER_ADMIN may delete (reverse) a payment. The UI hides the
    // button for other roles, but enforce it server-side too — a salesman must
    // not be able to reverse a collection by calling the endpoint directly.
    if (authUser?.role !== 'ADMIN' && authUser?.role !== 'SUPER_ADMIN') {
      return NextResponse.json(
        { success: false, message: 'Only admins can delete payments' },
        { status: 403 },
      )
    }

    // Verify the payment belongs to the user's company
    if (companyId) {
      const { data: payment } = await supabaseAdmin
        .from('payments')
        .select('company_id')
        .eq('id', id)
        .single()
      
      if (!payment || payment.company_id !== companyId) {
        return NextResponse.json({ success: false, message: 'Payment not found or access denied' }, { status: 403 })
      }
    }

      // Get the payment details before deleting (need party_id and amount for wallet reversal)
      const { data: paymentDetail } = await supabaseAdmin
        .from('payments')
        .select('party_id, amount')
        .eq('id', id)
        .single()

      // Reverse any invoice adjustments linked to this payment
    const { data: links } = await supabaseAdmin
      .from('payment_invoice_links')
      .select('invoice_id, adjusted_amount')
      .eq('payment_id', id)

    if (links && links.length > 0) {
      for (const link of links) {
        const { data: inv } = await supabaseAdmin
          .from('invoices')
          .select('amount_paid, grand_total')
          .eq('id', link.invoice_id)
          .single()

        if (inv) {
          const newPaid = Math.max(0, Number(inv.amount_paid) - Number(link.adjusted_amount))
          const newOutstanding = Number(inv.grand_total) - newPaid
          const newStatus = newPaid <= 0 ? 'UNPAID' : 'PARTIAL'
          await supabaseAdmin.from('invoices').update({
            amount_paid: newPaid,
            amount_outstanding: newOutstanding,
            payment_status: newStatus,
          }).eq('id', link.invoice_id)
        }
      }
      await supabaseAdmin.from('payment_invoice_links').delete().eq('payment_id', id)
    }

    // Reverse allocations recorded against request-based invoices (own ledger, no FK
    // into the invoices table) so their outstanding/PARTIAL status restores correctly.
    await reverseInvoiceRequestPaymentsForPayment(id)

    const { error } = await supabaseAdmin.from('payments').delete().eq('id', id)
      if (error) throw error

      // A deleted payment changes the combined ledger — drop the cache so it
      // reflects on the next open instead of after the TTL.
      invalidateCombinedLedgerCache()

      // Reverse wallet balance on payment deletion and log transaction
        if (paymentDetail) {
          const { data: currentParty, error: fetchBalanceErr } = await supabaseAdmin
            .from('parties')
            .select('wallet_balance')
            .eq('id', paymentDetail.party_id)
            .single()
          let newBalance: number | null = null
          if (!fetchBalanceErr) {
            const currentBalance = Number(currentParty?.wallet_balance || 0)
            newBalance = currentBalance - Number(paymentDetail.amount)
            const { error: updateBalanceErr } = await supabaseAdmin
              .from('parties')
              .update({ wallet_balance: newBalance })
              .eq('id', paymentDetail.party_id)
            if (updateBalanceErr && !isMissingSchemaPiece(updateBalanceErr, 'wallet_balance')) throw updateBalanceErr
          } else if (!isMissingSchemaPiece(fetchBalanceErr, 'wallet_balance')) {
            throw fetchBalanceErr
          }

          // Log wallet reversal transaction
          await supabaseAdmin.from('wallet_transactions').insert({
            party_id: paymentDetail.party_id,
            type: 'ADJUSTMENT',
            amount: -Number(paymentDetail.amount),
            balance_after: newBalance,
            reference_id: id,
            reference_type: 'PAYMENT_REVERSAL',
            description: `Payment deleted — ${fmt(Number(paymentDetail.amount))} reversed`,
            created_by: authUser?.app_user_id || authUser?.id || null,
            company_id: companyId || null,
          })
        }

      return NextResponse.json({ success: true })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed to delete payment' },
      { status: 500 }
    )
  }
}
