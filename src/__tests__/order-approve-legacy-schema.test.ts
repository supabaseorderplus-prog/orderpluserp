import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

type Row = Record<string, unknown>

const h = vi.hoisted(() => {
  const state: {
    order: Row
    updatePayloads: Row[]
  } = {
    order: {},
    updatePayloads: [],
  }

  function builder() {
    let updatePayload: Row | null = null
    const proxy: unknown = new Proxy({}, {
      get(_target, property) {
        if (typeof property === 'symbol' || property === 'then') return undefined
        if (property === 'update') {
          return (payload: Row) => {
            updatePayload = { ...payload }
            return proxy
          }
        }
        if (property === 'maybeSingle') {
          return () => {
            if (!updatePayload) return Promise.resolve({ data: state.order, error: null })
            state.updatePayloads.push(updatePayload)
            if ('approved_by' in updatePayload) {
              return Promise.resolve({
                data: null,
                error: { code: '42703', message: 'column "approved_by" of relation "orders" does not exist' },
              })
            }
            if ('approval_time' in updatePayload) {
              return Promise.resolve({
                data: null,
                error: { code: '42703', message: 'column "approval_time" of relation "orders" does not exist' },
              })
            }
            return Promise.resolve({ data: { ...state.order, ...updatePayload }, error: null })
          }
        }
        return () => proxy
      },
    })
    return proxy
  }

  return {
    state,
    supabaseAdmin: { from: vi.fn(() => builder()) },
    getUserFromToken: vi.fn(),
    resolveCompanyScope: vi.fn(),
    getPartyDescendants: vi.fn(),
  }
})

vi.mock('@/lib/supabase-server', () => ({
  supabaseAdmin: h.supabaseAdmin,
  getUserFromToken: h.getUserFromToken,
  resolveCompanyScope: h.resolveCompanyScope,
  getPartyDescendants: h.getPartyDescendants,
}))

import { POST } from '@/app/api/v1/orders/[id]/approve/route'

describe('POST /api/v1/orders/[id]/approve legacy schema', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.state.updatePayloads = []
    h.state.order = {
      id: 'order-legacy',
      order_number: 'ORD/WB/264',
      billing_party_id: 'party-1',
      status: 'PENDING',
      order_status: 'DRAFT',
    }
    h.getUserFromToken.mockResolvedValue({ id: 'admin-1', app_user_id: 'admin-1', role: 'ADMIN', party_id: 'company-1' })
    h.resolveCompanyScope.mockResolvedValue('company-1')
    h.getPartyDescendants.mockResolvedValue([{ id: 'party-1' }])
  })

  it('approves an order when optional scope and audit columns are absent', async () => {
    const request = new NextRequest('http://localhost/api/v1/orders/order-legacy/approve', { method: 'POST' })
    const response = await POST(request, { params: Promise.resolve({ id: 'order-legacy' }) })
    const json = await response.json()

    expect(response.status).toBe(200)
    expect(json.success).toBe(true)
    expect(json.data.status).toBe('APPROVED')
    expect(json.data.order_status).toBe('APPROVED')
    expect(h.state.updatePayloads).toHaveLength(3)
    expect(h.state.updatePayloads[2]).toEqual({ status: 'APPROVED', order_status: 'APPROVED' })
  })
})
