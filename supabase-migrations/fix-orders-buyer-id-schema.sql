-- ============================================================
-- FIX: orders table — add buyer_id and other columns expected
-- by the updated Next.js orders API route.
--
-- Run in Supabase SQL Editor: Dashboard > SQL Editor
-- ============================================================

-- Add buyer_id as the canonical party reference (new schema name)
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS buyer_id UUID;

-- Back-fill buyer_id from billing_party_id for existing rows
UPDATE public.orders
SET buyer_id = billing_party_id
WHERE buyer_id IS NULL AND billing_party_id IS NOT NULL;

-- Add seller_id (company that created the order)
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS seller_id UUID;

-- Add status column (separate from order_status) as TEXT with default
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'PENDING';

-- Back-fill status from order_status for existing rows
UPDATE public.orders
SET status = order_status
WHERE status IS NULL AND order_status IS NOT NULL;

-- Add payment columns
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS payment_mode TEXT DEFAULT 'CREDIT';
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS payment_status TEXT DEFAULT 'UNPAID';
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(12,2) DEFAULT 0;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS gst_amount NUMERIC(12,2) DEFAULT 0;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS grand_total NUMERIC(12,2) DEFAULT 0;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS subtotal NUMERIC(12,2) DEFAULT 0;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS approved_by UUID;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS approval_time TIMESTAMPTZ;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS created_by UUID;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS order_number TEXT;

-- Add missing order_items columns
ALTER TABLE public.order_items ADD COLUMN IF NOT EXISTS discount_percent NUMERIC(5,2) DEFAULT 0;
ALTER TABLE public.order_items ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(12,2) DEFAULT 0;
ALTER TABLE public.order_items ADD COLUMN IF NOT EXISTS gst_amount NUMERIC(12,2) DEFAULT 0;
ALTER TABLE public.order_items ADD COLUMN IF NOT EXISTS line_total NUMERIC(12,2) DEFAULT 0;

-- Notify PostgREST to reload schema cache
NOTIFY pgrst, 'reload schema';
