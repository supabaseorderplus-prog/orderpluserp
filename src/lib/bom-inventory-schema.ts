import fs from 'node:fs'
import path from 'node:path'

import { runDirectSql } from '@/lib/direct-sql'
import { supabaseAdmin } from '@/lib/supabase-server'

type DbError = {
  code?: string
  message?: string
  details?: string
  hint?: string
}

const BOM_INVENTORY_SCHEMA_NOT_READY_MESSAGE = 'BOM and inventory database migration has not been applied yet.'

let bomInventorySchemaEnsurePromise: Promise<boolean> | null = null
let bomInventorySchemaEnsured = false

function readMigrationSql(): string {
  return fs.readFileSync(
    path.join(process.cwd(), 'supabase/migrations/20260625000000_create_bom_inventory_tables.sql'),
    'utf8',
  )
}

function errorText(error: unknown): string {
  if (!error || typeof error !== 'object') return ''
  const candidate = error as DbError
  return [candidate.message, candidate.details, candidate.hint]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join(' | ')
}

function isMissingExecSql(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: string }).code === 'PGRST202'
}

export function isBomInventorySchemaGap(error: unknown): boolean {
  const text = errorText(error).toLowerCase()
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code || '')
    : ''

  return (
    code === '42P01'
    || code === '42703'
    || code === 'PGRST200'
    || code === 'PGRST204'
    || code === 'PGRST205'
    || text.includes('schema cache')
    || text.includes('could not find')
    || text.includes('does not exist')
    || text.includes('relation')
    || text.includes('raw_materials')
    || text.includes('stock_movements')
    || text.includes('bom_items')
    || text.includes(BOM_INVENTORY_SCHEMA_NOT_READY_MESSAGE.toLowerCase())
  )
}

async function runSchemaSql(sql: string): Promise<boolean> {
  const { error } = await supabaseAdmin.rpc('exec_sql', { sql })
  if (!error) return true
  if (!isMissingExecSql(error)) {
    console.warn('[bom-inventory] exec_sql failed:', errorText(error))
  }
  return runDirectSql(sql)
}

async function tablesExist(): Promise<boolean> {
  const [rawMaterials, bomItems, stockMovements] = await Promise.all([
    supabaseAdmin.from('raw_materials').select('id').limit(1),
    supabaseAdmin.from('bom_items').select('id').limit(1),
    supabaseAdmin.from('stock_movements').select('id').limit(1),
  ])

  return !rawMaterials.error && !bomItems.error && !stockMovements.error
}

export async function ensureBomInventorySchema(): Promise<boolean> {
  if (bomInventorySchemaEnsured) return true
  if (bomInventorySchemaEnsurePromise) return bomInventorySchemaEnsurePromise

  bomInventorySchemaEnsurePromise = (async () => {
    if (await tablesExist()) {
      bomInventorySchemaEnsured = true
      return true
    }

    try {
      const sql = readMigrationSql()
      const applied = await runSchemaSql(sql)
      if (!applied) return false
      const ready = await tablesExist()
      bomInventorySchemaEnsured = ready
      return ready
    } catch (error) {
      console.warn('[bom-inventory] schema ensure failed:', errorText(error) || error)
      return false
    } finally {
      bomInventorySchemaEnsurePromise = null
    }
  })()

  return bomInventorySchemaEnsurePromise
}

export { BOM_INVENTORY_SCHEMA_NOT_READY_MESSAGE }
