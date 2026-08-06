import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'

// Read .env.local file manually
const envContent = readFileSync('.env.local', 'utf-8')
const envVars = {}
envContent.split('\n').forEach(line => {
  const [key, ...valueParts] = line.split('=')
  if (key && valueParts.length > 0) {
    envVars[key.trim()] = valueParts.join('=').trim()
  }
})

const supabaseUrl = envVars.NEXT_PUBLIC_SUPABASE_URL
const supabaseKey = envVars.SUPABASE_SERVICE_ROLE_KEY

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing Supabase credentials in .env.local')
  process.exit(1)
}

const supabase = createClient(supabaseUrl, supabaseKey)

async function checkMigrationStatus() {
  console.log('Checking if salesman_id column exists in parties table...')

  try {
    // Try to select the salesman_id column
    const { data, error } = await supabase
      .from('parties')
      .select('salesman_id')
      .limit(1)

    if (error) {
      if (error.message.includes('column') || error.code === 'PGRST116') {
        console.log('\n❌ Migration NOT applied: salesman_id column does not exist')
        console.log('\n📋 Please run the following SQL in your Supabase SQL Editor:')
        console.log('\n' + '='.repeat(60))
        console.log(`
-- Migration: Add salesman_id column to parties table
-- This migration adds the salesman_id foreign key to link parties to salesmen

-- Add salesman_id column to parties table
ALTER TABLE "parties" 
ADD COLUMN "salesman_id" UUID;

-- Add foreign key constraint to link salesman_id to users table
ALTER TABLE "parties" 
ADD CONSTRAINT "parties_salesman_id_fkey" 
FOREIGN KEY ("salesman_id") 
REFERENCES "users"("id") 
ON DELETE SET NULL 
ON UPDATE CASCADE;

-- Create index for salesman_id to improve query performance
CREATE INDEX "parties_salesman_id_status_idx" ON "parties"("salesman_id", "status");

-- Add comment to document the purpose of this column
COMMENT ON COLUMN "parties"."salesman_id" IS 'The salesman assigned to this party. Used for filtering parties by salesman in downline scope.';
        `)
        console.log('='.repeat(60))
        console.log('\n📝 Steps to apply:')
        console.log('1. Go to https://supabase.com/dashboard/project/slgrxczjnburhggnmaew/sql')
        console.log('2. Paste the SQL above')
        console.log('3. Click "Run" to execute')
        console.log('4. Run this script again to verify')
        return false
      }
      throw error
    }

    console.log('\n✅ Migration already applied: salesman_id column exists')
    return true
  } catch (error) {
    console.error('Error checking migration status:', error.message)
    return false
  }
}

checkMigrationStatus()
