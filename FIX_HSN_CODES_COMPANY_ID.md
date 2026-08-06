# Fix HSN Codes Company ID Column - Complete Guide

## Problem
When creating GST templates, you're getting this error:
```
Could not find the 'company_id' column of 'hsn_codes' in the schema cache
```

## Root Cause
The `hsn_codes` table is missing the `company_id` column that is required for proper multi-tenant functionality and RLS policies.

## Solution - Run This SQL in Supabase SQL Editor

### Step 1: Go to Supabase SQL Editor
1. Go to https://supabase.com/dashboard
2. Select your project (slgrxczjnburhggnmaew)
3. Go to **SQL Editor** in the left sidebar
4. Click **New Query**

### Step 2: Run the SQL
Copy and paste the following SQL into the SQL Editor and click **Run**:

```sql
-- Add company_id column to hsn_codes table for multi-tenant support

-- Add the company_id column
ALTER TABLE public.hsn_codes
ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES public.parties(id) ON DELETE CASCADE;

-- Create index for better performance
CREATE INDEX IF NOT EXISTS idx_hsn_codes_company_id ON public.hsn_codes(company_id);

-- Enable Row Level Security
ALTER TABLE public.hsn_codes ENABLE ROW LEVEL SECURITY;

-- Drop existing policies if they exist
DROP POLICY IF EXISTS "Allow authenticated users to read hsn_codes" ON public.hsn_codes;
DROP POLICY IF EXISTS "Allow authenticated users to create hsn_codes" ON public.hsn_codes;
DROP POLICY IF EXISTS "Allow authenticated users to update hsn_codes" ON public.hsn_codes;
DROP POLICY IF EXISTS "Allow authenticated users to delete hsn_codes" ON public.hsn_codes;

-- Create new policies with company scoping
CREATE POLICY "Allow authenticated users to read hsn_codes"
ON public.hsn_codes FOR SELECT
TO authenticated
USING (company_id IN (SELECT party_id FROM app_users WHERE id = auth.uid()));

CREATE POLICY "Allow authenticated users to create hsn_codes"
ON public.hsn_codes FOR INSERT
TO authenticated
WITH CHECK (company_id IN (SELECT party_id FROM app_users WHERE id = auth.uid()));

CREATE POLICY "Allow authenticated users to update hsn_codes"
ON public.hsn_codes FOR UPDATE
TO authenticated
USING (company_id IN (SELECT party_id FROM app_users WHERE id = auth.uid()))
WITH CHECK (company_id IN (SELECT party_id FROM app_users WHERE id = auth.uid()));

CREATE POLICY "Allow authenticated users to delete hsn_codes"
ON public.hsn_codes FOR DELETE
TO authenticated
USING (company_id IN (SELECT party_id FROM app_users WHERE id = auth.uid()));
```

### Step 3: Verify the Fix
After running the SQL, verify the column was added by running this query:

```sql
-- Check that the column exists
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'hsn_codes'
AND column_name = 'company_id';

-- Check that RLS is enabled
SELECT schemaname, tablename, rowsecurity
FROM pg_tables
WHERE tablename = 'hsn_codes';
```

You should see:
- A row showing `company_id` column exists
- `rowsecurity` should be `t` (true) for the hsn_codes table

## After Applying the Fix
Once you've run the SQL in Supabase, try creating a GST template again. The error should be resolved.

## Quick Copy-Paste SQL
```sql
ALTER TABLE public.hsn_codes ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES public.parties(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_hsn_codes_company_id ON public.hsn_codes(company_id);
ALTER TABLE public.hsn_codes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow authenticated users to read hsn_codes" ON public.hsn_codes;
DROP POLICY IF EXISTS "Allow authenticated users to create hsn_codes" ON public.hsn_codes;
DROP POLICY IF EXISTS "Allow authenticated users to update hsn_codes" ON public.hsn_codes;
DROP POLICY IF EXISTS "Allow authenticated users to delete hsn_codes" ON public.hsn_codes;
CREATE POLICY "Allow authenticated users to read hsn_codes" ON public.hsn_codes FOR SELECT TO authenticated USING (company_id IN (SELECT party_id FROM app_users WHERE id = auth.uid()));
CREATE POLICY "Allow authenticated users to create hsn_codes" ON public.hsn_codes FOR INSERT TO authenticated WITH CHECK (company_id IN (SELECT party_id FROM app_users WHERE id = auth.uid()));
CREATE POLICY "Allow authenticated users to update hsn_codes" ON public.hsn_codes FOR UPDATE TO authenticated USING (company_id IN (SELECT party_id FROM app_users WHERE id = auth.uid())) WITH CHECK (company_id IN (SELECT party_id FROM app_users WHERE id = auth.uid()));
CREATE POLICY "Allow authenticated users to delete hsn_codes" ON public.hsn_codes FOR DELETE TO authenticated USING (company_id IN (SELECT party_id FROM app_users WHERE id = auth.uid()));