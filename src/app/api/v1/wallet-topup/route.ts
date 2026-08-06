import { NextRequest, NextResponse } from 'next/server'
import { getUserFromToken, resolveCompanyScope } from '@/lib/supabase-server'
import { adjustWallet } from '@/lib/wallet-adjust'

const fmt = (n: number) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(n)

export async function POST(req: NextRequest) {
  try {
    const authUser = await getUserFromToken(req)

    // Only ADMIN / SUPER_ADMIN may top up a wallet. The UI hides the button for
    // other roles, but enforce it server-side too — a salesman must not be able
    // to credit a wallet by calling the endpoint directly.
    if (authUser?.role !== 'ADMIN' && authUser?.role !== 'SUPER_ADMIN') {
      return NextResponse.json(
        { success: false, message: 'Only admins can top up wallets' },
        { status: 403 },
      )
    }

    const companyId = await resolveCompanyScope(req, authUser)
    const body = await req.json()
    const { party_id, amount, note } = body

    if (!party_id || !amount || amount <= 0) {
      return NextResponse.json({ success: false, message: 'party_id and positive amount required' }, { status: 400 })
    }

    const result = await adjustWallet({
      partyId: party_id,
      delta: amount,
      type: 'TOPUP_CREDIT',
      referenceType: 'TOPUP',
      description: note || `Wallet top-up of ${fmt(amount)}`,
      createdBy: authUser?.app_user_id || authUser?.id || null,
      companyId: companyId || null,
    })

    if (!result.ok) {
      return NextResponse.json({ success: false, message: result.message || 'Top-up failed' }, { status: result.status })
    }

    return NextResponse.json({ success: true, data: { new_balance: result.newBalance } })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Top-up failed' },
      { status: 500 }
    )
  }
}
