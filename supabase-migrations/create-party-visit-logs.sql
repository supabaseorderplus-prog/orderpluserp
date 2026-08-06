-- Drop and recreate party_visit_logs without FK on visited_by
-- (users may live in either the 'users' or 'app_users' table)
DROP TABLE IF EXISTS public.party_visit_logs;

CREATE TABLE public.party_visit_logs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  party_id        uuid NOT NULL REFERENCES public.parties(id) ON DELETE CASCADE,
  visited_by      uuid NOT NULL,
  visited_by_name text,
  visit_date      timestamptz NOT NULL DEFAULT now(),
  notes           text,
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_party_visit_logs_party_id   ON public.party_visit_logs(party_id);
CREATE INDEX IF NOT EXISTS idx_party_visit_logs_visited_by ON public.party_visit_logs(visited_by);

ALTER TABLE public.party_visit_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all" ON public.party_visit_logs
  FOR ALL TO service_role USING (true) WITH CHECK (true);
