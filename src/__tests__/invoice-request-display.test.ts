import { describe, expect, it } from 'vitest'
import { hideSupersededInvoiceRequests, invoiceRequestsByOrder } from '@/lib/invoice-request-display'

const request = (id: string, order_id: string, status: string, created_at: string) => ({
  id,
  order_id,
  status,
  created_at,
})

describe('invoice request display state', () => {
  it('never lets an older pending duplicate hide a confirmed invoice', () => {
    const confirmed = request('confirmed', 'order-1', 'CONFIRMED', '2026-07-05T10:00:00Z')
    const pending = request('pending', 'order-1', 'PENDING', '2026-07-04T10:00:00Z')

    expect(invoiceRequestsByOrder([confirmed, pending])['order-1']).toBe(confirmed)
    expect(hideSupersededInvoiceRequests([confirmed, pending])).toEqual([confirmed])
  })

  it('uses the newest request when statuses have equal priority', () => {
    const older = request('older', 'order-1', 'PENDING', '2026-07-04T10:00:00Z')
    const newer = request('newer', 'order-1', 'PENDING', '2026-07-05T10:00:00Z')

    expect(invoiceRequestsByOrder([newer, older])['order-1']).toBe(newer)
  })
})
