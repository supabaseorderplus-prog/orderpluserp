import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, getUserFromToken, resolveCompanyScope, getPartyDescendants } from '@/lib/supabase-server'

async function fetchUserRow(id: string) {
  const select = 'id, phone, party_id'
  const { data, error } = await supabaseAdmin.from('users').select(select).eq('id', id).single()
  if (!error && data) return data as { id: string; phone: string | null; party_id: string | null }
  const { data: data2, error: error2 } = await supabaseAdmin.from('app_users').select(select).eq('id', id).single()
  if (!error2 && data2) return data2 as { id: string; phone: string | null; party_id: string | null }
  return null
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const authUser = await getUserFromToken(req)
    if (!authUser || (authUser.role !== 'SUPER_ADMIN' && authUser.role !== 'ADMIN')) {
      return NextResponse.json({ success: false, message: 'Forbidden' }, { status: 403 })
    }

    const companyId = await resolveCompanyScope(req, authUser)
    const { id } = await params

    const body = await req.json()
    const newPassword = String(body.new_password || '')
    if (newPassword.length < 6) {
      return NextResponse.json({ success: false, message: 'Password must be at least 6 characters' }, { status: 400 })
    }

    const user = await fetchUserRow(id)
    if (!user) {
      return NextResponse.json({ success: false, message: 'User not found' }, { status: 404 })
    }

    // Verify the user belongs to the caller's company scope
    if (companyId && user.party_id) {
      const tree = await getPartyDescendants(companyId)
      const treeIds = tree && tree.length > 0 ? tree.map((r: { id: string }) => r.id) : []
      if (!treeIds.includes(companyId)) treeIds.push(companyId)
      if (!treeIds.includes(user.party_id)) {
        return NextResponse.json({ success: false, message: 'Access denied' }, { status: 403 })
      }
    }

    const { error: authUpdateError } = await supabaseAdmin.auth.admin.updateUserById(id, {
      password: newPassword,
    })

    if (authUpdateError) {
      return NextResponse.json({ success: false, message: authUpdateError.message }, { status: 500 })
    }

    return NextResponse.json({ success: true, message: 'Password updated successfully' })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed to update password' },
      { status: 500 }
    )
  }
}
