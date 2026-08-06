import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, getUserFromToken, resolveCompanyScope } from '@/lib/supabase-server'

export async function GET(req: NextRequest) {
  try {
    const authUser = await getUserFromToken(req)
    const companyId = await resolveCompanyScope(req, authUser)

    const url = new URL(req.url)
    const module = url.searchParams.get('module')
    const userId = url.searchParams.get('userId')
    const from = url.searchParams.get('from')
    const to = url.searchParams.get('to')
    const page = parseInt(url.searchParams.get('page') || '1')
    const limit = parseInt(url.searchParams.get('limit') || '50')
    const offset = (page - 1) * limit

    let query = supabaseAdmin
      .from('audit_logs')
      .select('*, users:public_users(name, email)', { count: 'exact' })
      .order('timestamp', { ascending: false })
      .range(offset, offset + limit - 1)

    if (module) query = query.eq('module', module)
    if (userId) query = query.eq('user_id', userId)
    if (from) query = query.gte('timestamp', from)
    if (to) query = query.lte('timestamp', to)
    if (companyId) query = query.eq('company_id', companyId)

    const { data, count, error } = await query
    if (error) {
      // Fallback without user join if the relation fails
      const fallbackQuery = supabaseAdmin
        .from('audit_logs')
        .select('*', { count: 'exact' })
        .order('timestamp', { ascending: false })
        .range(offset, offset + limit - 1)

      const { data: fbData, count: fbCount, error: fbError } = await fallbackQuery
      if (fbError) throw fbError

      return NextResponse.json({
        success: true,
        data: fbData || [],
        pagination: { page, limit, total: fbCount || 0, pages: Math.ceil((fbCount || 0) / limit) },
      })
    }

    return NextResponse.json({
      success: true,
      data: data || [],
      pagination: { page, limit, total: count || 0, pages: Math.ceil((count || 0) / limit) },
    })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed to fetch audit logs' },
      { status: 500 }
    )
  }
}
