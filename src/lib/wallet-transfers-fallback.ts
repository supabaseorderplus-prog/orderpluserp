export const WALLET_TRANSFER_NOTE_PREFIX = '__wallet_transfer__:'

export type TransferBucket = 'cash' | 'bank' | 'coupon'
export type TransferStatus = 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'CANCELLED'

export type WalletTransferRecord = {
  id: string
  from_user_id: string
  to_user_id: string
  bucket: TransferBucket
  amount: number
  status: TransferStatus
  note: string | null
  company_id: string | null
  created_by: string | null
  decided_by: string | null
  decided_at: string | null
  created_at: string
}

const BUCKETS: TransferBucket[] = ['cash', 'bank', 'coupon']
const STATUSES: TransferStatus[] = ['PENDING', 'ACCEPTED', 'REJECTED', 'CANCELLED']

function normalizeBucket(value: unknown): TransferBucket {
  const b = String(value || '').toLowerCase()
  return (BUCKETS as string[]).includes(b) ? (b as TransferBucket) : 'bank'
}

function normalizeStatus(value: unknown): TransferStatus {
  const s = String(value || '').toUpperCase()
  return (STATUSES as string[]).includes(s) ? (s as TransferStatus) : 'PENDING'
}

/**
 * Encode one transfer as a `company_notes` row body. Used on deployments where
 * the dedicated `wallet_transfers` table cannot be created (no DDL privilege),
 * mirroring the wallet-adjust + invoice-request fallbacks. The full record is
 * embedded so status changes can rewrite the same note in place (located by id).
 */
export function buildWalletTransferNote(record: WalletTransferRecord): string {
  return `${WALLET_TRANSFER_NOTE_PREFIX}${JSON.stringify(record)}`
}

export function parseWalletTransferNote(raw: string | null | undefined): WalletTransferRecord | null {
  if (!raw || !raw.startsWith(WALLET_TRANSFER_NOTE_PREFIX)) return null
  try {
    const parsed = JSON.parse(raw.slice(WALLET_TRANSFER_NOTE_PREFIX.length)) as Partial<WalletTransferRecord>
    if (!parsed || typeof parsed !== 'object') return null
    if (!parsed.id || !parsed.from_user_id || !parsed.to_user_id) return null
    const amount = Number(parsed.amount)
    if (!Number.isFinite(amount)) return null
    return {
      id: String(parsed.id),
      from_user_id: String(parsed.from_user_id),
      to_user_id: String(parsed.to_user_id),
      bucket: normalizeBucket(parsed.bucket),
      amount,
      status: normalizeStatus(parsed.status),
      note: parsed.note == null ? null : String(parsed.note),
      company_id: parsed.company_id == null ? null : String(parsed.company_id),
      created_by: parsed.created_by == null ? null : String(parsed.created_by),
      decided_by: parsed.decided_by == null ? null : String(parsed.decided_by),
      decided_at: parsed.decided_at == null ? null : String(parsed.decided_at),
      created_at: String(parsed.created_at || new Date().toISOString()),
    }
  } catch {
    return null
  }
}
