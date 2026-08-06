import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// Supabase configuration
const supabaseUrl = 'https://slgrxczjnburhggnmaew.supabase.co'
const supabaseServiceKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNsZ3J4Y3pqbmJ1cmhnZ25tYWV3Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MTYwNTg1OSwiZXhwIjoyMDg3MTgxODU5fQ.Kv3w4mDrMwFbV4OQXVEVO-Lr7sNGbQFCWuFM_MHs0yo'

// Create Supabase client with service role key
const supabase = createClient(supabaseUrl, supabaseServiceKey)

async function executeMigration() {
  try {
    console.log('Reading migration file...')
    const migrationPath = join(__dirname, 'supabase-migrations', 'create_categories_table.sql')
    const sql = readFileSync(migrationPath, 'utf-8')
    
    console.log('Executing migration...')
    
    // Split the SQL into individual statements
    const statements = sql
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0 && !s.startsWith('--'))
    
    for (const statement of statements) {
      if (statement.trim()) {
        console.log(`Executing: ${statement.substring(0, 50)}...`)
        const { error } = await supabase.rpc('exec_sql', { sql: statement })
        if (error) {
          console.error('Error executing statement:', error)
          // Try direct query instead
          const { error: queryError } = await supabase.from('_temp').select('*').limit(1)
          if (queryError && queryError.code !== 'PGRST116') {
            console.log('Note: Direct SQL execution not available via RPC')
          }
        }
      }
    }
    
    // Alternative: Use the Supabase SQL editor approach
    console.log('\nMigration SQL file created at: supabase-migrations/create_categories_table.sql')
    console.log('Please execute this SQL in your Supabase SQL Editor:')
    console.log('https://supabase.com/dashboard/project/slgrxczjnburhggnmaew/sql/new')
    console.log('\nOr use the Supabase CLI: supabase db push')
    
  } catch (error) {
    console.error('Migration failed:', error)
    process.exit(1)
  }
}

executeMigration()
