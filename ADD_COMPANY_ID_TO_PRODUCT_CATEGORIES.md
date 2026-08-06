# Add company_id to product_categories - MANUAL EXECUTION REQUIRED

## Problem
The `product_categories` table doesn't have a `company_id` column, so all companies can see each other's categories. This is a security issue.

## Solution
You need to manually run the SQL in Supabase SQL Editor to add `company_id` column and update RLS policies.

## Steps to Fix

### Step 1: Go to Supabase SQL Editor
Open this URL in your browser:
https://supabase.com/dashboard/project/slgrxczjnburhggnmaew/sql/new

### Step 2: Copy and Paste the SQL
Copy the following SQL and paste it into the SQL Editor:

```sql
-- Add company_id column to product_categories table
ALTER TABLE public.product_categories ADD COLUMN IF NOT EXISTS company_id UUID;

-- Create index on company_id for filtering
CREATE INDEX IF NOT EXISTS idx_product_categories_company_id ON public.product_categories(company_id);

-- Update RLS policies to filter by company_id
DROP POLICY IF EXISTS "Allow authenticated users to read product_categories" ON public.product_categories;
CREATE POLICY "Allow authenticated users to read product_categories"
ON public.product_categories FOR SELECT
TO authenticated
USING (company_id IN (SELECT company_id FROM app_users WHERE id = auth.uid()));

DROP POLICY IF EXISTS "Allow authenticated users to create product_categories" ON public.product_categories;
CREATE POLICY "Allow authenticated users to create product_categories"
ON public.product_categories FOR INSERT
TO authenticated
WITH CHECK (company_id IN (SELECT company_id FROM app_users WHERE id = auth.uid()));

DROP POLICY IF EXISTS "Allow authenticated users to update product_categories" ON public.product_categories;
CREATE POLICY "Allow authenticated users to update product_categories"
ON public.product_categories FOR UPDATE
TO authenticated
USING (company_id IN (SELECT company_id FROM app_users WHERE id = auth.uid()))
WITH CHECK (company_id IN (SELECT company_id FROM app_users WHERE id = auth.uid()));

DROP POLICY IF EXISTS "Allow authenticated users to delete product_categories" ON public.product_categories;
CREATE POLICY "Allow authenticated users to delete product_categories"
ON public.product_categories FOR DELETE
TO authenticated
USING (company_id IN (SELECT company_id FROM app_users WHERE id = auth.uid()));
```

### Step 3: Click "Run"
Click the "Run" button to execute the SQL.

### Step 4: Verify
After running the SQL, you should see a success message. The `product_categories` table now has:
- `company_id` column
- Index on `company_id`
- RLS policies that filter by company

## What This Does
1. Adds `company_id` column to track which company owns each category
2. Creates an index for fast filtering by company
3. Updates RLS policies so users can only see their own company's categories

## After Running This SQL
The API route will automatically use the `company_id` column to filter categories. Each company will only see their own categories.

## Files Created
- [`supabase-migrations/add-company-id-to-product-categories.sql`](supabase-migrations/add-company-id-to-product-categories.sql) - SQL migration file
- [`scripts/execute-company-id-migration.mjs`](scripts/execute-company-id-migration.mjs) - Migration script (requires manual SQL execution)
