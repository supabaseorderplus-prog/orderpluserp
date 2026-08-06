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

async function checkSalesmanPermissions() {
  console.log('Checking SALESMAN role permissions...\n')

  // Get SALESMAN role
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

  // Get all permissions for this role
  const { data: permissions } = await supabase
    .from('permissions')
    .select('module, action, scope, company_id')
    .eq('role_id', salesmanRole.id)

  if (!permissions || permissions.length === 0) {
    console.log('❌ No permissions found for SALESMAN role')
    return
  }

  console.log(`📋 Found ${permissions.length} permissions:\n`)

  // Group by module
  const byModule = {}
  permissions.forEach(p => {
    if (!byModule[p.module]) {
      byModule[p.module] = []
    }
    byModule[p.module].push(p)
  })

  Object.keys(byModule).forEach(module => {
    console.log(`   Module: ${module}`)
    byModule[module].forEach(p => {
      const company = p.company_id ? ` (Company: ${p.company_id})` : ' (Global)'
      console.log(`      - Action: ${p.action}, Scope: ${p.scope}${company}`)
    })
    console.log('')
  })

  // Specifically check parties module
  const partiesPerms = permissions.filter(p => p.module === 'parties')
  if (partiesPerms.length > 0) {
    console.log('🔍 Parties module permissions:\n')
    partiesPerms.forEach(p => {
      const company = p.company_id ? ` (Company: ${p.company_id})` : ' (Global)'
      console.log(`   Action: ${p.action}, Scope: ${p.scope}${company}`)
    })
    console.log('')
  }

  // Check T2SALES user's permissions
  const { data: t2sales } = await supabase
    .from('app_users')
    .select('id, name, email, role_id')
    .ilike('email', '%T2SALES%')
    .single()

  if (t2sales) {
    console.log(`✅ Found T2SALES user: ${t2sales.name} (${t2sales.email})`)
    console.log(`   User ID: ${t2sales.id}\n`)

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

    // Simulate getAllowedPartyIds for T2SALES
    console.log('🔍 Simulating getAllowedPartyIds for T2SALES:\n')

    const partiesPerm = partiesPerms.find(p => p.action === 'view')
    if (partiesPerm) {
      const scope = partiesPerm.scope
      console.log(`   Parties view permission scope: ${scope}`)

      if (scope === 'ALL') {
        console.log(`   Result: Should return all parties where salesman_id = ${t2sales.id}`)
        console.log(`   Party IDs: ${t2salesParties ? t2salesParties.map(p => p.id).join(', ') : 'None'}`)
      } else {
        console.log(`   Result: Should return only assigned_party_id`)
        console.log(`   Party ID: ${t2sales.assigned_party_id || 'None'}`)
      }
    } else {
      console.log('   ❌ No view permission found for parties module')
    }
  }
}

checkSalesmanPermissions()
