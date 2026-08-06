import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, getPartyDescendants, getUserFromToken } from '@/lib/supabase-server'
import { applyPartyEffectivePrices } from '@/lib/product-pricing'

/**
 * GET /api/v1/products/orderable
 *
 * Catalog a PARTY user can order from. Party accounts are company-scoped to
 * themselves, but their orderable products are owned by an upline company
 * (`products.company_id` = an ancestor party). This walks the party's
 * parent chain, returns the active products owned by any ancestor, and prices
 * them with the party's effective price (negotiated → category → base).
 */

// Pricing is party-specific and changes the moment an admin edits a price list,
// so this catalog must never be served from any cache layer (WebView/CDN/proxy).
export const dynamic = 'force-dynamic'
export const revalidate = 0

const NO_STORE_HEADERS = { 'Cache-Control': 'no-store, no-cache, must-revalidate' } as const

const MAX_ANCESTOR_DEPTH = 10

// Category names are stored with a legacy `__CID__<companyId>` suffix on some
// deployments. Strip it so the picker shows a clean human-readable name.
const LEGACY_CATEGORY_TAG = '__CID__'
function stripLegacyCategoryTag(rawName: string): string {
  const name = String(rawName || '')
  const idx = name.lastIndexOf(LEGACY_CATEGORY_TAG)
  if (idx < 0) return name
  return name.slice(0, idx).trim() || name
}

async function resolveCategoryNames(catIds: string[]): Promise<Record<string, string>> {
  const map: Record<string, string> = {}
  if (catIds.length === 0) return map
  const { data } = await supabaseAdmin
    .from('product_categories')
    .select('id, name')
    .in('id', catIds)
  for (const c of (data || []) as { id: string; name: string }[]) {
    map[c.id] = stripLegacyCategoryTag(c.name)
  }
  return map
}

async function resolveAncestorCompanyIds(partyId: string): Promise<string[]> {
  const ancestors: string[] = []
  let current: string | null = partyId

  for (let depth = 0; current && depth < MAX_ANCESTOR_DEPTH; depth += 1) {
    const res = (await supabaseAdmin
      .from('parties')
      .select('parent_party_id')
      .eq('id', current)
      .maybeSingle()) as { data: { parent_party_id?: string | null } | null; error: unknown }

    if (res.error) break
    const parent = res.data?.parent_party_id ? String(res.data.parent_party_id) : null
    if (!parent || ancestors.includes(parent)) break
    ancestors.push(parent)
    current = parent
  }

  return ancestors
}

interface OrderableProduct {
  id: string
  name: string
  sku: string
  unit_of_measure: string
  mrp: number
  effective_price: number
  category_id: string | null
  category_name: string | null
}

export async function GET(req: NextRequest) {
  try {
    const authUser = await getUserFromToken(req)
    if (!authUser) {
      return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 })
    }

    const authPartyId = authUser.party_id

    const url = new URL(req.url)
    const search = (url.searchParams.get('search') || '').trim()
    const requestedPartyId = (url.searchParams.get('partyId') || '').trim()

    // Resolve which party we price for. SUPER_ADMIN can price for any party and
    // typically has no party_id of their own, so the requested party is resolved
    // BEFORE the "no party" guard — otherwise admins ordering on behalf of a party
    // would be blocked and see an empty catalog. Everyone else is limited to their
    // own party or a descendant they own.
    let partyId: string | null = authPartyId
    if (requestedPartyId && requestedPartyId !== authPartyId) {
      if (authUser.role === 'SUPER_ADMIN') {
        partyId = requestedPartyId
      } else {
        if (!authPartyId) {
          return NextResponse.json(
            { success: false, message: 'You are not allowed to access this party pricing.' },
            { status: 403 }
          )
        }
        const allowedPartyIds = await getPartyDescendants(authPartyId)
        const canAccessRequestedParty = allowedPartyIds.some((party) => party.id === requestedPartyId)
        if (!canAccessRequestedParty) {
          return NextResponse.json(
            { success: false, message: 'You are not allowed to access this party pricing.' },
            { status: 403 }
          )
        }
        partyId = requestedPartyId
      }
    }

    if (!partyId) {
      return NextResponse.json(
        { success: false, message: 'Your account is not linked to a party yet.' },
        { status: 400 }
      )
    }

    // Products live on an upline company; include self as a fallback.
    const ancestors = await resolveAncestorCompanyIds(partyId)
    const companyIds = [...new Set([...ancestors, partyId])]
    if (companyIds.length === 0) {
      return NextResponse.json({ success: true, data: [] }, { headers: NO_STORE_HEADERS })
    }

    // select('*') keeps this resilient to schema differences (is_active,
    // unit_of_measure, mrp may or may not exist).
    let query = supabaseAdmin
      .from('products')
      .select('*')
      .in('company_id', companyIds)
      .order('name')
      .limit(500)

    if (search) query = query.ilike('name', `%${search}%`)

    const { data: rows, error } = await query
    if (error) throw error

    const active = ((rows || []) as Record<string, unknown>[]).filter(
      (p) => p.is_active !== false && p.status !== 'INACTIVE'
    )

    const priced = await applyPartyEffectivePrices(
      active.map((p) => ({ id: String(p.id), base_price: p.base_price, raw: p })),
      partyId
    )

    const catIds = [
      ...new Set(active.map((p) => (p.category_id ? String(p.category_id) : '')).filter(Boolean)),
    ]
    const catNames = await resolveCategoryNames(catIds)

    const data: OrderableProduct[] = priced.map((p) => {
      const raw = p.raw as Record<string, unknown>
      const categoryId = raw.category_id ? String(raw.category_id) : null
      return {
        id: p.id,
        name: String(raw.name || 'Unnamed product'),
        sku: String(raw.sku || ''),
        unit_of_measure: String(raw.unit_of_measure || 'pcs'),
        mrp: Number(raw.mrp || 0),
        effective_price: Number(p.effective_price || 0),
        category_id: categoryId,
        category_name: categoryId ? catNames[categoryId] || null : null,
      }
    })

    return NextResponse.json({ success: true, data }, { headers: NO_STORE_HEADERS })
  } catch (err) {
    console.error('[products/orderable][GET] failed:', err)
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed to load products' },
      { status: 500 }
    )
  }
}
