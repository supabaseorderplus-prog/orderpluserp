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

async function findSalesman() {
  console.log('Searching for salesman users...\n')

  // Find abc traders company
  const { data: companies } = await supabase
    .from('parties')
    .select('id, name')
    .ilike('name', '%abc traders%')
    .limit(5)

  if (!companies || companies.length === 0) {
    console.log('❌ abc traders company not found')
    return
  }

  const company = companies[0]
  console.log(`✅ Found company: ${company.name} (${company.id})\n`)

  // Get all users with SALESMAN role
  const { data: roles } = await supabase
    .from('roles')
    .select('id, name')
    .ilike('name', '%SALESMAN%')

  if (!roles || roles.length === 0) {
    console.log('❌ SALESMAN role not found')
    return
  }

  const salesmanRole = roles[0]
  console.log(`✅ Found role: ${salesmanRole.name} (${salesmanRole.id})\n`)

  // Get all users with SALESMAN role
  const { data: users, error: userError } = await supabase
    .from('app_users')
    .select('id, name, email, role_id, assigned_party_id')
    .eq('role_id', salesmanRole.id)
    .limit(20)

  if (userError) {
    console.error('Error fetching users:', userError.message)
    return
  }

  console.log(`📋 Found ${users?.length || 0} users with SALESMAN role:\n`)
  
  if (users && users.length > 0) {
    users.forEach((user, i) => {
      console.log(`   ${i + 1}. ${user.name} (${user.email})`)
      console.log(`      User ID: ${user.id}`)
      console.log(`      Assigned Party ID: ${user.assigned_party_id || 'None'}\n`)
    })
  }

  // Check parties assigned to these salesmen
  console.log('📦 Checking parties assigned to salesmen...\n')
  
  for (const user of users || []) {
    const { data: parties } = await supabase
      .from('parties')
      .select('id, name, party_code')
      .eq('salesman_id', user.id)
      .eq('status', 'ACTIVE')
      .limit(5)

    console.log(`   ${user.name}: ${parties?.length || 0} parties`)
    if (parties && parties.length > 0) {
      parties.forEach(p => {
        console.log(`      - ${p.name} (${p.party_code})`)
      })
    }
    console.log('')
  }
}

findSalesman()
