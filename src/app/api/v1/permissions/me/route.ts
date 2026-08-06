"use server";
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function GET(req: NextRequest) {
  const roleId = req.nextUrl.searchParams.get("role_id");
  const roleName = req.nextUrl.searchParams.get("role_name");

  if (!roleId && !roleName) {
    return NextResponse.json({ error: "Missing role_id or role_name" }, { status: 400 });
  }

  let resolvedRoleId = roleId;

  // Resolve role_id from role_name if needed
  if (!resolvedRoleId && roleName) {
    const { data: roleRow, error: roleErr } = await supabase
      .from("roles")
      .select("id")
      .eq("name", roleName)
      .single();
    if (roleErr || !roleRow) return NextResponse.json({ success: true, data: [] });
    resolvedRoleId = roleRow.id;
  }

  const { data, error } = await supabase
    .from("permissions")
    .select("module, can_view, can_create, can_edit, can_delete, can_approve, scope")
    .eq("role_id", resolvedRoleId!)
    .eq("status", "ACTIVE");

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const result = (data || []).map((p) => ({
    module: p.module,
    can_view: p.can_view,
    can_create: p.can_create,
    can_edit: p.can_edit,
    can_delete: p.can_delete,
    can_approve: p.can_approve,
    scope: p.scope,
  }));

  return NextResponse.json({ success: true, data: result });
}
