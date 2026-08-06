import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, getUserFromToken, resolveCompanyScope } from '@/lib/supabase-server'

export async function GET(req: NextRequest) {
  try {
    const authUser = await getUserFromToken(req)
    const companyId = await resolveCompanyScope(req, authUser)

    let tdQuery = supabaseAdmin.from('td_config').select('*, parties(name)').eq('status', 'ACTIVE')
    let cdQuery = supabaseAdmin.from('cd_config').select('*, parties(name)').eq('status', 'ACTIVE')
    let gstQuery = supabaseAdmin.from('gst_config').select('*').eq('status', 'ACTIVE')
    let secQuery = supabaseAdmin.from('security_interest_config').select('*').eq('status', 'ACTIVE')
    let rankQuery = supabaseAdmin.from('ranking_config').select('*').eq('status', 'ACTIVE')
    let yearlyBizQuery = supabaseAdmin.from('yearly_business_config').select('*').eq('status', 'ACTIVE')
    let expenseHeadsQuery = supabaseAdmin.from('expense_heads').select('*').eq('status', 'ACTIVE')

    if (companyId) {
      tdQuery = tdQuery.eq('company_id', companyId)
      cdQuery = cdQuery.eq('company_id', companyId)
      gstQuery = gstQuery.eq('company_id', companyId)
      secQuery = secQuery.eq('company_id', companyId)
      rankQuery = rankQuery.eq('company_id', companyId)
      yearlyBizQuery = yearlyBizQuery.eq('company_id', companyId)
      expenseHeadsQuery = expenseHeadsQuery.eq('company_id', companyId)
    }

    const { data: tdConfig } = await tdQuery
    const { data: cdConfig } = await cdQuery
    const { data: gstConfig } = await gstQuery
    const { data: secConfig } = await secQuery
    const { data: rankConfig } = await rankQuery
    const { data: yearlyBiz } = await yearlyBizQuery
    const { data: expenseHeads } = await expenseHeadsQuery

    return NextResponse.json({
      success: true,
      data: {
        tdConfig: tdConfig || [],
        cdConfig: cdConfig || [],
        gstConfig: gstConfig || [],
        securityInterestConfig: secConfig || [],
        rankingConfig: rankConfig || [],
        yearlyBusinessConfig: yearlyBiz || [],
        expenseHeads: expenseHeads || [],
      },
    })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed' },
      { status: 500 }
    )
  }
}

export async function PUT(req: NextRequest) {
  try {
    const body = await req.json()
    const { table, id, updates } = body

    const authUser = await getUserFromToken(req)
    const companyId = await resolveCompanyScope(req, authUser)

    const allowedTables = ['td_config', 'cd_config', 'gst_config', 'security_interest_config', 'ranking_config', 'yearly_business_config']
    if (!allowedTables.includes(table)) {
      return NextResponse.json({ success: false, message: 'Invalid config table' }, { status: 400 })
    }

    // Verify company access before update
    if (companyId) {
      const { data: existingConfig } = await supabaseAdmin
        .from(table)
        .select('company_id')
        .eq('id', id)
        .single()

      if (!existingConfig || existingConfig.company_id !== companyId) {
        return NextResponse.json({ success: false, message: 'Config not found or access denied' }, { status: 403 })
      }
    }

    const { data, error } = await supabaseAdmin
      .from(table)
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single()

    if (error) throw error
    return NextResponse.json({ success: true, data })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed' },
      { status: 500 }
    )
  }
}
