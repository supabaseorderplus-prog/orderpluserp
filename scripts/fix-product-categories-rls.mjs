import { createClient } from '@supabase/supabase-js'

// Supabase configuration from environment
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://slgrxczjnburhggnmaew.supabase.co'
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNsZ3J4Y3pqbmJ1cmhnZ25tYWV3Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MTYwNTg1OSwiZXhwIjoyMDg3MTgxODU5fQ.Kv3w4mDrMwFbV4OQXVEVO-Lr7sNGbQFCWuFM_MHs0yo'

// Create Supabase client with service role key
const supabase = createClient(supabaseUrl, supabaseServiceKey)

async function fixRLSPolicies() {
  try {
    console.log('Fixing RLS policies for product_categories table...')
    console.log('The issue: RLS policies may not be correctly set up.')
    console.log('')
    
    // First, let's check current policies
    console.log('Checking current RLS policies...')
    const { data: currentPolicies, error: policiesError } = await supabase
      .from('pg_policies')
      .select('polname, polpermissive, polroles, polcmd, polqual')
      .eq('schemaname', 'public')
      .eq('tablename', 'product_categories')
    
    if (policiesError) {
      console.log('Could not fetch current policies:', policiesError.message)
    } else {
      console.log('Current policies:', JSON.stringify(currentPolicies, null, 2))
    }
    
    // Check if table exists
    console.log('\nChecking if product_categories table exists...')
    const { data: tableExists, error: tableError } = await supabase
      .from('information_schema.tables')
      .select('table_name')
      .eq('table_schema', 'public')
      .eq('table_name', 'product_categories')
      .single()
    
    if (tableError || !tableExists) {
      console.log('Table does not exist! Creating it...')
      
      // Create the table first
      const createTableSQL = `
        CREATE TABLE IF NOT EXISTS public.product_categories (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          name VARCHAR(255) NOT NULL,
          company_id UUID REFERENCES public.parties(id) ON DELETE CASCADE,
          description TEXT,
          status VARCHAR(20) DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE', 'DELETED')),
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        );
        
        CREATE INDEX IF NOT EXISTS idx_product_categories_company_id ON public.product_categories(company_id);
        CREATE INDEX IF NOT EXISTS idx_product_categories_name ON public.product_categories(name);
      `
      
      const { error: createError } = await supabase.rpc('exec_sql', { query: createTableSQL })
      
      if (createError) {
        console.log('Error creating table via RPC:', createError.message)
        console.log('\nPlease create the table manually in Supabase SQL Editor:')
        console.log('https://supabase.com/dashboard/project/slgrxczjnburhggnmaew/sql/new')
        console.log('\nSQL to run:')
        console.log(createTableSQL)
        return
      }
    } else {
      console.log('Table exists!')
    }
    
    // Now let's try to fix the RLS policies using raw SQL
    console.log('\nAttempting to fix RLS policies...')
    
    const sql = `
      -- Enable RLS if not already enabled
      ALTER TABLE public.product_categories ENABLE ROW LEVEL SECURITY;
      
      -- Drop existing policies
      DROP POLICY IF EXISTS "Allow authenticated users to read product_categories" ON public.product_categories;
      DROP POLICY IF EXISTS "Allow authenticated users to create product_categories" ON public.product_categories;
      DROP POLICY IF EXISTS "Allow authenticated users to update product_categories" ON public.product_categories;
      DROP POLICY IF EXISTS "Allow authenticated users to delete product_categories" ON public.product_categories;
      
      -- Create new policies that use party_id instead of company_id
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
    
    // Try using the postgres extension to execute SQL
    // Since we can't execute raw SQL directly, let's inform the user
    console.log('\nSince we cannot execute raw SQL directly, please run the following in Supabase SQL Editor:')
    console.log('https://supabase.com/dashboard/project/slgrxczjnburhggnmaew/sql/new')
    console.log('\n' + '='.repeat(60))
    console.log('SQL TO RUN:')
    console.log('='.repeat(60))
    console.log(sql)
    console.log('='.repeat(60))
    console.log('\nOR - let me try an alternative approach using the API...')
    
  } catch (error) {
    console.error('Failed to fix RLS policies:', error)
  }
}

fixRLSPolicies()
