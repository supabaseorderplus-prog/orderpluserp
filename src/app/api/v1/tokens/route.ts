import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, getUserFromToken, resolveCompanyScope, getPartyDescendants } from '@/lib/supabase-server'

type ScopeMode = 'CATEGORY' | 'PARTY'

type TokenScopeMeta = {
  scope_mode: ScopeMode
  selected_party_ids: string[]
  selected_party_types: string[]
}

function parseScopeMeta(raw: unknown, fallbackPartyType: string | null): TokenScopeMeta {
  if (!raw || typeof raw !== 'string') {
    return {
      scope_mode: 'CATEGORY',
      selected_party_ids: [],
      selected_party_types: fallbackPartyType ? [fallbackPartyType] : [],
    }
  }

  try {
    const parsed = JSON.parse(raw) as Partial<TokenScopeMeta>
    return {
      scope_mode: parsed.scope_mode === 'PARTY' ? 'PARTY' : 'CATEGORY',
      selected_party_ids: Array.isArray(parsed.selected_party_ids) ? parsed.selected_party_ids : [],
      selected_party_types: Array.isArray(parsed.selected_party_types)
        ? parsed.selected_party_types
        : (fallbackPartyType ? [fallbackPartyType] : []),
    }
  } catch {
    return {
      scope_mode: 'CATEGORY',
      selected_party_ids: [],
      selected_party_types: fallbackPartyType ? [fallbackPartyType] : [],
    }
  }
}

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url)
    const schemeId = url.searchParams.get('scheme_id')

    if (!schemeId) {
      return NextResponse.json({ success: false, message: 'scheme_id required' }, { status: 400 })
    }

    const { data: scheme, error: schemeErr } = await supabaseAdmin
      .from('schemes')
      .select('*')
      .eq('id', schemeId)
      .single()

    if (schemeErr || !scheme) {
      return NextResponse.json({ success: false, message: 'Scheme not found' }, { status: 404 })
    }

    const amountPerToken = Number(scheme.target_value) || 1000
    const tokensPerUnit = Number(scheme.reward_value) || 1
    const scope = parseScopeMeta(scheme.terms_conditions, scheme.applicable_party_type)

    const authUser = await getUserFromToken(req)
    const companyId = await resolveCompanyScope(req, authUser)

    let query = supabaseAdmin
      .from('payments')
      .select('party_id, amount, payment_date, party:parties!payments_party_id_fkey(name, party_code, party_types(name))')
      .eq('status', 'ACTIVE')
      .gte('payment_date', scheme.start_date)
      .lte('payment_date', scheme.end_date)

    // CRITICAL: Filter by company hierarchy for data isolation
    if (companyId !== null) {
      const tree = await getPartyDescendants(companyId)
      const treeIds = tree && tree.length > 0 ? tree.map((r: { id: string }) => r.id) : []
      if (!treeIds.includes(companyId)) treeIds.push(companyId)
      query = query.in('party_id', treeIds)
    }

    if (scope.scope_mode === 'PARTY' && scope.selected_party_ids.length > 0) {
      query = query.in('party_id', scope.selected_party_ids)
    }

    const { data: payments, error: payErr } = await query
    if (payErr) throw payErr

    const normalizedScopeTypes = scope.selected_party_types.map(t => String(t).toUpperCase())

    const partyMap = new Map<string, {
      party_id: string
      party_name: string
      party_code: string
      party_type: string | null
      total_paid: number
      tokens_earned: number
    }>()

    for (const p of payments || []) {
      const party = (p as { party?: { name: string; party_code: string; party_types: { name: string } | null } | null }).party || null
      if (!party) continue

      const partyType = party.party_types?.name ? String(party.party_types.name).toUpperCase() : null

      if (scope.scope_mode === 'CATEGORY') {
        if (normalizedScopeTypes.length > 0 && !normalizedScopeTypes.includes('ALL')) {
          if (!partyType || !normalizedScopeTypes.includes(partyType)) continue
        }
      }

      const amount = Number(p.amount)
      const tokensFromThisPayment = Math.floor(amount / amountPerToken) * tokensPerUnit
      const existing = partyMap.get(p.party_id)

      if (existing) {
        existing.total_paid += amount
        existing.tokens_earned += tokensFromThisPayment
      } else {
        partyMap.set(p.party_id, {
          party_id: p.party_id,
          party_name: party.name,
          party_code: party.party_code,
          party_type: party.party_types?.name || null,
          total_paid: amount,
          tokens_earned: tokensFromThisPayment,
        })
      }
    }

    const result = Array.from(partyMap.values())
      .filter(p => p.tokens_earned > 0)
      .sort((a, b) => b.tokens_earned - a.tokens_earned)

    return NextResponse.json({
      success: true,
      data: result,
      meta: { amount_per_token: amountPerToken, tokens_per_unit: tokensPerUnit, scope },
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to fetch token balances'
    console.error('[tokens] GET failed:', message)
    return NextResponse.json(
      { success: false, message },
      { status: 500 }
    )
  }
}
