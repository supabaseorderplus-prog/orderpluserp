-- ============================================================================
-- FIX: Product Categories RPC Functions
-- Run this ONCE in Supabase Dashboard → SQL Editor
-- Fixes "Could not find the function public.create_product_category" error
-- ============================================================================

-- 1. Ensure company_id column exists
ALTER TABLE public.product_categories ADD COLUMN IF NOT EXISTS company_id UUID;
CREATE INDEX IF NOT EXISTS idx_product_categories_company_id ON public.product_categories(company_id);

-- 2. Drop ALL possible function signatures (both old parameter orders)
DROP FUNCTION IF EXISTS public.create_product_category(uuid, text);
DROP FUNCTION IF EXISTS public.create_product_category(text, uuid);
DROP FUNCTION IF EXISTS public.list_product_categories(uuid);
DROP FUNCTION IF EXISTS public.delete_product_category(uuid, uuid);

-- 3. Create list_product_categories
CREATE FUNCTION public.list_product_categories(p_company_id uuid)
RETURNS TABLE(id uuid, name text)
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT pc.id, pc.name::text FROM public.product_categories pc
  WHERE pc.company_id = p_company_id
  ORDER BY pc.name;
$$;

-- 4. Create create_product_category (parameter order: p_company_id, p_name)
CREATE FUNCTION public.create_product_category(p_company_id uuid, p_name text)
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

-- 5. Create delete_product_category
CREATE FUNCTION public.delete_product_category(p_id uuid, p_company_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE public.products SET category_id = NULL WHERE category_id = p_id AND company_id = p_company_id;
  DELETE FROM public.product_categories WHERE id = p_id AND company_id = p_company_id;
END;
$$;

-- 6. Grant permissions
GRANT EXECUTE ON FUNCTION public.list_product_categories(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.list_product_categories(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_product_category(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.create_product_category(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_product_category(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.delete_product_category(uuid, uuid) TO authenticated;

-- 7. Reload PostgREST schema cache
NOTIFY pgrst, 'reload schema';
