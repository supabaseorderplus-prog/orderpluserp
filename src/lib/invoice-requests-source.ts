import { supabaseAdmin } from '@/lib/supabase-server'

/**
 * Invoice requests are stored in one of two backends depending on the
 * deployment: the dedicated `invoice_requests` table, or — when that table was
 * never created (no exec_sql RPC / unreachable direct DB) — a JSON blob inside
 * `company_notes` prefixed with the marker below. The wallet balance is derived
 * from confirmed invoice requests, so the derivation MUST read both backends or
 * confirmed invoices silently fail to deduct.
 */
export const INVOICE_REQUEST_FALLBACK_PREFIX = 'SYSTEM_INVOICE_REQUEST::'

export interface ConfirmedInvoiceRequest {
  id: string
  order_id: string
  invoice_number: string
  company_id: string | null
  confirmed_at: string | null
}

export function parseInvoiceRequestNote(note: string | null): Record<string, unknown> | null {
  if (!note || !note.startsWith(INVOICE_REQUEST_FALLBACK_PREFIX)) return null
  try {
    return JSON.parse(note.slice(INVOICE_REQUEST_FALLBACK_PREFIX.length)) as Record<string, unknown>
  } catch {
    return null
  }
}

function toConfirmed(raw: {
  id?: unknown
  order_id?: unknown
  invoice_number?: unknown
  company_id?: unknown
  confirmed_at?: unknown
}, fallbackId: string): ConfirmedInvoiceRequest {
  return {
    id: String(raw.id || fallbackId),
    order_id: String(raw.order_id || ''),
    invoice_number: String(raw.invoice_number || ''),
    company_id: raw.company_id ? String(raw.company_id) : null,
    confirmed_at: raw.confirmed_at ? String(raw.confirmed_at) : null,
  }
}

/**
 * Loads every CONFIRMED invoice request for a party from BOTH the
 * `invoice_requests` table and the `company_notes` fallback, de-duplicated by
 * invoice_number (table rows win). Tolerates either backend being absent.
 */
export async function loadConfirmedInvoiceRequests(partyId: string): Promise<ConfirmedInvoiceRequest[]> {
  if (!partyId) return []

  const byKey = new Map<string, ConfirmedInvoiceRequest>()

  // 1. Dedicated table (may not exist — error is tolerated, not thrown).
  const { data: tableRows, error: tableErr } = await supabaseAdmin
    .from('invoice_requests')
    .select('id, order_id, invoice_number, company_id, confirmed_at')
    .eq('party_id', partyId)
    .eq('status', 'CONFIRMED')

  if (!tableErr && tableRows) {
    for (const r of tableRows as Record<string, unknown>[]) {
      const confirmed = toConfirmed(r, String(r.id || ''))
      byKey.set(confirmed.invoice_number || confirmed.id, confirmed)
    }
  }

  // 2. company_notes fallback.
  const { data: noteRows } = await supabaseAdmin
    .from('company_notes')
    .select('id, note')
    .like('note', `${INVOICE_REQUEST_FALLBACK_PREFIX}%`)
    .order('created_at', { ascending: false })
    .limit(500)

  for (const row of (noteRows || []) as { id: string; note: string | null }[]) {
    const parsed = parseInvoiceRequestNote(row.note)
    if (!parsed) continue
    if (String(parsed.status || '') !== 'CONFIRMED') continue
    if (String(parsed.party_id || '') !== partyId) continue

    const confirmed = toConfirmed(parsed, row.id)
    const key = confirmed.invoice_number || confirmed.id
    if (!byKey.has(key)) byKey.set(key, confirmed) // table wins on conflict
  }

  return [...byKey.values()]
}
