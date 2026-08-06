#!/usr/bin/env node
/**
 * Run product_categories RPC migration - fixes "company_id not in schema cache" error
 * Creates database functions that bypass PostgREST schema validation
 */

import { readFileSync, existsSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

// Load .env.local (Next.js convention)
const envPath = join(process.cwd(), '.env.local')
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([^#=]+)=(.*)$/)
    if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '')
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url))

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://slgrxczjnburhggnmaew.supabase.co'
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNsZ3J4Y3pqbmJ1cmhnZ25tYWV3Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MTYwNTg1OSwiZXhwIjoyMDg3MTgxODU5fQ.Kv3w4mDrMwFbV4OQXVEVO-Lr7sNGbQFCWuFM_MHs0yo'

async function execSql(sql) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/exec_sql`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Prefer': 'return=minimal',
    },
    body: JSON.stringify({ sql }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.message || res.statusText || `HTTP ${res.status}`)
  }
}

async function run() {
  if (!SUPABASE_SERVICE_KEY) {
    console.error('❌ Missing SUPABASE_SERVICE_ROLE_KEY or SUPABASE_SERVICE_KEY in environment')
    console.log('Add it to .env.local or run: SUPABASE_SERVICE_ROLE_KEY=xxx node scripts/run-product-categories-rpc-migration.mjs')
    process.exit(1)
  }

  console.log('🚀 Running product_categories RPC migration...\n')

  const statements = [
    `ALTER TABLE public.product_categories ADD COLUMN IF NOT EXISTS company_id UUID`,
    `CREATE INDEX IF NOT EXISTS idx_product_categories_company_id ON public.product_categories(company_id)`,
    `DROP FUNCTION IF EXISTS public.create_product_category(uuid, text)`,
    `DROP FUNCTION IF EXISTS public.create_product_category(text, uuid)`,
    `DROP FUNCTION IF EXISTS public.list_product_categories(uuid)`,
    `DROP FUNCTION IF EXISTS public.delete_product_category(uuid, uuid)`,
    `CREATE FUNCTION public.list_product_categories(p_company_id uuid)
RETURNS TABLE(id uuid, name text) LANGUAGE sql SECURITY DEFINER STABLE AS $$
  SELECT pc.id, pc.name::text FROM public.product_categories pc WHERE pc.company_id = p_company_id ORDER BY pc.name;
$$`,
    `CREATE FUNCTION public.create_product_category(p_company_id uuid, p_name text)
RETURNS TABLE(id uuid, name text) LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE new_id uuid;
BEGIN
  INSERT INTO public.product_categories (name, company_id) VALUES (p_name, p_company_id) RETURNING product_categories.id INTO new_id;
  RETURN QUERY SELECT pc.id, pc.name::text FROM public.product_categories pc WHERE pc.id = new_id;
END;
$$`,
    `CREATE FUNCTION public.delete_product_category(p_id uuid, p_company_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE public.products SET category_id = NULL WHERE category_id = p_id AND company_id = p_company_id;
  DELETE FROM public.product_categories WHERE id = p_id AND company_id = p_company_id;
END;
$$`,
    `GRANT EXECUTE ON FUNCTION public.list_product_categories(uuid) TO service_role`,
    `GRANT EXECUTE ON FUNCTION public.list_product_categories(uuid) TO authenticated`,
    `GRANT EXECUTE ON FUNCTION public.create_product_category(uuid, text) TO service_role`,
    `GRANT EXECUTE ON FUNCTION public.create_product_category(uuid, text) TO authenticated`,
    `GRANT EXECUTE ON FUNCTION public.delete_product_category(uuid, uuid) TO service_role`,
    `GRANT EXECUTE ON FUNCTION public.delete_product_category(uuid, uuid) TO authenticated`,
    `NOTIFY pgrst, 'reload schema'`,
  ]

  try {
    for (let i = 0; i < statements.length; i++) {
      await execSql(statements[i])
      console.log(`  ✓ Step ${i + 1}/${statements.length}`)
    }
    console.log('\n✅ Migration completed successfully!')
    console.log('   You can now create categories in the app.\n')
  } catch (err) {
    if (err.message?.includes('exec_sql') || err.message?.includes('function') || err.message?.includes('404')) {
      console.error('❌ Run the full migration in Supabase SQL Editor (should be open in your browser):\n')
      const sqlPath = join(__dirname, '../supabase-migrations/FIX-product-categories-rpc.sql')
      console.log(readFileSync(sqlPath, 'utf8'))
      console.log('\nPaste the above, click Run, then try creating a category again.\n')
    } else {
      console.error('❌ Migration failed:', err.message)
      console.log('\nRun the SQL manually in Supabase SQL Editor:')
      console.log('  File: supabase-migrations/FIX-product-categories-rpc.sql')
      console.log(`  URL:  ${SUPABASE_URL.replace('https://', 'https://supabase.com/dashboard/project/').replace('.supabase.co', '')}/sql/new\n`)
    }
    process.exit(1)
  }
}

run()
