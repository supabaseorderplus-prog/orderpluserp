-- Individual scheme enrollment table.
--
-- party_id is intentionally text instead of a strict FK to parties(id): regular
-- party schemes store parties.id, while SALESMAN schemes may store users.id.
-- The app resolves both forms when displaying rosters and computing progress.

CREATE TABLE IF NOT EXISTS public.scheme_parties (
  scheme_id uuid NOT NULL REFERENCES public.schemes(id) ON DELETE CASCADE,
  party_id text NOT NULL,
  enrolled_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scheme_id, party_id)
);

CREATE INDEX IF NOT EXISTS idx_scheme_parties_scheme_id
  ON public.scheme_parties(scheme_id);

CREATE INDEX IF NOT EXISTS idx_scheme_parties_party_id
  ON public.scheme_parties(party_id);

ALTER TABLE public.scheme_parties ENABLE ROW LEVEL SECURITY;

NOTIFY pgrst, 'reload schema';
