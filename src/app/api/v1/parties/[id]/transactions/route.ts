import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, resolveUserDisplayMap } from "@/lib/supabase-server";
import { queryDirectSql, runDirectSql } from "@/lib/direct-sql";
import { loadConfirmedInvoiceRequests } from "@/lib/invoice-requests-source";
import { parseWalletAdjustNote, WALLET_ADJUST_NOTE_PREFIX } from "@/lib/wallet-adjust-fallback";

type DbError = { code?: string; message?: string; details?: string };

function isMissingSchemaPiece(error: DbError | null | undefined, column?: string) {
  if (!error) return false;
  const text = `${error.message || ""} ${error.details || ""}`.toLowerCase();
  return (
    error.code === "42P01" ||
    error.code === "42703" ||
    error.code === "PGRST200" ||
    error.code === "PGRST204" ||
    error.code === "PGRST205" ||
    text.includes("schema cache") ||
    text.includes("could not find") ||
    (column ? text.includes(column.toLowerCase()) : text.includes("column"))
  );
}

function sqlLiteral(value: string) {
  return `'${value.replace(/'/g, "''")}'`;
}

function sqlNullableText(value: unknown) {
  if (value === null || value === undefined || value === "") return "NULL";
  return sqlLiteral(String(value));
}

function sqlNullableUuid(value: unknown) {
  if (typeof value !== "string") return "NULL";
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? sqlLiteral(value)
    : "NULL";
}

function sqlNullableNumber(value: unknown) {
  if (value === null || value === undefined || value === "") return "NULL";
  const numeric = Number(value);
  return Number.isFinite(numeric) ? String(numeric) : "NULL";
}

async function loadWalletTransactionsDirect(partyId: string) {
  return queryDirectSql<Record<string, unknown>>(`
    SELECT *
    FROM public.wallet_transactions
    WHERE party_id = ${sqlLiteral(partyId)}
    ORDER BY created_at ASC
  `)
}

async function ensureWalletTransactionsSchema() {
  const sql = `
      CREATE TABLE IF NOT EXISTS public.wallet_transactions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        party_id UUID NOT NULL,
        type TEXT NOT NULL,
        amount FLOAT NOT NULL DEFAULT 0,
        balance_after FLOAT,
        reference_id TEXT,
        reference_type TEXT,
        description TEXT,
        created_by UUID,
        company_id UUID,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      ALTER TABLE public.wallet_transactions ADD COLUMN IF NOT EXISTS party_id UUID;
      ALTER TABLE public.wallet_transactions ADD COLUMN IF NOT EXISTS type TEXT;
      ALTER TABLE public.wallet_transactions ADD COLUMN IF NOT EXISTS amount FLOAT NOT NULL DEFAULT 0;
      ALTER TABLE public.wallet_transactions ADD COLUMN IF NOT EXISTS balance_after FLOAT;
      ALTER TABLE public.wallet_transactions ADD COLUMN IF NOT EXISTS reference_id TEXT;
      ALTER TABLE public.wallet_transactions ADD COLUMN IF NOT EXISTS reference_type TEXT;
      ALTER TABLE public.wallet_transactions ADD COLUMN IF NOT EXISTS description TEXT;
      ALTER TABLE public.wallet_transactions ADD COLUMN IF NOT EXISTS created_by UUID;
      ALTER TABLE public.wallet_transactions ADD COLUMN IF NOT EXISTS company_id UUID;
      ALTER TABLE public.wallet_transactions ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();
      CREATE INDEX IF NOT EXISTS idx_wallet_transactions_party_created ON public.wallet_transactions(party_id, created_at DESC);
      NOTIFY pgrst, 'reload schema';
    `;
  const { error } = await supabaseAdmin.rpc("exec_sql", { sql });
  if (!error) return true;
  return runDirectSql(sql);
}

/**
 * Auto-repairs missing wallet deductions for confirmed invoice_requests.
 * Runs on every transactions load — safe because it checks for existing debits first.
 */
async function repairMissingInvoiceRequestWalletRows(
  partyId: string,
  walletTxns: Record<string, unknown>[],
): Promise<Record<string, unknown>[]> {
  // Fetch all CONFIRMED invoice_requests for this party from BOTH the
  // invoice_requests table AND the company_notes fallback. Deployments without
  // the table store confirmed requests only in the fallback, so reading the
  // table alone makes confirmed invoices silently fail to deduct.
  const confirmedReqs = await loadConfirmedInvoiceRequests(partyId)
  if (confirmedReqs.length === 0) return walletTxns

  // Find which ones are missing a wallet debit
  const existingDebitRefs = new Set(
    walletTxns
      .filter((tx) => String(tx.type || '').includes('INVOICE'))
      .map((tx) => String(tx.reference_id ?? ''))
  )

  const missing = confirmedReqs
    .filter((r) => r.invoice_number && !existingDebitRefs.has(r.invoice_number))
    // Process oldest → newest so the running balance accumulates in chronological
    // order. loadConfirmedInvoiceRequests returns newest-first, which would otherwise
    // give the newest invoice the smallest cumulative balance and the oldest the full
    // total — a reversed ledger. Tie-break on invoice number (numeric) so multiple
    // invoices confirmed on the same day still sequence deterministically.
    .sort((a, b) => {
      const ta = new Date(a.confirmed_at || 0).getTime()
      const tb = new Date(b.confirmed_at || 0).getTime()
      if (ta !== tb) return ta - tb
      return String(a.invoice_number).localeCompare(String(b.invoice_number), undefined, { numeric: true })
    })

  if (missing.length === 0) return walletTxns

  // Fetch all relevant orders in one query
  const orderIds = [...new Set(missing.map((r) => r.order_id).filter(Boolean))]
  const { data: orders } = await supabaseAdmin
    .from('orders')
    .select('id, grand_total')
    .in('id', orderIds)

  const orderMap = new Map(
    ((orders || []) as { id: string; grand_total: number }[]).map((o) => [o.id, Number(o.grand_total || 0)])
  )

  // Compute running balance from existing txns
  const sortedExisting = [...walletTxns].sort(
    (a, b) => new Date(String(a.created_at ?? '')).getTime() - new Date(String(b.created_at ?? '')).getTime()
  )
  let runningBalance = sortedExisting.length > 0
    ? Number(sortedExisting[sortedExisting.length - 1].balance_after ?? 0)
    : 0

  const canPersist = await ensureWalletTransactionsSchema()
  const repairedRows: Record<string, unknown>[] = []

  for (const req of missing) {
    const grandTotal = orderMap.get(req.order_id) || 0
    if (grandTotal <= 0) continue

    runningBalance = runningBalance - grandTotal
    const row: Record<string, unknown> = {
      party_id: partyId,
      type: 'INVOICE_DEBIT',
      amount: -grandTotal,
      balance_after: runningBalance,
      reference_id: req.invoice_number,
      reference_type: 'INVOICE',
      description: `Invoice ${req.invoice_number} confirmed — ₹${grandTotal.toLocaleString('en-IN')} deducted`,
      company_id: req.company_id || null,
      created_at: req.confirmed_at || new Date().toISOString(),
    }

    // Always fix order status to DELIVERED for confirmed invoices
    if (req.order_id) {
      await supabaseAdmin
        .from('orders')
        .update({ status: 'DELIVERED' })
        .eq('id', req.order_id)
        .in('status', ['APPROVED', 'PROCUREMENT', 'IN_PROCUREMENT', 'DISPATCHED'])
    }

    if (canPersist) {
      const { data: inserted, error: insErr } = await supabaseAdmin
        .from('wallet_transactions')
        .insert(row)
        .select()
        .maybeSingle()

      if (!insErr && inserted) {
        repairedRows.push(inserted as Record<string, unknown>)
        existingDebitRefs.add(req.invoice_number)
        await supabaseAdmin.from('parties').update({ wallet_balance: runningBalance }).eq('id', partyId)
        continue
      }

      // Retry without company_id if column missing
      if (insErr && (insErr.code === '42703' || (insErr.message || '').includes('company_id'))) {
        delete row.company_id
        const { data: retryData } = await supabaseAdmin.from('wallet_transactions').insert(row).select().maybeSingle()
        if (retryData) {
          repairedRows.push(retryData as Record<string, unknown>)
          existingDebitRefs.add(req.invoice_number)
          await supabaseAdmin.from('parties').update({ wallet_balance: runningBalance }).eq('id', partyId)
          continue
        }
      }
    }

    repairedRows.push({ ...row, id: `repaired-req-${req.id}` })
    existingDebitRefs.add(req.invoice_number)
  }

  return [...walletTxns, ...repairedRows]
}

async function repairMissingInvoiceWalletRows(
  partyId: string,
  walletTxns: Record<string, unknown>[],
) {
  const { data: invoices, error: invoicesErr } = await supabaseAdmin
    .from("invoices")
    .select("id, invoice_number, grand_total, created_at, company_id, created_by")
    .eq("billing_party_id", partyId)
    .not("is_cancelled", "eq", true)
    .order("created_at", { ascending: true });

  if (invoicesErr) {
    console.warn("Invoice wallet repair skipped:", invoicesErr.message);
    return walletTxns;
  }

  const existingRefs = new Set(
    walletTxns.map((tx) => String(tx.reference_id ?? "")),
  );

  const missingInvoices = (invoices || []).filter((invoice) => {
    const invoiceNumber = String(invoice.invoice_number || invoice.id);
    return !existingRefs.has(invoiceNumber) &&
      ![...existingRefs].some((ref) => ref.includes(invoiceNumber));
  });

  if (missingInvoices.length === 0) return walletTxns;

  const sortedTxns = [...walletTxns].sort(
    (a, b) => new Date(String(a.created_at ?? "")).getTime() - new Date(String(b.created_at ?? "")).getTime(),
  );

  const canPersistWalletRows = await ensureWalletTransactionsSchema();
  const repairedRows: Record<string, unknown>[] = [];

  for (const invoice of missingInvoices) {
    const invoiceNumber = String(invoice.invoice_number || invoice.id);
    const invoiceDate = new Date(invoice.created_at || 0).getTime();
    const amount = Number(invoice.grand_total || 0);

    // Find the running wallet balance just before this invoice date
    let balanceBefore = 0;
    for (const tx of sortedTxns) {
      if (new Date(String(tx.created_at ?? "")).getTime() <= invoiceDate) {
        balanceBefore = Number(tx.balance_after ?? 0);
      } else {
        break;
      }
    }
    const balanceAfter = balanceBefore - amount;

    const row: Record<string, unknown> = {
      party_id: partyId,
      type: "INVOICE_DEBIT",
      amount: -amount,
      balance_after: balanceAfter,
      reference_id: invoiceNumber,
      reference_type: "INVOICE",
      description: `Invoice ${invoiceNumber} generated`,
      created_by: invoice.created_by || null,
      company_id: invoice.company_id || null,
      created_at: invoice.created_at || new Date().toISOString(),
    };

    if (canPersistWalletRows) {
      const insert = await supabaseAdmin.from("wallet_transactions").insert(row).select().maybeSingle();
      if (!insert.error && insert.data) {
        const inserted = insert.data as Record<string, unknown>;
        repairedRows.push(inserted);
        sortedTxns.push(inserted);
        sortedTxns.sort((a, b) => new Date(String(a.created_at ?? "")).getTime() - new Date(String(b.created_at ?? "")).getTime());
        existingRefs.add(invoiceNumber);
        continue;
      }

      const sql = `
          INSERT INTO public.wallet_transactions
            (party_id, type, amount, balance_after, reference_id, reference_type, description, created_by, company_id, created_at)
          VALUES
            (
              ${sqlNullableUuid(row.party_id)},
              ${sqlNullableText(row.type)},
              ${sqlNullableNumber(row.amount)},
              ${sqlNullableNumber(row.balance_after)},
              ${sqlNullableText(row.reference_id)},
              ${sqlNullableText(row.reference_type)},
              ${sqlNullableText(row.description)},
              ${sqlNullableUuid(row.created_by)},
              ${sqlNullableUuid(row.company_id)},
              COALESCE(${sqlNullableText(row.created_at)}::timestamptz, now())
            );
        `;
      const { error: sqlErr } = await supabaseAdmin.rpc("exec_sql", { sql });
      if (sqlErr && !(await runDirectSql(sql)) && !isMissingSchemaPiece(sqlErr)) {
        console.warn("Invoice wallet repair insert skipped:", sqlErr.message);
        continue;
      }
    }

    const syntheticRow = { ...row, id: `repaired-inv-${invoice.id}` };
    repairedRows.push(syntheticRow);
    sortedTxns.push(syntheticRow);
    sortedTxns.sort((a, b) => new Date(String(a.created_at ?? "")).getTime() - new Date(String(b.created_at ?? "")).getTime());
    existingRefs.add(invoiceNumber);
  }

  return [...walletTxns, ...repairedRows];
}

async function repairMissingPaymentWalletRows(
  partyId: string,
  walletTxns: Record<string, unknown>[],
) {
  const { data: payments, error: paymentsErr } = await supabaseAdmin
    .from("payments")
    .select("id, payment_number, amount, payment_date, created_at, company_id, created_by")
    .eq("party_id", partyId)
    .order("payment_date", { ascending: true })
    .order("created_at", { ascending: true });

  if (paymentsErr) {
    console.warn("Payment wallet repair skipped:", paymentsErr.message);
    return walletTxns;
  }

  const existingRefs = new Set(
    walletTxns.flatMap((tx) => [
      String(tx.reference_id ?? ""),
      String(tx.description ?? ""),
    ]),
  );
  const sortedTxns = [...walletTxns].sort(
    (a, b) => new Date(String(a.created_at ?? "")).getTime() - new Date(String(b.created_at ?? "")).getTime(),
  );
  let runningWalletBalance = sortedTxns.length > 0
    ? Number(sortedTxns[sortedTxns.length - 1].balance_after ?? 0)
    : 0;

  const repairedRows: Record<string, unknown>[] = [];
  const canPersistWalletRows = await ensureWalletTransactionsSchema();

  for (const payment of payments || []) {
    const paymentNumber = String(payment.payment_number || payment.id);
    const alreadyPresent = existingRefs.has(paymentNumber) || [...existingRefs].some((ref) => ref.includes(paymentNumber));
    if (alreadyPresent) continue;

    const amount = Number(payment.amount || 0);
    runningWalletBalance += amount;
    const row: Record<string, unknown> = {
      party_id: partyId,
      type: "PAYMENT_CREDIT",
      amount,
      balance_after: runningWalletBalance,
      reference_id: paymentNumber,
      reference_type: "PAYMENT",
      description: `Payment ${paymentNumber} received`,
      created_by: payment.created_by || null,
      company_id: payment.company_id || null,
      created_at: payment.created_at || payment.payment_date || new Date().toISOString(),
    };

    if (canPersistWalletRows) {
      const insert = await supabaseAdmin.from("wallet_transactions").insert(row).select().maybeSingle();
      if (!insert.error && insert.data) {
        repairedRows.push(insert.data as Record<string, unknown>);
        existingRefs.add(paymentNumber);
        continue;
      }

      const sql = `
          INSERT INTO public.wallet_transactions
            (party_id, type, amount, balance_after, reference_id, reference_type, description, created_by, company_id, created_at)
          VALUES
            (
              ${sqlNullableUuid(row.party_id)},
              ${sqlNullableText(row.type)},
              ${sqlNullableNumber(row.amount)},
              ${sqlNullableNumber(row.balance_after)},
              ${sqlNullableText(row.reference_id)},
              ${sqlNullableText(row.reference_type)},
              ${sqlNullableText(row.description)},
              ${sqlNullableUuid(row.created_by)},
              ${sqlNullableUuid(row.company_id)},
              COALESCE(${sqlNullableText(row.created_at)}::timestamptz, now())
            );
        `;
      const { error: sqlErr } = await supabaseAdmin.rpc("exec_sql", { sql });

      if (sqlErr && !(await runDirectSql(sql)) && !isMissingSchemaPiece(sqlErr)) {
        console.warn("Payment wallet repair insert skipped:", sqlErr.message);
        continue;
      }
    }

    repairedRows.push({ ...row, id: `repaired-${payment.id}` });
    existingRefs.add(paymentNumber);
  }

  if (repairedRows.length > 0 && canPersistWalletRows) {
    const balanceUpdate = await supabaseAdmin
      .from("parties")
      .update({ wallet_balance: runningWalletBalance })
      .eq("id", partyId)
    if (balanceUpdate.error && isMissingSchemaPiece(balanceUpdate.error, "wallet_balance")) {
      const sql = `
          ALTER TABLE public.parties ADD COLUMN IF NOT EXISTS wallet_balance FLOAT NOT NULL DEFAULT 0;
          UPDATE public.parties
          SET wallet_balance = ${sqlNullableNumber(runningWalletBalance)}
          WHERE id = ${sqlLiteral(partyId)};
          NOTIFY pgrst, 'reload schema';
        `;
      await supabaseAdmin.rpc("exec_sql", { sql }).then(async ({ error }) => {
        if (error && !(await runDirectSql(sql))) {
          console.warn("Payment wallet repair balance SQL update skipped:", error.message);
        }
      });
    } else if (balanceUpdate.error) {
      console.warn("Payment wallet repair balance update skipped:", balanceUpdate.error.message);
    }
  }

  return [...walletTxns, ...repairedRows];
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: partyId } = await params;

    if (!partyId) {
      return NextResponse.json(
        { success: false, message: "Party ID is required" },
        { status: 400 }
      );
    }

    // Fetch party for opening_balance (wallet_balance may lag; we derive it from transactions)
    let { data: party, error: partyErr } = await supabaseAdmin
      .from("parties")
      .select("wallet_balance, opening_balance")
      .eq("id", partyId)
      .single();

    if (partyErr && isMissingSchemaPiece(partyErr, "wallet_balance")) {
      const retry = await supabaseAdmin
        .from("parties")
        .select("opening_balance")
        .eq("id", partyId)
        .single();
      party = retry.data ? { ...retry.data, wallet_balance: 0 } : null;
      partyErr = retry.error;
    }

    if (partyErr) console.error("parties fetch error:", partyErr);

    const openingBalance = Number(party?.opening_balance ?? 0);

    // Primary source: wallet_transactions (written atomically with every invoice/payment)
    const { data: fetchedWalletTxns, error: wtErr } = await supabaseAdmin
      .from("wallet_transactions")
      .select("*")
      .eq("party_id", partyId)
      .order("created_at", { ascending: true });

    if (wtErr) console.error("wallet_transactions fetch error:", wtErr);
    let baseWalletTxns = (fetchedWalletTxns || []) as Record<string, unknown>[];
    if (wtErr && isMissingSchemaPiece(wtErr)) {
      const directRows = await loadWalletTransactionsDirect(partyId)
      baseWalletTxns = (directRows || []) as Record<string, unknown>[]

      if (baseWalletTxns.length === 0) {
        const { data: noteRows } = await supabaseAdmin
          .from("company_notes")
          .select("id, created_at, created_by, company_id, note")
          .like("note", `${WALLET_ADJUST_NOTE_PREFIX}%`)
          .limit(5000)
        baseWalletTxns = (noteRows || [])
          .map((row) => {
            const parsed = parseWalletAdjustNote(row.note)
            if (!parsed || parsed.party_id !== partyId) return null
            return {
              id: row.id,
              party_id: parsed.party_id,
              type: parsed.type,
              amount: parsed.delta,
              balance_after: parsed.balance_after,
              reference_id: null,
              reference_type: parsed.reference_type,
              description: parsed.description,
              created_by: parsed.created_by ?? row.created_by,
              company_id: parsed.company_id ?? row.company_id,
              created_at: parsed.created_at || row.created_at,
            }
          })
          .filter(Boolean) as Record<string, unknown>[]
      }
    }
    const afterPaymentRepair = await repairMissingPaymentWalletRows(partyId, baseWalletTxns);
    const afterInvoiceRepair = await repairMissingInvoiceWalletRows(partyId, afterPaymentRepair);
    const walletTxns = await repairMissingInvoiceRequestWalletRows(partyId, afterInvoiceRepair);

    // Synthesize an opening balance row if one was set but never logged as a transaction.
    // This makes the opening balance visible as the first entry in the statement.
    if (openingBalance > 0) {
      const hasOpeningRow = walletTxns.some(tx => {
        const t = tx as Record<string, unknown>
        return t.reference_type === 'OPENING_BALANCE' || t.type === 'OPENING_BALANCE'
      })
      if (!hasOpeningRow) {
        // Use the earliest existing transaction date minus 1 second, or now if no transactions.
        const firstTxDate = walletTxns.length > 0
          ? new Date(new Date(String((walletTxns[0] as Record<string, unknown>).created_at ?? '')).getTime() - 1000).toISOString()
          : new Date().toISOString()
        walletTxns.unshift({
          id: `opening-${partyId}`,
          party_id: partyId,
          type: 'OPENING_BALANCE',
          amount: openingBalance,
          balance_after: 0,
          reference_id: 'OPENING_BALANCE',
          reference_type: 'OPENING_BALANCE',
          description: `Opening balance`,
          created_at: firstTxDate,
        })
      }
    }

    // TD entries
    let tdEntries: Record<string, unknown>[] = [];
    try {
      const { data, error } = await supabaseAdmin
        .from("td_ledger")
        .select("*")
        .eq("party_id", partyId)
        .order("created_at", { ascending: true });
      if (error) throw error;
      tdEntries = data || [];
    } catch (err: unknown) {
      console.error("TD Ledger not available:", (err as Error).message);
    }

    // CD entries
    let cdEntries: Record<string, unknown>[] = [];
    try {
      const { data, error } = await supabaseAdmin
        .from("cd_ledger")
        .select("*")
        .eq("party_id", partyId)
        .order("created_at", { ascending: true });
      if (error) throw error;
      cdEntries = data || [];
    } catch (err: unknown) {
      console.error("CD Ledger not available:", (err as Error).message);
    }

    // Security entries
    let securityEntries: Record<string, unknown>[] = [];
    try {
      const { data, error } = await supabaseAdmin
        .from("security_ledger")
        .select("*")
        .eq("party_id", partyId)
        .order("created_at", { ascending: true });
      if (error) throw error;
      securityEntries = data || [];
    } catch (err: unknown) {
      console.error("Security Ledger not available:", (err as Error).message);
    }

    type TxRow = {
      id: string;
      date: string;
      created_at: string;
      type: string;
      reference: string;
      description: string;
      debit: number;
      credit: number;
      balance: number | null;
      proof_url?: string;
      isSecurity?: boolean;
      isOpening?: boolean;
      collected_by?: string;
    };

    // Resolve "collected by whom" — map each wallet txn's created_by (the
    // collector's user id) to a display name so the ledger always shows which
    // salesman/admin recorded the payment.
    const collectorIds = [...new Set(
      (walletTxns || [])
        .map((tx) => (tx as Record<string, unknown>).created_by)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    )];
    const collectorNames = collectorIds.length > 0
      ? await resolveUserDisplayMap(collectorIds)
      : {};

    const allTransactions: TxRow[] = [];

    // Map wallet_transactions → ledger rows
    for (const tx of walletTxns || []) {
      const raw = tx as Record<string, unknown>;
      const rawAmount = Number(raw.amount ?? 0);
      const balanceAfter = Number(raw.balance_after ?? 0);
      const txType = String(raw.type ?? "");
      const collectedBy = typeof raw.created_by === "string" && raw.created_by
        ? (collectorNames[raw.created_by]?.name ?? undefined)
        : undefined;

      let ledgerType: string;
      let debit = 0;
      let credit = 0;

      if (txType === "INVOICE_DEBIT") {
        ledgerType = "INVOICE";
        debit = Math.abs(rawAmount);
      } else if (txType === "PAYMENT_CREDIT" || txType === "TOPUP_CREDIT") {
        ledgerType = "PAYMENT";
        credit = Math.abs(rawAmount);
      } else if (txType === "PAYMENT_REVERSAL") {
        ledgerType = "PAYMENT";
        debit = Math.abs(rawAmount);
      } else if (txType === "OPENING_BALANCE" || txType === "BALANCE_ADJUSTMENT") {
        ledgerType = rawAmount >= 0 ? "PAYMENT" : "INVOICE";
        if (rawAmount >= 0) credit = Math.abs(rawAmount);
        else debit = Math.abs(rawAmount);
      } else {
        // Any other wallet operation
        ledgerType = rawAmount >= 0 ? "PAYMENT" : "INVOICE";
        if (rawAmount >= 0) credit = Math.abs(rawAmount);
        else debit = Math.abs(rawAmount);
      }

      const proofUrl = raw.proof_url ? String(raw.proof_url) : undefined;
      const isOpening = txType === "OPENING_BALANCE";
      allTransactions.push({
        id: String(raw.id ?? ""),
        date: String(raw.created_at ?? "").split("T")[0],
        created_at: String(raw.created_at ?? ""),
        type: ledgerType,
        reference: String(raw.reference_id ?? ""),
        description: String(raw.description ?? ""),
        debit,
        credit,
        // Placeholder — the coherent running balance is recomputed chronologically
        // after sorting (stored balance_after values drift across repair paths).
        balance: openingBalance + balanceAfter,
        ...(proofUrl ? { proof_url: proofUrl } : {}),
        ...(isOpening ? { isOpening: true } : {}),
        ...(collectedBy && ledgerType === "PAYMENT" ? { collected_by: collectedBy } : {}),
      });
    }

    // TD entries (outside wallet balance, tracked separately)
    for (const td of tdEntries) {
      const isCredit = td.entry_type === "CREDIT";
      const amount = Number(td.td_amount ?? td.amount ?? 0);
      allTransactions.push({
        id: String(td.id ?? ""),
        date: String(td.created_at ?? "").split("T")[0],
        created_at: String(td.created_at ?? ""),
        type: "TD",
        reference: String(td.reference_no ?? ""),
        description: `TD ${td.entry_type ?? ""}${td.narration ? ` - ${td.narration}` : ""}`,
        debit: isCredit ? 0 : amount,
        credit: isCredit ? amount : 0,
        balance: null,
      });
    }

    // CD entries
    for (const cd of cdEntries) {
      const isCredit = cd.entry_type === "CREDIT";
      const amount = Number(cd.cd_amount ?? cd.amount ?? 0);
      allTransactions.push({
        id: String(cd.id ?? ""),
        date: String(cd.created_at ?? "").split("T")[0],
        created_at: String(cd.created_at ?? ""),
        type: "CD",
        reference: String(cd.reference_no ?? ""),
        description: `CD ${cd.entry_type ?? ""}${cd.narration ? ` - ${cd.narration}` : ""}`,
        debit: isCredit ? 0 : amount,
        credit: isCredit ? amount : 0,
        balance: null,
      });
    }

    // Security entries
    for (const sec of securityEntries) {
      const isDeposit = ["DEPOSIT", "BONUS_DEPOSIT", "INTEREST_CREDIT"].includes(String(sec.entry_type ?? ""));
      const amount = Number(sec.amount ?? 0);
      allTransactions.push({
        id: String(sec.id ?? ""),
        date: String(sec.created_at ?? "").split("T")[0],
        created_at: String(sec.created_at ?? ""),
        type: "SECURITY",
        reference: String(sec.reference_no ?? ""),
        description: `Security ${sec.entry_type ?? ""}${sec.narration ? ` - ${sec.narration}` : ""}`,
        debit: isDeposit ? amount : 0,
        credit: isDeposit ? 0 : amount,
        balance: null,
        isSecurity: true,
      });
    }

    // Sort chronologically
    allTransactions.sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    );

    // Recompute the running balance as a single coherent ledger. The stored
    // balance_after on each wallet_transactions row is written independently by
    // the payment, invoice, and manual-adjustment repair paths, so those values
    // drift out of sync and produce an internally inconsistent Balance column
    // and a wrong effective balance. Derive it instead from the opening balance
    // plus the cumulative credit/debit, in chronological order. TD/CD/Security
    // rows (balance === null) are tracked outside the wallet and skipped.
    let runningBalance = openingBalance;
    for (const tx of allTransactions) {
      if (tx.balance === null) continue;
      if (tx.isOpening) {
        // The opening row represents the baseline itself, not a delta on top of it.
        tx.balance = openingBalance;
        continue;
      }
      runningBalance += tx.credit - tx.debit;
      tx.balance = runningBalance;
    }
    const currentWalletBalance = runningBalance;

    // Compute summary
    const totalInvoices = allTransactions
      .filter((tx) => tx.type === "INVOICE")
      .reduce((s, tx) => s + tx.debit, 0);

    const totalPayments = allTransactions
      .filter((tx) => tx.type === "PAYMENT")
      .reduce((s, tx) => s + tx.credit - tx.debit, 0);

    const totalTD = allTransactions
      .filter((tx) => tx.type === "TD")
      .reduce((s, tx) => s + tx.debit - tx.credit, 0);

    const totalCD = allTransactions
      .filter((tx) => tx.type === "CD")
      .reduce((s, tx) => s + tx.debit - tx.credit, 0);

    const totalSecurityDeposits = allTransactions
      .filter((tx) => tx.type === "SECURITY" && tx.debit > 0)
      .reduce((s, tx) => s + tx.debit, 0);

    const totalSecurityWithdrawals = allTransactions
      .filter((tx) => tx.type === "SECURITY" && tx.credit > 0)
      .reduce((s, tx) => s + tx.credit, 0);

    return NextResponse.json({
      success: true,
      data: {
        transactions: allTransactions,
        summary: {
          totalInvoices,
          totalPayments: Math.max(0, totalPayments),
          totalTD,
          totalCD,
          totalSecurity: totalSecurityDeposits - totalSecurityWithdrawals,
          currentBalance: currentWalletBalance,
          openingBalance,
          securityDeposits: totalSecurityDeposits,
          securityWithdrawals: totalSecurityWithdrawals,
        },
      },
    });
  } catch (error: unknown) {
    console.error("Transactions API Error:", error);
    return NextResponse.json(
      { success: false, message: (error as Error).message || "Failed to fetch transactions" },
      { status: 500 }
    );
  }
}
