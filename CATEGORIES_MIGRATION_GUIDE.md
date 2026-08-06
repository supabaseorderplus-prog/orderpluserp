d m i ded# Categories Table Migration Guide

## Problem
The `categories` table doesn't exist in your Supabase database, causing the error:
```
Could not find the table 'public.categories' in the schema cache
```

## Solution
You need to create the `categories` table in your Supabase database.

## Steps to Fix

### Option 1: Run SQL in Supabase SQL Editor (Recommended)

1. Go to your Supabase SQL Editor:
   https://supabase.com/dashboard/project/slgrxczjnburhggnmaew/sql/new

2. Copy and paste the following SQL:

```sql
-- Create categories table
CREATE TABLE IF NOT EXISTS public.categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  parent_category_id UUID REFERENCES public.categories(id) ON DELETE SET NULL,
  description TEXT,
  icon_url VARCHAR(500),
  status VARCHAR(20) DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE', 'DELETED')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  created_by UUID
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_categories_parent_category_id ON public.categories(parent_category_id);
CREATE INDEX IF NOT EXISTS idx_categories_status ON public.categories(status);
CREATE INDEX IF NOT EXISTS idx_categories_name ON public.categories(name);

-- Enable Row Level Security
ALTER TABLE public.categories ENABLE ROW LEVEL SECURITY;

-- Create policies for authenticated users
CREATE POLICY IF NOT EXISTS "Allow authenticated users to read categories"
ON public.categories FOR SELECT
TO authenticated
USING (true);

CREATE POLICY IF NOT EXISTS "Allow authenticated users to create categories"
ON public.categories FOR INSERT
TO authenticated
WITH CHECK (true);

CREATE POLICY IF NOT EXISTS "Allow authenticated users to update categories"
ON public.categories FOR UPDATE
TO authenticated
USING (true)
WITH CHECK (true);

CREATE POLICY IF NOT EXISTS "Allow authenticated users to delete categories"
ON public.categories FOR DELETE
TO authenticated
USING (true);

-- Create function to update updated_at timestamp
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger to automatically update updated_at
DROP TRIGGER IF EXISTS update_categories_updated_at ON public.categories;
CREATE TRIGGER update_categories_updated_at
BEFORE UPDATE ON public.categories
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

-- Insert default categories
INSERT INTO public.categories (name, description) VALUES
  ('Electronics', 'Electronic products and devices'),
  ('Chemicals', 'Chemical products and materials'),
  ('Construction', 'Construction materials and supplies'),
  ('Industrial', 'Industrial equipment and supplies'),
  ('Packaging', 'Packaging materials and supplies')
ON CONFLICT DO NOTHING;
```

3. Click "Run" to execute the SQL

4. Verify the table was created by checking the "Table Editor" in Supabase

### Option 2: Use Supabase CLI (if installed)

If you have the Supabase CLI installed, you can run:

```bash
supabase db push
```

This will apply all pending migrations including the categories table.

## Verification

After running the migration, try creating a category in your application. The error should be resolved.

## Files Created

- `supabase-migrations/create_categories_table.sql` - The SQL migration file
- `scripts/create-categories-table.mjs` - Script to run migration (requires manual SQL execution)
- `scripts/create-categories-table-v2.mjs` - Alternative migration script

## API Route Fixed

The API route at `src/app/api/v1/product-categories/route.ts` has been updated to:
- Use the correct table name: `categories` (not `product_categories`)
- Remove company_id filtering (since categories table doesn't have that column)
