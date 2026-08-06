/**
 * Route-level integration tests for PUT /api/v1/invoice-requests/[id].
 *
 * On this deployment the wallet has no persisted ledger — the balance is
 * DERIVED from confirmed invoice requests when the statement is read (see
 * loadConfirmedInvoiceRequests + the transactions endpoint). So confirming an
 * invoice request must:
 *   - CONFIRMED → flip status to CONFIRMED and walk the order to DELIVERED
 *   - REJECTED  → record the rejection, leave the order alone
 *   - guards    → reject invalid status and non-PENDING requests
 *
 * The wallet deduction itself is covered by invoice-requests-source.test.ts.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

type DispatchResult = { data?: unknown; error?: unknown }

interface RouteMockConfig {
  existingRequest: DispatchResult
  updatedRequest: DispatchResult
  orderStatus: DispatchResult
  requestUpdates: Record<string, unknown>[]
  orderUpdates: Record<string, unknown>[]
}

const h = vi.hoisted(() => {
  const state: { config: RouteMockConfig | null } = { config: null }

  function dispatch(table: string, chain: [string, unknown[]][]): DispatchResult {
    const cfg = state.config!
    const has = (m: string) => chain.some((c) => c[0] === m)

    if (table === 'invoice_requests') {
      if (has('update')) {
        const payload = chain.find((c) => c[0] === 'update')![1][0] as Record<string, unknown>
        cfg.requestUpdates.push(payload)
        return cfg.updatedRequest
      }
      return cfg.existingRequest
    }

    if (table === 'orders') {
      if (has('update')) {
        const payload = chain.find((c) => c[0] === 'update')![1][0] as Record<string, unknown>
        cfg.orderUpdates.push(payload)
        return { error: null }
      }
      return cfg.orderStatus
    }

    return { data: null, error: null }
  }

  function makeBuilder(table: string) {
    const chain: [string, unknown[]][] = []
    const proxy: unknown = new Proxy(
      {},
      {
        get(_t, prop) {
          if (typeof prop === 'symbol') return undefined
          if (prop === 'then') {
            return (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
              try {
                resolve(dispatch(table, chain))
              } catch (e) {
                reject(e)
              }
            }
          }
          if (prop === 'single' || prop === 'maybeSingle') {
            return (...args: unknown[]) => {
              chain.push([prop, args])
              return Promise.resolve(dispatch(table, chain))
            }
          }
          return (...args: unknown[]) => {
            chain.push([prop as string, args])
            return proxy
          }
        },
      }
    )
    return proxy
  }

  const supabaseAdmin = { from: (t: string) => makeBuilder(t) }
  const getUserFromToken = vi.fn(async () => ({ app_user_id: 'u1', id: 'u1' }))

  return { state, supabaseAdmin, getUserFromToken }
})

vi.mock('@/lib/supabase-server', () => ({
  supabaseAdmin: h.supabaseAdmin,
  getUserFromToken: h.getUserFromToken,
}))

// One confirmation, whichever channel: confirming/rejecting in-app must kill the
// outstanding WhatsApp approval link for the order so it can't be reused.
const links = vi.hoisted(() => ({ revokeTokensForOrder: vi.fn(async () => {}) }))
vi.mock('@/lib/order-approval-links', () => ({ revokeTokensForOrder: links.revokeTokensForOrder }))

import { PUT } from '@/app/api/v1/invoice-requests/[id]/route'

function makeConfig(over: Partial<RouteMockConfig> = {}): RouteMockConfig {
  return {
    existingRequest: {
      data: {
        id: 'ir1',
        status: 'PENDING',
        order_id: 'o1',
        party_id: 'p1',
        invoice_number: 'INV-1',
        company_id: 'c1',
      },
      error: null,
    },
    updatedRequest: { data: { id: 'ir1', status: 'CONFIRMED' }, error: null },
    orderStatus: { data: { status: 'APPROVED' }, error: null },
    requestUpdates: [],
    orderUpdates: [],
    ...over,
  }
}

function callPut(body: Record<string, unknown>) {
  const req = { json: async () => body } as unknown as Parameters<typeof PUT>[0]
  return PUT(req, { params: Promise.resolve({ id: 'ir1' }) })
}

describe('PUT /api/v1/invoice-requests/[id]', () => {
  beforeEach(() => {
    h.state.config = makeConfig()
    h.getUserFromToken.mockClear()
    links.revokeTokensForOrder.mockClear()
  })

  it('CONFIRMED flips status and walks the order to DELIVERED', async () => {
    const res = await callPut({ status: 'CONFIRMED' })
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.success).toBe(true)
    expect(json.message).toMatch(/Delivery confirmed/i)

    // request flipped to CONFIRMED with a confirmation timestamp
    expect(h.state.config!.requestUpdates[0]).toMatchObject({ status: 'CONFIRMED' })
    expect(h.state.config!.requestUpdates[0].confirmed_at).toBeTruthy()

    // APPROVED order is walked DISPATCHED → DELIVERED
    expect(h.state.config!.orderUpdates).toEqual([{ status: 'DISPATCHED' }, { status: 'DELIVERED' }])

    // In-app confirmation terminates the outstanding WhatsApp link for this order.
    expect(links.revokeTokensForOrder).toHaveBeenCalledWith('o1', 'c1', 'INVOICE')
  })

  it('CONFIRMED on an order already DELIVERED issues no order update', async () => {
    h.state.config = makeConfig({ orderStatus: { data: { status: 'DELIVERED' }, error: null } })

    const res = await callPut({ status: 'CONFIRMED' })
    expect(res.status).toBe(200)
    expect(h.state.config!.orderUpdates).toHaveLength(0)
  })

  it('CONFIRMED on a PROCUREMENT order also delivers it (heals stuck orders)', async () => {
    h.state.config = makeConfig({ orderStatus: { data: { status: 'PROCUREMENT' }, error: null } })

    await callPut({ status: 'CONFIRMED' })
    expect(h.state.config!.orderUpdates).toEqual([{ status: 'DISPATCHED' }, { status: 'DELIVERED' }])
  })

  it('REJECTED records the rejection without delivering the order', async () => {
    h.state.config = makeConfig({ updatedRequest: { data: { id: 'ir1', status: 'REJECTED' }, error: null } })

    const res = await callPut({ status: 'REJECTED' })
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.success).toBe(true)
    expect(h.state.config!.orderUpdates).toHaveLength(0)
    expect(h.state.config!.requestUpdates[0]).toMatchObject({ status: 'REJECTED' })

    // Rejecting in-app also kills the link — a stale link must not re-confirm it.
    expect(links.revokeTokensForOrder).toHaveBeenCalledWith('o1', 'c1', 'INVOICE')
  })

  it('rejects an invalid status with 400 and no side effects', async () => {
    const res = await callPut({ status: 'MAYBE' })
    const json = await res.json()

    expect(res.status).toBe(400)
    expect(json.success).toBe(false)
    expect(h.state.config!.requestUpdates).toHaveLength(0)
    expect(h.state.config!.orderUpdates).toHaveLength(0)
    // A rejected request never happened → the link stays untouched.
    expect(links.revokeTokensForOrder).not.toHaveBeenCalled()
  })

  it('blocks confirming a request that is no longer PENDING', async () => {
    h.state.config = makeConfig({
      existingRequest: {
        data: { id: 'ir1', status: 'CONFIRMED', order_id: 'o1', party_id: 'p1', invoice_number: 'INV-1', company_id: 'c1' },
        error: null,
      },
    })

    const res = await callPut({ status: 'CONFIRMED' })
    const json = await res.json()

    expect(res.status).toBe(400)
    expect(json.message).toMatch(/already confirmed/i)
    expect(h.state.config!.orderUpdates).toHaveLength(0)
  })
})
