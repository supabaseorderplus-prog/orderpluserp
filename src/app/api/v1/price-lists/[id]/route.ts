import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, getUserFromToken, resolveCompanyScope } from '@/lib/supabase-server'
import { ensureGroupsSchema } from '@/lib/groups'
import { ensurePricingSchema, isMissingCompanyIdColumn, isPricingSchemaGap, PRICING_SCHEMA_NOT_READY_MESSAGE } from '@/lib/pricing-schema'
import { deleteFallbackPriceList, getFallbackPriceListById, updateFallbackPriceList } from '@/lib/price-lists-fallback'

const COMPANY_SCOPE_MARKER = '||CID:'

type PriceListRow = Record<string, unknown> & {
  notes?: string | null
}

function sanitizeLegacyScopeMarker(value: unknown): string {
  return String(value ?? '').replaceAll(COMPANY_SCOPE_MARKER, ' ').trim()
}

function encodeLegacyScopedNotes(notes: unknown, companyId: string): string {
  const cleanNotes = sanitizeLegacyScopeMarker(notes)
  return cleanNotes ? `${cleanNotes}\n${COMPANY_SCOPE_MARKER}${companyId}` : `${COMPANY_SCOPE_MARKER}${companyId}`
}

function decodeLegacyScopeFromNotes(notes: unknown): string | null {
  if (typeof notes !== 'string') return null
  const markerIndex = notes.lastIndexOf(COMPANY_SCOPE_MARKER)
  if (markerIndex === -1) return null
  return notes.slice(markerIndex + COMPANY_SCOPE_MARKER.length).split(/\s/)[0]?.trim() || null
}

function stripLegacyScopeFromNotes(notes: unknown): string | null {
  if (typeof notes !== 'string') return notes == null ? null : String(notes)
  const markerIndex = notes.lastIndexOf(COMPANY_SCOPE_MARKER)
  if (markerIndex === -1) return notes
  return notes.slice(0, markerIndex).trim() || null
}

function sanitizePriceListRow<T extends PriceListRow>(row: T | null): T | null {
  if (!row) return row
  return { ...row, notes: stripLegacyScopeFromNotes(row.notes) }
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params

    const authUser = await getUserFromToken(req)
    if (!authUser) {
      return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 })
    }
    const companyId = await resolveCompanyScope(req, authUser)
    if (!companyId) {
      return NextResponse.json({ success: false, message: 'Select a company to view pricing data' }, { status: 403 })
    }

    await ensurePricingSchema()

    let { data, error } = await supabaseAdmin
      .from('price_lists')
      .select('*, price_list_items(*, products(name, sku, base_price, mrp))')
      .eq('id', id)
      .eq('company_id', companyId)
      .single()

    if (error && isMissingCompanyIdColumn(error as { code?: string; message?: string })) {
      const legacy = await supabaseAdmin
        .from('price_lists')
        .select('*, price_list_items(*, products(name, sku, base_price, mrp))')
        .eq('id', id)
        .single()
      if (!legacy.error && decodeLegacyScopeFromNotes((legacy.data as PriceListRow | null)?.notes) === companyId) {
        data = legacy.data
        error = null
      }
    }

    if (error) {
      const fallback = await getFallbackPriceListById(companyId, id)
      if (fallback) {
        return NextResponse.json({ success: true, data: sanitizePriceListRow(fallback as unknown as PriceListRow) })
      }
      if (isPricingSchemaGap(error as { code?: string; message?: string })) {
        return NextResponse.json({ success: false, message: PRICING_SCHEMA_NOT_READY_MESSAGE }, { status: 503 })
      }
      throw error
    }

    return NextResponse.json({ success: true, data: sanitizePriceListRow(data as PriceListRow | null) })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed'
    const status = msg === PRICING_SCHEMA_NOT_READY_MESSAGE ? 503 : 500
    return NextResponse.json({ success: false, message: msg }, { status })
  }
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const body = await req.json()
    const { items, ...priceListData } = body

    const authUser = await getUserFromToken(req)
    if (!authUser) {
      return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 })
    }
    const companyId = await resolveCompanyScope(req, authUser)
    if (!companyId) {
      return NextResponse.json({ success: false, message: 'Select a company before updating price list' }, { status: 403 })
    }

    await ensurePricingSchema()
    await ensureGroupsSchema()

    // Verify company access before update
    let legacyMode = false
    let { data: existingPriceList, error: existingError } = await supabaseAdmin
      .from('price_lists')
      .select('company_id, notes')
      .eq('id', id)
      .eq('company_id', companyId)
      .maybeSingle()

    if (existingError && isPricingSchemaGap(existingError as { code?: string; message?: string })) {
      if (!isMissingCompanyIdColumn(existingError as { code?: string; message?: string })) {
        return NextResponse.json({ success: false, message: PRICING_SCHEMA_NOT_READY_MESSAGE }, { status: 503 })
      }
      const legacyExisting = await supabaseAdmin
        .from('price_lists')
        .select('notes')
        .eq('id', id)
        .maybeSingle()
      if (legacyExisting.error) throw legacyExisting.error
      if (decodeLegacyScopeFromNotes((legacyExisting.data as PriceListRow | null)?.notes) === companyId) {
        existingPriceList = { company_id: companyId, notes: (legacyExisting.data as PriceListRow | null)?.notes || null }
        existingError = null
        legacyMode = true
      }
    }

    if (!existingPriceList) {
      const fallback = await updateFallbackPriceList(companyId, id, {
        name: String(priceListData.name || ''),
        code: String(priceListData.code || ''),
        applicable_party_type: String(priceListData.applicable_party_type || ''),
        party_id: priceListData.party_id ? String(priceListData.party_id) : null,
        group_id: priceListData.group_id ? String(priceListData.group_id) : null,
        valid_from: String(priceListData.valid_from || new Date().toISOString().slice(0, 10)),
        valid_to: priceListData.valid_to ? String(priceListData.valid_to) : null,
        is_current: priceListData.is_current !== false,
        notes: priceListData.notes ? String(priceListData.notes) : null,
        items: Array.isArray(items) ? items.map((item: Record<string, unknown>) => ({
          product_id: String(item.product_id || ''),
          unit_price: Number(item.unit_price || 0),
          min_margin_floor: item.min_margin_floor == null || item.min_margin_floor === '' ? null : Number(item.min_margin_floor),
          max_margin_ceiling: item.max_margin_ceiling == null || item.max_margin_ceiling === '' ? null : Number(item.max_margin_ceiling),
          status: String(item.status || 'ACTIVE'),
        })) : [],
      })
      if (fallback) {
        return NextResponse.json({ success: true, data: sanitizePriceListRow(fallback as unknown as PriceListRow) })
      }
      return NextResponse.json({ success: false, message: 'Price list not found or access denied' }, { status: 403 })
    }

    const updateData = {
      ...priceListData,
      ...(legacyMode ? { notes: encodeLegacyScopedNotes(priceListData.notes, companyId) } : {}),
      updated_at: new Date().toISOString(),
    }

    // Update price list
    let updateQuery = supabaseAdmin
      .from('price_lists')
      .update(updateData)
      .eq('id', id)
      .select()
    if (!legacyMode) updateQuery = updateQuery.eq('company_id', companyId)
    const { data, error } = await updateQuery.single()

    if (error) {
      if (isPricingSchemaGap(error as { code?: string; message?: string })) {
        return NextResponse.json({ success: false, message: PRICING_SCHEMA_NOT_READY_MESSAGE }, { status: 503 })
      }
      throw error
    }

    // If items provided, upsert them
    if (items?.length) {
      // Delete existing items first
      await supabaseAdmin.from('price_list_items').delete().eq('price_list_id', id)

      const itemsWithListId = items.map((item: Record<string, unknown>) => ({
        ...item,
        price_list_id: id,
      }))
      const { error: itemsError } = await supabaseAdmin.from('price_list_items').insert(itemsWithListId)
      if (itemsError) {
        if (isPricingSchemaGap(itemsError as { code?: string; message?: string })) {
          return NextResponse.json({ success: false, message: PRICING_SCHEMA_NOT_READY_MESSAGE }, { status: 503 })
        }
        throw itemsError
      }
    }

    return NextResponse.json({ success: true, data: sanitizePriceListRow(data as PriceListRow | null) })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed'
    const status = msg === PRICING_SCHEMA_NOT_READY_MESSAGE ? 503 : 500
    return NextResponse.json({ success: false, message: msg }, { status })
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params

    const authUser = await getUserFromToken(req)
    if (!authUser) {
      return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 })
    }
    const companyId = await resolveCompanyScope(req, authUser)
    if (!companyId) {
      return NextResponse.json({ success: false, message: 'Select a company before deleting price list' }, { status: 403 })
    }

    await ensurePricingSchema()

    // Verify company access before delete
    let legacyMode = false
    let { data: existingPriceList, error: existingError } = await supabaseAdmin
      .from('price_lists')
      .select('company_id, notes')
      .eq('id', id)
      .eq('company_id', companyId)
      .maybeSingle()

    if (existingError && isPricingSchemaGap(existingError as { code?: string; message?: string })) {
      if (!isMissingCompanyIdColumn(existingError as { code?: string; message?: string })) {
        return NextResponse.json({ success: false, message: PRICING_SCHEMA_NOT_READY_MESSAGE }, { status: 503 })
      }
      const legacyExisting = await supabaseAdmin
        .from('price_lists')
        .select('notes')
        .eq('id', id)
        .maybeSingle()
      if (legacyExisting.error) throw legacyExisting.error
      if (decodeLegacyScopeFromNotes((legacyExisting.data as PriceListRow | null)?.notes) === companyId) {
        existingPriceList = { company_id: companyId, notes: (legacyExisting.data as PriceListRow | null)?.notes || null }
        existingError = null
        legacyMode = true
      }
    }

    if (!existingPriceList) {
      const deleted = await deleteFallbackPriceList(companyId, id)
      if (deleted) {
        return NextResponse.json({ success: true })
      }
      return NextResponse.json({ success: false, message: 'Price list not found or access denied' }, { status: 403 })
    }

    // Soft delete
    let deleteQuery = supabaseAdmin
      .from('price_lists')
      .update({ status: 'DELETED', updated_at: new Date().toISOString() })
      .eq('id', id)
    if (!legacyMode) deleteQuery = deleteQuery.eq('company_id', companyId)
    const { error } = await deleteQuery

    if (error) {
      if (isPricingSchemaGap(error as { code?: string; message?: string })) {
        return NextResponse.json({ success: false, message: PRICING_SCHEMA_NOT_READY_MESSAGE }, { status: 503 })
      }
      throw error
    }
    return NextResponse.json({ success: true })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed'
    const status = msg === PRICING_SCHEMA_NOT_READY_MESSAGE ? 503 : 500
    return NextResponse.json({ success: false, message: msg }, { status })
  }
}
