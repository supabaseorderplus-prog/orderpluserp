import { supabaseAdmin } from '@/lib/supabase-server'

/**
 * Manual scheme-progress overrides.
 *
 * Scheme progress is computed on read from payments/invoices (see
 * scheme-roster.ts / scheme-progress.ts). To let an admin manually bump a
 * party's progress (e.g. "set this retailer to 70%") WITHOUT that value being
 * wiped on the next recompute, we store an additive OFFSET — exactly like manual
 * wallet adjustments are folded into computeCurrentBalances.
 *
 * displayed_value = max(0, auto_computed_value + offset)
 *
 * The offset is `desired_value − auto_value_at_save_time`, so right after saving
 * the bar reads the desired value, and it keeps moving as the scheme's natural
 * metric (payments/invoices) grows. Latest note per (scheme_id, party_id) wins.
 */
export const SCHEME_ADJUST_NOTE_PREFIX = '__scheme_adjust__:'

export type SchemeAdjustNote = {
  scheme_id: string
  // The roster identity the offset applies to — a parties.id for real parties,
  // or the salesman's user id for salesman members.
  party_id: string
  offset: number
  created_at: string
  created_by?: string | null
  company_id?: string | null
  note?: string | null
}

export function buildSchemeAdjustNote(note: SchemeAdjustNote): string {
  return `${SCHEME_ADJUST_NOTE_PREFIX}${JSON.stringify(note)}`
}

export function parseSchemeAdjustNote(raw: string | null | undefined): SchemeAdjustNote | null {
  if (!raw || !raw.startsWith(SCHEME_ADJUST_NOTE_PREFIX)) return null
  try {
    const parsed = JSON.parse(raw.slice(SCHEME_ADJUST_NOTE_PREFIX.length)) as SchemeAdjustNote
    if (!parsed || typeof parsed !== 'object') return null
    if (!parsed.scheme_id || !parsed.party_id) return null
    const offset = Number(parsed.offset)
    if (!Number.isFinite(offset)) return null
    return {
      scheme_id: String(parsed.scheme_id),
      party_id: String(parsed.party_id),
      offset,
      created_at: String(parsed.created_at || new Date().toISOString()),
      created_by: parsed.created_by ?? null,
      company_id: parsed.company_id ?? null,
      note: parsed.note ?? null,
    }
  } catch {
    return null
  }
}

/**
 * Loads the latest manual offset note per (scheme_id, party_id) for the given
 * scheme(s). Scans the company_notes fallback once and de-dupes to the most
 * recent note. Fail-soft: returns [] on any error.
 */
export async function loadSchemeAdjustments(schemeIds: string[]): Promise<SchemeAdjustNote[]> {
  const wanted = new Set(schemeIds.filter(Boolean))
  if (wanted.size === 0) return []

  const { data, error } = await supabaseAdmin
    .from('company_notes')
    .select('note')
    .like('note', `${SCHEME_ADJUST_NOTE_PREFIX}%`)
    .limit(5000)

  if (error || !data) return []

  // Keep only the newest note per (scheme_id, party_id).
  const latest = new Map<string, SchemeAdjustNote>()
  for (const row of data as { note: string | null }[]) {
    const parsed = parseSchemeAdjustNote(row.note)
    if (!parsed || !wanted.has(parsed.scheme_id)) continue
    const key = `${parsed.scheme_id}:${parsed.party_id}`
    const existing = latest.get(key)
    if (!existing || parsed.created_at > existing.created_at) latest.set(key, parsed)
  }
  return [...latest.values()]
}

/** Latest offset per party_id for a single scheme, as a lookup map. */
export async function loadSchemeAdjustmentMap(schemeId: string): Promise<Map<string, number>> {
  const notes = await loadSchemeAdjustments([schemeId])
  const map = new Map<string, number>()
  for (const n of notes) map.set(n.party_id, n.offset)
  return map
}

/**
 * Persists a new manual offset for one (scheme, party). Each save inserts a fresh
 * note; loaders take the latest, so re-editing simply supersedes the prior value.
 */
export async function saveSchemeAdjustment(input: {
  schemeId: string
  partyId: string
  offset: number
  createdBy?: string | null
  companyId?: string | null
  note?: string | null
}): Promise<boolean> {
  const { error } = await supabaseAdmin.from('company_notes').insert({
    company_id: input.companyId ?? null,
    created_by: input.createdBy ?? null,
    note: buildSchemeAdjustNote({
      scheme_id: input.schemeId,
      party_id: input.partyId,
      offset: input.offset,
      created_at: new Date().toISOString(),
      created_by: input.createdBy ?? null,
      company_id: input.companyId ?? null,
      note: input.note ?? null,
    }),
  })
  return !error
}
