import { NextRequest, NextResponse } from 'next/server'
import { getUserFromToken, supabaseAdmin } from '@/lib/supabase-server'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  try {
    const user = await getUserFromToken(req)
    if (!user) {
      return NextResponse.json(
        { success: false, message: 'Unauthorized' },
        { status: 401 },
      )
    }

    let roleId = user.role_id
    if (!roleId) {
      const { data: role, error: roleError } = await supabaseAdmin
        .from('roles')
        .select('id')
        .eq('name', user.role)
        .maybeSingle()

      if (roleError) {
        return NextResponse.json(
          { success: false, message: roleError.message },
          { status: 500 },
        )
      }
      roleId = role?.id || null
    }

    if (!roleId) {
      return NextResponse.json({ success: true, data: [] })
    }

    const { data, error } = await supabaseAdmin
      .from('permissions')
      .select('module, can_view, can_create, can_edit, can_delete, can_approve, scope')
      .eq('role_id', roleId)
      .eq('status', 'ACTIVE')
      .order('module')

    if (error) {
      return NextResponse.json(
        { success: false, message: error.message },
        { status: 500 },
      )
    }

    return NextResponse.json({ success: true, data: data || [] })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ success: false, message }, { status: 500 })
  }
}
