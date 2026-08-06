import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-server'
import { getUserFromToken, resolveCompanyScope } from '@/lib/supabase-server'
import { ensureGroupsSchema } from '@/lib/groups'
import { ensurePricingSchema, isMissingCompanyIdColumn, isPricingSchemaGap, PRICING_SCHEMA_NOT_READY_MESSAGE } from '@/lib/pricing-schema'
import { createFallbackPriceList, listFallbackPriceLists } from '@/lib/price-lists-fallback'

const COMPANY_SCOPE_MARKER = '||CID:'

type DbErrorLike = { code?: string; message?: string; details?: string; hint?: string } | null | undefined

type PriceListRow = Record<string, unknown> & {
  id?: string
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
  const markerValue = notes.slice(markerIndex + COMPANY_SCOPE_MARKER.length).split(/\s/)[0]?.trim()
  return markerValue || null
}

function stripLegacyScopeFromNotes(notes: unknown): string | null {
  if (typeof notes !== 'string') return notes == null ? null : String(notes)
  const markerIndex = notes.lastIndexOf(COMPANY_SCOPE_MARKER)
  if (markerIndex === -1) return notes
  const clean = notes.slice(0, markerIndex).trim()
  return clean || null
}

function sanitizePriceListRow<T extends PriceListRow>(row: T): T {
  return {
    ...row,
    notes: stripLegacyScopeFromNotes(row.notes),
  }
}

function sanitizePriceListRows<T extends PriceListRow>(rows: T[] | null): T[] {
  return (rows || []).map(row => sanitizePriceListRow(row))
}

const isRelationshipError = (err: { code?: string; message?: string } | null | undefined) =>
  !!err && (err.code === 'PGRST200' || err.code === 'PGRST204' || err.code === '42703' ||
    !!(err.message?.includes('relationship') || err.message?.includes('Could not find')))

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url)
    const partyType = url.searchParams.get('party_type') || ''

    const authUser = await getUserFromToken(req)
    if (!authUser) {
      return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 })
    }

    const companyId = await resolveCompanyScope(req, authUser)
    if (!companyId) {
      return NextResponse.json({ success: false, message: 'Select a company to view pricing data' }, { status: 403 })
    }

    await ensurePricingSchema()

    const buildBaseQuery = (select: string) => {
      let q = supabaseAdmin.from('price_lists').select(select).eq('status', 'ACTIVE').order('name')
      if (partyType) q = q.eq('applicable_party_type', partyType)
      q = q.eq('company_id', companyId)
      return q
    }

    // Try with full joins first
    const initial = await buildBaseQuery('*, price_list_items(*, products(name, sku)), party:party_id(name, party_code)')
    let data = (initial.data || null) as unknown as PriceListRow[] | null
    let error = initial.error as DbErrorLike

    // Fallback 1: items join without products join
    if (error && isRelationshipError(error as { code?: string; message?: string })) {
      const retry = await buildBaseQuery('*, price_list_items(*), party:party_id(name, party_code)')
      data = (retry.data || null) as unknown as PriceListRow[] | null
      error = retry.error as DbErrorLike
    }

    // Fallback 2: no joins at all
    if (error && isRelationshipError(error as { code?: string; message?: string })) {
      const retry = await buildBaseQuery('*')
      data = (retry.data || null) as unknown as PriceListRow[] | null
      error = retry.error as DbErrorLike
    }

    if (error && isMissingCompanyIdColumn(error as { code?: string; message?: string })) {
      const legacy = await supabaseAdmin
        .from('price_lists')
        .select('*, price_list_items(*, products(name, sku)), party:party_id(name, party_code)')
        .eq('status', 'ACTIVE')
        .order('name')

      if (!legacy.error) {
        data = ((legacy.data || []) as unknown as PriceListRow[]).filter(row => {
          if (partyType && row.applicable_party_type !== partyType) return false
          return decodeLegacyScopeFromNotes(row.notes) === companyId
        })
        error = null
      } else if (isRelationshipError(legacy.error as { code?: string; message?: string })) {
        const legacyNoJoin = await supabaseAdmin
          .from('price_lists')
          .select('*')
          .eq('status', 'ACTIVE')
          .order('name')
        if (!legacyNoJoin.error) {
          data = ((legacyNoJoin.data || []) as unknown as PriceListRow[]).filter(row => {
            if (partyType && row.applicable_party_type !== partyType) return false
            return decodeLegacyScopeFromNotes(row.notes) === companyId
          })
          error = null
        }
      }
    }

    if (error) {
      if (isMissingCompanyIdColumn(error as { code?: string; message?: string })) {
        return NextResponse.json({ success: true, data: [] })
      }
      if (isPricingSchemaGap(error as { code?: string; message?: string })) {
        return NextResponse.json({ success: true, data: [] })
      }
      throw error
    }

    const legacyTagged = await supabaseAdmin
      .from('price_lists')
      .select('*, price_list_items(*, products(name, sku)), party:party_id(name, party_code)')
      .eq('status', 'ACTIVE')
      .ilike('notes', `%${COMPANY_SCOPE_MARKER}${companyId}%`)
      .order('name')

    if (!legacyTagged.error && legacyTagged.data) {
      const currentRows = data || []
      const legacyRows = legacyTagged.data as unknown as PriceListRow[]
      const seen = new Set(currentRows.map(row => row.id))
      const extra = legacyRows.filter(row => {
        if (seen.has(row.id)) return false
        if (partyType && row.applicable_party_type !== partyType) return false
        return decodeLegacyScopeFromNotes(row.notes) === companyId
      })
      data = [...currentRows, ...extra]
    }

    const fallbackRows = await listFallbackPriceLists(companyId)
    const fallbackProductIds = [...new Set(fallbackRows.flatMap((row) => row.items.map((item) => item.product_id)).filter(Boolean))]
    const fallbackProductMap: Record<string, { name: string | null; sku: string | null }> = {}
    if (fallbackProductIds.length > 0) {
      const { data: productRows } = await supabaseAdmin
        .from('products')
        .select('id, name, sku')
        .in('id', fallbackProductIds)
      for (const product of productRows || []) {
        fallbackProductMap[product.id] = { name: product.name ?? null, sku: product.sku ?? null }
      }
    }

    const merged = [
      ...sanitizePriceListRows(data || []),
      ...fallbackRows
        .filter((row) => {
          if (partyType && row.applicable_party_type !== partyType) return false
          return !(data || []).some((existing) => existing.id === row.id)
        })
        .map((row) => sanitizePriceListRow({
          ...row,
          price_list_items: row.items.map((item) => ({
            ...item,
            products: fallbackProductMap[item.product_id]
              ? { name: fallbackProductMap[item.product_id].name, sku: fallbackProductMap[item.product_id].sku }
              : undefined,
          })),
        } as unknown as PriceListRow)),
    ]
    return NextResponse.json({ success: true, data: merged })
  } catch (err) {
    const msg = (err as { message?: string })?.message || 'Failed to fetch price lists'
    const status = msg === PRICING_SCHEMA_NOT_READY_MESSAGE ? 503 : 500
    return NextResponse.json({ success: false, message: msg }, { status })
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { items, ...priceListData } = body

    // CRITICAL: Get authenticated user and resolve company scope for data isolation
    const authUser = await getUserFromToken(req)
    if (!authUser) {
      return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 })
    }
    const companyId = await resolveCompanyScope(req, authUser)
    if (!companyId) {
      return NextResponse.json({ success: false, message: 'Select a company before creating a price list' }, { status: 403 })
    }

    await ensurePricingSchema()
    // Adds price_lists.group_id so a list can target a group.
    await ensureGroupsSchema()

    // Verify the party belongs to the user's company if party_id is provided
    if (priceListData.party_id && companyId) {
      const tree = await getPartyDescendants(companyId)
      // Cached, non-truncating subtree; always includes at least the company root
      // (the helper never throws), so the membership check runs against a complete set.
      if (tree.length > 0) {
        const treeIds = tree.map((r) => r.id)
        if (!treeIds.includes(companyId)) treeIds.push(companyId)
        if (!treeIds.includes(priceListData.party_id)) {
          return NextResponse.json({ success: false, message: 'Party not found or access denied' }, { status: 403 })
        }
      }
    }

    const insertData: Record<string, unknown> = { ...priceListData }
    insertData.company_id = companyId

    let { data: priceList, error } = await supabaseAdmin
      .from('price_lists')
      .insert(insertData)
      .select()
      .single()

    if (error && isPricingSchemaGap(error as { code?: string; message?: string })) {
      await ensurePricingSchema()
      const retry = await supabaseAdmin
        .from('price_lists')
        .insert(insertData)
        .select()
        .single()
      priceList = retry.data
      error = retry.error
    }

    if (error && isMissingCompanyIdColumn(error as { code?: string; message?: string })) {
      const { company_id, ...legacyInsertData } = {
        ...insertData,
        notes: encodeLegacyScopedNotes(priceListData.notes, companyId),
      } as Record<string, unknown>
      void company_id
      const legacyRetry = await supabaseAdmin
        .from('price_lists')
        .insert(legacyInsertData)
        .select()
        .single()
      priceList = legacyRetry.data
      error = legacyRetry.error
    }

    if (error) {
      if (isPricingSchemaGap(error as { code?: string; message?: string })) {
        const fallback = await createFallbackPriceList({
          company_id: companyId,
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
        return NextResponse.json({ success: true, data: sanitizePriceListRow(fallback as unknown as PriceListRow), storage: 'company_notes_fallback' }, { status: 201 })
      }
      throw error
    }

    if (items?.length) {
      const itemsWithListId = items.map((item: Record<string, unknown>) => ({
        ...item,
        price_list_id: priceList.id,
      }))
      let { error: itemsError } = await supabaseAdmin.from('price_list_items').insert(itemsWithListId)
      if (itemsError && isPricingSchemaGap(itemsError as { code?: string; message?: string })) {
        await ensurePricingSchema()
        const retryItems = await supabaseAdmin.from('price_list_items').insert(itemsWithListId)
        itemsError = retryItems.error
      }
      if (itemsError) {
        if (isPricingSchemaGap(itemsError as { code?: string; message?: string })) {
          const fallback = await createFallbackPriceList({
            company_id: companyId,
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
          return NextResponse.json({ success: true, data: sanitizePriceListRow(fallback as unknown as PriceListRow), storage: 'company_notes_fallback' }, { status: 201 })
        }
        throw itemsError
      }
    }

    return NextResponse.json({ success: true, data: sanitizePriceListRow(priceList) }, { status: 201 })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to create price list'
    const status = msg === PRICING_SCHEMA_NOT_READY_MESSAGE ? 503 : 500
    return NextResponse.json({ success: false, message: msg }, { status })
  }
}
