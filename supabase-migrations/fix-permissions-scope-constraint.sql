-- Fix permissions_scope_check constraint to accept the values used by the control panel
-- Control panel uses 'downline' (own data only) and 'all' (all company data).
-- The old constraint used different values ('PARTY', 'ALL', 'TERRITORY').

-- Step 1: Migrate old values to new canonical values
UPDATE permissions SET scope = 'all'      WHERE scope = 'ALL';
UPDATE permissions SET scope = 'downline' WHERE scope = 'TERRITORY';
UPDATE permissions SET scope = 'downline' WHERE scope IS NULL OR scope NOT IN ('downline', 'all');

-- Step 2: Drop the old (restrictive) constraint
ALTER TABLE permissions DROP CONSTRAINT IF EXISTS permissions_scope_check;

-- Step 3: Re-add the constraint with the correct allowed values
ALTER TABLE permissions
  ADD CONSTRAINT permissions_scope_check
  CHECK (scope IN ('downline', 'all'));
