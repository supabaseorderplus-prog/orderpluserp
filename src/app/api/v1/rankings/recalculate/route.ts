import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, getUserFromToken, resolveCompanyScope } from '@/lib/supabase-server'
import { calculateRanking, getFiscalYear } from '@/lib/services/ranking-calculator'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const fiscalYear = body.fiscal_year || getFiscalYear()
    const partyType = body.party_type || 'CNF'

    // CRITICAL: Enforce company isolation - rankings must be scoped to user's company
    const authUser = await getUserFromToken(req)
    const companyId = await resolveCompanyScope(req, authUser)

    // Get all parties of type
    const { data: partyTypes } = await supabaseAdmin
      .from('party_types')
      .select('id')
      .eq('name', partyType)
      .single()

    if (!partyTypes) {
      return NextResponse.json({ success: false, message: 'Invalid party type' }, { status: 400 })
    }

    let partiesQuery = supabaseAdmin
      .from('parties')
      .select('id')
      .eq('party_type_id', partyTypes.id)
      .eq('status', 'ACTIVE')

    // CRITICAL: Filter by company_id to prevent cross-company data access
    if (companyId) {
      partiesQuery = partiesQuery.eq('company_id', companyId)
    }

    const { data: parties } = await partiesQuery

    const rankings = []
    for (const party of parties || []) {
      const result = await calculateRanking({ partyId: party.id, fiscalYear })
      rankings.push({ partyId: party.id, ...result })
    }

    // Sort by total score and assign ranks
    rankings.sort((a, b) => b.totalScore - a.totalScore)
    rankings.forEach((r, i) => { r.rank = i + 1 })

    // Upsert rankings
    for (const r of rankings) {
      const upsertData: any = {
        party_id: r.partyId,
        fiscal_year: fiscalYear,
        period_month: null,
        payment_performance_score: r.paymentScore,
        business_volume_score: r.volumeScore,
        material_lifting_score: r.liftingScore,
        total_weighted_score: r.totalScore,
        avg_payment_days: r.avgPaymentDays,
        total_business_value: r.totalBusinessValue,
        total_lifting_value: r.totalLiftingValue,
        rank_position: r.rank,
        calculated_at: new Date().toISOString(),
      }

      // CRITICAL: Associate ranking with company
      if (companyId) {
        upsertData.company_id = companyId
      }

      await supabaseAdmin
        .from('party_rankings')
        .upsert(upsertData, { onConflict: 'party_id,fiscal_year,period_month' })
    }

    return NextResponse.json({ success: true, data: { calculated: rankings.length } })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed' },
      { status: 500 }
    )
  }
}
