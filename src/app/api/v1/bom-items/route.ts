import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, getUserFromToken, resolveCompanyScope } from '@/lib/supabase-server'
import { BOM_INVENTORY_SCHEMA_NOT_READY_MESSAGE, ensureBomInventorySchema, isBomInventorySchemaGap } from '@/lib/bom-inventory-schema'

export async function GET(req: NextRequest) {
  try {
    await ensureBomInventorySchema()
    const authUser = await getUserFromToken(req)
    if (!authUser) return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 })

    const companyId = await resolveCompanyScope(req, authUser)
    if (!companyId) return NextResponse.json({ success: false, message: 'Company not found' }, { status: 403 })

    const { data, error } = await supabaseAdmin
      .from('bom_items')
      .select('*')
      .eq('company_id', companyId)
      .order('created_at', { ascending: false })

    if (error) throw error

    return NextResponse.json({ success: true, data: data || [] })
  } catch (err) {
    console.error('[GET /api/v1/bom-items]', err)
    return NextResponse.json(
      { success: false, message: isBomInventorySchemaGap(err) ? BOM_INVENTORY_SCHEMA_NOT_READY_MESSAGE : err instanceof Error ? err.message : 'Failed to fetch BOMs' },
      { status: isBomInventorySchemaGap(err) ? 503 : 500 }
    )
  }
}

export async function POST(req: NextRequest) {
  try {
    await ensureBomInventorySchema()
    const authUser = await getUserFromToken(req)
    if (!authUser) return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 })

    const companyId = await resolveCompanyScope(req, authUser)
    if (!companyId) return NextResponse.json({ success: false, message: 'Company not found' }, { status: 403 })

    const body = await req.json()
    const { product_name, product_code, batch_size, batch_unit, description, components } = body

    if (!product_name?.trim()) {
      return NextResponse.json({ success: false, message: 'product_name is required' }, { status: 400 })
    }

    const { data, error } = await supabaseAdmin
      .from('bom_items')
      .insert({
        company_id: companyId,
        product_name: product_name.trim(),
        product_code: product_code || '',
        batch_size: Number(batch_size) || 1,
        batch_unit: batch_unit || 'kg',
        description: description || '',
        components: components || [],
      })
      .select('*')
      .single()

    if (error) throw error

    return NextResponse.json({ success: true, data }, { status: 201 })
  } catch (err) {
    console.error('[POST /api/v1/bom-items]', err)
    return NextResponse.json(
      { success: false, message: isBomInventorySchemaGap(err) ? BOM_INVENTORY_SCHEMA_NOT_READY_MESSAGE : err instanceof Error ? err.message : 'Failed to create BOM' },
      { status: isBomInventorySchemaGap(err) ? 503 : 500 }
    )
  }
}

export async function PUT(req: NextRequest) {
  try {
    await ensureBomInventorySchema()
    const authUser = await getUserFromToken(req)
    if (!authUser) return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 })

    const companyId = await resolveCompanyScope(req, authUser)
    if (!companyId) return NextResponse.json({ success: false, message: 'Company not found' }, { status: 403 })

    const body = await req.json()
    const { id, product_name, product_code, batch_size, batch_unit, description, components } = body

    if (!id) return NextResponse.json({ success: false, message: 'id required' }, { status: 400 })

    // Verify ownership
    const { data: existing } = await supabaseAdmin
      .from('bom_items')
      .select('company_id')
      .eq('id', id)
      .single()

    if (!existing || existing.company_id !== companyId) {
      return NextResponse.json({ success: false, message: 'Not found or access denied' }, { status: 403 })
    }

    const { data, error } = await supabaseAdmin
      .from('bom_items')
      .update({
        product_name: product_name?.trim(),
        product_code: product_code ?? undefined,
        batch_size: batch_size !== undefined ? Number(batch_size) : undefined,
        batch_unit: batch_unit ?? undefined,
        description: description ?? undefined,
        components: components ?? undefined,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select('*')
      .single()

    if (error) throw error

    return NextResponse.json({ success: true, data })
  } catch (err) {
    console.error('[PUT /api/v1/bom-items]', err)
    return NextResponse.json(
      { success: false, message: isBomInventorySchemaGap(err) ? BOM_INVENTORY_SCHEMA_NOT_READY_MESSAGE : err instanceof Error ? err.message : 'Failed to update BOM' },
      { status: isBomInventorySchemaGap(err) ? 503 : 500 }
    )
  }
}

export async function DELETE(req: NextRequest) {
  try {
    await ensureBomInventorySchema()
    const authUser = await getUserFromToken(req)
    if (!authUser) return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 })

    const companyId = await resolveCompanyScope(req, authUser)
    if (!companyId) return NextResponse.json({ success: false, message: 'Company not found' }, { status: 403 })

    const id = new URL(req.url).searchParams.get('id')
    if (!id) return NextResponse.json({ success: false, message: 'id required' }, { status: 400 })

    // Verify ownership
    const { data: existing } = await supabaseAdmin
      .from('bom_items')
      .select('company_id')
      .eq('id', id)
      .single()

    if (!existing || existing.company_id !== companyId) {
      return NextResponse.json({ success: false, message: 'Not found or access denied' }, { status: 403 })
    }

    const { error } = await supabaseAdmin
      .from('bom_items')
      .delete()
      .eq('id', id)

    if (error) throw error

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('[DELETE /api/v1/bom-items]', err)
    return NextResponse.json(
      { success: false, message: isBomInventorySchemaGap(err) ? BOM_INVENTORY_SCHEMA_NOT_READY_MESSAGE : err instanceof Error ? err.message : 'Failed to delete BOM' },
      { status: isBomInventorySchemaGap(err) ? 503 : 500 }
    )
  }
}
