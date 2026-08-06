import { NextRequest, NextResponse } from 'next/server'
import { calculateInvoice } from '@/lib/services/invoice-calculator'
import { supabaseAdmin, getUserFromToken, resolveCompanyScope, getPartyDescendants } from '@/lib/supabase-server'

export async function POST(req: NextRequest) {
  try {
    const authUser = await getUserFromToken(req)
    const companyId = await resolveCompanyScope(req, authUser)

    const { billingPartyId, lines, priceListId, isInterstateOverride, billDiscountPercent, skipTd } = await req.json()

    if (!billingPartyId || !lines?.length) {
      return NextResponse.json(
        { success: false, message: 'billingPartyId and lines are required' },
        { status: 400 }
      )
    }

    // Run the hierarchy check, GST config lookup, and party-state fallback concurrently —
    // they're independent. (getPartyDescendants is cached, so repeated calculations are cheap.)
    const [descendants, companyGstConfig, partyState] = await Promise.all([
      companyId
        ? getPartyDescendants(companyId).catch(() => [] as { id: string }[])
        : Promise.resolve([] as { id: string }[]),
      companyId
        ? supabaseAdmin
            .from('gst_config')
            .select('company_state_code')
            .eq('company_id', companyId)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle()
            .then(r => r.data)
        : Promise.resolve(null),
      supabaseAdmin
        .from('parties')
        .select('state_id')
        .eq('id', billingPartyId)
        .maybeSingle()
        .then(r => r.data),
    ])

    // Verify party belongs to the company (skip silently if the RPC/data is unavailable).
    if (companyId && descendants.length > 0) {
      const treeIds = descendants.map(r => r.id)
      if (!treeIds.includes(companyId)) treeIds.push(companyId)
      if (!treeIds.includes(billingPartyId)) {
        return NextResponse.json({ success: false, message: 'Party not found or access denied' }, { status: 403 })
      }
    }

    // Resolve supplier state: company GST config → any GST config → party state → UNKNOWN.
    let manufacturerStateId: string | null = companyGstConfig?.company_state_code ?? null

    if (!manufacturerStateId) {
      const { data: anyGstConfig } = await supabaseAdmin
        .from('gst_config')
        .select('company_state_code')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      manufacturerStateId = anyGstConfig?.company_state_code ?? null
    }

    if (!manufacturerStateId) {
      // New-project compatibility: allow live calculation even when GST config isn't set yet.
      // Using billing party state for equality check makes transaction intra-state by default.
      manufacturerStateId = partyState?.state_id || 'UNKNOWN'
    }

    const result = await calculateInvoice(
      billingPartyId,
      manufacturerStateId || 'UNKNOWN',
      lines,
      priceListId,
      typeof isInterstateOverride === 'boolean' ? isInterstateOverride : undefined,
      typeof billDiscountPercent === 'number' && billDiscountPercent > 0 ? billDiscountPercent : undefined,
      skipTd === true,
      companyId
    )

    return NextResponse.json({ success: true, data: result })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Calculation failed' },
      { status: 500 }
    )
  }
}
