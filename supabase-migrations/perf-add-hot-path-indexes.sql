-- Performance: indexes for the compute-on-read hot paths.
--
-- Wallet balances, scheme progress and rankings are derived at request time by
-- scanning payments / invoices / wallet_transactions / invoice_requests filtered
-- by party. Without these indexes every one of those filters is a sequential
-- scan, and under concurrency (multiple users + polling screens) the DB falls
-- behind, which is the "everything gets slow when many people use it" symptom.
--
-- Safe to run more than once: every index uses IF NOT EXISTS and is guarded so a
-- table/column that does not exist on a given deployment is simply skipped
-- (table presence varies — see project notes on wallet_transactions /
-- invoice_requests living in company_notes on some deployments).
--
-- Run in the Supabase SQL editor. These are plain CREATE INDEX statements (brief
-- write lock per table). If a table is very large and actively written, swap the
-- guarded CREATE for `CREATE INDEX CONCURRENTLY` and run each one outside a
-- transaction block.

DO $$
DECLARE
  -- table_name, index_name, columns (raw index expression)
  idx RECORD;
BEGIN
  FOR idx IN
    SELECT * FROM (VALUES
      ('payments',           'idx_payments_party_id',            'party_id',                'party_id'),
      ('payments',           'idx_payments_created_by',          'created_by',              'created_by'),
      ('invoices',           'idx_invoices_billing_party_id',    'billing_party_id',        'billing_party_id'),
      ('wallet_transactions','idx_wallet_txns_party_ref',        'party_id',                'party_id, reference_type'),
      ('invoice_requests',   'idx_invoice_requests_party_status','party_id',                'party_id, status'),
      ('parties',            'idx_parties_parent_party_id',      'parent_party_id',         'parent_party_id'),
      ('parties',            'idx_parties_status_id',            'status',                  'status, id'),
      ('orders',             'idx_orders_billing_party_id',      'billing_party_id',        'billing_party_id'),
      ('company_notes',      'idx_company_notes_company_id',     'company_id',              'company_id')
    ) AS t(table_name, index_name, probe_column, index_expr)
  LOOP
    IF to_regclass('public.' || idx.table_name) IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = idx.table_name
           AND column_name = idx.probe_column
       ) THEN
      EXECUTE format(
        'CREATE INDEX IF NOT EXISTS %I ON public.%I (%s)',
        idx.index_name, idx.table_name, idx.index_expr
      );
    END IF;
  END LOOP;
END $$;

-- company_notes prefix-LIKE scans (wallet-adjust / invoice-request fallbacks use
-- `note LIKE 'PREFIX%'`). A text_pattern_ops btree makes the prefix match an
-- index range scan instead of a full table scan.
DO $$
BEGIN
  IF to_regclass('public.company_notes') IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'company_notes'
         AND column_name = 'note'
     ) THEN
    CREATE INDEX IF NOT EXISTS idx_company_notes_note_prefix
      ON public.company_notes (note text_pattern_ops);
  END IF;
END $$;

-- Refresh planner statistics so the new indexes are used immediately.
ANALYZE;
