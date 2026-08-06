import { supabaseAdmin } from "@/lib/supabase-server";
import { queryDirectSql } from "@/lib/direct-sql";
import { parseWalletAdjustNote, WALLET_ADJUST_NOTE_PREFIX } from "@/lib/wallet-adjust-fallback";
import {
  INVOICE_REQUEST_FALLBACK_PREFIX,
  parseInvoiceRequestNote,
} from "@/lib/invoice-requests-source";
import { fetchAllInChunks } from "@/lib/supabase-in-chunks";

/**
 * Derives the *current* wallet balance for a set of parties.
 *
 * The DB has no maintained `wallet_balance` column, so a party's balance must be
 * derived the same way the single-party ledger endpoint does:
 *
 *   currentBalance = opening_balance + Σ payments − Σ invoice deductions
 *
 * Invoice deductions come from BOTH the `invoices` table AND confirmed
 * `invoice_requests` (which live in the `company_notes` fallback on deployments
 * without the table and reference `orders.grand_total`). Deductions are
 * de-duplicated per party by invoice number so the two sources never double-count.
 *
 * Batched (a handful of queries total) so it scales to a full downline tree
 * instead of calling the per-party transactions endpoint N times.
 */
// Short-TTL single-flight cache. Computing balances pulls every payment,
// invoice, wallet adjustment and confirmed invoice-request for the party set —
// a heavy multi-table scan. Polling screens (20-30s) and several users hitting
// the same scoped lists meant this ran over and over on identical inputs. The
// cache (a) lets concurrent identical requests share one in-flight computation
// and (b) reuses the result for a few seconds. Balances therefore lag real
// writes by at most BALANCE_CACHE_TTL_MS, which is well within the polling
// cadence that consumes them.
const BALANCE_CACHE_TTL_MS = Number(process.env.BALANCE_CACHE_TTL_MS || 8_000);
const balanceCache = new Map<string, { expires: number; promise: Promise<Record<string, number>> }>();

export async function computeCurrentBalances(
  parties: { id: string; opening_balance?: number | string | null }[],
): Promise<Record<string, number>> {
  if (parties.length === 0) return {};

  // Key on the party set + their opening balances so an opening-balance edit
  // (rare, admin-driven) isn't masked by a stale cache entry.
  const key = parties
    .map((p) => `${p.id}:${Number(p.opening_balance ?? 0)}`)
    .sort()
    .join("|");

  const now = Date.now();
  const cached = balanceCache.get(key);
  if (cached && cached.expires > now) return cached.promise;

  const promise = computeCurrentBalancesUncached(parties).catch((err) => {
    // Never cache a rejection; let the next caller retry.
    balanceCache.delete(key);
    throw err;
  });
  balanceCache.set(key, { expires: now + BALANCE_CACHE_TTL_MS, promise });

  // Opportunistic sweep so the map can't grow without bound.
  if (balanceCache.size > 500) {
    for (const [k, v] of balanceCache) {
      if (v.expires <= now) balanceCache.delete(k);
    }
  }

  return promise;
}

async function computeCurrentBalancesUncached(
  parties: { id: string; opening_balance?: number | string | null }[],
): Promise<Record<string, number>> {
  const balances: Record<string, number> = {};
  for (const p of parties) balances[p.id] = Number(p.opening_balance ?? 0);

  const ids = parties.map((p) => p.id);
  if (ids.length === 0) return balances;
  const idSet = new Set(ids);

  // These four reads are independent of each other, so fire them concurrently
  // instead of awaiting one-at-a-time. The per-balance bookkeeping below stays
  // identical — only the I/O overlaps. (Payments/invoices/wallet_transactions
  // tables may be absent on some deployments; that is handled per-result.)
  // Chunked: large id sets overflow PostgREST's URL-encoded .in() filter.
  const [
    { data: payments },
    { data: invoices },
    confirmed,
    { data: manualTxns, error: manualErr },
  ] = await Promise.all([
    fetchAllInChunks<{ party_id: string; amount: number | string }>(
      ids,
      (chunk) =>
        supabaseAdmin.from("payments").select("party_id, amount").in("party_id", chunk),
    ),
    fetchAllInChunks<{
      billing_party_id: string;
      invoice_number: string | null;
      grand_total: number | string;
      is_cancelled?: boolean | null;
    }>(
      ids,
      (chunk) =>
        supabaseAdmin
          .from("invoices")
          .select("billing_party_id, invoice_number, grand_total, is_cancelled")
          .in("billing_party_id", chunk),
    ),
    // Confirmed invoice_requests (debits) → resolved to orders.grand_total below.
    loadConfirmedRequestsForParties(idSet),
    // Manual wallet adjustments (admin top-ups, deductions, party-edit wallet
    // changes). Folded in below; see the long note there.
    fetchAllInChunks<{ party_id: string; amount: number | string }>(
      ids,
      (chunk) =>
        supabaseAdmin
          .from("wallet_transactions")
          .select("party_id, amount")
          .in("party_id", chunk)
          .in("reference_type", ["TOPUP", "DEDUCT", "ADJUSTMENT"]),
    ),
  ]);

  for (const pay of (payments || []) as { party_id: string; amount: number | string }[]) {
    if (pay.party_id in balances) balances[pay.party_id] += Number(pay.amount || 0);
  }

  // Invoices table (debits). Track party:invoice_number so invoice_requests
  // referencing the same invoice are not counted twice.
  const countedRefs = new Set<string>();
  for (const inv of (invoices || []) as {
    billing_party_id: string;
    invoice_number: string | null;
    grand_total: number | string;
    is_cancelled?: boolean | null;
  }[]) {
    if (inv.is_cancelled) continue;
    if (inv.billing_party_id in balances) {
      balances[inv.billing_party_id] -= Number(inv.grand_total || 0);
    }
    if (inv.invoice_number) countedRefs.add(`${inv.billing_party_id}:${inv.invoice_number}`);
  }

  // Confirmed invoice_requests (debits) → orders.grand_total. `confirmed` was
  // loaded in the parallel batch above; only the dependent orders fetch remains.
  const orderIds = [...new Set(confirmed.map((c) => c.order_id).filter(Boolean))];
  const orderTotals: Record<string, number> = {};
  if (orderIds.length > 0) {
    const { data: orders } = await fetchAllInChunks<{ id: string; grand_total: number | string }>(
      orderIds,
      (chunk) => supabaseAdmin.from("orders").select("id, grand_total").in("id", chunk),
    );
    for (const o of (orders || []) as { id: string; grand_total: number | string }[]) {
      orderTotals[o.id] = Number(o.grand_total || 0);
    }
  }
  for (const req of confirmed) {
    const ref = `${req.party_id}:${req.invoice_number}`;
    if (countedRefs.has(ref)) continue; // already counted via invoices table
    const total = orderTotals[req.order_id] || 0;
    if (total <= 0) continue;
    if (req.party_id in balances) balances[req.party_id] -= total;
    countedRefs.add(ref);
  }

  // Manual wallet adjustments (admin top-ups, deductions, party-edit wallet
  // changes). These are NOT represented in the payments/invoices tables, so they
  // must be folded in here or they would never move the displayed balance. We
  // include ONLY reference_types that are exclusively manual adjustments —
  // PAYMENT/INVOICE/RECEIPT/OPENING_BALANCE rows are already accounted for above
  // (or in the opening base) and must be excluded to avoid double-counting.
  // The signed `amount` already encodes direction (top-up +, deduct/adjust −).
  let manualRows = [] as { party_id: string; amount: number | string }[]
  // Whether the wallet_transactions table is actually readable. The WALLET_ADJUST
  // company_notes are a *fallback* written by adjustWallet ONLY when the table is
  // absent — exactly mirroring the single-party ledger endpoint. When the table
  // exists, every manual adjustment is already a row here, so folding the notes in
  // too would double-count any adjustment (the cause of wrong list-card balances).
  // (manualTxns/manualErr were fetched in the parallel batch above.)
  let walletTableAvailable = true

  if (manualErr) {
    const message = `${manualErr.message || ''} ${(manualErr as { details?: string }).details || ''}`.toLowerCase()
    const isSchemaMiss =
      manualErr.code === '42P01' ||
      manualErr.code === 'PGRST200' ||
      manualErr.code === 'PGRST204' ||
      manualErr.code === 'PGRST205' ||
      message.includes('wallet_transactions') ||
      message.includes('schema cache') ||
      message.includes('could not find')

    if (isSchemaMiss) {
      const quotedIds = ids.map(id => `'${id.replace(/'/g, "''")}'`).join(', ')
      const directRows = await queryDirectSql<{ party_id: string; amount: number | string }>(`
        SELECT party_id, amount
        FROM public.wallet_transactions
        WHERE party_id IN (${quotedIds})
          AND reference_type IN ('TOPUP', 'DEDUCT', 'ADJUSTMENT')
      `)
      // null = table genuinely unavailable (relation missing / no direct DB) → use
      // the notes fallback. A (possibly empty) array means the table exists.
      if (directRows === null) walletTableAvailable = false
      else manualRows = directRows
    }
  } else {
    manualRows = (manualTxns || []) as { party_id: string; amount: number | string }[]
  }

  for (const txn of manualRows) {
    if (txn.party_id in balances) balances[txn.party_id] += Number(txn.amount || 0)
  }

  // Notes fallback only when the table could not be read — otherwise the rows
  // above already account for every manual adjustment.
  if (!walletTableAvailable) {
    const { data: noteRows } = await supabaseAdmin
      .from("company_notes")
      .select("note")
      .like("note", `${WALLET_ADJUST_NOTE_PREFIX}%`)
      .limit(5000)
    for (const row of (noteRows || []) as { note: string | null }[]) {
      const parsed = parseWalletAdjustNote(row.note)
      if (!parsed) continue
      if (!(parsed.party_id in balances)) continue
      balances[parsed.party_id] += Number(parsed.delta || 0)
    }
  }

  return balances;
}

type ConfirmedReq = { party_id: string; invoice_number: string; order_id: string };

/**
 * Batch-loads CONFIRMED invoice requests for many parties from the dedicated
 * table (if present) and the company_notes fallback, de-duplicated by
 * party + invoice_number (table wins).
 */
async function loadConfirmedRequestsForParties(idSet: Set<string>): Promise<ConfirmedReq[]> {
  const byKey = new Map<string, ConfirmedReq>();
  const ids = [...idSet];

  // 1. Dedicated table (tolerated if absent).
  const { data: tableRows, error: tableErr } = await fetchAllInChunks<Record<string, unknown>>(
    ids,
    (chunk) =>
      supabaseAdmin
        .from("invoice_requests")
        .select("party_id, invoice_number, order_id, status")
        .in("party_id", chunk)
        .eq("status", "CONFIRMED"),
  );
  if (!tableErr) {
    for (const r of (tableRows || []) as Record<string, unknown>[]) {
      const party_id = String(r.party_id || "");
      const invoice_number = String(r.invoice_number || "");
      const order_id = String(r.order_id || "");
      if (!party_id || !invoice_number) continue;
      byKey.set(`${party_id}:${invoice_number}`, { party_id, invoice_number, order_id });
    }
  }

  // 2. company_notes fallback (single scan).
  const { data: noteRows } = await supabaseAdmin
    .from("company_notes")
    .select("note")
    .like("note", `${INVOICE_REQUEST_FALLBACK_PREFIX}%`)
    .limit(2000);
  for (const row of (noteRows || []) as { note: string | null }[]) {
    const parsed = parseInvoiceRequestNote(row.note);
    if (!parsed) continue;
    if (String(parsed.status || "") !== "CONFIRMED") continue;
    const party_id = String(parsed.party_id || "");
    if (!idSet.has(party_id)) continue;
    const invoice_number = String(parsed.invoice_number || "");
    const order_id = String(parsed.order_id || "");
    if (!invoice_number) continue;
    const key = `${party_id}:${invoice_number}`;
    if (!byKey.has(key)) byKey.set(key, { party_id, invoice_number, order_id }); // table wins
  }

  return [...byKey.values()];
}
