/**
 * Unit tests for loadConfirmedInvoiceRequests (src/lib/invoice-requests-source.ts).
 *
 * The wallet balance is derived from confirmed invoice requests. This deployment
 * stores them in the company_notes fallback (the invoice_requests table doesn't
 * exist), so the loader MUST read the fallback or confirmed invoices never
 * deduct — the exact production bug this fixes.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

const PREFIX = 'SYSTEM_INVOICE_REQUEST::'

interface SourceMockConfig {
  // invoice_requests table response
  tableRows: unknown[] | null
  tableError: unknown
  // company_notes rows (note already JSON-encoded with the prefix)
  noteRows: { id: string; note: string }[]
}

const h = vi.hoisted(() => {
  const state: { config: SourceMockConfig | null } = { config: null }

  function dispatch(table: string): { data?: unknown; error?: unknown } {
    const cfg = state.config!
    if (table === 'invoice_requests') return { data: cfg.tableRows, error: cfg.tableError }
    if (table === 'company_notes') return { data: cfg.noteRows, error: null }
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

import { loadConfirmedInvoiceRequests } from '@/lib/invoice-requests-source'

function note(obj: Record<string, unknown>): { id: string; note: string } {
  return { id: String(obj.id || 'note-row'), note: PREFIX + JSON.stringify(obj) }
}

const PARTY = 'cb1f05f1-da0c-4290-9592-ac08ded79003'

describe('loadConfirmedInvoiceRequests', () => {
  beforeEach(() => {
    h.state.config = { tableRows: null, tableError: null, noteRows: [] }
  })

  it('reads confirmed requests from the company_notes fallback when the table is missing', async () => {
    h.state.config = {
      tableRows: null,
      tableError: { message: "Could not find the table 'public.invoice_requests'" },
      noteRows: [
        note({ id: 'a', invoice_number: 'INV/007', status: 'CONFIRMED', party_id: PARTY, order_id: 'o7' }),
        note({ id: 'b', invoice_number: 'INV/006', status: 'PENDING', party_id: PARTY, order_id: 'o6' }),
        note({ id: 'c', invoice_number: 'INV/005', status: 'CONFIRMED', party_id: PARTY, order_id: 'o5' }),
      ],
    }

    const result = await loadConfirmedInvoiceRequests(PARTY)

    // only CONFIRMED rows for this party, PENDING excluded
    expect(result.map((r) => r.invoice_number).sort()).toEqual(['INV/005', 'INV/007'])
  })

  it('excludes confirmed requests belonging to a different party', async () => {
    h.state.config = {
      tableRows: null,
      tableError: { message: 'missing table' },
      noteRows: [
        note({ id: 'a', invoice_number: 'INV/007', status: 'CONFIRMED', party_id: PARTY, order_id: 'o7' }),
        note({ id: 'x', invoice_number: 'INV/001', status: 'CONFIRMED', party_id: 'other-party', order_id: 'ox' }),
      ],
    }

    const result = await loadConfirmedInvoiceRequests(PARTY)
    expect(result).toHaveLength(1)
    expect(result[0].invoice_number).toBe('INV/007')
  })

  it('keeps two confirmed invoices that reference the same order (billed twice)', async () => {
    h.state.config = {
      tableRows: null,
      tableError: { message: 'missing table' },
      noteRows: [
        note({ id: 'a', invoice_number: 'INV/001', status: 'CONFIRMED', party_id: PARTY, order_id: 'shared' }),
        note({ id: 'b', invoice_number: 'INV/002', status: 'CONFIRMED', party_id: PARTY, order_id: 'shared' }),
      ],
    }

    const result = await loadConfirmedInvoiceRequests(PARTY)
    expect(result).toHaveLength(2)
    expect(result.map((r) => r.order_id)).toEqual(['shared', 'shared'])
  })

  it('merges table + fallback and de-duplicates by invoice_number (table wins)', async () => {
    h.state.config = {
      tableRows: [
        { id: 't1', invoice_number: 'INV/009', order_id: 'o9', company_id: 'c1', confirmed_at: '2026-06-01T00:00:00Z' },
      ],
      tableError: null,
      noteRows: [
        // duplicate invoice number — should be ignored in favour of the table row
        note({ id: 'dup', invoice_number: 'INV/009', status: 'CONFIRMED', party_id: PARTY, order_id: 'WRONG' }),
        note({ id: 'n1', invoice_number: 'INV/010', status: 'CONFIRMED', party_id: PARTY, order_id: 'o10' }),
      ],
    }

    const result = await loadConfirmedInvoiceRequests(PARTY)
    const byNum = Object.fromEntries(result.map((r) => [r.invoice_number, r.order_id]))
    expect(byNum).toEqual({ 'INV/009': 'o9', 'INV/010': 'o10' })
  })

  it('returns empty for a blank party id', async () => {
    expect(await loadConfirmedInvoiceRequests('')).toEqual([])
  })
})
