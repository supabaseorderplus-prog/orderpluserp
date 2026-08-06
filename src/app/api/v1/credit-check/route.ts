import { NextRequest, NextResponse } from 'next/server'
import { checkCreditLimit } from '@/lib/services/credit-checker'
import { getUserFromToken, resolveCompanyScope } from '@/lib/supabase-server'

export async function POST(req: NextRequest) {
  try {
    const { partyId, amount } = await req.json()
    if (!partyId || amount === undefined) {
      return NextResponse.json({ success: false, message: 'partyId and amount required' }, { status: 400 })
    }

    // CRITICAL: Enforce company isolation - credit checks must be scoped to the user's company
    const authUser = await getUserFromToken(req)
    const companyId = await resolveCompanyScope(req, authUser)

    const result = await checkCreditLimit({ partyId, newInvoiceAmount: amount, companyId })
    return NextResponse.json({ success: true, data: result })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Credit check failed' },
      { status: 500 }
    )
  }
}
