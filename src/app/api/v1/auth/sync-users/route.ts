import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-server'

/**
 * GET /api/v1/auth/sync-users
 * Finds auth users without corresponding users table entries and creates them.
 * Run this when companies were created but admin users weren't fully provisioned.
 */
export async function GET(req: NextRequest) {
  try {
    // Get ADMIN role ID
    const { data: roleRow } = await supabaseAdmin
      .from('roles')
      .select('id')
      .eq('name', 'ADMIN')
      .single()

    if (!roleRow) {
      return NextResponse.json({ error: 'ADMIN role not found' }, { status: 500 })
    }

    // Get all auth users with portal.internal email pattern
    const { data: authUsers, error: authError } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 })
    if (authError) {
      return NextResponse.json({ error: authError.message }, { status: 500 })
    }

    // Get all existing users table entries
    const { data: existingUsers, error: usersError } = await supabaseAdmin
      .from('users')
      .select('id, email, phone, party_id')
      .neq('status', 'DELETED')

    if (usersError) {
      return NextResponse.json({ error: usersError.message }, { status: 500 })
    }

    const existingUserIds = new Set((existingUsers || []).map(u => u.id))

    // Get all companies
    const COMPANY_TYPE_ID = 'fdcc59d3-fdc1-4700-94eb-3c2cf7e28c03'
    const { data: companies, error: companiesError } = await supabaseAdmin
      .from('parties')
      .select('id, name, portal_phone')
      .eq('party_type_id', COMPANY_TYPE_ID)
      .neq('status', 'DELETED')

    if (companiesError) {
      return NextResponse.json({ error: companiesError.message }, { status: 500 })
    }

    // Map company ID prefix to company
    const companyMap: Record<string, { id: string; name: string; portal_phone: string }> = {}
    for (const c of companies || []) {
      companyMap[c.id.substring(0, 8)] = c
    }

    // Find orphaned auth users (auth users without users table entry)
    const portalUsers = (authUsers?.users || []).filter(u => u.email?.endsWith('@portal.internal'))
    const orphans = portalUsers.filter(u => !existingUserIds.has(u.id))

    console.log('[SYNC-USERS] Found', orphans.length, 'orphaned auth users')

    const results: Array<{
      email: string
      status: 'created' | 'skipped' | 'error'
      message?: string
    }> = []

    for (const orphan of orphans) {
      const email = orphan.email!
      const phoneMatch = email.match(/^(\d+)_([a-f0-9]+)@portal\.internal$/)

      if (!phoneMatch) {
        results.push({ email, status: 'skipped', message: 'Invalid email format' })
        continue
      }

      const phone = phoneMatch[1]
      const companyPrefix = phoneMatch[2]
      const company = companyMap[companyPrefix]

      if (!company) {
        results.push({ email, status: 'skipped', message: `Company not found for prefix ${companyPrefix}` })
        continue
      }

      // Create users table entry
      const { error: insertError } = await supabaseAdmin
        .from('users')
        .insert({
          id: orphan.id,
          name: company.name || 'Company Admin',
          email: email,
          phone: company.portal_phone || phone,
          role_id: roleRow.id,
          party_id: company.id,
          status: 'ACTIVE',
        })

      if (insertError) {
        results.push({ email, status: 'error', message: insertError.message })
      } else {
        results.push({ email, status: 'created', message: `Linked to company ${company.name}` })
      }
    }

    return NextResponse.json({
      success: true,
      orphanedCount: orphans.length,
      processed: results,
      summary: {
        created: results.filter(r => r.status === 'created').length,
        skipped: results.filter(r => r.status === 'skipped').length,
        errors: results.filter(r => r.status === 'error').length,
      }
    })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Sync failed' },
      { status: 500 }
    )
  }
}