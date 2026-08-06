import { NextRequest, NextResponse } from "next/server";
import {
  supabaseAdmin,
  getUserFromToken,
  resolveCompanyScope,
  getPartyDescendants,
} from "@/lib/supabase-server";
import { invalidateCombinedLedgerCache } from "@/app/api/v1/ledger/combined/route";
import {
  INVOICE_REQUEST_FALLBACK_PREFIX,
  parseInvoiceRequestNote,
} from "@/lib/invoice-requests-source";

export const dynamic = "force-dynamic";

/**
 * Unified delete for any row shown in the combined ledger
 * (`/dashboard/ledgers`). Each transaction type reverses its own effect so the
 * party balance / wallet self-corrects:
 *
 *   OPENING   → party.opening_balance = 0
 *   WALLET    → delete the manual adjustment (wallet_transactions row, or the
 *               company_notes marker on deployments without that table)
 *   TD / CD   → delete the ledger row, then recompute running balances
 *   SECURITY  → delete the ledger row, then recompute running balances
 *   INVOICE   → soft-cancel the invoice (is_cancelled = true) and unlink its
 *               payments, or cancel the underlying confirmed invoice_request
 *
 * PAYMENT rows are deleted via the existing `DELETE /api/v1/payments?id=` route
 * (it reverses invoice/invoice-request allocations); the client routes those
 * there. Balances are derived (opening + payments − invoices ± adjustments), so
 * removing the source row is what reverses the money everywhere it was counted.
 */

type DbError = { code?: string; message?: string; details?: string } | null;

function isMissingTable(error: DbError): boolean {
  if (!error) return false;
  const text = `${error.message || ""} ${error.details || ""}`.toLowerCase();
  return (
    error.code === "42P01" ||
    error.code === "PGRST205" ||
    error.code === "PGRST200" ||
    text.includes("does not exist") ||
    text.includes("could not find") ||
    text.includes("schema cache")
  );
}

async function partyInScope(companyId: string | null, partyId: string): Promise<boolean> {
  if (!companyId) return true; // unscoped super admin → everything in reach
  const tree = await getPartyDescendants(companyId);
  const ids = (tree || []).map((r: { id: string }) => r.id);
  if (!ids.includes(companyId)) ids.push(companyId);
  return ids.includes(partyId);
}

// TD/CD/Security store a running `balance` per row (read by the parties page),
// so a mid-history delete leaves later rows stale. Recompute the whole party
// chain in chronological order, the same credit/debit convention used on write.
async function recomputeRunningBalances(
  table: "td_ledger" | "cd_ledger" | "security_ledger",
  partyId: string,
): Promise<void> {
  const { data: rows, error } = await supabaseAdmin
    .from(table)
    .select("*")
    .eq("party_id", partyId)
    .order("created_at", { ascending: true });
  if (error || !rows) return;

  let running = 0;
  for (const row of rows as Record<string, unknown>[]) {
    const amount = Number(
      (row.td_amount as number | undefined) ??
        (row.cd_amount as number | undefined) ??
        (row.amount as number | undefined) ??
        0,
    );
    const entryType = String(row.entry_type || "");
    const isCredit =
      table === "security_ledger"
        ? ["DEPOSIT", "BONUS_DEPOSIT", "INTEREST_CREDIT"].includes(entryType)
        : entryType === "CREDIT";
    running += isCredit ? amount : -amount;
    if (Number(row.balance) !== running) {
      await supabaseAdmin.from(table).update({ balance: running }).eq("id", String(row.id));
    }
  }
}

async function deleteWalletAdjustment(id: string): Promise<void> {
  // Manual adjustment id is a UUID either way. Try the table first; if the row
  // isn't there (or the table doesn't exist) fall back to the note marker.
  const { data, error } = await supabaseAdmin
    .from("wallet_transactions")
    .delete()
    .eq("id", id)
    .select("id");
  if (error && !isMissingTable(error)) throw error;
  if (!data || data.length === 0) {
    await supabaseAdmin.from("company_notes").delete().eq("id", id);
  }
}

async function deleteInvoiceRow(
  id: string,
  partyId: string,
  reference: string,
): Promise<void> {
  // Request-based invoice — combined-ledger id is `req-<invoice_number>`.
  if (id.startsWith("req-")) {
    const invoiceNumber = reference || id.slice("req-".length);

    // Table backend (when invoice_requests exists).
    const { error: tableErr } = await supabaseAdmin
      .from("invoice_requests")
      .update({ status: "CANCELLED" })
      .eq("invoice_number", invoiceNumber)
      .eq("party_id", partyId);
    if (tableErr && !isMissingTable(tableErr)) throw tableErr;

    // company_notes fallback — drop the confirmed-request marker so its debit
    // leaves the ledger.
    const { data: notes } = await supabaseAdmin
      .from("company_notes")
      .select("id, note")
      .like("note", `${INVOICE_REQUEST_FALLBACK_PREFIX}%`)
      .limit(5000);
    for (const row of (notes || []) as { id: string; note: string | null }[]) {
      const parsed = parseInvoiceRequestNote(row.note);
      if (!parsed) continue;
      if (
        String(parsed.invoice_number || "") === invoiceNumber &&
        String(parsed.party_id || "") === partyId
      ) {
        await supabaseAdmin.from("company_notes").delete().eq("id", row.id);
      }
    }
    return;
  }

  // Real invoice → soft-cancel (the ledger skips is_cancelled rows, removing the
  // debit) and unlink any payments. The payments stay as received credits; they
  // just become unallocated.
  const { error: linkErr } = await supabaseAdmin
    .from("payment_invoice_links")
    .delete()
    .eq("invoice_id", id);
  if (linkErr && !isMissingTable(linkErr)) throw linkErr;

  const { error } = await supabaseAdmin
    .from("invoices")
    .update({ is_cancelled: true })
    .eq("id", id);
  if (error) throw error;
}

export async function DELETE(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const type = url.searchParams.get("type");
    const id = url.searchParams.get("id");
    const partyId = url.searchParams.get("partyId");
    const reference = url.searchParams.get("reference") || "";

    if (!type || !id || !partyId) {
      return NextResponse.json(
        { success: false, message: "type, id and partyId are required" },
        { status: 400 },
      );
    }

    // Only ADMIN / SUPER_ADMIN may delete (reverse) a transaction.
    const authUser = await getUserFromToken(req);
    if (authUser?.role !== "ADMIN" && authUser?.role !== "SUPER_ADMIN") {
      return NextResponse.json(
        { success: false, message: "Only admins can delete transactions" },
        { status: 403 },
      );
    }

    const companyId = await resolveCompanyScope(req, authUser);
    if (!(await partyInScope(companyId, partyId))) {
      return NextResponse.json(
        { success: false, message: "Transaction not found or access denied" },
        { status: 403 },
      );
    }

    switch (type) {
      case "OPENING": {
        const { error } = await supabaseAdmin
          .from("parties")
          .update({ opening_balance: 0 })
          .eq("id", partyId);
        if (error) throw error;
        break;
      }
      case "WALLET":
        await deleteWalletAdjustment(id);
        break;
      case "SECURITY":
        await supabaseAdmin.from("security_ledger").delete().eq("id", id);
        await recomputeRunningBalances("security_ledger", partyId);
        break;
      case "TD":
        await supabaseAdmin.from("td_ledger").delete().eq("id", id);
        await recomputeRunningBalances("td_ledger", partyId);
        break;
      case "CD":
        await supabaseAdmin.from("cd_ledger").delete().eq("id", id);
        await recomputeRunningBalances("cd_ledger", partyId);
        break;
      case "INVOICE":
        await deleteInvoiceRow(id, partyId, reference);
        break;
      case "PAYMENT":
        return NextResponse.json(
          { success: false, message: "Delete payments via /api/v1/payments" },
          { status: 400 },
        );
      default:
        return NextResponse.json(
          { success: false, message: `Cannot delete ${type} transactions` },
          { status: 400 },
        );
    }

    // The combined-ledger view is cached — drop it so the deletion shows on the
    // next open instead of after the TTL.
    invalidateCombinedLedgerCache();

    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : "Failed to delete transaction" },
      { status: 500 },
    );
  }
}
