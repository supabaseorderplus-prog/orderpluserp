import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// Read environment variables from .env.local
const envPath = join(__dirname, '../.env.local')
const envContent = readFileSync(envPath, 'utf-8')
const envVars = {}
envContent.split('\n').forEach(line => {
  const [key, ...valueParts] = line.split('=')
  if (key && valueParts.length > 0) {
    envVars[key.trim()] = valueParts.join('=').trim()
  }
})

const supabaseUrl = envVars.NEXT_PUBLIC_SUPABASE_URL
const supabaseServiceKey = envVars.SUPABASE_SERVICE_ROLE_KEY

// Create Supabase admin client
const supabase = createClient(supabaseUrl, supabaseServiceKey)

async function testProductCreation() {
  try {
    console.log('Testing product creation with different unit_of_measure values...\n')

    const testUnits = ['KG', 'LITRE', 'BAG', 'BOX', 'SET', 'DRUM', 'PIECE', 'MT']

    for (const unit of testUnits) {
      const testProduct = {
        name: `Test Product ${unit}`,
        sku: `TEST-${unit}-${Date.now()}`,
        unit_of_measure: unit,
        base_price: 100,
        mrp: 120,
        pack_size: 1,
        company_id: '00000000-0000-0000-0000-000000000000', // Dummy company ID
        created_by: '00000000-0000-0000-0000-000000000000', // Dummy user ID
        status: 'ACTIVE'
      }

      const { data, error } = await supabase
        .from('products')
        .insert(testProduct)
        .select()
        .single()

      if (error) {
        console.log(`❌ ${unit}: ${error.message}`)
      } else {
        console.log(`✅ ${unit}: Product created successfully (ID: ${data.id})`)
        // Clean up the test product
        await supabase.from('products').delete().eq('id', data.id)
      }
    }

    console.log('\n✅ Test completed!')
  } catch (err) {
    console.error('Test failed:', err)
    process.exit(1)
  }
}

testProductCreation()
