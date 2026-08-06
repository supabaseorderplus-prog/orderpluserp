import { supabaseAdmin } from '@/lib/supabase-server'
import { runDirectSql, queryDirectSql } from '@/lib/direct-sql'
import { resolveSelfAssignedPartyIds } from '@/lib/collector-ids'
import { fetchAllInChunksPaged } from '@/lib/supabase-in-chunks'
import { effectivePaymentMode } from '@/lib/payment-mode'
import {
  WALLET_TRANSFER_NOTE_PREFIX,
  buildWalletTransferNote,
  parseWalletTransferNote,
  type WalletTransferRecord,
  type TransferBucket,
  type TransferStatus,
} from '@/lib/wallet-transfers-fallback'

export type { WalletTransferRecord, TransferBucket, TransferStatus }

type DbError = { code?: string; message?: string; details?: string } | null | undefined

function isMissingSchemaPiece(error: DbError): boolean {
  if (!error) return false
  const text = `${error.message || ''} ${error.details || ''}`.toLowerCase()
  return (
    error.code === '42P01' ||
    error.code === '42703' ||
    error.code === 'PGRST200' ||
    error.code === 'PGRST204' ||
    error.code === 'PGRST205' ||
    text.includes('wallet_transfers') ||
    text.includes('schema cache') ||
    text.includes('could not find')
  )
}

// ── Buckets ──────────────────────────────────────────────────────────────
// Mirror the classification used by /api/v1/wallets and the my-wallet page so
// a transferred bucket lines up with the balance the salesman actually sees.
const CASH_MODES = ['CASH']
const COUPON_MODES = ['COUPON', 'VOUCHER', 'TOKEN']
export const TRANSFER_BUCKETS: TransferBucket[] = ['cash', 'bank', 'coupon']

export function classifyBucket(mode: string | null | undefined, bankName?: string | null): TransferBucket {
  const m = effectivePaymentMode(mode, bankName)
  if (CASH_MODES.includes(m)) return 'cash'
  if (COUPON_MODES.includes(m)) return 'coupon'
  return 'bank'
}

// ── Flow rule ────────────────────────────────────────────────────────────
// Who may send to whom. Money terminates at the company ADMIN. Super Admins
// hold no wallet, so they are never a valid recipient. Admin is terminal
// (cannot initiate).
export const TRANSFER_FLOW: Record<string, string[]> = {
  SALESMAN: ['ACCOUNTS_MANAGER', 'ADMIN'],
  ACCOUNTS_MANAGER: ['ADMIN'],
}

export function canSend(fromRole: string): boolean {
  return Array.isArray(TRANSFER_FLOW[fromRole]) && TRANSFER_FLOW[fromRole].length > 0
}

export function canTransfer(fromRole: string, toRole: string): boolean {
  return (TRANSFER_FLOW[fromRole] || []).includes(toRole)
}

// ── Pure adjustment reducer (unit-tested; no DB) ───────────────────────────
export interface BucketDelta {
  cash: number
  bank: number
  coupon: number
  /** count of PENDING transfers awaiting this user's approval (for the badge) */
  pendingIncoming: number
  /** total amount of PENDING transfers awaiting this user's approval */
  pendingIncomingAmount: number
}

function emptyDelta(): BucketDelta {
  return { cash: 0, bank: 0, coupon: 0, pendingIncoming: 0, pendingIncomingAmount: 0 }
}

/**
 * Per-user wallet delta from a set of transfers, applying the unified formula:
 *
 *   walletBucket += Σ incoming ACCEPTED − Σ outgoing (PENDING | ACCEPTED)
 *
 * Held money (PENDING outgoing) leaves the sender immediately; ACCEPTED keeps it
 * gone and lands it on the recipient; REJECTED/CANCELLED restore it (never summed).
 *
 * `identityByUser` maps each board user id to EVERY id they may appear under in
 * transfer from/to columns (see resolveUserIdentityIds). Matching is membership-
 * based and fail-closed: a user with no resolvable identity ids gets a zero delta.
 */
export function reduceTransferAdjustments(
  transfers: WalletTransferRecord[],
  identityByUser: Record<string, string[]>,
): Record<string, BucketDelta> {
  const result: Record<string, BucketDelta> = {}
  const idSets: Record<string, Set<string>> = {}
  for (const [userId, ids] of Object.entries(identityByUser)) {
    result[userId] = emptyDelta()
    idSets[userId] = new Set((ids || []).filter(Boolean))
  }

  for (const t of transfers) {
    const amount = Number(t.amount) || 0
    if (amount <= 0) continue
    const bucket = t.bucket

    for (const userId of Object.keys(result)) {
      const ids = idSets[userId]
      if (ids.size === 0) continue
      const isSender = ids.has(t.from_user_id)
      const isRecipient = ids.has(t.to_user_id)

      // Outgoing: money leaves on PENDING and stays gone on ACCEPTED.
      if (isSender && (t.status === 'PENDING' || t.status === 'ACCEPTED')) {
        result[userId][bucket] -= amount
      }
      // Incoming: credited only once ACCEPTED. PENDING only feeds the badge.
      if (isRecipient) {
        if (t.status === 'ACCEPTED') {
          result[userId][bucket] += amount
        } else if (t.status === 'PENDING') {
          result[userId].pendingIncoming += 1
          result[userId].pendingIncomingAmount += amount
        }
      }
    }
  }

  return result
}

// ── Schema ─────────────────────────────────────────────────────────────────
async function ensureWalletTransfersSchema(): Promise<boolean> {
  const sql = `
    CREATE TABLE IF NOT EXISTS public.wallet_transfers (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      from_user_id UUID NOT NULL,
      to_user_id UUID NOT NULL,
      bucket TEXT NOT NULL DEFAULT 'bank',
      amount FLOAT NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'PENDING',
      note TEXT,
      company_id UUID,
      created_by UUID,
      decided_by UUID,
      decided_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_wallet_transfers_company ON public.wallet_transfers(company_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_wallet_transfers_from ON public.wallet_transfers(from_user_id);
    CREATE INDEX IF NOT EXISTS idx_wallet_transfers_to ON public.wallet_transfers(to_user_id);
    NOTIFY pgrst, 'reload schema';
  `
  const { error } = await supabaseAdmin.rpc('exec_sql', { sql })
  if (!error) return true
  return runDirectSql(sql)
}

// ── SQL literal helpers (for the company_notes-free direct path) ────────────
function sqlLiteral(value: string) {
  return `'${value.replace(/'/g, "''")}'`
}
function sqlNullableUuid(value: unknown) {
  if (typeof value !== 'string') return 'NULL'
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? sqlLiteral(value)
    : 'NULL'
}
function sqlNullableText(value: unknown) {
  if (value === null || value === undefined || value === '') return 'NULL'
  return sqlLiteral(String(value))
}

function rowToRecord(row: Record<string, unknown>): WalletTransferRecord {
  return {
    id: String(row.id),
    from_user_id: String(row.from_user_id),
    to_user_id: String(row.to_user_id),
    bucket: (['cash', 'bank', 'coupon'].includes(String(row.bucket)) ? row.bucket : 'bank') as TransferBucket,
    amount: Number(row.amount || 0),
    status: (['PENDING', 'ACCEPTED', 'REJECTED', 'CANCELLED'].includes(String(row.status)) ? row.status : 'PENDING') as TransferStatus,
    note: row.note == null ? null : String(row.note),
    company_id: row.company_id == null ? null : String(row.company_id),
    created_by: row.created_by == null ? null : String(row.created_by),
    decided_by: row.decided_by == null ? null : String(row.decided_by),
    decided_at: row.decided_at == null ? null : String(row.decided_at),
    created_at: String(row.created_at || new Date().toISOString()),
  }
}

// ── company_notes fallback helpers ──────────────────────────────────────────
async function loadTransfersFromNotes(companyId: string | null): Promise<WalletTransferRecord[]> {
  const { data: noteRows } = await supabaseAdmin
    .from('company_notes')
    .select('note')
    .like('note', `${WALLET_TRANSFER_NOTE_PREFIX}%`)
    .limit(5000)
  const records: WalletTransferRecord[] = []
  for (const row of (noteRows || []) as { note: string | null }[]) {
    const parsed = parseWalletTransferNote(row.note)
    if (!parsed) continue
    if (companyId && parsed.company_id && parsed.company_id !== companyId) continue
    records.push(parsed)
  }
  return records
}

/**
 * Load all transfers for a company from whichever store is available
 * (dedicated table preferred, company_notes fallback).
 */
export async function loadCompanyTransfers(companyId: string | null): Promise<WalletTransferRecord[]> {
  let query = supabaseAdmin
    .from('wallet_transfers')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(5000)
  if (companyId) query = query.eq('company_id', companyId)

  const { data, error } = await query
  if (!error) return (data || []).map((r) => rowToRecord(r as Record<string, unknown>))
  if (!isMissingSchemaPiece(error)) throw error

  // PostgREST cannot see the table — which is EXACTLY the condition under which
  // updateTransferStatus() writes accept/reject/cancel decisions to company_notes
  // instead of the table. So in this branch company_notes is authoritative for
  // STATUS and we must overlay it: a raw direct-SQL read can surface a stale
  // table row (e.g. the table exists physically but isn't in PostgREST's schema
  // cache after a CREATE), and without the overlay an accepted transfer would
  // read back as PENDING forever. We merge by id, letting the company_notes copy
  // (the post-decision record) win over any table row with the same id.
  const where = companyId ? `WHERE company_id = ${sqlLiteral(companyId)}` : ''
  const rows = await queryDirectSql<Record<string, unknown>>(
    `SELECT * FROM public.wallet_transfers ${where} ORDER BY created_at DESC LIMIT 5000`,
  )
  const notes = await loadTransfersFromNotes(companyId)

  if (rows && rows.length > 0) {
    const byId = new Map<string, WalletTransferRecord>()
    for (const r of rows) {
      const rec = rowToRecord(r)
      byId.set(rec.id, rec)
    }
    // company_notes carries the latest decision in fallback mode → it wins.
    for (const n of notes) byId.set(n.id, n)
    return [...byId.values()].sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    )
  }

  return notes
}

export async function getTransferById(id: string): Promise<WalletTransferRecord | null> {
  const { data, error } = await supabaseAdmin.from('wallet_transfers').select('*').eq('id', id).maybeSingle()
  if (!error) return data ? rowToRecord(data as Record<string, unknown>) : null
  if (!isMissingSchemaPiece(error)) throw error

  // Resolve from the same merged store loadCompanyTransfers reads (direct-SQL
  // table overlaid by company_notes), so PATCH's pre-check sees a record that
  // lives in the physical table — otherwise it 404s before the status update.
  const notes = await loadTransfersFromNotes(null)
  const noteHit = notes.find((t) => t.id === id)
  if (noteHit) return noteHit

  const rows = await queryDirectSql<Record<string, unknown>>(
    `SELECT * FROM public.wallet_transfers WHERE id = ${sqlNullableUuid(id)} LIMIT 1`,
  )
  if (rows && rows.length > 0) return rowToRecord(rows[0])
  return null
}

// ── Create ──────────────────────────────────────────────────────────────────
export async function createTransfer(input: {
  from_user_id: string
  to_user_id: string
  bucket: TransferBucket
  amount: number
  note?: string | null
  company_id?: string | null
}): Promise<WalletTransferRecord> {
  const record: WalletTransferRecord = {
    id: globalThis.crypto?.randomUUID?.() ?? cryptoFallbackUuid(),
    from_user_id: input.from_user_id,
    to_user_id: input.to_user_id,
    bucket: input.bucket,
    amount: Number(input.amount),
    status: 'PENDING',
    note: input.note ?? null,
    company_id: input.company_id ?? null,
    created_by: input.from_user_id,
    decided_by: null,
    decided_at: null,
    created_at: new Date().toISOString(),
  }

  const insertRow = {
    id: record.id,
    from_user_id: record.from_user_id,
    to_user_id: record.to_user_id,
    bucket: record.bucket,
    amount: record.amount,
    status: record.status,
    note: record.note,
    company_id: record.company_id,
    created_by: record.created_by,
    created_at: record.created_at,
  }

  const first = await supabaseAdmin.from('wallet_transfers').insert(insertRow)
  if (!first.error) return record

  if (!isMissingSchemaPiece(first.error)) throw first.error

  // Try to create the table, then retry once.
  const ready = await ensureWalletTransfersSchema()
  if (ready) {
    const retry = await supabaseAdmin.from('wallet_transfers').insert(insertRow)
    if (!retry.error) return record
    if (!isMissingSchemaPiece(retry.error)) throw retry.error

    const sql = `
      INSERT INTO public.wallet_transfers
        (id, from_user_id, to_user_id, bucket, amount, status, note, company_id, created_by, created_at)
      VALUES (
        ${sqlNullableUuid(record.id)}, ${sqlNullableUuid(record.from_user_id)}, ${sqlNullableUuid(record.to_user_id)},
        ${sqlLiteral(record.bucket)}, ${record.amount}, ${sqlLiteral(record.status)}, ${sqlNullableText(record.note)},
        ${sqlNullableUuid(record.company_id)}, ${sqlNullableUuid(record.created_by)}, ${sqlLiteral(record.created_at)}
      );
    `
    if (await runDirectSql(sql)) return record
  }

  // Final fallback: persist as a company_notes row.
  const { error: noteErr } = await supabaseAdmin.from('company_notes').insert({
    company_id: record.company_id,
    created_by: record.created_by,
    note: buildWalletTransferNote(record),
  })
  if (noteErr) throw noteErr
  return record
}

// ── Status change (accept / reject / cancel) ─────────────────────────────────
export async function updateTransferStatus(
  id: string,
  next: { status: TransferStatus; decided_by: string | null },
): Promise<boolean> {
  const decided_at = new Date().toISOString()
  const update = { status: next.status, decided_by: next.decided_by, decided_at }

  const { error, data } = await supabaseAdmin
    .from('wallet_transfers')
    .update(update)
    .eq('id', id)
    .eq('status', 'PENDING') // only a pending transfer may transition
    .select('id')
  if (!error) return Array.isArray(data) && data.length > 0
  if (!isMissingSchemaPiece(error)) throw error

  // The table is invisible to PostgREST. It may still exist physically (created
  // earlier, schema cache not reloaded) — in which case the transfer was created
  // there via direct SQL and lives ONLY there. Try a direct-SQL update so the
  // decision persists against the same store loadCompanyTransfers reads from;
  // otherwise an accepted transfer would read back as PENDING. A null result
  // means direct SQL is unavailable or the table doesn't exist → fall through.
  const updated = await queryDirectSql<{ id: string }>(
    `UPDATE public.wallet_transfers
       SET status = ${sqlLiteral(next.status)},
           decided_by = ${sqlNullableUuid(next.decided_by)},
           decided_at = ${sqlLiteral(decided_at)}
     WHERE id = ${sqlNullableUuid(id)} AND status = 'PENDING'
     RETURNING id`,
  )
  if (updated && updated.length > 0) return true

  // company_notes fallback: locate the note carrying this transfer and rewrite it.
  const { data: noteRows } = await supabaseAdmin
    .from('company_notes')
    .select('id, note')
    .like('note', `${WALLET_TRANSFER_NOTE_PREFIX}%`)
    .limit(5000)
  for (const row of (noteRows || []) as { id: string; note: string | null }[]) {
    const parsed = parseWalletTransferNote(row.note)
    if (!parsed || parsed.id !== id) continue
    if (parsed.status !== 'PENDING') return false
    const updated: WalletTransferRecord = { ...parsed, status: next.status, decided_by: next.decided_by, decided_at }
    const { error: upErr } = await supabaseAdmin
      .from('company_notes')
      .update({ note: buildWalletTransferNote(updated) })
      .eq('id', row.id)
    return !upErr
  }
  return false
}

// ── Collected payments (a salesman's wallet base) ──────────────────────────
type CollectedRow = {
  id?: string | null
  amount: number | string
  payment_mode: string | null
  bank_name: string | null
  created_by: string | null
}

/**
 * Sum the payments a collector recorded, bucketed cash/bank/coupon. This is the
 * BASE a salesman can transfer from (financers/admins collect nothing → zeros).
 *
 * Mirrors the UNION used by both /api/v1/wallets (admin board) and the
 * /api/v1/payments?mine=true wallet view: primary match on
 * payments.created_by ∈ identityIds, ALWAYS merged with the legacy null-created_by
 * payments on the collector's assigned parties (deduped by payment id).
 *
 * The legacy set is NOT an empty-fallback. The old "only when primary is empty"
 * gate meant the moment a salesman had a single created_by-stamped collection,
 * every earlier NULL-created_by payment silently dropped out of this total — so
 * the transfer endpoint under-counted the balance and rejected valid transfers
 * with "Insufficient balance", even though the wallet board / My-Wallet view
 * (which already union both sets) showed the full amount. Keeping this in sync
 * with those two paths is what makes the pre-transfer check agree with the UI.
 */
export async function computeCollectedBuckets(
  identityIds: string[],
): Promise<{ cash: number; bank: number; coupon: number }> {
  const buckets = { cash: 0, bank: 0, coupon: 0 }
  if (identityIds.length === 0) return buckets

  // Page past PostgREST's max-rows cap (order by unique id): a high-volume collector
  // with >1000 payments would otherwise have their collections silently truncated,
  // under-counting the base a salesman can transfer from and desyncing the wallet
  // board (which pages the same data) from this My-Wallet view.
  const { data: primary } = await fetchAllInChunksPaged<CollectedRow>(
    identityIds, (chunk, from, to) =>
      supabaseAdmin.from('payments').select('id, amount, payment_mode, bank_name, created_by').in('created_by', chunk).order('id', { ascending: true }).range(from, to))

  // Legacy attribution (null created_by) for every party assigned to this
  // collector, UNIONED with the primary rows above — never gated on the primary
  // set being empty. Disjoint by construction (primary requires a non-null
  // created_by, legacy requires null), but we still dedupe by id defensively.
  const partyIds = await resolveSelfAssignedPartyIds(identityIds)
  let legacyRows: CollectedRow[] = []
  if (partyIds.length > 0) {
    const { data: legacy } = await fetchAllInChunksPaged<CollectedRow>(
      partyIds, (chunk, from, to) =>
        supabaseAdmin.from('payments').select('id, amount, payment_mode, bank_name, created_by').in('party_id', chunk).is('created_by', null).order('id', { ascending: true }).range(from, to))
    legacyRows = (legacy || []) as CollectedRow[]
  }

  const seen = new Set<string>()
  for (const p of [...((primary || []) as CollectedRow[]), ...legacyRows]) {
    const rowId = typeof p.id === 'string' ? p.id : null
    if (rowId) {
      if (seen.has(rowId)) continue
      seen.add(rowId)
    }
    buckets[classifyBucket(p.payment_mode, p.bank_name)] += Number(p.amount) || 0
  }
  return buckets
}

function cryptoFallbackUuid(): string {
  // RFC4122 v4-ish fallback for environments without crypto.randomUUID.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}
