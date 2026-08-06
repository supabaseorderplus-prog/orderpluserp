-- Add ALL missing columns to parties table that the Create Company form sends
-- Run this in Supabase SQL Editor

-- company_id for data isolation
ALTER TABLE public.parties ADD COLUMN IF NOT EXISTS company_id UUID;

-- Form fields collected by Create Company modal
ALTER TABLE public.parties ADD COLUMN IF NOT EXISTS city TEXT;
ALTER TABLE public.parties ADD COLUMN IF NOT EXISTS contact_person TEXT;
ALTER TABLE public.parties ADD COLUMN IF NOT EXISTS pan TEXT;

-- Core party columns that may be missing
ALTER TABLE public.parties ADD COLUMN IF NOT EXISTS portal_password_hash TEXT;
ALTER TABLE public.parties ADD COLUMN IF NOT EXISTS portal_phone TEXT;
ALTER TABLE public.parties ADD COLUMN IF NOT EXISTS is_verified BOOLEAN DEFAULT false;
ALTER TABLE public.parties ADD COLUMN IF NOT EXISTS verified_by UUID;
ALTER TABLE public.parties ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;
ALTER TABLE public.parties ADD COLUMN IF NOT EXISTS salesman_id UUID;
ALTER TABLE public.parties ADD COLUMN IF NOT EXISTS parent_party_id UUID;
ALTER TABLE public.parties ADD COLUMN IF NOT EXISTS territory_id UUID;
ALTER TABLE public.parties ADD COLUMN IF NOT EXISTS party_type_id UUID;
ALTER TABLE public.parties ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'ACTIVE';

NOTIFY pgrst, 'reload schema';
