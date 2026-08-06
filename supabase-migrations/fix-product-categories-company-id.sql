-- Fix: Add company_id column to product_categories table
-- Run this in Supabase Dashboard → SQL Editor to fix:
-- "Could not find the 'company_id' column of 'product_categories' in the schema cache"

-- 1. Add company_id column (stores party/company ID for multi-tenancy)
ALTER TABLE public.product_categories 
ADD COLUMN IF NOT EXISTS company_id UUID;

-- 2. Create index for efficient filtering by company
CREATE INDEX IF NOT EXISTS idx_product_categories_company_id 
ON public.product_categories(company_id);

-- 3. Reload PostgREST schema cache so the new column is recognized immediately
NOTIFY pgrst, 'reload schema';
