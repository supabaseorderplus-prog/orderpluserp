import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// Read environment variables from .env.local
const envPath = join(__dirname, '../.env.local')
const envContent = readFileSync(envPath, 'utf-8')
const envVars = {}
envContent.split('\n').forEach(line => {
  const [key, ...valueParts] = line.split('=')
  if (key && valueParts.length > 0) {
    envVars[key.trim()] = valueParts.join('=').trim()
  }
})

const supabaseUrl = envVars.NEXT_PUBLIC_SUPABASE_URL
const supabaseServiceKey = envVars.SUPABASE_SERVICE_ROLE_KEY

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('Missing Supabase credentials')
  process.exit(1)
}

// Create Supabase admin client
const supabase = createClient(supabaseUrl, supabaseServiceKey)

async function executeMigration() {
  try {
    console.log('Executing products unit_of_measure constraint fix...')

    // Read the SQL file
    const sqlPath = join(__dirname, '../supabase-migrations/fix-products-unit-of-measure-constraint.sql')
    const sql = readFileSync(sqlPath, 'utf-8')

    // Execute the SQL using Supabase RPC
    const { data, error } = await supabase.rpc('exec_sql', { sql })

    if (error) {
      console.error('Error executing migration:', error)
      process.exit(1)
    }

    console.log('Migration executed successfully!')
    console.log('Result:', data)
  } catch (err) {
    console.error('Migration failed:', err)
    process.exit(1)
  }
}

executeMigration()
