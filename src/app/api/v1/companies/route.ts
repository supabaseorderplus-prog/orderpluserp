import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, getUserFromToken } from '@/lib/supabase-server'

export async function GET(req: NextRequest) {
  let stage = 'init'
  try {
    stage = 'auth'
    const caller = await getUserFromToken(req)
    if (!caller) {
      return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 })
    }
    if (caller.role !== 'SUPER_ADMIN') {
      return NextResponse.json({ success: false, message: 'Forbidden' }, { status: 403 })
    }

    // Get COMPANY party type id
    stage = 'load-company-type'
    const { data: typeRow, error: typeErr } = await supabaseAdmin
      .from('party_types')
      .select('id')
      .eq('name', 'COMPANY')
      .single()

    if (typeErr || !typeRow) {
      return NextResponse.json({ success: true, data: [] })
    }

    // Get all COMPANY parties (ACTIVE + SUSPENDED).
    // DBs in this project can have either:
    // - phone/email/address (+ optional logo_url), or
    // - contact_phone/contact_email/city (+ optional logo_url).
    type PartyRow = {
      id: string
      name: string
      party_code: string
      status: string
      gstin: string | null
      created_at: string
      phone?: string | null
      email?: string | null
      address?: string | null
      contact_phone?: string | null
      contact_email?: string | null
      city?: string | null
      logo_url?: string | null
    }

    const partySelects = [
      'id, name, party_code, phone, email, address, status, gstin, logo_url, created_at',
      'id, name, party_code, phone, email, address, status, gstin, created_at',
      'id, name, party_code, contact_phone, contact_email, city, status, gstin, logo_url, created_at',
      'id, name, party_code, contact_phone, contact_email, city, status, gstin, created_at',
    ]

    let companies: PartyRow[] | null = null
    let companiesErr: { code?: string; message?: string } | null = null
    for (const selectCols of partySelects) {
      stage = `load-companies-select:${selectCols}`
      const result = await supabaseAdmin
        .from('parties')
        .select(selectCols)
        .eq('party_type_id', typeRow.id)
        .in('status', ['ACTIVE', 'SUSPENDED'])
        .order('name', { ascending: true })
      if (!result.error) {
        companies = result.data as unknown as PartyRow[] | null
        companiesErr = null
        break
      }
      companiesErr = result.error
      if (result.error.code !== '42703') break
    }

    if (companiesErr) {
      console.error('[companies] parties error:', companiesErr)
      return NextResponse.json({ success: true, data: [] })
    }

    if (!companies || companies.length === 0) {
      return NextResponse.json({ success: true, data: [] })
    }

    const companyIds = companies.map((c) => c.id)

    // Count users per company (users linked via party_id)
    stage = 'load-users'
    const { data: allUsers, error: usersErr } = await supabaseAdmin
      .from('app_users')
      .select('id, party_id, status, last_login')
      .in('party_id', companyIds)

    if (usersErr) {
      console.error('[companies] users error:', usersErr)
    }

    // Sum outstanding per company
    stage = 'load-invoices'
    const { data: allInvoices, error: invoicesErr } = await supabaseAdmin
      .from('invoices')
      .select('supplier_id, amount_outstanding, payment_status, is_cancelled, aging_bucket')
      .in('supplier_id', companyIds)
      .in('payment_status', ['UNPAID', 'PARTIAL'])
      .eq('is_cancelled', false)

    if (invoicesErr) {
      console.error('[companies] invoices error:', invoicesErr)
    }

    // Get last invoice date per company
    stage = 'load-last-invoice'
    const { data: lastInvoices } = await supabaseAdmin
      .from('invoices')
      .select('supplier_id, invoice_date, created_at')
      .in('supplier_id', companyIds)
      .eq('is_cancelled', false)
      .order('invoice_date', { ascending: false })

    const lastInvoiceMap: Record<string, string | null> = {}
    ;(lastInvoices || []).forEach(inv => {
      if (!lastInvoiceMap[inv.supplier_id]) {
        lastInvoiceMap[inv.supplier_id] = inv.invoice_date || inv.created_at || null
      }
    })

    stage = 'build-response'
    const enriched = companies.map((c) => {
      const companyUsers = (allUsers || []).filter(u => u.party_id === c.id)
      const totalUsers = companyUsers.length
      const activeUsers = companyUsers.filter(u => u.status === 'ACTIVE').length

      // Last login across all users of this company
      const lastLogins = companyUsers
        .filter(u => u.last_login)
        .map(u => new Date(u.last_login as string).getTime())
        .filter((ts) => Number.isFinite(ts))
      const lastLogin = lastLogins.length > 0
        ? new Date(Math.max(...lastLogins)).toISOString()
        : null

      const companyInvoices = (allInvoices || []).filter(i => i.supplier_id === c.id)
      const outstanding = companyInvoices.reduce((s, i) => s + Number(i.amount_outstanding || 0), 0)
      const overdue = companyInvoices
        .filter(i => ['BUCKET_2', 'BUCKET_3', 'BUCKET_4'].includes(i.aging_bucket))
        .reduce((s, i) => s + Number(i.amount_outstanding || 0), 0)

      return {
        ...c,
        contact_phone: c.phone ?? c.contact_phone ?? null,
        contact_email: c.email ?? c.contact_email ?? null,
        city: c.address ?? c.city ?? null,
        totalUsers,
        activeUsers,
        outstanding,
        overdue,
        lastLogin,
        lastInvoiceDate: lastInvoiceMap[c.id] || null,
      }
    })

    stage = 'done'
    return NextResponse.json({ success: true, data: enriched })
  } catch (err) {
    console.error('[companies GET] caught:', { stage, err })
    return NextResponse.json(
      {
        success: false,
        message: err instanceof Error ? err.message : 'Failed',
        stage: process.env.NODE_ENV === 'development' ? stage : undefined,
      },
      { status: 500 }
    )
  }
}
