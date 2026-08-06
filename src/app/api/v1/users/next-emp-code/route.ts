import { NextRequest, NextResponse } from 'next/server'
import { supabasePublic } from '@/lib/supabase-server'

const isMissingUsersTable = (err: { code?: string; message?: string } | null | undefined) =>
  !!err && (
    err.code === 'PGRST205' ||
    err.code === '42P01' ||
    (err.message || '').includes("Could not find the table 'public.users'")
  )

async function getNextCodeFromTable(tableName: 'users' | 'app_users', prefix: string) {
  const { data, error } = await supabasePublic
    .from(tableName)
    .select('employee_code')
    .ilike('employee_code', `${prefix}%`)

  if (error) throw error

  let maxSeq = 0
  for (const row of ((data || []) as unknown as { employee_code?: string | null }[])) {
    const code = String(row.employee_code || '').toUpperCase()
    if (!code.startsWith(prefix)) continue
    const seq = Number.parseInt(code.slice(prefix.length), 10)
    if (Number.isFinite(seq) && seq > maxSeq) maxSeq = seq
  }

  return `${prefix}${String(maxSeq + 1).padStart(3, '0')}`
}

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url)
    const company_name = url.searchParams.get('company_name') || ''
    const prefix = `${company_name.substring(0, 2).toUpperCase()}EMP`

    try {
      return NextResponse.json({ nextCode: await getNextCodeFromTable('users', prefix) })
    } catch (err) {
      if (!isMissingUsersTable(err as { code?: string; message?: string })) throw err
      return NextResponse.json({ nextCode: await getNextCodeFromTable('app_users', prefix) })
    }
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed to generate code' },
      { status: 500 }
    )
  }
}
