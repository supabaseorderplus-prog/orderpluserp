-- Add proof_url column to the payments table
-- Fixes: "Could not find the 'proof_url' column of 'payments' in the schema cache"

ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS proof_url TEXT;

-- Reload PostgREST schema cache so the column is immediately available
NOTIFY pgrst, 'reload schema';
