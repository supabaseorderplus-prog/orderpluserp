-- Fix: extend schemes_applicable_party_type_check to include all values used by the app
-- The original constraint was missing INDIVIDUAL (used for manually-enrolled parties)
-- and SUPER_DEALER. Dropping and recreating the constraint is a safe, additive change —
-- no existing rows are removed or changed.

ALTER TABLE public.schemes
  DROP CONSTRAINT IF EXISTS schemes_applicable_party_type_check;

ALTER TABLE public.schemes
  ADD CONSTRAINT schemes_applicable_party_type_check
  CHECK (applicable_party_type IN (
    'COMPANY',
    'CNF',
    'SUPER_DEALER',
    'RETAILER',
    'SALESMAN',
    'MANUFACTURER',
    'ALL',
    'INDIVIDUAL'
  ));

NOTIFY pgrst, 'reload schema';
