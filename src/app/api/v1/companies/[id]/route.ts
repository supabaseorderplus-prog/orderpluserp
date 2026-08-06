import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, getUserFromToken } from '@/lib/supabase-server'

// PUT /api/v1/companies/[id]
// Updates a company (party) record, handling both old (phone/email/address)
// and new (contact_phone/contact_email/city) column layouts.
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const caller = await getUserFromToken(req)
  if (!caller || caller.role !== 'SUPER_ADMIN') {
    return NextResponse.json({ success: false, message: 'Forbidden' }, { status: 403 })
  }

  const { id } = await params

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ success: false, message: 'Invalid JSON' }, { status: 400 })
  }

  const { name, contact_phone, contact_email, city, gstin } = body as {
    name?: string
    contact_phone?: string
    contact_email?: string
    city?: string
    gstin?: string
  }

  if (!name || !String(name).trim()) {
    return NextResponse.json({ success: false, message: 'Name is required' }, { status: 400 })
  }

  // Verify the party exists before trying to update
  const { data: existing, error: findErr } = await supabaseAdmin
    .from('parties')
    .select('id')
    .eq('id', id)
    .single()

  if (findErr || !existing) {
    return NextResponse.json({ success: false, message: 'Company not found' }, { status: 404 })
  }

  // Try updating with new-style columns first (contact_phone / contact_email / city),
  // then fall back to old-style (phone / email / address).
  // We probe by attempting each layout; a column-not-found error has code '42703'.
  const newStyleUpdate = {
    name: String(name).trim(),
    ...(contact_phone !== undefined ? { contact_phone: contact_phone ?? null } : {}),
    ...(contact_email !== undefined ? { contact_email: contact_email ?? null } : {}),
    ...(city !== undefined ? { city: city ?? null } : {}),
    ...(gstin !== undefined ? { gstin: gstin ?? null } : {}),
  }

  const oldStyleUpdate = {
    name: String(name).trim(),
    ...(contact_phone !== undefined ? { phone: contact_phone ?? null } : {}),
    ...(contact_email !== undefined ? { email: contact_email ?? null } : {}),
    ...(city !== undefined ? { address: city ?? null } : {}),
    ...(gstin !== undefined ? { gstin: gstin ?? null } : {}),
  }

  // Try new-style first
  const { data: newResult, error: newErr } = await supabaseAdmin
    .from('parties')
    .update(newStyleUpdate)
    .eq('id', id)
    .select('id, name')
    .single()

  if (!newErr) {
    return NextResponse.json({ success: true, data: newResult, message: 'Company updated' })
  }

  // If it was a column-not-found error, fall back to old-style columns
  if ((newErr as { code?: string }).code === '42703') {
    const { data: oldResult, error: oldErr } = await supabaseAdmin
      .from('parties')
      .update(oldStyleUpdate)
      .eq('id', id)
      .select('id, name')
      .single()

    if (!oldErr) {
      return NextResponse.json({ success: true, data: oldResult, message: 'Company updated' })
    }

    console.error('[company PUT] old-style update failed:', oldErr)
    return NextResponse.json(
      { success: false, message: oldErr.message || 'Update failed' },
      { status: 500 }
    )
  }

  console.error('[company PUT] new-style update failed:', newErr)
  return NextResponse.json(
    { success: false, message: newErr.message || 'Update failed' },
    { status: 500 }
  )
}
