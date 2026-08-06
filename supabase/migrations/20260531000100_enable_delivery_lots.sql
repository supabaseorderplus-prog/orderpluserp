-- Delivery Lots schema for procurement -> lot conversion.
-- Safe to run repeatedly.

CREATE TABLE IF NOT EXISTS public.delivery_lots (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lot_number    text NOT NULL,
  name          text NOT NULL DEFAULT '',
  status        text NOT NULL DEFAULT 'OPEN',
  dispatch_date date,
  destination   text DEFAULT '',
  vehicle_no    text DEFAULT '',
  notes         text DEFAULT '',
  driver_id     uuid,
  driver_name   text DEFAULT '',
  company_id    uuid,
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.delivery_lot_orders (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lot_id               uuid NOT NULL REFERENCES public.delivery_lots(id) ON DELETE CASCADE,
  order_id             uuid NOT NULL,
  invoice_number       text DEFAULT '',
  party_name           text DEFAULT '',
  grand_total          numeric DEFAULT 0,
  manufacturing_status text DEFAULT 'Not Started',
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS delivery_lot_orders_lot_order_idx
  ON public.delivery_lot_orders(lot_id, order_id);

CREATE INDEX IF NOT EXISTS delivery_lots_company_created_idx
  ON public.delivery_lots(company_id, created_at DESC);

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.delivery_lots;
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN undefined_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.delivery_lot_orders;
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN undefined_object THEN NULL;
END $$;

NOTIFY pgrst, 'reload schema';
