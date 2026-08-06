-- Preserve the payment method selected by the collector. Older schemas only
-- allowed bank/cash values, which forced Coupon payments into DD/CHEQUE and made
-- them appear in the Bank wallet.
ALTER TABLE public.payments
  DROP CONSTRAINT IF EXISTS payments_payment_mode_check;

ALTER TABLE public.payments
  ADD CONSTRAINT payments_payment_mode_check
  CHECK (payment_mode IN (
    'CASH', 'UPI', 'CHEQUE', 'NEFT', 'RTGS', 'DD',
    'BANK', 'BANK_TRANSFER', 'ONLINE', 'CARD', 'COUPON'
  ));

NOTIFY pgrst, 'reload schema';
