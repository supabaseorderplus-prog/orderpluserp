/**
 * Unit tests for applyPartyEffectivePrices (src/lib/product-pricing.ts).
 *
 * Verifies the price a party sees when ordering resolves in the right order:
 *   party-specific price list → party category/type price list → base price.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

interface PricingConfig {
  party: { data: unknown; error: unknown }
  partyList: { data: unknown; error: unknown } // price_lists filtered by party_id
  typeList: { data: unknown; error: unknown } // price_lists filtered by applicable_party_type
  items: { data: unknown; error: unknown } // price_list_items (default, any list)
  itemsByList?: Record<string, { data: unknown; error: unknown }> // per price_list_id override
}

const h = vi.hoisted(() => {
  const state: { config: PricingConfig | null } = { config: null }

  function dispatch(table: string, chain: [string, unknown[]][]): { data?: unknown; error?: unknown } {
    const cfg = state.config!
    if (table === 'parties') return cfg.party
    if (table === 'price_lists') {
      const usesType = chain.some((c) => c[0] === 'eq' && c[1][0] === 'applicable_party_type')
      return usesType ? cfg.typeList : cfg.partyList
    }
    if (table === 'price_list_items') {
      const idEntry = chain.find((c) => c[0] === 'eq' && c[1][0] === 'price_list_id')
      const listId = idEntry ? String(idEntry[1][1]) : ''
      if (cfg.itemsByList && listId in cfg.itemsByList) return cfg.itemsByList[listId]
      return cfg.items
    }
    return { data: null, error: null }
  }

  function makeBuilder(table: string) {
    const chain: [string, unknown[]][] = []
    const proxy: unknown = new Proxy(
      {},
      {
        get(_t, prop) {
          if (typeof prop === 'symbol') return undefined
          if (prop === 'then') {
            return (resolve: (v: unknown) => void) => resolve(dispatch(table, chain))
          }
          if (prop === 'single' || prop === 'maybeSingle') {
            return (...args: unknown[]) => {
              chain.push([prop, args])
              return Promise.resolve(dispatch(table, chain))
            }
          }
          return (...args: unknown[]) => {
            chain.push([prop as string, args])
            return proxy
          }
        },
      }
    )
    return proxy
  }

  const supabaseAdmin = { from: (t: string) => makeBuilder(t) }
  return { state, supabaseAdmin }
})

vi.mock('@/lib/supabase-server', () => ({ supabaseAdmin: h.supabaseAdmin }))

import { applyPartyEffectivePrices } from '@/lib/product-pricing'

const PRODUCTS = [
  { id: 'p1', base_price: 100 },
  { id: 'p2', base_price: 200 },
]
const PARTY = 'party-1'

describe('applyPartyEffectivePrices', () => {
  beforeEach(() => {
    h.state.config = {
      party: { data: { price_list_id: null, party_types: null }, error: null },
      partyList: { data: null, error: null },
      typeList: { data: null, error: null },
      items: { data: [], error: null },
    }
  })

  it('falls back to base price when the party has no price list', async () => {
    const result = await applyPartyEffectivePrices(PRODUCTS, PARTY)
    expect(result.map((p) => p.effective_price)).toEqual([100, 200])
  })

  it('uses a party-specific negotiated price when one exists', async () => {
    const cfg = h.state.config!
    cfg.party = { data: { price_list_id: 'PL-PARTY', party_types: null }, error: null }
    cfg.items = { data: [{ product_id: 'p1', unit_price: 80 }], error: null }

    const result = await applyPartyEffectivePrices(PRODUCTS, PARTY)
    // p1 negotiated to 80, p2 has no item → base 200
    expect(result.find((p) => p.id === 'p1')!.effective_price).toBe(80)
    expect(result.find((p) => p.id === 'p2')!.effective_price).toBe(200)
  })

  it('uses a category/type price list when there is no party-specific one', async () => {
    const cfg = h.state.config!
    cfg.party = { data: { price_list_id: null, party_types: { name: 'CNF' } }, error: null }
    cfg.partyList = { data: null, error: null } // no party-specific list
    cfg.typeList = { data: { id: 'PL-CNF' }, error: null }
    cfg.items = { data: [{ product_id: 'p2', unit_price: 150 }], error: null }

    const result = await applyPartyEffectivePrices(PRODUCTS, PARTY)
    expect(result.find((p) => p.id === 'p1')!.effective_price).toBe(100) // base
    expect(result.find((p) => p.id === 'p2')!.effective_price).toBe(150) // category price
  })

  it('honors a price from a lower-precedence list when the top list omits the product', async () => {
    // Party has a category list (PL-CNF, higher precedence) that only prices p2,
    // and a legacy party-default list (PL-PARTY, lower) that prices p1. Both prices
    // must surface — neither product should fall back to base — instead of the old
    // single-winner behavior that would drop p1 to base because PL-CNF wins.
    const cfg = h.state.config!
    cfg.party = { data: { price_list_id: 'PL-PARTY', party_types: { name: 'CNF' } }, error: null }
    cfg.partyList = { data: null, error: null } // no canonical party-scoped list
    cfg.typeList = { data: { id: 'PL-CNF' }, error: null }
    cfg.itemsByList = {
      'PL-PARTY': { data: [{ product_id: 'p1', unit_price: 80 }], error: null },
      'PL-CNF': { data: [{ product_id: 'p2', unit_price: 150 }], error: null },
    }

    const result = await applyPartyEffectivePrices(PRODUCTS, PARTY)
    expect(result.find((p) => p.id === 'p1')!.effective_price).toBe(80) // from lower list
    expect(result.find((p) => p.id === 'p2')!.effective_price).toBe(150) // from top list
  })

  it('returns an empty array unchanged', async () => {
    expect(await applyPartyEffectivePrices([], PARTY)).toEqual([])
  })
})
