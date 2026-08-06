import { runDirectSql } from '@/lib/direct-sql'
import { supabaseAdmin } from '@/lib/supabase-server'

export const SCHEME_PARTIES_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS public.scheme_parties (
  scheme_id uuid NOT NULL REFERENCES public.schemes(id) ON DELETE CASCADE,
  party_id text NOT NULL,
  enrolled_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scheme_id, party_id)
);

CREATE INDEX IF NOT EXISTS idx_scheme_parties_scheme_id
  ON public.scheme_parties(scheme_id);

CREATE INDEX IF NOT EXISTS idx_scheme_parties_party_id
  ON public.scheme_parties(party_id);

ALTER TABLE public.scheme_parties ENABLE ROW LEVEL SECURITY;

NOTIFY pgrst, 'reload schema';
`

type DbError = {
  code?: string
  message?: string
  details?: string
  hint?: string
}

const SCHEMA_ERROR_CODES = new Set(['42P01', '42703', 'PGRST200', 'PGRST204', 'PGRST205'])

let ensurePromise: Promise<boolean> | null = null
let schemaEnsured = false

function errorText(error: unknown): string {
  if (!error || typeof error !== 'object') return ''
  const e = error as DbError
  return [e.message, e.details, e.hint]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join(' | ')
}

export function isSchemePartiesSchemaError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const e = error as DbError
  const text = `${e.message || ''} ${e.details || ''} ${e.hint || ''}`.toLowerCase()
  return (
    SCHEMA_ERROR_CODES.has(e.code || '') ||
    text.includes('scheme_parties') ||
    text.includes('schema cache') ||
    text.includes('does not exist') ||
    text.includes('could not find')
  )
}

async function runSchemaSql(): Promise<boolean> {
  const { error } = await supabaseAdmin.rpc('exec_sql', { sql: SCHEME_PARTIES_SCHEMA_SQL })
  if (!error) return true
  if (error.code !== 'PGRST202') {
    console.warn('[scheme_parties] exec_sql failed:', errorText(error))
  }
  return runDirectSql(SCHEME_PARTIES_SCHEMA_SQL)
}

async function tableIsReady(): Promise<boolean> {
  const { error } = await supabaseAdmin.from('scheme_parties').select('scheme_id').limit(0)
  return !error
}

export async function schemePartiesTableIsReady(): Promise<boolean> {
  return tableIsReady()
}

export async function ensureSchemePartiesSchema(): Promise<boolean> {
  if (schemaEnsured) return true
  if (ensurePromise) return ensurePromise

  ensurePromise = (async () => {
    if (await tableIsReady()) {
      schemaEnsured = true
      return true
    }

    try {
      const applied = await runSchemaSql()
      if (!applied) return false

      for (let attempt = 0; attempt < 3; attempt++) {
        if (await tableIsReady()) {
          schemaEnsured = true
          return true
        }
        await new Promise((resolve) => setTimeout(resolve, 300))
      }

      return false
    } catch (error) {
      console.warn('[scheme_parties] schema ensure failed:', errorText(error) || error)
      return false
    } finally {
      ensurePromise = null
    }
  })()

  return ensurePromise
}
