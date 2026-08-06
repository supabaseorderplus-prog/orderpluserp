import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, getUserFromToken, resolveCompanyScope } from '@/lib/supabase-server'
import { getFallbackDeliveryLotsVersion } from '@/lib/delivery-lots-fallback'

/**
 * Cheap change-detection for delivery lots.
 *
 * The lots pages poll to stay in sync across devices. Polling the full list is
 * what pushed this project past its Supabase egress quota: every tick pulled
 * every lot row plus every linked order row (or, in company_notes fallback mode,
 * up to 5000 encoded lot blobs). This endpoint answers the only question a poll
 * actually asks — "has anything changed?" — with a row count and the newest
 * updated_at, so the expensive fetch only runs when the answer is yes.
 *
 * A null version means "couldn't tell"; the client then does a full fetch rather
 * than risk silently showing stale lots.
 */

const isMissingSchemaObject = (error: { code?: string; message?: string } | null | undefined) => {
  if (!error) return false
  const code = error.code || ''
  if (code === 'PGRST205' || code === '42P01' || code === 'PGRST200') return true
  return /relation .* does not exist|could not find the table/i.test(error.message || '')
}

export async function GET(req: NextRequest) {
  try {
    const authUser = await getUserFromToken(req)
    const companyId = await resolveCompanyScope(req, authUser)
    const isSuperAdmin = authUser?.role === 'SUPER_ADMIN'

    // Fail-closed, matching the list endpoint: no scope means no lots, so the
    // version is a constant and the client never fetches.
    if (!companyId && !isSuperAdmin) {
      return NextResponse.json({ success: true, version: 'empty' }, { headers: { 'Cache-Control': 'no-store' } })
    }

    let query = supabaseAdmin
      .from('delivery_lots')
      .select('updated_at', { count: 'exact' })
      .order('updated_at', { ascending: false })
      .limit(1)
    query = companyId ? query.eq('company_id', companyId) : query.is('company_id', null)

    const { data, count, error } = await query

    if (error && isMissingSchemaObject(error)) {
      const fallbackVersion = await getFallbackDeliveryLotsVersion(companyId)
      return NextResponse.json(
        { success: true, version: fallbackVersion },
        { headers: { 'Cache-Control': 'no-store' } },
      )
    }

    if (error) {
      // Unknown failure — report null so the client does a full fetch instead of
      // assuming nothing changed.
      console.warn('[delivery-lots version] degraded:', error)
      return NextResponse.json({ success: true, version: null }, { headers: { 'Cache-Control': 'no-store' } })
    }

    const newest = (data?.[0] as { updated_at?: string } | undefined)?.updated_at || ''
    return NextResponse.json(
      { success: true, version: `db:${count ?? 0}:${newest}` },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (err) {
    console.warn('[delivery-lots version] unexpected failure:', err)
    return NextResponse.json({ success: true, version: null }, { headers: { 'Cache-Control': 'no-store' } })
  }
}
