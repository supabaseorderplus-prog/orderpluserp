import { NextRequest, NextResponse } from 'next/server'
import {
  supabaseAdmin,
  getUserFromToken,
  resolveCompanyScope,
  getPartyDescendants,
} from '@/lib/supabase-server'
import { resolveUserIdentityIds } from '@/lib/collector-ids'
import {
  TRANSFER_BUCKETS,
  TRANSFER_FLOW,
  canSend,
  canTransfer,
  classifyBucket,
  createTransfer,
  computeCollectedBuckets,
  getTransferById,
  loadCompanyTransfers,
  reduceTransferAdjustments,
  updateTransferStatus,
  type TransferBucket,
} from '@/lib/wallet-transfers'

const fmt = (n: number) =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(n)

type RoleRow = { id: string; name: string }
type ScopedUser = {
  id: string
  name: string | null
  email: string | null
  role_name: string
  party_id: string | null
}

function isSchemaCompatError(err: { code?: string; message?: string } | null | undefined) {
  return (
    !!err &&
    (err.code === 'PGRST200' ||
      err.code === 'PGRST204' ||
      err.code === 'PGRST205' ||
      err.code === '42703' ||
      err.code === '42P01' ||
      (err.message || '').includes('schema cache') ||
      (err.message || '').includes("Could not find the table 'public."))
  )
}

/**
 * Walk up the party hierarchy to the company root. A salesman's party_id is a
 * leaf; their financer/admin sit ABOVE them, so scoping by descendants-of-self
 * would never surface valid recipients. Mirrors the root walk in
 * /api/v1/payments (updatePartySchemeProgress).
 */
async function resolveCompanyRootPartyId(partyId: string | null): Promise<string | null> {
  if (!partyId) return null
  let current = partyId
  for (let i = 0; i < 8; i++) {
    const { data } = await supabaseAdmin
      .from('parties')
      .select('parent_party_id')
      .eq('id', current)
      .maybeSingle()
    if (!data?.parent_party_id) return current
    current = data.parent_party_id
  }
  return current
}

/** Party ids in the whole company tree rooted at `rootId` (self + descendants). */
async function resolveScopePartyIds(rootId: string | null): Promise<string[] | null> {
  if (!rootId) return null
  try {
    const tree = await getPartyDescendants(rootId)
    const ids = tree && tree.length > 0 ? tree.map((r: { id: string }) => r.id) : []
    if (!ids.includes(rootId)) ids.push(rootId)
    return ids
  } catch {
    return [rootId]
  }
}

/** Load active users in scope, optionally restricted to a set of role names. */
async function loadScopedUsers(
  scopePartyIds: string[] | null,
  roleNames?: string[],
): Promise<ScopedUser[]> {
  let roleIds: string[] = []
  const roleNameById: Record<string, string> = {}
  const { data: roleRows } = await supabaseAdmin.from('roles').select('id, name')
  for (const r of (roleRows || []) as RoleRow[]) roleNameById[r.id] = r.name
  if (roleNames && roleNames.length > 0) {
    roleIds = (roleRows || []).filter((r: RoleRow) => roleNames.includes(r.name)).map((r) => r.id)
  }

  const select = 'id,name,email,role_id,status,party_id,roles:role_id(name)'
  const selectBase = 'id,name,email,role_id,status,party_id'

  // NOTE: the company-tree filter is applied IN MEMORY below, not in the query.
  // Two reasons:
  //  1. A null `party_id` never matches PostgREST's `.in('party_id', […])`, so
  //     filtering in the query silently drops admins / financers / super-admins
  //     whose party_id is null by design (see Super Admin Null party_id). Those
  //     are exactly the recipients a salesman needs, and the POST handler already
  //     ACCEPTS a null-party_id recipient — the listing must match that rule.
  //  2. A company tree can hold 600+ party UUIDs; an `.in('party_id', […])` of
  //     that size overflows undici's 16KB request-header limit. Restricting by
  //     role keeps the unfiltered result small enough to scope in memory.
  async function run(table: 'users' | 'app_users', sel: string) {
    let q = supabaseAdmin.from(table).select(sel).eq('status', 'ACTIVE')
    if (roleIds.length > 0) q = q.in('role_id', roleIds)
    return q
  }

  let res = await run('users', select)
  if (res.error && isSchemaCompatError(res.error)) res = await run('users', selectBase)
  if (res.error && isSchemaCompatError(res.error)) res = await run('app_users', select)
  if (res.error && isSchemaCompatError(res.error)) res = await run('app_users', selectBase)
  if (res.error) return []

  const scopeSet = scopePartyIds && scopePartyIds.length > 0 ? new Set(scopePartyIds) : null

  return ((res.data || []) as unknown as Record<string, unknown>[])
    .map((u) => {
      const rel = u.roles as { name?: string } | { name?: string }[] | null | undefined
      const relName = Array.isArray(rel) ? rel[0]?.name : rel?.name
      const role_name = relName || roleNameById[String(u.role_id)] || 'UNKNOWN'
      return {
        id: String(u.id),
        name: (u.name as string) ?? null,
        email: (u.email as string) ?? null,
        role_name,
        party_id: (u.party_id as string) ?? null,
      }
    })
    // In scope when the user belongs to this company's party tree, OR has a null
    // party_id (company/platform admins not pinned to a party — accepted by POST).
    .filter((u) => !scopeSet || u.party_id === null || scopeSet.has(u.party_id))
}

async function findUserById(userId: string): Promise<ScopedUser | null> {
  const users = await loadScopedUsers(null)
  return users.find((u) => u.id === userId) || null
}

/**
 * Resolve display names for the stored from/to ids. These are app_users/users
 * row ids (the board's user_id) — NOT auth ids — so we look them up directly in
 * users + app_users (whichever the deployment has) rather than via the auth
 * admin API, which would 404 on an app_users id and leave the raw UUID showing.
 */
async function resolveNamesByIds(ids: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  const unique = [...new Set(ids.filter(Boolean))]
  if (unique.length === 0) return out
  for (const table of ['users', 'app_users'] as const) {
    const { data, error } = await supabaseAdmin.from(table).select('id, name, email').in('id', unique)
    if (error) continue
    for (const u of (data || []) as { id: string; name: string | null; email: string | null }[]) {
      if (!out[u.id]) out[u.id] = u.name || u.email || 'User'
    }
  }
  return out
}

/** Best-effort bell notification — never throws, never blocks the transfer. */
async function notifyUser(input: {
  userId: string
  companyId: string | null
  type: string
  title: string
  message: string
}) {
  try {
    const full = await supabaseAdmin.from('notifications').insert({
      user_id: input.userId,
      company_id: input.companyId,
      type: input.type,
      title: input.title,
      message: input.message,
      is_read: false,
    })
    if (!full.error) return
    await supabaseAdmin.from('notifications').insert({
      user_id: input.userId,
      company_id: input.companyId,
      type: input.type,
      message: input.message,
    })
  } catch {
    /* notifications table absent / different shape — badge still covers the alert */
  }
}

// ── POST: initiate a transfer ────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  try {
    const authUser = await getUserFromToken(req)
    if (!authUser) return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 })

    const companyId = await resolveCompanyScope(req, authUser)
    const body = await req.json()
    const to_user_id = String(body?.to_user_id || '')
    const bucket = String(body?.bucket || '').toLowerCase() as TransferBucket
    const amount = Number(body?.amount)
    const note = body?.note ? String(body.note) : null

    if (!canSend(authUser.role)) {
      return NextResponse.json({ success: false, message: 'Your role cannot initiate transfers' }, { status: 403 })
    }
    if (!to_user_id) return NextResponse.json({ success: false, message: 'to_user_id is required' }, { status: 400 })
    if (!TRANSFER_BUCKETS.includes(bucket)) {
      return NextResponse.json({ success: false, message: 'bucket must be cash, bank or coupon' }, { status: 400 })
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      return NextResponse.json({ success: false, message: 'amount must be a positive number' }, { status: 400 })
    }

    // Fail-closed identity: a sender we cannot identify can move no money.
    const fromUserId = authUser.app_user_id || authUser.id
    const senderIds = await resolveUserIdentityIds(fromUserId, authUser.email)
    if (senderIds.length === 0) {
      return NextResponse.json({ success: false, message: 'Could not resolve your wallet identity' }, { status: 403 })
    }
    if (senderIds.includes(to_user_id)) {
      return NextResponse.json({ success: false, message: 'Cannot transfer to yourself' }, { status: 400 })
    }

    // Validate recipient exists, is in the SAME company tree, and the flow rule allows it.
    const recipient = await findUserById(to_user_id)
    if (!recipient) {
      return NextResponse.json({ success: false, message: 'Recipient not found' }, { status: 404 })
    }
    const root = await resolveCompanyRootPartyId(authUser.party_id)
    const companyTree = await resolveScopePartyIds(root)
    if (companyTree && recipient.party_id && !companyTree.includes(recipient.party_id)) {
      return NextResponse.json({ success: false, message: 'Recipient is outside your company' }, { status: 403 })
    }
    if (!canTransfer(authUser.role, recipient.role_name)) {
      return NextResponse.json(
        { success: false, message: `A ${authUser.role} cannot transfer to a ${recipient.role_name}` },
        { status: 400 },
      )
    }

    // Available = collected base + (Σ accepted incoming − Σ pending/accepted outgoing).
    // Transfers are matched by identity (globally-unique from/to ids), not company_id —
    // a salesman's transfers carry a leaf company_id that differs from the admin's root.
    const [collected, transfers] = await Promise.all([
      computeCollectedBuckets(senderIds),
      loadCompanyTransfers(null),
    ])
    const delta = reduceTransferAdjustments(transfers, { self: senderIds }).self
    const available = collected[bucket] + delta[bucket]
    if (amount > available + 1e-6) {
      return NextResponse.json(
        { success: false, message: `Insufficient ${bucket} balance. Available ${fmt(available)}` },
        { status: 400 },
      )
    }

    const transfer = await createTransfer({
      from_user_id: fromUserId,
      to_user_id,
      bucket,
      amount,
      note,
      company_id: companyId,
    })

    await notifyUser({
      userId: to_user_id,
      companyId,
      type: 'WALLET_TRANSFER',
      title: 'Incoming wallet transfer',
      message: `${authUser.name || 'A user'} sent you ${fmt(amount)} (${bucket}) — pending your approval`,
    })

    return NextResponse.json({ success: true, data: transfer }, { status: 201 })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Transfer failed' },
      { status: 500 },
    )
  }
}

// ── GET: ?recipients=true  |  ?box=incoming|outgoing&status= ─────────────────
export async function GET(req: NextRequest) {
  try {
    const authUser = await getUserFromToken(req)
    if (!authUser) return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 })
    const companyId = await resolveCompanyScope(req, authUser)
    const url = new URL(req.url)

    if (url.searchParams.get('recipients') === 'true') {
      if (!canSend(authUser.role)) return NextResponse.json({ success: true, data: [] })
      const allowedRoles = TRANSFER_FLOW[authUser.role] || []
      const root = await resolveCompanyRootPartyId(authUser.party_id)
      const scopePartyIds = await resolveScopePartyIds(root)
      const users = await loadScopedUsers(scopePartyIds, allowedRoles)
      const selfId = authUser.app_user_id || authUser.id
      const data = users
        .filter((u) => u.id !== selfId && u.id !== authUser.id)
        .map((u) => ({ user_id: u.id, name: u.name, role_name: u.role_name }))
      return NextResponse.json({ success: true, data })
    }

    const box = url.searchParams.get('box') === 'incoming' ? 'incoming' : 'outgoing'
    const statusFilter = (url.searchParams.get('status') || '').toUpperCase()

    const selfId = authUser.app_user_id || authUser.id
    const myIds = new Set(await resolveUserIdentityIds(selfId, authUser.email))
    if (myIds.size === 0) {
      return NextResponse.json({ success: true, data: [], pendingIncoming: 0 })
    }

    const transfers = await loadCompanyTransfers(null)
    const mine = transfers.filter((t) =>
      box === 'incoming' ? myIds.has(t.to_user_id) : myIds.has(t.from_user_id),
    )
    const filtered = statusFilter ? mine.filter((t) => t.status === statusFilter) : mine

    // Enrich with the counterparty's display name.
    const counterpartyIds = [
      ...new Set(filtered.map((t) => (box === 'incoming' ? t.from_user_id : t.to_user_id))),
    ]
    const nameMap = await resolveNamesByIds(counterpartyIds)

    const data = filtered.map((t) => {
      const counterpartyId = box === 'incoming' ? t.from_user_id : t.to_user_id
      return { ...t, counterparty_name: nameMap[counterpartyId] ?? null }
    })

    const pendingIncoming = transfers.filter(
      (t) => myIds.has(t.to_user_id) && t.status === 'PENDING',
    ).length

    return NextResponse.json({ success: true, data, pendingIncoming })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed to fetch transfers' },
      { status: 500 },
    )
  }
}

// ── PATCH: { id, action: ACCEPT | REJECT | CANCEL } ──────────────────────────
export async function PATCH(req: NextRequest) {
  try {
    const authUser = await getUserFromToken(req)
    if (!authUser) return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 })
    const body = await req.json()
    const id = String(body?.id || '')
    const action = String(body?.action || '').toUpperCase()
    if (!id) return NextResponse.json({ success: false, message: 'id is required' }, { status: 400 })
    if (!['ACCEPT', 'REJECT', 'CANCEL'].includes(action)) {
      return NextResponse.json({ success: false, message: 'action must be ACCEPT, REJECT or CANCEL' }, { status: 400 })
    }

    const transfer = await getTransferById(id)
    if (!transfer) return NextResponse.json({ success: false, message: 'Transfer not found' }, { status: 404 })
    // Isolation guard is identity-based (caller must be the sender or recipient),
    // which is stronger than company_id — and avoids the leaf/root company_id
    // mismatch between a salesman sender and an admin recipient.
    if (transfer.status !== 'PENDING') {
      return NextResponse.json({ success: false, message: `Transfer already ${transfer.status.toLowerCase()}` }, { status: 400 })
    }

    const selfId = authUser.app_user_id || authUser.id
    const myIds = new Set(await resolveUserIdentityIds(selfId, authUser.email))
    if (myIds.size === 0) {
      return NextResponse.json({ success: false, message: 'Could not resolve your identity' }, { status: 403 })
    }

    if (action === 'CANCEL') {
      if (!myIds.has(transfer.from_user_id)) {
        return NextResponse.json({ success: false, message: 'Only the sender can cancel' }, { status: 403 })
      }
    } else if (!myIds.has(transfer.to_user_id)) {
      return NextResponse.json({ success: false, message: 'Only the recipient can decide this transfer' }, { status: 403 })
    }

    const nextStatus = action === 'ACCEPT' ? 'ACCEPTED' : action === 'REJECT' ? 'REJECTED' : 'CANCELLED'
    const ok = await updateTransferStatus(id, { status: nextStatus, decided_by: selfId })
    if (!ok) {
      return NextResponse.json({ success: false, message: 'Transfer could not be updated (already decided?)' }, { status: 409 })
    }

    // Best-effort: tell the other party what happened.
    const verb = action === 'ACCEPT' ? 'accepted' : action === 'REJECT' ? 'rejected' : 'cancelled'
    const otherParty = action === 'CANCEL' ? transfer.to_user_id : transfer.from_user_id
    await notifyUser({
      userId: otherParty,
      companyId: transfer.company_id,
      type: 'WALLET_TRANSFER',
      title: `Transfer ${verb}`,
      message: `${authUser.name || 'A user'} ${verb} a ${fmt(transfer.amount)} (${transfer.bucket}) transfer`,
    })

    return NextResponse.json({ success: true, data: { id, status: nextStatus } })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed to update transfer' },
      { status: 500 },
    )
  }
}
