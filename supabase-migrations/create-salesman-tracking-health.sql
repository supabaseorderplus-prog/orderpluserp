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
