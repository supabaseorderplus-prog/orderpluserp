import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-server'

export async function POST(req: NextRequest) {
  try {
    // First, get all role IDs
    const { data: roles } = await supabaseAdmin
      .from('roles')
      .select('id, name')
    
    const roleMap: Record<string, string> = {}
    for (const role of roles || []) {
      roleMap[role.name] = role.id
    }
    
    console.log('[FIX-ROLE] Role map:', roleMap)
    
    // Get all users with their roles
    const { data: users, error: fetchError } = await supabaseAdmin
      .from('users')
      .select('id, name, role_id, roles(id, name)')
    
    if (fetchError) {
      return NextResponse.json({ error: fetchError.message }, { status: 500 })
    }
    
    console.log('[FIX-ROLE] Found users:', users?.length)
    
    const results = []
    
    for (const user of users || []) {
      // Get role name from roles relation
      const roleData = Array.isArray(user.roles) ? user.roles[0] : user.roles
      const roleName = roleData?.name || null
      
      console.log(`[FIX-ROLE] User ${user.id}: role_id=${user.role_id}, roleName=${roleName}`)
      
      // Skip if role_id is already set
      if (user.role_id) {
        results.push({ id: user.id, name: user.name, role: roleName, status: 'skipped', reason: 'role_id already set' })
        continue
      }
      
      // Find the correct role_id based on role name
      let correctRoleId: string | null = null
      if (roleName && roleMap[roleName]) {
        correctRoleId = roleMap[roleName]
      }
      
      if (correctRoleId) {
        const { error: updateError } = await supabaseAdmin
          .from('users')
          .update({ role_id: correctRoleId })
          .eq('id', user.id)
        
        if (updateError) {
          results.push({ id: user.id, name: user.name, role: roleName, status: 'error', message: updateError.message })
        } else {
          results.push({ id: user.id, name: user.name, role: roleName, status: 'updated', newRoleId: correctRoleId })
        }
      } else {
        results.push({ id: user.id, name: user.name, role: roleName, status: 'skipped', reason: 'Unknown role' })
      }
    }
    
    return NextResponse.json({ success: true, processed: results.filter(r => r.status === 'updated').length, total: users?.length || 0, results })
  } catch (err) {
    console.error('[FIX-ROLE] Error:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed' },
      { status: 500 }
    )
  }
}