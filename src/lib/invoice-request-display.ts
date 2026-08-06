export interface InvoiceRequestStatusLike {
  id: string
  order_id: string
  status: string
  created_at?: string | null
  updated_at?: string | null
  confirmed_at?: string | null
}

const STATUS_PRIORITY: Record<string, number> = {
  CONFIRMED: 3,
  PENDING: 2,
  REJECTED: 1,
}

function eventTime(request: InvoiceRequestStatusLike): number {
  const value = request.confirmed_at || request.updated_at || request.created_at || ''
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * Select the authoritative invoice state for each order. A confirmed invoice
 * always beats a stale pending/rejected duplicate; ties use the newest event.
 */
export function invoiceRequestsByOrder<T extends InvoiceRequestStatusLike>(requests: T[]): Record<string, T> {
  const byOrder: Record<string, T> = {}
  for (const request of requests) {
    const current = byOrder[request.order_id]
    if (!current) {
      byOrder[request.order_id] = request
      continue
    }

    const requestPriority = STATUS_PRIORITY[request.status] || 0
    const currentPriority = STATUS_PRIORITY[current.status] || 0
    if (requestPriority > currentPriority || (
      requestPriority === currentPriority && eventTime(request) > eventTime(current)
    )) {
      byOrder[request.order_id] = request
    }
  }
  return byOrder
}

/** Hide obsolete pending/rejected duplicates once an order has an invoice. */
export function hideSupersededInvoiceRequests<T extends InvoiceRequestStatusLike>(requests: T[]): T[] {
  const confirmedOrders = new Set(
    requests.filter((request) => request.status === 'CONFIRMED').map((request) => request.order_id),
  )
  return requests.filter((request) => request.status === 'CONFIRMED' || !confirmedOrders.has(request.order_id))
}
