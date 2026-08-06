import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, getUserFromToken, resolveCompanyScope } from '@/lib/supabase-server'

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const authUser = await getUserFromToken(req)
    const companyId = await resolveCompanyScope(req, authUser)
    const { id } = await params

    const { data, error } = await supabaseAdmin
      .from('procurement_orders')
      .select('*, procurement_order_items(*)')
      .eq('id', id)
      .single()

    if (error || !data) return NextResponse.json({ success: false, message: 'Not found' }, { status: 404 })
    if (companyId && data.company_id !== companyId) {
      return NextResponse.json({ success: false, message: 'Access denied' }, { status: 403 })
    }

    return NextResponse.json({ success: true, data })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed to fetch procurement order' },
      { status: 500 }
    )
  }
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const authUser = await getUserFromToken(req)
    const companyId = await resolveCompanyScope(req, authUser)
    const { id } = await params
    const body = await req.json()

    const { data: existing } = await supabaseAdmin.from('procurement_orders').select('company_id, status').eq('id', id).single()
    if (!existing) return NextResponse.json({ success: false, message: 'Not found' }, { status: 404 })
    if (companyId && existing.company_id !== companyId) {
      return NextResponse.json({ success: false, message: 'Access denied' }, { status: 403 })
    }
    if (['RECEIVED', 'CANCELLED'].includes(existing.status)) {
      return NextResponse.json({ success: false, message: 'Cannot edit a completed or cancelled order' }, { status: 400 })
    }

    const { items, ...poFields } = body
    if (Object.keys(poFields).length > 0) {
      await supabaseAdmin.from('procurement_orders').update(poFields).eq('id', id)
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed to update procurement order' },
      { status: 500 }
    )
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const authUser = await getUserFromToken(req)
    const companyId = await resolveCompanyScope(req, authUser)
    const { id } = await params

    const { data: existing } = await supabaseAdmin.from('procurement_orders').select('company_id, status').eq('id', id).single()
    if (!existing) return NextResponse.json({ success: false, message: 'Not found' }, { status: 404 })
    if (companyId && existing.company_id !== companyId) {
      return NextResponse.json({ success: false, message: 'Access denied' }, { status: 403 })
    }
    if (existing.status === 'RECEIVED') {
      return NextResponse.json({ success: false, message: 'Received orders cannot be deleted' }, { status: 400 })
    }

    await supabaseAdmin.from('procurement_orders').update({ status: 'CANCELLED' }).eq('id', id)
    return NextResponse.json({ success: true })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed to cancel procurement order' },
      { status: 500 }
    )
  }
}
