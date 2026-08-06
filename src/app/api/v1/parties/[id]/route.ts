import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, getUserFromToken, resolveCompanyScope, getPartyDescendants } from '@/lib/supabase-server'
import { loadConfirmedInvoiceRequests } from '@/lib/invoice-requests-source'
import { computeCurrentBalances } from '@/lib/party-balance'
import { ensureGroupsSchema, hasGroupsSchema } from '@/lib/groups'
import { listFallbackGroups, updateFallbackGroup } from '@/lib/groups-fallback'

const TAX_TEMPLATE_NOTE_PREFIX = 'SYSTEM_DEFAULT_TAX_TEMPLATE::'

async function syncPartyGroupAssignment(params: {
  partyId: string
  groupId: string | null
  companyId: string | null
  authUser: { id?: string | null; app_user_id?: string | null; role?: string | null } | null
}) {
  const { partyId, groupId, companyId, authUser } = params
  await ensureGroupsSchema()

  if (!(await hasGroupsSchema())) {
    const groups = await listFallbackGroups(companyId)
    const target = groupId ? groups.find(group => group.id === groupId && group.status !== 'DELETED') : null
    if (groupId && !target) throw new Error('Selected group was not found in this company')
    if (target && authUser?.role === 'SALESMAN' && ![authUser.id, authUser.app_user_id].includes(target.salesman_id)) {
      throw new Error('You can only assign parties to one of your own groups')
    }

    for (const group of groups) {
      const hasParty = group.member_ids.includes(partyId)
      const shouldHaveParty = group.id === groupId
      if (hasParty === shouldHaveParty) continue
      await updateFallbackGroup(group.id, companyId, {
        member_ids: shouldHaveParty
          ? [...group.member_ids.filter(id => id !== partyId), partyId]
          : group.member_ids.filter(id => id !== partyId),
      })
    }
    return
  }

  if (groupId) {
    const { data: target, error } = await supabaseAdmin
      .from('groups')
      .select('id, company_id, salesman_id, status')
      .eq('id', groupId)
      .maybeSingle()
    if (error) throw error
    if (!target || target.status === 'DELETED' || (companyId && target.company_id && target.company_id !== companyId)) {
      throw new Error('Selected group was not found in this company')
    }
    if (authUser?.role === 'SALESMAN' && ![authUser.id, authUser.app_user_id].includes(target.salesman_id)) {
      throw new Error('You can only assign parties to one of your own groups')
    }
  }

  const { error: clearError } = await supabaseAdmin.from('group_members').delete().eq('party_id', partyId)
  if (clearError) throw clearError
  if (groupId) {
    const { error: insertError } = await supabaseAdmin.from('group_members').insert({ group_id: groupId, party_id: partyId })
    if (insertError) throw insertError
  }
}

async function persistTaxTemplateFallback(
  companyId: string,
  partyId: string,
  templateId: string | null,
  userId: string | null
) {
  const markerPrefix = `${TAX_TEMPLATE_NOTE_PREFIX}${partyId}::`
  await supabaseAdmin
    .from('company_notes')
    .delete()
    .eq('company_id', companyId)
    .like('note', `${markerPrefix}%`)

  if (!templateId) return

  await supabaseAdmin
    .from('company_notes')
    .insert({
      company_id: companyId,
      note: `${markerPrefix}${templateId}`,
      created_by: userId,
    })
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params

    const authUser = await getUserFromToken(req)
    const companyId = await resolveCompanyScope(req, authUser)

    const { data, error } = await supabaseAdmin
      .from('parties')
      .select(`
        *,
        party_types(name, level_order),
        parent_party:parties!parent_party_id(id, name, party_code)
      `)
      .eq('id', id)
      .single()

    if (error) throw error
    if (!data) {
      return NextResponse.json({ success: false, message: 'Party not found' }, { status: 404 })
    }

    // Verify company access
    // Allow access if: party is the company itself (id matches companyId) OR party belongs to the company
    if (companyId && data.id !== companyId) {
      const tree = await getPartyDescendants(companyId)
      const treeIds = tree && tree.length > 0 ? tree.map((r: { id: string }) => r.id) : []
      if (!treeIds.includes(companyId)) treeIds.push(companyId)
      if (!treeIds.includes(data.id)) {
        return NextResponse.json({ success: false, message: 'Party not found or access denied' }, { status: 403 })
      }
    }

    const openingBalance = Number((data as { opening_balance?: number | string | null }).opening_balance ?? 0)

    // Every read below is independent, so fire them all at once instead of as a
    // sequential await chain — this is what made "Loading party history" crawl.
    // computeCurrentBalances derives the authoritative wallet balance and depends
    // on none of the others, so it joins the same batch (it fails soft to the
    // local payments-minus-invoices derivation computed further down).
    const [
      outstandingRes,
      tdRes,
      cdRes,
      secRes,
      allInvoicesRes,
      paymentsRes,
      derivedBalances,
    ] = await Promise.all([
      // Outstanding summary + recent unpaid invoices.
      supabaseAdmin
        .from('invoices')
        .select('id, invoice_number, invoice_date, grand_total, amount_paid, amount_outstanding, aging_bucket, aging_days, payment_status, due_date')
        .eq('billing_party_id', id)
        .in('payment_status', ['UNPAID', 'PARTIAL'])
        .eq('is_cancelled', false)
        .order('invoice_date', { ascending: false }),
      // TD balance
      supabaseAdmin.from('td_ledger').select('balance').eq('party_id', id).order('created_at', { ascending: false }).limit(1),
      // CD balance
      supabaseAdmin.from('cd_ledger').select('balance').eq('party_id', id).order('created_at', { ascending: false }).limit(1),
      // Security balance
      supabaseAdmin.from('security_ledger').select('balance').eq('party_id', id).order('created_at', { ascending: false }).limit(1),
      // Total invoiced (all time).
      supabaseAdmin.from('invoices').select('grand_total, amount_paid, invoice_number').eq('billing_party_id', id).eq('is_cancelled', false),
      // Payments (receipts) credit the wallet. wallet_transactions/wallet_balance
      // don't exist in this schema, so the live balance must be derived from here.
      supabaseAdmin.from('payments').select('amount, status').eq('party_id', id),
      // Authoritative current balance (payments − invoices − confirmed requests +
      // manual adjustments). Fail soft so a balance hiccup never blocks the page.
      computeCurrentBalances([{ id, opening_balance: openingBalance }]).catch((e) => {
        console.warn('[parties/:id] computeCurrentBalances failed, using local derivation:', e instanceof Error ? e.message : e)
        return {} as Record<string, number>
      }),
    ])

    const outstanding = outstandingRes.data
    const tdBal = tdRes.data
    const cdBal = cdRes.data
    const secBal = secRes.data

    const outstandingTotal = outstanding?.reduce((sum, inv) => sum + Number(inv.amount_outstanding), 0) || 0
    const agingBreakdown = {
      CURRENT: 0, BUCKET_1: 0, BUCKET_2: 0, BUCKET_3: 0, BUCKET_4: 0,
    }
    outstanding?.forEach(inv => {
      const bucket = inv.aging_bucket as keyof typeof agingBreakdown
      if (bucket in agingBreakdown) {
        agingBreakdown[bucket] += Number(inv.amount_outstanding)
      }
    })

    const allInvoices = allInvoicesRes.data
    const totalBilled = allInvoices?.reduce((s, i) => s + Number(i.grand_total), 0) || 0
    const totalPaid = allInvoices?.reduce((s, i) => s + Number(i.amount_paid), 0) || 0

    // Confirmed invoice requests are wallet debits too. This schema does NOT write
    // an `invoices` row when a request is confirmed (see invoice-requests-source),
    // so without this the wallet ignores every delivered/invoiced order. Count each
    // confirmed request's order total, deduped against any real invoice by number
    // so a deployment that has both never double-debits. Mirrors the derivation in
    // GET /api/v1/parties/[id]/transactions so all wallet displays agree.
    let confirmedRequestsTotal = 0
    try {
      const invoiceNumbersBilled = new Set(
        (allInvoices || [])
          .map((i) => String((i as { invoice_number?: string }).invoice_number || ''))
          .filter(Boolean)
      )
      const confirmedReqs = await loadConfirmedInvoiceRequests(id)
      const pending = confirmedReqs.filter((r) => r.invoice_number && !invoiceNumbersBilled.has(r.invoice_number))
      const orderIds = [...new Set(pending.map((r) => r.order_id).filter(Boolean))]
      if (orderIds.length > 0) {
        const { data: ords } = await supabaseAdmin
          .from('orders')
          .select('id, grand_total')
          .in('id', orderIds)
        const totalByOrderId = new Map(
          ((ords || []) as { id: string; grand_total: number }[]).map((o) => [String(o.id), Number(o.grand_total || 0)])
        )
        confirmedRequestsTotal = pending.reduce((s, r) => s + (totalByOrderId.get(r.order_id) || 0), 0)
      }
    } catch (e) {
      console.warn('[parties/:id] confirmed invoice-request debit calc skipped:', e instanceof Error ? e.message : e)
    }

    const effectiveTotalBilled = totalBilled + confirmedRequestsTotal

    // Sum non-cancelled payments (advances + receipts). These are wallet credits.
    const paymentsTotal = (paymentsRes.data || [])
      .filter((p) => String((p as { status?: string }).status || '').toUpperCase() !== 'CANCELLED')
      .reduce((s, p) => s + Number((p as { amount?: number }).amount || 0), 0)

    // Effective wallet movement (delta from opening_balance). The authoritative
    // figure comes from the shared computeCurrentBalances helper (resolved in the
    // parallel batch above) — payments − invoices − confirmed requests + manual
    // wallet adjustments (top-ups/deductions/admin edits) — so this endpoint
    // always agrees with the parties list and wallets displays. We fall back to
    // the local payments-minus-invoices derivation if the helper failed soft.
    // The frontend adds opening_balance to this to get the displayed wallet balance.
    let walletBalance = paymentsTotal - effectiveTotalBilled
    let currentBalance = openingBalance + walletBalance
    if (derivedBalances[id] !== undefined) {
      currentBalance = derivedBalances[id]
      walletBalance = currentBalance - openingBalance
    }

    return NextResponse.json({
      success: true,
      data: {
        ...data,
        wallet_balance: walletBalance,
        current_balance: currentBalance,
        outstanding: outstandingTotal,
        aging_breakdown: agingBreakdown,
        td_balance: tdBal?.[0]?.balance || 0,
        cd_balance: cdBal?.[0]?.balance || 0,
        security_balance: secBal?.[0]?.balance || 0,
        total_billed: effectiveTotalBilled,
        total_paid: totalPaid,
        total_payments_received: paymentsTotal,
        unpaid_invoices: outstanding || [],
      },
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to fetch party'
    return NextResponse.json(
      { success: false, message, error: err },
      { status: 500 }
    )
  }
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const body = await req.json()

    const authUser = await getUserFromToken(req)
    const companyId = await resolveCompanyScope(req, authUser)

    // Verify company access before update
    if (companyId) {
      const { data: existingParty } = await supabaseAdmin
        .from('parties')
        .select('id, parent_party_id')
        .eq('id', id)
        .single()

      if (!existingParty) {
         return NextResponse.json({ success: false, message: 'Party not found' }, { status: 404 })
      }

      if (id !== companyId) {
        const tree = await getPartyDescendants(companyId)
        const treeIds = tree && tree.length > 0 ? tree.map((r: { id: string }) => r.id) : []
        if (!treeIds.includes(companyId)) treeIds.push(companyId)
        if (!treeIds.includes(id)) {
          return NextResponse.json({ success: false, message: 'Party not found or access denied' }, { status: 403 })
        }
      }
    }

    // Probe which contact column variants exist so we update the right columns.
    const [phoneProbe, contactPhoneProbe, emailProbe, contactEmailProbe, addressProbe] = await Promise.all([
      supabaseAdmin.from('parties').select('phone').limit(0),
      supabaseAdmin.from('parties').select('contact_phone').limit(0),
      supabaseAdmin.from('parties').select('email').limit(0),
      supabaseAdmin.from('parties').select('contact_email').limit(0),
      supabaseAdmin.from('parties').select('address').limit(0),
    ])
    const phoneCol = !phoneProbe.error ? 'phone' : (!contactPhoneProbe.error ? 'contact_phone' : null)
    const emailCol = !emailProbe.error ? 'email' : (!contactEmailProbe.error ? 'contact_email' : null)
    const hasAddressCol = !addressProbe.error

    // Handle default_tax_template_id as a dedicated early-return path.
    if ('default_tax_template_id' in body) {
      const templateId = (body.default_tax_template_id as string | null) || null
      // Some older schemas do not have updated_at. Try with updated_at first, then retry without it.
      let updateData: { id: string; default_tax_template_id: string | null } | null = null
      let updateError: { code?: string; message?: string } | null = null
      {
        const attempt = await supabaseAdmin
          .from('parties')
          .update({ default_tax_template_id: templateId, updated_at: new Date().toISOString() })
          .eq('id', id)
          .select('id, default_tax_template_id')
          .maybeSingle()
        updateData = attempt.data as { id: string; default_tax_template_id: string | null } | null
        updateError = attempt.error as { code?: string; message?: string } | null
      }
      if (updateError) {
        const updateErrMsg = (updateError.message || '').toLowerCase()
        const updatedAtMissing =
          updateError.code === '42703' ||
          updateError.code === 'PGRST204' ||
          (updateErrMsg.includes('updated_at') && updateErrMsg.includes('column'))
        if (updatedAtMissing) {
          const retry = await supabaseAdmin
            .from('parties')
            .update({ default_tax_template_id: templateId })
            .eq('id', id)
            .select('id, default_tax_template_id')
            .maybeSingle()
          updateData = retry.data as { id: string; default_tax_template_id: string | null } | null
          updateError = retry.error as { code?: string; message?: string } | null
        }
      }

      if (!updateError) {
        if (!updateData) return NextResponse.json({ success: false, message: 'Party not found' }, { status: 404 })
        return NextResponse.json({ success: true, data: updateData })
      }

      const errMsg = (updateError.message || '').toLowerCase()
      const isColumnMissing =
        updateError.code === '42703' ||
        updateError.code === 'PGRST204' ||
        errMsg.includes('default_tax_template_id') ||
        (errMsg.includes('column') && errMsg.includes('does not exist'))

      if (isColumnMissing) {
        // Migrate + update directly via pg, bypassing PostgREST (no schema cache issue).
        const dbUrl = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL
        if (!dbUrl) {
          if (companyId) {
            await persistTaxTemplateFallback(companyId, id, templateId, authUser?.app_user_id || authUser?.id || null)
            return NextResponse.json({ success: true, data: { id, default_tax_template_id: templateId, storage: 'company_notes_fallback' } })
          }
          return NextResponse.json({
            success: false,
            code: 'MIGRATION_REQUIRED',
            message: 'One-time database setup required. Run: ALTER TABLE public.parties ADD COLUMN IF NOT EXISTS default_tax_template_id UUID;',
          }, { status: 409 })
        }
        try {
          const { Client } = await import('pg')
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const client = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } } as any)
          await client.connect()
          await client.query('ALTER TABLE public.parties ADD COLUMN IF NOT EXISTS default_tax_template_id UUID')
          await client.query("NOTIFY pgrst, 'reload schema'")
          let result
          try {
            result = await client.query(
              `UPDATE parties SET default_tax_template_id = $1, updated_at = NOW() WHERE id = $2 RETURNING id, default_tax_template_id`,
              [templateId, id]
            )
          } catch {
            result = await client.query(
              `UPDATE parties SET default_tax_template_id = $1 WHERE id = $2 RETURNING id, default_tax_template_id`,
              [templateId, id]
            )
          }
          await client.end()
          if (!result.rows.length) {
            return NextResponse.json({ success: false, message: 'Party not found' }, { status: 404 })
          }
          return NextResponse.json({ success: true, data: result.rows[0] })
        } catch (migErr) {
          const reason = migErr instanceof Error ? migErr.message : String(migErr)
          console.error('[parties PUT] auto-migration failed:', reason)
          if (companyId) {
            await persistTaxTemplateFallback(companyId, id, templateId, authUser?.app_user_id || authUser?.id || null)
            return NextResponse.json({ success: true, data: { id, default_tax_template_id: templateId, storage: 'company_notes_fallback' } })
          }
          return NextResponse.json({
            success: false,
            code: 'MIGRATION_REQUIRED',
            message: 'Run this SQL once in Supabase SQL Editor, then save again: ALTER TABLE public.parties ADD COLUMN IF NOT EXISTS default_tax_template_id UUID;',
            debug: reason,
          }, { status: 409 })
        }
      }

      if (updateError.code === '23503' || errMsg.includes('foreign key')) {
        return NextResponse.json({ success: false, message: 'Invalid tax template. Please refresh and try again.' }, { status: 400 })
      }

      throw new Error(updateError.message || 'Failed to save tax template')
    }

    // Normalise frontend aliases to whichever DB column name actually exists.
    const mapped: Record<string, unknown> = { ...body }
    const incomingPhone = mapped.contact_phone ?? mapped.phone ?? undefined
    delete mapped.contact_phone
    delete mapped.phone
    if (incomingPhone !== undefined && phoneCol) mapped[phoneCol] = incomingPhone

    const incomingEmail = mapped.contact_email ?? mapped.email ?? undefined
    delete mapped.contact_email
    delete mapped.email
    if (incomingEmail !== undefined && emailCol) mapped[emailCol] = incomingEmail

    if ('city' in mapped && hasAddressCol) mapped.address = mapped.city

    // Sanitize: only allow known DB columns, convert empty strings to null for nullable columns
    const nullableFields = [
      'gstin', 'city', 'logo_url', 'parent_party_id', 'salesman_id',
      'trade_name', 'pin_code', 'contact_person', 'address_line1',
      'price_list_id', 'default_tax_template_id',
      ...(hasAddressCol ? ['address'] : []),
      ...(phoneCol ? [phoneCol] : []),
      ...(emailCol ? [emailCol] : []),
    ]
    const allowedFields = ['name', 'status', 'opening_balance', 'wallet_balance', 'credit_limit', 'latitude', 'longitude', ...nullableFields]
    const sanitizedBody: Record<string, unknown> = {}
    for (const key of allowedFields) {
      if (key in mapped) {
        sanitizedBody[key] = mapped[key] === '' ? null : mapped[key]
      }
    }
    // Group membership is the only party-assignment source of truth. A group's
    // salesman controls downline access; never retain a parallel direct salesman
    // assignment when this request explicitly selects (or clears) a group.
    const hasGroupAssignment = Object.prototype.hasOwnProperty.call(body, 'group_id')
    const requestedGroupId = hasGroupAssignment && body.group_id ? String(body.group_id) : null
    if (hasGroupAssignment) sanitizedBody.salesman_id = null

    // GSTIN validation if being updated with a non-null value
    if (sanitizedBody.gstin) {
      const gstinPattern = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/
      if (!gstinPattern.test(sanitizedBody.gstin as string)) {
        return NextResponse.json(
          { success: false, message: 'Invalid GSTIN format' },
          { status: 400 }
        )
      }
    }

      // Check if opening_balance or wallet_balance is changing — need to log wallet transaction
      let oldOpeningBalance = 0
      let oldWalletBalance = 0
      const isBalanceChange = sanitizedBody.opening_balance !== undefined || sanitizedBody.wallet_balance !== undefined
      if (isBalanceChange) {
        const { data: current } = await supabaseAdmin
          .from('parties')
          .select('opening_balance, wallet_balance')
          .eq('id', id)
          .single()
        if (current) {
          oldOpeningBalance = Number(current.opening_balance || 0)
          oldWalletBalance = Number(current.wallet_balance || 0)
        }
      }

      const fullPayload = { ...sanitizedBody, updated_at: new Date().toISOString() }
      // Fallback uses only universally-safe columns (no schema-dependent variants).
      const fallbackPayload: Record<string, unknown> = {}
      const fallbackFields = [
        'name', 'status', 'gstin', 'opening_balance', 'wallet_balance', 'latitude', 'longitude',
        ...(phoneCol ? [phoneCol] : []),
        ...(emailCol ? [emailCol] : []),
      ]
      for (const key of fallbackFields) {
        if (key in sanitizedBody) fallbackPayload[key] = sanitizedBody[key]
      }

      let data: Record<string, unknown> | null = null
      let error: { message?: string; code?: string; details?: string } | null = null

      {
        const result = await supabaseAdmin
          .from('parties')
          .update(fullPayload)
          .eq('id', id)
          .select()
          .single()
        data = result.data as Record<string, unknown> | null
        error = result.error as { message?: string; code?: string; details?: string } | null
      }

      if (error && (error.code === 'PGRST204' || error.code === '42703' || error.message?.toLowerCase().includes('column'))) {
        if (Object.keys(fallbackPayload).length === 0) {
          // Nothing safe to fall back to — the request only touched schema-new columns.
          // Continue so non-column side effects such as group membership still run.
          data = {}
          error = null
        } else {
          const retry = await supabaseAdmin
            .from('parties')
            .update(fallbackPayload)
            .eq('id', id)
            .select()
            .single()
          data = retry.data as Record<string, unknown> | null
          error = retry.error as { message?: string; code?: string; details?: string } | null
        }
      }

      if (error) {
        console.error('[PARTY PUT] Supabase update error:', error.code, error.message, error.details)
        const msg = (error.message || '').toLowerCase()
        if (error.code === '23505' || msg.includes('duplicate')) {
          return NextResponse.json({ success: false, message: 'Duplicate value detected. Please check GSTIN/email/phone.' }, { status: 409 })
        }
        if (error.code === '23503' || msg.includes('foreign key')) {
          return NextResponse.json({ success: false, message: 'Invalid linked data. Please refresh and try again.' }, { status: 400 })
        }
        throw new Error(error.message || 'Database update failed')
      }

      if (hasGroupAssignment) {
        await syncPartyGroupAssignment({ partyId: id, groupId: requestedGroupId, companyId, authUser })
        // Remove legacy direct links as well. Salesman visibility now comes from
        // groups -> group_members, preventing stale links from leaking access.
        await supabaseAdmin.from('party_salesman').delete().eq('party_id', id)
      }

      // Log wallet transaction for balance changes
      if (isBalanceChange && data) {
        const newOpeningBalance = Number((data as Record<string, unknown>).opening_balance || 0)
        const newWalletBalance = Number((data as Record<string, unknown>).wallet_balance || 0)
        const openingDiff = newOpeningBalance - oldOpeningBalance
        const walletDiff = newWalletBalance - oldWalletBalance

        const txns: Record<string, unknown>[] = []
        if (openingDiff !== 0) {
          const newEffective = newOpeningBalance + newWalletBalance
          txns.push({
            party_id: id,
            type: openingDiff > 0 ? 'TOPUP_CREDIT' : 'ADJUSTMENT',
            amount: openingDiff,
            balance_after: newEffective,
            reference_type: 'OPENING_BALANCE',
            description: `Opening balance ${openingDiff > 0 ? 'set to' : 'adjusted to'} ${new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(newOpeningBalance)}`,
            created_by: authUser?.app_user_id || authUser?.id || null,
            company_id: companyId || null,
          })
        }
        if (walletDiff !== 0) {
          const newEffective = newOpeningBalance + newWalletBalance
          txns.push({
            party_id: id,
            type: walletDiff > 0 ? 'TOPUP_CREDIT' : 'ADJUSTMENT',
            amount: walletDiff,
            balance_after: newEffective,
            reference_type: walletDiff > 0 ? 'TOPUP' : 'ADJUSTMENT',
            description: `Wallet balance ${walletDiff > 0 ? 'increased' : 'decreased'} by ${new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(Math.abs(walletDiff))}`,
            created_by: authUser?.app_user_id || authUser?.id || null,
            company_id: companyId || null,
          })
        }
        if (txns.length > 0) {
          await supabaseAdmin.from('wallet_transactions').insert(txns)
        }
      }

      return NextResponse.json({ success: true, data })
  } catch (err) {
    const message = err instanceof Error
      ? err.message
      : typeof err === 'object' && err !== null && 'message' in err
        ? String((err as Record<string, unknown>).message)
        : 'Failed to update party'
    console.error('[PARTY PUT] Error:', message, err)
    return NextResponse.json({ success: false, message }, { status: 500 })
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params

    const authUser = await getUserFromToken(req)
    if (authUser?.role !== 'SUPER_ADMIN') {
      return NextResponse.json({ success: false, message: 'Only super admins can delete companies' }, { status: 403 })
    }

    // Collect all descendant party IDs in one RPC call
    const { data: descendants, error: descError } = await supabaseAdmin.rpc('get_party_descendants', { root_id: id })
    if (descError) throw new Error(`Failed to get party descendants: ${descError.message}`)
    const allIds: string[] = descendants ? [id, ...descendants.map((r: { id: string }) => r.id)] : [id]

    type DbError = { message?: string; code?: string; details?: string }
    type DbOperation = PromiseLike<{ error: DbError | null }>

    function isMissingSchemaPiece(error: DbError) {
      const message = (error.message || '').toLowerCase()
      return (
        error.code === '42P01' ||
        error.code === '42703' ||
        error.code === 'PGRST200' ||
        error.code === 'PGRST204' ||
        error.code === 'PGRST205' ||
        message.includes('could not find the table') ||
        message.includes('could not find') ||
        (message.includes('column') && message.includes('does not exist')) ||
        message.includes('schema cache')
      )
    }

    async function runDb(label: string, operation: DbOperation) {
      const { error } = await operation
      if (!error) return
      const detail = [error.code, error.message, error.details].filter(Boolean).join(' - ')
      throw new Error(`${label} failed: ${detail || 'Unknown database error'}`)
    }

    async function runOptionalDb(label: string, operation: DbOperation) {
      const { error } = await operation
      if (!error) return
      if (isMissingSchemaPiece(error)) return
      const detail = [error.code, error.message, error.details].filter(Boolean).join(' - ')
      throw new Error(`${label} failed: ${detail || 'Unknown database error'}`)
    }

    async function selectIdsOptional(table: string, column: string, ids: string[]): Promise<string[]> {
      if (ids.length === 0) return []
      const { data, error } = await supabaseAdmin.from(table).select('id').in(column, ids)
      if (error) {
        if (isMissingSchemaPiece(error)) return []
        const detail = [error.code, error.message, error.details].filter(Boolean).join(' - ')
        throw new Error(`Fetch ${table} by ${column} failed: ${detail || 'Unknown database error'}`)
      }
      return (data || []).map((row: { id: string }) => row.id)
    }

    // ── Phase 1: Fetch IDs needed for child-table deletes ──
    const [
      companyInvoiceIds,
      billingInvoiceIds,
      orderPartyIds,
      orderSellerIds,
      orderBillingIds,
      orderBuyerIds,
      orderSalesmanIds,
      orderCreatedByIds,
      routeIds,
      productIds,
      priceListIds,
    ] = await Promise.all([
      selectIdsOptional('invoices', 'company_id', allIds),
      selectIdsOptional('invoices', 'billing_party_id', allIds),
      selectIdsOptional('orders', 'party_id', allIds),
      selectIdsOptional('orders', 'seller_id', allIds),
      selectIdsOptional('orders', 'billing_party_id', allIds),
      selectIdsOptional('orders', 'buyer_id', allIds),
      selectIdsOptional('orders', 'salesman_id', allIds),
      selectIdsOptional('orders', 'created_by', allIds),
      selectIdsOptional('beat_routes', 'company_id', allIds),
      selectIdsOptional('products', 'company_id', allIds),
      selectIdsOptional('price_lists', 'company_id', allIds),
    ])
    const invoiceIds = [
      ...companyInvoiceIds,
      ...billingInvoiceIds,
    ]
    const orderIds = [...new Set([
      ...orderPartyIds,
      ...orderSellerIds,
      ...orderBillingIds,
      ...orderBuyerIds,
      ...orderSalesmanIds,
      ...orderCreatedByIds,
    ])]

    const [pricingRuleIds, inventoryIds] = await Promise.all([
      selectIdsOptional('pricing_rules', 'product_id', productIds),
      selectIdsOptional('inventory', 'product_id', productIds),
    ])

    // ── Phase 2: Delete deepest leaf records in parallel ──
    await Promise.all([
      invoiceIds.length ? runOptionalDb('Delete invoice items by invoice', supabaseAdmin.from('invoice_items').delete().in('invoice_id', invoiceIds)) : Promise.resolve(),
      productIds.length ? runOptionalDb('Delete invoice items by product', supabaseAdmin.from('invoice_items').delete().in('product_id', productIds)) : Promise.resolve(),
      orderIds.length   ? runOptionalDb('Delete order items by order', supabaseAdmin.from('order_items').delete().in('order_id', orderIds))           : Promise.resolve(),
      productIds.length ? runOptionalDb('Delete order items by product', supabaseAdmin.from('order_items').delete().in('product_id', productIds))     : Promise.resolve(),
      routeIds.length   ? runOptionalDb('Delete route stops', supabaseAdmin.from('route_stops').delete().in('route_id', routeIds))                    : Promise.resolve(),
      pricingRuleIds.length ? runOptionalDb('Delete pricing audit logs', supabaseAdmin.from('pricing_audit_logs').delete().in('pricing_rule_id', pricingRuleIds)) : Promise.resolve(),
    ])

    // ── Phase 2b: Delete product-dependent records before products ──
    await Promise.all([
      priceListIds.length ? runOptionalDb('Delete price list items by list', supabaseAdmin.from('price_list_items').delete().in('price_list_id', priceListIds)) : Promise.resolve(),
      productIds.length ? runOptionalDb('Delete price list items by product', supabaseAdmin.from('price_list_items').delete().in('product_id', productIds)) : Promise.resolve(),
      productIds.length ? runOptionalDb('Delete product zone visibility', supabaseAdmin.from('product_zone_visibility').delete().in('product_id', productIds)) : Promise.resolve(),
      productIds.length ? runOptionalDb('Delete bulk pricing slabs', supabaseAdmin.from('bulk_pricing_slabs').delete().in('product_id', productIds)) : Promise.resolve(),
      productIds.length ? runOptionalDb('Delete pricing rules', supabaseAdmin.from('pricing_rules').delete().in('product_id', productIds)) : Promise.resolve(),
      productIds.length ? runOptionalDb('Delete reorder settings', supabaseAdmin.from('reorder_settings').delete().in('product_id', productIds)) : Promise.resolve(),
      productIds.length ? runOptionalDb('Delete reorder triggers', supabaseAdmin.from('reorder_triggers').delete().in('product_id', productIds)) : Promise.resolve(),
      productIds.length ? runOptionalDb('Delete stock transfers', supabaseAdmin.from('stock_transfers').delete().in('product_id', productIds)) : Promise.resolve(),
      inventoryIds.length ? runOptionalDb('Delete inventory movements', supabaseAdmin.from('inventory_movements').delete().in('inventory_id', inventoryIds)) : Promise.resolve(),
      productIds.length ? runOptionalDb('Delete procurement order items', supabaseAdmin.from('procurement_order_items').delete().in('product_id', productIds)) : Promise.resolve(),
    ])
    await Promise.all([
      productIds.length ? runOptionalDb('Delete inventory by product', supabaseAdmin.from('inventory').delete().in('product_id', productIds)) : Promise.resolve(),
    ])

    // ── Phase 3: Delete all mid-level records in parallel ──
    await Promise.all([
      runOptionalDb('Delete invoices by company', supabaseAdmin.from('invoices').delete().in('company_id', allIds)),
      runOptionalDb('Delete invoices by billing party', supabaseAdmin.from('invoices').delete().in('billing_party_id', allIds)),
      runOptionalDb('Delete payments', supabaseAdmin.from('payments').delete().in('party_id', allIds)),
      runOptionalDb('Delete TD ledger', supabaseAdmin.from('td_ledger').delete().in('party_id', allIds)),
      runOptionalDb('Delete CD ledger', supabaseAdmin.from('cd_ledger').delete().in('party_id', allIds)),
      runOptionalDb('Delete security ledger', supabaseAdmin.from('security_ledger').delete().in('party_id', allIds)),
      runOptionalDb('Delete invoice requests', supabaseAdmin.from('invoice_requests').delete().in('party_id', allIds)),
      runOptionalDb('Delete delivery lots', supabaseAdmin.from('delivery_lots').delete().in('company_id', allIds)),
      orderIds.length ? runDb('Delete orders', supabaseAdmin.from('orders').delete().in('id', orderIds)) : Promise.resolve(),
      runOptionalDb('Delete party visit logs', supabaseAdmin.from('party_visit_logs').delete().in('party_id', allIds)),
      runOptionalDb('Delete beat routes', supabaseAdmin.from('beat_routes').delete().in('company_id', allIds)),
      runOptionalDb('Delete products', supabaseAdmin.from('products').delete().in('company_id', allIds)),
      runOptionalDb('Delete product categories', supabaseAdmin.from('product_categories').delete().in('company_id', allIds)),
      runOptionalDb('Delete HSN codes', supabaseAdmin.from('hsn_codes').delete().in('company_id', allIds)),
      runOptionalDb('Delete subscriptions', supabaseAdmin.from('subscriptions').delete().in('company_id', allIds)),
      runOptionalDb('Delete price lists', supabaseAdmin.from('price_lists').delete().in('company_id', allIds)),
      runOptionalDb('Delete party salesman links by party', supabaseAdmin.from('party_salesman').delete().in('party_id', allIds)),
      runOptionalDb('Delete party salesman links by salesman', supabaseAdmin.from('party_salesman').delete().in('salesman_id', allIds)),
      runOptionalDb('Delete wallet transactions', supabaseAdmin.from('wallet_transactions').delete().in('party_id', allIds)),
      runOptionalDb('Delete subscription payments', supabaseAdmin.from('subscription_payments').delete().in('company_id', allIds)),
    ])

    // ── Phase 4: Delete users + their Supabase Auth accounts ──
    const [usersRes, appUsersRes] = await Promise.all([
      supabaseAdmin.from('users').select('id').in('party_id', allIds),
      supabaseAdmin.from('app_users').select('id').in('party_id', allIds),
    ])
    await Promise.all([
      ...(usersRes.data || []).map((u: { id: string }) =>
        supabaseAdmin.auth.admin.deleteUser(u.id).catch(() => null)
      ),
      ...(appUsersRes.data || []).map((u: { id: string }) =>
        supabaseAdmin.auth.admin.deleteUser(u.id).catch(() => null)
      ),
    ])
    await Promise.all([
      runOptionalDb('Delete users', supabaseAdmin.from('users').delete().in('party_id', allIds)),
      runOptionalDb('Detach app users', supabaseAdmin.from('app_users').update({ party_id: null }).in('party_id', allIds)),
    ])
    await runOptionalDb('Delete app users', supabaseAdmin.from('app_users').delete().in('party_id', allIds))

    // ── Phase 5: Null out any remaining FK references to these parties from other tables ──
    // This catches orders/users that weren't in our collected IDs (e.g. cross-company billing references)
    await Promise.all([
      runOptionalDb('Detach orders billing party', supabaseAdmin.from('orders').update({ billing_party_id: null }).in('billing_party_id', allIds)),
      runOptionalDb('Detach orders party', supabaseAdmin.from('orders').update({ party_id: null }).in('party_id', allIds)),
      runOptionalDb('Detach orders seller', supabaseAdmin.from('orders').update({ seller_id: null }).in('seller_id', allIds)),
      runOptionalDb('Detach orders buyer', supabaseAdmin.from('orders').update({ buyer_id: null }).in('buyer_id', allIds)),
      runOptionalDb('Detach orders salesman', supabaseAdmin.from('orders').update({ salesman_id: null }).in('salesman_id', allIds)),
      runOptionalDb('Detach orders creator', supabaseAdmin.from('orders').update({ created_by: null }).in('created_by', allIds)),
      runOptionalDb('Detach users', supabaseAdmin.from('users').update({ party_id: null }).in('party_id', allIds)),
    ])

    // ── Phase 6: Break the self-referential parent_party_id FK, then delete all party rows at once ──
    await runOptionalDb('Detach child parties', supabaseAdmin.from('parties').update({ parent_party_id: null }).in('id', allIds))
    const { error: delErr } = await supabaseAdmin.from('parties').delete().in('id', allIds)
    if (delErr) {
      const detail = [delErr.code, delErr.message, delErr.details].filter(Boolean).join(' - ')
      throw new Error(`Delete parties failed: ${detail || 'Unknown database error'}`)
    }

    return NextResponse.json({ success: true, message: 'Company and all related data permanently deleted' })
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : JSON.stringify(err)
    console.error('[PARTY DELETE]', errMsg)
    return NextResponse.json({ success: false, message: errMsg }, { status: 500 })
  }
}
