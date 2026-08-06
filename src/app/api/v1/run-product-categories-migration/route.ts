import { NextResponse } from 'next/server'
import { Client } from 'pg'
import { readFileSync } from 'fs'
import { join } from 'path'

const SQL_PATH = join(process.cwd(), 'supabase-migrations', 'FIX-product-categories-rpc.sql')

export async function POST() {
  const dbUrl = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL
  if (!dbUrl || !dbUrl.includes('supabase')) {
    return NextResponse.json({
      success: false,
      message: 'Add SUPABASE_DB_URL to .env.local (from Supabase Dashboard → Settings → Database → Connection string)',
    }, { status: 400 })
  }

  try {
    const client = new Client({ connectionString: dbUrl })
    await client.connect()
    const sql = readFileSync(SQL_PATH, 'utf8')
      .split('\n')
      .filter((l) => !l.trim().startsWith('--'))
      .join('\n')
      .trim()
    await client.query(sql)
    await client.end()
    return NextResponse.json({ success: true, message: 'Migration completed. Try creating a category now.' })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Migration failed' },
      { status: 500 }
    )
  }
}
