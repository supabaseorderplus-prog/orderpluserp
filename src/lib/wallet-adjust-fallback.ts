export const WALLET_ADJUST_NOTE_PREFIX = '__wallet_adjust__:'

export type WalletAdjustNote = {
  party_id: string
  delta: number
  type: string
  reference_type: string
  description: string
  created_at: string
  created_by?: string | null
  company_id?: string | null
  balance_after?: number | null
}

export function buildWalletAdjustNote(note: WalletAdjustNote): string {
  return `${WALLET_ADJUST_NOTE_PREFIX}${JSON.stringify(note)}`
}

export function parseWalletAdjustNote(raw: string | null | undefined): WalletAdjustNote | null {
  if (!raw || !raw.startsWith(WALLET_ADJUST_NOTE_PREFIX)) return null
  try {
    const parsed = JSON.parse(raw.slice(WALLET_ADJUST_NOTE_PREFIX.length)) as WalletAdjustNote
    if (!parsed || typeof parsed !== 'object') return null
    if (!parsed.party_id) return null
    const delta = Number(parsed.delta)
    if (!Number.isFinite(delta)) return null
    return {
      party_id: String(parsed.party_id),
      delta,
      type: String(parsed.type || 'BALANCE_ADJUSTMENT'),
      reference_type: String(parsed.reference_type || 'ADJUSTMENT'),
      description: String(parsed.description || ''),
      created_at: String(parsed.created_at || new Date().toISOString()),
      created_by: parsed.created_by ?? null,
      company_id: parsed.company_id ?? null,
      balance_after: parsed.balance_after == null ? null : Number(parsed.balance_after),
    }
  } catch {
    return null
  }
}
