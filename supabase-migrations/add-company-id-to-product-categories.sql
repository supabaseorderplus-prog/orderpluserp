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
