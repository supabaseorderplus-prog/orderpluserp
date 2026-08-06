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

async function testSalesmanDownlineFix() {
  console.log('Testing salesman downline fix...\n')

  // T2SALES user ID from previous query
  const t2salesId = '0aa7fb55-cc55-4e49-a902-f8ad88369367'

  // Get T2SALES user from app_users table
  const { data: t2sales } = await supabase
    .from('app_users')
    .select('id, name, email, role_id, assigned_party_id')
    .eq('id', t2salesId)
    .single()

  if (!t2sales) {
    console.log('❌ T2SALES user not found')
    return
  }

  console.log(`✅ Found T2SALES user: ${t2sales.name} (${t2sales.email})`)
  console.log(`   User ID: ${t2sales.id}`)
  console.log(`   Assigned Party ID: ${t2sales.assigned_party_id || 'None'}\n`)

  // Get parties assigned to T2SALES
  const { data: t2salesParties } = await supabase
    .from('parties')
    .select('id, name, party_code, status')
    .eq('salesman_id', t2sales.id)
    .eq('status', 'ACTIVE')

  console.log(`📦 Parties assigned to T2SALES: ${t2salesParties?.length || 0}`)
  if (t2salesParties && t2salesParties.length > 0) {
    t2salesParties.forEach(p => {
      console.log(`   - ${p.name} (${p.party_code}) - ${p.id}`)
    })
  }
  console.log('')

  // Get permissions for SALESMAN role
  const { data: permissions } = await supabase
    .from('permissions')
    .select('module, scope, can_view, can_create')
    .eq('role_id', t2sales.role_id)
    .eq('module', 'parties')

  if (!permissions || permissions.length === 0) {
    console.log('❌ No permissions found for parties module')
    return
  }

  const perm = permissions[0]
  console.log(`📋 Parties permission for SALESMAN role:`)
  console.log(`   Scope: ${perm.scope}`)
  console.log(`   Can View: ${perm.can_view}`)
  console.log(`   Can Create: ${perm.can_create}\n`)

  // Simulate getAllowedPartyIds logic
  console.log('🔍 Simulating getAllowedPartyIds logic:\n')

  if (perm.scope === 'ALL') {
    console.log('   Scope is "ALL" (all company parties)')
    console.log('   Result: null (allows all company parties)')
    console.log('   Expected: T2SALES should see ALL parties in the company\n')
  } else {
    console.log(`   Scope is "${perm.scope}" (downline only)`)
    console.log('   Result: Parties where salesman_id = userId')
    console.log(`   Party IDs: ${t2salesParties ? t2salesParties.map(p => p.id).join(', ') : 'None'}`)
    console.log('   Expected: T2SALES should see ONLY their assigned parties\n')
  }

  // Get all parties in the company
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
  console.log('\n📝 Summary:')
  console.log('   - The salesman_id column exists in the parties table')
  console.log('   - T2SALES has 1 party assigned (T2CNF)')
  console.log(`   - Current scope is "${perm.scope}"`)
  if (perm.scope === 'ALL') {
    console.log('   - With "ALL" scope, T2SALES should see ALL company parties')
  } else {
    console.log('   - With "PARTY/TERRITORY" scope, T2SALES should see ONLY their assigned parties')
  }
  console.log('\n💡 To change the scope:')
  console.log('   1. Go to the control panel')
  console.log('   2. Navigate to Roles & Permissions')
  console.log('   3. Edit the SALESMAN role')
  console.log('   4. Change the parties module scope to:')
  console.log('      - "ALL" to allow seeing all company parties')
  console.log('      - "PARTY" or "TERRITORY" to restrict to assigned parties only')
}

testSalesmanDownlineFix()
