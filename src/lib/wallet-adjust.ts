import { supabaseAdmin } from '@/lib/supabase-server'
import { runDirectSql } from '@/lib/direct-sql'
import { computeCurrentBalances } from '@/lib/party-balance'
import { buildWalletAdjustNote } from '@/lib/wallet-adjust-fallback'

type DbError = { code?: string; message?: string; details?: string } | null | undefined

function isMissingSchemaPiece(error: DbError, column?: string): boolean {
  if (!error) return false
  const text = `${error.message || ''} ${error.details || ''}`.toLowerCase()
  return (
    error.code === '42P01' ||
    error.code === '42703' ||
    error.code === 'PGRST200' ||
    error.code === 'PGRST204' ||
    error.code === 'PGRST205' ||
    text.includes('schema cache') ||
    text.includes('could not find') ||
    (column ? text.includes(column.toLowerCase()) : text.includes('column'))
  )
}

function sqlLiteral(value: string) {
  return `'${value.replace(/'/g, "''")}'`
}

function sqlNullableText(value: unknown) {
  if (value === null || value === undefined || value === '') return 'NULL'
  return sqlLiteral(String(value))
}

function sqlNullableUuid(value: unknown) {
  if (typeof value !== 'string') return 'NULL'
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? sqlLiteral(value)
    : 'NULL'
}

function sqlNumber(value: number) {
  return Number.isFinite(value) ? String(value) : '0'
}

async function ensureWalletSchema(): Promise<boolean> {
  const sql = `
    ALTER TABLE public.parties ADD COLUMN IF NOT EXISTS wallet_balance FLOAT NOT NULL DEFAULT 0;
    CREATE TABLE IF NOT EXISTS public.wallet_transactions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      party_id UUID NOT NULL,
      type TEXT NOT NULL,
      amount FLOAT NOT NULL DEFAULT 0,
      balance_after FLOAT,
      reference_id TEXT,
      reference_type TEXT,
      description TEXT,
      created_by UUID,
      company_id UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_wallet_transactions_party_created
      ON public.wallet_transactions(party_id, created_at DESC);
    NOTIFY pgrst, 'reload schema';
  `
  const { error } = await supabaseAdmin.rpc('exec_sql', { sql })
  if (!error) return true
  return runDirectSql(sql)
}

export interface WalletAdjustResult {
  ok: boolean
  status: number
  message?: string
  newBalance?: number
  partyName?: string
}

export interface WalletAdjustInput {
  partyId: string
  delta: number
  type: string
  referenceType: string
  description: string
  createdBy?: string | null
  companyId?: string | null
}

async function updatePartyWalletBalanceDirect(partyId: string, walletBalance: number): Promise<boolean> {
  const sql = `
    UPDATE public.parties
    SET wallet_balance = ${sqlNumber(walletBalance)}
    WHERE id = ${sqlLiteral(partyId)};
  `
  return runDirectSql(sql)
}

async function insertWalletAdjustmentNote(input: {
  partyId: string
  type: string
  delta: number
  newBalanceAfter: number
  referenceType: string
  description: string
  createdBy?: string | null
  companyId?: string | null
}): Promise<boolean> {
  const { error } = await supabaseAdmin.from('company_notes').insert({
    company_id: input.companyId ?? null,
    created_by: input.createdBy ?? null,
    note: buildWalletAdjustNote({
      party_id: input.partyId,
      delta: input.delta,
      type: input.type,
      reference_type: input.referenceType,
      description: input.description,
      created_at: new Date().toISOString(),
      created_by: input.createdBy ?? null,
      company_id: input.companyId ?? null,
      balance_after: input.newBalanceAfter,
    }),
  })
  return !error
}

async function insertWalletTransactionDirect(input: {
  partyId: string
  type: string
  delta: number
  newBalanceAfter: number
  referenceType: string
  description: string
  createdBy?: string | null
  companyId?: string | null
}): Promise<boolean> {
  const sql = `
    INSERT INTO public.wallet_transactions (
      party_id, type, amount, balance_after, reference_id, reference_type, description, created_by, company_id
    ) VALUES (
      ${sqlLiteral(input.partyId)},
      ${sqlLiteral(input.type)},
      ${sqlNumber(input.delta)},
      ${sqlNumber(input.newBalanceAfter)},
      NULL,
      ${sqlLiteral(input.referenceType)},
      ${sqlNullableText(input.description)},
      ${sqlNullableUuid(input.createdBy)},
      ${sqlNullableUuid(input.companyId)}
    );
  `
  return runDirectSql(sql)
}

export async function adjustWallet(input: WalletAdjustInput): Promise<WalletAdjustResult> {
  const { partyId, delta, type, referenceType, description, createdBy = null, companyId = null } = input

  const { data: party, error: partyErr } = await supabaseAdmin
    .from('parties')
    .select('name, opening_balance')
    .eq('id', partyId)
    .single()

  if (partyErr || !party) {
    if (partyErr && isMissingSchemaPiece(partyErr)) {
      return { ok: false, status: 500, message: partyErr.message }
    }
    return { ok: false, status: 404, message: 'Party not found' }
  }

  const opening = Number((party as { opening_balance?: number | string | null }).opening_balance ?? 0)
  const currentTotals = await computeCurrentBalances([{ id: partyId, opening_balance: opening }])
  const currentTotal = currentTotals[partyId] ?? opening
  const newTotal = currentTotal + delta
  const newBalanceAfter = newTotal - opening

  await ensureWalletSchema()

  const { error: updateErr } = await supabaseAdmin
    .from('parties')
    .update({ wallet_balance: newBalanceAfter })
    .eq('id', partyId)

  if (updateErr) {
    if (isMissingSchemaPiece(updateErr, 'wallet_balance')) {
      await updatePartyWalletBalanceDirect(partyId, newBalanceAfter)
    } else {
      return { ok: false, status: 500, message: updateErr.message }
    }
  }

  const { error: txnErr } = await supabaseAdmin.from('wallet_transactions').insert({
    party_id: partyId,
    type,
    amount: delta,
    balance_after: newBalanceAfter,
    reference_id: null,
    reference_type: referenceType,
    description,
    created_by: createdBy,
    company_id: companyId,
  })

  if (txnErr) {
    if (isMissingSchemaPiece(txnErr) || isMissingSchemaPiece(txnErr, 'company_id')) {
      let inserted = await insertWalletTransactionDirect({
        partyId,
        type,
        delta,
        newBalanceAfter,
        referenceType,
        description,
        createdBy,
        companyId,
      })
      if (!inserted) {
        inserted = await insertWalletAdjustmentNote({
          partyId,
          type,
          delta,
          newBalanceAfter,
          referenceType,
          description,
          createdBy,
          companyId,
        })
      }
      if (!inserted) return { ok: false, status: 500, message: txnErr.message }
    } else {
      return { ok: false, status: 500, message: txnErr.message }
    }
  }

  return { ok: true, status: 200, newBalance: newTotal, partyName: (party as { name?: string } | null)?.name }
}
