-- ============================================================
-- COMPREHENSIVE FIX: All missing database objects
-- Run this in Supabase SQL Editor (Dashboard > SQL Editor)
-- ============================================================

-- ─────────────────────────────────────────────────────────────
-- 1. get_party_descendants RPC function
--    Used by 20+ routes for company-scoped data isolation
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION get_party_descendants(root_id uuid)
RETURNS TABLE(id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  WITH RECURSIVE party_tree AS (
    SELECT p.id
    FROM parties p
    WHERE p.id = root_id

    UNION ALL

    SELECT p.id
    FROM parties p
    JOIN party_tree pt ON p.parent_id = pt.id
  )
  SELECT party_tree.id FROM party_tree;
END;
$$;

GRANT EXECUTE ON FUNCTION get_party_descendants(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION get_party_descendants(uuid) TO service_role;

-- ─────────────────────────────────────────────────────────────
-- 2. invoices table — add missing columns
-- ─────────────────────────────────────────────────────────────
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS order_status TEXT DEFAULT 'PENDING';
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS is_cancelled BOOLEAN DEFAULT false;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS cancelled_by UUID;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS cancel_reason TEXT;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS approved_by UUID;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS approval_time TIMESTAMPTZ;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS created_by UUID;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS company_id UUID;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS is_interstate BOOLEAN DEFAULT false;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS supplier_gstin TEXT;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS buyer_gstin TEXT;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS place_of_supply TEXT;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS billing_path TEXT DEFAULT 'A';
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS cnf_id UUID;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS super_dealer_id UUID;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS td_triggered BOOLEAN DEFAULT false;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS dispatch_reference TEXT;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS transporter TEXT;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS lr_number TEXT;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS adjustment_reason TEXT;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS billing_path TEXT DEFAULT 'A';

-- Set existing orders without order_status to PENDING (not CONFIRM)
UPDATE public.invoices SET order_status = 'PENDING' WHERE order_status IS NULL AND is_cancelled = false;
UPDATE public.invoices SET order_status = 'CANCELLED' WHERE order_status IS NULL AND is_cancelled = true;

-- ─────────────────────────────────────────────────────────────
-- 2b. gst_config — add state_id for UUID-based state reference
-- ─────────────────────────────────────────────────────────────
ALTER TABLE public.gst_config ADD COLUMN IF NOT EXISTS state_id UUID;
ALTER TABLE public.gst_config ADD COLUMN IF NOT EXISTS company_id UUID;
ALTER TABLE public.gst_config ADD COLUMN IF NOT EXISTS gst_number TEXT;
ALTER TABLE public.gst_config ADD COLUMN IF NOT EXISTS company_state_code TEXT;
ALTER TABLE public.gst_config ADD COLUMN IF NOT EXISTS company_name TEXT;
ALTER TABLE public.gst_config ADD COLUMN IF NOT EXISTS company_address TEXT;

-- ─────────────────────────────────────────────────────────────
-- 3. orders table — add missing columns
-- ─────────────────────────────────────────────────────────────
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS order_status TEXT DEFAULT 'PENDING';
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS company_id UUID;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS territory_id UUID;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS is_offline_created BOOLEAN DEFAULT false;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS synced_at TIMESTAMPTZ;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS salesman_id UUID;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS notes TEXT;

-- ─────────────────────────────────────────────────────────────
-- 4. payments table — add missing columns
-- ─────────────────────────────────────────────────────────────
ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS company_id UUID;
ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS is_advance BOOLEAN DEFAULT false;
ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS is_verified BOOLEAN DEFAULT true;
ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS invoice_id UUID;

-- ─────────────────────────────────────────────────────────────
-- 5. users table — add missing columns
-- ─────────────────────────────────────────────────────────────
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS assigned_party_id UUID;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS territory_id UUID;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS last_login TIMESTAMPTZ;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS parent_user_id UUID;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS phone TEXT;

-- ─────────────────────────────────────────────────────────────
-- 6. parties table — add missing columns
-- ─────────────────────────────────────────────────────────────
ALTER TABLE public.parties ADD COLUMN IF NOT EXISTS portal_password_hash TEXT;
ALTER TABLE public.parties ADD COLUMN IF NOT EXISTS portal_phone TEXT;
ALTER TABLE public.parties ADD COLUMN IF NOT EXISTS credit_limit NUMERIC(12,2) DEFAULT 0;
ALTER TABLE public.parties ADD COLUMN IF NOT EXISTS credit_multiplier NUMERIC(5,2) DEFAULT 1;
ALTER TABLE public.parties ADD COLUMN IF NOT EXISTS use_security_for_credit BOOLEAN DEFAULT false;
ALTER TABLE public.parties ADD COLUMN IF NOT EXISTS is_verified BOOLEAN DEFAULT false;
ALTER TABLE public.parties ADD COLUMN IF NOT EXISTS verified_by UUID;
ALTER TABLE public.parties ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;
ALTER TABLE public.parties ADD COLUMN IF NOT EXISTS salesman_id UUID;
ALTER TABLE public.parties ADD COLUMN IF NOT EXISTS parent_id UUID;
ALTER TABLE public.parties ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'ACTIVE';
ALTER TABLE public.parties ADD COLUMN IF NOT EXISTS party_type_id UUID;
ALTER TABLE public.parties ADD COLUMN IF NOT EXISTS territory_id UUID;
ALTER TABLE public.parties ADD COLUMN IF NOT EXISTS company_id UUID;

-- ─────────────────────────────────────────────────────────────
-- 7. route_parties table (for field checkin / today-route)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.route_parties (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  route_id UUID NOT NULL,
  party_id UUID NOT NULL,
  sequence INTEGER DEFAULT 0,
  visit_day INTEGER,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_route_parties_route_id ON public.route_parties(route_id);
CREATE INDEX IF NOT EXISTS idx_route_parties_party_id ON public.route_parties(party_id);

-- ─────────────────────────────────────────────────────────────
-- 8. credit_control_events table (for credit checker)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.credit_control_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  party_id UUID NOT NULL,
  event_type TEXT NOT NULL,
  details JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_credit_events_party_id ON public.credit_control_events(party_id);

-- ─────────────────────────────────────────────────────────────
-- 9. Reconcile tracking table names
--    Standardize on salesman_location_logs as the canonical table
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.salesman_location_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  salesman_id UUID NOT NULL,
  latitude NUMERIC(10,7),
  longitude NUMERIC(10,7),
  accuracy NUMERIC(10,2),
  battery_level INTEGER,
  recorded_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_location_logs_salesman ON public.salesman_location_logs(salesman_id);
CREATE INDEX IF NOT EXISTS idx_location_logs_recorded ON public.salesman_location_logs(recorded_at);

-- Create gps_logs as an alias view if the table doesn't exist but code references it
-- (Skip if gps_logs already exists as a table)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'gps_logs'
  ) THEN
    CREATE VIEW public.gps_logs AS SELECT * FROM public.salesman_location_logs;
  END IF;
END $$;

-- Create location_logs as an alias view if it doesn't exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'location_logs'
  ) THEN
    CREATE VIEW public.location_logs AS SELECT * FROM public.salesman_location_logs;
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────
-- 10. beat_routes / routes reconciliation
-- ─────────────────────────────────────────────────────────────
-- Create beat_routes if it doesn't exist (some routes reference it)
CREATE TABLE IF NOT EXISTS public.beat_routes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  salesman_id UUID,
  company_id UUID,
  schedule_type TEXT DEFAULT 'DAILY',
  schedule_days INTEGER[] DEFAULT '{}',
  is_active BOOLEAN DEFAULT true,
  status TEXT DEFAULT 'ACTIVE',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_beat_routes_salesman ON public.beat_routes(salesman_id);

-- Create routes as a view of beat_routes if routes table doesn't exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'routes'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'beat_routes'
  ) THEN
    CREATE VIEW public.routes AS SELECT * FROM public.beat_routes;
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────
-- 11. route_stops table (for tracking routes/stops)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.route_stops (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  route_id UUID NOT NULL,
  party_id UUID,
  sequence INTEGER DEFAULT 0,
  address TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_route_stops_route_id ON public.route_stops(route_id);

-- ─────────────────────────────────────────────────────────────
-- 12. warehouses table (for inventory joins)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.warehouses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  address TEXT,
  company_id UUID,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ─────────────────────────────────────────────────────────────
-- 13. salesman_day_sessions unique constraint
--    Required for upsert with onConflict: "salesman_id,date"
-- ─────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'salesman_day_sessions_salesman_date_key'
    AND table_name = 'salesman_day_sessions'
  ) THEN
    ALTER TABLE public.salesman_day_sessions
    ADD CONSTRAINT salesman_day_sessions_salesman_date_key
    UNIQUE (salesman_id, date);
  EXCEPTION WHEN undefined_table THEN
    -- Table doesn't exist yet, skip
    NULL;
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────
-- 14. Notify PostgREST to reload schema cache
-- ─────────────────────────────────────────────────────────────
NOTIFY pgrst, 'reload schema';
