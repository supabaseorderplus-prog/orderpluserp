import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, getUserFromToken, resolveCompanyScope } from '@/lib/supabase-server'

const DEFAULT_UNITS = ['KG', 'LITRE', 'BAG', 'SET', 'DRUM', 'PIECE', 'BOX', 'MT']

export async function GET(req: NextRequest) {
  try {
    // CRITICAL: Enforce company isolation - users can only see units of measure used by their company
    const authUser = await getUserFromToken(req)
    const companyId = await resolveCompanyScope(req, authUser)

    let query = supabaseAdmin
      .from('products')
      .select('unit_of_measure')
      .not('unit_of_measure', 'is', null)
      .eq('status', 'ACTIVE')

    // CRITICAL: Filter by company_id to prevent cross-company data leakage
    if (companyId) {
      query = query.eq('company_id', companyId)
    }

    const { data, error } = await query

    if (error) throw error

    const ALLOWED_UNITS = new Set(DEFAULT_UNITS)
    const fromDB = [...new Set((data || []).map((r: { unit_of_measure: string }) => r.unit_of_measure).filter(u => u && ALLOWED_UNITS.has(u)))]

    // Merge DB units with defaults, preserving order (defaults first, then any extras)
    const merged = [...DEFAULT_UNITS]
    for (const u of fromDB) {
      if (!merged.includes(u)) merged.push(u)
    }

    return NextResponse.json({ success: true, data: merged })
  } catch {
    // On error, return safe defaults
    return NextResponse.json({ success: true, data: DEFAULT_UNITS })
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { name } = body
    if (!name || typeof name !== 'string' || !name.trim()) {
      return NextResponse.json({ success: false, message: 'name required' }, { status: 400 })
    }
    // Units are not stored in a table — just return success (managed via product creation)
    return NextResponse.json({ success: true, data: name.trim().toUpperCase() })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed' },
      { status: 500 }
    )
  }
}
