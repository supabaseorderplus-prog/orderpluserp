import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, getUserFromToken } from '@/lib/supabase-server'

export async function GET(req: NextRequest) {
  const caller = await getUserFromToken(req)
  if (!caller || caller.role !== 'SUPER_ADMIN') {
    return NextResponse.json({ success: false, message: 'Forbidden' }, { status: 403 })
  }

  const { data: typeRow } = await supabaseAdmin
    .from('party_types')
    .select('id')
    .eq('name', 'COMPANY')
    .single()

  if (!typeRow) {
    return NextResponse.json({ success: true, data: '' })
  }

  const { data: companies } = await supabaseAdmin
    .from('parties')
    .select('id, name, party_code, contact_phone, contact_email, city, status, gstin, created_at')
    .eq('party_type_id', typeRow.id)
    .in('status', ['ACTIVE', 'SUSPENDED'])
    .order('name', { ascending: true })

  if (!companies || companies.length === 0) {
    return new NextResponse('name,party_code,city,phone,email,status,gstin\n', {
      headers: {
        'Content-Type': 'text/csv',
        'Content-Disposition': 'attachment; filename="companies.csv"',
      },
    })
  }

  const companyIds = companies.map(c => c.id)

  const { data: allInvoices } = await supabaseAdmin
    .from('invoices')
    .select('supplier_id, amount_outstanding')
    .in('supplier_id', companyIds)
    .in('payment_status', ['UNPAID', 'PARTIAL'])
    .eq('is_cancelled', false)

  const outstandingMap: Record<string, number> = {}
  ;(allInvoices || []).forEach(inv => {
    outstandingMap[inv.supplier_id] = (outstandingMap[inv.supplier_id] || 0) + Number(inv.amount_outstanding || 0)
  })

  const header = 'Company Name,Party Code,City,Phone,Email,Status,GSTIN,Outstanding (INR)\n'
  const rows = companies.map(c => {
    const outstanding = outstandingMap[c.id] || 0
    return [
      `"${(c.name || '').replace(/"/g, '""')}"`,
      c.party_code || '',
      c.city || '',
      c.contact_phone || '',
      c.contact_email || '',
      c.status || '',
      c.gstin || '',
      outstanding.toFixed(2),
    ].join(',')
  })

  const csv = header + rows.join('\n')

  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv',
      'Content-Disposition': 'attachment; filename="companies.csv"',
    },
  })
}
