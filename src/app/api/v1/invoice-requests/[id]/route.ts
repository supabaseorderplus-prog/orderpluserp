import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, getUserFromToken } from '@/lib/supabase-server'
import { markOrderDelivered, recomputeInvoiceSchemes } from '@/lib/invoice-confirm-effects'
import { revokeTokensForOrder } from '@/lib/order-approval-links'

// One confirmation, whichever channel the party uses. When the party confirms
// (or rejects) inside the app, kill any still-active WhatsApp approval link for
// the same order so it can't be confirmed a second time through the link. The
// reverse direction is already covered: confirming via the link is single-use
// (the token flips to APPROVED) and flips the invoice_request to CONFIRMED too.
// Best-effort: a failed revoke must not fail an already-committed confirmation,
// and the public link is idempotent so a stale link can never double-invoice.
async function terminateApprovalLink(orderId: string | null, companyId: string | null): Promise<void> {
  if (!orderId) return
  try {
    await revokeTokensForOrder(orderId, companyId, 'INVOICE')
  } catch (e) {
    console.warn('[invoice-confirm] failed to revoke WhatsApp approval link:', e instanceof Error ? e.message : e)
  }
}

const FALLBACK_PREFIX = 'SYSTEM_INVOICE_REQUEST::'

function fallbackNoteKey(id: string) {
  return `${FALLBACK_PREFIX}${id}`
}

function parseFallbackNote(note: string | null): Record<string, unknown> | null {
  if (!note || !note.startsWith(FALLBACK_PREFIX)) return null
  const json = note.slice(FALLBACK_PREFIX.length)
  try {
    return JSON.parse(json) as Record<string, unknown>
  } catch {
    return null
  }
}

async function updateFallbackRequest(id: string, updater: (current: Record<string, unknown>) => Record<string, unknown>) {
  const { data, error } = await supabaseAdmin
    .from('company_notes')
    .select('id, note')
    .like('note', `${FALLBACK_PREFIX}%`)
    .order('created_at', { ascending: false })

  if (error) throw error

  const row = (data || []).find((item) => {
    const parsed = parseFallbackNote((item as { note?: string | null }).note || null)
    return parsed && String(parsed.id || '') === id
  }) as { id: string; note: string | null } | undefined

  if (!row) return null

  const current = parseFallbackNote(row.note) || {}
  const next = updater(current)

  const { data: updatedRows, error: updateError } = await supabaseAdmin
    .from('company_notes')
    .update({ note: fallbackNoteKey(JSON.stringify(next)), updated_at: new Date().toISOString() })
    .eq('id', row.id)
    .eq('note', row.note)
    .select('id')

  if (updateError) throw updateError
  if (!updatedRows || updatedRows.length === 0) {
    throw new Error('Request already processed by another confirmation channel.')
  }
  return next
}

// PUT - confirm or reject an invoice request (party confirms delivery)
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const body = await req.json()
    const { status: newStatus, notes } = body

    if (!['CONFIRMED', 'REJECTED', 'PENDING'].includes(newStatus)) {
      return NextResponse.json({ success: false, message: 'Status must be CONFIRMED, REJECTED, or PENDING' }, { status: 400 })
    }

    const authUser = await getUserFromToken(req)
    const actorId = authUser?.app_user_id || authUser?.id || null

    // Re-initiate = resend a REJECTED invoice back to the party for confirmation.
    // Restricted to the company's ADMIN (own company only) and SUPER_ADMIN.
    const isReinitiate = newStatus === 'PENDING'
    const isAdmin = authUser?.role === 'ADMIN' || authUser?.role === 'SUPER_ADMIN'
    if (isReinitiate && !isAdmin) {
      return NextResponse.json(
        { success: false, message: 'Only an admin can re-initiate a rejected invoice.' },
        { status: 403 }
      )
    }

    // ── Primary path: invoice_request exists in the DB ────────────────────────
    // Fetch WITHOUT embedded join — order data fetched separately after confirm
    const { data: existing, error: fetchErr } = await supabaseAdmin
      .from('invoice_requests')
      .select('id, status, order_id, party_id, invoice_number, company_id')
      .eq('id', id)
      .single()

    if (!fetchErr && existing) {
      if (isReinitiate) {
        if (existing.status !== 'REJECTED') {
          return NextResponse.json({ success: false, message: 'Only a rejected invoice can be re-initiated.' }, { status: 400 })
        }
        // ADMIN may only re-initiate invoices that belong to their own company.
        if (authUser?.role === 'ADMIN' && existing.company_id && existing.company_id !== authUser.party_id) {
          return NextResponse.json({ success: false, message: 'You can only re-initiate invoices for your own company.' }, { status: 403 })
        }
      } else if (existing.status !== 'PENDING') {
        return NextResponse.json({ success: false, message: `Request already ${existing.status.toLowerCase()}` }, { status: 400 })
      }

      const updateData: Record<string, unknown> = isReinitiate
        ? {
            status: 'PENDING',
            updated_at: new Date().toISOString(),
            confirmed_by: null,
            confirmed_at: null,
          }
        : {
            status: newStatus,
            updated_at: new Date().toISOString(),
            confirmed_by: actorId,
            confirmed_at: new Date().toISOString(),
          }
      if (!isReinitiate && notes) updateData.notes = notes

      const { data, error } = await supabaseAdmin
        .from('invoice_requests')
        .update(updateData)
        .eq('id', id)
        .eq('status', isReinitiate ? 'REJECTED' : 'PENDING')
        .select()
        .maybeSingle()

      if (error) throw error
      if (!data) {
        const { data: latest } = await supabaseAdmin
          .from('invoice_requests')
          .select('id, status, order_id, party_id, invoice_number, company_id')
          .eq('id', id)
          .maybeSingle()

        // The other confirmation channel won the race. Treat the same final
        // state as success, but never let this request transition a second time.
        if (!isReinitiate && newStatus === 'CONFIRMED' && latest?.status === 'CONFIRMED') {
          await terminateApprovalLink(
            latest.order_id as string | null,
            (latest.company_id as string | null) ?? null,
          )
          return NextResponse.json({
            success: true,
            data: latest,
            message: 'Invoice was already confirmed and generated.',
          })
        }

        return NextResponse.json(
          { success: false, message: `Request already ${String(latest?.status || 'processed').toLowerCase()}` },
          { status: 409 },
        )
      }

      if (newStatus === 'CONFIRMED') {
        // The wallet debit is DERIVED from confirmed invoice requests by the
        // statement endpoint (see loadConfirmedInvoiceRequests) — this DB has no
        // persisted wallet ledger, so confirming only needs to flip the order to
        // DELIVERED. The deduction then appears wherever the wallet is read.
        const orderId = existing.order_id as string | null
        if (orderId) {
          await markOrderDelivered(orderId, '[invoice-confirm]')
        }
        recomputeInvoiceSchemes(
          existing.party_id as string | null,
          (existing.company_id as string | null) ?? null,
        )
      }

      // Confirm or reject in-app → immediately terminate the WhatsApp link.
      if (!isReinitiate) {
        await terminateApprovalLink(
          existing.order_id as string | null,
          (existing.company_id as string | null) ?? null,
        )
      }

      return NextResponse.json({
        success: true,
        data,
        message: isReinitiate
          ? 'Invoice re-initiated. Awaiting party confirmation.'
          : newStatus === 'CONFIRMED'
            ? 'Delivery confirmed! Invoice generated.'
            : 'Invoice request rejected.',
      })
    }

    // ── Fallback path: invoice_request stored in company_notes ────────────────
    const fallback = await updateFallbackRequest(id, (current) => {
      if (isReinitiate) {
        if (String(current.status || '') !== 'REJECTED') {
          throw new Error('Only a rejected invoice can be re-initiated.')
        }
        if (authUser?.role === 'ADMIN' && current.company_id && String(current.company_id) !== authUser.party_id) {
          throw new Error('You can only re-initiate invoices for your own company.')
        }
        return {
          ...current,
          status: 'PENDING',
          updated_at: new Date().toISOString(),
          confirmed_by: null,
          confirmed_at: null,
        }
      }
      if (String(current.status || '') !== 'PENDING') {
        throw new Error(`Request already ${String(current.status || '').toLowerCase()}`)
      }
      return {
        ...current,
        status: newStatus,
        updated_at: new Date().toISOString(),
        confirmed_by: actorId,
        confirmed_at: new Date().toISOString(),
        ...(notes ? { notes } : {}),
      }
    })

    if (!fallback) {
      return NextResponse.json({ success: false, message: 'Invoice request not found' }, { status: 404 })
    }

    if (newStatus === 'CONFIRMED') {
      // Wallet debit is derived from confirmed invoice requests on read; here we
      // only need to walk the order to DELIVERED.
      const orderId = fallback.order_id ? String(fallback.order_id) : null
      if (orderId) {
        await markOrderDelivered(orderId, '[invoice-confirm][fallback]')
      }
      recomputeInvoiceSchemes(
        fallback.party_id ? String(fallback.party_id) : null,
        fallback.company_id ? String(fallback.company_id) : null,
      )
    }

    // Confirm or reject in-app → immediately terminate the WhatsApp link.
    if (!isReinitiate) {
      await terminateApprovalLink(
        fallback.order_id ? String(fallback.order_id) : null,
        fallback.company_id ? String(fallback.company_id) : null,
      )
    }

    return NextResponse.json({
      success: true,
      data: fallback,
      message: isReinitiate
        ? 'Invoice re-initiated. Awaiting party confirmation.'
        : newStatus === 'CONFIRMED'
          ? 'Delivery confirmed! Invoice generated.'
          : 'Invoice request rejected.',
    })
  } catch (err) {
    console.error('[invoice-requests][PUT] failed:', err)
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed to update invoice request' },
      { status: 500 }
    )
  }
}
