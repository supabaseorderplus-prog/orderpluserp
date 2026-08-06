import { supabaseAdmin } from '@/lib/supabase-server'
import {
  INVOICE_REQUEST_FALLBACK_PREFIX,
  parseInvoiceRequestNote,
} from '@/lib/invoice-requests-source'

/**
 * The scheme_type value that flips a scheme from "measure by payments collected"
 * to "measure by value of invoices issued TO the party". INVOICE schemes are
 * aimed at parties (typically CNF) — when an invoice request the party received
 * is CONFIRMED, the linked order's grand_total counts toward the target.
 */
export const INVOICE_SCHEME_TYPE = 'INVOICE_SCHEME'

type ConfirmedInvoiceForScheme = {
  invoice_number: string
  order_id: string
  // confirmed_at, falling back to created_at — used to window against the scheme period.
  date: string | null
}

/**
 * Loads every CONFIRMED invoice request *issued to* `partyId` from BOTH the
 * `invoice_requests` table and the `company_notes` fallback, carrying the
 * order_id and the effective date. De-duplicated by invoice_number (table wins),
 * mirroring loadConfirmedInvoiceRequests / computeCurrentBalances so the two
 * backends never double-count.
 */
async function loadConfirmedInvoicesWithDates(partyId: string): Promise<ConfirmedInvoiceForScheme[]> {
  const byKey = new Map<string, ConfirmedInvoiceForScheme>()

  // 1. Dedicated table (tolerated if absent — error is ignored, not thrown).
  const { data: tableRows, error: tableErr } = await supabaseAdmin
    .from('invoice_requests')
    .select('invoice_number, order_id, confirmed_at, created_at')
    .eq('party_id', partyId)
    .eq('status', 'CONFIRMED')

  if (!tableErr && tableRows) {
    for (const r of tableRows as Record<string, unknown>[]) {
      const invoice_number = String(r.invoice_number || '')
      const order_id = String(r.order_id || '')
      const date = r.confirmed_at
        ? String(r.confirmed_at)
        : r.created_at
          ? String(r.created_at)
          : null
      const key = invoice_number || order_id
      if (!key) continue
      byKey.set(key, { invoice_number, order_id, date })
    }
  }

  // 2. company_notes fallback (single scan).
  const { data: noteRows } = await supabaseAdmin
    .from('company_notes')
    .select('note')
    .like('note', `${INVOICE_REQUEST_FALLBACK_PREFIX}%`)
    .limit(2000)

  for (const row of (noteRows || []) as { note: string | null }[]) {
    const parsed = parseInvoiceRequestNote(row.note)
    if (!parsed) continue
    if (String(parsed.status || '') !== 'CONFIRMED') continue
    if (String(parsed.party_id || '') !== partyId) continue

    const invoice_number = String(parsed.invoice_number || '')
    const order_id = String(parsed.order_id || '')
    const date = parsed.confirmed_at
      ? String(parsed.confirmed_at)
      : parsed.created_at
        ? String(parsed.created_at)
        : null
    const key = invoice_number || order_id
    if (!key) continue
    if (!byKey.has(key)) byKey.set(key, { invoice_number, order_id, date }) // table wins
  }

  return [...byKey.values()]
}

/**
 * Sums the ₹-value of invoices issued to `partyId` and CONFIRMED within the
 * [startDate, endDate] window (inclusive, date-only). The value of an invoice is
 * its linked `orders.grand_total` — the same derivation computeCurrentBalances
 * uses for wallet debits. Fail-soft: returns 0 for the common empty cases and
 * never throws.
 */
export async function sumConfirmedInvoiceValueForParty(
  partyId: string,
  startDate: string,
  endDate: string,
): Promise<number> {
  if (!partyId) return 0

  const rows = await loadConfirmedInvoicesWithDates(partyId)

  const inWindow = rows.filter((r) => {
    if (!r.date) return false
    const day = r.date.split('T')[0]
    return day >= startDate && day <= endDate
  })

  const orderIds = [...new Set(inWindow.map((r) => r.order_id).filter(Boolean))]
  if (orderIds.length === 0) return 0

  const { data: orders } = await supabaseAdmin
    .from('orders')
    .select('id, grand_total')
    .in('id', orderIds)

  const orderTotals: Record<string, number> = {}
  for (const o of (orders || []) as { id: string; grand_total: number | string }[]) {
    orderTotals[String(o.id)] = Number(o.grand_total || 0)
  }

  return inWindow.reduce((sum, r) => sum + (orderTotals[r.order_id] || 0), 0)
}