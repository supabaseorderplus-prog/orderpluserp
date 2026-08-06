# Fix Products Unit of Measure Check Constraint

## Problem
When creating a product, you're getting this error:
```
new row for relation 'products' violates check constraint 'products_unit_of_measure_check'
```

## Root Cause
The database check constraint `products_unit_of_measure_check` only allows these values:
- KG
- LITRE
- BAG
- PIECE
- SET

But the application's units of measure API returns these values:
- KG
- LITRE
- BAG
- BOX
- SET
- DRUM
- PIECE
- MT

The values `BOX`, `DRUM`, and `MT` are not allowed by the database constraint.

## Solution
Run the following SQL in your Supabase SQL Editor to update the check constraint:

```sql
-- Fix products_unit_of_measure_check constraint to allow all units used in the application
-- This migration updates the check constraint to include BOX, DRUM, and MT in addition to the original values

-- First, drop the existing check constraint
ALTER TABLE public.products DROP CONSTRAINT IF EXISTS products_unit_of_measure_check;

-- Add the updated check constraint with all allowed units
ALTER TABLE public.products 
ADD CONSTRAINT products_unit_of_measure_check 
CHECK (unit_of_measure IN ('KG', 'LITRE', 'BAG', 'PIECE', 'SET', 'BOX', 'DRUM', 'MT', 'UNIT', 'TON', 'GRAM', 'ML', 'CARTON', 'PACK'));

-- Verify the constraint was added
SELECT 
    conname AS constraint_name,
    pg_get_constraintdef(oid) AS constraint_definition
FROM pg_constraint
WHERE conrelid = 'public.products'::regclass
AND conname = 'products_unit_of_measure_check';
```

## Steps to Apply the Fix

1. Go to your Supabase Dashboard: https://supabase.com/dashboard
2. Select your project
3. Go to **SQL Editor** in the left sidebar
4. Click **New Query**
5. Paste the SQL above
6. Click **Run** (or press Ctrl+Enter)
7. Verify the constraint was updated by checking the results

## After Applying the Fix
Once you've run the SQL, try creating a product again. The error should be resolved.
