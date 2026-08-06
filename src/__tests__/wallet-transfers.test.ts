/**
 * Unit tests for the approval-based wallet-transfer ledger.
 *
 * Wallets in this app are DERIVED, not stored — a salesman's balance is the live
 * sum of payments they collected. A transfer therefore cannot mutate a balance;
 * it is a separate ledger the wallet views net against via the unified formula:
 *
 *   walletBucket += Σ incoming ACCEPTED − Σ outgoing (PENDING | ACCEPTED)
 *
 * These tests lock in: money conservation across the PENDING→ACCEPTED/REJECTED
 * lifecycle, strict bucket isolation, the sender/recipient flow rule, and
 * fail-closed behaviour when a user's identity cannot be resolved.
 */

import { describe, it, expect, vi } from 'vitest'

// wallet-transfers.ts imports these at module load; stub them so the pure
// functions under test can be imported without a live DB / env.
vi.mock('@/lib/supabase-server', () => ({ supabaseAdmin: {} }))
vi.mock('@/lib/direct-sql', () => ({ runDirectSql: vi.fn(), queryDirectSql: vi.fn() }))
vi.mock('@/lib/collector-ids', () => ({ resolveSelfAssignedPartyIds: vi.fn() }))

import {
  reduceTransferAdjustments,
  canSend,
  canTransfer,
  classifyBucket,
} from '@/lib/wallet-transfers'
import {
  buildWalletTransferNote,
  parseWalletTransferNote,
  type WalletTransferRecord,
} from '@/lib/wallet-transfers-fallback'

const SALESMAN = 'salesman-1'
const FINANCER = 'financer-1'
const ADMIN = 'admin-1'

function transfer(over: Partial<WalletTransferRecord>): WalletTransferRecord {
  return {
    id: over.id || 't-' + Math.random().toString(36).slice(2),
    from_user_id: over.from_user_id || SALESMAN,
    to_user_id: over.to_user_id || FINANCER,
    bucket: over.bucket || 'cash',
    amount: over.amount ?? 1000,
    status: over.status || 'PENDING',
    note: over.note ?? null,
    company_id: over.company_id ?? 'co-1',
    created_by: over.created_by ?? null,
    decided_by: over.decided_by ?? null,
    decided_at: over.decided_at ?? null,
    created_at: over.created_at || new Date().toISOString(),
  }
}

const identity = { [SALESMAN]: [SALESMAN], [FINANCER]: [FINANCER], [ADMIN]: [ADMIN] }

describe('reduceTransferAdjustments — conservation', () => {
  it('PENDING removes from the sender but does not yet credit the recipient', () => {
    const adj = reduceTransferAdjustments([transfer({ status: 'PENDING', amount: 1000, bucket: 'cash' })], identity)
    expect(adj[SALESMAN].cash).toBe(-1000) // held / left the wallet immediately
    expect(adj[FINANCER].cash).toBe(0) // not credited until accepted
    expect(adj[FINANCER].pendingIncoming).toBe(1)
    expect(adj[FINANCER].pendingIncomingAmount).toBe(1000)
  })

  it('ACCEPTED keeps it gone from sender and credits the recipient', () => {
    const adj = reduceTransferAdjustments([transfer({ status: 'ACCEPTED', amount: 1000, bucket: 'cash' })], identity)
    expect(adj[SALESMAN].cash).toBe(-1000)
    expect(adj[FINANCER].cash).toBe(1000)
    expect(adj[FINANCER].pendingIncoming).toBe(0)
  })

  it('REJECTED restores the sender — neither side is adjusted', () => {
    const adj = reduceTransferAdjustments([transfer({ status: 'REJECTED', amount: 1000 })], identity)
    expect(adj[SALESMAN].cash).toBe(0)
    expect(adj[FINANCER].cash).toBe(0)
  })

  it('CANCELLED restores the sender — neither side is adjusted', () => {
    const adj = reduceTransferAdjustments([transfer({ status: 'CANCELLED', amount: 1000 })], identity)
    expect(adj[SALESMAN].cash).toBe(0)
    expect(adj[FINANCER].cash).toBe(0)
  })

  it('total money is conserved across all parties for any pending/accepted set', () => {
    const transfers = [
      transfer({ from_user_id: SALESMAN, to_user_id: FINANCER, status: 'ACCEPTED', amount: 700, bucket: 'cash' }),
      transfer({ from_user_id: SALESMAN, to_user_id: ADMIN, status: 'PENDING', amount: 300, bucket: 'bank' }),
      transfer({ from_user_id: FINANCER, to_user_id: ADMIN, status: 'ACCEPTED', amount: 200, bucket: 'cash' }),
    ]
    const adj = reduceTransferAdjustments(transfers, identity)
    const net = (d: { cash: number; bank: number; coupon: number }) => d.cash + d.bank + d.coupon
    const totalMoved = net(adj[SALESMAN]) + net(adj[FINANCER]) + net(adj[ADMIN])
    // The 300 PENDING is "in limbo" (left salesman, not yet on admin) → −300 net.
    expect(totalMoved).toBe(-300)
  })
})

describe('reduceTransferAdjustments — bucket isolation', () => {
  it('a cash transfer never touches bank or coupon', () => {
    const adj = reduceTransferAdjustments([transfer({ status: 'ACCEPTED', amount: 500, bucket: 'cash' })], identity)
    expect(adj[SALESMAN]).toMatchObject({ cash: -500, bank: 0, coupon: 0 })
    expect(adj[FINANCER]).toMatchObject({ cash: 500, bank: 0, coupon: 0 })
  })

  it('keeps each bucket on its own track', () => {
    const adj = reduceTransferAdjustments(
      [
        transfer({ status: 'ACCEPTED', amount: 100, bucket: 'cash' }),
        transfer({ status: 'ACCEPTED', amount: 200, bucket: 'bank' }),
        transfer({ status: 'ACCEPTED', amount: 300, bucket: 'coupon' }),
      ],
      identity,
    )
    expect(adj[FINANCER]).toMatchObject({ cash: 100, bank: 200, coupon: 300 })
  })
})

describe('reduceTransferAdjustments — fail-closed identity', () => {
  it('a user with no resolvable identity ids gets a zero delta', () => {
    const adj = reduceTransferAdjustments(
      [transfer({ from_user_id: SALESMAN, to_user_id: FINANCER, status: 'ACCEPTED', amount: 1000 })],
      { [SALESMAN]: [], [FINANCER]: [] },
    )
    expect(adj[SALESMAN]).toMatchObject({ cash: 0, bank: 0, coupon: 0 })
    expect(adj[FINANCER]).toMatchObject({ cash: 0, bank: 0, coupon: 0 })
  })

  it('matches on any of a user\'s identity ids (email-divergent app_users id)', () => {
    const adj = reduceTransferAdjustments(
      [transfer({ from_user_id: 'alt-app-user-id', to_user_id: FINANCER, status: 'ACCEPTED', amount: 400 })],
      { [SALESMAN]: [SALESMAN, 'alt-app-user-id'], [FINANCER]: [FINANCER] },
    )
    expect(adj[SALESMAN].cash).toBe(-400)
    expect(adj[FINANCER].cash).toBe(400)
  })
})

describe('flow rule', () => {
  it('salesmen and financers may initiate; admins are terminal', () => {
    expect(canSend('SALESMAN')).toBe(true)
    expect(canSend('ACCOUNTS_MANAGER')).toBe(true)
    expect(canSend('ADMIN')).toBe(false)
    expect(canSend('SUPER_ADMIN')).toBe(false)
  })

  it('enforces salesman → {financer, admin} and financer → admin', () => {
    expect(canTransfer('SALESMAN', 'ACCOUNTS_MANAGER')).toBe(true)
    expect(canTransfer('SALESMAN', 'ADMIN')).toBe(true)
    expect(canTransfer('SALESMAN', 'SALESMAN')).toBe(false) // no peer transfers
    expect(canTransfer('ACCOUNTS_MANAGER', 'ADMIN')).toBe(true)
    expect(canTransfer('ACCOUNTS_MANAGER', 'SALESMAN')).toBe(false) // never flows back down
    expect(canTransfer('ADMIN', 'ADMIN')).toBe(false)
  })
})

describe('classifyBucket', () => {
  it('maps payment modes to the wallet buckets the salesman sees', () => {
    expect(classifyBucket('CASH')).toBe('cash')
    expect(classifyBucket('COUPON')).toBe('coupon')
    expect(classifyBucket('VOUCHER')).toBe('coupon')
    expect(classifyBucket('NEFT')).toBe('bank')
    expect(classifyBucket('UPI')).toBe('bank')
    expect(classifyBucket('')).toBe('bank') // unknown → bank, matching the board
  })
})

describe('company_notes fallback round-trip', () => {
  it('survives a build → parse cycle, preserving the lifecycle fields', () => {
    const rec = transfer({ status: 'ACCEPTED', amount: 1234.5, bucket: 'coupon', decided_by: ADMIN, decided_at: '2026-01-01T00:00:00Z' })
    const parsed = parseWalletTransferNote(buildWalletTransferNote(rec))
    expect(parsed).not.toBeNull()
    expect(parsed).toMatchObject({
      id: rec.id,
      from_user_id: rec.from_user_id,
      to_user_id: rec.to_user_id,
      bucket: 'coupon',
      amount: 1234.5,
      status: 'ACCEPTED',
      decided_by: ADMIN,
    })
  })

  it('rejects foreign / malformed notes', () => {
    expect(parseWalletTransferNote(null)).toBeNull()
    expect(parseWalletTransferNote('__wallet_adjust__:{"party_id":"x"}')).toBeNull()
    expect(parseWalletTransferNote('__wallet_transfer__:not-json')).toBeNull()
  })
})
