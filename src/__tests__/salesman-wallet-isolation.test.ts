/**
 * Regression tests for per-collector wallet/scheme isolation.
 *
 * Salesmen frequently SHARE (or lack) a company party_id, so company/party scope
 * cannot tell two collectors apart. The only reliable per-collector identity is
 * `created_by`. These tests lock in that recalcSalesmanSchemesFromPayments:
 *   1. sums a salesman's collections strictly by created_by (NEVER by company_id),
 *      so one salesman's money never inflates another's scheme bar; and
 *   2. stores that progress under the collector's OWN unique user id (not the
 *      shared party_id), so two salesmen on the same party never overwrite each
 *      other.
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
    partyRow: null as unknown,
    schemeRows: [] as unknown[],
    paymentRows: [] as unknown[],
  }

  function dispatch(table: string, record: { method: string }[]): { data?: unknown; error?: unknown } {
    if (table === 'parties') return { data: state.partyRow, error: null }
    if (table === 'scheme_parties') return { data: [], error: null }
    if (table === 'schemes') return { data: state.schemeRows, error: null }
    if (table === 'payments') return { data: state.paymentRows, error: null }
    if (table === 'scheme_progress') {
      // An insert in the chain → return success; otherwise it's the "existing?" lookup.
      if (record.some((c) => c.method === 'insert')) return { error: null }
      return { data: null, error: null }
    }
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

  const supabaseAdmin = { from: (t: string) => makeBuilder(t) }
  return { state, supabaseAdmin }
})

vi.mock('@/lib/supabase-server', () => ({ supabaseAdmin: h.supabaseAdmin }))

import { recalcSalesmanSchemesFromPayments } from '@/lib/scheme-progress'

const SALESMAN = {
  id: 'auth-1',
  app_user_id: 'app-user-1',
  party_id: 'shared-company-party',
  role: 'SALESMAN',
  name: 'Nabab Ali',
  email: 'nabab@example.com',
}

describe('recalcSalesmanSchemesFromPayments — per-collector isolation', () => {
  beforeEach(() => {
    h.state.calls = []
    h.state.partyRow = {
      id: 'shared-company-party',
      name: 'Nabab Ali',
      parent_party_id: null,
      party_types: { name: 'SALESMAN' },
    }
    h.state.schemeRows = [
      {
        id: 'scheme-1',
        start_date: '2020-01-01',
        end_date: '2099-01-01',
        target_value: 50000,
        scheme_type: 'PAYMENT',
        applicable_party_type: 'ALL',
        terms_conditions: null,
      },
    ]
    h.state.paymentRows = [{ amount: 5000 }, { amount: 5000 }]
  })

  it('sums collections by created_by, never by company_id', async () => {
    await recalcSalesmanSchemesFromPayments(SALESMAN, null)

    const paymentCalls = h.state.calls.filter((c) => c.table === 'payments')

    // Must scope payments to THIS collector's ids…
    const createdByFilter = paymentCalls.find(
      (c) => c.method === 'in' && c.args[0] === 'created_by',
    )
    expect(createdByFilter).toBeDefined()
    expect(createdByFilter?.args[1]).toEqual(['app-user-1', 'auth-1'])

    // …and must NEVER fall back to a shared company/party scope.
    const companyFilter = paymentCalls.find(
      (c) => c.method === 'eq' && c.args[0] === 'company_id',
    )
    expect(companyFilter).toBeUndefined()
  })

  it('stores progress under the collector user id, not the shared party_id', async () => {
    await recalcSalesmanSchemesFromPayments(SALESMAN, null)

    const insert = h.state.calls.find(
      (c) => c.table === 'scheme_progress' && c.method === 'insert',
    )
    expect(insert).toBeDefined()
    const row = insert?.args[0] as Record<string, unknown>
    expect(row.party_id).toBe('app-user-1') // collector identity, NOT 'shared-company-party'
    expect(row.scheme_id).toBe('scheme-1')
    expect(row.current_value).toBe(10000)
  })

  it('fails closed when the collector cannot be identified', async () => {
    const result = await recalcSalesmanSchemesFromPayments(
      { ...SALESMAN, id: null, app_user_id: null },
      null,
    )
    expect(result).toEqual({ updated: 0, schemes: [] })
    expect(h.state.calls.filter((c) => c.table === 'payments')).toHaveLength(0)
  })
})
