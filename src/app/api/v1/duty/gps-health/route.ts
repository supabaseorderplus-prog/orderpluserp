import { NextRequest, NextResponse } from "next/server";
import { getUserFromToken, resolveCompanyScope, supabaseAdmin } from "@/lib/supabase-server";
import { istToday } from "@/lib/datetime";
import { gpsAdminEvent } from "@/lib/gps-notification-policy";

type DbError = { code?: string; message?: string } | null | undefined;

function isSchemaGap(error: DbError) {
  const message = String(error?.message || "").toLowerCase();
  return ["42P01", "PGRST200", "PGRST204", "PGRST205"].includes(error?.code || "") ||
    message.includes("does not exist") || message.includes("schema cache") || message.includes("could not find");
}

async function ensureHealthTable() {
  const { error } = await supabaseAdmin.rpc("exec_sql", {
    sql: `
      CREATE TABLE IF NOT EXISTS public.salesman_tracking_health (
        salesman_id uuid PRIMARY KEY,
        company_id uuid,
        gps_enabled boolean NOT NULL DEFAULT false,
        permission_granted boolean NOT NULL DEFAULT false,
        service_active boolean NOT NULL DEFAULT false,
        location_available boolean NOT NULL DEFAULT false,
        last_location_at timestamptz,
        status_updated_at timestamptz NOT NULL DEFAULT now(),
        device_platform text,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_salesman_tracking_health_company_status
        ON public.salesman_tracking_health(company_id, gps_enabled, status_updated_at DESC);
      ALTER TABLE public.salesman_tracking_health ENABLE ROW LEVEL SECURITY;
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_policies
          WHERE tablename = 'salesman_tracking_health' AND policyname = 'service_role_all'
        ) THEN
          CREATE POLICY service_role_all ON public.salesman_tracking_health
            FOR ALL TO service_role USING (true) WITH CHECK (true);
        END IF;
      END $$;
      NOTIFY pgrst, 'reload schema';
    `,
  });
  return !error;
}

async function resolveCompanyRoot(partyId: string | null): Promise<string | null> {
  if (!partyId) return null;
  let current = partyId;
  for (let depth = 0; depth < 10; depth += 1) {
    const { data } = await supabaseAdmin.from("parties")
      .select("parent_party_id").eq("id", current).maybeSingle();
    if (!data?.parent_party_id) return current;
    current = data.parent_party_id;
  }
  return current;
}

async function loadCompanyAdminIds(companyId: string | null): Promise<string[]> {
  if (!companyId) return [];
  const { data: role } = await supabaseAdmin.from("roles")
    .select("id").eq("name", "ADMIN").maybeSingle();
  if (!role?.id) return [];

  const adminIds = new Set<string>();
  for (const table of ["users", "app_users"] as const) {
    const { data, error } = await supabaseAdmin.from(table)
      .select("id").eq("role_id", role.id).eq("party_id", companyId).eq("status", "ACTIVE");
    if (!error) (data || []).forEach((admin: { id: string }) => adminIds.add(admin.id));
  }
  return [...adminIds];
}

async function insertGpsNotification(input: {
  adminId: string;
  companyId: string;
  salesmanId: string;
  title: string;
  message: string;
}) {
  // Current production schema (party_id/channel) — keep the incident linked to
  // the company and salesman so the admin listener can scope and deep-link it.
  const productionShape: Record<string, unknown> = {
    user_id: input.adminId,
    party_id: input.companyId,
    title: input.title,
    body: input.message,
    type: "SYSTEM",
    reference_id: input.salesmanId,
    reference_type: "SALESMAN_GPS",
    is_read: false,
    channel: "IN_APP",
  };
  let result = await supabaseAdmin.from("notifications").insert(productionShape);
  if (!result.error) return;

  // Prisma-era schema used delivery_channel and did not carry a party/company
  // column. This fallback keeps upgrades compatible with those databases.
  const prismaShape: Record<string, unknown> = { ...productionShape };
  delete prismaShape.party_id;
  delete prismaShape.channel;
  prismaShape.delivery_channel = "IN_APP";
  result = await supabaseAdmin.from("notifications").insert(prismaShape);
  if (!result.error) return;

  const legacyShape = {
    user_id: input.adminId,
    company_id: input.companyId,
    type: "SYSTEM",
    title: input.title,
    message: input.message,
    is_read: false,
  };
  const legacy = await supabaseAdmin.from("notifications").insert(legacyShape);
  if (legacy.error) {
    const withoutCompany: Record<string, unknown> = { ...legacyShape };
    delete withoutCompany.company_id;
    await supabaseAdmin.from("notifications").insert(withoutCompany);
  }
}

async function notifyCompanyAdmins(input: {
  companyId: string | null;
  salesmanId: string;
  salesmanName: string;
  restored: boolean;
}) {
  if (!input.companyId) return;
  const adminIds = await loadCompanyAdminIds(input.companyId);
  const title = input.restored ? "Salesman GPS restored" : "Salesman GPS connection lost";
  const message = input.restored
    ? `${input.salesmanName}'s GPS connection is active again. Verified duty tracking has resumed.`
    : `${input.salesmanName} is on duty, but the GPS connection is off or location permission was lost.`;
  await Promise.all(adminIds.map((adminId) => insertGpsNotification({
    adminId,
    companyId: input.companyId as string,
    salesmanId: input.salesmanId,
    title,
    message,
  })));
}

// GET /api/v1/duty/gps-health — current device health for the signed-in salesman.
// This lets the duty screen reflect the Android service state instead of using
// the desktop/WebView geolocation result as a proxy for the phone.
export async function GET(req: NextRequest) {
  try {
    const caller = await getUserFromToken(req);
    if (!caller) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const salesmanId = caller.app_user_id || caller.id;
    const { data, error } = await supabaseAdmin
      .from("salesman_tracking_health")
      .select("gps_enabled, permission_granted, service_active, location_available, last_location_at, status_updated_at, device_platform")
      .eq("salesman_id", salesmanId)
      .maybeSingle();

    if (error && !isSchemaGap(error)) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    const ageMs = data?.status_updated_at
      ? Math.max(0, Date.now() - new Date(data.status_updated_at).getTime())
      : null;
    return NextResponse.json({
      data: data ? { ...data, stale: ageMs === null || ageMs > 90_000, age_ms: ageMs } : null,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to load GPS health" },
      { status: 500 },
    );
  }
}

// POST /api/v1/duty/gps-health — authenticated device heartbeat.
export async function POST(req: NextRequest) {
  try {
    const caller = await getUserFromToken(req);
    if (!caller) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const salesmanId = caller.app_user_id || caller.id;
    const scopedCompanyId = await resolveCompanyScope(req, caller);
    const companyId = await resolveCompanyRoot(caller.party_id || scopedCompanyId);
    const body = await req.json().catch(() => ({}));
    const now = new Date().toISOString();
    const lastLocationAt = typeof body.last_location_at === "string" &&
      Number.isFinite(new Date(body.last_location_at).getTime())
      ? new Date(body.last_location_at).toISOString()
      : null;

    const row = {
      salesman_id: salesmanId,
      company_id: companyId || null,
      gps_enabled: body.gps_enabled === true,
      permission_granted: body.permission_granted === true,
      service_active: body.service_active === true,
      location_available: body.location_available === true,
      last_location_at: lastLocationAt,
      status_updated_at: now,
      device_platform: String(body.device_platform || "web").slice(0, 32),
      updated_at: now,
    };

    const { data: previousHealth } = await supabaseAdmin
      .from("salesman_tracking_health")
      .select("gps_enabled, permission_granted, service_active, status_updated_at")
      .eq("salesman_id", salesmanId)
      .maybeSingle();

    let result = await supabaseAdmin
      .from("salesman_tracking_health")
      .upsert(row, { onConflict: "salesman_id" })
      .select()
      .single();

    if (result.error && isSchemaGap(result.error) && await ensureHealthTable()) {
      result = await supabaseAdmin
        .from("salesman_tracking_health")
        .upsert(row, { onConflict: "salesman_id" })
        .select()
        .single();
    }

    if (result.error) {
      return NextResponse.json({ error: result.error.message }, { status: 500 });
    }

    const { data: dutySession } = await supabaseAdmin
      .from("salesman_day_sessions")
      .select("status, check_out_time")
      .eq("salesman_id", salesmanId)
      .eq("date", istToday())
      .maybeSingle();
    const onDuty = dutySession?.status === "active" && !dutySession?.check_out_time;
    const previousAgeMs = previousHealth?.status_updated_at
      ? Date.now() - new Date(previousHealth.status_updated_at).getTime()
      : Number.POSITIVE_INFINITY;
    const adminEvent = gpsAdminEvent({
      onDuty,
      current: row,
      previous: previousHealth || null,
      previousAgeMs,
    });

    if (adminEvent) {
      await notifyCompanyAdmins({
        companyId,
        salesmanId,
        salesmanName: caller.name || "A salesman",
        restored: adminEvent === "restored",
      });
    }
    return NextResponse.json({ data: result.data });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to save GPS health" },
      { status: 500 },
    );
  }
}
