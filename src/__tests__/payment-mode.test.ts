import { describe, expect, it } from 'vitest'
import {
  COUPON_COMPAT_BANK_NAME,
  effectivePaymentMode,
  paymentModeInsert,
  visibleBankName,
} from '@/lib/payment-mode'
import { classifyBucket } from '@/lib/wallet-transfers'

describe('coupon payment-mode compatibility', () => {
  it('keeps a canonical coupon in the coupon wallet', () => {
    expect(effectivePaymentMode('COUPON')).toBe('COUPON')
    expect(classifyBucket('COUPON')).toBe('coupon')
  })

  it('marks a legacy DD fallback and still classifies it as coupon', () => {
    const row = paymentModeInsert({ amount: 10 }, 'COUPON', 'DD')
    expect(row).toMatchObject({
      amount: 10,
      payment_mode: 'DD',
      bank_name: COUPON_COMPAT_BANK_NAME,
    })
    expect(effectivePaymentMode('DD', COUPON_COMPAT_BANK_NAME)).toBe('COUPON')
    expect(classifyBucket('DD', COUPON_COMPAT_BANK_NAME)).toBe('coupon')
    expect(visibleBankName(COUPON_COMPAT_BANK_NAME)).toBeNull()
  })

  it('does not reinterpret a genuine DD payment', () => {
    expect(effectivePaymentMode('DD', null)).toBe('DD')
    expect(classifyBucket('DD', null)).toBe('bank')
  })
})
