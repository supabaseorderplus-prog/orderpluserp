-- Live-duty telemetry used by the Android foreground tracker and admin map.
ALTER TABLE public.salesman_location_logs
  ADD COLUMN IF NOT EXISTS company_id uuid,
  ADD COLUMN IF NOT EXISTS speed numeric(10,3),
  ADD COLUMN IF NOT EXISTS heading numeric(10,3),
  ADD COLUMN IF NOT EXISTS address text,
  ADD COLUMN IF NOT EXISTS place_name text,
  ADD COLUMN IF NOT EXISTS road text,
  ADD COLUMN IF NOT EXISTS suburb text,
  ADD COLUMN IF NOT EXISTS city text,
  ADD COLUMN IF NOT EXISTS activity text DEFAULT 'moving',
  ADD COLUMN IF NOT EXISTS note text;

CREATE INDEX IF NOT EXISTS idx_salesman_location_live
  ON public.salesman_location_logs (salesman_id, recorded_at DESC);

CREATE INDEX IF NOT EXISTS idx_salesman_location_company_live
  ON public.salesman_location_logs (company_id, recorded_at DESC)
  WHERE company_id IS NOT NULL;
