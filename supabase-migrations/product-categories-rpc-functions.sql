-- RPC functions for product_categories - bypasses PostgREST schema cache
-- NOTE: If you already ran a migration with wrong parameter order, use FIX-product-categories-rpc.sql instead
-- Run this in Supabase SQL Editor if you still get "company_id column not in schema cache" after adding the column

-- 1. Ensure company_id column exists
ALTER TABLE public.product_categories ADD COLUMN IF NOT EXISTS company_id UUID;
CREATE INDEX IF NOT EXISTS idx_product_categories_company_id ON public.product_categories(company_id);

-- 2. Create function to list categories (bypasses schema cache)
CREATE OR REPLACE FUNCTION public.list_product_categories(p_company_id uuid)
RETURNS TABLE(id uuid, name text)
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT id, name::text FROM public.product_categories
  WHERE company_id = p_company_id
  ORDER BY name;
$$;

-- 3. Create function to insert a category (bypasses schema cache)
CREATE OR REPLACE FUNCTION public.create_product_category(p_company_id uuid, p_name text)
RETURNS TABLE(id uuid, name text)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  new_id uuid;
BEGIN
  INSERT INTO public.product_categories (name, company_id)
  VALUES (p_name, p_company_id)
  RETURNING product_categories.id INTO new_id;
  RETURN QUERY SELECT pc.id, pc.name::text FROM public.product_categories pc WHERE pc.id = new_id;
END;
$$;

-- 4. Create function to delete a category (bypasses schema cache)
CREATE OR REPLACE FUNCTION public.delete_product_category(p_id uuid, p_company_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE public.products SET category_id = NULL WHERE category_id = p_id AND company_id = p_company_id;
  DELETE FROM public.product_categories WHERE id = p_id AND company_id = p_company_id;
END;
$$;

-- Grant execute to service_role and authenticated
GRANT EXECUTE ON FUNCTION public.list_product_categories(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.list_product_categories(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_product_category(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.create_product_category(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_product_category(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.delete_product_category(uuid, uuid) TO authenticated;
