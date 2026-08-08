import { NextRequest, NextResponse } from "next/server";
import {
  supabaseAdmin,
  getUserFromToken,
  resolveCompanyScope,
  resolveUserDisplayMap,
} from "@/lib/supabase-server";
import { getScopedPartyIdsForUser } from "@/lib/party-scope";
import { fetchAllInChunks, fetchAllRows } from "@/lib/supabase-in-chunks";
import { queryDirectSql } from "@/lib/direct-sql";
import { WALLET_ADJUST_NOTE_PREFIX, parseWalletAdjustNote } from "@/lib/wallet-adjust-fallback";
import {
  INVOICE_REQUEST_FALLBACK_PREFIX,
  parseInvoiceRequestNote,
} from "@/lib/invoice-requests-source";

export const dynamic = "force-dynamic";

/**
 * Combined ledger across every scoped party — built from a handful of bulk,
 * READ-ONLY queries instead of calling the per-party `/transactions` endpoint
 * once per party.
 *
 * The old client loaded all parties and then fired one `/transactions` request
 * per party (1000+). That endpoint is write-capable (it backfills/repairs
 * wallet rows) and does multiple DB round-trips each, so firing it N times in
 * parallel exhausted the connection pool, serialized behind the browser's
 * 6-connection limit over US-latency links, and — since the client had no
 * per-request timeout — any single hung request left `Promise.allSettled`
 * pending forever, leaving the page stuck on "Loading combined ledger…".
 *
 * Rows are derived from the SAME sources as `computeCurrentBalances`
 * (opening balance + payments − invoices − confirmed invoice_requests + manual
 * wallet adjustments), so the combined view agrees with the wallet balances
 * shown on the parties list and wallets board. No repair writes happen here.
 */

interface CombinedRow {
  id: string;
  partyId: string;
  partyName: string;
  partyCode: string;
  partyType: string;
  date: string;
  createdAt: string;
  type: "INVOICE" | "PAYMENT" | "WALLET" | "TD" | "CD" | "SECURITY" | "OPENING";
  reference: string;
  description: string;
  debit: number;
  credit: number;
  balance: number | null;
  collected_by?: string;
}

type PartyMeta = {
  id: string;
  name: string;
  party_code: string | null;
  opening_balance: number | string | null;
  party_types: { name: string } | { name: string }[] | null;
};

function partyTypeName(meta: PartyMeta | undefined): string {
  const pt = meta?.party_types;
  if (!pt) return "N/A";
  if (Array.isArray(pt)) return pt[0]?.name || "N/A";
  return pt.name || "N/A";
}

async function resolveScopedPartyIds(req: NextRequest): Promise<string[] | null> {
  const authUser = await getUserFromToken(req);
  if (!authUser) return null;
  const companyId = await resolveCompanyScope(req, authUser);
  const scoped = await getScopedPartyIdsForUser(authUser, companyId);

  if (scoped !== null) return scoped;

  // Unscoped (super admin, no active company) → page every active party id.
  const { data } = await fetchAllRows<{ id: string }>((from, to) =>
    supabaseAdmin
      .from("parties")
      .select("id")
      .eq("status", "ACTIVE")
      .order("id")
      .range(from, to),
  );
  return (data || []).map((r) => r.id);
}

export async function GET(req: NextRequest) {
  try {
    const authUser = await getUserFromToken(req);
    if (!authUser) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }

    const scopedIds = await resolveScopedPartyIds(req);
    if (scopedIds === null || scopedIds.length === 0) {
      return NextResponse.json({ success: true, data: { transactions: [] } });
    }

    const requestedPartyId = req.nextUrl.searchParams.get("party_id")?.trim();
    if (requestedPartyId && !scopedIds.includes(requestedPartyId)) {
      return NextResponse.json(
        { success: false, message: "You do not have access to this party ledger" },
        { status: 403 },
      );
    }

    // A party-card ledger link must never return the combined company ledger.
    // Restrict at the API boundary as well as in the UI so the response itself
    // contains transactions for only the requested, authorised party.
    const ids = requestedPartyId ? [requestedPartyId] : scopedIds;
    const transactions = await getCachedLedger(ids);
    return NextResponse.json({ success: true, data: { transactions } });
  } catch (error: unknown) {
    console.error("Combined ledger API Error:", error);
    return NextResponse.json(
      { success: false, message: (error as Error).message || "Failed to load combined ledger" },
      { status: 500 },
    );
  }
}

// ---- Combined-ledger cache (stale-while-revalidate) -------------------------
// Computing the combined ledger scans payments/invoices/wallet/TD/CD/security
// for EVERY scoped party — heavy over US-latency links, and the dominant cost
// of opening the Ledger page. The result changes infrequently relative to how
// often the page is opened, so we memoise it per scope (same module-level TTL
// pattern as the auth/party-tree/balance caches). A fresh hit returns instantly;
// a stale hit returns the cached copy AND rebuilds in the background, so a
// repeat click never blocks on the DB.
const LEDGER_CACHE_TTL_MS = Number(process.env.LEDGER_CACHE_TTL_MS || 30_000);
const ledgerCache = new Map<string, { data: CombinedRow[]; expires: number }>();
const ledgerInFlight = new Map<string, Promise<CombinedRow[]>>();

function ledgerCacheKey(ids: string[]): string {
  // Order-independent signature: a scope is just a set of party ids.
  return `${ids.length}:${[...ids].sort().join(",")}`;
}

function buildLedgerSingleFlight(key: string, ids: string[]): Promise<CombinedRow[]> {
  const existing = ledgerInFlight.get(key);
  if (existing) return existing; // collapse concurrent cold/stale rebuilds into one
  const p = computeLedger(ids)
    .then((data) => {
      ledgerCache.set(key, { data, expires: Date.now() + LEDGER_CACHE_TTL_MS });
      return data;
    })
    .finally(() => { ledgerInFlight.delete(key); });
  ledgerInFlight.set(key, p);
  return p;
}

async function getCachedLedger(ids: string[]): Promise<CombinedRow[]> {
  const key = ledgerCacheKey(ids);
  const cached = ledgerCache.get(key);
  if (cached) {
    if (cached.expires <= Date.now()) {
      // Stale → refresh in the background, serve the cached copy now.
      void buildLedgerSingleFlight(key, ids).catch(() => {});
    }
    return cached.data;
  }
  // Cold cache → build synchronously (and cache for the next click).
  return buildLedgerSingleFlight(key, ids);
}

// Drop every cached scope. Called whenever a ledger source (e.g. a payment) is
// created or deleted so a mutation is never masked by a stale cached copy.
export function invalidateCombinedLedgerCache(): void {
  ledgerCache.clear();
}

async function computeLedger(ids: string[]): Promise<CombinedRow[]> {
    // Party metadata for row labelling + opening balances.
    const { data: partyRows } = await fetchAllInChunks<PartyMeta>(ids, (chunk) =>
      supabaseAdmin
        .from("parties")
        .select("id, name, party_code, opening_balance, party_types(name)")
        .in("id", chunk),
    );
    const partyMeta = new Map<string, PartyMeta>(
      (partyRows || []).map((p) => [p.id, p]),
    );
    const idSet = new Set(ids);

    // All source reads run concurrently — they are independent. Each one
    // tolerates its table being absent on a given deployment.
    const [
      { data: payments },
      { data: invoices },
      confirmed,
      { data: manualTxns, error: manualErr },
      { data: tdRows },
      { data: cdRows },
      { data: secRows },
    ] = await Promise.all([
      fetchAllInChunks<{
        id: string; party_id: string; payment_number: string | null;
        amount: number | string; payment_date: string | null;
        created_at: string | null; created_by: string | null; notes: string | null;
      }>(ids, (chunk) =>
        supabaseAdmin
          .from("payments")
          .select("id, party_id, payment_number, amount, payment_date, created_at, created_by, notes")
          .in("party_id", chunk),
      ),
      fetchAllInChunks<{
        id: string; billing_party_id: string; invoice_number: string | null;
        grand_total: number | string; created_at: string | null; is_cancelled: boolean | null;
      }>(ids, (chunk) =>
        supabaseAdmin
          .from("invoices")
          .select("id, billing_party_id, invoice_number, grand_total, created_at, is_cancelled")
          .in("billing_party_id", chunk),
      ),
      loadConfirmedRequestsForParties(idSet),
      fetchAllInChunks<{
        id: string; party_id: string; amount: number | string;
        reference_id: string | null; reference_type: string | null;
        description: string | null; created_at: string | null; created_by: string | null;
      }>(ids, (chunk) =>
        supabaseAdmin
          .from("wallet_transactions")
          .select("id, party_id, amount, reference_id, reference_type, description, created_at, created_by")
          .in("party_id", chunk)
          .in("reference_type", ["TOPUP", "DEDUCT", "ADJUSTMENT"]),
      ),
      fetchAllInChunks<Record<string, unknown>>(ids, (chunk) =>
        supabaseAdmin.from("td_ledger").select("*").in("party_id", chunk),
      ),
      fetchAllInChunks<Record<string, unknown>>(ids, (chunk) =>
        supabaseAdmin.from("cd_ledger").select("*").in("party_id", chunk),
      ),
      fetchAllInChunks<Record<string, unknown>>(ids, (chunk) =>
        supabaseAdmin.from("security_ledger").select("*").in("party_id", chunk),
      ),
    ]);

    // Resolve order grand_total for confirmed invoice_requests (debits).
    const orderIds = [...new Set(confirmed.map((c) => c.order_id).filter(Boolean))];
    const orderTotals = new Map<string, number>();
    if (orderIds.length > 0) {
      const { data: orders } = await fetchAllInChunks<{ id: string; grand_total: number | string }>(
        orderIds,
        (chunk) => supabaseAdmin.from("orders").select("id, grand_total").in("id", chunk),
      );
      for (const o of (orders || [])) orderTotals.set(o.id, Number(o.grand_total || 0));
    }

    // Build rows grouped by party.
    const rowsByParty = new Map<string, CombinedRow[]>();
    const pushRow = (row: CombinedRow) => {
      const list = rowsByParty.get(row.partyId);
      if (list) list.push(row);
      else rowsByParty.set(row.partyId, [row]);
    };
    const collectorIds = new Set<string>();

    const baseRow = (partyId: string): Omit<CombinedRow, "id" | "type" | "reference" | "description" | "debit" | "credit" | "balance" | "date" | "createdAt"> => {
      const meta = partyMeta.get(partyId);
      return {
        partyId,
        partyName: meta?.name || "Unknown",
        partyCode: meta?.party_code || "",
        partyType: partyTypeName(meta),
      };
    };

    // Opening balances.
    for (const id of ids) {
      const opening = Number(partyMeta.get(id)?.opening_balance ?? 0);
      if (opening === 0) continue;
      pushRow({
        ...baseRow(id),
        id: `${id}-opening`,
        date: "1970-01-01T00:00:00.000Z",
        createdAt: "1970-01-01T00:00:00.000Z",
        type: "OPENING",
        reference: partyMeta.get(id)?.party_code || "",
        description: "Opening balance",
        debit: opening < 0 ? Math.abs(opening) : 0,
        credit: opening > 0 ? opening : 0,
        balance: opening,
      });
    }

    // Payments (credits).
    for (const pay of payments || []) {
      if (!idSet.has(pay.party_id)) continue;
      const at = pay.created_at || pay.payment_date || new Date().toISOString();
      if (pay.created_by) collectorIds.add(pay.created_by);
      pushRow({
        ...baseRow(pay.party_id),
        id: String(pay.id),
        date: at,
        createdAt: at,
        type: "PAYMENT",
        reference: String(pay.payment_number || pay.id),
        // Prefer the note the user typed when recording the payment; fall back
        // to the auto text (which carries the payment/reference number) when blank.
        description: (pay.notes && String(pay.notes).trim())
          ? String(pay.notes).trim()
          : `Payment ${pay.payment_number || pay.id} received`,
        debit: 0,
        credit: Number(pay.amount || 0),
        balance: 0,
        ...(pay.created_by ? { collected_by: pay.created_by } : {}),
      });
    }

    // Invoices (debits). Track party:invoice_number so confirmed invoice_requests
    // referencing the same invoice are not double-counted.
    const countedRefs = new Set<string>();
    for (const inv of invoices || []) {
      if (inv.is_cancelled) continue;
      if (!idSet.has(inv.billing_party_id)) continue;
      const at = inv.created_at || new Date().toISOString();
      if (inv.invoice_number) countedRefs.add(`${inv.billing_party_id}:${inv.invoice_number}`);
      pushRow({
        ...baseRow(inv.billing_party_id),
        id: String(inv.id),
        date: at,
        createdAt: at,
        type: "INVOICE",
        reference: String(inv.invoice_number || inv.id),
        description: `Invoice ${inv.invoice_number || inv.id} generated`,
        debit: Number(inv.grand_total || 0),
        credit: 0,
        balance: 0,
      });
    }

    // Confirmed invoice_requests (debits) not already represented by an invoice row.
    for (const req of confirmed) {
      if (!idSet.has(req.party_id)) continue;
      const ref = `${req.party_id}:${req.invoice_number}`;
      if (countedRefs.has(ref)) continue;
      const total = orderTotals.get(req.order_id) || 0;
      if (total <= 0) continue;
      countedRefs.add(ref);
      const at = req.confirmed_at || new Date().toISOString();
      pushRow({
        ...baseRow(req.party_id),
        id: `req-${req.invoice_number}`,
        date: at,
        createdAt: at,
        type: "INVOICE",
        reference: req.invoice_number,
        description: `Invoice ${req.invoice_number} confirmed`,
        debit: total,
        credit: 0,
        balance: 0,
      });
    }

    // Manual wallet adjustments (top-ups / deductions / adjustments). These are
    // not in payments/invoices, so they would otherwise never appear. Read the
    // wallet_transactions table when available; fall back to the company_notes
    // marker only when the table cannot be read (mirrors computeCurrentBalances,
    // avoiding double-counting when the table exists).
    let walletTableAvailable = true;
    let manualRows = (manualTxns || []) as {
      id: string; party_id: string; amount: number | string;
      reference_id: string | null; reference_type: string | null;
      description: string | null; created_at: string | null; created_by: string | null;
    }[];

    if (manualErr) {
      const message = `${manualErr.message || ""} ${(manualErr as { details?: string }).details || ""}`.toLowerCase();
      const isSchemaMiss =
        manualErr.code === "42P01" ||
        manualErr.code === "PGRST200" ||
        manualErr.code === "PGRST204" ||
        manualErr.code === "PGRST205" ||
        message.includes("wallet_transactions") ||
        message.includes("schema cache") ||
        message.includes("could not find");
      if (isSchemaMiss) {
        const quotedIds = ids.map((id) => `'${id.replace(/'/g, "''")}'`).join(", ");
        const directRows = await queryDirectSql<{
          id: string; party_id: string; amount: number | string;
          reference_id: string | null; reference_type: string | null;
          description: string | null; created_at: string | null; created_by: string | null;
        }>(`
          SELECT id, party_id, amount, reference_id, reference_type, description, created_at, created_by
          FROM public.wallet_transactions
          WHERE party_id IN (${quotedIds})
            AND reference_type IN ('TOPUP', 'DEDUCT', 'ADJUSTMENT')
        `);
        if (directRows === null) walletTableAvailable = false;
        else manualRows = directRows;
      }
    }

    for (const txn of manualRows) {
      if (!idSet.has(txn.party_id)) continue;
      const amount = Number(txn.amount || 0);
      const at = txn.created_at || new Date().toISOString();
      if (txn.created_by) collectorIds.add(txn.created_by);
      pushRow({
        ...baseRow(txn.party_id),
        id: String(txn.id),
        date: at,
        createdAt: at,
        type: "WALLET",
        reference: String(txn.reference_id || ""),
        description: String(txn.description || (amount >= 0 ? "Wallet top-up" : "Wallet deduction")),
        debit: amount < 0 ? Math.abs(amount) : 0,
        credit: amount > 0 ? amount : 0,
        balance: 0,
      });
    }

    if (!walletTableAvailable) {
      const { data: noteRows } = await supabaseAdmin
        .from("company_notes")
        .select("id, note")
        .like("note", `${WALLET_ADJUST_NOTE_PREFIX}%`)
        .limit(5000);
      for (const row of (noteRows || []) as { id: string; note: string | null }[]) {
        const parsed = parseWalletAdjustNote(row.note);
        if (!parsed || !idSet.has(parsed.party_id)) continue;
        const amount = Number(parsed.delta || 0);
        const at = parsed.created_at || new Date().toISOString();
        if (parsed.created_by) collectorIds.add(parsed.created_by);
        pushRow({
          ...baseRow(parsed.party_id),
          id: String(row.id),
          date: at,
          createdAt: at,
          type: "WALLET",
          reference: "",
          description: parsed.description || (amount >= 0 ? "Wallet top-up" : "Wallet deduction"),
          debit: amount < 0 ? Math.abs(amount) : 0,
          credit: amount > 0 ? amount : 0,
          balance: 0,
        });
      }
    }

    // TD / CD / Security — tracked outside the wallet balance (balance = null).
    pushSubLedger(tdRows, "TD", "td_amount", idSet, partyMeta, pushRow, baseRow);
    pushSubLedger(cdRows, "CD", "cd_amount", idSet, partyMeta, pushRow, baseRow);

    for (const sec of secRows || []) {
      const partyId = String((sec as Record<string, unknown>).party_id || "");
      if (!idSet.has(partyId)) continue;
      const entryType = String((sec as Record<string, unknown>).entry_type || "");
      const isDeposit = ["DEPOSIT", "BONUS_DEPOSIT", "INTEREST_CREDIT"].includes(entryType);
      const amount = Number((sec as Record<string, unknown>).amount ?? 0);
      const at = String((sec as Record<string, unknown>).created_at || new Date().toISOString());
      pushRow({
        ...baseRow(partyId),
        id: String((sec as Record<string, unknown>).id || ""),
        date: at,
        createdAt: at,
        type: "SECURITY",
        reference: String((sec as Record<string, unknown>).reference_no || ""),
        description: `Security ${entryType}`,
        debit: isDeposit ? amount : 0,
        credit: isDeposit ? 0 : amount,
        balance: null,
      });
    }

    // Resolve collector display names.
    const collectorNames = collectorIds.size > 0
      ? await resolveUserDisplayMap([...collectorIds])
      : {};

    // Per party: sort chronologically and recompute a single coherent running
    // balance (opening + cumulative credit − debit). Rows with balance === null
    // (TD/CD/Security) are tracked outside the wallet and skipped.
    const merged: CombinedRow[] = [];
    for (const [partyId, rows] of rowsByParty) {
      rows.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
      let running = Number(partyMeta.get(partyId)?.opening_balance ?? 0);
      for (const row of rows) {
        if (row.collected_by && collectorNames[row.collected_by]) {
          row.collected_by = collectorNames[row.collected_by].name;
        } else if (row.collected_by) {
          delete row.collected_by;
        }
        if (row.balance === null) continue;
        if (row.type === "OPENING") {
          row.balance = running;
          continue;
        }
        running += row.credit - row.debit;
        row.balance = running;
      }
      merged.push(...rows);
    }

    // Newest first for the combined table.
    merged.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    return merged;
}

function pushSubLedger(
  rows: Record<string, unknown>[] | null,
  type: "TD" | "CD",
  amountKey: "td_amount" | "cd_amount",
  idSet: Set<string>,
  _partyMeta: Map<string, PartyMeta>,
  pushRow: (row: CombinedRow) => void,
  baseRow: (partyId: string) => Omit<CombinedRow, "id" | "type" | "reference" | "description" | "debit" | "credit" | "balance" | "date" | "createdAt">,
) {
  for (const entry of rows || []) {
    const partyId = String(entry.party_id || "");
    if (!idSet.has(partyId)) continue;
    const isCredit = entry.entry_type === "CREDIT";
    const amount = Number(entry[amountKey] ?? entry.amount ?? 0);
    const at = String(entry.created_at || new Date().toISOString());
    pushRow({
      ...baseRow(partyId),
      id: String(entry.id || ""),
      date: at,
      createdAt: at,
      type,
      reference: String(entry.reference_no || ""),
      description: `${type} ${entry.entry_type || ""}`,
      debit: isCredit ? 0 : amount,
      credit: isCredit ? amount : 0,
      balance: null,
    });
  }
}

type ConfirmedReq = {
  party_id: string;
  invoice_number: string;
  order_id: string;
  confirmed_at: string | null;
};

/**
 * Batch-loads CONFIRMED invoice requests for many parties from the dedicated
 * table (if present) and the company_notes fallback, de-duplicated by
 * party + invoice_number (table wins).
 */
async function loadConfirmedRequestsForParties(idSet: Set<string>): Promise<ConfirmedReq[]> {
  const byKey = new Map<string, ConfirmedReq>();
  const ids = [...idSet];

  const { data: tableRows, error: tableErr } = await fetchAllInChunks<Record<string, unknown>>(
    ids,
    (chunk) =>
      supabaseAdmin
        .from("invoice_requests")
        .select("party_id, invoice_number, order_id, confirmed_at, status")
        .in("party_id", chunk)
        .eq("status", "CONFIRMED"),
  );
  if (!tableErr) {
    for (const r of tableRows || []) {
      const party_id = String(r.party_id || "");
      const invoice_number = String(r.invoice_number || "");
      const order_id = String(r.order_id || "");
      if (!party_id || !invoice_number) continue;
      byKey.set(`${party_id}:${invoice_number}`, {
        party_id,
        invoice_number,
        order_id,
        confirmed_at: r.confirmed_at ? String(r.confirmed_at) : null,
      });
    }
  }

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
    if (!byKey.has(key)) {
      byKey.set(key, {
        party_id,
        invoice_number,
        order_id,
        confirmed_at: parsed.confirmed_at ? String(parsed.confirmed_at) : null,
      });
    }
  }

  return [...byKey.values()];
}
