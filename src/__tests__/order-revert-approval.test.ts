import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

type OrderRow = Record<string, unknown>

const h = vi.hoisted(() => {
  const state: {
    order: OrderRow
    updated: OrderRow | null
    updatePayloads: OrderRow[]
    updateChains: Array<Array<[string, unknown[]]>>
  } = {
    order: {},
    updated: null,
    updatePayloads: [],
    updateChains: [],
  }

  function makeBuilder() {
    const chain: Array<[string, unknown[]]> = []
    const proxy: unknown = new Proxy({}, {
      get(_target, property) {
        if (typeof property === 'symbol') return undefined
        if (property === 'then') return undefined
        if (property === 'maybeSingle') {
          return () => {
            const update = chain.find(([method]) => method === 'update')
            if (update) {
              state.updatePayloads.push(update[1][0] as OrderRow)
              state.updateChains.push([...chain])
              return Promise.resolve({ data: state.updated, error: null })
            }
            return Promise.resolve({ data: state.order, error: null })
          }
        }
        return (...args: unknown[]) => {
          chain.push([property as string, args])
          return proxy
        }
      },
    })
    return proxy
  }

  return {
    state,
    supabaseAdmin: { from: vi.fn(() => makeBuilder()) },
    getUserFromToken: vi.fn(),
    resolveCompanyScope: vi.fn(),
    getPartyDescendants: vi.fn(),
    resetApprovalsForOrder: vi.fn(),
  }
})

vi.mock('@/lib/supabase-server', () => ({
  supabaseAdmin: h.supabaseAdmin,
  getUserFromToken: h.getUserFromToken,
  resolveCompanyScope: h.resolveCompanyScope,
  getPartyDescendants: h.getPartyDescendants,
}))

vi.mock('@/lib/order-approval-links', () => ({
  resetApprovalsForOrder: h.resetApprovalsForOrder,
}))

import { POST } from '@/app/api/v1/orders/[id]/revert-approval/route'

const approvedOrder = {
  id: 'order-1',
  order_number: 'ORD-1',
  company_id: 'company-1',
  buyer_id: 'party-1',
  status: 'APPROVED',
  approved_by: 'admin-1',
  approval_time: '2026-07-10T00:00:00.000Z',
}

function request() {
  return new NextRequest('http://localhost/api/v1/orders/order-1/revert-approval', {
    method: 'POST',
  })
}

describe('POST /api/v1/orders/[id]/revert-approval', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.state.order = { ...approvedOrder }
    h.state.updated = {
      ...approvedOrder,
      status: 'PENDING',
      approved_by: null,
      approval_time: null,
    }
    h.state.updatePayloads = []
    h.state.updateChains = []
    h.getUserFromToken.mockResolvedValue({ id: 'admin-1', role: 'ADMIN', party_id: 'company-1' })
    h.resolveCompanyScope.mockResolvedValue('company-1')
    h.getPartyDescendants.mockResolvedValue([])
    h.resetApprovalsForOrder.mockResolvedValue(undefined)
  })

  it('moves an approved order back to Pending and resets its approval cycle', async () => {
    const response = await POST(request(), { params: Promise.resolve({ id: 'order-1' }) })
    const json = await response.json()

    expect(response.status).toBe(200)
    expect(json.success).toBe(true)
    expect(json.data.status).toBe('PENDING')
    expect(h.state.updatePayloads).toEqual([{
      status: 'PENDING',
      approved_by: null,
      approval_time: null,
    }])
    expect(h.state.updateChains[0]).toContainEqual(['eq', ['status', 'APPROVED']])
    expect(h.resetApprovalsForOrder).toHaveBeenCalledWith('order-1', 'ORDER')
  })

  it('does not revert an order after fulfilment has started', async () => {
    h.state.order = { ...approvedOrder, status: 'DISPATCHED' }

    const response = await POST(request(), { params: Promise.resolve({ id: 'order-1' }) })
    const json = await response.json()

    expect(response.status).toBe(409)
    expect(json.message).toMatch(/only an APPROVED order/i)
    expect(h.state.updatePayloads).toHaveLength(0)
    expect(h.resetApprovalsForOrder).not.toHaveBeenCalled()
  })
})
