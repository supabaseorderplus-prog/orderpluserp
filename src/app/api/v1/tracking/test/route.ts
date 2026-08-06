import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-server";

export async function GET() {
  try {
    const { data, error } = await supabaseAdmin
      .from("roles")
      .select("id, name")
      .eq("name", "SALESMAN")
      .maybeSingle();
    return NextResponse.json({ ok: true, role: data, error: error?.message ?? null });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
