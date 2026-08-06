import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, getUserFromToken, resolveCompanyScope } from '@/lib/supabase-server'
import { getScopedPartyIdsForUser } from '@/lib/party-scope'
import { computeCurrentBalances } from '@/lib/party-balance'
import { getPaidAmountsByRequestIds } from '@/lib/invoice-request-payments'
import { fetchAllInChunks, fetchAllRows } from '@/lib/supabase-in-chunks'
import { INVOICE_REQUEST_FALLBACK_PREFIX, parseInvoiceRequestNote } from '@/lib/invoice-requests-source'

type DbError = { code?: string; message?: string; details?: string }
type PartyBalanceRow = {
  id: string
  name: string
  party_code: string
  wallet_balance?: number | string | null
  opening_balance?: number | string | null
  party_types: { name: string } | { name: string }[] | null
  created_at: string
}

function getPartyTypeName(raw: unknown): string | null {
  if (Array.isArray(raw)) return raw[0]?.name ?? null
  return ((raw as { name?: string } | null)?.name) ?? null
}

function isMissingColumn(error: DbError | null | undefined, column: string) {
  if (!error) return false
  const text = `${error.message || ''} ${error.details || ''}`.toLowerCase()
  return (
    error.code === '42703' ||
    error.code === 'PGRST204' ||
    text.includes('schema cache') ||
    text.includes(column.toLowerCase())
  )
}

export async function GET(req: NextRequest) {
  try {
    const authUser = await getUserFromToken(req)
    if (!authUser) {
      return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 })
    }

    let companyId = await resolveCompanyScope(req, authUser)
    if (!companyId && authUser.role !== 'SUPER_ADMIN') {
      companyId = authUser.party_id || null
    }
    if (!companyId && authUser.role !== 'SUPER_ADMIN') {
      return NextResponse.json({ success: false, message: 'Company scope is required' }, { status: 403 })
    }

    const scopedPartyIds = await getScopedPartyIdsForUser(authUser, companyId)
    if (scopedPartyIds !== null && scopedPartyIds.length === 0) {
      return NextResponse.json({ success: true, data: [] })
    }

    // Fetch all unpaid/partial invoices grouped by party
    // Only invoices with order_status = 'CONFIRM' (i.e. "Mark as Invoiced" has been done)
    // represent real receivables. Pre-invoice orders are never considered as dues.
    // Fetch ALL active non-cancelled invoices (not just UNPAID/PARTIAL) so that
    // invoice_count reflects total invoices, not just outstanding ones.
    // Chunked: large company/salesman scopes overflow PostgREST's URL-encoded
    // .in() filter (undici 16KB header limit ≈ 400+ UUIDs → 500). Merge + re-sort.
    const INVOICE_SELECT = `
        id,
        invoice_number,
        invoice_date,
        grand_total,
        amount_paid,
        amount_outstanding,
        payment_status,
        billing_party_id,
        billing_party:parties!billing_party_id(id, name, party_code, party_types(name))
      `
    let invoices: any[] | null
    let error: DbError | null
    if (scopedPartyIds !== null) {
      const res = await fetchAllInChunks<any>(scopedPartyIds, (chunk) =>
        supabaseAdmin
          .from('invoices')
          .select(INVOICE_SELECT)
          .eq('status', 'ACTIVE')
          .not('is_cancelled', 'eq', true)
          .in('billing_party_id', chunk),
      )
      invoices = res.data
      error = res.error
      if (invoices) {
        invoices.sort((a, b) => String(b?.invoice_date ?? '').localeCompare(String(a?.invoice_date ?? '')))
      }
    } else {
      // SUPER_ADMIN (no company scope) reads the whole table. A single unranged
      // select is capped at PostgREST's max-rows (1000), silently dropping every
      // invoice past the first page once the table grows. Page through all rows.
      // invoice_date is not unique, so add `id` as a stable tiebreaker.
      const res = await fetchAllRows<any>((from, to) =>
        supabaseAdmin
          .from('invoices')
          .select(INVOICE_SELECT)
          .eq('status', 'ACTIVE')
          .not('is_cancelled', 'eq', true)
          .order('invoice_date', { ascending: false })
          .order('id', { ascending: true })
          .range(from, to),
      )
      invoices = res.data
      error = res.error
    }
    if (error) {
      console.error('[outstanding] Supabase query error:', JSON.stringify(error))
      throw new Error(error.message || 'Failed to query invoices')
    }

    // Group by party — count ALL invoices but only accumulate outstanding for UNPAID/PARTIAL
    const partyMap = new Map<string, {
      party_id: string
      party_name: string
      party_code: string
      party_type: string | null
      total_outstanding: number
      invoice_count: number
      oldest_invoice_date: string
      invoices: { id: string; invoice_number: string; invoice_date: string; grand_total: number; amount_paid: number; amount_outstanding: number; payment_status: string }[]
    }>()

    for (const inv of invoices || []) {
      const party = inv.billing_party as unknown as { id: string; name: string; party_code: string; party_types: unknown } | null
      if (!party) continue

      const isUnpaid = inv.payment_status === 'UNPAID' || inv.payment_status === 'PARTIAL'
      const outstanding = isUnpaid ? Number(inv.amount_outstanding) : 0
      const invoiceEntry = {
        id: inv.id,
        invoice_number: inv.invoice_number,
        invoice_date: inv.invoice_date,
        grand_total: Number(inv.grand_total),
        amount_paid: Number(inv.amount_paid),
        amount_outstanding: Number(inv.amount_outstanding),
        payment_status: inv.payment_status,
      }

      const existing = partyMap.get(party.id)
      if (existing) {
        existing.invoice_count += 1
        existing.total_outstanding += outstanding
        if (isUnpaid) existing.invoices.push(invoiceEntry)
        if (inv.invoice_date < existing.oldest_invoice_date) {
          existing.oldest_invoice_date = inv.invoice_date
        }
      } else {
        partyMap.set(party.id, {
          party_id: party.id,
          party_name: party.name,
          party_code: party.party_code,
          party_type: getPartyTypeName(party.party_types),
          total_outstanding: outstanding,
          invoice_count: 1,
          oldest_invoice_date: inv.invoice_date,
          invoices: isUnpaid ? [invoiceEntry] : [],
        })
      }
    }

    // Step 2: include parties with negative effective balance as outstanding dues.
    // Chunk the id-scoped fetch so large scopes don't overflow the .in() URL.
    const fetchPartyBalances = async (
      sel: string,
    ): Promise<{ data: PartyBalanceRow[] | null; error: DbError | null }> => {
      if (scopedPartyIds !== null) {
        return fetchAllInChunks<PartyBalanceRow>(scopedPartyIds, (chunk) =>
          supabaseAdmin.from('parties').select(sel).in('id', chunk),
        )
      }
      // SUPER_ADMIN scans every party. An unranged select tops out at PostgREST's
      // max-rows (1000), so parties past row 1000 (and their negative balances)
      // never reach the dues list. Page through all of them.
      return (await fetchAllRows<PartyBalanceRow>((from, to) =>
        supabaseAdmin.from('parties').select(sel).order('id').range(from, to) as unknown as PromiseLike<{
          data: PartyBalanceRow[] | null
          error: DbError | null
        }>,
      )) as {
        data: PartyBalanceRow[] | null
        error: DbError | null
      }
    }

    let walletBalanceColumnMissing = false
    let { data: allParties, error: partiesErr } = await fetchPartyBalances(
      'id, name, party_code, wallet_balance, opening_balance, party_types(name), created_at',
    )
    if (partiesErr && isMissingColumn(partiesErr, 'wallet_balance')) {
      walletBalanceColumnMissing = true
      const retry = await fetchPartyBalances(
        'id, name, party_code, opening_balance, party_types(name), created_at',
      )
      allParties = retry.data
      partiesErr = retry.error
    }
    if (partiesErr) throw new Error(partiesErr.message || 'Failed to query party balances')

    const paymentCreditMap: Record<string, number> = {}
    if (walletBalanceColumnMissing && allParties && allParties.length > 0) {
      const partyIds = allParties.map((p) => p.id).filter(Boolean)
      const { data: paymentRows, error: paymentErr } = await fetchAllInChunks<{ party_id: string; amount: number | string }>(
        partyIds,
        (chunk) => supabaseAdmin.from('payments').select('party_id, amount').in('party_id', chunk),
      )
      if (paymentErr) {
        console.warn('[outstanding] payment-derived wallet fallback failed:', paymentErr.message)
      }
      for (const payment of paymentRows || []) {
        const partyId = String(payment.party_id || '')
        if (!partyId) continue
        paymentCreditMap[partyId] = (paymentCreditMap[partyId] || 0) + Number(payment.amount || 0)
      }
    }

    // Derive true current balance (opening + payments − invoices, incl. confirmed
    // invoice_requests/orders). This is the authoritative due — the wallet_balance
    // column doesn't exist, and the payment-only fallback ignores invoiced orders.
    const currentBalances = await computeCurrentBalances(
      (allParties || []).map((p) => ({ id: p.id, opening_balance: Number(p.opening_balance || 0) }))
    )

    for (const p of allParties || []) {
      const walletBalance = 'wallet_balance' in p
        ? Number(p.wallet_balance || 0)
        : Number(paymentCreditMap[p.id] || 0)
      const effectiveBal = currentBalances[p.id] ?? (walletBalance + Number(p.opening_balance || 0))
      if (effectiveBal >= 0) continue
      const dueAmount = Math.abs(effectiveBal)

      const existing = partyMap.get(p.id)
      if (existing) {
        existing.total_outstanding = dueAmount
      } else {
        partyMap.set(p.id, {
          party_id: p.id,
          party_name: p.name,
          party_code: p.party_code,
          party_type: getPartyTypeName(p.party_types),
          total_outstanding: dueAmount,
          invoice_count: 0,
          oldest_invoice_date: p.created_at,
          invoices: [],
        })
      }
    }

    // Step 3: pull confirmed invoice requests from BOTH supported backends and
    // count them per party. Some deployments persist requests in company_notes
    // when the dedicated table is unavailable. The balance calculation already
    // includes those fallback rows, so ignoring them here produced a due amount
    // alongside an incorrect "0 invoices" label.
    //
    // This runs AFTER the wallet-balance block so all scoped parties are known.
    {
      type ConfirmedRequestRow = {
        id: string
        order_id: string
        invoice_number: string
        confirmed_at: string | null
        created_at: string | null
        party_id: string
        company_id: string | null
      }

      const IR_SELECT = 'id, order_id, invoice_number, confirmed_at, created_at, party_id, company_id'
      let tableReqs: ConfirmedRequestRow[] | null
      if (scopedPartyIds !== null) {
        const res = await fetchAllInChunks<ConfirmedRequestRow>(scopedPartyIds, (chunk) =>
          supabaseAdmin
            .from('invoice_requests')
            .select(IR_SELECT)
            .eq('status', 'CONFIRMED')
            .in('party_id', chunk),
        )
        // A missing invoice_requests table is expected on fallback deployments.
        tableReqs = res.error ? [] : res.data
      } else {
        // SUPER_ADMIN reads every confirmed request. Page past PostgREST's
        // max-rows cap (1000); confirmed_at is not unique, so add `id` as a
        // stable tiebreaker for range paging.
        const res = await fetchAllRows<ConfirmedRequestRow>((from, to) =>
          supabaseAdmin
            .from('invoice_requests')
            .select(IR_SELECT)
            .eq('status', 'CONFIRMED')
            .order('confirmed_at', { ascending: false })
            .order('id', { ascending: true })
            .range(from, to),
        )
        tableReqs = res.error ? [] : res.data
      }

      const allowedPartyIds = new Set((allParties || []).map((party) => party.id))
      const partiesById = new Map((allParties || []).map((party) => [party.id, party]))
      const requestsByKey = new Map<string, ConfirmedRequestRow>()
      for (const row of tableReqs || []) {
        const key = `${row.party_id}:${row.invoice_number || row.id}`
        requestsByKey.set(key, row)
      }

      // Scan the fallback once (instead of once per party), then merge it behind
      // table rows so a migrated request is never counted twice.
      const fallbackRes = await fetchAllRows<{ id: string; note: string | null; created_at: string | null }>(
        (from, to) =>
          supabaseAdmin
            .from('company_notes')
            .select('id, note, created_at')
            .like('note', `${INVOICE_REQUEST_FALLBACK_PREFIX}%`)
            .order('created_at', { ascending: false })
            .order('id', { ascending: true })
            .range(from, to),
      )
      if (!fallbackRes.error) {
        for (const noteRow of fallbackRes.data || []) {
          const parsed = parseInvoiceRequestNote(noteRow.note)
          if (!parsed || String(parsed.status || '') !== 'CONFIRMED') continue
          const partyId = String(parsed.party_id || '')
          if (!partyId || !allowedPartyIds.has(partyId)) continue
          const row: ConfirmedRequestRow = {
            id: String(parsed.id || noteRow.id),
            order_id: String(parsed.order_id || ''),
            invoice_number: String(parsed.invoice_number || ''),
            confirmed_at: parsed.confirmed_at ? String(parsed.confirmed_at) : null,
            created_at: String(parsed.created_at || noteRow.created_at || ''),
            party_id: partyId,
            company_id: parsed.company_id ? String(parsed.company_id) : null,
          }
          const key = `${partyId}:${row.invoice_number || row.id}`
          if (!requestsByKey.has(key)) requestsByKey.set(key, row)
        }
      }

      const confirmedReqs = [...requestsByKey.values()]
      const orderIds = [...new Set(confirmedReqs.map((row) => row.order_id).filter(Boolean))]
      const orderTotals = new Map<string, number>()
      if (orderIds.length > 0) {
        const orderRes = await fetchAllInChunks<{ id: string; grand_total: number | string }>(orderIds, (chunk) =>
          supabaseAdmin.from('orders').select('id, grand_total').in('id', chunk),
        )
        for (const order of orderRes.data || []) {
          orderTotals.set(order.id, Number(order.grand_total || 0))
        }
      }

      // Fold in any partial payments recorded against these request-based invoices
      // (their own ledger — they aren't rows in the invoices table) so the status
      // and outstanding here match what the collect-payment modal shows.
      const paidByRequestId = await getPaidAmountsByRequestIds(
        (confirmedReqs || []).map((ir) => String(ir.id)),
      )

      // Collect every real invoice number (including paid invoices) by party to
      // avoid double-counting a request that was also materialized in invoices.
      const knownInvoiceNumbers = new Set<string>()
      for (const inv of invoices || []) {
        if (inv.billing_party_id && inv.invoice_number) {
          knownInvoiceNumbers.add(`${inv.billing_party_id}:${inv.invoice_number}`)
        }
      }

      for (const ir of confirmedReqs || []) {
        if (!ir.party_id) continue
        if (ir.invoice_number && knownInvoiceNumbers.has(`${ir.party_id}:${ir.invoice_number}`)) continue

        const grandTotal = orderTotals.get(ir.order_id) || 0
        const amountPaid = paidByRequestId.get(String(ir.id)) || 0
        const amountOutstanding = Math.max(0, grandTotal - amountPaid)
        const paymentStatus = amountPaid <= 0 ? 'UNPAID' : amountOutstanding <= 0 ? 'PAID' : 'PARTIAL'
        const invoiceDate = (ir.confirmed_at || ir.created_at || new Date().toISOString()).split('T')[0]
        const invoiceEntry = {
          id: ir.id,
          invoice_number: ir.invoice_number || `IR/${ir.id.slice(0, 8)}`,
          invoice_date: invoiceDate,
          grand_total: grandTotal,
          amount_paid: amountPaid,
          amount_outstanding: amountOutstanding,
          payment_status: paymentStatus as 'UNPAID' | 'PARTIAL' | 'PAID',
        }

        const existing = partyMap.get(ir.party_id)
        if (existing) {
          existing.invoice_count += 1
          existing.invoices.push(invoiceEntry)
          if (invoiceDate < existing.oldest_invoice_date) existing.oldest_invoice_date = invoiceDate
        } else {
          // Party has invoice_requests but no negative wallet balance — still show them
          const p = partiesById.get(ir.party_id)
          if (!p) continue
          partyMap.set(ir.party_id, {
            party_id: ir.party_id,
            party_name: p.name,
            party_code: p.party_code,
            party_type: getPartyTypeName(p.party_types),
            total_outstanding: amountOutstanding,
            invoice_count: 1,
            oldest_invoice_date: invoiceDate,
            invoices: [invoiceEntry],
          })
        }
      }
    }

      // Sort by total_outstanding descending
      const result = Array.from(partyMap.values()).sort((a, b) => b.total_outstanding - a.total_outstanding)

      return NextResponse.json({ success: true, data: result })
  } catch (err) {
    console.error('[outstanding] Error:', err)
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed to fetch outstanding' },
      { status: 500 }
    )
  }
}
