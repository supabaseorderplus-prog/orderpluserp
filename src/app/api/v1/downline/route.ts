import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getUserFromToken, resolveCompanyScope, getPartyDescendants } from "@/lib/supabase-server";
import { computeCurrentBalances } from "@/lib/party-balance";
import { fetchAllInChunks } from "@/lib/supabase-in-chunks";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// GET /api/v1/downline — returns full hierarchy tree (CNF → Super Dealer → Retailer)
// Scoped strictly to the caller's company — no cross-company data leaks.
export async function GET(req: NextRequest) {
  try {
    // Resolve caller + company scope
    const caller = await getUserFromToken(req);
    const companyPartyId = await resolveCompanyScope(req, caller);

    // Collect allowed party IDs for this company. getPartyDescendants returns the
    // complete subtree (root + all descendants) via a cycle-safe parent_party_id BFS;
    // the get_party_descendants RPC caps at 1000 and would drop whole branches (e.g.
    // super dealers under a CNF) once the company exceeds that many parties.
    let allowedPartyIds: string[] | null = null;
    if (companyPartyId) {
      const descendants = await getPartyDescendants(companyPartyId);
      allowedPartyIds = [...new Set([companyPartyId, ...descendants.map((d) => d.id)])];
    }

    // Fetch all relevant parties — try * first (always includes wallet_balance, opening_balance),
    // fall through to explicit column lists only if * itself errors.
    // Large company scopes overflow PostgREST's URL-encoded .in() filter (undici's
    // 16KB header limit ≈ 400+ UUIDs → UND_ERR_HEADERS_OVERFLOW → 500), so any
    // id-scoped fetch is chunked and merged/re-sorted in memory.
    const fetchParties = async (
      sel: string,
    ): Promise<{ data: any[] | null; error: { code?: string; message?: string } | null }> => {
      if (allowedPartyIds !== null) {
        const res = await fetchAllInChunks<any>(allowedPartyIds, (chunk) =>
          supabase
            .from("parties")
            .select(sel)
            .not("party_type_id", "is", null)
            .neq("status", "DELETED")
            .in("id", chunk),
        );
        if (res.error) return { data: null, error: res.error };
        const rows = [...(res.data || [])];
        rows.sort((a, b) => String(a?.name ?? "").localeCompare(String(b?.name ?? "")));
        return { data: rows, error: null };
      }
      const res = await supabase
        .from("parties")
        .select(sel)
        .not("party_type_id", "is", null)
        .neq("status", "DELETED")
        .order("name");
      return { data: res.data, error: res.error };
    };

    let data: any[] | null = null;
    let error: { code?: string; message?: string } | null = null;

    {
      const res = await fetchParties("*, party_types(id, name)");
      if (!res.error) { data = res.data; }
      else { error = res.error; }
    }

    // Explicit-column fallbacks (handle phone vs contact_phone schema variants)
    if (error) {
      const selects = [
        "id, name, party_code, status, city, phone, territory_id, parent_party_id, is_verified, wallet_balance, opening_balance, party_types(id, name)",
        "id, name, party_code, status, city, contact_phone, territory_id, parent_party_id, is_verified, wallet_balance, opening_balance, party_types(id, name)",
        "id, name, party_code, status, city, phone, territory_id, parent_party_id, wallet_balance, opening_balance, party_types(id, name)",
        "id, name, party_code, status, city, contact_phone, territory_id, parent_party_id, wallet_balance, opening_balance, party_types(id, name)",
        "id, name, party_code, status, city, phone, territory_id, parent_party_id, is_verified, party_types(id, name)",
        "id, name, party_code, status, city, contact_phone, territory_id, parent_party_id, is_verified, party_types(id, name)",
        "id, name, party_code, status, city, phone, territory_id, parent_party_id, party_types(id, name)",
        "id, name, party_code, status, city, contact_phone, territory_id, parent_party_id, party_types(id, name)",
      ];
      for (const sel of selects) {
        const res = await fetchParties(sel);
        if (!res.error) { data = res.data; error = null; break; }
        error = res.error;
        if (res.error.code !== "42703") break;
      }
    }

    if (error) throw error;

      const all = (data || []).map((p: any) => ({ ...p, contact_phone: p.phone ?? p.contact_phone ?? null }));

    // Derive each party's true current balance (opening + payments − invoices).
    // There is no maintained wallet_balance column, so without this every node
    // would show only its opening balance and ignore invoiced orders/payments.
    const balanceMap = await computeCurrentBalances(all);
    for (const p of all) p.current_balance = balanceMap[p.id] ?? Number(p.opening_balance ?? 0);

    // Separate by type
    const companies    = all.filter((p: any) => p.party_types?.name === "COMPANY");
    const cnfs         = all.filter((p: any) => p.party_types?.name === "CNF");
    const superDealers = all.filter((p: any) => p.party_types?.name === "SUPER_DEALER");
    const retailers    = all.filter((p: any) => p.party_types?.name === "RETAILER");

    const companyIds = new Set(companies.map((c: any) => c.id));

    // Build CNF tree as before
    const tree = cnfs.map((cnf: any) => ({
      ...cnf,
      level: "CNF",
      children: superDealers
        .filter((sd: any) => sd.parent_party_id === cnf.id)
        .map((sd: any) => ({
          ...sd,
          level: "SUPER_DEALER",
          children: retailers
            .filter((r: any) => r.parent_party_id === sd.id)
            .map((r: any) => ({ ...r, level: "RETAILER", children: [] })),
        })),
    }));

    // Parties directly under company (parent_party_id = a COMPANY id)
    // These are SD or Retailer that the user placed directly under the company
    const companyDirectSD = superDealers
      .filter((sd: any) => sd.parent_party_id && companyIds.has(sd.parent_party_id))
      .map((sd: any) => ({
        ...sd,
        level: "SUPER_DEALER",
        children: retailers
          .filter((r: any) => r.parent_party_id === sd.id)
          .map((r: any) => ({ ...r, level: "RETAILER", children: [] })),
      }));

    const companyDirectR = retailers
      .filter((r: any) => r.parent_party_id && companyIds.has(r.parent_party_id))
      .map((r: any) => ({ ...r, level: "RETAILER", children: [] }));

    // Truly unattached — no parent or parent not in any known group
    const allKnownParentIds = new Set([
      ...cnfs.map((c: any) => c.id),
      ...superDealers.map((s: any) => s.id),
      ...companyIds,
    ]);

    const unattachedSD = superDealers
      .filter((sd: any) => !sd.parent_party_id || !allKnownParentIds.has(sd.parent_party_id))
      .map((sd: any) => ({
        ...sd,
        level: "SUPER_DEALER",
        children: retailers
          .filter((r: any) => r.parent_party_id === sd.id)
          .map((r: any) => ({ ...r, level: "RETAILER", children: [] })),
      }));

    const unattachedR = retailers
      .filter((r: any) => !r.parent_party_id || !allKnownParentIds.has(r.parent_party_id))
      .map((r: any) => ({ ...r, level: "RETAILER", children: [] }));

    const companyParty = companies[0] ?? null;

    return NextResponse.json({
      success: true,
      data: { tree, companyDirectSD, companyDirectR, unattachedSD, unattachedR, companyParty },
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, message: err.message }, { status: 500 });
  }
}

// PATCH /api/v1/downline — update parent_party_id (transfer node)
export async function PATCH(req: NextRequest) {
  try {
    const { id, parent_party_id } = await req.json();
    if (!id) return NextResponse.json({ success: false, message: "id required" }, { status: 400 });

    const { data, error } = await supabase
      .from("parties")
      .update({ parent_party_id: parent_party_id || null })
      .eq("id", id)
      .select()
      .single();

    if (error) throw error;
    return NextResponse.json({ success: true, data });
  } catch (err: any) {
    return NextResponse.json({ success: false, message: err.message }, { status: 500 });
  }
}

// POST /api/v1/downline — create a new party in the hierarchy
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { name, party_code, level, parent_party_id, address_line1, city, contact_phone, territory_id } = body;

      if (!name || !level) {
      return NextResponse.json({ success: false, message: "name and level are required" }, { status: 400 });
    }

    // Resolve party_type_id from level
    const { data: pt, error: ptErr } = await supabase
      .from("party_types")
      .select("id")
      .eq("name", level)
      .single();

    if (ptErr || !pt) {
      return NextResponse.json({ success: false, message: "Invalid level" }, { status: 400 });
    }

    // Auto-generate party_code if not provided
    let code = party_code;
    if (!code) {
      const prefix = level === "CNF" ? "CNF" : level === "SUPER_DEALER" ? "SD" : "RT";
      const { count } = await supabase.from("parties").select("*", { count: "exact", head: true });
      code = `${prefix}-${String((count || 0) + 1).padStart(4, "0")}`;
    }

    // If no parent given for a CNF, auto-attach to caller's company
    let resolvedParentId = parent_party_id || null;
    if (!resolvedParentId && level === "CNF") {
      const caller = await getUserFromToken(req);
      const companyId = await resolveCompanyScope(req, caller);
      if (companyId) resolvedParentId = companyId;
    }

      let insertPayload: Record<string, unknown> = {
          name,
          party_code: code,
          party_type_id: pt.id,
          parent_party_id: resolvedParentId,
          address_line1: address_line1 || "",
          city: city || "",
          phone: contact_phone || null,
          territory_id: territory_id || null,
          status: "ACTIVE",
        }

      let { data, error } = await supabase
        .from("parties")
        .insert(insertPayload)
        .select()
        .single();

      if (error && error.code === "42703") {
        delete insertPayload.phone;
        insertPayload.contact_phone = contact_phone || null;
        const retry = await supabase
          .from("parties")
          .insert(insertPayload)
          .select()
          .single();
        data = retry.data;
        error = retry.error;
      }

    if (error) throw error;

    return NextResponse.json({ success: true, data });
  } catch (err: any) {
    return NextResponse.json({ success: false, message: err.message }, { status: 500 });
  }
}
