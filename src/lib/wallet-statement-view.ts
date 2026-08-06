// Shared view helpers for the wallet statement surfaces (the slide-in drawer and
// the full-window "expanded" page). Keeping the date presets and the
// transfer/collection type filter here means both surfaces stay in lock-step.
import type { StatementRow } from '@/lib/wallet-statement-pdf'

// ── Date presets ─────────────────────────────────────────────────────────────
export type PresetKey = 'all' | 'today' | '7d' | '30d' | 'month' | 'custom'

export const PRESETS: { key: PresetKey; label: string }[] = [
  { key: 'all', label: 'All time' },
  { key: 'today', label: 'Today' },
  { key: '7d', label: '7 days' },
  { key: '30d', label: '30 days' },
  { key: 'month', label: 'This month' },
  { key: 'custom', label: 'Custom' },
]

export const isoDay = (d: Date): string => {
  // Local YYYY-MM-DD (the server interprets these as IST day bounds).
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function rangeForPreset(key: PresetKey): { from: string | null; to: string | null } {
  const now = new Date()
  const today = isoDay(now)
  switch (key) {
    case 'today':
      return { from: today, to: today }
    case '7d': {
      const f = new Date(now)
      f.setDate(f.getDate() - 6)
      return { from: isoDay(f), to: today }
    }
    case '30d': {
      const f = new Date(now)
      f.setDate(f.getDate() - 29)
      return { from: isoDay(f), to: today }
    }
    case 'month':
      return { from: isoDay(new Date(now.getFullYear(), now.getMonth(), 1)), to: today }
    default:
      return { from: null, to: null }
  }
}

// ── Transaction type filter (collection vs transfer) ─────────────────────────
export type TxFilterKey = 'all' | 'collection' | 'transfer'

export const TX_FILTERS: { key: TxFilterKey; label: string }[] = [
  { key: 'all', label: 'All types' },
  { key: 'collection', label: 'Collections' },
  { key: 'transfer', label: 'Transfers' },
]

// Wallet-to-wallet transfers are folded into the statement by the history API
// with a synthetic id prefixed "transfer-in-" / "transfer-out-". Every other row
// is a real collected payment.
export function isTransferRow(r: Pick<StatementRow, 'id'>): boolean {
  return typeof r.id === 'string' && r.id.startsWith('transfer-')
}

export function matchesTxFilter(r: StatementRow, filter: TxFilterKey): boolean {
  if (filter === 'all') return true
  const transfer = isTransferRow(r)
  return filter === 'transfer' ? transfer : !transfer
}
