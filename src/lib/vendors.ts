import { createHash, randomUUID } from 'crypto'
import { supabaseAdmin } from '@/lib/supabase-server'
import { queryDirectSql, runDirectSql } from '@/lib/direct-sql'

type CompanyNoteRow = {
  id: string
  company_id: string | null
  note: string | null
  created_at?: string | null
  updated_at?: string | null
}

// ── Domain types ────────────────────────────────────────────────────────────

export type VendorType = 'CREDITOR' | 'DEBTOR'
export type VendorTxnType = 'BILL' | 'PAYMENT' | 'ADJUSTMENT'

export interface VendorRow {
  id: string
  company_id: string | null
  vendor_code: string
  name: string
  trade_name: string | null
  vendor_type: VendorType
  gstin: string | null
  pan: string | null
  address_line1: string | null
  city: string | null
  pin_code: string | null
  contact_person: string | null
  contact_phone: string | null
  contact_email: string | null
  contact_aadhaar_url: string | null
  credit_limit: number
  payment_terms_days: number
  opening_balance: number
  latitude: number | null
  longitude: number | null
  portal_phone: string | null
  notes: string | null
  status: string
  is_verified: boolean | null
  verified_at: string | null
  verified_by: string | null
  created_at: string
  updated_at: string
}

export interface VendorTransactionRow {
  id: string
  vendor_id: string
  company_id: string | null
  txn_type: VendorTxnType
  amount: number
  txn_date: string
  reference_number: string | null
  description: string | null
  created_at: string
}

export const VENDOR_FALLBACK_NOTE_PREFIX = '__vendor__:'
export const VENDOR_TXN_FALLBACK_NOTE_PREFIX = '__vendor_txn__:'

// PostgREST/Postgres "undefined_table" — surfaced before the migration is run.
export const VENDORS_TABLE_MISSING_MESSAGE =
  'Vendor tables not found. Run CREATE_VENDORS_TABLES.sql in the Supabase SQL editor to enable vendor management.'

export const VENDORS_BACKEND_UNAVAILABLE_MESSAGE =
  'Vendor database is not reachable from the app right now. The vendors table may exist, but the app cannot access the fallback database connection.'

export const VENDORS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS vendors (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id           uuid,
  vendor_code          text NOT NULL DEFAULT '',
  name                 text NOT NULL,
  trade_name           text,
  vendor_type          text NOT NULL DEFAULT 'CREDITOR' CHECK (vendor_type IN ('CREDITOR', 'DEBTOR')),
  gstin                text,
  pan                  text,
  address_line1        text,
  city                 text,
  pin_code             text,
  contact_person       text,
  contact_phone        text,
  contact_email        text,
  contact_aadhaar_url  text,
  credit_limit         numeric(14,2) NOT NULL DEFAULT 0,
  payment_terms_days   integer NOT NULL DEFAULT 21,
  opening_balance      numeric(14,2) NOT NULL DEFAULT 0,
  latitude             numeric(9,6),
  longitude            numeric(9,6),
  portal_phone         text,
  portal_password_hash text,
  notes                text,
  status               text NOT NULL DEFAULT 'ACTIVE',
  is_verified          boolean NOT NULL DEFAULT false,
  verified_at          timestamptz,
  verified_by          uuid,
  created_by           uuid,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vendors_company ON vendors(company_id);
CREATE INDEX IF NOT EXISTS idx_vendors_status ON vendors(status);
CREATE INDEX IF NOT EXISTS idx_vendors_type ON vendors(vendor_type);
CREATE UNIQUE INDEX IF NOT EXISTS uq_vendors_company_portal_phone
  ON vendors(company_id, portal_phone)
  WHERE portal_phone IS NOT NULL AND portal_phone <> '';

CREATE TABLE IF NOT EXISTS vendor_transactions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id        uuid NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  company_id       uuid,
  txn_type         text NOT NULL CHECK (txn_type IN ('BILL', 'PAYMENT', 'ADJUSTMENT')),
  amount           numeric(14,2) NOT NULL,
  txn_date         date NOT NULL DEFAULT current_date,
  reference_number text,
  description      text,
  created_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vendor_txns_vendor ON vendor_transactions(vendor_id);
CREATE INDEX IF NOT EXISTS idx_vendor_txns_company ON vendor_transactions(company_id);
CREATE INDEX IF NOT EXISTS idx_vendor_txns_date ON vendor_transactions(txn_date);

ALTER TABLE vendors ADD COLUMN IF NOT EXISTS is_verified boolean NOT NULL DEFAULT false;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS verified_at timestamptz;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS verified_by uuid;

UPDATE vendors SET is_verified = true, verified_at = COALESCE(verified_at, now())
WHERE status = 'ACTIVE' AND is_verified = false;

CREATE INDEX IF NOT EXISTS idx_vendors_verified ON vendors(is_verified);

NOTIFY pgrst, 'reload schema';
`

export async function ensureVendorsSchema(): Promise<boolean> {
  try {
    const probe = await supabaseAdmin.rpc('exec_sql', { sql: 'SELECT 1;' })
    if (!probe.error) {
      const { error } = await supabaseAdmin.rpc('exec_sql', { sql: VENDORS_SCHEMA_SQL })
      if (!error) {
        try {
          await supabaseAdmin.rpc('exec_sql', { sql: "NOTIFY pgrst, 'reload schema';" })
        } catch {}
        return true
      }
      console.warn('[vendors] exec_sql migration failed:', error.message)
    } else {
      console.warn('[vendors] exec_sql unavailable:', probe.error.message)
    }
  } catch (err) {
    console.warn('[vendors] exec_sql unavailable:', err instanceof Error ? err.message : err)
  }

  const ok = await runDirectSql(VENDORS_SCHEMA_SQL)
  if (ok) {
    try {
      await runDirectSql("NOTIFY pgrst, 'reload schema';")
    } catch {}
  }
  return ok
}

export function isMissingTableError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const e = error as { code?: string; message?: string; details?: string }
  if (e.code === '42P01' || e.code === 'PGRST205') return true
  const text = `${e.message || ''} ${e.details || ''}`.toLowerCase()
  const namesTable = text.includes('vendors') || text.includes('vendor_transactions')
  if (!namesTable) return false
  return (
    text.includes('does not exist') ||
    text.includes('could not find the table') ||
    (text.includes('schema cache') && text.includes('table'))
  )
}

export function isMissingColumnError(error: unknown, column?: string): boolean {
  if (!error || typeof error !== 'object') return false
  const e = error as { code?: string; message?: string; details?: string }
  if (isMissingTableError(error)) return false
  const text = `${e.code || ''} ${e.message || ''} ${e.details || ''}`.toLowerCase()
  const looksLikeMissingColumn =
    e.code === '42703' ||
    e.code === 'PGRST204' ||
    (text.includes('column') &&
      (text.includes('could not find') ||
        text.includes('schema cache') ||
        text.includes('does not exist')))
  if (!looksLikeMissingColumn) return false
  return column ? text.includes(column.toLowerCase()) : true
}

export function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error) return err.message
  if (err && typeof err === 'object') {
    const e = err as { message?: string; details?: string; hint?: string }
    return e.message || e.details || e.hint || fallback
  }
  return fallback
}

function sqlLiteral(value: string): string {
  return "'" + value.replace(/'/g, "''") + "'"
}

export function hashVendorPassword(plain: string): string {
  return createHash('sha256').update(plain).digest('hex')
}

export const VENDOR_PUBLIC_COLUMNS =
  'id, company_id, vendor_code, name, trade_name, vendor_type, gstin, pan, ' +
  'address_line1, city, pin_code, contact_person, contact_phone, contact_email, ' +
  'contact_aadhaar_url, credit_limit, payment_terms_days, opening_balance, ' +
  'latitude, longitude, portal_phone, notes, status, created_at, updated_at'

export const VENDOR_VERIFICATION_COLUMNS = 'is_verified, verified_at, verified_by'

export const VENDOR_PUBLIC_COLUMNS_WITH_VERIFICATION =
  `${VENDOR_PUBLIC_COLUMNS}, ${VENDOR_VERIFICATION_COLUMNS}`

export function ledgerMovement(txns: Pick<VendorTransactionRow, 'txn_type' | 'amount'>[]): number {
  return txns.reduce((sum, t) => {
    const amt = Number(t.amount) || 0
    if (t.txn_type === 'PAYMENT') return sum - amt
    return sum + amt
  }, 0)
}

export function currentVendorBalance(
  openingBalance: number,
  txns: Pick<VendorTransactionRow, 'txn_type' | 'amount'>[],
): number {
  return Number((Number(openingBalance || 0) + ledgerMovement(txns)).toFixed(2))
}

export async function getVendorBalances(
  vendorIds: string[],
  openingById: Record<string, number>,
): Promise<Record<string, number>> {
  const result: Record<string, number> = {}
  for (const id of vendorIds) result[id] = Number(openingById[id] || 0)
  if (vendorIds.length === 0) return result

  const { data, error } = await supabaseAdmin
    .from('vendor_transactions')
    .select('vendor_id, txn_type, amount')
    .in('vendor_id', vendorIds)
  if (error) {
    if (isMissingTableError(error)) {
      const rows = await queryDirectSql<Pick<VendorTransactionRow, 'vendor_id' | 'txn_type' | 'amount'>>(`SELECT vendor_id, txn_type, amount FROM public.vendor_transactions WHERE vendor_id IN (${vendorIds.map((id) => sqlLiteral(id)).join(', ')})`)
      if (!rows) return result
      for (const t of rows) {
        const amt = Number(t.amount) || 0
        result[t.vendor_id] = (result[t.vendor_id] ?? 0) + (t.txn_type === 'PAYMENT' ? -amt : amt)
      }
      for (const id of vendorIds) result[id] = Number((result[id] ?? 0).toFixed(2))
      return result
    }
    throw error
  }
  for (const t of (data || []) as Pick<VendorTransactionRow, 'vendor_id' | 'txn_type' | 'amount'>[]) {
    const amt = Number(t.amount) || 0
    result[t.vendor_id] = (result[t.vendor_id] ?? 0) + (t.txn_type === 'PAYMENT' ? -amt : amt)
  }
  for (const id of vendorIds) result[id] = Number((result[id] ?? 0).toFixed(2))
  return result
}

export async function generateVendorCode(companyId: string | null): Promise<string> {
  try {
    const { count, error } = await supabaseAdmin
      .from('vendors')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', companyId)
    if (error) throw error
    const next = (count || 0) + 1
    return `V${String(next).padStart(3, '0')}`
  } catch {
    return `V${Date.now().toString().slice(-6)}`
  }
}

const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/

export function validateGstin(gstin: string): boolean {
  return GSTIN_PATTERN.test(gstin)
}

export function normalizeCoordinate(value: unknown, min: number, max: number): number | null {
  if (value === undefined || value === null || value === '') return null
  const n = Number(value)
  if (!Number.isFinite(n) || n < min || n > max) return null
  return Number(n.toFixed(6))
}

function nowIso(): string {
  return new Date().toISOString()
}

function randomId(): string {
  return randomUUID()
}

function normalizeVendorRow(record: Partial<VendorRow> & { id: string }): VendorRow {
  return {
    id: String(record.id),
    company_id: record.company_id == null ? null : String(record.company_id),
    vendor_code: String(record.vendor_code || ''),
    name: String(record.name || ''),
    trade_name: record.trade_name == null ? null : String(record.trade_name),
    vendor_type: record.vendor_type === 'DEBTOR' ? 'DEBTOR' : 'CREDITOR',
    gstin: record.gstin == null ? null : String(record.gstin),
    pan: record.pan == null ? null : String(record.pan),
    address_line1: record.address_line1 == null ? null : String(record.address_line1),
    city: record.city == null ? null : String(record.city),
    pin_code: record.pin_code == null ? null : String(record.pin_code),
    contact_person: record.contact_person == null ? null : String(record.contact_person),
    contact_phone: record.contact_phone == null ? null : String(record.contact_phone),
    contact_email: record.contact_email == null ? null : String(record.contact_email),
    contact_aadhaar_url: record.contact_aadhaar_url == null ? null : String(record.contact_aadhaar_url),
    credit_limit: Number(record.credit_limit || 0),
    payment_terms_days: Number(record.payment_terms_days || 21),
    opening_balance: Number(record.opening_balance || 0),
    latitude: record.latitude == null ? null : Number(record.latitude),
    longitude: record.longitude == null ? null : Number(record.longitude),
    portal_phone: record.portal_phone == null ? null : String(record.portal_phone),
    notes: record.notes == null ? null : String(record.notes),
    status: String(record.status || 'ACTIVE'),
    is_verified: record.is_verified == null ? false : Boolean(record.is_verified),
    verified_at: record.verified_at == null ? null : String(record.verified_at),
    verified_by: record.verified_by == null ? null : String(record.verified_by),
    created_at: String(record.created_at || nowIso()),
    updated_at: String(record.updated_at || nowIso()),
  }
}

function normalizeVendorTxnRow(record: Partial<VendorTransactionRow> & { id: string; vendor_id: string }): VendorTransactionRow {
  return {
    id: String(record.id),
    vendor_id: String(record.vendor_id),
    company_id: record.company_id == null ? null : String(record.company_id),
    txn_type: record.txn_type === 'PAYMENT' ? 'PAYMENT' : record.txn_type === 'ADJUSTMENT' ? 'ADJUSTMENT' : 'BILL',
    amount: Number(record.amount || 0),
    txn_date: String(record.txn_date || nowIso().slice(0, 10)),
    reference_number: record.reference_number == null ? null : String(record.reference_number),
    description: record.description == null ? null : String(record.description),
    created_at: String(record.created_at || nowIso()),
  }
}

function buildVendorFallbackNote(record: VendorRow): string {
  return `${VENDOR_FALLBACK_NOTE_PREFIX}${JSON.stringify(record)}`
}

function parseVendorFallbackNote(note: string | null | undefined): VendorRow | null {
  if (!note || !note.startsWith(VENDOR_FALLBACK_NOTE_PREFIX)) return null
  try {
    const parsed = JSON.parse(note.slice(VENDOR_FALLBACK_NOTE_PREFIX.length)) as Partial<VendorRow> & { id?: string }
    if (!parsed?.id) return null
    return normalizeVendorRow(parsed as Partial<VendorRow> & { id: string })
  } catch {
    return null
  }
}

function buildVendorTxnFallbackNote(record: VendorTransactionRow): string {
  return `${VENDOR_TXN_FALLBACK_NOTE_PREFIX}${JSON.stringify(record)}`
}

function parseVendorTxnFallbackNote(note: string | null | undefined): VendorTransactionRow | null {
  if (!note || !note.startsWith(VENDOR_TXN_FALLBACK_NOTE_PREFIX)) return null
  try {
    const parsed = JSON.parse(note.slice(VENDOR_TXN_FALLBACK_NOTE_PREFIX.length)) as Partial<VendorTransactionRow> & { id?: string; vendor_id?: string }
    if (!parsed?.id || !parsed?.vendor_id) return null
    return normalizeVendorTxnRow(parsed as Partial<VendorTransactionRow> & { id: string; vendor_id: string })
  } catch {
    return null
  }
}

async function listVendorFallbackRows(companyId?: string | null): Promise<Array<{ noteRow: CompanyNoteRow; vendor: VendorRow }>> {
  let query = supabaseAdmin
    .from('company_notes')
    .select('id, company_id, note, created_at, updated_at')
    .like('note', `${VENDOR_FALLBACK_NOTE_PREFIX}%`)
    .order('created_at', { ascending: false })
    .limit(5000)

  if (companyId) query = query.eq('company_id', companyId)
  const { data, error } = await query
  if (error) throw error

  return ((data || []) as CompanyNoteRow[])
    .map((noteRow) => ({ noteRow, vendor: parseVendorFallbackNote(noteRow.note) }))
    .filter((entry): entry is { noteRow: CompanyNoteRow; vendor: VendorRow } => !!entry.vendor)
}

async function listVendorTxnFallbackRows(companyId?: string | null): Promise<Array<{ noteRow: CompanyNoteRow; txn: VendorTransactionRow }>> {
  let query = supabaseAdmin
    .from('company_notes')
    .select('id, company_id, note, created_at, updated_at')
    .like('note', `${VENDOR_TXN_FALLBACK_NOTE_PREFIX}%`)
    .order('created_at', { ascending: false })
    .limit(5000)

  if (companyId) query = query.eq('company_id', companyId)
  const { data, error } = await query
  if (error) throw error

  return ((data || []) as CompanyNoteRow[])
    .map((noteRow) => ({ noteRow, txn: parseVendorTxnFallbackNote(noteRow.note) }))
    .filter((entry): entry is { noteRow: CompanyNoteRow; txn: VendorTransactionRow } => !!entry.txn)
}

export async function listFallbackVendors(companyId: string, opts?: { search?: string; vendor_type?: string; is_verified?: 'true' | 'false' | 'all' }) {
  const rows = await listVendorFallbackRows(companyId)
  let vendors = rows.map((entry) => entry.vendor).filter((vendor) => vendor.status !== 'DELETED')

  const search = String(opts?.search || '').trim().toLowerCase()
  if (search) {
    vendors = vendors.filter((vendor) =>
      [vendor.name, vendor.vendor_code, vendor.trade_name, vendor.gstin, vendor.contact_phone]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(search)),
    )
  }

  if (opts?.vendor_type === 'CREDITOR' || opts?.vendor_type === 'DEBTOR') {
    vendors = vendors.filter((vendor) => vendor.vendor_type === opts.vendor_type)
  }

  if (opts?.is_verified === 'true') vendors = vendors.filter((vendor) => vendor.is_verified === true)
  if (opts?.is_verified === 'false') vendors = vendors.filter((vendor) => vendor.is_verified !== true)

  vendors.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
  return vendors
}

export async function getFallbackVendorById(companyId: string, id: string): Promise<VendorRow | null> {
  const rows = await listVendorFallbackRows(companyId)
  const match = rows.find((entry) => entry.vendor.id === id && entry.vendor.status !== 'DELETED')
  return match?.vendor ?? null
}

export async function createFallbackVendor(companyId: string, input: Omit<VendorRow, 'created_at' | 'updated_at'>): Promise<VendorRow> {
  const record = normalizeVendorRow({
    ...input,
    company_id: companyId,
    created_at: nowIso(),
    updated_at: nowIso(),
  })
  const { error } = await supabaseAdmin.from('company_notes').insert({
    company_id: companyId,
    note: buildVendorFallbackNote(record),
  })
  if (error) throw error
  return record
}

export async function updateFallbackVendor(companyId: string, id: string, patch: Partial<VendorRow>): Promise<VendorRow | null> {
  const rows = await listVendorFallbackRows(companyId)
  const existing = rows.find((entry) => entry.vendor.id === id)
  if (!existing) return null

  const updated = normalizeVendorRow({
    ...existing.vendor,
    ...patch,
    id,
    company_id: companyId,
    updated_at: nowIso(),
  })
  const { error } = await supabaseAdmin
    .from('company_notes')
    .update({ note: buildVendorFallbackNote(updated) })
    .eq('id', existing.noteRow.id)
    .eq('company_id', companyId)
  if (error) throw error
  return updated
}

export async function deleteFallbackVendor(companyId: string, id: string): Promise<boolean> {
  const rows = await listVendorFallbackRows(companyId)
  const existing = rows.find((entry) => entry.vendor.id === id)
  if (!existing) return false
  const deleted = normalizeVendorRow({ ...existing.vendor, status: 'DELETED', updated_at: nowIso() })
  const { error } = await supabaseAdmin
    .from('company_notes')
    .update({ note: buildVendorFallbackNote(deleted) })
    .eq('id', existing.noteRow.id)
    .eq('company_id', companyId)
  if (error) throw error
  return true
}

export async function listFallbackVendorTransactions(companyId: string, vendorId: string): Promise<VendorTransactionRow[]> {
  const rows = await listVendorTxnFallbackRows(companyId)
  return rows
    .map((entry) => entry.txn)
    .filter((txn) => txn.vendor_id === vendorId)
    .sort((a, b) => `${b.txn_date} ${b.created_at}`.localeCompare(`${a.txn_date} ${a.created_at}`))
}

export async function getFallbackVendorBalances(vendorIds: string[], openingById: Record<string, number>, companyId?: string | null): Promise<Record<string, number>> {
  const result: Record<string, number> = {}
  for (const id of vendorIds) result[id] = Number(openingById[id] || 0)
  if (vendorIds.length === 0 || !companyId) return result
  const txns = await listVendorTxnFallbackRows(companyId)
  for (const { txn } of txns) {
    if (!vendorIds.includes(txn.vendor_id)) continue
    const amt = Number(txn.amount || 0)
    result[txn.vendor_id] = (result[txn.vendor_id] ?? 0) + (txn.txn_type === 'PAYMENT' ? -amt : amt)
  }
  for (const id of vendorIds) result[id] = Number((result[id] ?? 0).toFixed(2))
  return result
}

export async function createFallbackVendorTransaction(companyId: string, input: Omit<VendorTransactionRow, 'created_at'>): Promise<VendorTransactionRow> {
  const record = normalizeVendorTxnRow({ ...input, company_id: companyId, created_at: nowIso() })
  const { error } = await supabaseAdmin.from('company_notes').insert({
    company_id: companyId,
    note: buildVendorTxnFallbackNote(record),
  })
  if (error) throw error
  return record
}

export async function generateFallbackVendorCode(companyId: string | null): Promise<string> {
  if (!companyId) return `V${Date.now().toString().slice(-6)}`
  const vendors = await listFallbackVendors(companyId)
  return `V${String(vendors.length + 1).padStart(3, '0')}`
}

export function newVendorId(): string {
  return randomId()
}

export function newVendorTxnId(): string {
  return randomId()
}
