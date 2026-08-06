-- Locks one selected beat route to a salesman for each working day.
-- Visit details are stored as JSON so this remains compatible with both legacy
-- route_stops schemas used by existing HomeTech deployments.
CREATE TABLE IF NOT EXISTS public.salesman_route_runs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salesman_id       uuid NOT NULL,
  company_id        uuid,
  route_id          uuid NOT NULL,
  work_date         date NOT NULL,
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed')),
  ordered_stop_ids  jsonb NOT NULL DEFAULT '[]'::jsonb,
  visits            jsonb NOT NULL DEFAULT '[]'::jsonb,
  total_stops       integer NOT NULL DEFAULT 0,
  active_stop_id    uuid,
  signoff_request   jsonb,
  started_at        timestamptz NOT NULL DEFAULT now(),
  completed_at      timestamptz,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (salesman_id, work_date)
);

ALTER TABLE public.salesman_route_runs
  ADD COLUMN IF NOT EXISTS active_stop_id uuid,
  ADD COLUMN IF NOT EXISTS signoff_request jsonb;

CREATE INDEX IF NOT EXISTS idx_salesman_route_runs_company_date
  ON public.salesman_route_runs(company_id, work_date);
CREATE INDEX IF NOT EXISTS idx_salesman_route_runs_route
  ON public.salesman_route_runs(route_id);

ALTER TABLE public.salesman_route_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.salesman_route_runs;
CREATE POLICY "service_role_all" ON public.salesman_route_runs
  FOR ALL TO service_role USING (true) WITH CHECK (true);

NOTIFY pgrst, 'reload schema';
