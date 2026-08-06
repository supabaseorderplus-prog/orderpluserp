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
      .from('raw_materials')
      .select('*')
      .eq('company_id', companyId)
      .eq('status', 'ACTIVE')
      .order('created_at', { ascending: false })

    if (error) throw error

    return NextResponse.json({ success: true, data: data || [] })
  } catch (err) {
    console.error('[GET /api/v1/raw-materials]', err)
    return NextResponse.json(
      { success: false, message: isBomInventorySchemaGap(err) ? BOM_INVENTORY_SCHEMA_NOT_READY_MESSAGE : err instanceof Error ? err.message : 'Failed to fetch materials' },
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
    const { name, code, category, unit, current_stock, min_stock, max_stock, cost_per_unit, location, supplier } = body

    if (!name?.trim()) {
      return NextResponse.json({ success: false, message: 'name is required' }, { status: 400 })
    }

    const { data, error } = await supabaseAdmin
      .from('raw_materials')
      .insert({
        company_id: companyId,
        name: name.trim(),
        code: code || '',
        category: category || 'Raw Material',
        unit: unit || 'kg',
        current_stock: Number(current_stock) || 0,
        min_stock: Number(min_stock) || 0,
        max_stock: Number(max_stock) || 0,
        cost_per_unit: Number(cost_per_unit) || 0,
        location: location || '',
        supplier: supplier || '',
      })
      .select('*')
      .single()

    if (error) throw error

    return NextResponse.json({ success: true, data }, { status: 201 })
  } catch (err) {
    console.error('[POST /api/v1/raw-materials]', err)
    return NextResponse.json(
      { success: false, message: isBomInventorySchemaGap(err) ? BOM_INVENTORY_SCHEMA_NOT_READY_MESSAGE : err instanceof Error ? err.message : 'Failed to create material' },
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
    const { id, name, code, category, unit, current_stock, min_stock, max_stock, cost_per_unit, location, supplier } = body

    if (!id) return NextResponse.json({ success: false, message: 'id required' }, { status: 400 })

    // Verify ownership
    const { data: existing } = await supabaseAdmin
      .from('raw_materials')
      .select('company_id')
      .eq('id', id)
      .single()

    if (!existing || existing.company_id !== companyId) {
      return NextResponse.json({ success: false, message: 'Not found or access denied' }, { status: 403 })
    }

    const { data, error } = await supabaseAdmin
      .from('raw_materials')
      .update({
        name: name?.trim(),
        code: code ?? undefined,
        category: category ?? undefined,
        unit: unit ?? undefined,
        current_stock: current_stock !== undefined ? Number(current_stock) : undefined,
        min_stock: min_stock !== undefined ? Number(min_stock) : undefined,
        max_stock: max_stock !== undefined ? Number(max_stock) : undefined,
        cost_per_unit: cost_per_unit !== undefined ? Number(cost_per_unit) : undefined,
        location: location ?? undefined,
        supplier: supplier ?? undefined,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select('*')
      .single()

    if (error) throw error

    return NextResponse.json({ success: true, data })
  } catch (err) {
    console.error('[PUT /api/v1/raw-materials]', err)
    return NextResponse.json(
      { success: false, message: isBomInventorySchemaGap(err) ? BOM_INVENTORY_SCHEMA_NOT_READY_MESSAGE : err instanceof Error ? err.message : 'Failed to update material' },
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
      .from('raw_materials')
      .select('company_id')
      .eq('id', id)
      .single()

    if (!existing || existing.company_id !== companyId) {
      return NextResponse.json({ success: false, message: 'Not found or access denied' }, { status: 403 })
    }

    // Soft-delete
    const { error } = await supabaseAdmin
      .from('raw_materials')
      .update({ status: 'DELETED', updated_at: new Date().toISOString() })
      .eq('id', id)

    if (error) throw error

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('[DELETE /api/v1/raw-materials]', err)
    return NextResponse.json(
      { success: false, message: isBomInventorySchemaGap(err) ? BOM_INVENTORY_SCHEMA_NOT_READY_MESSAGE : err instanceof Error ? err.message : 'Failed to delete material' },
      { status: isBomInventorySchemaGap(err) ? 503 : 500 }
    )
  }
}
