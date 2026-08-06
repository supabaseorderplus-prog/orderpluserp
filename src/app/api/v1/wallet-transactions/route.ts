import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, getUserFromToken, resolveCompanyScope } from '@/lib/supabase-server'
import { queryDirectSql } from '@/lib/direct-sql'
import { getScopedPartyIdsForUser } from '@/lib/party-scope'
import { parseWalletAdjustNote, WALLET_ADJUST_NOTE_PREFIX } from '@/lib/wallet-adjust-fallback'

function getErrorMessage(err: unknown) {
  if (err instanceof Error) return err.message
  if (err && typeof err === 'object' && 'message' in err) return String((err as { message?: unknown }).message || '')
  return ''
}

function isWalletTransactionsUnavailable(err: unknown) {
  const message = getErrorMessage(err).toLowerCase()
  return (
    message.includes('fetch failed') ||
    message.includes('enotfound') ||
    message.includes('wallet_transactions') ||
    message.includes('schema cache') ||
    message.includes('does not exist')
  )
}

function sqlLiteral(value: string) {
  return `'${value.replace(/'/g, "''")}'`
}

function buildWalletTransactionsSql(args: {
  partyId?: string
  type?: string
  limit: number
  offset: number
  scopedPartyIds: string[] | null
}) {
  const where: string[] = []
  if (args.scopedPartyIds !== null) {
    if (args.scopedPartyIds.length === 0) return null
    where.push(`wt.party_id IN (${args.scopedPartyIds.map(sqlLiteral).join(', ')})`)
  }
  if (args.partyId) where.push(`wt.party_id = ${sqlLiteral(args.partyId)}`)
  if (args.type) where.push(`wt.type = ${sqlLiteral(args.type)}`)

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
  return `
    SELECT
      wt.id,
      wt.party_id,
      wt.type,
      wt.amount,
      wt.balance_after,
      wt.reference_id,
      wt.reference_type,
      wt.description,
      wt.created_by,
      wt.company_id,
      wt.created_at,
      p.id AS party_ref_id,
      p.name AS party_name,
      p.party_code AS party_code
    FROM public.wallet_transactions wt
    LEFT JOIN public.parties p ON p.id = wt.party_id
    ${whereSql}
    ORDER BY wt.created_at DESC
    LIMIT ${args.limit}
    OFFSET ${args.offset}
  `
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const page = parseInt(url.searchParams.get('page') || '1')
  const limit = parseInt(url.searchParams.get('limit') || '50')
  const partyId = url.searchParams.get('party_id') || ''
  const transactionType = url.searchParams.get('type') || ''

  try {
    const offset = (page - 1) * limit

    const authUser = await getUserFromToken(req)
    if (!authUser) {
      return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 })
    }
    const companyId = await resolveCompanyScope(req, authUser)

    const scopedPartyIds = await getScopedPartyIdsForUser(authUser, companyId)
    if (scopedPartyIds !== null && scopedPartyIds.length === 0) {
      return NextResponse.json({
        success: true,
        data: [],
        pagination: { page, limit, total: 0, pages: 0 },
      })
    }

    let query = supabaseAdmin
      .from('wallet_transactions')
      .select('*, parties:party_id(id, name, party_code)', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1)

    if (scopedPartyIds !== null) query = query.in('party_id', scopedPartyIds)
    if (partyId) query = query.eq('party_id', partyId)
    if (transactionType) query = query.eq('type', transactionType)

    const { data, error, count } = await query
    if (error) throw error

    return NextResponse.json({
      success: true,
      data: data || [],
      pagination: {
        page,
        limit,
        total: count || 0,
        pages: Math.ceil((count || 0) / limit),
      },
    })
  } catch (err) {
    if (isWalletTransactionsUnavailable(err)) {
      const authUser = await getUserFromToken(req)
      if (!authUser) {
        return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 })
      }
      const companyId = await resolveCompanyScope(req, authUser)
      const scopedPartyIds = await getScopedPartyIdsForUser(authUser, companyId)
      if (scopedPartyIds !== null && scopedPartyIds.length === 0) {
        return NextResponse.json({
          success: true,
          data: [],
          pagination: { page, limit, total: 0, pages: 0 },
        })
      }

      const sql = buildWalletTransactionsSql({
        partyId: partyId || undefined,
        type: transactionType || undefined,
        limit,
        offset: (page - 1) * limit,
        scopedPartyIds,
      })

      if (sql) {
        const rows = await queryDirectSql<Record<string, unknown>>(sql)
        if (rows) {
          const normalized = rows.map((row) => ({
            id: row.id,
            party_id: row.party_id,
            type: row.type,
            amount: Number(row.amount || 0),
            balance_after: row.balance_after == null ? null : Number(row.balance_after),
            reference_id: row.reference_id,
            reference_type: row.reference_type,
            description: row.description,
            created_by: row.created_by,
            company_id: row.company_id,
            created_at: row.created_at,
            parties: row.party_ref_id ? {
              id: row.party_ref_id,
              name: row.party_name,
              party_code: row.party_code,
            } : null,
          }))
          return NextResponse.json({
            success: true,
            data: normalized,
            pagination: {
              page,
              limit,
              total: normalized.length,
              pages: normalized.length < limit ? page : page + 1,
            },
          })
        }
      }

      let fallbackQuery = supabaseAdmin
        .from('payments')
        .select('id, party_id, payment_number, amount, payment_date, created_at, parties:party_id(id, name, party_code)', { count: 'exact' })
        .order('created_at', { ascending: false })
        .range((page - 1) * limit, page * limit - 1)

      if (scopedPartyIds !== null) fallbackQuery = fallbackQuery.in('party_id', scopedPartyIds)
      if (partyId) fallbackQuery = fallbackQuery.eq('party_id', partyId)
      const { data: paymentRows, count } = await fallbackQuery
      const derivedRows = (paymentRows || []).map((payment) => ({
        id: payment.id,
        party_id: payment.party_id,
        type: 'PAYMENT_CREDIT',
        amount: Number(payment.amount || 0),
        created_at: payment.created_at || payment.payment_date,
        description: `Payment ${payment.payment_number || payment.id} received`,
        reference_id: payment.payment_number || payment.id,
        reference_type: 'PAYMENT',
        parties: payment.parties,
      }))

      const { data: noteRows } = await supabaseAdmin
        .from('company_notes')
        .select('id, company_id, created_at, created_by, note')
        .like('note', `${WALLET_ADJUST_NOTE_PREFIX}%`)
        .limit(5000)

      const noteDerived = (noteRows || [])
        .map((row) => {
          const parsed = parseWalletAdjustNote(row.note)
          if (!parsed) return null
          if (partyId && parsed.party_id !== partyId) return null
          if (transactionType && parsed.type !== transactionType) return null
          if (scopedPartyIds !== null && !scopedPartyIds.includes(parsed.party_id)) return null
          return {
            id: row.id,
            party_id: parsed.party_id,
            type: parsed.type,
            amount: Number(parsed.delta || 0),
            balance_after: parsed.balance_after ?? null,
            reference_id: null,
            reference_type: parsed.reference_type,
            description: parsed.description,
            created_by: parsed.created_by ?? row.created_by,
            company_id: parsed.company_id ?? row.company_id,
            created_at: parsed.created_at || row.created_at,
            parties: null,
          }
        })
        .filter((row) => row !== null)

      const merged = [...derivedRows, ...noteDerived].sort((a, b) =>
        new Date(String(b.created_at || 0)).getTime() - new Date(String(a.created_at || 0)).getTime()
      )
      const paged = merged.slice((page - 1) * limit, page * limit)

      return NextResponse.json({
        success: true,
        data: paged,
        pagination: {
          page,
          limit,
          total: merged.length || count || 0,
          pages: Math.ceil((merged.length || count || 0) / limit),
        },
      })
    }

    return NextResponse.json(
      { success: false, message: getErrorMessage(err) || 'Failed to fetch transactions' },
      { status: 500 }
    )
  }
}
