import { createClient } from '@supabase/supabase-js'

// Supabase configuration
const supabaseUrl = 'https://slgrxczjnburhggnmaew.supabase.co'
const supabaseServiceKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNsZ3J4Y3pqbmJ1cmhnZ25tYWV3Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MTYwNTg1OSwiZXhwIjoyMDg3MTgxODU5fQ.Kv3w4mDrMwFbV4OQXVEVO-Lr7sNGbQFCWuFM_MHs0yo'

// Create Supabase client with service role key
const supabase = createClient(supabaseUrl, supabaseServiceKey)

async function runHsnCodesMigration() {
  console.log('Running add-company-id-to-hsn-codes migration...\n')

  try {
    // Add company_id column to hsn_codes table if it doesn't exist
    console.log('Adding company_id column...')
    const { error: alterError } = await supabase.rpc('exec_sql', {
      sql: `ALTER TABLE public.hsn_codes ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES public.parties(id) ON DELETE CASCADE;`
    })
    if (alterError && alterError.code !== 'PGRST202') {
      console.error('Failed to add company_id column:', alterError.message)
      return
    }
    console.log('✓ company_id column added')

    // Create index on company_id for filtering
    console.log('Creating index...')
    await supabase.rpc('exec_sql', {
      sql: `CREATE INDEX IF NOT EXISTS idx_hsn_codes_company_id ON public.hsn_codes(company_id);`
    })
    console.log('✓ Index created')

    // Enable RLS if not already enabled
    console.log('Enabling RLS...')
    await supabase.rpc('exec_sql', {
      sql: `ALTER TABLE public.hsn_codes ENABLE ROW LEVEL SECURITY;`
    })
    console.log('✓ RLS enabled')

    // Drop existing policies
    console.log('Dropping existing policies...')
    await supabase.rpc('exec_sql', {
      sql: `DROP POLICY IF EXISTS "Allow authenticated users to read hsn_codes" ON public.hsn_codes;`
    })
    await supabase.rpc('exec_sql', {
      sql: `DROP POLICY IF EXISTS "Allow authenticated users to create hsn_codes" ON public.hsn_codes;`
    })
    await supabase.rpc('exec_sql', {
      sql: `DROP POLICY IF EXISTS "Allow authenticated users to update hsn_codes" ON public.hsn_codes;`
    })
    await supabase.rpc('exec_sql', {
      sql: `DROP POLICY IF EXISTS "Allow authenticated users to delete hsn_codes" ON public.hsn_codes;`
    })
    console.log('✓ Existing policies dropped')

    // Create new policies that use party_id from app_users
    console.log('Creating new policies...')
    const { error: readError } = await supabase.rpc('exec_sql', {
      sql: `CREATE POLICY "Allow authenticated users to read hsn_codes"
ON public.hsn_codes FOR SELECT
TO authenticated
USING (company_id IN (SELECT party_id FROM app_users WHERE id = auth.uid()));`
    })
    if (readError && readError.code !== 'PGRST202') {
      console.error('Failed to create read policy:', readError.message)
      return
    }

    const { error: createError } = await supabase.rpc('exec_sql', {
      sql: `CREATE POLICY "Allow authenticated users to create hsn_codes"
ON public.hsn_codes FOR INSERT
TO authenticated
WITH CHECK (company_id IN (SELECT party_id FROM app_users WHERE id = auth.uid()));`
    })
    if (createError && createError.code !== 'PGRST202') {
      console.error('Failed to create insert policy:', createError.message)
      return
    }

    const { error: updateError } = await supabase.rpc('exec_sql', {
      sql: `CREATE POLICY "Allow authenticated users to update hsn_codes"
ON public.hsn_codes FOR UPDATE
TO authenticated
USING (company_id IN (SELECT party_id FROM app_users WHERE id = auth.uid()))
WITH CHECK (company_id IN (SELECT party_id FROM app_users WHERE id = auth.uid()));`
    })
    if (updateError && updateError.code !== 'PGRST202') {
      console.error('Failed to create update policy:', updateError.message)
      return
    }

    const { error: deleteError } = await supabase.rpc('exec_sql', {
      sql: `CREATE POLICY "Allow authenticated users to delete hsn_codes"
ON public.hsn_codes FOR DELETE
TO authenticated
USING (company_id IN (SELECT party_id FROM app_users WHERE id = auth.uid()));`
    })
    if (deleteError && deleteError.code !== 'PGRST202') {
      console.error('Failed to create delete policy:', deleteError.message)
      return
    }

    console.log('✓ New policies created')
    console.log('Migration completed successfully!')
  } catch (error) {
    console.error('Migration failed:', error)
  }
}

runHsnCodesMigration()