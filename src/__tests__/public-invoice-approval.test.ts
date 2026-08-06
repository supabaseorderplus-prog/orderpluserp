import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const h = vi.hoisted(() => ({
  getApprovalByToken: vi.fn(),
  confirmApproval: vi.fn(),
  confirmInvoice: vi.fn(),
}))

vi.mock('@/lib/order-approval-links', () => ({
  getApprovalByToken: h.getApprovalByToken,
  confirmApproval: h.confirmApproval,
}))
vi.mock('@/lib/order-approval-view', () => ({ loadOrderApprovalView: vi.fn() }))
vi.mock('@/lib/public-invoice-confirmation', () => ({
  confirmInvoiceRequestFromPublicLink: h.confirmInvoice,
}))

import { GET, POST } from '@/app/api/v1/public/order-approval/[token]/route'

const baseRecord = {
  token: 'secure-token',
  order_id: 'order-1',
  order_number: 'ORD-1',
  company_id: 'company-1',
  company_name: 'HomeTech',
  party_id: 'party-1',
  party_name: 'Buyer',
  party_phone: '9999999999',
  grand_total: 1200,
  status: 'ACTIVE' as const,
  created_by: 'staff-1',
  created_at: '2026-07-05T00:00:00.000Z',
  expires_at: '2026-07-19T00:00:00.000Z',
  approved_at: null,
  approved_name: null,
}

function request() {
  return new NextRequest('http://localhost/api/v1/public/order-approval/secure-token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Buyer Name' }),
  })
}

describe('public invoice approval', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.confirmInvoice.mockResolvedValue({ id: 'invoice-request-1', invoiceNumber: 'INV/001', alreadyConfirmed: false })
  })

  it('confirms the linked invoice request only for an INVOICE-purpose token', async () => {
    const invoiceRecord = { ...baseRecord, purpose: 'INVOICE' as const, invoice_request_id: 'invoice-request-1' }
    h.getApprovalByToken.mockResolvedValue({ noteRowId: 'note-1', record: invoiceRecord, effective: 'ACTIVE' })
    h.confirmApproval.mockResolvedValue({
      ok: true,
      record: { ...invoiceRecord, status: 'APPROVED', approved_name: 'Buyer Name', approved_at: '2026-07-05T01:00:00.000Z' },
    })

    const response = await POST(request(), { params: Promise.resolve({ token: 'secure-token' }) })
    const json = await response.json()

    expect(response.status).toBe(200)
    expect(h.confirmInvoice).toHaveBeenCalledWith({
      requestId: 'invoice-request-1',
      orderId: 'order-1',
      approverName: 'Buyer Name',
    })
    expect(json.data.invoice_generated).toBe(true)
    expect(json.data.invoice_number).toBe('INV/001')
  })

  it('keeps ordinary ORDER approvals separate from invoice generation', async () => {
    const orderRecord = { ...baseRecord, purpose: 'ORDER' as const }
    h.getApprovalByToken.mockResolvedValue({ noteRowId: 'note-1', record: orderRecord, effective: 'ACTIVE' })
    h.confirmApproval.mockResolvedValue({
      ok: true,
      record: { ...orderRecord, status: 'APPROVED', approved_name: 'Buyer Name', approved_at: '2026-07-05T01:00:00.000Z' },
    })

    const response = await POST(request(), { params: Promise.resolve({ token: 'secure-token' }) })
    const json = await response.json()

    expect(response.status).toBe(200)
    expect(h.confirmInvoice).not.toHaveBeenCalled()
    expect(json.data.invoice_generated).toBe(false)
  })

  it('repairs a confirmed WhatsApp link whose invoice update was interrupted', async () => {
    const invoiceRecord = {
      ...baseRecord,
      purpose: 'INVOICE' as const,
      invoice_request_id: 'invoice-request-1',
      status: 'APPROVED' as const,
      approved_name: 'Buyer Name',
      approved_at: '2026-07-05T01:00:00.000Z',
    }
    h.getApprovalByToken.mockResolvedValue({ noteRowId: 'note-1', record: invoiceRecord, effective: 'APPROVED' })

    const response = await GET(request(), { params: Promise.resolve({ token: 'secure-token' }) })
    const json = await response.json()

    expect(response.status).toBe(200)
    expect(h.confirmInvoice).toHaveBeenCalledWith({
      requestId: 'invoice-request-1',
      orderId: 'order-1',
      approverName: 'Buyer Name',
    })
    expect(json.data.invoice_generated).toBe(true)
  })
})
