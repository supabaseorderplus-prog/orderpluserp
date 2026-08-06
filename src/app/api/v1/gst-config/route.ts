import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, getUserFromToken, resolveCompanyScope } from '@/lib/supabase-server'

export async function GET(req: NextRequest) {
  try {
    const authUser = await getUserFromToken(req)
    const companyId = await resolveCompanyScope(req, authUser)

    let query = supabaseAdmin
      .from('gst_config')
      .select('*')
      .eq('status', 'ACTIVE')
      .order('created_at', { ascending: false })

    if (companyId) {
      query = query.eq('company_id', companyId)
    }

    const { data, error } = await query
    if (error) {
      // Table doesn't exist yet — return empty config gracefully
      const code = (error as { code?: string }).code || ''
      if (code === '42P01' || code === 'PGRST200' || code === 'PGRST204' || error.message?.includes('does not exist')) {
        return NextResponse.json({ success: true, data: [] })
      }
      throw error
    }
    return NextResponse.json({ success: true, data: data || [] })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed to fetch GST config' },
      { status: 500 }
    )
  }
}

export async function PUT(req: NextRequest) {
  try {
    const body = await req.json()
    const { id, invoice_prefix, invoice_series, current_sequence, gst_number, company_name, company_address, company_state_code } = body

    const authUser = await getUserFromToken(req)
    const companyId = await resolveCompanyScope(req, authUser)

    if (!id) {
      return NextResponse.json({ success: false, message: 'id is required' }, { status: 400 })
    }

    // Verify company access before update
    if (companyId) {
      const { data: existingConfig } = await supabaseAdmin
        .from('gst_config')
        .select('company_id')
        .eq('id', id)
        .single()

      if (!existingConfig || existingConfig.company_id !== companyId) {
        return NextResponse.json({ success: false, message: 'GST config not found or access denied' }, { status: 403 })
      }
    }

    const updates: Record<string, unknown> = {}
    if (invoice_prefix !== undefined) updates.invoice_prefix = String(invoice_prefix).trim().toUpperCase()
    if (invoice_series !== undefined) updates.invoice_series = String(invoice_series).trim().toUpperCase()
    if (current_sequence !== undefined) updates.current_sequence = Number(current_sequence)
    if (gst_number !== undefined) updates.gst_number = gst_number ? String(gst_number).trim() : null
    if (company_name !== undefined) updates.company_name = company_name ? String(company_name).trim() : null
    if (company_address !== undefined) updates.company_address = company_address ? String(company_address).trim() : null
    if (company_state_code !== undefined) updates.company_state_code = company_state_code ? String(company_state_code).trim() : null

    const { data, error } = await supabaseAdmin
      .from('gst_config')
      .update(updates)
      .eq('id', id)
      .select()
      .single()

    if (error) throw error
    return NextResponse.json({ success: true, data })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed to update GST config' },
      { status: 500 }
    )
  }
}
