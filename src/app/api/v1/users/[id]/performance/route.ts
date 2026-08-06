import { NextRequest, NextResponse } from 'next/server'
import { getUserFromToken, resolveCompanyScope, supabaseAdmin, getPartyDescendants } from '@/lib/supabase-server'

type UserRow = {
  id: string
  party_id: string | null
}

type OrderRow = {
  grand_total?: number | string | null
  status?: string | null
  order_status?: string | null
}

const SALES_STATUS = new Set(['DELIVERED', 'DISPATCHED', 'APPROVED', 'CONFIRMED', 'CONFIRM'])

const isMissingUsersTable = (err: { code?: string; message?: string } | null | undefined) =>
  !!err && (
    err.code === 'PGRST205' ||
    err.code === '42P01' ||
    (err.message || '').includes("Could not find the table 'public.users'")
  )

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

async function resolveUsersTable(): Promise<'users' | 'app_users'> {
  const probe = await supabaseAdmin.from('users').select('id').limit(0)
  return isMissingUsersTable(probe.error) ? 'app_users' : 'users'
}

async function getCompanyPartyIds(companyId: string | null): Promise<string[] | null> {
  if (!companyId) return null
  const tree = await getPartyDescendants(companyId)
  const ids = tree && tree.length > 0 ? tree.map((r: { id: string }) => r.id) : []
  if (!ids.includes(companyId)) ids.push(companyId)
  return ids
}

function inCompanyScope(companyPartyIds: string[] | null, partyId: string | null): boolean {
  if (!companyPartyIds) return true
  if (!partyId) return false
  return companyPartyIds.includes(partyId)
}

async function fetchUserById(userId: string, table: 'users' | 'app_users'): Promise<UserRow | null> {
  const { data } = await supabaseAdmin
    .from(table as 'users')
    .select('id, party_id')
    .eq('id', userId)
    .maybeSingle()

  if (!data) return null
  return {
    id: data.id,
    party_id: data.party_id || null,
  }
}

async function fetchOrdersForParties(partyIds: string[], startOfMonthIso: string): Promise<OrderRow[]> {
  if (partyIds.length === 0) return []

  const run = async (column: 'buyer_id' | 'billing_party_id' | 'seller_id') => {
    let query = supabaseAdmin
      .from('orders')
      .select('grand_total, status, order_status')
      .gte('created_at', startOfMonthIso)

    if (column === 'seller_id') {
      query = query.in('seller_id', partyIds)
    } else {
      query = query.in(column, partyIds)
    }

    return query
  }

  let { data, error } = await run('buyer_id')
  if (error && isSchemaCompatError(error)) {
    const fallback = await run('billing_party_id')
    data = fallback.data
    error = fallback.error
  }
  if (error && isSchemaCompatError(error)) {
    const fallback = await run('seller_id')
    data = fallback.data
    error = fallback.error
  }
  if (error) {
    console.warn('[users/performance] orders query fallback failed:', error.message)
    return []
  }
  return (data || []) as OrderRow[]
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const authUser = await getUserFromToken(req)
    if (!authUser) {
      return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 })
    }

    const { id } = await params

    let companyId = await resolveCompanyScope(req, authUser)
    if (!companyId && authUser.role !== 'SUPER_ADMIN') {
      companyId = authUser.party_id || null
    }
    if (!companyId && authUser.role !== 'SUPER_ADMIN') {
      return NextResponse.json({ success: false, message: 'Company scope is required' }, { status: 403 })
    }

    const usersTable = await resolveUsersTable()
    const targetUser = await fetchUserById(id, usersTable)
    if (!targetUser) {
      return NextResponse.json({ success: false, message: 'User not found' }, { status: 404 })
    }

    const companyPartyIds = await getCompanyPartyIds(companyId)
    if (!inCompanyScope(companyPartyIds, targetUser.party_id) && targetUser.id !== authUser.id) {
      return NextResponse.json({ success: false, message: 'User not found or access denied' }, { status: 403 })
    }

    if (!targetUser.party_id) {
      return NextResponse.json({
        success: true,
        data: { mtdOrders: 0, mtdSales: 0, outstandingBalance: 0 },
      })
    }

    const userPartyIds = await getCompanyPartyIds(targetUser.party_id)
    const scopedPartyIds = (userPartyIds || []).filter((partyId) => !companyPartyIds || companyPartyIds.includes(partyId))
    if (scopedPartyIds.length === 0) {
      return NextResponse.json({
        success: true,
        data: { mtdOrders: 0, mtdSales: 0, outstandingBalance: 0 },
      })
    }

    const now = new Date()
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
    const orders = await fetchOrdersForParties(scopedPartyIds, startOfMonth)

    let mtdOrders = 0
    let mtdSales = 0
    for (const order of orders) {
      const status = String(order.status || order.order_status || '').toUpperCase()
      if (status === 'CANCELLED') continue
      mtdOrders += 1
      if (SALES_STATUS.has(status)) {
        mtdSales += Number(order.grand_total || 0)
      }
    }

    // Outstanding per party: use invoice dues, then override by negative wallet if present.
    const duesByParty = new Map<string, number>()

    const { data: invoices, error: invErr } = await supabaseAdmin
      .from('invoices')
      .select('billing_party_id, amount_outstanding, payment_status')
      .eq('status', 'ACTIVE')
      .not('is_cancelled', 'eq', true)
      .in('billing_party_id', scopedPartyIds)

    if (invErr && !isSchemaCompatError(invErr)) {
      console.warn('[users/performance] invoices query failed:', invErr.message)
    } else {
      for (const inv of invoices || []) {
        const partyId = inv.billing_party_id as string | null
        if (!partyId) continue
        const isDue = inv.payment_status === 'UNPAID' || inv.payment_status === 'PARTIAL'
        if (!isDue) continue
        const current = duesByParty.get(partyId) || 0
        duesByParty.set(partyId, current + Number(inv.amount_outstanding || 0))
      }
    }

    const { data: parties } = await supabaseAdmin
      .from('parties')
      .select('id, wallet_balance, opening_balance')
      .in('id', scopedPartyIds)

    for (const party of parties || []) {
      const effective = Number(party.wallet_balance || 0) + Number(party.opening_balance || 0)
      if (effective < 0) {
        duesByParty.set(party.id, Math.abs(effective))
      }
    }

    const outstandingBalance = Array.from(duesByParty.values()).reduce((sum, v) => sum + Number(v || 0), 0)

    return NextResponse.json({
      success: true,
      data: {
        mtdOrders,
        mtdSales,
        outstandingBalance,
      },
    })
  } catch (err) {
    console.error('[users/performance] error:', err)
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed to fetch performance' },
      { status: 500 }
    )
  }
}
