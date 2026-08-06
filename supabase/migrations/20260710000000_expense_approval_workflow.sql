-- Approval-based wallet expenses.
-- PENDING reserves requested_amount; APPROVED realizes approved_amount;
-- REJECTED/CANCELLED release the full reservation. Amounts are never increased
-- by an approver and terminal requests remain immutable through the API.

CREATE TABLE IF NOT EXISTS public.wallet_expenses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  user_name TEXT,
  requester_role TEXT NOT NULL DEFAULT 'UNKNOWN',
  bucket TEXT NOT NULL DEFAULT 'cash',
  amount NUMERIC(15,2) NOT NULL DEFAULT 0,
  requested_amount NUMERIC(15,2) NOT NULL DEFAULT 0,
  approved_amount NUMERIC(15,2),
  category TEXT NOT NULL DEFAULT 'Misc',
  note TEXT,
  company_id UUID,
  created_by UUID,
  status TEXT NOT NULL DEFAULT 'PENDING',
  decided_by UUID,
  decided_by_name TEXT,
  decision_note TEXT,
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.wallet_expenses ADD COLUMN IF NOT EXISTS requester_role TEXT NOT NULL DEFAULT 'UNKNOWN';
ALTER TABLE public.wallet_expenses ADD COLUMN IF NOT EXISTS requested_amount NUMERIC(15,2);
ALTER TABLE public.wallet_expenses ADD COLUMN IF NOT EXISTS approved_amount NUMERIC(15,2);
ALTER TABLE public.wallet_expenses ADD COLUMN IF NOT EXISTS status TEXT;
ALTER TABLE public.wallet_expenses ADD COLUMN IF NOT EXISTS decided_by UUID;
ALTER TABLE public.wallet_expenses ADD COLUMN IF NOT EXISTS decided_by_name TEXT;
ALTER TABLE public.wallet_expenses ADD COLUMN IF NOT EXISTS decision_note TEXT;
ALTER TABLE public.wallet_expenses ADD COLUMN IF NOT EXISTS decided_at TIMESTAMPTZ;
ALTER TABLE public.wallet_expenses ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- Existing pre-approval rows were already treated as realized expenses.
UPDATE public.wallet_expenses
   SET requested_amount = COALESCE(requested_amount, amount),
       approved_amount = COALESCE(approved_amount, amount),
       status = COALESCE(status, 'APPROVED'),
       updated_at = COALESCE(updated_at, created_at, now());

ALTER TABLE public.wallet_expenses ALTER COLUMN requested_amount SET NOT NULL;
ALTER TABLE public.wallet_expenses ALTER COLUMN requested_amount SET DEFAULT 0;
ALTER TABLE public.wallet_expenses ALTER COLUMN status SET NOT NULL;
ALTER TABLE public.wallet_expenses ALTER COLUMN status SET DEFAULT 'PENDING';

DO $$ BEGIN
  ALTER TABLE public.wallet_expenses ADD CONSTRAINT wallet_expenses_bucket_check
    CHECK (bucket IN ('cash', 'bank', 'coupon'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE public.wallet_expenses ADD CONSTRAINT wallet_expenses_status_check
    CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE public.wallet_expenses ADD CONSTRAINT wallet_expenses_amounts_check
    CHECK (
      requested_amount > 0
      AND (approved_amount IS NULL OR (approved_amount > 0 AND approved_amount <= requested_amount))
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_wallet_expenses_company_status
  ON public.wallet_expenses(company_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wallet_expenses_user_status
  ON public.wallet_expenses(user_id, status, created_at DESC);

NOTIFY pgrst, 'reload schema';
