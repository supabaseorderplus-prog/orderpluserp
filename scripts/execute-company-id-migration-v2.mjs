import { createClient } from '@supabase/supabase-js'

// Supabase configuration
const supabaseUrl = 'https://slgrxczjnburhggnmaew.supabase.co'
const supabaseServiceKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNsZ3J4Y3pqbmJ1cmhnZ25tYWV3Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MTYwNTg1OSwiZXhwIjoyMDg3MTgxODU5fQ.Kv3w4mDrMwFbV4OQXVEVO-Lr7sNGbQFCWuFM_MHs0yo'

// Create Supabase client with service role key
const supabase = createClient(supabaseUrl, supabaseServiceKey)

async function executeMigration() {
  try {
    console.log('Adding company_id column to product_categories table...')
    
    // Use the Supabase Management API to execute SQL
    const managementUrl = 'https://api.supabase.com/v1/projects/slgrxczjnburhggnmaew/database/query'
    
    const sql = `
      ALTER TABLE public.product_categories ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES public.parties(id) ON DELETE CASCADE;
      CREATE INDEX IF NOT EXISTS idx_product_categories_company_id ON public.product_categories(company_id);
      DROP POLICY IF EXISTS "Allow authenticated users to read product_categories" ON public.product_categories;
      CREATE POLICY "Allow authenticated users to read product_categories"
      ON public.product_categories FOR SELECT
      TO authenticated
      USING (company_id IN (SELECT party_id FROM app_users WHERE id = auth.uid()));
      DROP POLICY IF EXISTS "Allow authenticated users to create product_categories" ON public.product_categories;
      CREATE POLICY "Allow authenticated users to create product_categories"
      ON public.product_categories FOR INSERT
      TO authenticated
      WITH CHECK (company_id IN (SELECT party_id FROM app_users WHERE id = auth.uid()));
      DROP POLICY IF EXISTS "Allow authenticated users to update product_categories" ON public.product_categories;
      CREATE POLICY "Allow authenticated users to update product_categories"
      ON public.product_categories FOR UPDATE
      TO authenticated
      USING (company_id IN (SELECT party_id FROM app_users WHERE id = auth.uid()))
      WITH CHECK (company_id IN (SELECT party_id FROM app_users WHERE id = auth.uid()));
      DROP POLICY IF EXISTS "Allow authenticated users to delete product_categories" ON public.product_categories;
      CREATE POLICY "Allow authenticated users to delete product_categories"
      ON public.product_categories FOR DELETE
      TO authenticated
      USING (company_id IN (SELECT party_id FROM app_users WHERE id = auth.uid()));
    `
    
    const response = await fetch(managementUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseServiceKey,
        'Authorization': `Bearer ${supabaseServiceKey}`
      },
      body: JSON.stringify({
        query: sql
      })
    })
    
    if (response.ok) {
      console.log('✓ Migration completed successfully!')
      console.log('✓ company_id column added!')
      console.log('✓ RLS policies updated for company scoping!')
    } else {
      const error = await response.json()
      console.error('Error executing migration:', error)
      console.log('\nPlease run the SQL manually in Supabase SQL Editor:')
      console.log('https://supabase.com/dashboard/project/slgrxczjnburhggnmaew/sql/new')
      console.log('\nSQL file location: supabase-migrations/add-company-id-to-product-categories.sql')
    }
    
  } catch (error) {
    console.error('Migration failed:', error)
    console.log('\nPlease run the SQL manually in Supabase SQL Editor:')
    console.log('https://supabase.com/dashboard/project/slgrxczjnburhggnmaew/sql/new')
    console.log('\nSQL file location: supabase-migrations/add-company-id-to-product-categories.sql')
  }
}

executeMigration()
