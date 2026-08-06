import { createClient } from '@supabase/supabase-js'

// Supabase configuration
const supabaseUrl = 'https://slgrxczjnburhggnmaew.supabase.co'
const supabaseServiceKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNsZ3J4Y3pqbmJ1cmhnZ25tYWV3Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MTYwNTg1OSwiZXhwIjoyMDg3MTgxODU5fQ.Kv3w4mDrMwFbV4OQXVEVO-Lr7sNGbQFCWuFM_MHs0yo'

// Create Supabase client with service role key
const supabase = createClient(supabaseUrl, supabaseServiceKey)

async function addColumnDirect() {
  console.log('Adding company_id column directly...\n')

  try {
    // Try direct SQL execution
    const { data, error } = await supabase.rpc('exec_sql', {
      sql: `
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                         WHERE table_name = 'hsn_codes'
                         AND column_name = 'company_id') THEN
            ALTER TABLE public.hsn_codes ADD COLUMN company_id UUID REFERENCES public.parties(id) ON DELETE CASCADE;
          END IF;
        END $$;
      `
    })

    if (error) {
      console.error('Error adding column:', error)
      return
    }

    console.log('Column added successfully!')

    // Verify the column exists
    const { data: verifyData, error: verifyError } = await supabase
      .from('hsn_codes')
      .select('id, company_id')
      .limit(1)

    if (verifyError) {
      console.log('Verification failed:', verifyError.message)
    } else {
      console.log('✓ Column verified to exist')
    }

  } catch (error) {
    console.error('Script failed:', error)
  }
}

addColumnDirect()