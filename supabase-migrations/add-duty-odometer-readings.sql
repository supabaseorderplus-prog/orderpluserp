-- Verified odometer evidence captured when a salesman starts and ends duty.
ALTER TABLE public.salesman_day_sessions
  ADD COLUMN IF NOT EXISTS start_odometer_km numeric(12,1),
  ADD COLUMN IF NOT EXISTS end_odometer_km numeric(12,1),
  ADD COLUMN IF NOT EXISTS odometer_distance_km numeric(12,1),
  ADD COLUMN IF NOT EXISTS start_odometer_photo_path text,
  ADD COLUMN IF NOT EXISTS end_odometer_photo_path text,
  ADD COLUMN IF NOT EXISTS start_odometer_ocr_confidence numeric(5,2),
  ADD COLUMN IF NOT EXISTS end_odometer_ocr_confidence numeric(5,2);

ALTER TABLE public.salesman_day_sessions
  DROP CONSTRAINT IF EXISTS salesman_day_sessions_odometer_order_check;

ALTER TABLE public.salesman_day_sessions
  ADD CONSTRAINT salesman_day_sessions_odometer_order_check
  CHECK (
    start_odometer_km IS NULL OR
    end_odometer_km IS NULL OR
    end_odometer_km >= start_odometer_km
  );

COMMENT ON COLUMN public.salesman_day_sessions.odometer_distance_km IS
  'Distance calculated from verified end_odometer_km - start_odometer_km.';

NOTIFY pgrst, 'reload schema';
