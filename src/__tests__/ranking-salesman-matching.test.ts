/**
 * Covers the broadened salesman-collection matching added to the ranking engine so
 * the monthly leaderboard stays consistent with the Wallets page:
 *
 *   1. Divergent / duplicate app_users id — a payment stamped with a DIFFERENT
 *      app_users row that merely shares the salesman's email is still counted.
 *   2. Legacy NULL-created_by payments — attributed to a zero-collection salesman
 *      via their party_salesman assignments (and NOT to already-credited salesmen).
 *
 * The mock distinguishes payment queries by whether `.is()` was used (legacy path)
 * and app_users queries by whether `.in('email', …)` was used (email resolution).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

const h = vi.hoisted(() => {
  const state = {
    roleRow: { id: 'role-salesman' } as unknown,
    appUserRoster: [] as { id: string; name: string; email: string; party_id: string }[],
    appUsersByEmail: [] as { id: string; email: string }[],
    authUsers: [] as { id: string; email: string; user_metadata?: Record<string, unknown> }[],
    partySalesmanLinks: [] as { salesman_id: string; party_id: string }[],
    primaryPayments: [] as { created_by: string; amount: number }[],
    legacyPayments: [] as { party_id: string; amount: number }[],
    treeIds: [] as string[],
  }

  function dispatch(table: string, record: { method: string; args: unknown[] }[]): { data?: unknown; error?: unknown } {
    if (table === 'roles') return { data: state.roleRow, error: null }
    if (table === 'users') return { data: null, error: { code: 'PGRST205' } }
    if (table === 'app_users') {
      const usedEmailIn = record.some((r) => r.method === 'in' && r.args[0] === 'email')
      return { data: usedEmailIn ? state.appUsersByEmail : state.appUserRoster, error: null }
    }
    if (table === 'party_salesman') return { data: state.partySalesmanLinks, error: null }
    if (table === 'payments') {
      const isLegacy = record.some((r) => r.method === 'is')
      return { data: isLegacy ? state.legacyPayments : state.primaryPayments, error: null }
    }
    if (table === 'parties' || table === 'invoices') return { data: [], error: null }
    return { data: null, error: null }
  }

  function makeBuilder(table: string): unknown {
    const record: { method: string; args: unknown[] }[] = []
    const proxy: unknown = new Proxy(
      {},
      {
        get(_t, prop) {
          if (typeof prop === 'symbol') return undefined
          if (prop === 'then') {
            return (resolve: (v: unknown) => void) => resolve(dispatch(table, record))
          }
          return (...args: unknown[]) => {
            record.push({ method: String(prop), args })
            return proxy
          }
        },
      },
    )
    return proxy
  }

  const supabaseAdmin = {
    from: (t: string) => makeBuilder(t),
    auth: {
      admin: {
        listUsers: async () => ({ data: { users: state.authUsers }, error: null }),
      },
    },
  }

  const getPartyDescendants = async () => state.treeIds.map((id) => ({ id }))

  return { state, supabaseAdmin, getPartyDescendants }
})

vi.mock('@/lib/supabase-server', () => ({
  supabaseAdmin: h.supabaseAdmin,
  getPartyDescendants: h.getPartyDescendants,
}))

import { computeRanking } from '@/lib/services/ranking-engine'

const adminReq = {
  rootId: 'company',
  isAdminView: true,
  selfBoard: 'salesman' as const,
  selfCategory: null,
  selfId: null,
  requestedBoard: 'salesman' as const,
  requestedCategory: null,
}

describe('salesman ranking board — broadened collection matching', () => {
  beforeEach(() => {
    h.state.treeIds = ['company', 'app-user-1', 'app-user-2']
    h.state.appUserRoster = [
      { id: 'app-user-1', name: 'Nabab Ali', email: 'nabab@example.com', party_id: 'company' },
      { id: 'app-user-2', name: 'Arif Hossain', email: 'arif@example.com', party_id: 'company' },
    ]
    h.state.appUsersByEmail = []
    h.state.authUsers = [
      { id: 'auth-1', email: 'nabab@example.com' },
      { id: 'auth-2', email: 'arif@example.com' },
    ]
    h.state.partySalesmanLinks = []
    h.state.primaryPayments = []
    h.state.legacyPayments = []
  })

  it('counts a payment stamped with a duplicate app_users id that shares the email', async () => {
    // Nabab's collection was stamped with a DIFFERENT app_users row (dup) sharing
    // their email — not the roster id, not the auth id.
    h.state.appUsersByEmail = [
      { id: 'app-user-1', email: 'nabab@example.com' },
      { id: 'app-user-1-dup', email: 'nabab@example.com' },
      { id: 'app-user-2', email: 'arif@example.com' },
    ]
    h.state.primaryPayments = [{ created_by: 'app-user-1-dup', amount: 12000 }]

    const board = await computeRanking(adminReq)

    const nabab = board.entries.find((e) => e.id === 'app-user-1')
    expect(nabab?.paymentValue).toBe(12000)
    expect(nabab?.rank).toBe(1)
  })

  it('attributes legacy NULL-created_by payments to a zero-collection salesman only', async () => {
    // Arif already collected via created_by; Nabab has zero primary but is assigned
    // a party that has a legacy NULL-created_by payment.
    h.state.primaryPayments = [{ created_by: 'app-user-2', amount: 9000 }]
    h.state.partySalesmanLinks = [{ salesman_id: 'app-user-1', party_id: 'party-x' }]
    h.state.legacyPayments = [{ party_id: 'party-x', amount: 4000 }]

    const board = await computeRanking(adminReq)

    const nabab = board.entries.find((e) => e.id === 'app-user-1')
    const arif = board.entries.find((e) => e.id === 'app-user-2')
    expect(nabab?.paymentValue).toBe(4000) // legacy attributed
    expect(arif?.paymentValue).toBe(9000) // primary only — legacy not double-counted
    expect(arif?.rank).toBe(1)
    expect(nabab?.rank).toBe(2)
  })
})
