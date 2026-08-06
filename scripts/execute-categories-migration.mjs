import { createClient } from '@supabase/supabase-js'

// Supabase configuration
const supabaseUrl = 'https://slgrxczjnburhggnmaew.supabase.co'
const supabaseServiceKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNsZ3J4Y3pqbmJ1cmhnZ25tYWV3Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MTYwNTg1OSwiZXhwIjoyMDg3MTgxODU5fQ.Kv3w4mDrMwFbV4OQXVEVO-Lr7sNGbQFCWuFM_MHs0yo'

// Create Supabase client with service role key
const supabase = createClient(supabaseUrl, supabaseServiceKey)

async function executeMigration() {
  try {
    console.log('Creating categories table...')
    
    // Step 1: Create the table
    console.log('Step 1: Creating categories table...')
    const createTableSQL = `
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
        query: createTableSQL
      })
    })
    
    console.log('Table creation response:', response1.status)
    
    // Step 2: Create indexes
    console.log('Step 2: Creating indexes...')
    const indexesSQL = `
      CREATE INDEX IF NOT EXISTS idx_categories_parent_category_id ON public.categories(parent_category_id);
      CREATE INDEX IF NOT EXISTS idx_categories_status ON public.categories(status);
      CREATE INDEX IF NOT EXISTS idx_categories_name ON public.categories(name);
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
        query: indexesSQL
      })
    })
    
    console.log('Indexes creation response:', response2.status)
    
    // Step 3: Enable RLS and create policies
    console.log('Step 3: Enabling RLS and creating policies...')
    const rlsSQL = `
      ALTER TABLE public.categories ENABLE ROW LEVEL SECURITY;
      
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
    
    console.log('RLS policies response:', response3.status)
    
    // Step 4: Create trigger function
    console.log('Step 4: Creating trigger function...')
    const triggerSQL = `
      CREATE OR REPLACE FUNCTION public.update_updated_at_column()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.updated_at = NOW();
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      
      DROP TRIGGER IF EXISTS update_categories_updated_at ON public.categories;
      CREATE TRIGGER update_categories_updated_at
      BEFORE UPDATE ON public.categories
      FOR EACH ROW
      EXECUTE FUNCTION public.update_updated_at_column();
    `
    
    const response4 = await fetch(`${supabaseUrl}/rest/v1/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseServiceKey,
        'Authorization': `Bearer ${supabaseServiceKey}`,
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({
        query: triggerSQL
      })
    })
    
    console.log('Trigger creation response:', response4.status)
    
    // Step 5: Insert default categories
    console.log('Step 5: Inserting default categories...')
    const { data, error } = await supabase
      .from('categories')
      .insert([
        { name: 'Electronics', description: 'Electronic products and devices' },
        { name: 'Chemicals', description: 'Chemical products and materials' },
        { name: 'Construction', description: 'Construction materials and supplies' },
        { name: 'Industrial', description: 'Industrial equipment and supplies' },
        { name: 'Packaging', description: 'Packaging materials and supplies' }
      ])
      .select()
    
    if (error) {
      console.log('Note: Default categories may already exist:', error.message)
    } else {
      console.log('Default categories inserted:', data?.length || 0)
    }
    
    // Verify the table exists
    console.log('Step 6: Verifying table creation...')
    const { data: categories, error: verifyError } = await supabase
      .from('categories')
      .select('*')
      .limit(1)
    
    if (verifyError) {
      console.error('Error verifying table:', verifyError)
      console.log('\nMigration may have partially completed.')
      console.log('Please check your Supabase dashboard and run the SQL manually if needed.')
    } else {
      console.log('✓ Categories table created successfully!')
      console.log('✓ Migration completed!')
    }
    
  } catch (error) {
    console.error('Migration failed:', error)
    console.log('\nPlease run the SQL manually in Supabase SQL Editor:')
    console.log('https://supabase.com/dashboard/project/slgrxczjnburhggnmaew/sql/new')
    console.log('\nSQL file location: supabase-migrations/create_categories_table.sql')
  }
}

executeMigration()
