#!/usr/bin/env node
/**
 * Create the delivery_lots + delivery_lot_orders tables (and realtime publication)
 * in the production Supabase project so delivery lots sync across every device.
 *
 * Runs supabase-migrations/enable-delivery-lots-realtime.sql against prod.
 *
 * It tries, in order, whichever credential is available:
 *   1. SUPABASE_ACCESS_TOKEN  -> Supabase Management API (cleanest; get one at
 *                                https://supabase.com/dashboard/account/tokens
 *                                with database:write scope)
 *   2. SUPABASE_DB_URL / DATABASE_URL -> direct Postgres connection via `pg`
 *      (also tries the transaction pooler host automatically)
 *
 * Usage:
 *   SUPABASE_ACCESS_TOKEN=sbp_xxx node scripts/run-delivery-lots-migration.mjs
 *   # or just put a fresh SUPABASE_DB_URL in .env.local and run:
 *   node scripts/run-delivery-lots-migration.mjs
 */

import { readFileSync, existsSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'

const __dirname = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

// Load .env.local into process.env (without overwriting real shell vars)
const envPath = join(process.cwd(), '.env.local')
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([^#=]+)=(.*)$/)
    if (m && !process.env[m[1].trim()]) {
      process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '')
    }
  }
}

const PROJECT_REF = 'slgrxczjnburhggnmaew'
const SQL = readFileSync(
  join(__dirname, '../supabase-migrations/enable-delivery-lots-realtime.sql'),
  'utf8',
)

async function viaManagementApi(token) {
  console.log('→ Trying Supabase Management API…')
  const res = await fetch(
    `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ query: SQL }),
    },
  )
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.message || err.error || `HTTP ${res.status}`)
  }
  return true
}

async function viaDirectPg() {
  const { Client } = require('pg')
  const url = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL
  if (!url) throw new Error('no SUPABASE_DB_URL / DATABASE_URL')

  const m = url.match(/^postgres(?:ql)?:\/\/([^:]+):(.+)@([^:/]+)(?::(\d+))?\/(.+?)(?:\?.*)?$/)
  if (!m) throw new Error('cannot parse DB URL')
  const [, user, pass, host, port, db] = m

  const targets = [
    { host, port: Number(port) || 5432, user, label: `direct ${host}` },
    {
      host: 'aws-1-us-east-1.pooler.supabase.com',
      port: 6543,
      user: user.includes('.') ? user : `postgres.${PROJECT_REF}`,
      label: 'transaction pooler',
    },
  ]

  let lastErr
  for (const t of targets) {
    console.log(`→ Trying direct Postgres (${t.label})…`)
    const client = new Client({
      host: t.host,
      port: t.port,
      user: t.user,
      password: pass,
      database: db || 'postgres',
      ssl: { rejectUnauthorized: false },
    })
    try {
      await client.connect()
      await client.query(SQL)
      await client.end()
      return true
    } catch (e) {
      lastErr = e
      await client.end().catch(() => {})
      console.log(`  ✗ ${e.code || ''} ${e.message}`)
    }
  }
  throw lastErr
}

async function verify() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return
  const res = await fetch(`${url}/rest/v1/delivery_lots?select=id&limit=1`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  })
  console.log(res.ok ? '✓ Verified: delivery_lots is now queryable.' : `⚠ Verify returned HTTP ${res.status}`)
}

async function main() {
  const token = process.env.SUPABASE_ACCESS_TOKEN || process.env.SUPABASE_ACCESS_TOKEN_PAT
  let done = false
  try {
    if (token) done = await viaManagementApi(token)
  } catch (e) {
    console.log(`  ✗ Management API: ${e.message}`)
  }
  if (!done) {
    try {
      done = await viaDirectPg()
    } catch (e) {
      console.log(`  ✗ Direct Postgres: ${e.message}`)
    }
  }

  if (!done) {
    console.error('\n❌ Could not run the migration — no working credential.')
    console.error('   Provide ONE of:')
    console.error('   • SUPABASE_ACCESS_TOKEN (https://supabase.com/dashboard/account/tokens, database:write)')
    console.error('   • a fresh SUPABASE_DB_URL password in .env.local')
    console.error('   • or paste supabase-migrations/enable-delivery-lots-realtime.sql into the dashboard SQL editor:')
    console.error(`     https://supabase.com/dashboard/project/${PROJECT_REF}/sql/new`)
    process.exit(1)
  }

  console.log('✅ Migration ran successfully.')
  await verify().catch(() => {})
  console.log('\nNext: open Delivery Lots once on the device that has local lots — it will upload them to the shared DB and sync everywhere.')
}

main()
