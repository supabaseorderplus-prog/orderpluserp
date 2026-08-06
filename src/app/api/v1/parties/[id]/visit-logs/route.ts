import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, getUserFromToken } from '@/lib/supabase-server'

type SupabaseError = { code?: string; message?: string }

const isTableMissing = (e: SupabaseError | null | undefined) =>
  !!e && (e.code === '42P01' || e.code === 'PGRST205' ||
    !!(e.message?.includes('does not exist') && !e.message?.includes('column')))

const isMissingColumn = (e: SupabaseError | null | undefined) =>
  !!e && (e.code === '42703' || !!(e.message?.includes('column') && e.message?.includes('does not exist')))

const isFKViolation = (e: SupabaseError | null | undefined) =>
  !!e && e.code === '23503'

async function ensureTable(): Promise<string | null> {
  const { error } = await supabaseAdmin.rpc('exec_sql', {
    sql: `
      CREATE TABLE IF NOT EXISTS public.party_visit_logs (
        id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        party_id        uuid NOT NULL REFERENCES public.parties(id) ON DELETE CASCADE,
        visited_by      uuid NOT NULL,
        visited_by_name text,
        visit_date      timestamptz NOT NULL DEFAULT now(),
        notes           text,
        created_at      timestamptz DEFAULT now(),
        updated_at      timestamptz DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_pvl_party_id ON public.party_visit_logs(party_id);
      ALTER TABLE public.party_visit_logs ENABLE ROW LEVEL SECURITY;
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_policies WHERE tablename='party_visit_logs' AND policyname='service_role_all'
        ) THEN
          EXECUTE 'CREATE POLICY service_role_all ON public.party_visit_logs FOR ALL TO service_role USING (true) WITH CHECK (true)';
        END IF;
      END $$;
    `
  })
  if (error) return (error as SupabaseError).message || 'Failed to create table'
  return null
}

async function ensureColumns(): Promise<void> {
  await supabaseAdmin.rpc('exec_sql', {
    sql: `
      ALTER TABLE public.party_visit_logs ADD COLUMN IF NOT EXISTS visited_by_name text;
      ALTER TABLE public.party_visit_logs DROP CONSTRAINT IF EXISTS party_visit_logs_visited_by_fkey;
    `
  })
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  const authUser = await getUserFromToken(req)
  if (!authUser) {
    return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 })
  }

  let { data, error } = await supabaseAdmin
    .from('party_visit_logs')
    .select('id, visited_by, visited_by_name, visit_date, notes, created_at')
    .eq('party_id', id)
    .order('visit_date', { ascending: false })

  if (error && isTableMissing(error as SupabaseError)) {
    await ensureTable()
    return NextResponse.json({ success: true, data: [], total: 0 })
  }

  if (error && isMissingColumn(error as SupabaseError)) {
    await ensureColumns()
    const retry = await supabaseAdmin
      .from('party_visit_logs')
      .select('id, visited_by, visit_date, notes, created_at')
      .eq('party_id', id)
      .order('visit_date', { ascending: false })
    data = retry.data; error = retry.error
  }

  if (error) {
    return NextResponse.json({ success: false, message: (error as SupabaseError).message }, { status: 500 })
  }

  const logs = (data || []).map((log: Record<string, unknown>) => ({
    id: log.id,
    visited_by: log.visited_by,
    visitor_name: (log.visited_by_name as string) || 'Unknown',
    visit_date: log.visit_date,
    notes: log.notes,
    created_at: log.created_at,
  }))

  return NextResponse.json({ success: true, data: logs, total: logs.length })
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  const authUser = await getUserFromToken(req)
  if (!authUser) {
    return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 })
  }

  let body: { notes?: string; visit_date?: string } = {}
  try { body = await req.json() } catch { /* empty body ok */ }

  const visitorId = authUser.app_user_id || authUser.id
  const visitorName = authUser.name || 'Unknown'
  const visitDate = body.visit_date || new Date().toISOString()

  const doInsert = (vid: string, withName: boolean) =>
    supabaseAdmin
      .from('party_visit_logs')
      .insert({
        party_id: id,
        visited_by: vid,
        ...(withName ? { visited_by_name: visitorName } : {}),
        notes: body.notes || null,
        visit_date: visitDate,
      })
      .select('id, visited_by, visited_by_name, visit_date, notes, created_at')
      .single()

  let { data, error } = await doInsert(visitorId, true)

  // Table missing — auto-create it then retry
  if (error && isTableMissing(error as SupabaseError)) {
    const createErr = await ensureTable()
    if (createErr) {
      return NextResponse.json({ success: false, message: `Auto-create failed: ${createErr}` }, { status: 500 })
    }
    const retry = await doInsert(visitorId, true)
    data = retry.data; error = retry.error
  }

  // visited_by_name column missing — patch schema then retry without name
  if (error && isMissingColumn(error as SupabaseError)) {
    await ensureColumns()
    const retry = await doInsert(visitorId, false)
    data = retry.data; error = retry.error
  }

  // FK violation — visited_by not in users table, try raw auth uid
  if (error && isFKViolation(error as SupabaseError)) {
    const retry = await doInsert(authUser.id, true)
    data = retry.data; error = retry.error
  }

  // Still FK — drop the constraint and retry
  if (error && isFKViolation(error as SupabaseError)) {
    await ensureColumns() // drops the FK constraint
    const retry = await doInsert(visitorId, true)
    data = retry.data; error = retry.error
  }

  if (error) {
    return NextResponse.json(
      { success: false, message: (error as SupabaseError).message || 'Failed to create visit log' },
      { status: 500 }
    )
  }

  return NextResponse.json({ success: true, data }, { status: 201 })
}
