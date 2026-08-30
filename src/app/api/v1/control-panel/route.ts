import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const ALL_MODULES = [
  "dashboard",
  "orders",
  "parties",
  "vendors",
  "invoices",
  "procurement",
  "delivery_lots",
  "payments",
  "balance_sheet",
  "reconcile",
  "products",
  "pricing",
  "ledgers",
  "security",
  "schemes",
  "rankings",
  "groups",
  "downline",
  "routes",
  "tracking",
  "van_tracking",
  "analytics",
  "reports",
  "users",
  "control_panel",
  "approval_requests",
  "exports",
  "bom_inventory",
  "driver_duty",
  "tax_settings",
];

export async function GET() {
  const supabaseAdmin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const { data: roles, error: rolesErr } = await supabaseAdmin
    .from("roles")
    .select("id, name")
    .order("name");

  if (rolesErr) return NextResponse.json({ message: rolesErr.message }, { status: 500 });

  const { data: permissions, error: permErr } = await supabaseAdmin
    .from("permissions")
    .select("*");

  if (permErr) return NextResponse.json({ message: permErr.message }, { status: 500 });

  // Build full matrix: for each role, ensure every module has a row
  const matrix = (roles || []).map((role: { id: string; name: string }) => {
    const rolePerms = (permissions || []).filter((p: { role_id: string }) => p.role_id === role.id);
    const modules = ALL_MODULES.map((mod) => {
      const existing = rolePerms.find((p: { module: string }) => p.module === mod);
    return existing
          ? {
              id: existing.id,
              role_id: existing.role_id,
              module_name: existing.module,
              can_view: existing.can_view,
              can_create: existing.can_create,
              can_edit: existing.can_edit,
              can_delete: existing.can_delete,
              can_approve: existing.can_approve,
              scope: existing.scope || "downline",
              status: existing.status,
            }
          : {
              id: null,
              role_id: role.id,
              module_name: mod,
              can_view: false,
              can_create: false,
              can_edit: false,
              can_delete: false,
              can_approve: false,
              scope: "downline",
              status: "ACTIVE",
            };
    });
    return { role, modules };
  });

  return NextResponse.json({ success: true, data: { matrix, modules: ALL_MODULES } });
}

export async function PATCH(req: NextRequest) {
  try {
    const supabaseAdmin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );

    const body = await req.json();
    const { role_id, module_name, field, value } = body;

    if (!role_id || !module_name) {
      return NextResponse.json({ message: "Missing fields: role_id and module_name are required" }, { status: 400 });
    }

    if (!field) {
      return NextResponse.json({ message: "Missing field parameter" }, { status: 400 });
    }

    const booleanFields = ["can_view", "can_create", "can_edit", "can_delete", "can_approve"];
    const allowedFields = [...booleanFields, "scope"];
    if (!allowedFields.includes(field)) {
      return NextResponse.json({ message: "Invalid field" }, { status: 400 });
    }

    if (field === "scope") {
      if (value !== "downline" && value !== "all") {
        return NextResponse.json({ message: "Invalid scope value: must be 'downline' or 'all'" }, { status: 400 });
      }
    } else if (typeof value !== "boolean") {
      return NextResponse.json({ message: `Invalid value for ${field}: must be true or false` }, { status: 400 });
    }

    // Check if row exists for this role + module_name
    const { data: existing, error: existingError } = await supabaseAdmin
      .from("permissions")
      .select("id")
      .eq("role_id", role_id)
      .eq("module", module_name)
      .maybeSingle();

    if (existingError) {
      return NextResponse.json({ message: `Database error: ${existingError.message}` }, { status: 500 });
    }

    if (existing?.id) {
      const { error } = await supabaseAdmin
        .from("permissions")
        .update({ [field]: value, status: "ACTIVE", updated_at: new Date().toISOString() })
        .eq("id", existing.id);
      if (error) return NextResponse.json({ message: `Failed to update permission: ${error.message}` }, { status: 500 });
    } else {
      const newPerm: Record<string, unknown> = {
          role_id,
          module: module_name,
          can_view: false,
          can_create: false,
          can_edit: false,
          can_delete: false,
          can_approve: false,
          status: "ACTIVE",
          [field]: value,
        };
      const { error } = await supabaseAdmin.from("permissions").insert(newPerm);
      if (error) return NextResponse.json({ message: `Failed to create permission: ${error.message}` }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ message }, { status: 500 });
  }
}
