/**
 * Compatibility marker for deployments whose legacy payments check constraint
 * does not yet allow the canonical COUPON value. The stored fallback remains a
 * DB-allowed value, while every wallet/read path preserves the real mode.
 */
export const COUPON_COMPAT_BANK_NAME = '__HOMETECH_COUPON__'

export function effectivePaymentMode(
  paymentMode: string | null | undefined,
  bankName?: string | null,
): string {
  if (bankName === COUPON_COMPAT_BANK_NAME) return 'COUPON'
  return (paymentMode || '').toUpperCase()
}

export function visibleBankName(bankName?: string | null): string | null {
  return bankName === COUPON_COMPAT_BANK_NAME ? null : (bankName || null)
}

export function paymentModeInsert(
  data: Record<string, unknown>,
  requestedMode: string,
  storedMode: string,
): Record<string, unknown> {
  const couponFallback = requestedMode.toUpperCase() === 'COUPON' && storedMode.toUpperCase() !== 'COUPON'
  return {
    ...data,
    payment_mode: storedMode,
    ...(couponFallback ? { bank_name: COUPON_COMPAT_BANK_NAME } : {}),
  }
}
