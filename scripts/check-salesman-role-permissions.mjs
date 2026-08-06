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

async function checkSalesmanRolePermissions() {
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
    .select('*')
    .eq('role_id', salesmanRole.id)

  if (!permissions || permissions.length === 0) {
    console.log('❌ No permissions found for SALESMAN role')
    console.log('\n📋 This means the SALESMAN role has no permissions configured.')
    console.log('   The user needs to configure permissions in the control panel.')
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
      const actions = []
      if (p.can_view) actions.push('view')
      if (p.can_create) actions.push('create')
      if (p.can_edit) actions.push('edit')
      if (p.can_delete) actions.push('delete')
      if (p.can_approve) actions.push('approve')
      if (p.can_export) actions.push('export')
      console.log(`      - Actions: [${actions.join(', ')}], Scope: ${p.scope}${company}`)
    })
    console.log('')
  })

  // Specifically check parties module
  const partiesPerms = permissions.filter(p => p.module === 'parties')
  if (partiesPerms.length > 0) {
    console.log('🔍 Parties module permissions:\n')
    partiesPerms.forEach(p => {
      const company = p.company_id ? ` (Company: ${p.company_id})` : ' (Global)'
      const actions = []
      if (p.can_view) actions.push('view')
      if (p.can_create) actions.push('create')
      if (p.can_edit) actions.push('edit')
      if (p.can_delete) actions.push('delete')
      if (p.can_approve) actions.push('approve')
      if (p.can_export) actions.push('export')
      console.log(`   Actions: [${actions.join(', ')}], Scope: ${p.scope}${company}`)
    })
    console.log('')
  } else {
    console.log('❌ No permissions found for parties module')
    console.log('   The SALESMAN role needs permissions configured for the parties module.')
  }
}

checkSalesmanRolePermissions()
