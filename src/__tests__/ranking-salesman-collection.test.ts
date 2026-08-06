/**
 * Regression test for the salesman ranking board.
 *
 * `payments.created_by` is stamped with `app_user_id || auth_id` and falls back to
 * the AUTH id whenever the app_users profile wasn't resolved at collection time.
 * The board roster, however, is keyed on `app_users.id`. The original engine
 * matched payments ONLY against the app_users id, so every auth-id-stamped
 * collection was silently dropped and the whole board showed ₹0 — even when a
 * salesman had genuinely collected.
 *
 * This locks in the dual-id reconciliation (mirroring the wallet): a salesman is
 * matched against BOTH their app_users id and their auth id, so the collection is
 * counted regardless of which identity `created_by` holds.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

interface RecordedCall {
  table: string
  method: string
  args: unknown[]
}

const h = vi.hoisted(() => {
  const state = {
    calls: [] as RecordedCall[],
    roleRow: { id: 'role-salesman' } as unknown,
    appUserRows: [] as unknown[],
    paymentRows: [] as unknown[],
    authUsers: [] as { id: string; email: string; user_metadata?: Record<string, unknown> }[],
    treeIds: [] as string[],
  }

  function dispatch(table: string, record: { method: string }[]): { data?: unknown; error?: unknown } {
    if (table === 'roles') return { data: state.roleRow, error: null }
    if (table === 'users') {
      // Simulate the "no public.users table" deployment → forces app_users fallback.
      return { data: null, error: { code: 'PGRST205' } }
    }
    if (table === 'app_users') return { data: state.appUserRows, error: null }
    if (table === 'payments') return { data: state.paymentRows, error: null }
    if (table === 'parties') return { data: [], error: null }
    if (table === 'invoices') return { data: [], error: null }
    return { data: null, error: null }
  }

  function makeBuilder(table: string): unknown {
    const record: { method: string }[] = []
    const proxy: unknown = new Proxy(
      {},
      {
        get(_t, prop) {
          if (typeof prop === 'symbol') return undefined
          if (prop === 'then') {
            return (resolve: (v: unknown) => void) => resolve(dispatch(table, record))
          }
          return (...args: unknown[]) => {
            record.push({ method: String(prop) })
            state.calls.push({ table, method: String(prop), args })
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

describe('salesman ranking board — dual-id collection matching', () => {
  beforeEach(() => {
    h.state.calls = []
    h.state.treeIds = ['company', 'app-user-1', 'app-user-2']
    h.state.appUserRows = [
      { id: 'app-user-1', name: 'Nabab Ali', email: 'nabab@example.com', party_id: 'company' },
      { id: 'app-user-2', name: 'Arif Hossain', email: 'arif@example.com', party_id: 'company' },
    ]
    h.state.authUsers = [
      { id: 'auth-1', email: 'nabab@example.com' },
      { id: 'auth-2', email: 'arif@example.com' },
      { id: 'auth-driver', email: 'driver@example.com', user_metadata: { display_role: 'DRIVER' } },
    ]
    // Nabab's collection is stamped with the AUTH id, not the app_users id.
    h.state.paymentRows = [
      { created_by: 'auth-1', amount: 30000 },
      { created_by: 'auth-1', amount: 5000 },
    ]
  })

  it('counts a collection stamped with the auth id (not just the app_users id)', async () => {
    const board = await computeRanking({
      rootId: 'company',
      isAdminView: false,
      selfBoard: 'salesman',
      selfCategory: null,
      selfId: 'app-user-1',
      requestedBoard: 'salesman',
      requestedCategory: null,
    })

    const nabab = board.entries.find((e) => e.id === 'app-user-1')
    expect(nabab?.paymentValue).toBe(35000) // 30000 + 5000 — previously dropped → 0
    expect(nabab?.rank).toBe(1)
    expect(nabab?.isSelf).toBe(true)

    const arif = board.entries.find((e) => e.id === 'app-user-2')
    expect(arif?.paymentValue).toBe(0)
  })

  it('queries payments across BOTH id spaces and excludes drivers from the roster', async () => {
    await computeRanking({
      rootId: 'company',
      isAdminView: true,
      selfBoard: 'salesman',
      selfCategory: null,
      selfId: null,
      requestedBoard: 'salesman',
      requestedCategory: null,
    })

    const paymentFilter = h.state.calls.find(
      (c) => c.table === 'payments' && c.method === 'in' && c.args[0] === 'created_by',
    )
    const matchIds = paymentFilter?.args[1] as string[]
    // Union of app_users ids and resolved auth ids.
    expect(matchIds).toEqual(
      expect.arrayContaining(['app-user-1', 'auth-1', 'app-user-2', 'auth-2']),
    )
    // The driver's auth id must never be queried.
    expect(matchIds).not.toContain('auth-driver')
  })
})
