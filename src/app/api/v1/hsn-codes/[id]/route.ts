import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-server'

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const body = await req.json()
    const updates: Record<string, unknown> = {}

    if (body.hsn_code !== undefined) updates.hsn_code = String(body.hsn_code).trim()
    if (body.gst_rate !== undefined) updates.gst_rate = Number(body.gst_rate)
    if (body.cess_rate !== undefined) updates.cess_rate = Number(body.cess_rate)
    if (body.description !== undefined) updates.description = body.description ? String(body.description).trim() : ''

    const { data, error } = await supabaseAdmin
      .from('hsn_codes')
      .update(updates)
      .eq('id', id)
      .select()
      .single()

    if (error) throw error
    return NextResponse.json({ success: true, data })
  } catch (err) {
    return NextResponse.json({ success: false, message: err instanceof Error ? err.message : 'Failed to update HSN code' }, { status: 500 })
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params

    // Check if any products use this HSN code
    const { count } = await supabaseAdmin
      .from('products')
      .select('id', { count: 'exact', head: true })
      .eq('hsn_code_id', id)

    if ((count || 0) > 0) {
      return NextResponse.json(
        { success: false, message: `Cannot delete — ${count} product(s) use this HSN code. Reassign them first.` },
        { status: 400 }
      )
    }

    const { error } = await supabaseAdmin
      .from('hsn_codes')
      .delete()
      .eq('id', id)

    if (error) throw error
    return NextResponse.json({ success: true })
  } catch (err) {
    return NextResponse.json({ success: false, message: err instanceof Error ? err.message : 'Failed to delete HSN code' }, { status: 500 })
  }
}
