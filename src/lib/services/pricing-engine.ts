import { supabaseAdmin } from '@/lib/supabase-server'

export interface PriceComputeResult {
  priceListId: string | null
  priceListName: string | null
  basePrice: number
  applicablePrice: number
  marginPercent: number
  isOverrideRequired: boolean
}

async function resolveApplicablePriceListId(partyId: string): Promise<{ priceListId: string | null; partyType: string | null }> {
  const { data: party } = await supabaseAdmin
    .from('parties')
    .select('price_list_id, party_type_id, party_types(name)')
    .eq('id', partyId)
    .single()

  const partyType = (party?.party_types as { name?: string } | null)?.name || null

  if (party?.price_list_id) {
    return { priceListId: party.price_list_id, partyType }
  }

  // Check if a price list was created specifically for this party
  const { data: partySpecificList } = await supabaseAdmin
    .from('price_lists')
    .select('id')
    .eq('party_id', partyId)
    .eq('is_current', true)
    .eq('status', 'ACTIVE')
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (partySpecificList?.id) {
    return { priceListId: partySpecificList.id, partyType }
  }

  if (!partyType) {
    return { priceListId: null, partyType: null }
  }

  const { data: fallbackList } = await supabaseAdmin
    .from('price_lists')
    .select('id')
    .eq('applicable_party_type', partyType)
    .is('party_id', null)
    .eq('is_current', true)
    .eq('status', 'ACTIVE')
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  return { priceListId: fallbackList?.id || null, partyType }
}

export async function computePrice(params: {
  partyId: string
  productId: string
  quantity: number
  invoiceDate?: string
}): Promise<PriceComputeResult> {
  const { partyId, productId } = params

  const { data: product } = await supabaseAdmin
    .from('products')
    .select('base_price, mrp')
    .eq('id', productId)
    .single()

  const basePrice = Number(product?.base_price || 0)
  const { priceListId } = await resolveApplicablePriceListId(partyId)

  if (!priceListId) {
    return {
      priceListId: null,
      priceListName: null,
      basePrice,
      applicablePrice: basePrice,
      marginPercent: 0,
      isOverrideRequired: false,
    }
  }

  const { data: plItem } = await supabaseAdmin
    .from('price_list_items')
    .select('unit_price, min_margin_floor, max_margin_ceiling, override_requires_approval, price_lists(name, is_current, valid_from, valid_to)')
    .eq('price_list_id', priceListId)
    .eq('product_id', productId)
    .eq('status', 'ACTIVE')
    .single()

  if (!plItem) {
    return {
      priceListId,
      priceListName: null,
      basePrice,
      applicablePrice: basePrice,
      marginPercent: 0,
      isOverrideRequired: false,
    }
  }

  const applicablePrice = Number(plItem.unit_price)
  const marginPercent = basePrice > 0 ? Math.round(((applicablePrice - basePrice) / basePrice) * 10000) / 100 : 0
  const plData = Array.isArray(plItem.price_lists) ? plItem.price_lists[0] : plItem.price_lists

  return {
    priceListId,
    priceListName: plData?.name || null,
    basePrice,
    applicablePrice,
    marginPercent,
    isOverrideRequired: Boolean(plItem.override_requires_approval),
  }
}
