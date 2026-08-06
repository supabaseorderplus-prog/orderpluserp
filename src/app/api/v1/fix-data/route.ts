import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-server'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { userId, userName, companyId, companyName } = body
    
    const results = []
    
    // Update user name if provided
    if (userId && userName) {
      const { error: userError } = await supabaseAdmin
        .from('users')
        .update({ name: userName })
        .eq('id', userId)
      
      if (userError) {
        results.push({ action: 'update_user', status: 'error', message: userError.message })
      } else {
        results.push({ action: 'update_user', status: 'success', userId, userName })
      }
    }
    
    // Update company name if provided
    if (companyId && companyName) {
      const { error: companyError } = await supabaseAdmin
        .from('parties')
        .update({ name: companyName })
        .eq('id', companyId)
      
      if (companyError) {
        results.push({ action: 'update_company', status: 'error', message:companyError.message })
      } else {
        results.push({ action: 'update_company', status: 'success', companyId, companyName })
      }
    }
    
    return NextResponse.json({ success: true, results })
  } catch (err) {
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : 'Failed' },
      { status: 500 }
    )
  }
}