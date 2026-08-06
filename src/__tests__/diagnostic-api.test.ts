/**
 * Diagnostic Test to Understand API Behavior
 */

import { describe, it, expect } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'

// Read environment variables
const envContent = readFileSync('.env.local', 'utf-8')
const envVars: Record<string, string> = {}
envContent.split('\n').forEach(line => {
  const [key, ...valueParts] = line.split('=')
  if (key && valueParts.length > 0) {
    envVars[key.trim()] = valueParts.join('=').trim()
  }
})

const supabaseUrl = envVars.NEXT_PUBLIC_SUPABASE_URL
const supabaseKey = envVars.SUPABASE_SERVICE_ROLE_KEY
const supabase = createClient(supabaseUrl, supabaseKey)

describe('Diagnostic: API and Database Connectivity', () => {
  it('should connect to Supabase and query users', async () => {
    const { data: roleData } = await supabase
      .from('roles')
      .select('id')
      .eq('name', 'SALESMAN')
      .single()

    console.log('\n🔍 Diagnostic Results:')
    console.log(`   SALESMAN role found: ${!!roleData}`)
    console.log(`   SALESMAN role ID: ${roleData?.id}`)

    if (!roleData) {
      console.log('   ❌ Cannot proceed - SALESMAN role not found')
      return
    }

    // Get all salesmen
    const { data: allSalesmen } = await supabase
      .from('users')
      .select('id, name, party_id, status, company_id')
      .eq('role_id', roleData.id)
      .limit(5)

    console.log(`\n   Total salesmen in database (first 5): ${allSalesmen?.length || 0}`)
    if (allSalesmen && allSalesmen.length > 0) {
      allSalesmen.forEach((s, i) => {
        console.log(`   ${i + 1}. ${s.name}`)
        console.log(`      - ID: ${s.id}`)
        console.log(`      - party_id: ${s.party_id || 'NULL'}`)
        console.log(`      - company_id: ${(s as any).company_id || 'NULL'}`)
        console.log(`      - status: ${s.status}`)
      })
    }

    // Get all companies
    const { data: companyType } = await supabase
      .from('party_types')
      .select('id')
      .eq('name', 'COMPANY')
      .single()

    let companies: Array<{ id: string; name: string; status: string | null }> = []

    if (companyType) {
      const { data: companyRows } = await supabase
        .from('parties')
        .select('id, name, status')
        .eq('party_type_id', companyType.id)
        .limit(3)

      companies = companyRows || []

      console.log(`\n   Total companies (first 3): ${companies?.length || 0}`)
      if (companies && companies.length > 0) {
        companies.forEach((c, i) => {
          console.log(`   ${i + 1}. ${c.name} (${c.id}) - ${c.status}`)
        })
      }
    }

    // Test API endpoint
    const apiBaseUrl = supabaseUrl.replace('/rest/v1', '')
    console.log(`\n   API Base URL: ${apiBaseUrl}`)
    
    if (allSalesmen && allSalesmen.length > 0 && companies && companies.length > 0) {
      const testCompanyId = companies[0].id
      console.log(`   Testing with company ID: ${testCompanyId}`)
      
      const response = await fetch(`${apiBaseUrl}/api/v1/parties/salesmen`, {
        headers: {
          'x-company-id': testCompanyId,
        }
      })

      console.log(`   API Response status: ${response.status}`)
      const result = await response.json()
      console.log(`   API Response:`, JSON.stringify(result, null, 2))
    }

    expect(true).toBe(true)
  })
})
