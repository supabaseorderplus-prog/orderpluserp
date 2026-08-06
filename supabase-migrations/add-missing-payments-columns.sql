-- Add missing columns to the payments table
-- Fixes: "Could not find the 'bank_name' column of 'payments' in the schema cache"

ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS bank_name       TEXT;
ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS payment_number  TEXT;
ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS party_id        UUID;
ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS notes           TEXT;
