import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, getUserFromToken, resolveCompanyScope, getPartyDescendants, listAllAuthUsers } from '@/lib/supabase-server'
import { loadCompanyTransfers, reduceTransferAdjustments } from '@/lib/wallet-transfers'
import { loadCompanyExpenses, reduceExpenseAdjustments } from '@/lib/expenses'
import { fetchAllInChunks, fetchAllInChunksPaged } from '@/lib/supabase-in-chunks'
import { effectivePaymentMode } from '@/lib/payment-mode'

// Super Admins are platform custodians, not company money-holders — they never
// get a wallet. Only a company's own roles (salesman → accountant → admin) do.
const WALLET_ROLE_NAMES = ['SALESMAN', 'ACCOUNTS_MANAGER', 'ADMIN']

export async function GET(req: NextRequest) {
  try {
    const isSchemaCompatError = (err: { code?: string; message?: string } | null | undefined) =>
      !!err && (
        err.code === 'PGRST200' ||
        err.code === 'PGRST204' ||
        err.code === 'PGRST205' ||
        err.code === '42703' ||
        err.code === '42P01' ||
        (err.message || '').includes('schema cache') ||
        (err.message || '').includes("Could not find the table 'public.")
      )

    const authUser = await getUserFromToken(req)
    if (!authUser) {
      return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 })
    }
    const companyId = await resolveCompanyScope(req, authUser)
    const { data: walletRoles, error: walletRolesErr } = await supabaseAdmin
      .from('roles')
      .select('id, name')
      .in('name', WALLET_ROLE_NAMES)
    if (walletRolesErr && !isSchemaCompatError(walletRolesErr)) throw walletRolesErr
    const walletRoleIds = (walletRoles || []).map((r: { id: string }) => r.id)
    const roleNameById = Object.fromEntries((walletRoles || []).map((r: { id: string; name: string }) => [r.id, r.name])) as Record<string, string>

    // Determine which party/company to scope wallets to.
    // resolveCompanyScope returns the x-company-id header for SUPER_ADMIN (the company being viewed),
    // or the user's own party_id for ADMIN. We must use this as the filter — never the Super Admin's
    // own party_id — otherwise a Super Admin viewing another company sees their own company's users.
    let scopePartyId: string | null = companyId
    let scopePartyIds: string[] | null = scopePartyId ? [scopePartyId] : null

    // For non-super-admin users, fall back to their own party_id if companyId is null.
    // In fresh projects, party mapping can be incomplete; do not hard-return [] because
    // that makes the wallets page look broken even when users exist.
    if (!scopePartyId && authUser?.role !== 'SUPER_ADMIN') {
      scopePartyId = authUser?.party_id || null

      if (!scopePartyId && authUser?.app_user_id) {
        let userData: { party_id?: string | null } | null = null
        const u1 = await supabaseAdmin
          .from('users')
          .select('party_id')
          .eq('id', authUser.app_user_id)
          .single()
        if (!u1.error) userData = u1.data as { party_id?: string | null }
        else if (isSchemaCompatError(u1.error)) {
          const u2 = await supabaseAdmin
            .from('app_users')
            .select('party_id')
            .eq('id', authUser.app_user_id)
            .single()
          if (!u2.error) userData = u2.data as { party_id?: string | null }
        }
        scopePartyId = userData?.party_id || null
      }

      // If still unresolved, continue unscoped (compat mode) instead of returning empty.
      // This keeps wallets visible for setups where party_id is not populated yet.
    }

    // Expand scope to company hierarchy so users assigned to child parties are included.
    if (scopePartyId) {
      try {
        const ids = (await getPartyDescendants(scopePartyId)).map((r) => r.id)
        if (!ids.includes(scopePartyId)) ids.push(scopePartyId)
        scopePartyIds = ids
      } catch {
        scopePartyIds = [scopePartyId]
      }
    }

    // Fetch all users with wallet roles - ONLY from the scoped company
    let userTable: 'users' | 'app_users' = 'users'
    const selectWithRoles = `
      id,
      name,
      email,
      phone,
      role_id,
      status,
      party_id,
      created_at,
      updated_at,
      roles:role_id (name)
    `
    const selectBase = 'id,name,email,phone,role_id,status,party_id,created_at,updated_at'

    // Run the active wallet-users query for one (table, select) shape. The
    // party_id filter MUST be chunked: a company tree can hold hundreds of parties
    // (one real org has 600+), and a single .in('party_id', [600+ ids]) builds a
    // ~24KB request URL that overflows undici's 16KB header limit
    // (UND_ERR_HEADERS_OVERFLOW), throwing before it reaches Supabase and 500-ing
    // the whole board. Chunking keeps each request small and merges the disjoint
    // results (a user has exactly one party_id, so chunks never overlap).
    const fetchScopedUsers = async (
      table: 'users' | 'app_users',
      select: string,
      withRole: boolean,
    ): Promise<{ data: Record<string, any>[] | null; error: { code?: string; message?: string } | null }> => {
      const build = () => {
        let q = supabaseAdmin.from(table).select(select).eq('status', 'ACTIVE')
        if (withRole && walletRoleIds.length > 0) q = q.in('role_id', walletRoleIds)
        return q
      }
      if (scopePartyIds && scopePartyIds.length > 0) {
        return fetchAllInChunks<Record<string, any>>(scopePartyIds, (chunk) =>
          build().in('party_id', chunk),
        )
      }
      const { data, error } = await build()
      return { data, error }
    }

    // Primary: scoped users with their role relation.
    let { data: users, error: usersError } = await fetchScopedUsers(userTable, selectWithRoles, true)

    if (usersError && isSchemaCompatError(usersError)) {
      // Retry without the roles relation.
      const r1 = await fetchScopedUsers(userTable, selectBase, true)
      users = r1.data
      usersError = r1.error
    }

    if (usersError && isSchemaCompatError(usersError)) {
      // Fallback to the app_users table (with, then without, the roles relation).
      userTable = 'app_users'
      const r2 = await fetchScopedUsers(userTable, selectWithRoles, true)
      users = r2.data
      usersError = r2.error

      if (usersError && isSchemaCompatError(usersError)) {
        const r3 = await fetchScopedUsers(userTable, selectBase, true)
        users = r3.data
        usersError = r3.error
      }
    }

    if (usersError) {
      if (isSchemaCompatError(usersError)) return NextResponse.json({ success: true, data: [] })
      throw usersError
    }

    if (!users || users.length === 0) {
      // Compatibility fallback: if role lookup did not resolve, return all active scoped users.
      if (walletRoleIds.length === 0) {
        const allUsersRes = await fetchScopedUsers('app_users', selectBase, false)
        users = allUsersRes.data
      }
    }

    if (!users || users.length === 0) {
      return NextResponse.json({ success: true, data: [] })
    }

    const BANK_MODES = ['UPI', 'NEFT', 'CHEQUE', 'BANK', 'RTGS', 'IMPS']
    const CASH_MODES = ['CASH']
    const COUPON_MODES = ['COUPON', 'VOUCHER', 'TOKEN']
    const roleOf = (u: any): string =>
      roleNameById[u.role_id] ||
      (Array.isArray(u.roles) ? (u.roles[0]?.name || 'UNKNOWN') : (u.roles?.name || 'UNKNOWN'))
    const normEmail = (e?: string | null) => (e || '').trim().toLowerCase()

    // Kick off the transfer-ledger load NOW, in parallel with balance computation.
    // It's independent of the wallet balances and falls back to a ~1.5s notes scan
    // when the wallet_transfers table is absent — overlapping it instead of running
    // it after the balances keeps it off the critical path.
    const transfersPromise = loadCompanyTransfers(null).catch((e) => {
      console.warn('[wallets] transfer load failed:', e instanceof Error ? e.message : e)
      return [] as Awaited<ReturnType<typeof loadCompanyTransfers>>
    })

    // Internal expenses reduce the paying user's wallet, exactly like outgoing
    // transfers. Loaded UNSCOPED (like loadCompanyTransfers(null)) and netted by
    // globally-unique identity id, so the deduction shows on every viewer's board
    // — not just the company whose root happened to be stamped on the expense.
    const expensesPromise = loadCompanyExpenses(null).catch((e) => {
      console.warn('[wallets] expense load failed:', e instanceof Error ? e.message : e)
      return [] as Awaited<ReturnType<typeof loadCompanyExpenses>>
    })

    // ── Batch every per-salesman lookup up front ─────────────────────────────
    // Each salesman's wallet used to do its OWN collector-id reconciliation,
    // party-link and payment round-trips (~5-6 Supabase calls each). For a large
    // company that fan-out serialized through undici into a 10-20s request that
    // timed out into a 500. Resolve it all in a fixed handful of chunked batch
    // queries; the per-user map below then just sums in memory.
    // Every wallet role — salesman, financier/accountant AND admin — can record
    // collections stamped with their own id in payments.created_by. Compute the
    // cash/bank/coupon buckets for ALL of them (not just salesmen) so each wallet's
    // live balance on the board equals that user's own "My Wallet" view. Received
    // transfers and internal expenses still layer on top further below.
    const collectors = users as any[]
    const collectorUserIds = [...new Set(collectors.map((u) => u.id).filter(Boolean))] as string[]

    // collector ids per wallet user: own row id + EVERY app_users row sharing the
    // resolved (normalized) email + the Supabase AUTH id resolved by that email.
    // Both payments.created_by and wallet_transfers.from_user_id are stamped
    // `app_user_id || auth_id`, and the per-collector contract (locked by the
    // salesman-wallet-isolation test as [app_user_id, auth_id]) requires BOTH ids.
    // Omitting the auth id — or matching emails case-sensitively while the transfer
    // path below normalizes — makes the board UNDER-count a salesman's collections
    // while still fully subtracting their transfers/expenses, so the wallet reads
    // NEGATIVE (money you cannot have transferred without first collecting).
    // authIdByEmail is hoisted so the transfer/expense identity resolution nets
    // against the exact same id basis (parity with the salesman's My-Wallet view).
    const authIdByEmail: Record<string, string> = {}
    const collectorIdsByUser: Record<string, Set<string>> = {}
    for (const s of collectors) collectorIdsByUser[s.id] = new Set<string>([s.id])
    const partyIdsByUser: Record<string, string[]> = {}
    type WalletPayment = { amount: any; payment_mode: string; bank_name: string | null }
    const paymentsByCollector: Record<string, WalletPayment[]> = {}
    const legacyByParty: Record<string, WalletPayment[]> = {}

    if (collectorUserIds.length > 0) {
      try {
        // Phase 1 — resolve each user's email (users table, falling back to the
        // wallet row) plus the platform auth-id-by-email map.
        const usersEmailRes = await fetchAllInChunks<{ id: string; email: string | null }>(
          collectorUserIds, (chunk) => supabaseAdmin.from('users').select('id, email').in('id', chunk))
        const emailById: Record<string, string> = {}
        for (const r of usersEmailRes.data || []) if (r.email) emailById[r.id] = r.email

        try {
          const authUsers = await listAllAuthUsers()
          for (const au of authUsers) {
            const e = normEmail(au.email)
            if (e && au.id) authIdByEmail[e] = au.id
          }
        } catch (authErr) {
          // Auth admin unavailable (restricted key) → skip; the board still
          // reconciles by app_users id, it just can't recover auth-id-stamped rows.
          console.warn('[wallets] auth-id resolution skipped:',
            authErr instanceof Error ? authErr.message : authErr)
        }

        const resolvedEmailByUser: Record<string, string> = {}
        const emailSet = new Set<string>()
        for (const s of collectors) {
          const e = normEmail(emailById[s.id] || s.email)
          if (e) { resolvedEmailByUser[s.id] = e; emailSet.add(e) }
        }

        // Phase 2 — every app_users id sharing each resolved email; fold that plus
        // the email's auth id into each user's collector set (all normalized).
        const emails = [...emailSet]
        const idsByEmail: Record<string, string[]> = {}
        if (emails.length > 0) {
          const auByEmailRes = await fetchAllInChunks<{ id: string; email: string | null }>(
            emails, (chunk) => supabaseAdmin.from('app_users').select('id, email').in('email', chunk))
          for (const r of auByEmailRes.data || []) {
            const e = normEmail(r.email)
            if (e && r.id) (idsByEmail[e] ||= []).push(r.id)
          }
        }
        for (const s of collectors) {
          const e = resolvedEmailByUser[s.id]
          if (!e) continue
          for (const id of idsByEmail[e] || []) collectorIdsByUser[s.id].add(id)
          const authId = authIdByEmail[e]
          if (authId) collectorIdsByUser[s.id].add(authId)
        }

        // Reverse index: every collector id → EVERY owning board user, so a party
        // assigned to ANY of a salesman's ids (auth id / divergent app_users id
        // included) is attributed to that salesman — mirroring
        // resolveSelfAssignedPartyIds(collectorIds) in the My-Wallet view. The old
        // board queried party assignments by primary id ONLY, dropping legacy
        // NULL-created_by payments on parties assigned under a divergent id.
        //
        // This MUST be one-to-many. When two board cards share a collector id — a
        // duplicate/sibling user (the same person as two app_users rows, e.g.
        // "Manjur alam" / "MONJUR ALAM"), or two cards resolving to the same auth
        // id — a one-to-one `map[cid] = s.id` is LAST-WRITE-WINS: whichever card is
        // iterated last silently STEALS the shared salesman_id's parties from the
        // other. The robbed card then loses its legacy (NULL-created_by) collections
        // while its transfers are still fully subtracted, so its wallet reads a
        // PHANTOM NEGATIVE (e.g. −₹3,000) even though the running-ledger statement
        // (/api/v1/wallets/history) correctly re-derives ₹0. Attributing the party
        // to every legitimate owner keeps both cards equal to that statement.
        const userIdsByCollectorId: Record<string, string[]> = {}
        for (const s of collectors) {
          for (const cid of collectorIdsByUser[s.id]) (userIdsByCollectorId[cid] ||= []).push(s.id)
        }
        const allCollectorIds = [...new Set(Object.keys(userIdsByCollectorId))]

        // Phase 3 — party assignments (link table + direct parties.salesman_id
        // column) for the FULL collector-id union, plus primary collections.
        // These assignment lookups must be PAGED as well as ID-chunked. A large
        // company can have well over PostgREST's 1,000-row response cap across its
        // salesmen. The old unpaged queries silently dropped the tail of the party
        // assignments while transfer debits were still complete — exactly how a
        // ₹0 wallet appeared as -₹3,000 and a ₹14,207 wallet as -₹11,293.
        const [linkRes, directPartyRes] = await Promise.all([
          fetchAllInChunksPaged<{ salesman_id: string; party_id: string | null }>(allCollectorIds, (chunk, from, to) =>
            supabaseAdmin
              .from('party_salesman')
              .select('salesman_id, party_id')
              .in('salesman_id', chunk)
              .order('salesman_id', { ascending: true })
              .order('party_id', { ascending: true })
              .range(from, to)),
          // Schema-tolerant: ignored (via .error) if the parties.salesman_id column is absent.
          fetchAllInChunksPaged<{ id: string; salesman_id: string | null }>(allCollectorIds, (chunk, from, to) =>
            supabaseAdmin
              .from('parties')
              .select('id, salesman_id')
              .in('salesman_id', chunk)
              .order('id', { ascending: true })
              .range(from, to)),
        ])
        for (const l of linkRes.data || []) {
          if (!l.party_id) continue
          for (const owner of userIdsByCollectorId[l.salesman_id] || []) {
            (partyIdsByUser[owner] ||= []).push(l.party_id)
          }
        }
        if (!directPartyRes.error) {
          for (const p of directPartyRes.data || []) {
            if (!p.id || !p.salesman_id) continue
            for (const owner of userIdsByCollectorId[p.salesman_id] || []) {
              (partyIdsByUser[owner] ||= []).push(p.id)
            }
          }
        }

        // Primary payments for ALL collector ids in one chunked, PAGED sweep,
        // grouped by collector. Paging (order by unique id) keeps a company with
        // >1000 payments from silently capping collections at PostgREST's max-rows —
        // an under-count there also drives the NEGATIVE-wallet symptom above.
        if (allCollectorIds.length > 0) {
          const payRes = await fetchAllInChunksPaged<WalletPayment & { created_by: string | null }>(
            allCollectorIds, (chunk, from, to) =>
              supabaseAdmin.from('payments').select('amount, payment_mode, bank_name, created_by').in('created_by', chunk).order('id', { ascending: true }).range(from, to))
          if (payRes.error && !isSchemaCompatError(payRes.error)) throw payRes.error
          for (const p of payRes.data || []) {
            if (p.created_by) (paymentsByCollector[p.created_by] ||= []).push(p)
          }
        }

        // Legacy attribution (null created_by) for EVERY party assigned to any
        // salesman — fetched once for the union of those parties. UNIONed with the
        // primary created_by rows above (not an empty-fallback), so a salesman's
        // board figure stays equal to everything they collected even after their
        // first created_by-stamped collection lands.
        const legacyPartyIds = [...new Set(
          collectors
            .filter((s) => (partyIdsByUser[s.id] || []).length > 0)
            .flatMap((s) => partyIdsByUser[s.id]),
        )]
        if (legacyPartyIds.length > 0) {
          const fbRes = await fetchAllInChunksPaged<WalletPayment & { party_id: string | null }>(
            legacyPartyIds, (chunk, from, to) =>
              supabaseAdmin.from('payments').select('amount, payment_mode, bank_name, party_id').in('party_id', chunk).is('created_by', null).order('id', { ascending: true }).range(from, to))
          for (const p of fbRes.data || []) {
            if (p.party_id) (legacyByParty[p.party_id] ||= []).push(p)
          }
        }
      } catch (batchErr) {
        // Never 500 the board on a transient batch failure; salesmen fall back to 0
        // and self-correct on the next poll. Mirrors the transfer-netting guard.
        console.warn('[wallets] salesman batch precompute skipped:',
          batchErr instanceof Error ? batchErr.message : batchErr)
      }
    }

    const sumModes = (rows: WalletPayment[]) => {
      let cash = 0, bank = 0, coupon = 0
      for (const p of rows) {
        const amt = parseFloat(p.amount) || 0
        const mode = effectivePaymentMode(p.payment_mode, p.bank_name)
        if (CASH_MODES.includes(mode)) cash += amt
        else if (BANK_MODES.includes(mode)) bank += amt
        else if (COUPON_MODES.includes(mode)) coupon += amt
        else bank += amt
      }
      return { cash, bank, coupon }
    }

    // Synchronous map — all data is precomputed, so no per-user round-trips.
    const walletsWithBalances = (users as any[]).map((user) => {
      const roleName = roleOf(user)
      let cash_balance = 0
      let bank_balance = 0
      let coupon_balance = 0

      if (roleName === 'SALESMAN') {
        const collectorIds = [...(collectorIdsByUser[user.id] || new Set<string>([user.id]))]
        // UNION created_by-stamped collections with legacy NULL-created_by payments
        // on this salesman's assigned parties. They never overlap (primary requires
        // non-null created_by; legacy requires null), so concatenating sums every
        // collection. Previously legacy was used only when primary was empty, which
        // made earlier NULL-created_by collections disappear from the wallet the
        // moment a single stamped payment arrived.
        const primary = collectorIds.flatMap((id) => paymentsByCollector[id] || [])
        // Dedupe party ids: a party can be assigned via BOTH the party_salesman link
        // table and the parties.salesman_id column, which would otherwise count its
        // legacy payments twice.
        const assignedParties = [...new Set(partyIdsByUser[user.id] || [])]
        const legacy = assignedParties.flatMap((pid) => legacyByParty[pid] || [])
        const rows = [...primary, ...legacy]
        const summed = sumModes(rows)
        cash_balance = summed.cash
        bank_balance = summed.bank
        coupon_balance = summed.coupon
      }

      const balance = cash_balance + bank_balance + coupon_balance
      return {
        id: user.id,
        user_id: user.id,
        user_name: user.name,
        user_email: user.email,
        user_phone: user.phone,
        role_name: roleName,
        role_id: user.role_id,
        balance,
        cash_balance,
        bank_balance,
        coupon_balance,
        is_active: true,
        created_at: user.created_at,
        updated_at: user.updated_at,
      }
    })

    // ── Fold in approval-based wallet transfers (all roles) ──────────────────
    // Salesmen see HELD money removed (pending+accepted outgoing); financers and
    // admins see RECEIVED money added (accepted incoming). Transfers are matched
    // by user identity (globally-unique from/to ids) — never company_id, which a
    // salesman's transfer stores as a leaf that differs from the admin's root.
    try {
      // Batch identity resolution: one chunked app_users-by-id sweep + one
      // app_users-by-email sweep, instead of resolveUserIdentityIds() per user
      // (which was ~2 round-trips × every wallet on the board). Mirrors
      // resolveUserIdentityIds: own id + same-id row + every row sharing the email.
      const identityByUser: Record<string, string[]> = {}
      const idList = [...new Set(walletsWithBalances.map((w) => w.user_id).filter(Boolean))] as string[]
      const emailList = [...new Set(walletsWithBalances.map((w) => normEmail(w.user_email)).filter(Boolean))]
      const [idRowsRes, emailRowsRes] = await Promise.all([
        fetchAllInChunks<{ id: string }>(idList, (chunk) =>
          supabaseAdmin.from('app_users').select('id').in('id', chunk)),
        emailList.length
          ? fetchAllInChunks<{ id: string; email: string | null }>(emailList, (chunk) =>
              supabaseAdmin.from('app_users').select('id, email').in('email', chunk))
          : Promise.resolve({ data: [] as { id: string; email: string | null }[], error: null }),
      ])
      const auIdSet = new Set((idRowsRes.data || []).map((r) => r.id))
      const idsByEmail: Record<string, string[]> = {}
      for (const r of emailRowsRes.data || []) {
        if (r.email && r.id) (idsByEmail[normEmail(r.email)] ||= []).push(r.id)
      }
      for (const w of walletsWithBalances) {
        const ids = new Set<string>()
        if (w.user_id) {
          ids.add(w.user_id)
          if (auIdSet.has(w.user_id)) ids.add(w.user_id)
        }
        const e = normEmail(w.user_email)
        for (const id of idsByEmail[e] || []) ids.add(id)
        // Same auth-id basis as the collections resolution above, so a transfer or
        // expense stamped under the auth id nets against the collections that were
        // ALSO counted under it — keeping the two paths symmetric (no over/under).
        const authId = authIdByEmail[e]
        if (authId) ids.add(authId)
        identityByUser[w.user_id] = [...ids]
      }
      const transfers = await transfersPromise
      const adjustments = reduceTransferAdjustments(transfers, identityByUser)
      for (const w of walletsWithBalances) {
        const adj = adjustments[w.user_id]
        if (!adj) continue
        w.cash_balance += adj.cash
        w.bank_balance += adj.bank
        w.coupon_balance += adj.coupon
        w.balance = w.cash_balance + w.bank_balance + w.coupon_balance
        ;(w as Record<string, unknown>).pending_incoming = adj.pendingIncoming
      }

      // Expense requests reserve money immediately for every requester role.
      // Pending uses requested_amount, approved uses the final approved_amount,
      // and rejected/cancelled requests reserve nothing (automatic refund).
      const expenses = await expensesPromise
      const spend = reduceExpenseAdjustments(expenses, identityByUser)
      for (const w of walletsWithBalances) {
        const s = spend[w.user_id]
        if (!s) continue
        w.cash_balance -= s.cash
        w.bank_balance -= s.bank
        w.coupon_balance -= s.coupon
        w.balance = w.cash_balance + w.bank_balance + w.coupon_balance
        ;(w as Record<string, unknown>).total_spent = s.total
      }
    } catch (transferErr) {
      // Never break the board if the transfer ledger is unavailable.
      console.warn('[wallets] transfer netting skipped:', transferErr instanceof Error ? transferErr.message : transferErr)
    }

    return NextResponse.json({ success: true, data: walletsWithBalances })
  } catch (err) {
    console.error('Wallets API error:', err)
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed to fetch wallets' },
      { status: 500 }
    )
  }
}

// POST endpoint to manually update a user's wallet balance (optional, for future use)
export async function POST(req: NextRequest) {
  try {
    const authUser = await getUserFromToken(req)
    if (!authUser) {
      return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 })
    }
    const body = await req.json()

    const { user_id } = body
    if (!user_id) {
      return NextResponse.json({ success: false, message: 'user_id is required' }, { status: 400 })
    }

    // This is a placeholder for future wallet table implementation
    // For now, wallet balances are calculated on-the-fly
    return NextResponse.json(
      { success: false, message: 'Wallet balances are calculated automatically from payments' },
      { status: 400 }
    )
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed to update wallet' },
      { status: 500 }
    )
  }
}
