import { describe, expect, it } from 'vitest'
import { writeFileSync } from 'node:fs'
import { effectivePaymentApprovalStatus, type PaymentApprovalRecord } from '@/lib/payment-approval-links'
import { generatePaymentApprovalPdf, paymentApprovalPdfFilename } from '@/lib/payment-approval-pdf'

const sample = (overrides: Partial<PaymentApprovalRecord> = {}): PaymentApprovalRecord => ({
  token: 'x'.repeat(43),
  request_number: 'PAY-REQ-TEST123',
  status: 'ACTIVE',
  company_id: 'company-1',
  company_name: 'HomeTech Chemical',
  party_id: 'party-1',
  party_name: 'Shree Buildmart',
  party_code: 'PTY-1001',
  party_phone: '9876543210',
  collector_id: 'user-1',
  collector_name: 'Aarav Sharma',
  auth_user: { id: 'auth-1', app_user_id: 'user-1', name: 'Aarav Sharma', email: 'aarav@example.com', role: 'SALESMAN', role_id: null, party_id: 'company-1' },
  payload: { party_id: 'party-1', amount: 25000, payment_mode: 'NEFT', reference_number: 'UTR123456', adjustments: [{ invoiceId: 'invoice-1', amount: 25000 }], applied_scheme_ids: ['scheme-1'] },
  invoices: [{ id: 'invoice-1', invoice_number: 'INV-2026-1042', invoice_date: '2026-07-01', invoice_total: 50000, outstanding_before: 30000, allocation: 25000, outstanding_after: 5000, status_after: 'PARTIAL' }],
  schemes: [{ id: 'scheme-1', name: 'Monsoon Growth Reward', target_value: 100000, current_value: 65000, payment_credit: 25000, projected_value: 90000, progress_before: 65, progress_after: 90, status_before: 'IN PROGRESS', status_after: 'IN PROGRESS', end_date: '2026-07-31', reward_description: 'Gold reward' }],
  balance_before: -30000,
  balance_after: -5000,
  unallocated_amount: 0,
  created_at: '2026-07-05T10:00:00.000Z',
  expires_at: '2099-07-08T10:00:00.000Z',
  processing_at: null,
  approved_at: null,
  approved_name: null,
  payment_id: null,
  payment_number: null,
  last_error: null,
  ...overrides,
})

describe('payment approval links', () => {
  it('expires approved links immediately', () => {
    expect(effectivePaymentApprovalStatus(sample({ status: 'APPROVED' }))).toBe('APPROVED')
  })

  it('keeps revoked links expired even when their original deadline is in the future', () => {
    expect(effectivePaymentApprovalStatus(sample({ status: 'REVOKED' }))).toBe('REVOKED')
  })

  it('allows recovery from a stale processing lock', () => {
    expect(effectivePaymentApprovalStatus(sample({
      status: 'PROCESSING',
      processing_at: new Date(Date.now() - 3 * 60 * 1000).toISOString(),
    }))).toBe('ACTIVE')
  })

  it('generates a non-empty professional PDF with a stable filename', () => {
    const record = sample()
    const pdf = generatePaymentApprovalPdf(record, `https://example.com/approve-payment/${record.token}`)
    const bytes = pdf.output('arraybuffer')
    if (process.env.PAYMENT_PDF_PREVIEW) writeFileSync(process.env.PAYMENT_PDF_PREVIEW, Buffer.from(bytes))
    expect(bytes.byteLength).toBeGreaterThan(5_000)
    expect(pdf.getNumberOfPages()).toBeGreaterThanOrEqual(1)
    expect(paymentApprovalPdfFilename(record)).toBe('Payment_Approval_PAY_REQ_TEST123.pdf')
  })
})
