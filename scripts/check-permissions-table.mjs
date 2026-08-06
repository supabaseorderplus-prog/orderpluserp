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

async function checkPermissionsTable() {
  console.log('Checking permissions table structure...\n')

  // Get all permissions
  const { data: permissions, error } = await supabase
    .from('permissions')
    .select('*')
    .limit(5)

  if (error) {
    console.error('Error fetching permissions:', error.message)
    return
  }

  if (!permissions || permissions.length === 0) {
    console.log('❌ No permissions found in the table')
    return
  }

  console.log('✅ Sample permissions data:\n')
  console.log(JSON.stringify(permissions[0], null, 2))
  console.log('\n')

  // Get all columns in permissions table
  console.log('📋 Columns in permissions table:')
  const columns = Object.keys(permissions[0])
  columns.forEach(col => {
    console.log(`   - ${col}`)
  })
  console.log('')

  // Check if there's a scope column
  if (columns.includes('scope')) {
    console.log('✅ Scope column exists')
    
    // Get all unique scopes
    const { data: allPerms } = await supabase
      .from('permissions')
      .select('scope')
    
    const uniqueScopes = [...new Set(allPerms?.map(p => p.scope) || [])]
    console.log(`   Unique scopes: ${uniqueScopes.join(', ')}`)
  } else {
    console.log('❌ Scope column does not exist')
  }
  console.log('')

  // Check for module vs module_name
  if (columns.includes('module')) {
    console.log('✅ Module column exists')
  } else if (columns.includes('module_name')) {
    console.log('✅ Module_name column exists')
  } else {
    console.log('❌ Neither module nor module_name column exists')
  }
}

checkPermissionsTable()
