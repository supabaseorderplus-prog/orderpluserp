import { NextRequest, NextResponse } from 'next/server'
import { Client } from 'pg'

// ONE-TIME migration route — DELETE THIS FILE after running it once.
// Enables Supabase Realtime for delivery_lots so all devices see lots instantly.
export async function POST(req: NextRequest) {
  const secret = req.headers.get('x-migration-secret')
  if (secret !== process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 })
  }

  const dbUrl = process.env.SUPABASE_DB_URL
  if (!dbUrl) {
    return NextResponse.json({ success: false, message: 'SUPABASE_DB_URL not set' }, { status: 500 })
  }

  const client = new Client({ connectionString: dbUrl })
  const results: string[] = []

  try {
    await client.connect()
    results.push('Connected to database')

    // 1. Check if delivery_lots is already in the realtime publication
    const { rows: existing } = await client.query(
      `SELECT tablename FROM pg_publication_tables
       WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'delivery_lots'`
    )
    if (existing.length > 0) {
      results.push('delivery_lots is already in supabase_realtime publication — nothing to do')
    } else {
      await client.query(`ALTER PUBLICATION supabase_realtime ADD TABLE public.delivery_lots`)
      results.push('SUCCESS: delivery_lots added to supabase_realtime publication')
    }

    // 2. Verify
    const { rows: verify } = await client.query(
      `SELECT tablename FROM pg_publication_tables
       WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
       ORDER BY tablename`
    )
    results.push(`Realtime tables: ${verify.map((r) => String((r as { tablename?: string }).tablename || '')).join(', ')}`)

    await client.end()
    return NextResponse.json({ success: true, results })
  } catch (err) {
    await client.end().catch(() => {})
    const msg = err instanceof Error ? err.message : String(err)
    results.push(`Error: ${msg}`)
    return NextResponse.json({ success: false, results, message: msg }, { status: 500 })
  }
}
