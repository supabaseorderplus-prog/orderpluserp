import { NextRequest, NextResponse } from 'next/server'
import { getPartyDescendants, getUserFromToken, resolveCompanyScope, supabaseAdmin } from '@/lib/supabase-server'
import { resolveUserIdentityIds } from '@/lib/collector-ids'
import { computeCollectedBuckets, loadCompanyTransfers, reduceTransferAdjustments } from '@/lib/wallet-transfers'
import { approverRolesForExpense, canApproveExpense, expenseRequiresApproval } from '@/lib/expenses-fallback'
import {
  createExpense,
  decideExpense,
  getExpenseById,
  loadCompanyExpenses,
  realizedExpenseAmount,
  reduceExpenseAdjustments,
  type ExpenseBucket,
  type ExpenseRecord,
} from '@/lib/expenses'

const VALID_BUCKETS: ExpenseBucket[] = ['cash', 'bank', 'coupon']
const WALLET_EXPENSE_ROLES = ['SALESMAN', 'ACCOUNTS_MANAGER', 'ADMIN']

const fmt = (amount: number) => new Intl.NumberFormat('en-IN', {
  style: 'currency', currency: 'INR', maximumFractionDigits: 2,
}).format(amount)

async function resolveCompanyRoot(partyId: string | null): Promise<string | null> {
  if (!partyId) return null
  let current = partyId
  for (let depth = 0; depth < 10; depth += 1) {
    const { data } = await supabaseAdmin.from('parties')
      .select('parent_party_id').eq('id', current).maybeSingle()
    if (!data?.parent_party_id) return current
    current = data.parent_party_id
  }
  return current
}

async function companyContext(req: NextRequest, authUser: NonNullable<Awaited<ReturnType<typeof getUserFromToken>>>) {
  const scoped = await resolveCompanyScope(req, authUser)
  const root = authUser.role === 'SUPER_ADMIN'
    ? scoped
    : await resolveCompanyRoot(authUser.party_id || scoped)
  return root || scoped || null
}

type ScopedUser = { id: string; name: string | null; role_name: string; party_id: string | null }

async function loadCompanyUsers(companyId: string | null, roleNames: string[]): Promise<ScopedUser[]> {
  const { data: roles } = await supabaseAdmin.from('roles').select('id,name').in('name', roleNames)
  const roleById = Object.fromEntries((roles || []).map((role: { id: string; name: string }) => [role.id, role.name]))
  const roleIds = Object.keys(roleById)
  if (roleIds.length === 0) return []

  let partyIds: string[] | null = null
  if (companyId) {
    const tree = await getPartyDescendants(companyId).catch(() => [{ id: companyId }])
    partyIds = tree.map((party) => party.id)
    if (!partyIds.includes(companyId)) partyIds.push(companyId)
  }
  const partySet = partyIds ? new Set(partyIds) : null

  for (const table of ['users', 'app_users'] as const) {
    const { data, error } = await supabaseAdmin.from(table)
      .select('id,name,role_id,party_id,status').in('role_id', roleIds).eq('status', 'ACTIVE')
    if (error) continue
    return ((data || []) as Array<{ id: string; name: string | null; role_id: string; party_id: string | null }>)
      .map((user) => ({ ...user, role_name: roleById[user.role_id] || 'UNKNOWN' }))
      // Fail closed when company-scoped: approvers must belong to this party tree.
      // This prevents a null/unscoped finance user from receiving another
      // company's expense notification or seeing its approval workflow.
      .filter((user) => !partySet || (!!user.party_id && partySet.has(user.party_id)))
  }
  return []
}

async function notifyUser(input: { userId: string; companyId: string | null; title: string; message: string; referenceId?: string }) {
  try {
    const full = await supabaseAdmin.from('notifications').insert({
      user_id: input.userId,
      company_id: input.companyId,
      type: 'EXPENSE_APPROVAL',
      title: input.title,
      message: input.message,
      is_read: false,
    })
    if (!full.error) return
    const prismaShape = await supabaseAdmin.from('notifications').insert({
      user_id: input.userId,
      title: input.title,
      body: input.message,
      type: 'SYSTEM',
      reference_id: input.referenceId || null,
      reference_type: 'EXPENSE_APPROVAL',
      is_read: false,
    })
    if (!prismaShape.error) return
    await supabaseAdmin.from('notifications').insert({
      user_id: input.userId,
      type: 'SYSTEM',
      message: input.message,
    })
  } catch {
    // The queue remains authoritative even when a legacy deployment has no notifications table.
  }
}

function presentExpense(expense: ExpenseRecord, viewerRole: string, viewerIds: string[]) {
  const isMine = viewerIds.includes(expense.user_id)
  const approved = realizedExpenseAmount(expense)
  return {
    ...expense,
    amount: expense.status === 'APPROVED' ? approved : expense.requested_amount,
    is_mine: isMine,
    can_approve: expense.status === 'PENDING' && !isMine && canApproveExpense(expense.requester_role, viewerRole),
    can_cancel: expense.status === 'PENDING' && isMine,
    refund_amount: expense.status === 'REJECTED' || expense.status === 'CANCELLED'
      ? expense.requested_amount
      : expense.status === 'APPROVED'
        ? Math.max(0, expense.requested_amount - approved)
        : 0,
    awaiting_label: approverRolesForExpense(expense.requester_role)
      .map((role) => role === 'ACCOUNTS_MANAGER' ? 'Accounts Manager' : 'Admin')
      .join(' or '),
  }
}

/** Relevant request queue for the signed-in user, plus approver counters. */
export async function GET(req: NextRequest) {
  try {
    const authUser = await getUserFromToken(req)
    if (!authUser) return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 })
    const companyId = await companyContext(req, authUser)
    const actorId = authUser.app_user_id || authUser.id
    const viewerIds = await resolveUserIdentityIds(actorId, authUser.email)
    const all = await loadCompanyExpenses(companyId)
    const relevant = all.filter((expense) => {
      const mine = viewerIds.includes(expense.user_id)
      if (mine) return true
      // Platform super admins may audit every request in the selected company,
      // but remain read-only because they do not own a company wallet.
      if (authUser.role === 'SUPER_ADMIN') return true
      return canApproveExpense(expense.requester_role, authUser.role)
    })
    const data = relevant.map((expense) => presentExpense(expense, authUser.role, viewerIds))
    const pendingMine = data.filter((expense) => expense.is_mine && expense.status === 'PENDING')
    const pendingApproval = data.filter((expense) => expense.can_approve)

    return NextResponse.json({
      success: true,
      data,
      summary: {
        pendingMineCount: pendingMine.length,
        pendingMineAmount: pendingMine.reduce((sum, expense) => sum + expense.requested_amount, 0),
        pendingApprovalCount: pendingApproval.length,
        pendingApprovalAmount: pendingApproval.reduce((sum, expense) => sum + expense.requested_amount, 0),
        approvedTotal: data.reduce((sum, expense) => sum + realizedExpenseAmount(expense), 0),
        revertedTotal: data.reduce((sum, expense) => sum + expense.refund_amount, 0),
      },
    })
  } catch (error) {
    return NextResponse.json(
      { success: false, message: error instanceof Error ? error.message : 'Failed to load expense requests' },
      { status: 500 },
    )
  }
}

/** Record an admin expense immediately, or reserve non-admin funds for approval. */
export async function POST(req: NextRequest) {
  try {
    const authUser = await getUserFromToken(req)
    if (!authUser) return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 })
    if (!WALLET_EXPENSE_ROLES.includes(authUser.role)) {
      return NextResponse.json({ success: false, message: 'Your role does not have a wallet for expenses' }, { status: 403 })
    }

    const body = await req.json()
    const bucket = String(body.bucket || '').toLowerCase() as ExpenseBucket
    const amount = Number(body.amount)
    const category = String(body.category || 'Misc').trim() || 'Misc'
    const note = body.note ? String(body.note).trim().slice(0, 1000) : null
    if (!VALID_BUCKETS.includes(bucket)) {
      return NextResponse.json({ success: false, message: 'Choose cash, bank, or coupon' }, { status: 400 })
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      return NextResponse.json({ success: false, message: 'Enter a positive expense amount' }, { status: 400 })
    }

    const actorId = authUser.app_user_id || authUser.id
    const actorIds = await resolveUserIdentityIds(actorId, authUser.email)
    if (actorIds.length === 0) {
      return NextResponse.json({ success: false, message: 'Could not resolve your wallet identity' }, { status: 403 })
    }
    const [collected, transfers, expenses] = await Promise.all([
      computeCollectedBuckets(actorIds),
      loadCompanyTransfers(null),
      loadCompanyExpenses(null),
    ])
    const transferDelta = reduceTransferAdjustments(transfers, { self: actorIds }).self
    const expenseDebit = reduceExpenseAdjustments(expenses, { self: actorIds }).self
    const available = collected[bucket] + transferDelta[bucket] - expenseDebit[bucket]
    if (amount > available + 1e-6) {
      return NextResponse.json({
        success: false,
        message: `Insufficient ${bucket} balance. Available ${fmt(available)}`,
      }, { status: 400 })
    }

    const companyId = await companyContext(req, authUser)
    const requiresApproval = expenseRequiresApproval(authUser.role)
    const expense = await createExpense({
      user_id: actorId,
      user_name: authUser.name,
      requester_role: authUser.role,
      bucket,
      amount,
      category,
      note,
      company_id: companyId,
      created_by: actorId,
      direct_approval: requiresApproval ? undefined : {
        decided_by: actorId,
        decided_by_name: authUser.name,
        decision_note: 'Recorded directly by admin',
      },
    })

    if (requiresApproval) {
      const approvers = await loadCompanyUsers(companyId, approverRolesForExpense(authUser.role))
      await Promise.all(approvers
        .filter((approver) => !actorIds.includes(approver.id))
        .map((approver) => notifyUser({
          userId: approver.id,
          companyId,
          title: 'Expense approval required',
          message: `${authUser.name || 'A user'} requested ${fmt(amount)} from their ${bucket} wallet for ${category}`,
          referenceId: expense.id,
        })))
    }

    return NextResponse.json({
      success: true,
      data: presentExpense(expense, authUser.role, actorIds),
      message: requiresApproval ? 'Expense submitted for approval' : 'Expense recorded and deducted from the admin wallet',
    }, { status: 201 })
  } catch (error) {
    return NextResponse.json(
      { success: false, message: error instanceof Error ? error.message : 'Failed to request expense' },
      { status: 500 },
    )
  }
}

/** Approve (optionally reduced), reject, or cancel a pending request. */
export async function PATCH(req: NextRequest) {
  try {
    const authUser = await getUserFromToken(req)
    if (!authUser) return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 })
    const body = await req.json()
    const id = String(body.id || '')
    const action = String(body.action || '').toUpperCase()
    if (!id || !['APPROVE', 'REJECT', 'CANCEL'].includes(action)) {
      return NextResponse.json({ success: false, message: 'id and a valid action are required' }, { status: 400 })
    }
    const expense = await getExpenseById(id)
    if (!expense) return NextResponse.json({ success: false, message: 'Expense request not found' }, { status: 404 })
    if (expense.status !== 'PENDING') {
      return NextResponse.json({ success: false, message: `This request is already ${expense.status.toLowerCase()}` }, { status: 409 })
    }

    const companyId = await companyContext(req, authUser)
    if (companyId && expense.company_id && companyId !== expense.company_id) {
      return NextResponse.json({ success: false, message: 'Expense request is outside your company' }, { status: 403 })
    }
    const actorId = authUser.app_user_id || authUser.id
    const actorIds = await resolveUserIdentityIds(actorId, authUser.email)
    const isOwner = actorIds.includes(expense.user_id)
    if (action === 'CANCEL' && !isOwner) {
      return NextResponse.json({ success: false, message: 'Only the requester can cancel this request' }, { status: 403 })
    }
    if (action !== 'CANCEL' && (isOwner || !canApproveExpense(expense.requester_role, authUser.role))) {
      return NextResponse.json({ success: false, message: 'You are not an eligible approver for this request' }, { status: 403 })
    }

    const decisionNote = body.decision_note ? String(body.decision_note).trim().slice(0, 1000) : null
    if (action === 'REJECT' && !decisionNote) {
      return NextResponse.json({ success: false, message: 'Add a reason before rejecting the request' }, { status: 400 })
    }
    let approvedAmount: number | null = null
    if (action === 'APPROVE') {
      approvedAmount = Number(body.approved_amount ?? expense.requested_amount)
      if (!Number.isFinite(approvedAmount) || approvedAmount <= 0 || approvedAmount > expense.requested_amount + 1e-6) {
        return NextResponse.json({
          success: false,
          message: `Approved amount must be between ${fmt(0.01)} and ${fmt(expense.requested_amount)}`,
        }, { status: 400 })
      }
    }

    const nextStatus = action === 'APPROVE' ? 'APPROVED' : action === 'REJECT' ? 'REJECTED' : 'CANCELLED'
    const updated = await decideExpense({
      id,
      status: nextStatus,
      approved_amount: approvedAmount,
      decided_by: actorId,
      decided_by_name: authUser.name,
      decision_note: decisionNote,
    })
    if (!updated) {
      return NextResponse.json({ success: false, message: 'Another approver has already processed this request' }, { status: 409 })
    }

    const refund = updated.requested_amount - (updated.status === 'APPROVED' ? Number(updated.approved_amount || 0) : 0)
    const verb = updated.status === 'APPROVED' ? 'approved' : updated.status === 'REJECTED' ? 'rejected' : 'cancelled'
    await notifyUser({
      userId: updated.user_id,
      companyId: updated.company_id,
      title: `Expense ${verb}`,
      message: updated.status === 'APPROVED'
        ? `${authUser.name || 'An approver'} approved ${fmt(Number(updated.approved_amount || 0))}${refund > 0 ? ` and returned ${fmt(refund)} to your wallet` : ''}`
        : `${fmt(updated.requested_amount)} was returned to your wallet${decisionNote ? ` — ${decisionNote}` : ''}`,
      referenceId: updated.id,
    })

    return NextResponse.json({ success: true, data: presentExpense(updated, authUser.role, actorIds) })
  } catch (error) {
    return NextResponse.json(
      { success: false, message: error instanceof Error ? error.message : 'Failed to update expense request' },
      { status: 500 },
    )
  }
}

/** Financial audit records are never hard-deleted. */
export async function DELETE() {
  return NextResponse.json(
    { success: false, message: 'Expense requests cannot be deleted; cancel a pending request instead' },
    { status: 405 },
  )
}
