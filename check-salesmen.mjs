import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'

// Read environment variables
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
const supabase = createClient(supabaseUrl, supabaseKey)

async function checkSalesmen() {
  console.log('Checking salesmen in database...\n')
  
  // Get SALESMAN role ID
  const { data: roleData } = await supabase
    .from('roles')
    .select('id')
    .eq('name', 'SALESMAN')
    .single()
  
  if (!roleData) {
    console.log('❌ SALESMAN role not found')
    return
  }
  
  console.log(`✅ SALESMAN role ID: ${roleData.id}\n`)
  
  // Get all salesmen
  const { data: salesmen, error } = await supabase
    .from('users')
    .select('id, name, email, phone, party_id, status')
    .eq('role_id', roleData.id)
    .order('name')
  
  if (error) {
    console.log('❌ Error fetching salesmen:', error.message)
    return
  }
  
  console.log(`Total salesmen found: ${salesmen?.length || 0}\n`)
  
  const withNullPartyId = salesmen?.filter(s => !s.party_id) || []
  const withPartyId = salesmen?.filter(s => s.party_id) || []
  
  console.log(`Salesmen with NULL party_id: ${withNullPartyId.length}`)
  console.log(`Salesmen with party_id set: ${withPartyId.length}\n`)
  
  if (withNullPartyId.length > 0) {
    console.log('❌ Salesmen with NULL party_id:')
    withNullPartyId.forEach(s => {
      console.log(`  - ${s.name} (${s.email}) - Status: ${s.status}`)
    })
    console.log('')
  }
  
  if (withPartyId.length > 0) {
    console.log('✅ Salesmen with party_id set:')
    withPartyId.slice(0, 5).forEach(s => {
      console.log(`  - ${s.name} (${s.email}) - party_id: ${s.party_id}`)
    })
    if (withPartyId.length > 5) {
      console.log(`  ... and ${withPartyId.length - 5} more`)
    }
    console.log('')
  }
  
  // Get companies
  const { data: companyType } = await supabase
    .from('party_types')
    .select('id')
    .eq('name', 'COMPANY')
    .single()
  
  if (companyType) {
    const { data: companies } = await supabase
      .from('parties')
      .select('id, name, party_code')
      .eq('party_type_id', companyType.id)
      .eq('status', 'ACTIVE')
      .limit(5)
    
    console.log(`\nActive companies in database: ${companies?.length || 0}`)
    companies?.forEach(c => {
      console.log(`  - ${c.name} (${c.party_code}) - ID: ${c.id}`)
    })
  }
}

checkSalesmen().then(() => process.exit(0)).catch(err => {
  console.error('Error:', err)
  process.exit(1)
})
