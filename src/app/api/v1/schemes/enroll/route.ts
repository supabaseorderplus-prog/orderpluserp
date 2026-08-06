import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, getUserFromToken, resolveCompanyScope } from '@/lib/supabase-server'
import {
  ensureSchemePartiesSchema,
  isSchemePartiesSchemaError,
  schemePartiesTableIsReady,
} from '@/lib/scheme-parties-schema'
import {
  encodeSchemeScopeTerms,
  normalizeSchemePartyType,
  parseSchemeScopeMeta,
} from '@/lib/scheme-scope'

type EnrolledPartyRow = {
  party_id: string
  parties: {
    id: string
    name: string | null
    party_code: string | null
    party_types?: { name?: string | null } | null
  } | null
}

type PartyLookupRow = {
  id: string
  name: string | null
  party_code: string | null
  party_types?: { name?: string | null } | { name?: string | null }[] | null
}

type UserLookupRow = {
  id: string
  name: string | null
  email: string | null
  party_id: string | null
}

function normalizePartyTypes(raw: PartyLookupRow['party_types']) {
  if (Array.isArray(raw)) return raw[0] ?? null
  return raw ?? null
}

async function resolveEnrollmentRowsByIds(ids: string[]): Promise<EnrolledPartyRow[]> {
  if (ids.length === 0) return []

  const [partyRes, userRes, appUserRes] = await Promise.all([
    supabaseAdmin.from('parties').select('id, name, party_code, party_types(name)').in('id', ids),
    supabaseAdmin.from('users').select('id, name, email, party_id').in('id', ids).then((r) => (r.error ? { data: [] } : r)),
    supabaseAdmin.from('app_users').select('id, name, email, party_id').in('id', ids).then((r) => (r.error ? { data: [] } : r)),
  ])

  const byId = new Map<string, EnrolledPartyRow['parties']>()

  for (const party of (partyRes.data || []) as PartyLookupRow[]) {
    byId.set(party.id, {
      id: party.id,
      name: party.name,
      party_code: party.party_code,
      party_types: normalizePartyTypes(party.party_types),
    })
  }

  for (const user of [
    ...(((userRes.data || []) as UserLookupRow[])),
    ...(((appUserRes.data || []) as UserLookupRow[])),
  ]) {
    if (byId.has(user.id)) continue
    byId.set(user.id, {
      id: user.id,
      name: user.name || user.email || 'Salesman',
      party_code: user.party_id,
      party_types: { name: 'SALESMAN' },
    })
  }

  return ids.map((partyId) => ({ party_id: partyId, parties: byId.get(partyId) ?? null }))
}

async function loadEnrollmentRows(schemeId: string): Promise<{ data: EnrolledPartyRow[]; error: unknown | null }> {
  const { data: rows, error } = await supabaseAdmin
    .from('scheme_parties')
    .select('party_id')
    .eq('scheme_id', schemeId)

  if (error) return { data: [], error }

  const ids = [...new Set((rows || []).map((row: { party_id?: string | null }) => row.party_id).filter(Boolean))] as string[]
  return { data: await resolveEnrollmentRowsByIds(ids), error: null }
}

async function persistEnrollmentNamesInScheme(schemeId: string, partyIds: string[]) {
  const { data: scheme, error } = await supabaseAdmin
    .from('schemes')
    .select('terms_conditions, applicable_party_type')
    .eq('id', schemeId)
    .maybeSingle()
  if (error || !scheme) return false

  const rows = await resolveEnrollmentRowsByIds(partyIds)
  const namesToAdd = rows
    .map((row) => row.parties?.name)
    .filter((name): name is string => Boolean(name?.trim()))
  if (namesToAdd.length === 0) return false

  const scope = parseSchemeScopeMeta(scheme.terms_conditions, scheme.applicable_party_type)
  const existingNames = scope.partyNames.length > 0 ? scope.partyNames : []
  const allNames = [...existingNames]
  const seen = new Set(existingNames.map((name) => name.trim().toLowerCase()))
  for (const name of namesToAdd) {
    const key = name.trim().toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    allNames.push(name)
  }

  const individualPartyType =
    scope.individualPartyType ||
    normalizeSchemePartyType(rows.some((row) => row.parties?.party_types?.name === 'SALESMAN') ? 'SALESMAN' : null)
  const applicablePartyType = normalizeSchemePartyType(scope.applicablePartyType) || 'INDIVIDUAL'

  const { error: updateErr } = await supabaseAdmin
    .from('schemes')
    .update({
      terms_conditions: encodeSchemeScopeTerms({
        termsConditions: scope.termsConditions,
        mode: 'INDIVIDUAL',
        applicablePartyType,
        individualPartyType: individualPartyType || null,
        partyNames: allNames,
      }),
    })
    .eq('id', schemeId)

  return !updateErr
}

async function loadFallbackEnrollmentRowsFromScheme(schemeId: string): Promise<EnrolledPartyRow[]> {
  const { data: scheme } = await supabaseAdmin
    .from('schemes')
    .select('terms_conditions, applicable_party_type')
    .eq('id', schemeId)
    .maybeSingle()

  const scope = parseSchemeScopeMeta(scheme?.terms_conditions, scheme?.applicable_party_type)
  return scope.partyNames.map((name) => ({
    party_id: name,
    parties: {
      id: name,
      name,
      party_code: null,
      party_types: scope.individualPartyType ? { name: scope.individualPartyType } : null,
    },
  }))
}

// POST /api/v1/schemes/enroll
// Enroll one or more specific parties into a scheme (individual targeting)
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { scheme_id, party_ids } = body

    if (!scheme_id || !Array.isArray(party_ids) || party_ids.length === 0) {
      return NextResponse.json(
        { success: false, message: 'scheme_id and party_ids[] required' },
        { status: 400 },
      )
    }

    const authUser = await getUserFromToken(req)
    const companyId = await resolveCompanyScope(req, authUser)

    // Verify scheme belongs to company — fail closed if company can't be determined
    if (!companyId && authUser?.role !== 'SUPER_ADMIN') {
      return NextResponse.json({ success: false, message: 'Scheme not found' }, { status: 404 })
    }
    if (companyId) {
      const { data: scheme } = await supabaseAdmin
        .from('schemes')
        .select('company_id')
        .eq('id', scheme_id)
        .maybeSingle()
      if (!scheme || scheme.company_id !== companyId) {
        return NextResponse.json({ success: false, message: 'Scheme not found' }, { status: 404 })
      }
    }

    const tableReady = await schemePartiesTableIsReady()
    if (!tableReady) {
      if (await persistEnrollmentNamesInScheme(scheme_id, party_ids)) {
        return NextResponse.json({ success: true, enrolled: party_ids.length, persisted_via: 'scheme_scope' })
      }
      const schemaReady = await ensureSchemePartiesSchema()
      if (schemaReady) {
        const retry = await supabaseAdmin
          .from('scheme_parties')
          .insert(party_ids.map((pid: string) => ({ scheme_id, party_id: pid })))
        if (!retry.error) return NextResponse.json({ success: true, enrolled: party_ids.length })
      }
      return NextResponse.json(
        { success: false, message: 'scheme_parties table unavailable. The app could not create the enrollment table automatically.' },
        { status: 500 },
      )
    }

    // Remove any existing enrollment for these parties first, then insert fresh
    const { error: delErr } = await supabaseAdmin
      .from('scheme_parties')
      .delete()
      .eq('scheme_id', scheme_id)
      .in('party_id', party_ids)

    if (delErr) {
      console.warn('[enroll] delete step error (non-fatal):', JSON.stringify(delErr))
    }

    const inserts = party_ids.map((pid: string) => ({ scheme_id, party_id: pid }))
    const { error: insertErr } = await supabaseAdmin
      .from('scheme_parties')
      .insert(inserts)

    if (insertErr) {
      if (isSchemePartiesSchemaError(insertErr) && await ensureSchemePartiesSchema()) {
        const retry = await supabaseAdmin.from('scheme_parties').insert(inserts)
        if (!retry.error) return NextResponse.json({ success: true, enrolled: party_ids.length })
      }
      if (isSchemePartiesSchemaError(insertErr) && await persistEnrollmentNamesInScheme(scheme_id, party_ids)) {
        return NextResponse.json({ success: true, enrolled: party_ids.length, persisted_via: 'scheme_scope' })
      }
      const msg = insertErr.message || insertErr.details || insertErr.hint || JSON.stringify(insertErr)
      console.error('[enroll] insert error:', msg)
      return NextResponse.json({ success: false, message: msg }, { status: 500 })
    }

    return NextResponse.json({ success: true, enrolled: party_ids.length })
  } catch (err) {
    const msg =
      err instanceof Error
        ? err.message
        : (err as { message?: string; details?: string })?.message ||
          (err as { message?: string; details?: string })?.details ||
          JSON.stringify(err) ||
          'Failed to enroll parties'
    console.error('[enroll] caught:', msg)
    return NextResponse.json({ success: false, message: msg }, { status: 500 })
  }
}

// GET /api/v1/schemes/enroll?scheme_id=xxx
// Returns parties individually enrolled in a scheme
export async function GET(req: NextRequest) {
  try {
    const schemeId = new URL(req.url).searchParams.get('scheme_id')
    if (!schemeId) {
      return NextResponse.json({ success: false, message: 'scheme_id required' }, { status: 400 })
    }

    if (!(await schemePartiesTableIsReady())) {
      return NextResponse.json({ success: true, data: await loadFallbackEnrollmentRowsFromScheme(schemeId) })
    }

    const { data, error } = await loadEnrollmentRows(schemeId)

    if (error) {
      if (isSchemePartiesSchemaError(error)) {
        return NextResponse.json({ success: true, data: await loadFallbackEnrollmentRowsFromScheme(schemeId) })
      }
      const message = error instanceof Error ? error.message : 'Failed to fetch enrollments'
      console.error('[enroll GET]', error)
      return NextResponse.json({ success: false, message }, { status: 500 })
    }

    return NextResponse.json({ success: true, data })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed to fetch enrollments' },
      { status: 500 },
    )
  }
}

// DELETE /api/v1/schemes/enroll?scheme_id=xxx&party_id=yyy
// Remove individual party from scheme
export async function DELETE(req: NextRequest) {
  try {
    const url = new URL(req.url)
    const schemeId = url.searchParams.get('scheme_id')
    const partyId = url.searchParams.get('party_id')

    if (!schemeId || !partyId) {
      return NextResponse.json({ success: false, message: 'scheme_id and party_id required' }, { status: 400 })
    }

    if (!(await schemePartiesTableIsReady())) {
      return NextResponse.json(
        { success: false, message: 'scheme_parties table unavailable. The app could not create the enrollment table automatically.' },
        { status: 500 },
      )
    }

    const { error } = await supabaseAdmin
      .from('scheme_parties')
      .delete()
      .eq('scheme_id', schemeId)
      .eq('party_id', partyId)

    if (error) throw error

    return NextResponse.json({ success: true })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed to remove enrollment' },
      { status: 500 },
    )
  }
}
