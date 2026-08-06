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

async function testSalesmanDownline() {
  console.log('Testing salesman downline access...\n')

  // Find the T2SALES user in abc traders company
  const { data: users, error: userError } = await supabase
    .from('app_users')
    .select('id, name, email, role_id, assigned_party_id')
    .ilike('email', '%T2SALES%')
    .limit(10)

  if (userError) {
    console.error('Error finding T2SALES user:', userError.message)
    return
  }

  if (!users || users.length === 0) {
    console.log('❌ T2SALES user not found')
    return
  }

  const salesman = users[0]
  console.log(`✅ Found salesman: ${salesman.name} (${salesman.email})`)
  console.log(`   User ID: ${salesman.id}`)
  console.log(`   Assigned Party ID: ${salesman.assigned_party_id || 'None'}\n`)

  // Get the role name
  const { data: role } = await supabase
    .from('roles')
    .select('name')
    .eq('id', salesman.role_id)
    .single()

  console.log(`   Role: ${role?.name || 'Unknown'}\n`)

  // Check permissions for parties module
  const { data: permissions } = await supabase
    .from('permissions')
    .select('scope, company_id')
    .eq('role_id', salesman.role_id)
    .eq('module', 'parties')

  if (!permissions || permissions.length === 0) {
    console.log('❌ No permissions found for parties module')
    return
  }

  const perm = permissions[0]
  console.log(`📋 Parties Permission Scope: ${perm.scope}`)
  console.log(`   Company ID: ${perm.company_id || 'Global'}\n`)

  // Get parties assigned to this salesman via salesman_id
  const { data: salesmanParties, error: partiesError } = await supabase
    .from('parties')
    .select('id, name, party_code, status')
    .eq('salesman_id', salesman.id)
    .eq('status', 'ACTIVE')

  if (partiesError) {
    console.error('Error fetching salesman parties:', partiesError.message)
    return
  }

  console.log(`📦 Parties assigned to salesman (via salesman_id): ${salesmanParties?.length || 0}`)
  if (salesmanParties && salesmanParties.length > 0) {
    salesmanParties.forEach((party, i) => {
      console.log(`   ${i + 1}. ${party.name} (${party.party_code}) - ${party.id}`)
    })
  } else {
    console.log('   ⚠️  No parties assigned to this salesman via salesman_id')
  }
  console.log('')

  // Test the getAllowedPartyIds logic
  console.log('🔍 Testing getAllowedPartyIds logic...\n')

  if (perm.scope === 'ALL') {
    console.log('   Scope is "ALL" (downline) - should return all parties where salesman_id = userId')
    const allowedIds = salesmanParties ? salesmanParties.map(p => p.id) : []
    console.log(`   Allowed Party IDs: ${allowedIds.length} parties`)
    console.log(`   ${allowedIds.join(', ') || 'None'}\n`)
  } else {
    console.log(`   Scope is "${perm.scope}" - should return only assigned_party_id`)
    console.log(`   Allowed Party ID: ${salesman.assigned_party_id || 'None'}\n`)
  }

  // Check if there are any parties in the company
  const { data: companyParties } = await supabase
    .from('parties')
    .select('id, name, salesman_id')
    .eq('status', 'ACTIVE')
    .limit(10)

  console.log(`📊 Total ACTIVE parties in database: ${companyParties?.length || 0}`)
  if (companyParties && companyParties.length > 0) {
    const withSalesman = companyParties.filter(p => p.salesman_id).length
    console.log(`   Parties with salesman_id assigned: ${withSalesman}`)
    console.log(`   Parties without salesman_id: ${companyParties.length - withSalesman}\n`)
  }

  console.log('✅ Test completed')
}

testSalesmanDownline()
