#!/usr/bin/env node
/**
 * Run product_categories migration via Supabase Management API
 * Requires: SUPABASE_ACCESS_TOKEN (from supabase.com Account → Access Tokens)
 * Or: SUPABASE_SERVICE_ROLE_KEY as fallback (may not work for Management API)
 */

import { readFileSync, existsSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

const envPath = join(process.cwd(), '.env.local')
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([^#=]+)=(.*)$/)
    if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '')
  }
}

const PROJECT_REF = 'slgrxczjnburhggnmaew'
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN || process.env.SUPABASE_ACCESS_TOKEN_PAT

async function runQuery(query) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({ query }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.message || err.error || res.statusText || `HTTP ${res.status}`)
  }
  return res.json()
}

async function main() {
  if (!TOKEN) {
    console.error('❌ SUPABASE_ACCESS_TOKEN not set.')
    console.log('\nGet it from: https://supabase.com/dashboard/account/tokens')
    console.log('Create a token with database:write scope, add to .env.local:\n  SUPABASE_ACCESS_TOKEN=your_token\n')
    process.exit(1)
  }

  const sql = readFileSync(join(__dirname, '../supabase-migrations/RUN-THIS-ONCE-product-categories.sql'), 'utf8')
    .split('\n').filter(l => !l.trim().startsWith('--')).join('\n').trim()

  console.log('🚀 Running migration via Supabase Management API...\n')
  try {
    await runQuery(sql)
    console.log('  ✓ Done\n✅ Migration completed! Try creating a category now.\n')
  } catch (err) {
    console.error('❌', err.message)
    process.exit(1)
  }
}

main()
