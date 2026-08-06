# Fix Categories Error - "Could not find the 'company_id' column"

## Problem
You're getting: **"Could not find the 'company_id' column of 'product_categories' in the schema cache"** when trying to create categories.

## Fix: Run RPC Migration (Bypasses Schema Cache)

The app now uses **database functions** instead of direct table access, so it works even when the PostgREST schema cache is stale.

### Step 1: Open Supabase SQL Editor
Go to your Supabase project → **SQL Editor** → New query.

### Step 2: Run the Full Migration
Copy and paste the **entire contents** of [`supabase-migrations/product-categories-rpc-functions.sql`](supabase-migrations/product-categories-rpc-functions.sql), then click **Run**.

Or run this SQL directly:

```sql
-- Add company_id column
ALTER TABLE public.product_categories ADD COLUMN IF NOT EXISTS company_id UUID;
CREATE INDEX IF NOT EXISTS idx_product_categories_company_id ON public.product_categories(company_id);

-- RPC functions (bypass PostgREST schema cache)
CREATE OR REPLACE FUNCTION public.list_product_categories(p_company_id uuid)
RETURNS TABLE(id uuid, name text) LANGUAGE sql SECURITY DEFINER STABLE AS $$
  SELECT id, name::text FROM public.product_categories WHERE company_id = p_company_id ORDER BY name;
$$;

CREATE OR REPLACE FUNCTION public.create_product_category(p_name text, p_company_id uuid)
RETURNS TABLE(id uuid, name text) LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE new_id uuid;
BEGIN
  INSERT INTO public.product_categories (name, company_id) VALUES (p_name, p_company_id) RETURNING product_categories.id INTO new_id;
  RETURN QUERY SELECT pc.id, pc.name::text FROM public.product_categories pc WHERE pc.id = new_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.delete_product_category(p_id uuid, p_company_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE public.products SET category_id = NULL WHERE category_id = p_id AND company_id = p_company_id;
  DELETE FROM public.product_categories WHERE id = p_id AND company_id = p_company_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.list_product_categories(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.list_product_categories(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_product_category(text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.create_product_category(text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_product_category(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.delete_product_category(uuid, uuid) TO authenticated;
```

### Step 3: Refresh and Try
Refresh your app and try creating a category. It should work immediately.

## What This Fix Does
1. Adds `company_id` column if missing
2. Creates RPC functions that bypass PostgREST's table schema validation
3. The API now calls these functions instead of querying the table directly
