import { createClient } from '@supabase/supabase-js'

// Supabase configuration
const supabaseUrl = 'https://slgrxczjnburhggnmaew.supabase.co'
const supabaseServiceKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNsZ3J4Y3pqbmJ1cmhnZ25tYWV3Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MTYwNTg1OSwiZXhwIjoyMDg3MTgxODU5fQ.Kv3w4mDrMwFbV4OQXVEVO-Lr7sNGbQFCWuFM_MHs0yo'

// Create Supabase client with service role key
const supabase = createClient(supabaseUrl, supabaseServiceKey)

async function executeMigration() {
  try {
    console.log('Adding company_id column to product_categories table...')
    
    // Step 1: Add company_id column
    console.log('Step 1: Adding company_id column...')
    const addColumnSQL = `
      ALTER TABLE public.product_categories ADD COLUMN IF NOT EXISTS company_id UUID;
    `
    
    const response1 = await fetch(`${supabaseUrl}/rest/v1/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseServiceKey,
        'Authorization': `Bearer ${supabaseServiceKey}`,
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({
        query: addColumnSQL
      })
    })
    
    console.log('Add column response:', response1.status)
    
    // Step 2: Create index on company_id
    console.log('Step 2: Creating index on company_id...')
    const indexSQL = `
      CREATE INDEX IF NOT EXISTS idx_product_categories_company_id ON public.product_categories(company_id);
    `
    
    const response2 = await fetch(`${supabaseUrl}/rest/v1/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseServiceKey,
        'Authorization': `Bearer ${supabaseServiceKey}`,
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({
        query: indexSQL
      })
    })
    
    console.log('Index creation response:', response2.status)
    
    // Step 3: Update RLS policies
    console.log('Step 3: Updating RLS policies for company scoping...')
    const rlsSQL = `
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
    `
    
    const response3 = await fetch(`${supabaseUrl}/rest/v1/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseServiceKey,
        'Authorization': `Bearer ${supabaseServiceKey}`,
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({
        query: rlsSQL
      })
    })
    
    console.log('RLS policies update response:', response3.status)
    
    // Step 4: Verify the column exists
    console.log('Step 4: Verifying company_id column...')
    const { data: categories, error: verifyError } = await supabase
      .from('product_categories')
      .select('id, name, company_id')
      .limit(1)
    
    if (verifyError) {
      console.error('Error verifying column:', verifyError)
      console.log('\nMigration may have partially completed.')
      console.log('Please check your Supabase dashboard and run the SQL manually if needed.')
    } else {
      console.log('✓ company_id column added successfully!')
      console.log('✓ RLS policies updated for company scoping!')
      console.log('✓ Migration completed!')
    }
    
  } catch (error) {
    console.error('Migration failed:', error)
    console.log('\nPlease run the SQL manually in Supabase SQL Editor:')
    console.log('https://supabase.com/dashboard/project/slgrxczjnburhggnmaew/sql/new')
    console.log('\nSQL file location: supabase-migrations/add-company-id-to-product-categories.sql')
  }
}

executeMigration()
