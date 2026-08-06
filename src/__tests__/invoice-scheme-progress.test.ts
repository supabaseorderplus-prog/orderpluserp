/**
 * Unit tests for sumConfirmedInvoiceValueForParty (src/lib/invoice-scheme-progress.ts).
 *
 * INVOICE_SCHEME progress = Σ grand_total of orders whose invoice was CONFIRMED
 * to the party within the scheme window. This must: read BOTH the invoice_requests
 * table and the company_notes fallback, de-dup by invoice_number (table wins),
 * window by confirmed_at (falling back to created_at), and value each invoice by
 * its linked order's grand_total.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

const PREFIX = 'SYSTEM_INVOICE_REQUEST::'

interface MockConfig {
  tableRows: unknown[] | null
  tableError: unknown
  noteRows: { id: string; note: string }[]
  orderRows: { id: string; grand_total: number }[]
}

const h = vi.hoisted(() => {
  const state: { config: MockConfig | null } = { config: null }

  function dispatch(table: string): { data?: unknown; error?: unknown } {
    const cfg = state.config!
    if (table === 'invoice_requests') return { data: cfg.tableRows, error: cfg.tableError }
    if (table === 'company_notes') return { data: cfg.noteRows, error: null }
    if (table === 'orders') return { data: cfg.orderRows, error: null }
    return { data: null, error: null }
  }

  function makeBuilder(table: string) {
    const proxy: unknown = new Proxy(
      {},
      {
        get(_t, prop) {
          if (typeof prop === 'symbol') return undefined
          if (prop === 'then') {
            return (resolve: (v: unknown) => void) => resolve(dispatch(table))
          }
          return () => proxy
        },
      }
    )
    return proxy
  }

  const supabaseAdmin = { from: (t: string) => makeBuilder(t) }
  return { state, supabaseAdmin }
})

vi.mock('@/lib/supabase-server', () => ({ supabaseAdmin: h.supabaseAdmin }))

import { sumConfirmedInvoiceValueForParty } from '@/lib/invoice-scheme-progress'

function note(obj: Record<string, unknown>): { id: string; note: string } {
  return { id: String(obj.id || 'note-row'), note: PREFIX + JSON.stringify(obj) }
}

const PARTY = 'cb1f05f1-da0c-4290-9592-ac08ded79003'
const START = '2026-06-01'
const END = '2026-06-30'

describe('sumConfirmedInvoiceValueForParty', () => {
  beforeEach(() => {
    h.state.config = { tableRows: null, tableError: null, noteRows: [], orderRows: [] }
  })

  it('returns 0 for a blank party id', async () => {
    expect(await sumConfirmedInvoiceValueForParty('', START, END)).toBe(0)
  })

  it('counts only invoices confirmed within the scheme window', async () => {
    h.state.config = {
      tableRows: [
        { invoice_number: 'INV/A', order_id: 'oA', confirmed_at: '2026-06-15T10:00:00Z', created_at: '2026-06-15T10:00:00Z' },
        { invoice_number: 'INV/B', order_id: 'oB', confirmed_at: '2026-07-02T10:00:00Z', created_at: '2026-07-02T10:00:00Z' },
      ],
      tableError: null,
      noteRows: [],
      orderRows: [
        { id: 'oA', grand_total: 10000 },
        { id: 'oB', grand_total: 5000 },
      ],
    }

    // INV/B is outside the window → only oA's 10000 counts
    expect(await sumConfirmedInvoiceValueForParty(PARTY, START, END)).toBe(10000)
  })

  it('merges table + fallback and de-duplicates by invoice_number (table wins)', async () => {
    h.state.config = {
      tableRows: [
        { invoice_number: 'INV/009', order_id: 'o9', confirmed_at: '2026-06-10T00:00:00Z', created_at: '2026-06-10T00:00:00Z' },
      ],
      tableError: null,
      noteRows: [
        // duplicate invoice number — must be ignored in favour of the table row's order
        note({ id: 'dup', invoice_number: 'INV/009', status: 'CONFIRMED', party_id: PARTY, order_id: 'WRONG', confirmed_at: '2026-06-10T00:00:00Z' }),
        note({ id: 'n1', invoice_number: 'INV/010', status: 'CONFIRMED', party_id: PARTY, order_id: 'o10', confirmed_at: '2026-06-11T00:00:00Z' }),
      ],
      orderRows: [
        { id: 'o9', grand_total: 7000 },
        { id: 'o10', grand_total: 3000 },
        { id: 'WRONG', grand_total: 99999 },
      ],
    }

    // o9 (table) + o10 (note); WRONG never counted because table wins on INV/009
    expect(await sumConfirmedInvoiceValueForParty(PARTY, START, END)).toBe(10000)
  })

  it('falls back to created_at when confirmed_at is absent', async () => {
    h.state.config = {
      tableRows: null,
      tableError: { message: "Could not find the table 'public.invoice_requests'" },
      noteRows: [
        note({ id: 'a', invoice_number: 'INV/100', status: 'CONFIRMED', party_id: PARTY, order_id: 'o100', created_at: '2026-06-20T00:00:00Z' }),
      ],
      orderRows: [{ id: 'o100', grand_total: 4200 }],
    }

    expect(await sumConfirmedInvoiceValueForParty(PARTY, START, END)).toBe(4200)
  })

  it('excludes PENDING requests and other parties in the fallback', async () => {
    h.state.config = {
      tableRows: null,
      tableError: { message: 'missing table' },
      noteRows: [
        note({ id: 'ok', invoice_number: 'INV/1', status: 'CONFIRMED', party_id: PARTY, order_id: 'o1', confirmed_at: '2026-06-05T00:00:00Z' }),
        note({ id: 'pending', invoice_number: 'INV/2', status: 'PENDING', party_id: PARTY, order_id: 'o2', confirmed_at: '2026-06-05T00:00:00Z' }),
        note({ id: 'other', invoice_number: 'INV/3', status: 'CONFIRMED', party_id: 'someone-else', order_id: 'o3', confirmed_at: '2026-06-05T00:00:00Z' }),
      ],
      orderRows: [
        { id: 'o1', grand_total: 1500 },
        { id: 'o2', grand_total: 9000 },
        { id: 'o3', grand_total: 9000 },
      ],
    }

    // only the CONFIRMED row for PARTY counts
    expect(await sumConfirmedInvoiceValueForParty(PARTY, START, END)).toBe(1500)
  })

  it('returns 0 when there are no confirmed invoices in range', async () => {
    h.state.config = {
      tableRows: [],
      tableError: null,
      noteRows: [],
      orderRows: [],
    }
    expect(await sumConfirmedInvoiceValueForParty(PARTY, START, END)).toBe(0)
  })
})
