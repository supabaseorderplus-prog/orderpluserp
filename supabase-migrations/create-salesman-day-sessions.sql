-- Create salesman_day_sessions table if it doesn't exist
CREATE TABLE IF NOT EXISTS public.salesman_day_sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salesman_id   uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  date          date NOT NULL,
  check_in_time  timestamptz,
  check_out_time timestamptz,
  check_in_lat   numeric,
  check_in_lng   numeric,
  check_out_lat  numeric,
  check_out_lng  numeric,
  total_distance_km numeric DEFAULT 0,
  total_stops    integer DEFAULT 0,
  status         text DEFAULT 'active',
  notes          text,
  created_at     timestamptz DEFAULT now(),
  updated_at     timestamptz DEFAULT now()
);

-- Unique constraint required for upsert onConflict: "salesman_id,date"
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'salesman_day_sessions_salesman_date_key'
      AND table_name = 'salesman_day_sessions'
  ) THEN
    ALTER TABLE public.salesman_day_sessions
      ADD CONSTRAINT salesman_day_sessions_salesman_date_key UNIQUE (salesman_id, date);
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
