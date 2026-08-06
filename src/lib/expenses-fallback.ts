export const EXPENSE_NOTE_PREFIX = '__wallet_expense__:'

export type ExpenseBucket = 'cash' | 'bank' | 'coupon'
export type ExpenseStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED'

export const EXPENSE_APPROVAL_ROLES: Record<string, string[]> = {
  SALESMAN: ['ACCOUNTS_MANAGER', 'ADMIN'],
  ACCOUNTS_MANAGER: ['ADMIN'],
}

export function approverRolesForExpense(requesterRole: string): string[] {
  return EXPENSE_APPROVAL_ROLES[requesterRole] || []
}

export function canApproveExpense(requesterRole: string, approverRole: string): boolean {
  return approverRolesForExpense(requesterRole).includes(approverRole)
}

/** Admin spend is final immediately; every other wallet role requires approval. */
export function expenseRequiresApproval(requesterRole: string): boolean {
  return requesterRole !== 'ADMIN'
}

/** Preset categories surfaced in the UI; `category` is stored free-form so new ones never break parsing. */
export const EXPENSE_CATEGORIES = [
  'Travel',
  'Fuel',
  'Food',
  'Office',
  'Salary',
  'Rent',
  'Utilities',
  'Maintenance',
  'Marketing',
  'Misc',
] as const

export type ExpenseRecord = {
  id: string
  /** The user whose wallet the expense is paid from. */
  user_id: string
  /** Snapshot of the payer's name at creation time (board may not re-resolve it). */
  user_name: string | null
  /** Snapshot used to enforce who may approve without trusting the client. */
  requester_role: string
  bucket: ExpenseBucket
  /** Amount originally reserved from the requester's wallet. */
  requested_amount: number
  /** Final amount approved as an expense. Null until a decision is made. */
  approved_amount: number | null
  /** Effective amount kept for backwards compatibility with legacy rows. */
  amount: number
  category: string
  note: string | null
  company_id: string | null
  created_by: string | null
  status: ExpenseStatus
  decided_by: string | null
  decided_by_name: string | null
  decision_note: string | null
  decided_at: string | null
  created_at: string
  updated_at: string
}

const BUCKETS: ExpenseBucket[] = ['cash', 'bank', 'coupon']
const STATUSES: ExpenseStatus[] = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']

function normalizeBucket(value: unknown): ExpenseBucket {
  const b = String(value || '').toLowerCase()
  return (BUCKETS as string[]).includes(b) ? (b as ExpenseBucket) : 'cash'
}

/**
 * Encode one expense as a `company_notes` row body. Used on deployments where
 * the dedicated `wallet_expenses` table cannot be created (no DDL privilege),
 * mirroring the wallet-transfer + invoice-request fallbacks.
 */
export function buildExpenseNote(record: ExpenseRecord): string {
  return `${EXPENSE_NOTE_PREFIX}${JSON.stringify(record)}`
}

export function parseExpenseNote(raw: string | null | undefined): ExpenseRecord | null {
  if (!raw || !raw.startsWith(EXPENSE_NOTE_PREFIX)) return null
  try {
    const parsed = JSON.parse(raw.slice(EXPENSE_NOTE_PREFIX.length)) as Partial<ExpenseRecord>
    if (!parsed || typeof parsed !== 'object') return null
    if (!parsed.id || !parsed.user_id) return null
    const legacyAmount = Number(parsed.amount)
    const requestedAmount = Number(parsed.requested_amount ?? legacyAmount)
    const status = STATUSES.includes(parsed.status as ExpenseStatus)
      ? parsed.status as ExpenseStatus
      : 'APPROVED'
    const approvedAmount = parsed.approved_amount == null
      ? (status === 'APPROVED' ? legacyAmount : null)
      : Number(parsed.approved_amount)
    if (!Number.isFinite(requestedAmount) || (approvedAmount != null && !Number.isFinite(approvedAmount))) return null
    return {
      id: String(parsed.id),
      user_id: String(parsed.user_id),
      user_name: parsed.user_name == null ? null : String(parsed.user_name),
      requester_role: parsed.requester_role ? String(parsed.requester_role) : 'UNKNOWN',
      bucket: normalizeBucket(parsed.bucket),
      requested_amount: requestedAmount,
      approved_amount: approvedAmount,
      amount: status === 'APPROVED' ? (approvedAmount ?? requestedAmount) : requestedAmount,
      category: parsed.category ? String(parsed.category) : 'Misc',
      note: parsed.note == null ? null : String(parsed.note),
      company_id: parsed.company_id == null ? null : String(parsed.company_id),
      created_by: parsed.created_by == null ? null : String(parsed.created_by),
      status,
      decided_by: parsed.decided_by == null ? null : String(parsed.decided_by),
      decided_by_name: parsed.decided_by_name == null ? null : String(parsed.decided_by_name),
      decision_note: parsed.decision_note == null ? null : String(parsed.decision_note),
      decided_at: parsed.decided_at == null ? null : String(parsed.decided_at),
      created_at: String(parsed.created_at || new Date().toISOString()),
      updated_at: String(parsed.updated_at || parsed.created_at || new Date().toISOString()),
    }
  } catch {
    return null
  }
}
