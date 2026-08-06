import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, getUserFromToken } from '@/lib/supabase-server'

type DbError = { code?: string; message?: string; details?: string; hint?: string }

function isSchemaGap(error: DbError | null | undefined): boolean {
  if (!error) return false
  const msg = String(error.message || '').toLowerCase()
  return (
    error.code === '42P01' ||
    error.code === 'PGRST200' ||
    error.code === 'PGRST204' ||
    error.code === 'PGRST205' ||
    msg.includes('does not exist') ||
    msg.includes('schema cache') ||
    msg.includes('could not find')
  )
}

function getErrorMessage(err: unknown, fallback = 'Failed'): string {
  if (err instanceof Error && err.message) return err.message
  if (typeof err === 'object' && err !== null && 'message' in err) {
    const message = (err as { message?: unknown }).message
    if (typeof message === 'string' && message.trim()) return message
  }
  return fallback
}

function isRouteReferenceMismatch(error: DbError | null | undefined): boolean {
  if (!error || error.code !== '23503') return false
  const msg = `${error.message || ''} ${error.details || ''} ${error.hint || ''}`.toLowerCase()
  return (
    msg.includes('route_id') ||
    msg.includes('route_stops_route') ||
    msg.includes('beat_routes')
  )
}

async function ensureBeatRouteMirror(routeId: string): Promise<boolean> {
  let routeName = 'Route'

  const routeRow = await supabaseAdmin
    .from('routes')
    .select('name')
    .eq('id', routeId)
    .maybeSingle()

  if (!routeRow.error && routeRow.data?.name) {
    routeName = routeRow.data.name
  }

  const { error } = await supabaseAdmin
    .from('beat_routes')
    .upsert({ id: routeId, name: routeName }, { onConflict: 'id' })

  if (!error) return true
  if (isSchemaGap(error)) return false

  console.warn('[STOPS POST] Could not mirror route into beat_routes:', error)
  return false
}

// GET /api/v1/tracking/routes/stops?route_id=xxx
export async function GET(req: NextRequest) {
  const route_id = req.nextUrl.searchParams.get('route_id')
  if (!route_id) return NextResponse.json({ success: false, message: 'route_id required' }, { status: 400 })

  await getUserFromToken(req)

  // Attempt 1: current schema (retailer_id + stop_order)
  // Attempt 2: older schema (party_id + sequence)
  // Attempt 3: wildcard — fetch all columns and normalise (handles any unknown schema variant)
  let rows: Record<string, unknown>[] = []

  const normalizeStopRow = (s: Record<string, unknown>) => {
    const partyId = (s.retailer_id ?? s.party_id ?? s.store_id ?? s.outlet_id ?? null) as string | null
    const order = (s.stop_order ?? s.sequence ?? s.order_num ?? s.position ?? 0) as number
    return { ...s, retailer_id: partyId, party_id: partyId, stop_order: order }
  }

  const wide = await supabaseAdmin
    .from('route_stops')
    .select('id, stop_order, notes, retailer_id, party_id, status')
    .eq('route_id', route_id)
    .order('stop_order')

  if (!wide.error) {
    rows = ((wide.data || []) as Record<string, unknown>[]).map(normalizeStopRow)
  } else if (isSchemaGap(wide.error)) {
    const r1 = await supabaseAdmin
      .from('route_stops')
      .select('id, stop_order, notes, retailer_id, status')
      .eq('route_id', route_id)
      .order('stop_order')

    if (!r1.error) {
      rows = ((r1.data || []) as Record<string, unknown>[]).map(normalizeStopRow)
    } else if (!isSchemaGap(r1.error)) {
      return NextResponse.json({ success: false, message: r1.error.message }, { status: 500 })
    } else {
      const partyStopOrder = await supabaseAdmin
        .from('route_stops')
        .select('id, stop_order, notes, party_id')
        .eq('route_id', route_id)
        .order('stop_order')

      if (!partyStopOrder.error) {
        rows = ((partyStopOrder.data || []) as Record<string, unknown>[]).map(normalizeStopRow)
      } else if (!isSchemaGap(partyStopOrder.error)) {
        return NextResponse.json({ success: false, message: partyStopOrder.error.message }, { status: 500 })
      } else {
        const r2 = await supabaseAdmin
          .from('route_stops')
          .select('id, sequence, notes, party_id')
          .eq('route_id', route_id)
          .order('sequence')

        if (!r2.error) {
          rows = ((r2.data || []) as Record<string, unknown>[]).map(normalizeStopRow)
        } else if (isSchemaGap(r2.error)) {
          // Attempt 3: wildcard select — works regardless of column names
          const r3 = await supabaseAdmin
            .from('route_stops')
            .select('*')
            .eq('route_id', route_id)

          if (r3.error) {
            // Table genuinely missing
            return NextResponse.json({ success: true, data: [] })
          }

          rows = ((r3.data || []) as Record<string, unknown>[]).map(normalizeStopRow)
        } else {
          return NextResponse.json({ success: false, message: r2.error.message }, { status: 500 })
        }
      }
    }
  } else {
    return NextResponse.json({ success: false, message: wide.error.message }, { status: 500 })
  }

  const retailerIds = [...new Set(rows.map((s) => s.retailer_id as string).filter(Boolean))]
  const partyMap: Record<string, unknown> = {}
  if (retailerIds.length > 0) {
    const partySelects = [
      'id, name, party_code, latitude, longitude, address_line1, city, party_types(name)',
      'id, name, party_code, latitude, longitude, city, party_types(name)',
      'id, name, party_code, latitude, longitude, party_types(name)',
      'id, name, party_code, latitude, longitude, address_line1, city',
      'id, name, party_code, latitude, longitude',
      'id, name, party_code, party_types(name)',
      'id, name, party_code',
    ]

    for (const selectCols of partySelects) {
      const { data: partiesData, error: partiesError } = await supabaseAdmin
        .from('parties')
        .select(selectCols)
        .in('id', retailerIds)

      if (!partiesError) {
        for (const p of partiesData || []) partyMap[(p as { id: string }).id] = p
        break
      }

      if (!isSchemaGap(partiesError)) {
        console.warn('[STOPS GET] Could not fetch stop parties:', partiesError)
        break
      }
    }
  }

  const mappedData = rows.map((s) => ({
    ...s,
    party_id: s.retailer_id,
    parties: partyMap[s.retailer_id as string] || null,
  }))

  return NextResponse.json({ success: true, data: mappedData })
}

// POST /api/v1/tracking/routes/stops
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { route_id, party_id, stop_order, notes } = body

    if (!route_id) return NextResponse.json({ success: false, message: 'route_id is required' }, { status: 400 })
    if (!party_id) return NextResponse.json({ success: false, message: 'party_id is required' }, { status: 400 })

    await getUserFromToken(req)

    // Resolve next stop order
    let nextOrder = stop_order ?? 1
    if (!stop_order) {
      // Try both column names for ordering
      const existingR1 = await supabaseAdmin
        .from('route_stops')
        .select('stop_order')
        .eq('route_id', route_id)
        .order('stop_order', { ascending: false })
        .limit(1)
      if (!existingR1.error && existingR1.data?.[0]) {
        nextOrder = (existingR1.data[0].stop_order ?? 0) + 1
      } else {
        const existingR2 = await supabaseAdmin
          .from('route_stops')
          .select('sequence')
          .eq('route_id', route_id)
          .order('sequence', { ascending: false })
          .limit(1)
        if (!existingR2.error && existingR2.data?.[0]) {
          nextOrder = ((existingR2.data[0] as { sequence?: number }).sequence ?? 0) + 1
        }
      }
    }

    // Step 1: full insert with retailer_id, stop_order, status, expected_visit_duration_min
    let r1 = await supabaseAdmin
      .from('route_stops')
      .insert({
        route_id,
        retailer_id: party_id,
        stop_order: nextOrder,
        notes: notes || null,
        expected_visit_duration_min: body.expected_visit_duration_min || 15,
        status: 'ACTIVE',
      })
      .select('id, stop_order, notes, retailer_id')
      .single()

    if (r1.error && isRouteReferenceMismatch(r1.error) && await ensureBeatRouteMirror(route_id)) {
      r1 = await supabaseAdmin
        .from('route_stops')
        .insert({
          route_id,
          retailer_id: party_id,
          stop_order: nextOrder,
          notes: notes || null,
          expected_visit_duration_min: body.expected_visit_duration_min || 15,
          status: 'ACTIVE',
        })
        .select('id, stop_order, notes, retailer_id')
        .single()
    }

    if (!r1.error) {
      return NextResponse.json({
        success: true,
        data: { ...r1.data, party_id: r1.data.retailer_id, parties: null },
      })
    }
    if (!isSchemaGap(r1.error)) throw r1.error

    // Step 2: try retailer_id + stop_order without optional columns
    let r2 = await supabaseAdmin
      .from('route_stops')
      .insert({ route_id, retailer_id: party_id, stop_order: nextOrder, notes: notes || null })
      .select('id, stop_order, notes, retailer_id')
      .single()

    if (r2.error && isRouteReferenceMismatch(r2.error) && await ensureBeatRouteMirror(route_id)) {
      r2 = await supabaseAdmin
        .from('route_stops')
        .insert({ route_id, retailer_id: party_id, stop_order: nextOrder, notes: notes || null })
        .select('id, stop_order, notes, retailer_id')
        .single()
    }

    if (!r2.error) {
      return NextResponse.json({
        success: true,
        data: { ...r2.data, party_id: r2.data.retailer_id, parties: null },
      })
    }
    if (!isSchemaGap(r2.error)) throw r2.error

    // Step 3: fall back to party_id + sequence (original migration column names)
    await ensureBeatRouteMirror(route_id)

    let r3 = await supabaseAdmin
      .from('route_stops')
      .insert({ route_id, party_id, sequence: nextOrder, notes: notes || null })
      .select('id, sequence, notes, party_id')
      .single()

    if (r3.error && isRouteReferenceMismatch(r3.error) && await ensureBeatRouteMirror(route_id)) {
      r3 = await supabaseAdmin
        .from('route_stops')
        .insert({ route_id, party_id, sequence: nextOrder, notes: notes || null })
        .select('id, sequence, notes, party_id')
        .single()
    }

    if (!r3.error) {
      const row = r3.data as { id: string; sequence: number; notes: string | null; party_id: string }
      return NextResponse.json({
        success: true,
        data: { ...row, stop_order: row.sequence, retailer_id: row.party_id, parties: null },
      })
    }
    if (!isSchemaGap(r3.error)) throw r3.error

    // Step 4: absolute minimum — route_id + party_id only
    let r4 = await supabaseAdmin
      .from('route_stops')
      .insert({ route_id, party_id })
      .select('id, party_id')
      .single()

    if (r4.error && isRouteReferenceMismatch(r4.error) && await ensureBeatRouteMirror(route_id)) {
      r4 = await supabaseAdmin
        .from('route_stops')
        .insert({ route_id, party_id })
        .select('id, party_id')
        .single()
    }

    if (r4.error) throw r4.error
    const row4 = r4.data as { id: string; party_id: string }
    return NextResponse.json({
      success: true,
      data: { ...row4, stop_order: nextOrder, retailer_id: row4.party_id, parties: null },
    })
  } catch (err) {
    console.error('[STOPS POST] Error:', err)
    return NextResponse.json(
      { success: false, message: getErrorMessage(err) },
      { status: 500 },
    )
  }
}

// DELETE /api/v1/tracking/routes/stops?id=xxx
export async function DELETE(req: NextRequest) {
  const id = req.nextUrl.searchParams.get('id')
  if (!id) return NextResponse.json({ success: false, message: 'id required' }, { status: 400 })

  await getUserFromToken(req)

  const { error } = await supabaseAdmin.from('route_stops').delete().eq('id', id)
  if (error) return NextResponse.json({ success: false, message: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}
