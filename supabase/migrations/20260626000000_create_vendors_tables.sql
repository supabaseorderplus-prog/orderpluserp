-- ============================================================
-- Vendor Management Tables (Creditors / Debtors)
-- Run this ONCE in your Supabase SQL editor.
-- Until it runs, the Vendors tab shows a "run migration" notice.
-- ============================================================

-- Vendors: suppliers/parties you transact with outside the sales downline.
-- vendor_type:
--   CREDITOR — you owe them (a supplier you buy from). Positive balance = payable.
--   DEBTOR   — they owe you. Positive balance = receivable.
CREATE TABLE IF NOT EXISTS vendors (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id           uuid,
  vendor_code          text NOT NULL DEFAULT '',
  name                 text NOT NULL,
  trade_name           text,
  vendor_type          text NOT NULL DEFAULT 'CREDITOR' CHECK (vendor_type IN ('CREDITOR', 'DEBTOR')),
  gstin                text,
  pan                  text,
  address_line1        text,
  city                 text,
  pin_code             text,
  contact_person       text,
  contact_phone        text,
  contact_email        text,
  contact_aadhaar_url  text,
  credit_limit         numeric(14,2) NOT NULL DEFAULT 0,
  payment_terms_days   integer NOT NULL DEFAULT 21,
  opening_balance      numeric(14,2) NOT NULL DEFAULT 0,
  latitude             numeric(9,6),
  longitude            numeric(9,6),
  portal_phone         text,
  portal_password_hash text,
  notes                text,
  status               text NOT NULL DEFAULT 'ACTIVE',
  created_by           uuid,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vendors_company ON vendors(company_id);
CREATE INDEX IF NOT EXISTS idx_vendors_status  ON vendors(status);
CREATE INDEX IF NOT EXISTS idx_vendors_type    ON vendors(vendor_type);
-- One vendor per portal phone within a company (when portal login is set).
CREATE UNIQUE INDEX IF NOT EXISTS uq_vendors_company_portal_phone
  ON vendors(company_id, portal_phone)
  WHERE portal_phone IS NOT NULL AND portal_phone <> '';

-- Vendor ledger: every bill (what they billed us) and payment (what we paid them).
-- txn_type:
--   BILL       — increases what the CREDITOR is owed / what the DEBTOR owes back.
--   PAYMENT    — settles the balance (we pay a creditor / a debtor pays us).
--   ADJUSTMENT — signed manual correction (amount may be negative).
-- Current balance = opening_balance + Σ(BILL) − Σ(PAYMENT) + Σ(ADJUSTMENT).
CREATE TABLE IF NOT EXISTS vendor_transactions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id        uuid NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  company_id       uuid,
  txn_type         text NOT NULL CHECK (txn_type IN ('BILL', 'PAYMENT', 'ADJUSTMENT')),
  amount           numeric(14,2) NOT NULL,
  txn_date         date NOT NULL DEFAULT current_date,
  reference_number text,
  description      text,
  created_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vendor_txns_vendor  ON vendor_transactions(vendor_id);
CREATE INDEX IF NOT EXISTS idx_vendor_txns_company ON vendor_transactions(company_id);
CREATE INDEX IF NOT EXISTS idx_vendor_txns_date    ON vendor_transactions(txn_date);
