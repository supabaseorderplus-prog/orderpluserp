import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, getUserFromToken, resolveCompanyScope, resolveUserDisplayMap, getPartyDescendants } from '@/lib/supabase-server'
import { calculateInvoice, generateInvoiceNumber } from '@/lib/services/invoice-calculator'

const fmt = (n: number) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(n)

function deriveInvoiceOrderStatus(invoice: { invoice_type?: string | null; is_cancelled?: boolean | null; payment_status?: string | null; order_status?: string | null }) {
  if (invoice.is_cancelled) return 'CANCELLED'
  if (invoice.order_status) return invoice.order_status
  return 'PENDING'
}

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url)
    const page = parseInt(url.searchParams.get('page') || '1')
    const limit = parseInt(url.searchParams.get('limit') || '20')
    const status = url.searchParams.get('status') || ''
    let partyId = url.searchParams.get('party_id') || ''
    const invoiceType = url.searchParams.get('invoice_type') || ''
    const dateFrom = url.searchParams.get('date_from') || ''
    const dateTo = url.searchParams.get('date_to') || ''
    const offset = (page - 1) * limit

      // Company scope: SUPER_ADMIN uses x-company-id header; ADMIN auto-scopes to own party_id
      const authUser = await getUserFromToken(req)
      const companyId = await resolveCompanyScope(req, authUser)

    const isAdminRole = authUser?.role === 'SUPER_ADMIN' || authUser?.role === 'ADMIN'

    // Non-admin users always see only their own invoices regardless of any query param
    if (!isAdminRole && authUser?.party_id) {
      partyId = authUser.party_id
    }

    let companyPartyIds: string[] | null = null
    if (companyId) {
      const tree = await getPartyDescendants(companyId)
      const treeIds = tree && tree.length > 0 ? tree.map((r: { id: string }) => r.id) : []
      if (!treeIds.includes(companyId)) treeIds.push(companyId)
      companyPartyIds = treeIds
    }

    // When a specific party is requested (the Collect Payment modal, ledgers, etc.),
    // verify it belongs to the caller's company tree, then filter by that single id.
    // Do NOT also inject the whole company tree into a `.in()` filter: PostgREST
    // encodes `.in()` into the request URL, and for companies with 150+ parties the
    // UUID list overflows undici's 16KB header limit (UND_ERR_HEADERS_OVERFLOW),
    // killing the request with an opaque 500 before it ever reaches the database.
    if (partyId && companyPartyIds !== null && !companyPartyIds.includes(partyId)) {
      // Requested party is outside the caller's company — return empty, never leak.
      return NextResponse.json({
        success: true,
        data: [],
        pagination: { page, limit, total: 0, pages: 0 },
      })
    }
    // A single-party request is scoped by `.eq` below; only fall back to the company
    // `.in()` (the unfiltered list view) when no specific party was requested.
    const scopeByCompanyList = !partyId && companyPartyIds !== null

    let query = supabaseAdmin
      .from('invoices')
      .select(`
        *,
        billing_party:parties!billing_party_id(id, name, gstin, party_type_id, salesman_id, party_types(name)),
        supplier:parties!supplier_id(id, name),
        invoice_items(*, products(name, sku))
      `, { count: 'exact' })
      .or('status.eq.ACTIVE,status.is.null')
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1)

    if (partyId) query = query.eq('billing_party_id', partyId)
    else if (scopeByCompanyList) query = query.in('billing_party_id', companyPartyIds as string[])
    if (invoiceType) query = query.eq('invoice_type', invoiceType)
    if (dateFrom) query = query.gte('invoice_date', dateFrom)
    if (dateTo) query = query.lte('invoice_date', dateTo)
    if (status === 'CANCELLED') query = query.eq('is_cancelled', true)
    else if (status) {
      // Only confirmed invoices (order_status = CONFIRM) are real receivables.
      // Payment dues must never appear before "Mark as Invoiced".
      const statuses = status.split(',').map((s: string) => s.trim()).filter(Boolean)
      query = statuses.length === 1
        ? query.eq('payment_status', statuses[0]).not('is_cancelled', 'eq', true)
        : query.in('payment_status', statuses).not('is_cancelled', 'eq', true)
    }

    let data: Record<string, unknown>[] | null = null
    let count: number | null = null

    const result = await query
    if (!result.error && (result.data || []).length > 0) {
      data = result.data as Record<string, unknown>[] | null
      count = result.count
    } else {
      // Fallback: simple query without joins but KEEP company filter for data isolation
        let simpleQuery = supabaseAdmin
          .from('invoices')
          .select('*', { count: 'exact' })
          .order('created_at', { ascending: false })
          .range(offset, offset + limit - 1)

        // CRITICAL: Always apply company filter even in fallback. Same overflow rule
        // as the main query — a single-party request uses `.eq`, never the big `.in()`.
        if (partyId) simpleQuery = simpleQuery.eq('billing_party_id', partyId)
        else if (scopeByCompanyList) simpleQuery = simpleQuery.in('billing_party_id', companyPartyIds as string[])
        if (invoiceType) simpleQuery = simpleQuery.eq('invoice_type', invoiceType)
        if (dateFrom) simpleQuery = simpleQuery.gte('invoice_date', dateFrom)
        if (dateTo) simpleQuery = simpleQuery.lte('invoice_date', dateTo)

        const simpleResult = await simpleQuery
        data = simpleResult.data as Record<string, unknown>[] | null
        count = simpleResult.count
        if (simpleResult.error) throw simpleResult.error
    }

    // Resolve creator names (no FK, do a separate lookup)
    const items = (data || []) as Record<string, unknown>[]
    const companyIds = [...new Set(items.map((r) => r.company_id as string | null).filter(Boolean))] as string[]
    const companyAdminMap: Record<string, string> = {}
    if (companyIds.length > 0) {
      const { data: companyUsers } = await supabaseAdmin
        .from('users')
        .select('id, party_id, roles(name)')
        .in('party_id', companyIds)

      for (const companyUser of companyUsers || []) {
        if (!companyUser.party_id) continue
        const roles = companyUser.roles as any
        const roleName = Array.isArray(roles) ? roles[0]?.name : roles?.name
        const existing = companyAdminMap[companyUser.party_id]
        if (!existing || roleName === 'ADMIN') {
          companyAdminMap[companyUser.party_id] = companyUser.id
        }
      }
    }

    const effectiveCreatorIds = [...new Set(items.map((inv) => {
      const billingParty = inv.billing_party as { salesman_id?: string | null } | null | undefined
      return (inv.created_by as string | null) || billingParty?.salesman_id || (inv.company_id ? companyAdminMap[inv.company_id as string] || null : null)
    }).filter(Boolean))] as string[]
    const creatorMap = await resolveUserDisplayMap(effectiveCreatorIds)

    const enriched = items.map((inv) => {
      const billingParty = inv.billing_party as { salesman_id?: string | null } | null | undefined
      const effectiveCreatorId = (inv.created_by as string | null) || billingParty?.salesman_id || (inv.company_id ? companyAdminMap[inv.company_id as string] || null : null)
      return {
        ...inv,
        order_status: deriveInvoiceOrderStatus(inv),
        created_by_user: effectiveCreatorId ? (creatorMap[effectiveCreatorId] || null) : null,
      }
    })

    return NextResponse.json({
      success: true,
      data: enriched,
      pagination: { page, limit, total: count || 0, pages: Math.ceil((count || 0) / limit) },
    })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed to fetch invoices' },
      { status: 500 }
    )
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { billingPartyId, invoiceType, billingPath, lines, priceListId, supplyDate, billDiscountPercent } = body

    if (!billingPartyId || !invoiceType || !lines?.length) {
      return NextResponse.json(
        { success: false, message: 'billingPartyId, invoiceType, and lines are required' },
        { status: 400 }
      )
    }

    // CRITICAL: Get authenticated user and resolve company scope for data isolation
    const authUser = await getUserFromToken(req)
    const companyId = await resolveCompanyScope(req, authUser)

    // Verify the party belongs to the user's company and is verified
    if (companyId) {
      const tree = await getPartyDescendants(companyId)
      const treeIds = tree && tree.length > 0 ? tree.map((r: { id: string }) => r.id) : []
      if (!treeIds.includes(companyId)) treeIds.push(companyId)

      if (!treeIds.includes(billingPartyId)) {
        return NextResponse.json({ success: false, message: 'Party not found or access denied' }, { status: 403 })
      }

      const { data: party } = await supabaseAdmin
        .from('parties')
        .select('is_verified')
        .eq('id', billingPartyId)
        .maybeSingle()

      if (party && party.is_verified === false) {
        return NextResponse.json({ success: false, message: 'Party must be verified before creating invoices' }, { status: 400 })
      }
    }

    // Get GST config for supplier state
    let manufacturerStateId: string | null = null
    let manufacturerGstin: string | null = null

    if (companyId) {
      const { data: gstConfig } = await supabaseAdmin
        .from('gst_config')
        .select('state_id, company_state_code, gst_number')
        .eq('company_id', companyId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()

      manufacturerStateId = gstConfig?.state_id ?? gstConfig?.company_state_code ?? null
      manufacturerGstin = gstConfig?.gst_number ?? null
    }

      // If no GST config found for this company, do NOT fallback to another company's config
      // Just default to intrastate calculation
    let isInterstateOverride: boolean | undefined
    if (!manufacturerStateId) {
      const { data: billingParty } = await supabaseAdmin
        .from('parties')
        .select('state_id')
        .eq('id', billingPartyId)
        .maybeSingle()

      if (billingParty?.state_id) {
        manufacturerStateId = billingParty.state_id
      }
      // Default to intrastate (CGST+SGST) when no GST config exists
      isInterstateOverride = false
    }

    // Calculate invoice
    const calculated = await calculateInvoice(
      billingPartyId,
      manufacturerStateId!,
      lines,
      priceListId,
      isInterstateOverride,
      typeof billDiscountPercent === 'number' && billDiscountPercent > 0 ? billDiscountPercent : undefined,
      undefined,
      companyId
    )

    // Generate invoice number
    const invoiceNumber = await generateInvoiceNumber()

    // Get party GSTIN
    const { data: billingParty } = await supabaseAdmin
      .from('parties')
      .select('gstin, territory_id')
      .eq('id', billingPartyId)
      .maybeSingle()

    // Insert invoice
    const insertData: Record<string, unknown> = {
      invoice_number: invoiceNumber,
      invoice_type: invoiceType,
      billing_path: billingPath || 'A',
      billing_party_id: billingPartyId,
      territory_id: billingParty?.territory_id,
      invoice_date: new Date().toISOString().split('T')[0],
      supply_date: supplyDate || new Date().toISOString().split('T')[0],
      due_date: new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0],
      subtotal: calculated.subtotal,
      discount_amount: calculated.discountAmount,
      taxable_amount: calculated.taxableAmount,
      cgst_amount: calculated.cgstAmount,
      sgst_amount: calculated.sgstAmount,
      igst_amount: calculated.igstAmount,
      cess_amount: calculated.cessAmount,
      round_off: calculated.roundOff,
      grand_total: calculated.grandTotal,
      is_interstate: calculated.isInterstate,
      supplier_gstin: manufacturerGstin || '',
      buyer_gstin: billingParty?.gstin || '',
      payment_status: 'UNPAID',
      amount_outstanding: calculated.grandTotal,
      order_status: 'PENDING',
      status: 'ACTIVE',
      ...((authUser?.app_user_id || authUser?.id) ? { created_by: authUser.app_user_id || authUser.id } : {}),
    }
    if (companyId) {
      insertData.company_id = companyId
    }

    const { data: invoice, error: invoiceError } = await supabaseAdmin
      .from('invoices')
      .insert(insertData)
      .select()
      .single()

    if (invoiceError) throw invoiceError

    // Insert invoice items
    const items = calculated.lines.map(line => ({
      invoice_id: invoice.id,
      product_id: line.productId,
      hsn_code: line.hsnCode,
      quantity: line.quantity,
      unit_of_measure: line.unitOfMeasure,
      unit_price: line.unitPrice,
      price_list_id: line.priceListId,
      price_overridden: line.priceOverridden,
      discount_percent: line.discountPercent,
      discount_amount: line.discountAmount,
      taxable_amount: line.taxableAmount,
      gst_rate: line.gstRate,
      cgst_rate: line.cgstRate,
      sgst_rate: line.sgstRate,
      igst_rate: line.igstRate,
      cgst_amount: line.cgstAmount,
      sgst_amount: line.sgstAmount,
      igst_amount: line.igstAmount,
      line_total: line.lineTotal,
    }))

      const { error: itemsError } = await supabaseAdmin.from('invoice_items').insert(items)
      if (itemsError) throw itemsError

      // Deduct grand total from party wallet balance and log transaction
        {
          const { data: currentParty } = await supabaseAdmin
            .from('parties')
            .select('wallet_balance, name')
            .eq('id', billingPartyId)
            .single()
          const currentBalance = Number(currentParty?.wallet_balance || 0)
          const newBalance = currentBalance - calculated.grandTotal
          await supabaseAdmin
            .from('parties')
            .update({ wallet_balance: newBalance })
            .eq('id', billingPartyId)

          // Log wallet transaction
          await supabaseAdmin.from('wallet_transactions').insert({
            party_id: billingPartyId,
            type: 'INVOICE_DEBIT',
            amount: -calculated.grandTotal,
            balance_after: newBalance,
            reference_id: invoiceNumber,
            reference_type: 'INVOICE',
            description: `Invoice ${invoiceNumber} generated — ${fmt(calculated.grandTotal)} deducted`,
            created_by: authUser?.app_user_id || authUser?.id || null,
            company_id: companyId || null,
          })
        }

      return NextResponse.json({ success: true, data: { ...invoice, items } }, { status: 201 })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed to create invoice' },
      { status: 500 }
    )
  }
}
