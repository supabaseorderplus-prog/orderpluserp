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
const companyId = '97ae603b-38d3-4e9e-b434-ccce6316f002' // The company ID from the diagnostic

async function testAPI() {
  console.log('Testing /api/v1/parties/salesmen endpoint...\n')
  console.log(`Company ID: ${companyId}`)
  console.log(`API URL: http://localhost:3002/api/v1/parties/salesmen\n`)
  
  try {
    const response = await fetch('http://localhost:3002/api/v1/parties/salesmen', {
      headers: {
        'x-company-id': companyId,
      }
    })
    
    console.log(`Response status: ${response.status}`)
    
    const result = await response.json()
    console.log('\nResponse body:')
    console.log(JSON.stringify(result, null, 2))
    
    if (result.data) {
      console.log(`\n✅ Salesmen returned: ${result.data.length}`)
      result.data.forEach(s => {
        console.log(`  - ${s.name} (${s.email})`)
      })
    } else {
      console.log('\n❌ No salesmen data in response')
    }
  } catch (err) {
    console.error('❌ Error:', err.message)
  }
}

testAPI().then(() => process.exit(0)).catch(err => {
  console.error('Error:', err)
  process.exit(1)
})
