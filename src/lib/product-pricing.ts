import { supabaseAdmin } from '@/lib/supabase-server'
import { getPartyGroup } from '@/lib/groups'
import { findApplicableFallbackPriceLists, type PriceListFallbackRecord } from '@/lib/price-lists-fallback'

/**
 * Party-aware price resolution, shared by the products listing and the party
 * self-order catalog.
 *
 * Resolution order (first match wins), mirroring the pricing module intent:
 *   1. A price list created specifically for the party (`price_lists.party_id`).
 *   2. A price list linked to the party's group (`price_lists.group_id`).
 *   3. A price list for the party's category/type (`applicable_party_type`).
 *   4. A legacy/default price list explicitly attached to the party (`parties.price_list_id`).
 *   5. Fall back to the product's `base_price`.
 *
 * Every lookup tolerates the relevant table/column being absent (older
 * deployments have no `price_lists` table), degrading to base price.
 */
type PartyPricing = { price_list_id?: string | null; parent_party_id?: string | null; party_types?: { name?: string } | null }

interface ResolvedPartyPriceList {
  priceListId: string | null
  /**
   * When the winning list is note-stored (company_notes), its full record — with
   * line items — is returned here so callers never have to re-resolve or query the
   * canonical `price_list_items` table (which doesn't contain note-stored items).
   */
  fallbackRecord: PriceListFallbackRecord | null
}

/**
 * One price list that applies to a party. `fallbackRecord` is set when the list is
 * note-stored (its items are embedded); otherwise items live in `price_list_items`.
 */
interface PriceLayer {
  priceListId: string
  fallbackRecord: PriceListFallbackRecord | null
}

/** Walks a party's parent chain, returning ancestor company ids (nearest first). */
async function walkAncestorCompanyIds(firstParentId: string | null): Promise<string[]> {
  const companyIds: string[] = []
  let currentParent = firstParentId
  let guard = 0
  while (currentParent && guard < 10) {
    if (companyIds.includes(currentParent)) break
    companyIds.push(currentParent)
    guard += 1
    try {
      const { data: parentRow } = await supabaseAdmin
        .from('parties')
        .select('parent_party_id')
        .eq('id', currentParent)
        .maybeSingle()
      currentParent = parentRow?.parent_party_id ? String(parentRow.parent_party_id) : null
    } catch {
      break
    }
  }
  return companyIds
}

/**
 * Resolves EVERY price list that applies to a party, ordered highest precedence first.
 *
 * Precedence (mirrors the pricing module intent):
 *   1. A note-stored list scoped to this exact party (individual override).
 *   2. A note-stored list scoped to this party's category within its group.
 *   3. A note-stored list scoped to the whole group (GROUP sentinel).
 *   4. A canonical `price_lists` row scoped to this party.
 *   5. A canonical `price_lists` row linked to the party's group.
 *   6. A canonical `price_lists` row for the party's category/type.
 *   7. The legacy/default link kept on `parties.price_list_id`.
 *
 * Unlike a single-winner lookup, this returns ALL matching layers so a product priced
 * only in a lower-precedence list is still found instead of silently dropping to base
 * price — the higher layer just wins for products both lists carry. Party row, parent
 * chain and group are each fetched ONCE and threaded through.
 */
async function resolvePartyPriceLayers(partyId: string): Promise<PriceLayer[]> {
  let party: PartyPricing | null = null
  try {
    const res = await supabaseAdmin
      .from('parties')
      .select('price_list_id, parent_party_id, party_types(name)')
      .eq('id', partyId)
      .single()
    party = (res.data as PartyPricing | null) ?? null
  } catch {
    party = null
  }

  const legacyPartyPriceListId = party?.price_list_id || null
  const partyType = (party?.party_types as { name?: string } | null)?.name

  // The ancestor-company walk and the group lookup are independent of each other —
  // run them concurrently so we pay one round-trip of latency, not two.
  const [companyIds, groupId] = await Promise.all([
    walkAncestorCompanyIds(party?.parent_party_id ? String(party.parent_party_id) : null),
    getPartyGroup(partyId)
      .then((group) => group?.group_id ?? null)
      .catch(() => null),
  ])

  const layers: PriceLayer[] = []
  const pushLayer = (priceListId: string | null | undefined, fallbackRecord: PriceListFallbackRecord | null) => {
    if (!priceListId) return
    if (layers.some((l) => l.priceListId === priceListId)) return
    layers.push({ priceListId, fallbackRecord })
  }

  // 1-3. Note-stored fallbacks (individual → category → whole-group), already ordered.
  // On deployments without `price_lists.group_id`, group/category lists live ONLY here.
  try {
    const noteLists = await findApplicableFallbackPriceLists({ partyId, partyType, companyIds, groupId })
    for (const note of noteLists) pushLayer(note.id, note)
  } catch {
  }

  // 4. Canonical price list scoped to this exact party.
  try {
    const { data } = await supabaseAdmin
      .from('price_lists')
      .select('id')
      .eq('party_id', partyId)
      .eq('is_current', true)
      .eq('status', 'ACTIVE')
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    pushLayer(data?.id, null)
  } catch {
    /* price_lists table may not exist */
  }

  // 5. Canonical price lists linked to the party's group (party → category → whole group → rest).
  if (groupId) {
    try {
      const { data: groupLists } = await supabaseAdmin
        .from('price_lists')
        .select('id, applicable_party_type, party_id, updated_at')
        .eq('group_id', groupId)
        .eq('status', 'ACTIVE')
        .order('updated_at', { ascending: false })

      const lists = (groupLists || []) as {
        id: string
        applicable_party_type?: string | null
        party_id?: string | null
      }[]
      pushLayer(lists.find((l) => l.party_id === partyId)?.id, null)
      if (partyType) pushLayer(lists.find((l) => !l.party_id && l.applicable_party_type === partyType)?.id, null)
      pushLayer(
        lists.find((l) => !l.party_id && (l.applicable_party_type === 'GROUP' || !l.applicable_party_type))?.id,
        null,
      )
      for (const l of lists) pushLayer(l.id, null)
    } catch {
      /* groups table or price_lists.group_id column may not exist */
    }
  }

  // 6. Canonical price list for this party's category/type.
  if (partyType) {
    try {
      const { data } = await supabaseAdmin
        .from('price_lists')
        .select('id')
        .eq('applicable_party_type', partyType)
        .is('party_id', null)
        .eq('is_current', true)
        .eq('status', 'ACTIVE')
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      pushLayer(data?.id, null)
    } catch {
    }
  }

  // 7. Lowest-priority legacy/default link kept on the party row.
  pushLayer(legacyPartyPriceListId, null)

  return layers
}

/** Convenience wrapper: the single highest-precedence list (for callers that need just one). */
async function resolvePartyPriceList(partyId: string): Promise<ResolvedPartyPriceList> {
  const [top] = await resolvePartyPriceLayers(partyId)
  return { priceListId: top?.priceListId ?? null, fallbackRecord: top?.fallbackRecord ?? null }
}

export async function resolveApplicablePriceListId(partyId: string): Promise<string | null> {
  return (await resolvePartyPriceList(partyId)).priceListId
}

export interface PartyProductPricing {
  priceListId: string | null
  /** product_id → unit_price, only for products that have a negotiated price. */
  prices: Map<string, number>
}

/**
 * The single source of truth for "what does this party pay for these products".
 *
 * Resolves EVERY applicable price list and merges their `product_id → unit_price`
 * entries, applying lowest precedence first so the highest-precedence list wins for
 * products it carries — while products it omits still pick up a price from a lower
 * list. This is what keeps a just-set price from being masked by base price when a
 * higher-precedence list happens not to include that product. Reads from whichever
 * storage each list lives in — canonical `price_list_items` OR the note-stored
 * fallback. Products without any negotiated price are simply absent from the map.
 *
 * `priceListId` reports the highest-precedence applicable list (for metadata only).
 */
export async function resolvePartyProductPrices(
  partyId: string,
  productIds: string[],
): Promise<PartyProductPricing> {
  const prices = new Map<string, number>()
  const ids = [...new Set(productIds.filter(Boolean))]

  const layers = await resolvePartyPriceLayers(partyId)
  const priceListId = layers[0]?.priceListId ?? null
  if (ids.length === 0 || layers.length === 0) return { priceListId, prices }

  const wanted = new Set(ids)

  // Apply lowest precedence first; higher layers overwrite, so the top list wins.
  for (const layer of [...layers].reverse()) {
    if (layer.fallbackRecord) {
      // Note-stored list: items are embedded in the record, never in price_list_items.
      for (const item of layer.fallbackRecord.items) {
        if (item.status !== 'ACTIVE') continue
        if (wanted.has(item.product_id)) prices.set(item.product_id, Number(item.unit_price))
      }
      continue
    }

    // Canonical list: read from price_list_items.
    try {
      const { data: items } = await supabaseAdmin
        .from('price_list_items')
        .select('product_id, unit_price')
        .eq('price_list_id', layer.priceListId)
        .eq('status', 'ACTIVE')
        .in('product_id', ids)
      for (const item of items || []) prices.set(item.product_id, Number(item.unit_price))
    } catch {
      /* price_list_items table may not exist */
    }
  }

  return { priceListId, prices }
}

/**
 * Returns the products annotated with the party's `effective_price` — the
 * negotiated/category/group price if one exists, otherwise the product's base price.
 */
export async function applyPartyEffectivePrices<T extends { id: string; base_price?: unknown }>(
  products: T[],
  partyId: string,
): Promise<(T & { effective_price: number })[]> {
  const withBase = products.map((p) => ({
    ...p,
    effective_price: Number((p as { base_price?: unknown }).base_price || 0),
  }))
  if (withBase.length === 0) return withBase

  const { prices } = await resolvePartyProductPrices(partyId, withBase.map((p) => p.id))
  if (prices.size === 0) return withBase

  return withBase.map((p) => ({ ...p, effective_price: prices.get(p.id) ?? p.effective_price }))
}
