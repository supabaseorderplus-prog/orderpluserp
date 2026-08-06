import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, getUserFromToken, resolveCompanyScope } from '@/lib/supabase-server'

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url)
    const partyId = url.searchParams.get('partyId')
    const type = url.searchParams.get('type')
    const referenceType = url.searchParams.get('referenceType')
    const unread = url.searchParams.get('unread')
    const page = parseInt(url.searchParams.get('page') || '1')
    const limit = parseInt(url.searchParams.get('limit') || '20')
    const offset = (page - 1) * limit

    // CRITICAL: Enforce company isolation - users can only see notifications for their company
    const authUser = await getUserFromToken(req)
    if (!authUser) return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 })
    const companyId = await resolveCompanyScope(req, authUser)
    const userId = authUser.app_user_id || authUser.id

    const buildQuery = (withCompany: boolean) => {
      let query = supabaseAdmin.from('notifications').select('*', { count: 'exact' })
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1)
      if (partyId) query = query.eq('party_id', partyId)
      if (type) query = query.eq('type', type)
      if (referenceType) query = query.eq('reference_type', referenceType)
      if (unread === 'true') query = query.eq('is_read', false)
      if (withCompany && companyId) query = query.eq('company_id', companyId)
      return query
    }

    let result = await buildQuery(true)
    if (result.error?.code === '42703') result = await buildQuery(false)
    const { data, count, error } = result
    if (error) throw error

    return NextResponse.json({
      success: true,
      data: data || [],
      pagination: { page, limit, total: count || 0, pages: Math.ceil((count || 0) / limit) },
    })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed to fetch notifications' },
      { status: 500 }
    )
  }
}

export async function PUT(req: NextRequest) {
  try {
    const body = await req.json()
    const { notification_ids } = body

    if (!notification_ids || !Array.isArray(notification_ids)) {
      return NextResponse.json({ success: false, message: 'notification_ids array required' }, { status: 400 })
    }

    // CRITICAL: Enforce company isolation - users can only update notifications for their company
    const authUser = await getUserFromToken(req)
    if (!authUser) return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 })
    const companyId = await resolveCompanyScope(req, authUser)
    const userId = authUser.app_user_id || authUser.id

    const update = (withCompany: boolean) => {
      let query = supabaseAdmin.from('notifications')
        .update({ is_read: true, read_at: new Date().toISOString() })
        .in('id', notification_ids)
        .eq('user_id', userId)
      if (withCompany && companyId) query = query.eq('company_id', companyId)
      return query
    }

    let result = await update(true)
    if (result.error?.code === '42703') result = await update(false)
    const { error } = result

    if (error) throw error

    return NextResponse.json({ success: true, message: `${notification_ids.length} notifications marked read` })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed to update notifications' },
      { status: 500 }
    )
  }
}
