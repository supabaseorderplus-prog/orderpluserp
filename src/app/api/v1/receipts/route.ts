import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, getUserFromToken, resolveCompanyScope, getPartyDescendants } from '@/lib/supabase-server'

export async function GET(req: NextRequest) {
  try {
    const authUser = await getUserFromToken(req)
    const companyId = await resolveCompanyScope(req, authUser)

    const url = new URL(req.url)
    const partyId = url.searchParams.get('party_id')
    const salesmanId = url.searchParams.get('salesman_id')
    const approvalStatus = url.searchParams.get('approval_status')
    const from = url.searchParams.get('from')
    const to = url.searchParams.get('to')
    const page = parseInt(url.searchParams.get('page') || '1')
    const limit = parseInt(url.searchParams.get('limit') || '20')
    const offset = (page - 1) * limit

    let query = supabaseAdmin
      .from('receipts')
      .select('*, parties(id, name, phone)', { count: 'exact' })
      .eq('status', 'ACTIVE')
      .order('receipt_date', { ascending: false })
      .range(offset, offset + limit - 1)

    if (companyId) query = query.eq('company_id', companyId)
    if (partyId) query = query.eq('party_id', partyId)
    if (salesmanId) query = query.eq('salesman_id', salesmanId)
    if (approvalStatus) query = query.eq('approval_status', approvalStatus)
    if (from) query = query.gte('receipt_date', from)
    if (to) query = query.lte('receipt_date', to)

    let { data, count, error } = await query
    if (error && (error.code === 'PGRST200' || error.code === 'PGRST204' || error.code === '42703')) {
      // Fallback for relation/column mismatches (phone vs contact_phone, missing FK mapping, etc.)
      let fallback = supabaseAdmin
        .from('receipts')
        .select('*', { count: 'exact' })
        .eq('status', 'ACTIVE')
        .order('receipt_date', { ascending: false })
        .range(offset, offset + limit - 1)
      if (companyId) fallback = fallback.eq('company_id', companyId)
      if (partyId) fallback = fallback.eq('party_id', partyId)
      if (salesmanId) fallback = fallback.eq('salesman_id', salesmanId)
      if (approvalStatus) fallback = fallback.eq('approval_status', approvalStatus)
      if (from) fallback = fallback.gte('receipt_date', from)
      if (to) fallback = fallback.lte('receipt_date', to)
      const retry = await fallback
      data = retry.data
      count = retry.count
      error = retry.error
    }
    if (error && (error.code === 'PGRST205' || error.code === '42P01' || (error.message || '').includes("Could not find the table 'public.receipts'"))) {
      return NextResponse.json({
        success: true,
        data: [],
        pagination: { page, limit, total: 0, pages: 0 },
      })
    }
    if (error) throw error

    return NextResponse.json({
      success: true,
      data: data || [],
      pagination: { page, limit, total: count || 0, pages: Math.ceil((count || 0) / limit) },
    })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed to fetch receipts' },
      { status: 500 }
    )
  }
}

export async function POST(req: NextRequest) {
  try {
    const authUser = await getUserFromToken(req)
    const companyId = await resolveCompanyScope(req, authUser)
    const body = await req.json()

    const { party_id, amount, payment_mode, reference_number, bank_name, notes, salesman_id } = body

    if (!party_id || !amount || !payment_mode) {
      return NextResponse.json(
        { success: false, message: 'party_id, amount, and payment_mode are required' },
        { status: 400 }
      )
    }

    // Verify party access
    if (companyId) {
      const tree = await getPartyDescendants(companyId)
      const treeIds = tree && tree.length > 0 ? tree.map((r: { id: string }) => r.id) : []
      if (!treeIds.includes(companyId)) treeIds.push(companyId)
      if (!treeIds.includes(party_id)) {
        return NextResponse.json({ success: false, message: 'Party not found or access denied' }, { status: 403 })
      }
    }

    // Generate receipt number
    const seq = Date.now().toString(36).toUpperCase()
    const receipt_number = `RCP-${seq}`

    const { data: receipt, error } = await supabaseAdmin
      .from('receipts')
      .insert({
        company_id: companyId || null,
        receipt_number,
        party_id,
        salesman_id: salesman_id || authUser?.app_user_id || authUser?.id || null,
        amount: Number(amount),
        payment_mode,
        reference_number: reference_number || null,
        bank_name: bank_name || null,
        notes: notes || null,
        receipt_date: new Date().toISOString().split('T')[0],
        approval_status: 'PENDING_APPROVAL',
        status: 'ACTIVE',
        created_by: authUser?.app_user_id || authUser?.id || null,
      })
      .select()
      .single()

    if (error) throw error

    return NextResponse.json({ success: true, data: receipt }, { status: 201 })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed to create receipt' },
      { status: 500 }
    )
  }
}
