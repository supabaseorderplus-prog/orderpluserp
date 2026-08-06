import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getUserFromToken } from "@/lib/supabase-server";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// GET /api/v1/companies/subscription-payments?company_id=xxx
export async function GET(req: NextRequest) {
  const user = await getUserFromToken(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role !== "SUPER_ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const companyId = req.nextUrl.searchParams.get("company_id");
  let query = supabase
    .from("subscription_payments")
    .select("*")
    .order("payment_date", { ascending: false });
  if (companyId) query = query.eq("company_id", companyId);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true, data: data || [] });
}

// POST /api/v1/companies/subscription-payments — record a payment
export async function POST(req: NextRequest) {
  const user = await getUserFromToken(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role !== "SUPER_ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = await req.json();
  const { subscription_id, company_id, amount, payment_date, payment_method, reference_no, notes } = body;
  if (!subscription_id || !company_id || !amount) {
    return NextResponse.json({ error: "subscription_id, company_id, amount required" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("subscription_payments")
    .insert({
      subscription_id,
      company_id,
      amount: Number(amount),
      payment_date: payment_date || new Date().toISOString().split("T")[0],
      payment_method: payment_method || "MANUAL",
      reference_no: reference_no || null,
      notes: notes || null,
      recorded_by: user.email || user.id,
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true, data });
}
