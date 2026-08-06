import { supabaseAdmin } from '@/lib/supabase-server'

/**
 * Per-party invoice-approval "kill switch".
 *
 * When ON  (default): an invoice initiated for the party creates a PENDING
 *                      invoice request the party must confirm before generation.
 * When OFF:            an invoice initiated for the party is auto-confirmed
 *                      immediately — no approval, the invoice generates on the
 *                      spot. The switch is independent per party: one party of a
 *                      company can require approval while another auto-generates.
 *
 * Stored as a marker row in company_notes (no dedicated settings table on this
 * deployment), keyed by party_id, following the SYSTEM_* marker pattern. The
 * value lives in the note suffix: `${PREFIX}${partyId}::ON|OFF`.
 */

const PREFIX = 'SYSTEM_INVOICE_APPROVAL_SWITCH::'

function markerPrefix(partyId: string): string {
  return `${PREFIX}${partyId}::`
}

function parsePartyIdFromNote(note: string): string | null {
  if (!note.startsWith(PREFIX)) return null
  const rest = note.slice(PREFIX.length)
  const sep = rest.lastIndexOf('::')
  if (sep <= 0) return null
  return rest.slice(0, sep)
}

/**
 * Whether party approval is required before an invoice is generated for this
 * party. Defaults to `true` (approval required) when no marker has been set.
 */
export async function isInvoiceApprovalRequiredForParty(partyId: string | null): Promise<boolean> {
  if (!partyId) return true
  const prefix = markerPrefix(partyId)
  try {
    const { data, error } = await supabaseAdmin
      .from('company_notes')
      .select('note')
      .like('note', `${prefix}%`)
      .order('updated_at', { ascending: false })
      .limit(1)

    if (error || !data?.length) return true

    const note = String((data[0] as { note?: string }).note || '')
    const value = note.slice(prefix.length).trim().toUpperCase()
    // Only an explicit OFF disables approval; anything else stays safe (ON).
    return value !== 'OFF'
  } catch {
    // Fail safe: if the setting can't be read, keep approval required.
    return true
  }
}

/**
 * Persist the kill-switch state for one party. Replaces any existing marker.
 */
export async function setInvoiceApprovalRequiredForParty(
  partyId: string,
  required: boolean,
  companyId: string | null,
  userId: string | null,
): Promise<void> {
  const prefix = markerPrefix(partyId)

  await supabaseAdmin
    .from('company_notes')
    .delete()
    .like('note', `${prefix}%`)

  await supabaseAdmin
    .from('company_notes')
    .insert({
      company_id: companyId,
      note: `${prefix}${required ? 'ON' : 'OFF'}`,
      created_by: userId,
    })
}

/**
 * Returns the set of party IDs whose approval kill switch is OFF
 * (auto-generate). Approval is required by default, so only the OFF markers
 * need to be enumerated. Scoped to a company when provided.
 */
export async function getPartiesWithApprovalDisabled(companyId: string | null): Promise<string[]> {
  try {
    let query = supabaseAdmin
      .from('company_notes')
      .select('note, company_id')
      .like('note', `${PREFIX}%`)
      .limit(5000)

    if (companyId) query = query.eq('company_id', companyId)

    const { data, error } = await query
    if (error || !data?.length) return []

    const disabled = new Set<string>()
    for (const row of data as { note?: string }[]) {
      const note = String(row.note || '')
      const value = note.slice(note.lastIndexOf('::') + 2).trim().toUpperCase()
      if (value !== 'OFF') continue
      const partyId = parsePartyIdFromNote(note)
      if (partyId) disabled.add(partyId)
    }
    return [...disabled]
  } catch {
    return []
  }
}
