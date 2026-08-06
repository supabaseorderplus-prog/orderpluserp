import { createClient } from '@supabase/supabase-js'

// Supabase configuration
const supabaseUrl = 'https://slgrxczjnburhggnmaew.supabase.co'
const supabaseServiceKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNsZ3J4Y3pqbmJ1cmhnZ25tYWV3Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MTYwNTg1OSwiZXhwIjoyMDg3MTgxODU5fQ.Kv3w4mDrMwFbV4OQXVEVO-Lr7sNGbQFCWuFM_MHs0yo'

// Create Supabase client with service role key
const supabase = createClient(supabaseUrl, supabaseServiceKey)

async function checkHsnCodes() {
  console.log('Checking hsn_codes table structure...\n')
  
  // Try to select from the table
  const { data, error } = await supabase
    .from('hsn_codes')
    .select('*')
    .limit(1)
  
  if (error) {
    console.log('Error accessing hsn_codes:', error.message)
    return
  }
  
  if (data && data.length > 0) {
    console.log('Current columns:', Object.keys(data[0]))
    console.log('\nSample data:')
    console.log(JSON.stringify(data[0], null, 2))
  }
}

checkHsnCodes()
