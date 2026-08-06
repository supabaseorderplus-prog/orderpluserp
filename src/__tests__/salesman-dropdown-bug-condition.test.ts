/**
 * Bug Condition Exploration Test for Salesman Dropdown Fix
 * 
 * **Validates: Requirements 2.1, 2.2, 2.3**
 * 
 * This test explores the bug condition where salesmen with NULL party_id or
 * out-of-hierarchy party_id are excluded from dropdown lists.
 * 
 * **CRITICAL**: This test MUST FAIL on unfixed code - failure confirms the bug exists.
 * **DO NOT attempt to fix the test or the code when it fails.**
 * 
 * The test encodes the expected behavior (all company salesmen should appear).
 * When this test passes after the fix, it confirms the bug is resolved.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
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

// Test data IDs (will be populated during setup)
let testCompanyId: string
let testSalesmanRoleId: string
let testSalesmanWithNullPartyId: string
let testSalesmanWithOutOfHierarchyPartyId: string
let testSalesmanWithValidPartyId: string
let testOtherCompanyId: string
let testOtherCompanyPartyId: string

describe('Bug Condition Exploration: Salesmen with NULL or Out-of-Hierarchy party_id', () => {
  beforeAll(async () => {
    // Get SALESMAN role ID
    const { data: roleData } = await supabase
      .from('roles')
      .select('id')
      .eq('name', 'SALESMAN')
      .single()
    
    if (!roleData) {
      throw new Error('SALESMAN role not found')
    }
    testSalesmanRoleId = roleData.id

    // Find or create a test company (party with type COMPANY)
    const { data: companyTypeData } = await supabase
      .from('party_types')
      .select('id')
      .eq('name', 'COMPANY')
      .single()

    if (!companyTypeData) {
      throw new Error('COMPANY party type not found')
    }

    // Get an existing company for testing
    const { data: existingCompanies } = await supabase
      .from('parties')
      .select('id')
      .eq('party_type_id', companyTypeData.id)
      .eq('status', 'ACTIVE')
      .limit(1)

    if (existingCompanies && existingCompanies.length > 0) {
      testCompanyId = existingCompanies[0].id
    } else {
      // Create a test company if none exists
      const { data: newCompany, error } = await supabase
        .from('parties')
        .insert({
          name: 'Test Company for Bug Exploration',
          party_code: `TEST_COMPANY_${Date.now()}`,
          party_type_id: companyTypeData.id,
          status: 'ACTIVE'
        })
        .select('id')
        .single()

      if (error || !newCompany) {
        throw new Error(`Failed to create test company: ${error?.message}`)
      }
      testCompanyId = newCompany.id
    }

    // Create another company for out-of-hierarchy testing
    const { data: otherCompany, error: otherCompanyError } = await supabase
      .from('parties')
      .insert({
        name: 'Other Test Company',
        party_code: `OTHER_COMPANY_${Date.now()}`,
        party_type_id: companyTypeData.id,
        status: 'ACTIVE'
      })
      .select('id')
      .single()

    if (otherCompanyError || !otherCompany) {
      throw new Error(`Failed to create other test company: ${otherCompanyError?.message}`)
    }
    testOtherCompanyId = otherCompany.id
    testOtherCompanyPartyId = otherCompany.id

    // Create a valid party within the test company hierarchy
    const { data: validParty, error: validPartyError } = await supabase
      .from('parties')
      .insert({
        name: 'Valid CNF Party',
        party_code: `VALID_CNF_${Date.now()}`,
        party_type_id: companyTypeData.id,
        parent_party_id: testCompanyId,
        status: 'ACTIVE'
      })
      .select('id')
      .single()

    if (validPartyError) {
      console.warn('Could not create valid party, will use company ID:', validPartyError.message)
    }

    const validPartyId = validParty?.id || testCompanyId

    // Create test salesmen - ALL with party_id set to testCompanyId (the company they belong to)
    // 1. Salesman with NULL party_id
    const { data: salesmanNull, error: errorNull } = await supabase
      .from('users')
      .insert({
        name: 'Test Salesman NULL Party',
        email: `salesman_null_${Date.now()}@test.com`,
        phone: `+1555${Date.now().toString().slice(-7)}`,
        password_hash: 'dummy_hash',
        role_id: testSalesmanRoleId,
        party_id: null,  // NULL party_id - this is the bug condition
        status: 'ACTIVE'
      })
      .select('id')
      .single()

    if (errorNull || !salesmanNull) {
      throw new Error(`Failed to create salesman with NULL party_id: ${errorNull?.message}`)
    }
    testSalesmanWithNullPartyId = salesmanNull.id

    // 2. Salesman with out-of-hierarchy party_id
    const { data: salesmanOutOfHierarchy, error: errorOutOfHierarchy } = await supabase
      .from('users')
      .insert({
        name: 'Test Salesman Out-of-Hierarchy',
        email: `salesman_out_${Date.now()}@test.com`,
        phone: `+1556${Date.now().toString().slice(-7)}`,
        password_hash: 'dummy_hash',
        role_id: testSalesmanRoleId,
        party_id: testOtherCompanyPartyId,  // Out-of-hierarchy party_id - this is the bug condition
        status: 'ACTIVE'
      })
      .select('id')
      .single()

    if (errorOutOfHierarchy || !salesmanOutOfHierarchy) {
      throw new Error(`Failed to create salesman with out-of-hierarchy party_id: ${errorOutOfHierarchy?.message}`)
    }
    testSalesmanWithOutOfHierarchyPartyId = salesmanOutOfHierarchy.id

    // 3. Salesman with valid party_id (for comparison)
    const { data: salesmanValid, error: errorValid } = await supabase
      .from('users')
      .insert({
        name: 'Test Salesman Valid Party',
        email: `salesman_valid_${Date.now()}@test.com`,
        phone: `+1557${Date.now().toString().slice(-7)}`,
        password_hash: 'dummy_hash',
        role_id: testSalesmanRoleId,
        party_id: testCompanyId,  // Valid party_id within hierarchy
        status: 'ACTIVE'
      })
      .select('id')
      .single()

    if (errorValid || !salesmanValid) {
      throw new Error(`Failed to create salesman with valid party_id: ${errorValid?.message}`)
    }
    testSalesmanWithValidPartyId = salesmanValid.id

    console.log('\n📋 Test Setup Complete:')
    console.log(`   Company ID: ${testCompanyId}`)
    console.log(`   Salesman with NULL party_id: ${testSalesmanWithNullPartyId}`)
    console.log(`   Salesman with out-of-hierarchy party_id: ${testSalesmanWithOutOfHierarchyPartyId}`)
    console.log(`   Salesman with valid party_id: ${testSalesmanWithValidPartyId}`)
    console.log('')
  })

  afterAll(async () => {
    // Cleanup test data
    if (testSalesmanWithNullPartyId) {
      await supabase.from('users').delete().eq('id', testSalesmanWithNullPartyId)
    }
    if (testSalesmanWithOutOfHierarchyPartyId) {
      await supabase.from('users').delete().eq('id', testSalesmanWithOutOfHierarchyPartyId)
    }
    if (testSalesmanWithValidPartyId) {
      await supabase.from('users').delete().eq('id', testSalesmanWithValidPartyId)
    }
    if (testOtherCompanyId) {
      await supabase.from('parties').delete().eq('id', testOtherCompanyId)
    }
  })

  it('should include salesmen with NULL party_id in /api/v1/parties/salesmen', async () => {
    // Call the API endpoint
    const response = await fetch(`${supabaseUrl.replace('/rest/v1', '')}/api/v1/parties/salesmen`, {
      headers: {
        'x-company-id': testCompanyId,
      }
    })

    const result = await response.json()
    const salesmenIds = result.data?.map((s: any) => s.id) || []

    console.log('\n🔍 /api/v1/parties/salesmen Results:')
    console.log(`   Total salesmen returned: ${salesmenIds.length}`)
    console.log(`   Salesman with NULL party_id included: ${salesmenIds.includes(testSalesmanWithNullPartyId)}`)
    console.log(`   Salesman with valid party_id included: ${salesmenIds.includes(testSalesmanWithValidPartyId)}`)

    // **EXPECTED BEHAVIOR**: Salesman with NULL party_id SHOULD be included
    // **BUG CONDITION**: On unfixed code, this will FAIL (salesman is excluded)
    expect(salesmenIds).toContain(testSalesmanWithNullPartyId)
  })

  it('should include salesmen with out-of-hierarchy party_id in /api/v1/parties/salesmen', async () => {
    // Call the API endpoint
    const response = await fetch(`${supabaseUrl.replace('/rest/v1', '')}/api/v1/parties/salesmen`, {
      headers: {
        'x-company-id': testCompanyId,
      }
    })

    const result = await response.json()
    const salesmenIds = result.data?.map((s: any) => s.id) || []

    console.log('\n🔍 /api/v1/parties/salesmen Results (out-of-hierarchy):')
    console.log(`   Total salesmen returned: ${salesmenIds.length}`)
    console.log(`   Salesman with out-of-hierarchy party_id included: ${salesmenIds.includes(testSalesmanWithOutOfHierarchyPartyId)}`)

    // **EXPECTED BEHAVIOR**: Salesman with out-of-hierarchy party_id SHOULD be included
    // **BUG CONDITION**: On unfixed code, this will FAIL (salesman is excluded)
    expect(salesmenIds).toContain(testSalesmanWithOutOfHierarchyPartyId)
  })

  it('should include salesmen with NULL party_id in /api/v1/tracking/salesmen', async () => {
    // Call the API endpoint
    const response = await fetch(`${supabaseUrl.replace('/rest/v1', '')}/api/v1/tracking/salesmen`, {
      headers: {
        'x-company-id': testCompanyId,
      }
    })

    const result = await response.json()
    const salesmenIds = result.data?.map((s: any) => s.id) || []

    console.log('\n🔍 /api/v1/tracking/salesmen Results:')
    console.log(`   Total salesmen returned: ${salesmenIds.length}`)
    console.log(`   Salesman with NULL party_id included: ${salesmenIds.includes(testSalesmanWithNullPartyId)}`)

    // **EXPECTED BEHAVIOR**: Salesman with NULL party_id SHOULD be included
    // **BUG CONDITION**: On unfixed code, this will FAIL (salesman is excluded)
    expect(salesmenIds).toContain(testSalesmanWithNullPartyId)
  })

  it('should include salesmen with NULL party_id in /api/v1/salesman-downline', async () => {
    // Call the API endpoint
    const response = await fetch(`${supabaseUrl.replace('/rest/v1', '')}/api/v1/salesman-downline`, {
      headers: {
        'x-company-id': testCompanyId,
      }
    })

    const result = await response.json()
    const salesmenIds = result.data?.salesmen?.map((s: any) => s.id) || []

    console.log('\n🔍 /api/v1/salesman-downline Results:')
    console.log(`   Total salesmen returned: ${salesmenIds.length}`)
    console.log(`   Salesman with NULL party_id included: ${salesmenIds.includes(testSalesmanWithNullPartyId)}`)

    // **EXPECTED BEHAVIOR**: Salesman with NULL party_id SHOULD be included
    // **BUG CONDITION**: On unfixed code, this will FAIL (salesman is excluded)
    expect(salesmenIds).toContain(testSalesmanWithNullPartyId)
  })
})
