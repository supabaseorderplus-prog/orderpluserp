import { supabaseAdmin } from '@/lib/supabase-server'
import { resolvePartyProductPrices } from '@/lib/product-pricing'

export interface InvoiceLineInput {
  productId: string
  quantity: number
  unitPrice?: number
  priceListId?: string
  discountPercent?: number
  gstRateOverride?: number
  cessRateOverride?: number
}

export interface CalculatedLine {
  productId: string
  hsnCode: string
  quantity: number
  unitOfMeasure: string
  unitPrice: number
  priceListId: string | null
  priceOverridden: boolean
  discountPercent: number
  discountAmount: number
  billDiscountAmount: number
  taxableAmount: number
  gstRate: number
  cgstRate: number
  sgstRate: number
  igstRate: number
  cgstAmount: number
  sgstAmount: number
  igstAmount: number
  cessRate: number
  cessAmount: number
  lineTotal: number
}

export interface CalculatedInvoice {
  lines: CalculatedLine[]
  subtotal: number
  discountAmount: number
  lineDiscountAmount: number
  billDiscountAmount: number
  tdPercent: number
  tdAmount: number
  taxableAmount: number
  cgstAmount: number
  sgstAmount: number
  igstAmount: number
  cessAmount: number
  roundOff: number
  grandTotal: number
  isInterstate: boolean
}

function normalizeRate(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function displayUnitOfMeasure(product: { unit_of_measure: string; technical_specs?: unknown }): string {
  const specs = product.technical_specs
  if (!specs || typeof specs !== 'object') return product.unit_of_measure

  const requestedUnit = (specs as Record<string, unknown>).requested_unit_of_measure
  return typeof requestedUnit === 'string' && requestedUnit.trim()
    ? requestedUnit
    : product.unit_of_measure
}

interface PrefetchedParty {
  price_list_id?: string | null
  state_id?: string | null
  party_types?: { name?: string } | null
}

async function resolveTradeDiscount(
  billingPartyId: string,
  companyId?: string | null,
  prefetchedParty?: PrefetchedParty | null,
): Promise<number> {
  const today = new Date().toISOString().split('T')[0]

  // Reuse the already-fetched party when available to avoid a redundant round-trip.
  const partyInfo = prefetchedParty ?? (await supabaseAdmin
    .from('parties')
    .select('party_types(name)')
    .eq('id', billingPartyId)
    .maybeSingle()).data

  const partyType = (partyInfo?.party_types as { name?: string } | null)?.name

  // 1. Check party-specific TD (by party_id), scoped to company
  let partyTdQuery = supabaseAdmin
    .from('td_config')
    .select('td_percent, valid_to')
    .eq('party_id', billingPartyId)
    .eq('status', 'ACTIVE')
    .lte('valid_from', today)
    .order('valid_from', { ascending: false })
    .limit(1)

  if (companyId) partyTdQuery = partyTdQuery.eq('company_id', companyId)

  const { data: partyTd } = await partyTdQuery.maybeSingle()

  if (partyTd && (!partyTd.valid_to || partyTd.valid_to >= today)) {
    return Number(partyTd.td_percent) || 0
  }

  // 2. Fallback: check by party type (where party_id is NULL = applies to all of that type)
  // CRITICAL: must filter by company_id to prevent cross-company TD leakage
  if (!partyType) return 0

  let typeTdQuery = supabaseAdmin
    .from('td_config')
    .select('td_percent, valid_to')
    .eq('applicable_party_type', partyType)
    .is('party_id', null)
    .eq('status', 'ACTIVE')
    .lte('valid_from', today)
    .order('valid_from', { ascending: false })
    .limit(1)

  if (companyId) typeTdQuery = typeTdQuery.eq('company_id', companyId)

  const { data: typeTd } = await typeTdQuery.maybeSingle()

  if (typeTd && (!typeTd.valid_to || typeTd.valid_to >= today)) {
    return Number(typeTd.td_percent) || 0
  }

  return 0
}

export async function calculateInvoice(
  billingPartyId: string,
  supplierStateId: string,
  lines: InvoiceLineInput[],
  priceListId?: string,
  isInterstateOverride?: boolean,
  billDiscountPercent?: number,
  skipTd?: boolean,
  companyId?: string | null
): Promise<CalculatedInvoice> {
  const productIds = lines.map(l => l.productId)

  // Fetch the party (once, with everything the resolvers need) and the products in
  // parallel — these have no dependency on each other.
  const [partyRes, productsRes] = await Promise.all([
    supabaseAdmin
      .from('parties')
      .select('id, state_id, price_list_id, party_types(name)')
      .eq('id', billingPartyId)
      .maybeSingle(),
    supabaseAdmin
      .from('products')
      .select('id, sku, name, unit_of_measure, base_price, hsn_code_id, technical_specs')
      .in('id', productIds),
  ])

  const party = partyRes.data as PrefetchedParty & { state_id?: string | null } | null
  const products = productsRes.data

  const isInterstate = isInterstateOverride !== undefined
    ? isInterstateOverride
    : (party ? party.state_id !== supplierStateId : false)

  const hsnIds = products?.map(p => p.hsn_code_id).filter(Boolean) || []

  // The price list id is usually known without a query — the caller passes it
  // explicitly, or it's on the party row we just fetched. Knowing it up front lets
  // us batch price_list_items into the same parallel hop as hsn codes and trade
  // discount, instead of waiting on a separate round-trip.
  const knownPriceListId = priceListId || null

  const fetchPriceItems = (plId: string) =>
    supabaseAdmin
      .from('price_list_items')
      .select('product_id, unit_price')
      .eq('price_list_id', plId)
      .in('product_id', productIds)
      .then(r => r.data)

  const [hsnRes, tdPercent, earlyPlItems] = await Promise.all([
    supabaseAdmin
      .from('hsn_codes')
      .select('id, hsn_code, gst_rate, cess_rate')
      .in('id', hsnIds),
    skipTd ? Promise.resolve(0) : resolveTradeDiscount(billingPartyId, companyId, party),
    knownPriceListId ? fetchPriceItems(knownPriceListId) : Promise.resolve(null),
  ])

  const hsnCodes = hsnRes.data

  const priceMap: Record<string, number> = {}
  let resolvedPriceListId: string | null = knownPriceListId

  if (knownPriceListId) {
    // Caller passed an explicit price list — honour it verbatim from the canonical table.
    earlyPlItems?.forEach(item => {
      priceMap[item.product_id] = Number(item.unit_price)
    })
  } else {
    // No price list known up front — resolve the party's applicable price (individual →
    // category → group → legacy) in a single pass. resolvePartyProductPrices reads from
    // whichever storage the winning list lives in — the canonical price_list_items table
    // OR the note-stored fallback — so group/category lists kept in company_notes
    // (deployments without price_lists.group_id) price correctly here instead of silently
    // collapsing to base_price.
    const resolved = await resolvePartyProductPrices(billingPartyId, productIds)
    resolvedPriceListId = resolved.priceListId
    for (const [productId, unitPrice] of resolved.prices) {
      priceMap[productId] = unitPrice
    }
  }

  const productMap = new Map(products?.map(p => [p.id, p]) || [])
  const hsnMap = new Map(hsnCodes?.map(h => [h.id, h]) || [])

  const baseCalculatedLines = lines.map(line => {
    const product = productMap.get(line.productId)
    if (!product) throw new Error(`Product ${line.productId} not found`)

    const hsn = hsnMap.get(product.hsn_code_id)
    const gstOverride = normalizeRate(line.gstRateOverride)
    const cessOverride = normalizeRate(line.cessRateOverride)
    const gstRate = gstOverride !== undefined ? gstOverride : (hsn ? Number(hsn.gst_rate) : 0)
    const cessRate = cessOverride !== undefined ? cessOverride : (hsn ? Number(hsn.cess_rate || 0) : 0)

    const unitPrice = line.unitPrice !== undefined ? line.unitPrice : (priceMap[line.productId] ?? Number(product.base_price))
    const priceOverridden = line.unitPrice !== undefined

    const discountPercent = line.discountPercent || 0
    const grossAmount = round2(unitPrice * line.quantity)
    const discountAmount = round2(grossAmount * discountPercent / 100)
    const taxableAmount = round2(grossAmount - discountAmount)

    return {
      productId: line.productId,
      hsnCode: hsn?.hsn_code || '',
      quantity: line.quantity,
      unitOfMeasure: displayUnitOfMeasure(product),
      unitPrice,
      priceListId: resolvedPriceListId || null,
      priceOverridden,
      discountPercent,
      discountAmount,
      billDiscountAmount: 0,
      taxableAmount,
      gstRate,
      cessRate,
    }
  })

    const subtotal = round2(baseCalculatedLines.reduce((sum, line) => sum + line.unitPrice * line.quantity, 0))
    const lineDiscountAmount = round2(baseCalculatedLines.reduce((sum, line) => sum + line.discountAmount, 0))
    const taxableBeforeBillDiscount = round2(baseCalculatedLines.reduce((sum, line) => sum + line.taxableAmount, 0))

    const rawBillDiscountAmount = billDiscountPercent && billDiscountPercent > 0
      ? round2(taxableBeforeBillDiscount * billDiscountPercent / 100)
      : 0

    let allocatedBillDiscount = 0
    const calculatedLines: CalculatedLine[] = baseCalculatedLines.map((line, index) => {
      const isLastLine = index === baseCalculatedLines.length - 1
      const billShare = rawBillDiscountAmount > 0
        ? (isLastLine
            ? round2(rawBillDiscountAmount - allocatedBillDiscount)
            : round2(rawBillDiscountAmount * (taxableBeforeBillDiscount > 0 ? line.taxableAmount / taxableBeforeBillDiscount : 0)))
        : 0
      allocatedBillDiscount = round2(allocatedBillDiscount + billShare)

      const taxableAmount = round2(Math.max(0, line.taxableAmount - billShare))

      let cgstRate = 0, sgstRate = 0, igstRate = 0
      let cgstAmount = 0, sgstAmount = 0, igstAmount = 0

      if (line.gstRate > 0) {
        if (isInterstate) {
          igstRate = line.gstRate
          igstAmount = round2(taxableAmount * igstRate / 100)
        } else {
          cgstRate = line.gstRate / 2
          sgstRate = line.gstRate / 2
          cgstAmount = round2(taxableAmount * cgstRate / 100)
          sgstAmount = round2(taxableAmount * sgstRate / 100)
        }
      }

      const cessAmount = line.cessRate > 0 ? round2(taxableAmount * line.cessRate / 100) : 0
      const lineTotal = round2(taxableAmount + cgstAmount + sgstAmount + igstAmount + cessAmount)

      return {
        productId: line.productId,
        hsnCode: line.hsnCode,
        quantity: line.quantity,
        unitOfMeasure: line.unitOfMeasure,
        unitPrice: line.unitPrice,
        priceListId: line.priceListId,
        priceOverridden: line.priceOverridden,
        discountPercent: line.discountPercent,
        discountAmount: round2(line.discountAmount + billShare),
        billDiscountAmount: billShare,
        taxableAmount,
        gstRate: line.gstRate,
        cgstRate,
        sgstRate,
        igstRate,
        cgstAmount,
        sgstAmount,
        igstAmount,
        cessRate: line.cessRate,
        cessAmount,
        lineTotal,
      }
    })

    // tdPercent was resolved above in parallel with the other lookups.
    const taxableAmount = round2(calculatedLines.reduce((sum, line) => sum + line.taxableAmount, 0))
    const cgstAmount = round2(calculatedLines.reduce((sum, line) => sum + line.cgstAmount, 0))
    const sgstAmount = round2(calculatedLines.reduce((sum, line) => sum + line.sgstAmount, 0))
    const igstAmount = round2(calculatedLines.reduce((sum, line) => sum + line.igstAmount, 0))
    const cessAmount = round2(calculatedLines.reduce((sum, line) => sum + line.cessAmount, 0))

    // Post-tax total after line-level and bill-level product allocation.
    const totalWithTax = round2(taxableAmount + cgstAmount + sgstAmount + igstAmount + cessAmount)

    // TD applied post-tax on the discounted line totals.
    const tdAmount = tdPercent > 0 ? round2(totalWithTax * tdPercent / 100) : 0
    const afterTd = round2(totalWithTax - tdAmount)

    const billDiscountAmount = round2(calculatedLines.reduce((sum, line) => sum + line.billDiscountAmount, 0))
    const discountAmount = round2(lineDiscountAmount + billDiscountAmount + tdAmount)

    const preRound = afterTd
    const grandTotal = Math.round(preRound)
    const roundOff = round2(grandTotal - preRound)

    return {
      lines: calculatedLines,
      subtotal,
      discountAmount,
      lineDiscountAmount,
      billDiscountAmount,
      tdPercent,
      tdAmount,
      taxableAmount,
      cgstAmount,
      sgstAmount,
      igstAmount,
      cessAmount,
      roundOff,
      grandTotal,
      isInterstate,
    }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

export function validateGSTIN(gstin: string): { valid: boolean; stateCode: string; pan: string } {
  const pattern = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/
  if (!pattern.test(gstin)) {
    return { valid: false, stateCode: '', pan: '' }
  }
  return {
    valid: true,
    stateCode: gstin.substring(0, 2),
    pan: gstin.substring(2, 12),
  }
}

export async function generateInvoiceNumber(): Promise<string> {
  const { data: config } = await supabaseAdmin
    .from('gst_config')
    .select('invoice_prefix, invoice_series, current_sequence')
    .order('created_at', { ascending: false })
    .limit(1)
    .single()

  if (!config) throw new Error('GST config not found')

  const seq = (config.current_sequence || 0) + 1
  const padded = String(seq).padStart(6, '0')
  const invoiceNumber = `${config.invoice_prefix}/${config.invoice_series}/${padded}`

  await supabaseAdmin
    .from('gst_config')
    .update({ current_sequence: seq })
    .eq('invoice_prefix', config.invoice_prefix)
    .eq('invoice_series', config.invoice_series)

  return invoiceNumber
}
