/**
 * Migration script to populate party_salesman junction table
 * 
 * This script finds all parties that have a salesman_id set but are missing
 * from the party_salesman junction table, and creates the missing entries.
 */

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

// Load environment variables from .env.local
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

function loadEnvFile() {
  try {
    const envPath = join(__dirname, '..', '.env.local')
    const envContent = readFileSync(envPath, 'utf-8')
    const lines = envContent.split('\n')
    
    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed && !trimmed.startsWith('#')) {
        const [key, ...valueParts] = trimmed.split('=')
        const value = valueParts.join('=').trim()
        if (key && value) {
          process.env[key] = value
        }
      }
    }
  } catch (error) {
    console.warn('Could not load .env.local file:', error.message)
  }
}

loadEnvFile()

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables')
  process.exit(1)
}

const supabase = createClient(supabaseUrl, supabaseServiceKey)

async function migratePartySalesmanJunction() {
  console.log('Starting migration: populating party_salesman junction table...\n')

  try {
    // Step 1: Find all parties that have a salesman_id set
    const { data: partiesWithSalesman, error: fetchError } = await supabase
      .from('parties')
      .select('id, salesman_id')
      .not('salesman_id', 'is', null)

    if (fetchError) {
      console.error('Error fetching parties with salesman_id:', fetchError)
      throw fetchError
    }

    console.log(`Found ${partiesWithSalesman?.length || 0} parties with salesman_id set`)

    if (!partiesWithSalesman || partiesWithSalesman.length === 0) {
      console.log('No parties to migrate. Exiting.')
      return
    }

    // Step 2: Get all existing party_salesman entries
    const { data: existingJunctions, error: junctionError } = await supabase
      .from('party_salesman')
      .select('party_id, salesman_id')

    if (junctionError) {
      console.error('Error fetching existing party_salesman entries:', junctionError)
      throw junctionError
    }

    // Create a Set of existing (party_id, salesman_id) pairs for quick lookup
    const existingPairs = new Set(
      (existingJunctions || []).map(j => `${j.party_id}:${j.salesman_id}`)
    )

    console.log(`Found ${existingPairs.size} existing party_salesman entries`)

    // Step 3: Find parties that are missing from the junction table
    const missingEntries = partiesWithSalesman.filter(party => {
      const pairKey = `${party.id}:${party.salesman_id}`
      return !existingPairs.has(pairKey)
    })

    console.log(`Found ${missingEntries.length} parties missing from party_salesman junction table`)

    if (missingEntries.length === 0) {
      console.log('All parties already have junction entries. Nothing to migrate.')
      return
    }

    // Step 4: Insert missing entries
    const entriesToInsert = missingEntries.map(party => ({
      party_id: party.id,
      salesman_id: party.salesman_id
    }))

    console.log('\nInserting missing entries...')
    console.log('Entries to insert:', entriesToInsert)

    const { error: insertError } = await supabase
      .from('party_salesman')
      .insert(entriesToInsert)

    if (insertError) {
      console.error('Error inserting party_salesman entries:', insertError)
      throw insertError
    }

    console.log(`\n✅ Successfully inserted ${entriesToInsert.length} party_salesman entries`)
    console.log('\nMigration completed successfully!')

  } catch (error) {
    console.error('\n❌ Migration failed:', error)
    process.exit(1)
  }
}

// Run the migration
migratePartySalesmanJunction()
