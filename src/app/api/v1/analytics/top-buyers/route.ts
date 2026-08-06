import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, getUserFromToken, resolveCompanyScope } from '@/lib/supabase-server'

export async function GET(req: NextRequest) {
  try {
    const authUser = await getUserFromToken(req)
    const companyId = await resolveCompanyScope(req, authUser)

    if (!companyId) {
      return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 })
    }

    const url = new URL(req.url)
    const limit = parseInt(url.searchParams.get('limit') || '10')

    const { data, error } = await supabaseAdmin
      .from('invoices')
      .select('billing_party_id, grand_total, parties!billing_party_id(name)')
      .eq('company_id', companyId)
      .eq('status', 'ACTIVE')
      .not('is_cancelled', 'eq', true)
      .order('grand_total', { ascending: false })
      .limit(500)

    if (error) throw error

    const buyerMap = new Map<string, { name: string; totalOrders: number; totalSpent: number }>()
    for (const inv of data || []) {
      const key = inv.billing_party_id
      const party = Array.isArray(inv.parties) ? inv.parties[0] : inv.parties
      const name = party?.name || 'Unknown'
      const existing = buyerMap.get(key)
      if (existing) {
        existing.totalOrders += 1
        existing.totalSpent += Number(inv.grand_total)
      } else {
        buyerMap.set(key, { name, totalOrders: 1, totalSpent: Number(inv.grand_total) })
      }
    }

    const sorted = Array.from(buyerMap.values())
      .sort((a, b) => b.totalSpent - a.totalSpent)
      .slice(0, limit)

    return NextResponse.json({ data: sorted })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed' },
      { status: 500 }
    )
  }
}
