import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getUserFromToken } from "@/lib/supabase-server";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

/**
 * Walk up the parent_party_id chain to find the root company for any party.
 * Returns the root company's party ID (the one with no parent).
 */
async function resolveRootCompanyId(partyId: string): Promise<string> {
  let currentId = partyId;
  const visited = new Set<string>();
  while (true) {
    if (visited.has(currentId)) break; // cycle guard
    visited.add(currentId);
    const { data } = await supabase
      .from("parties")
      .select("id, parent_party_id")
      .eq("id", currentId)
      .single();
    if (!data || !data.parent_party_id) return currentId;
    currentId = data.parent_party_id;
  }
  return currentId;
}

// GET /api/v1/companies/subscriptions - list all or one company's subscription
export async function GET(req: NextRequest) {
  const user = await getUserFromToken(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let companyId = req.nextUrl.searchParams.get("company_id");

  // Non-SUPER_ADMIN: resolve their root company from their party_id
  if (user.role !== "SUPER_ADMIN") {
    if (!companyId) {
      return NextResponse.json({ error: "company_id required" }, { status: 400 });
    }
    // Resolve the provided company_id to its root company (handles CNF, sub-dealer, etc.)
    const rootId = await resolveRootCompanyId(companyId);
    companyId = rootId;
  }

  let query = supabase.from("company_subscriptions").select("*").order("expires_at", { ascending: true });
  if (companyId) query = query.eq("company_id", companyId);
  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true, data: data || [] });
}

// POST /api/v1/companies/subscriptions - upsert a subscription
export async function POST(req: NextRequest) {
  try {
    const user = await getUserFromToken(req);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (user.role !== "SUPER_ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    const body = await req.json();
    const { company_id, plan_name, plan_tier, started_at, expires_at, amount_monthly, status, notes } = body;
    if (!company_id) return NextResponse.json({ error: "company_id required" }, { status: 400 });

    const { data, error } = await supabase
      .from("company_subscriptions")
      .upsert({
        company_id,
        plan_name: plan_name || "STARTER",
        plan_tier: plan_tier || "BASIC",
        started_at: started_at || new Date().toISOString().split("T")[0],
        expires_at: expires_at || null,
        amount_monthly: amount_monthly || 0,
        status: status || "ACTIVE",
        notes: notes || null,
        updated_at: new Date().toISOString(),
      }, { onConflict: "company_id" })
      .select()
      .single();

    if (error) {
      console.error("Subscription upsert error:", error);
      return NextResponse.json({ error: error.message || "Database error" }, { status: 500 });
    }
    return NextResponse.json({ success: true, data });
  } catch (err) {
    console.error("Subscription API error:", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Internal server error" }, { status: 500 });
  }
}
