-- TDA Missing Tables Migration
-- Creates: ledger_entries, receipts, procurement_orders, procurement_order_items, wallets

-- ─────────────────────────────────────────────
-- 1. UNIFIED LEDGER ENTRIES
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ledger_entries (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID,
  party_id        UUID NOT NULL,
  type            TEXT NOT NULL CHECK (type IN ('DEBIT', 'CREDIT')),
  amount          NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  balance_after   NUMERIC(12, 2) NOT NULL DEFAULT 0,
  reference_id    UUID,
  reference_type  TEXT,           -- 'INVOICE', 'RECEIPT', 'ADJUSTMENT'
  narration       TEXT,
  entry_date      DATE NOT NULL DEFAULT CURRENT_DATE,
  fiscal_year     TEXT NOT NULL DEFAULT to_char(CURRENT_DATE, 'YYYY'),
  created_by      UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ledger_entries_party ON ledger_entries (party_id, entry_date DESC);
CREATE INDEX IF NOT EXISTS idx_ledger_entries_company ON ledger_entries (company_id, entry_date DESC);
CREATE INDEX IF NOT EXISTS idx_ledger_entries_reference ON ledger_entries (reference_id, reference_type);

-- ─────────────────────────────────────────────
-- 2. RECEIPTS
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS receipts (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        UUID,
  receipt_number    TEXT NOT NULL UNIQUE,
  party_id          UUID NOT NULL,
  salesman_id       UUID,
  amount            NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  payment_mode      TEXT NOT NULL DEFAULT 'CASH'
                      CHECK (payment_mode IN ('CASH','UPI','CHEQUE','NEFT','RTGS','DD')),
  reference_number  TEXT,
  bank_name         TEXT,
  notes             TEXT,
  receipt_date      DATE NOT NULL DEFAULT CURRENT_DATE,
  approval_status   TEXT NOT NULL DEFAULT 'PENDING_APPROVAL'
                      CHECK (approval_status IN ('PENDING_APPROVAL','APPROVED','REJECTED')),
  approved_by       UUID,
  approval_time     TIMESTAMPTZ,
  rejection_reason  TEXT,
  ledger_entry_id   UUID REFERENCES ledger_entries(id),
  status            TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DELETED')),
  created_by        UUID,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_receipts_party ON receipts (party_id, receipt_date DESC);
CREATE INDEX IF NOT EXISTS idx_receipts_company ON receipts (company_id, approval_status);
CREATE INDEX IF NOT EXISTS idx_receipts_salesman ON receipts (salesman_id, approval_status);

-- ─────────────────────────────────────────────
-- 3. PROCUREMENT ORDERS
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS procurement_orders (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        UUID,
  procurement_number TEXT NOT NULL UNIQUE,
  supplier_name     TEXT,
  supplier_id       UUID,              -- links to parties table if supplier is a party
  warehouse_id      UUID,
  status            TEXT NOT NULL DEFAULT 'DRAFT'
                      CHECK (status IN ('DRAFT','PENDING','APPROVED','RECEIVED','CANCELLED')),
  expected_date     DATE,
  received_date     DATE,
  notes             TEXT,
  total_amount      NUMERIC(12, 2) NOT NULL DEFAULT 0,
  approved_by       UUID,
  approval_time     TIMESTAMPTZ,
  received_by       UUID,
  created_by        UUID,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_procurement_company ON procurement_orders (company_id, status);

-- ─────────────────────────────────────────────
-- 4. PROCUREMENT ORDER ITEMS
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS procurement_order_items (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  procurement_order_id UUID NOT NULL REFERENCES procurement_orders(id) ON DELETE CASCADE,
  product_id          UUID NOT NULL,
  product_name        TEXT,
  sku                 TEXT,
  quantity_ordered    INT NOT NULL CHECK (quantity_ordered > 0),
  quantity_received   INT NOT NULL DEFAULT 0,
  unit_cost           NUMERIC(10, 2) NOT NULL DEFAULT 0,
  line_total          NUMERIC(12, 2) NOT NULL DEFAULT 0,
  unit_of_measure     TEXT DEFAULT 'PIECE',
  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_procurement_items_order ON procurement_order_items (procurement_order_id);
CREATE INDEX IF NOT EXISTS idx_procurement_items_product ON procurement_order_items (product_id);

-- ─────────────────────────────────────────────
-- 5. WALLETS (3-TIER: SALESMAN / ACCOUNTS / ADMIN)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wallets (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   UUID,
  owner_id     UUID NOT NULL,            -- user_id who owns this wallet
  wallet_type  TEXT NOT NULL DEFAULT 'SALESMAN'
                 CHECK (wallet_type IN ('SALESMAN','ACCOUNTS','ADMIN')),
  balance      NUMERIC(12, 2) NOT NULL DEFAULT 0,
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (owner_id, wallet_type, company_id)
);

CREATE INDEX IF NOT EXISTS idx_wallets_company ON wallets (company_id, wallet_type);
CREATE INDEX IF NOT EXISTS idx_wallets_owner ON wallets (owner_id);

-- ─────────────────────────────────────────────
-- 6. WALLET TRANSFERS (transfer between tiers)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wallet_transfers (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     UUID,
  from_wallet_id UUID NOT NULL REFERENCES wallets(id),
  to_wallet_id   UUID NOT NULL REFERENCES wallets(id),
  amount         NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  notes          TEXT,
  reference_id   UUID,                   -- receipt or other source
  transfer_date  DATE NOT NULL DEFAULT CURRENT_DATE,
  created_by     UUID,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wallet_transfers_company ON wallet_transfers (company_id, transfer_date DESC);

-- ─────────────────────────────────────────────
-- 7. TRIGGER: auto-update updated_at
-- ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

DO $$ BEGIN
  CREATE TRIGGER trg_ledger_entries_updated_at
    BEFORE UPDATE ON ledger_entries
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER trg_receipts_updated_at
    BEFORE UPDATE ON receipts
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER trg_procurement_orders_updated_at
    BEFORE UPDATE ON procurement_orders
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER trg_procurement_order_items_updated_at
    BEFORE UPDATE ON procurement_order_items
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER trg_wallets_updated_at
    BEFORE UPDATE ON wallets
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
