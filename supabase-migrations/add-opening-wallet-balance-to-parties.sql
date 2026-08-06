-- Add opening_balance and wallet_balance columns to parties table
-- Run this in Supabase SQL Editor
--
-- opening_balance: the fixed starting balance set when a party is onboarded.
--                  Positive = party owes you (they received credit from you).
--                  Negative = you owe the party (they made an advance payment).
--
-- wallet_balance:  running ledger delta driven by transactions (payments, invoices).
--                  Always initialised to 0 at party creation.
--
-- Effective balance displayed to users = wallet_balance + opening_balance

ALTER TABLE public.parties ADD COLUMN IF NOT EXISTS opening_balance NUMERIC(15, 2) NOT NULL DEFAULT 0;
ALTER TABLE public.parties ADD COLUMN IF NOT EXISTS wallet_balance  NUMERIC(15, 2) NOT NULL DEFAULT 0;

NOTIFY pgrst, 'reload schema';
