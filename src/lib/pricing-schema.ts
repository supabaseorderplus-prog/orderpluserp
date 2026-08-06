import { runDirectSql } from '@/lib/direct-sql'
import { supabaseAdmin } from '@/lib/supabase-server'

type DbErrorLike = { code?: string; message?: string; details?: string; hint?: string } | null | undefined

let pricingSchemaEnsured = false

const SCHEMA_ERROR_CODES = new Set(['42P01', '42703', 'PGRST200', 'PGRST204'])

const PRICING_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS public.price_lists (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID,
    name TEXT NOT NULL,
    code TEXT NOT NULL,
    applicable_party_type TEXT NOT NULL,
    party_id UUID,
    group_id UUID,
    valid_from DATE NOT NULL DEFAULT CURRENT_DATE,
    valid_to DATE,
    is_current BOOLEAN NOT NULL DEFAULT true,
    notes TEXT,
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS public.price_list_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    price_list_id UUID NOT NULL REFERENCES public.price_lists(id) ON DELETE CASCADE,
    product_id UUID,
    unit_price NUMERIC(12,2) NOT NULL DEFAULT 0,
    min_margin_floor NUMERIC(12,2),
    max_margin_ceiling NUMERIC(12,2),
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS public.td_config (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID,
    party_id UUID,
    applicable_party_type TEXT NOT NULL,
    td_percent NUMERIC(7,3) NOT NULL DEFAULT 0,
    valid_from DATE NOT NULL DEFAULT CURRENT_DATE,
    valid_to DATE,
    notes TEXT,
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS public.cd_config (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID,
    party_id UUID,
    applicable_party_type TEXT NOT NULL,
    cd_percent NUMERIC(7,3) NOT NULL DEFAULT 0,
    valid_from DATE NOT NULL DEFAULT CURRENT_DATE,
    valid_to DATE,
    notes TEXT,
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  ALTER TABLE public.price_lists ADD COLUMN IF NOT EXISTS company_id UUID;
  ALTER TABLE public.price_lists ADD COLUMN IF NOT EXISTS group_id UUID;
  ALTER TABLE public.price_lists ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'ACTIVE';
  ALTER TABLE public.price_lists ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now();
  ALTER TABLE public.price_lists ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

  ALTER TABLE public.price_list_items ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'ACTIVE';
  ALTER TABLE public.price_list_items ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now();
  ALTER TABLE public.price_list_items ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

  ALTER TABLE public.td_config ADD COLUMN IF NOT EXISTS company_id UUID;
  ALTER TABLE public.td_config ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'ACTIVE';
  ALTER TABLE public.td_config ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now();
  ALTER TABLE public.td_config ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

  ALTER TABLE public.cd_config ADD COLUMN IF NOT EXISTS company_id UUID;
  ALTER TABLE public.cd_config ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'ACTIVE';
  ALTER TABLE public.cd_config ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now();
  ALTER TABLE public.cd_config ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

  CREATE INDEX IF NOT EXISTS idx_price_lists_company_id ON public.price_lists(company_id);
  CREATE INDEX IF NOT EXISTS idx_price_lists_group_id ON public.price_lists(group_id);
  CREATE INDEX IF NOT EXISTS idx_price_lists_status ON public.price_lists(status);
  CREATE INDEX IF NOT EXISTS idx_price_list_items_price_list_id ON public.price_list_items(price_list_id);
  CREATE INDEX IF NOT EXISTS idx_td_config_company_id ON public.td_config(company_id);
  CREATE INDEX IF NOT EXISTS idx_td_config_status ON public.td_config(status);
  CREATE INDEX IF NOT EXISTS idx_cd_config_company_id ON public.cd_config(company_id);
  CREATE INDEX IF NOT EXISTS idx_cd_config_status ON public.cd_config(status);

  NOTIFY pgrst, 'reload schema';
`

const PRICING_SCHEMA_WAIT_MS = [0, 150, 400, 900]

function errorText(err: DbErrorLike): string {
  return `${err?.code || ''} ${err?.message || ''} ${err?.details || ''} ${err?.hint || ''}`.toLowerCase()
}

export function isPricingSchemaGap(err: DbErrorLike): boolean {
  if (!err) return false
  if (err.code && SCHEMA_ERROR_CODES.has(err.code)) return true

  const text = errorText(err)
  return (
    text.includes('schema cache') ||
    text.includes('does not exist') ||
    text.includes('relation') ||
    text.includes('could not find') ||
    text.includes('column')
  )
}

export function isMissingCompanyIdColumn(err: DbErrorLike): boolean {
  const text = errorText(err)
  return text.includes('company_id') && isPricingSchemaGap(err)
}

export const PRICING_SCHEMA_NOT_READY_MESSAGE =
  'Pricing schema is not ready yet for company-scoped pricing. Please run pricing migration once.'

async function hasPricingSchema(): Promise<boolean> {
  try {
    const { error: listError } = await supabaseAdmin.from('price_lists').select('id').limit(1)
    if (listError) return false
    const { error: itemError } = await supabaseAdmin.from('price_list_items').select('id').limit(1)
    return !itemError
  } catch {
    return false
  }
}

async function waitForPricingSchema(): Promise<boolean> {
  for (const delayMs of PRICING_SCHEMA_WAIT_MS) {
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))
    if (await hasPricingSchema()) return true
  }
  return false
}

export async function ensurePricingSchema(): Promise<void> {
  if (pricingSchemaEnsured) return

  if (await waitForPricingSchema()) {
    pricingSchemaEnsured = true
    return
  }

  try {
    const directOk = await runDirectSql(PRICING_SCHEMA_SQL)
    if (!directOk) {
      const probe = await supabaseAdmin.rpc('exec_sql', { sql: 'SELECT 1;' })
      if (!probe.error) {
        const { error } = await supabaseAdmin.rpc('exec_sql', { sql: PRICING_SCHEMA_SQL })
        if (error) {
          console.warn('[ensurePricingSchema] exec_sql migration failed:', error.message)
        }
      } else {
        console.warn('[ensurePricingSchema] exec_sql unavailable:', probe.error?.message)
      }
    }

    pricingSchemaEnsured = await waitForPricingSchema()
  } catch (e) {
    console.error('[ensurePricingSchema] migration failed:', e)
  }
}
