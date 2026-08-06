/**
 * Unit tests for the internal-expense ledger.
 *
 * Wallets here are DERIVED, not stored. An expense therefore cannot mutate a
 * balance directly; it is a ledger the wallet views net against by subtracting
 * the spend from the paying user's bucket (mirrors outgoing wallet transfers).
 *
 * These tests lock in: per-bucket subtraction, identity-keyed matching,
 * fail-closed behaviour when a user's identity cannot be resolved, and
 * round-trip integrity of the company_notes fallback encoding.
 */

import { describe, it, expect, vi } from 'vitest'

// expenses.ts imports these at module load; stub them so the pure functions
// under test can be imported without a live DB / env.
vi.mock('@/lib/supabase-server', () => ({ supabaseAdmin: {} }))
vi.mock('@/lib/direct-sql', () => ({ runDirectSql: vi.fn(), queryDirectSql: vi.fn() }))

import { expenseWalletDebit, realizedExpenseAmount, reduceExpenseAdjustments } from '@/lib/expenses'
import { buildExpenseNote, canApproveExpense, expenseRequiresApproval, parseExpenseNote, type ExpenseRecord } from '@/lib/expenses-fallback'

const ADMIN = 'admin-1'
const SALESMAN = 'salesman-1'

function expense(over: Partial<ExpenseRecord>): ExpenseRecord {
  const record: ExpenseRecord = {
    id: crypto.randomUUID(),
    user_id: ADMIN,
    user_name: 'Admin',
    requester_role: 'ACCOUNTS_MANAGER',
    bucket: 'cash',
    amount: 100,
    requested_amount: 100,
    approved_amount: 100,
    category: 'Misc',
    note: null,
    company_id: null,
    created_by: ADMIN,
    status: 'APPROVED',
    decided_by: 'approver-1',
    decided_by_name: 'Approver',
    decision_note: null,
    decided_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...over,
  }
  if (over.amount !== undefined && over.requested_amount === undefined) record.requested_amount = over.amount
  if (record.status === 'APPROVED' && over.amount !== undefined && over.approved_amount === undefined) {
    record.approved_amount = over.amount
  }
  return record
}

describe('reduceExpenseAdjustments', () => {
  it('subtracts spend from the paying user, isolated by bucket', () => {
    const expenses = [
      expense({ user_id: ADMIN, bucket: 'cash', amount: 100 }),
      expense({ user_id: ADMIN, bucket: 'bank', amount: 250 }),
      expense({ user_id: ADMIN, bucket: 'cash', amount: 50 }),
    ]
    const out = reduceExpenseAdjustments(expenses, { [ADMIN]: [ADMIN] })
    expect(out[ADMIN]).toEqual({ cash: 150, bank: 250, coupon: 0, total: 400 })
  })

  it('charges only the matched identity, never other users', () => {
    const expenses = [expense({ user_id: ADMIN, amount: 100 })]
    const out = reduceExpenseAdjustments(expenses, { [ADMIN]: [ADMIN], [SALESMAN]: [SALESMAN] })
    expect(out[ADMIN].total).toBe(100)
    expect(out[SALESMAN].total).toBe(0)
  })

  it('matches across every id a user may appear under', () => {
    const alias = 'admin-alias'
    const expenses = [expense({ user_id: alias, amount: 70 })]
    const out = reduceExpenseAdjustments(expenses, { [ADMIN]: [ADMIN, alias] })
    expect(out[ADMIN].total).toBe(70)
  })

  it('is fail-closed: a user with no resolvable id gets a zero delta', () => {
    const expenses = [expense({ user_id: ADMIN, amount: 100 })]
    const out = reduceExpenseAdjustments(expenses, { [ADMIN]: [] })
    expect(out[ADMIN]).toEqual({ cash: 0, bank: 0, coupon: 0, total: 0 })
  })

  it('ignores non-positive amounts', () => {
    const expenses = [expense({ amount: 0 }), expense({ amount: -50 }), expense({ amount: 25 })]
    const out = reduceExpenseAdjustments(expenses, { [ADMIN]: [ADMIN] })
    expect(out[ADMIN].total).toBe(25)
  })

  it('reserves the requested amount while pending', () => {
    const pending = expense({ status: 'PENDING', requested_amount: 100, approved_amount: null, amount: 100 })
    expect(expenseWalletDebit(pending)).toBe(100)
    expect(realizedExpenseAmount(pending)).toBe(0)
  })

  it('keeps only the reduced approved amount and releases the difference', () => {
    const approved = expense({ status: 'APPROVED', requested_amount: 100, approved_amount: 80, amount: 80 })
    expect(expenseWalletDebit(approved)).toBe(80)
    expect(realizedExpenseAmount(approved)).toBe(80)
  })

  it('fully releases rejected and cancelled reservations', () => {
    expect(expenseWalletDebit(expense({ status: 'REJECTED', requested_amount: 100, approved_amount: null }))).toBe(0)
    expect(expenseWalletDebit(expense({ status: 'CANCELLED', requested_amount: 100, approved_amount: null }))).toBe(0)
  })
})

describe('company_notes fallback encoding', () => {
  it('round-trips an expense record', () => {
    const rec = expense({ amount: 1234.5, category: 'Travel', note: "O'Brien trip", bucket: 'bank' })
    const parsed = parseExpenseNote(buildExpenseNote(rec))
    expect(parsed).toEqual(rec)
  })

  it('rejects unrelated notes', () => {
    expect(parseExpenseNote('just a plain note')).toBeNull()
    expect(parseExpenseNote(null)).toBeNull()
  })

  it('defaults a missing bucket/category safely', () => {
    const parsed = parseExpenseNote(`__wallet_expense__:${JSON.stringify({ id: 'x', user_id: ADMIN, amount: 10 })}`)
    expect(parsed?.bucket).toBe('cash')
    expect(parsed?.category).toBe('Misc')
  })
})

describe('approval role matrix', () => {
  it('finalizes admin expenses immediately but requires approval for every other wallet role', () => {
    expect(expenseRequiresApproval('ADMIN')).toBe(false)
    expect(expenseRequiresApproval('ACCOUNTS_MANAGER')).toBe(true)
    expect(expenseRequiresApproval('SALESMAN')).toBe(true)
  })

  it('allows either an accounts manager or admin to approve a salesman request', () => {
    expect(canApproveExpense('SALESMAN', 'ACCOUNTS_MANAGER')).toBe(true)
    expect(canApproveExpense('SALESMAN', 'ADMIN')).toBe(true)
  })

  it('allows only an admin to approve an accounts-manager request', () => {
    expect(canApproveExpense('ACCOUNTS_MANAGER', 'ADMIN')).toBe(true)
    expect(canApproveExpense('ACCOUNTS_MANAGER', 'ACCOUNTS_MANAGER')).toBe(false)
    expect(canApproveExpense('ACCOUNTS_MANAGER', 'SALESMAN')).toBe(false)
  })
})
