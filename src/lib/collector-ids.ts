import { supabaseAdmin } from '@/lib/supabase-server'

interface CollectorAuth {
  id?: string | null
  app_user_id?: string | null
  email?: string | null
}

/**
 * Resolve EVERY id the caller's own payments may be stamped under in
 * `payments.created_by`, for per-collector wallet/list isolation.
 *
 * `payments.created_by` is set to `app_user_id || auth_id` at collection time,
 * but `app_user_id` is resolved by-id first and by-email as a fallback (see
 * fetchAppUser). A divergent/duplicate app_users row sharing the email, or an
 * unresolved profile (auth id stamped), means created_by can be ANY of: the
 * caller's app_users id, a different app_users id sharing the email, or the auth
 * id. Matching only [app_user_id, id] silently drops those collections — the
 * salesman's wallet then shows ₹0 even though the admin Wallets board (which DOES
 * reconcile by email) shows a real balance.
 *
 * This mirrors the collector-id reconciliation in /api/v1/wallets and
 * ranking-engine.ts so a salesman's own wallet stays consistent with the board.
 *
 * Fail-closed: returns the direct id set if the email lookup is unavailable;
 * never returns a broader scope than the caller's own identities.
 */
export async function resolveSelfCollectorIds(authUser: CollectorAuth | null): Promise<string[]> {
  if (!authUser) return []

  const ids = new Set<string>(
    [authUser.app_user_id, authUser.id].filter((id): id is string => Boolean(id)),
  )

  const email = authUser.email?.trim().toLowerCase()
  if (email) {
    const { data: rows } = await supabaseAdmin
      .from('app_users')
      .select('id')
      .eq('email', email)
    for (const r of (rows || []) as { id?: string | null }[]) {
      if (r.id) ids.add(r.id)
    }
  }

  return [...ids]
}

/**
 * Resolve EVERY id a wallet user may appear under in `payments.created_by` and
 * in `wallet_transfers.from_user_id`/`to_user_id`, given the user's primary id
 * and (optionally) email.
 *
 * This is the board-side counterpart to resolveSelfCollectorIds: the wallets
 * board iterates users by their `users`/`app_users` id, but a payment's or
 * transfer's stored id can be that id, a divergent app_users row sharing the
 * email, or an unresolved auth id. Matching only the primary id silently drops
 * those rows (e.g. a salesman's wallet reading ₹0, or an accepted transfer never
 * crediting the recipient). Mirrors the inline reconciliation in /api/v1/wallets.
 *
 * Fail-closed: returns at least the primary id; never broadens beyond ids that
 * resolve to the same user identity.
 */
export async function resolveUserIdentityIds(
  userId: string | null | undefined,
  email?: string | null,
): Promise<string[]> {
  const ids = new Set<string>()
  if (userId) ids.add(userId)
  if (!userId && !email) return []

  // app_users row sharing this primary id (compat when users.id !== app_users.id).
  if (userId) {
    const { data: byId } = await supabaseAdmin
      .from('app_users')
      .select('id')
      .eq('id', userId)
      .maybeSingle()
    if (byId?.id) ids.add(byId.id)
  }

  const normalizedEmail = email?.trim().toLowerCase()
  if (normalizedEmail) {
    const { data: rows } = await supabaseAdmin
      .from('app_users')
      .select('id')
      .eq('email', normalizedEmail)
    for (const r of (rows || []) as { id?: string | null }[]) {
      if (r.id) ids.add(r.id)
    }
  }

  return [...ids]
}

/**
 * Resolve the parties THIS collector is assigned to — used only for the legacy
 * attribution of payments that were inserted with a NULL `created_by` (older /
 * unauthenticated collection flows never stamped the collector). A NULL-created_by
 * payment is attributed to a salesman ONLY when the paying party is assigned to
 * them, so the money still lands in exactly one salesman's wallet (isolation holds
 * as long as the party has a single assigned salesman, which is the normal case).
 *
 * Mirrors the /api/v1/wallets board's legacy reconciliation so a salesman's own
 * wallet equals what the admin board attributes to them. Resolves via both the
 * party_salesman link table and the direct parties.salesman_id column; tolerates
 * either being absent (schema compat) by ignoring lookup errors.
 */
export async function resolveSelfAssignedPartyIds(collectorIds: string[]): Promise<string[]> {
  if (collectorIds.length === 0) return []
  const partyIds = new Set<string>()

  const linkRes = await supabaseAdmin
    .from('party_salesman')
    .select('party_id')
    .in('salesman_id', collectorIds)
  for (const l of (linkRes.data || []) as { party_id?: string | null }[]) {
    if (l.party_id) partyIds.add(l.party_id)
  }

  const directRes = await supabaseAdmin
    .from('parties')
    .select('id')
    .in('salesman_id', collectorIds)
  for (const p of (directRes.data || []) as { id?: string | null }[]) {
    if (p.id) partyIds.add(p.id)
  }

  return [...partyIds]
}
