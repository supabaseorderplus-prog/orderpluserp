#!/usr/bin/env node
/**
 * Run product_categories RPC migration via direct Postgres connection
 * Use when exec_sql doesn't exist. Requires SUPABASE_DB_URL in .env.local
 * Get it from: Supabase Dashboard → Project Settings → Database → Connection string (URI)
 */

import { readFileSync, existsSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Load .env.local
const envPath = join(process.cwd(), '.env.local')
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([^#=]+)=(.*)$/)
    if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '')
  }
}

const dbUrl = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL

async function run() {
  if (!dbUrl) {
    console.log('⚠️  SUPABASE_DB_URL not set. Using Supabase SQL Editor instead.\n')
    const sql = readFileSync(join(__dirname, '../supabase-migrations/product-categories-rpc-full.sql'), 'utf8')
    console.log('Copy and run this in Supabase Dashboard → SQL Editor:\n')
    console.log('─'.repeat(60))
    console.log(sql)
    console.log('─'.repeat(60))
    console.log('\nGet the SQL Editor: Project → SQL → New query\n')
    return
  }

  const { default: pg } = await import('pg')
  const client = new pg.Client({ connectionString: dbUrl })

  const sql = readFileSync(join(__dirname, '../supabase-migrations/product-categories-rpc-full.sql'), 'utf8')

  try {
    await client.connect()
    console.log('🚀 Running product_categories RPC migration...\n')
    await client.query(sql)
    console.log('\n✅ Migration completed! You can now create categories.\n')
  } catch (err) {
    console.error('❌ Migration failed:', err.message)
    process.exit(1)
  } finally {
    await client.end()
  }
}

run()
