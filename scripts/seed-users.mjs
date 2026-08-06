import { createClient } from '@supabase/supabase-js'

const supabaseUrl = 'https://slgrxczjnburhggnmaew.supabase.co'
const serviceKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNsZ3J4Y3pqbmJ1cmhnZ25tYWV3Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MTYwNTg1OSwiZXhwIjoyMDg3MTgxODU5fQ.Kv3w4mDrMwFbV4OQXVEVO-Lr7sNGbQFCWuFM_MHs0yo'

const supabase = createClient(supabaseUrl, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false }
})

const users = [
  { email: 'sm@hometech.in', name: 'Rajesh Kumar', phone: '+919876543211', role: 'SALES_MANAGER', territory: 'KOLKAT-01' },
  { email: 'ravi@hometech.in', name: 'Ravi Sharma', phone: '+919876543212', role: 'SALESMAN', territory: 'KOLKAT-01' },
  { email: 'accounts@hometech.in', name: 'Priya Singh', phone: '+919876543213', role: 'ACCOUNTS_MANAGER', territory: null },
  { email: 'warehouse@hometech.in', name: 'Amit Patel', phone: '+919876543214', role: 'WAREHOUSE_MANAGER', territory: null },
  { email: 'territory@hometech.in', name: 'Suresh Das', phone: '+919876543215', role: 'TERRITORY_MANAGER', territory: 'HOWRAH-01' },
]

async function main() {
  // Get roles
  const { data: roles } = await supabase.from('roles').select('id, name')
  const roleMap = Object.fromEntries(roles.map(r => [r.name, r.id]))

  // Get territories
  const { data: territories } = await supabase.from('territories').select('id, code')
  const terrMap = Object.fromEntries(territories.map(t => [t.code, t.id]))

  for (const u of users) {
    // Check if auth user already exists
    const { data: existingUsers } = await supabase.auth.admin.listUsers()
    const exists = existingUsers?.users?.find(eu => eu.email === u.email)

    let authId
    if (exists) {
      authId = exists.id
      console.log(`Auth user ${u.email} already exists: ${authId}`)
    } else {
      const { data: authUser, error: authErr } = await supabase.auth.admin.createUser({
        email: u.email,
        password: 'Password@123',
        email_confirm: true,
      })
      if (authErr) {
        console.error(`Failed to create auth user ${u.email}:`, authErr.message)
        continue
      }
      authId = authUser.user.id
      console.log(`Created auth user ${u.email}: ${authId}`)
    }

    // Check if profile exists
    const { data: existingProfile } = await supabase.from('users').select('id').eq('id', authId).single()
    if (existingProfile) {
      console.log(`Profile already exists for ${u.email}`)
      continue
    }

    // Create user profile
    const { error: profileErr } = await supabase.from('users').insert({
      id: authId,
      name: u.name,
      email: u.email,
      phone: u.phone,
      role_id: roleMap[u.role],
      territory_id: u.territory ? terrMap[u.territory] : null,
    })
    if (profileErr) {
      console.error(`Failed to create profile for ${u.email}:`, profileErr.message)
    } else {
      console.log(`Created profile for ${u.email}`)
    }
  }

  console.log('Done seeding users!')
}

main().catch(console.error)
