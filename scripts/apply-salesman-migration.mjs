import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

dotenv.config({ path: '.env.local' })

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing Supabase credentials in .env.local')
  process.exit(1)
}

const supabase = createClient(supabaseUrl, supabaseKey)

async function applyMigration() {
  console.log('Applying migration: Add salesman_id column to parties table...')

  // Read the migration SQL file
  const migrationPath = join(__dirname, '../backend/prisma/migrations/20250321_add_salesman_id_to_parties/migration.sql')
  const migrationSQL = readFileSync(migrationPath, 'utf-8')

  // Split the SQL into individual statements
  const statements = migrationSQL
    .split(';')
    .map(s => s.trim())
    .filter(s => s.length > 0 && !s.startsWith('--'))

  console.log(`Found ${statements.length} SQL statements to execute`)

  for (let i = 0; i < statements.length; i++) {
    const statement = statements[i]
    console.log(`Executing statement ${i + 1}/${statements.length}...`)
    
    try {
      const { error } = await supabase.rpc('exec_sql', { sql: statement })
      
      if (error) {
        // If exec_sql doesn't exist, try direct SQL execution
        console.log('exec_sql not available, trying direct query...')
        
        // For ALTER TABLE and CREATE INDEX, we need to use a different approach
        // Let's try using the Supabase REST API directly
        const response = await fetch(`${supabaseUrl}/rest/v1/rpc/exec_sql`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': supabaseKey,
            'Authorization': `Bearer ${supabaseKey}`
          },
          body: JSON.stringify({ sql: statement })
        })
        
        if (!response.ok) {
          const errorText = await response.text()
          console.error(`Failed to execute statement ${i + 1}:`, errorText)
          throw new Error(errorText)
        }
      }
      
      console.log(`Statement ${i + 1} executed successfully`)
    } catch (error) {
      console.error(`Error executing statement ${i + 1}:`, error.message)
      console.log('Statement:', statement)
      throw error
    }
  }

  console.log('Migration applied successfully!')
}

applyMigration().catch(console.error)
