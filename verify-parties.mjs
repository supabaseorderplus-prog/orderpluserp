import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'

// Read .env.local file manually
const envContent = readFileSync('.env.local', 'utf-8')
const envVars = {}
envContent.split('\n').forEach(line => {
  const [key, ...valueParts] = line.split('=')
  if (key && valueParts.length) {
    envVars[key.trim()] = valueParts.join('=').trim()
  }
})

const supabaseUrl = envVars.NEXT_PUBLIC_SUPABASE_URL
const supabaseServiceKey = envVars.SUPABASE_SERVICE_ROLE_KEY

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('Missing Supabase credentials in .env.local')
  process.exit(1)
}

const supabase = createClient(supabaseUrl, supabaseServiceKey)

async function verifyAllParties() {
  console.log('🔄 Verifying all parties...')
  
  // Update all unverified parties
  const { data, error } = await supabase
    .from('parties')
    .update({ 
      is_verified: true,
      verified_at: new Date().toISOString()
    })
    .or('is_verified.is.null,is_verified.eq.false')
    .select('id, name')
  
  if (error) {
    console.error('❌ Error verifying parties:', error)
    process.exit(1)
  }
  
  console.log(`✅ Successfully verified ${data?.length || 0} parties:`)
  data?.forEach(party => {
    console.log(`   - ${party.name} (${party.id})`)
  })
  
  // Get total count
  const { count } = await supabase
    .from('parties')
    .select('*', { count: 'exact', head: true })
    .eq('is_verified', true)
  
  console.log(`\n📊 Total verified parties: ${count}`)
  console.log('\n✨ All parties are now verified! Orders should be visible.')
}

verifyAllParties()
