#!/usr/bin/env node

/**
 * Script to add company_id column to product_categories table
 * This fixes the error when creating categories in a company
 */

const SUPABASE_URL = 'https://slgrxczjnburhggnmaew.supabase.co'
const SUPABASE_SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNsZ3J4Y3pqbmJ1cmhnZ25tYWV3Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MTYwNTg1OSwiZXhwIjoyMDg3MTgxODU5fQ.Kv3w4mDrMwFbV4OQXVEVO-Lr7sNGbQFCWuFM_MHs0yo'

async function runMigration() {
  console.log('🚀 Running migration: add-company-id-to-product-categories')
  console.log('This will add the company_id column to product_categories table')
  console.log('')

  try {
    // Execute the migration using Supabase RPC
    const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/exec_sql`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
      },
      body: JSON.stringify({
        sql: `
          -- Add company_id column to product_categories table if it doesn't exist
          ALTER TABLE public.product_categories ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES public.parties(id) ON DELETE CASCADE;
          
          -- Create index on company_id for filtering
          CREATE INDEX IF NOT EXISTS idx_product_categories_company_id ON public.product_categories(company_id);
          
          -- Enable RLS if not already enabled
          ALTER TABLE public.product_categories ENABLE ROW LEVEL SECURITY;
          
          -- Drop existing policies
          DROP POLICY IF EXISTS "Allow authenticated users to read product_categories" ON public.product_categories;
          DROP POLICY IF EXISTS "Allow authenticated users to create product_categories" ON public.product_categories;
          DROP POLICY IF EXISTS "Allow authenticated users to update product_categories" ON public.product_categories;
          DROP POLICY IF EXISTS "Allow authenticated users to delete product_categories" ON public.product_categories;
          
          -- Create new policies that use party_id from app_users
          CREATE POLICY "Allow authenticated users to read product_categories"
          ON public.product_categories FOR SELECT
          TO authenticated
          USING (company_id IN (SELECT party_id FROM app_users WHERE id = auth.uid()));
          
          CREATE POLICY "Allow authenticated users to create product_categories"
          ON public.product_categories FOR INSERT
          TO authenticated
          WITH CHECK (company_id IN (SELECT party_id FROM app_users WHERE id = auth.uid()));
          
          CREATE POLICY "Allow authenticated users to update product_categories"
          ON public.product_categories FOR UPDATE
          TO authenticated
          USING (company_id IN (SELECT party_id FROM app_users WHERE id = auth.uid()))
          WITH CHECK (company_id IN (SELECT party_id FROM app_users WHERE id = auth.uid()));
          
          CREATE POLICY "Allow authenticated users to delete product_categories"
          ON public.product_categories FOR DELETE
          TO authenticated
          USING (company_id IN (SELECT party_id FROM app_users WHERE id = auth.uid()));
        `
      })
    })

    if (!response.ok) {
      const error = await response.json()
      console.error('❌ Migration failed:', error)
      console.log('')
      console.log('Please run the SQL manually in Supabase SQL Editor:')
      console.log('https://supabase.com/dashboard/project/slgrxczjnburhggnmaew/sql/new')
      console.log('')
      console.log('SQL to run:')
      console.log('='.repeat(60))
      console.log(`
-- Add company_id column to product_categories table if it doesn't exist
ALTER TABLE public.product_categories ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES public.parties(id) ON DELETE CASCADE;

-- Create index on company_id for filtering
CREATE INDEX IF NOT EXISTS idx_product_categories_company_id ON public.product_categories(company_id);

-- Enable RLS if not already enabled
ALTER TABLE public.product_categories ENABLE ROW LEVEL SECURITY;

-- Drop existing policies
DROP POLICY IF EXISTS "Allow authenticated users to read product_categories" ON public.product_categories;
DROP POLICY IF EXISTS "Allow authenticated users to create product_categories" ON public.product_categories;
DROP POLICY IF EXISTS "Allow authenticated users to update product_categories" ON public.product_categories;
DROP POLICY IF EXISTS "Allow authenticated users to delete product_categories" ON public.product_categories;

-- Create new policies that use party_id from app_users
CREATE POLICY "Allow authenticated users to read product_categories"
ON public.product_categories FOR SELECT
TO authenticated
USING (company_id IN (SELECT party_id FROM app_users WHERE id = auth.uid()));

CREATE POLICY "Allow authenticated users to create product_categories"
ON public.product_categories FOR INSERT
TO authenticated
WITH CHECK (company_id IN (SELECT party_id FROM app_users WHERE id = auth.uid()));

CREATE POLICY "Allow authenticated users to update product_categories"
ON public.product_categories FOR UPDATE
TO authenticated
USING (company_id IN (SELECT party_id FROM app_users WHERE id = auth.uid()))
WITH CHECK (company_id IN (SELECT party_id FROM app_users WHERE id = auth.uid()));

CREATE POLICY "Allow authenticated users to delete product_categories"
ON public.product_categories FOR DELETE
TO authenticated
USING (company_id IN (SELECT party_id FROM app_users WHERE id = auth.uid()));
      `)
      console.log('='.repeat(60))
      process.exit(1)
    }

    console.log('✅ Migration completed successfully!')
    console.log('✅ company_id column added to product_categories table')
    console.log('✅ RLS policies updated for company scoping')
    console.log('')
    console.log('You can now create categories in your company.')
    
  } catch (error) {
    console.error('❌ Migration failed:', error.message)
    console.log('')
    console.log('Please run the SQL manually in Supabase SQL Editor:')
    console.log('https://supabase.com/dashboard/project/slgrxczjnburhggnmaew/sql/new')
    process.exit(1)
  }
}

runMigration()
