import { supabaseAdmin } from '@/lib/supabase-server'
import { runDirectSql, queryDirectSql } from '@/lib/direct-sql'
import {
  EXPENSE_NOTE_PREFIX,
  buildExpenseNote,
  parseExpenseNote,
  type ExpenseRecord,
  type ExpenseBucket,
  type ExpenseStatus,
} from '@/lib/expenses-fallback'

export type { ExpenseRecord, ExpenseBucket, ExpenseStatus }

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
    text.includes('wallet_expenses') ||
    text.includes('schema cache') ||
    text.includes('could not find')
  )
}

function isUnavailableTable(error: DbError): boolean {
  if (!error) return false
  const text = `${error.message || ''} ${error.details || ''}`.toLowerCase()
  return error.code === '42P01' || error.code === 'PGRST205' || text.includes("could not find the table 'public.wallet_expenses")
}

// ── Pure adjustment reducer (subtract spend from a wallet) ───────────────────
export interface ExpenseDelta {
  cash: number
  bank: number
  coupon: number
  /** total spent across all buckets (always >= 0) */
  total: number
}

function emptyDelta(): ExpenseDelta {
  return { cash: 0, bank: 0, coupon: 0, total: 0 }
}

/**
 * Per-user wallet spend from a set of expenses. Returns POSITIVE amounts spent
 * per bucket; the wallets route subtracts these from the live balance, exactly
 * like outgoing transfers. `identityByUser` maps each board user id to every id
 * they may appear under (mirrors the transfer netting block). Matching is
 * membership-based and fail-closed: a user with no resolvable id gets a zero delta.
 */
export function reduceExpenseAdjustments(
  expenses: ExpenseRecord[],
  identityByUser: Record<string, string[]>,
): Record<string, ExpenseDelta> {
  const result: Record<string, ExpenseDelta> = {}
  const idSets: Record<string, Set<string>> = {}
  for (const [userId, ids] of Object.entries(identityByUser)) {
    result[userId] = emptyDelta()
    idSets[userId] = new Set((ids || []).filter(Boolean))
  }

  for (const e of expenses) {
    const amount = expenseWalletDebit(e)
    if (amount <= 0) continue
    for (const userId of Object.keys(result)) {
      const ids = idSets[userId]
      if (ids.size === 0) continue
      if (ids.has(e.user_id)) {
        result[userId][e.bucket] += amount
        result[userId].total += amount
      }
    }
  }

  return result
}

/** Amount currently unavailable in the payer's wallet for this request. */
export function expenseWalletDebit(expense: ExpenseRecord): number {
  if (expense.status === 'PENDING') return Math.max(0, Number(expense.requested_amount ?? expense.amount) || 0)
  if (expense.status === 'APPROVED') return Math.max(0, Number(expense.approved_amount ?? expense.amount) || 0)
  return 0
}

/** Amount that has actually become an accounting expense. */
export function realizedExpenseAmount(expense: ExpenseRecord): number {
  return expense.status === 'APPROVED'
    ? Math.max(0, Number(expense.approved_amount ?? expense.amount) || 0)
    : 0
}

export function expenseAccountingDate(expense: ExpenseRecord): string {
  return expense.status === 'APPROVED' && expense.decided_at ? expense.decided_at : expense.created_at
}

// ── Schema ─────────────────────────────────────────────────────────────────
async function ensureExpensesSchema(): Promise<boolean> {
  const sql = `
    CREATE TABLE IF NOT EXISTS public.wallet_expenses (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL,
      user_name TEXT,
      requester_role TEXT NOT NULL DEFAULT 'UNKNOWN',
      bucket TEXT NOT NULL DEFAULT 'cash',
      amount FLOAT NOT NULL DEFAULT 0,
      requested_amount FLOAT NOT NULL DEFAULT 0,
      approved_amount FLOAT,
      category TEXT NOT NULL DEFAULT 'Misc',
      note TEXT,
      company_id UUID,
      created_by UUID,
      status TEXT NOT NULL DEFAULT 'PENDING',
      decided_by UUID,
      decided_by_name TEXT,
      decision_note TEXT,
      decided_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    ALTER TABLE public.wallet_expenses ADD COLUMN IF NOT EXISTS requester_role TEXT NOT NULL DEFAULT 'UNKNOWN';
    ALTER TABLE public.wallet_expenses ADD COLUMN IF NOT EXISTS requested_amount FLOAT;
    ALTER TABLE public.wallet_expenses ADD COLUMN IF NOT EXISTS approved_amount FLOAT;
    ALTER TABLE public.wallet_expenses ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'APPROVED';
    ALTER TABLE public.wallet_expenses ADD COLUMN IF NOT EXISTS decided_by UUID;
    ALTER TABLE public.wallet_expenses ADD COLUMN IF NOT EXISTS decided_by_name TEXT;
    ALTER TABLE public.wallet_expenses ADD COLUMN IF NOT EXISTS decision_note TEXT;
    ALTER TABLE public.wallet_expenses ADD COLUMN IF NOT EXISTS decided_at TIMESTAMPTZ;
    ALTER TABLE public.wallet_expenses ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
    UPDATE public.wallet_expenses
       SET requested_amount = COALESCE(requested_amount, amount),
           approved_amount = CASE WHEN status = 'APPROVED' THEN COALESCE(approved_amount, amount) ELSE approved_amount END,
           status = COALESCE(status, 'APPROVED'),
           updated_at = COALESCE(updated_at, created_at, now());
    ALTER TABLE public.wallet_expenses ALTER COLUMN requested_amount SET DEFAULT 0;
    ALTER TABLE public.wallet_expenses ALTER COLUMN requested_amount SET NOT NULL;
    ALTER TABLE public.wallet_expenses ALTER COLUMN status SET DEFAULT 'PENDING';
    ALTER TABLE public.wallet_expenses ALTER COLUMN status SET NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_wallet_expenses_company ON public.wallet_expenses(company_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_wallet_expenses_user ON public.wallet_expenses(user_id);
    NOTIFY pgrst, 'reload schema';
  `
  const { error } = await supabaseAdmin.rpc('exec_sql', { sql })
  if (!error) return true
  return runDirectSql(sql)
}

// ── SQL literal helpers (direct path) ────────────────────────────────────────
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

function rowToRecord(row: Record<string, unknown>): ExpenseRecord {
  return {
    id: String(row.id),
    user_id: String(row.user_id),
    user_name: row.user_name == null ? null : String(row.user_name),
    requester_role: row.requester_role ? String(row.requester_role) : 'UNKNOWN',
    bucket: (['cash', 'bank', 'coupon'].includes(String(row.bucket)) ? row.bucket : 'cash') as ExpenseBucket,
    requested_amount: Number(row.requested_amount ?? row.amount ?? 0),
    approved_amount: row.approved_amount == null ? (String(row.status || 'APPROVED') === 'APPROVED' ? Number(row.amount || 0) : null) : Number(row.approved_amount),
    amount: Number(row.amount || 0),
    category: row.category ? String(row.category) : 'Misc',
    note: row.note == null ? null : String(row.note),
    company_id: row.company_id == null ? null : String(row.company_id),
    created_by: row.created_by == null ? null : String(row.created_by),
    status: (['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'].includes(String(row.status)) ? row.status : 'APPROVED') as ExpenseStatus,
    decided_by: row.decided_by == null ? null : String(row.decided_by),
    decided_by_name: row.decided_by_name == null ? null : String(row.decided_by_name),
    decision_note: row.decision_note == null ? null : String(row.decision_note),
    decided_at: row.decided_at == null ? null : String(row.decided_at),
    created_at: String(row.created_at || new Date().toISOString()),
    updated_at: String(row.updated_at || row.created_at || new Date().toISOString()),
  }
}

// ── company_notes fallback ───────────────────────────────────────────────────
async function loadExpensesFromNotes(companyId: string | null): Promise<ExpenseRecord[]> {
  const { data: noteRows } = await supabaseAdmin
    .from('company_notes')
    .select('note')
    .like('note', `${EXPENSE_NOTE_PREFIX}%`)
    .limit(5000)
  const records: ExpenseRecord[] = []
  for (const row of (noteRows || []) as { note: string | null }[]) {
    const parsed = parseExpenseNote(row.note)
    if (!parsed) continue
    if (companyId && parsed.company_id && parsed.company_id !== companyId) continue
    records.push(parsed)
  }
  return records.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
}

/**
 * Load all expenses for a company from whichever store is available
 * (dedicated table preferred, company_notes fallback).
 */
export async function loadCompanyExpenses(companyId: string | null): Promise<ExpenseRecord[]> {
  let query = supabaseAdmin
    .from('wallet_expenses')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(5000)
  if (companyId) query = query.eq('company_id', companyId)

  const { data, error } = await query
  if (!error) return (data || []).map((r) => rowToRecord(r as Record<string, unknown>))
  if (!isMissingSchemaPiece(error)) throw error
  // On deployments where the table is genuinely absent, company_notes is the
  // primary compatibility ledger. Avoid a doomed PostgreSQL connection attempt
  // (notably IPv6-only Supabase hosts) on every queue refresh.
  if (isUnavailableTable(error)) return loadExpensesFromNotes(companyId)

  const where = companyId ? `WHERE company_id = ${sqlLiteral(companyId)}` : ''
  const rows = await queryDirectSql<Record<string, unknown>>(
    `SELECT * FROM public.wallet_expenses ${where} ORDER BY created_at DESC LIMIT 5000`,
  )
  if (rows) return rows.map(rowToRecord)

  return loadExpensesFromNotes(companyId)
}

// ── Create ───────────────────────────────────────────────────────────────────
export async function createExpense(input: {
  user_id: string
  user_name?: string | null
  requester_role: string
  bucket: ExpenseBucket
  amount: number
  category: string
  note?: string | null
  company_id?: string | null
  created_by?: string | null
  /** Present only for admin-created expenses, which are final immediately. */
  direct_approval?: {
    decided_by: string
    decided_by_name?: string | null
    decision_note?: string | null
  }
}): Promise<ExpenseRecord> {
  const now = new Date().toISOString()
  const isDirect = !!input.direct_approval
  const record: ExpenseRecord = {
    id: globalThis.crypto?.randomUUID?.() ?? cryptoFallbackUuid(),
    user_id: input.user_id,
    user_name: input.user_name ?? null,
    requester_role: input.requester_role,
    bucket: input.bucket,
    requested_amount: Number(input.amount),
    approved_amount: isDirect ? Number(input.amount) : null,
    amount: Number(input.amount),
    category: input.category || 'Misc',
    note: input.note ?? null,
    company_id: input.company_id ?? null,
    created_by: input.created_by ?? input.user_id,
    status: isDirect ? 'APPROVED' : 'PENDING',
    decided_by: input.direct_approval?.decided_by ?? null,
    decided_by_name: input.direct_approval?.decided_by_name ?? null,
    decision_note: input.direct_approval?.decision_note ?? null,
    decided_at: isDirect ? now : null,
    created_at: now,
    updated_at: now,
  }

  const insertRow = {
    id: record.id,
    user_id: record.user_id,
    user_name: record.user_name,
    requester_role: record.requester_role,
    bucket: record.bucket,
    amount: record.amount,
    requested_amount: record.requested_amount,
    approved_amount: record.approved_amount,
    category: record.category,
    note: record.note,
    company_id: record.company_id,
    created_by: record.created_by,
    status: record.status,
    decided_by: record.decided_by,
    decided_by_name: record.decided_by_name,
    decision_note: record.decision_note,
    decided_at: record.decided_at,
    updated_at: record.updated_at,
    created_at: record.created_at,
  }

  const first = await supabaseAdmin.from('wallet_expenses').insert(insertRow)
  if (!first.error) return record
  if (!isMissingSchemaPiece(first.error)) throw first.error

  if (isUnavailableTable(first.error)) {
    const { error: noteErr } = await supabaseAdmin.from('company_notes').insert({
      company_id: record.company_id,
      created_by: record.created_by,
      note: buildExpenseNote(record),
    })
    if (noteErr) throw noteErr
    return record
  }

  // Try to create the table, then retry once.
  const ready = await ensureExpensesSchema()
  if (ready) {
    const retry = await supabaseAdmin.from('wallet_expenses').insert(insertRow)
    if (!retry.error) return record
    if (!isMissingSchemaPiece(retry.error)) throw retry.error

    const sql = `
      INSERT INTO public.wallet_expenses
        (id, user_id, user_name, requester_role, bucket, amount, requested_amount, approved_amount, category, note, company_id, created_by, status, decided_by, decided_by_name, decision_note, decided_at, updated_at, created_at)
      VALUES (
        ${sqlNullableUuid(record.id)}, ${sqlNullableUuid(record.user_id)}, ${sqlNullableText(record.user_name)},
        ${sqlLiteral(record.requester_role)}, ${sqlLiteral(record.bucket)}, ${record.amount}, ${record.requested_amount}, ${record.approved_amount == null ? 'NULL' : record.approved_amount},
        ${sqlLiteral(record.category)}, ${sqlNullableText(record.note)}, ${sqlNullableUuid(record.company_id)},
        ${sqlNullableUuid(record.created_by)}, ${sqlLiteral(record.status)}, ${sqlNullableUuid(record.decided_by)},
        ${sqlNullableText(record.decided_by_name)}, ${sqlNullableText(record.decision_note)}, ${record.decided_at ? sqlLiteral(record.decided_at) : 'NULL'},
        ${sqlLiteral(record.updated_at)}, ${sqlLiteral(record.created_at)}
      );
    `
    if (await runDirectSql(sql)) return record
  }

  // Final fallback: persist as a company_notes row.
  const { error: noteErr } = await supabaseAdmin.from('company_notes').insert({
    company_id: record.company_id,
    created_by: record.created_by,
    note: buildExpenseNote(record),
  })
  if (noteErr) throw noteErr
  return record
}

export async function getExpenseById(id: string): Promise<ExpenseRecord | null> {
  const expenses = await loadCompanyExpenses(null)
  return expenses.find((expense) => expense.id === id) || null
}

/** Atomic pending-only transition; a second approver can never decide the same request. */
export async function decideExpense(input: {
  id: string
  status: Extract<ExpenseStatus, 'APPROVED' | 'REJECTED' | 'CANCELLED'>
  approved_amount: number | null
  decided_by: string | null
  decided_by_name: string | null
  decision_note: string | null
}): Promise<ExpenseRecord | null> {
  const current = await getExpenseById(input.id)
  if (!current || current.status !== 'PENDING') return null
  const now = new Date().toISOString()
  const update = {
    status: input.status,
    approved_amount: input.status === 'APPROVED' ? input.approved_amount : null,
    amount: input.status === 'APPROVED' ? (input.approved_amount ?? current.requested_amount) : current.requested_amount,
    decided_by: input.decided_by,
    decided_by_name: input.decided_by_name,
    decision_note: input.decision_note,
    decided_at: now,
    updated_at: now,
  }

  const { data, error } = await supabaseAdmin
    .from('wallet_expenses')
    .update(update)
    .eq('id', input.id)
    .eq('status', 'PENDING')
    .select('*')
    .maybeSingle()
  if (!error) return data ? rowToRecord(data as Record<string, unknown>) : null
  if (!isMissingSchemaPiece(error)) throw error

  if (isUnavailableTable(error)) {
    const { data: noteRows } = await supabaseAdmin
      .from('company_notes').select('id, note').like('note', `${EXPENSE_NOTE_PREFIX}%`).limit(5000)
    for (const row of (noteRows || []) as { id: string; note: string | null }[]) {
      const parsed = parseExpenseNote(row.note)
      if (!parsed || parsed.id !== input.id || parsed.status !== 'PENDING') continue
      const next: ExpenseRecord = { ...parsed, ...update }
      const { data: changed, error: noteError } = await supabaseAdmin.from('company_notes')
        .update({ note: buildExpenseNote(next) })
        .eq('id', row.id)
        .eq('note', row.note)
        .select('id')
      if (noteError) throw noteError
      return changed && changed.length > 0 ? next : null
    }
    return null
  }

  const rows = await queryDirectSql<Record<string, unknown>>(`
    UPDATE public.wallet_expenses
       SET status = ${sqlLiteral(update.status)},
           approved_amount = ${update.approved_amount == null ? 'NULL' : update.approved_amount},
           amount = ${update.amount},
           decided_by = ${sqlNullableUuid(update.decided_by)},
           decided_by_name = ${sqlNullableText(update.decided_by_name)},
           decision_note = ${sqlNullableText(update.decision_note)},
           decided_at = ${sqlLiteral(now)}, updated_at = ${sqlLiteral(now)}
     WHERE id = ${sqlNullableUuid(input.id)} AND status = 'PENDING'
     RETURNING *
  `)
  if (rows && rows[0]) return rowToRecord(rows[0])

  const { data: noteRows } = await supabaseAdmin
    .from('company_notes').select('id, note').like('note', `${EXPENSE_NOTE_PREFIX}%`).limit(5000)
  for (const row of (noteRows || []) as { id: string; note: string | null }[]) {
    const parsed = parseExpenseNote(row.note)
    if (!parsed || parsed.id !== input.id || parsed.status !== 'PENDING') continue
    const next: ExpenseRecord = { ...parsed, ...update }
    const { data: changed, error: noteError } = await supabaseAdmin.from('company_notes')
      .update({ note: buildExpenseNote(next) })
      .eq('id', row.id)
      .eq('note', row.note)
      .select('id')
    if (noteError) throw noteError
    return changed && changed.length > 0 ? next : null
  }
  return null
}

// ── Delete (reverses the wallet deduction) ───────────────────────────────────
export async function deleteExpense(id: string): Promise<boolean> {
  const { error, data } = await supabaseAdmin
    .from('wallet_expenses')
    .delete()
    .eq('id', id)
    .select('id')
  if (!error) return Array.isArray(data) && data.length > 0
  if (!isMissingSchemaPiece(error)) throw error

  // company_notes fallback: locate and remove the note carrying this expense.
  const { data: noteRows } = await supabaseAdmin
    .from('company_notes')
    .select('id, note')
    .like('note', `${EXPENSE_NOTE_PREFIX}%`)
    .limit(5000)
  for (const row of (noteRows || []) as { id: string; note: string | null }[]) {
    const parsed = parseExpenseNote(row.note)
    if (!parsed || parsed.id !== id) continue
    const { error: delErr } = await supabaseAdmin.from('company_notes').delete().eq('id', row.id)
    return !delErr
  }
  return false
}

function cryptoFallbackUuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}
