# Fix Products Unit of Measure Check Constraint - Complete Guide

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

## Solution - Run This SQL in Supabase SQL Editor

### Step 1: Go to Supabase SQL Editor
1. Go to https://supabase.com/dashboard
2. Select your project (slgrxczjnburhggnmaew)
3. Go to **SQL Editor** in the left sidebar
4. Click **New Query**

### Step 2: Run the SQL
Copy and paste the following SQL into the SQL Editor and click **Run**:

```sql
-- Fix products_unit_of_measure_check constraint to allow all units used in the application

-- First, drop the existing check constraint
ALTER TABLE public.products DROP CONSTRAINT IF EXISTS products_unit_of_measure_check;

-- Add the updated check constraint with all allowed units
ALTER TABLE public.products 
ADD CONSTRAINT products_unit_of_measure_check 
CHECK (unit_of_measure IN ('KG', 'LITRE', 'BAG', 'PIECE', 'SET', 'BOX', 'DRUM', 'MT'));

-- Verify the constraint was added
SELECT 
    conname AS constraint_name,
    pg_get_constraintdef(oid) AS constraint_definition
FROM pg_constraint
WHERE conrelid = 'public.products'::regclass
AND conname = 'products_unit_of_measure_check';
```

### Step 3: Verify the Fix
After running the SQL, you should see a result showing the constraint was updated with all 8 allowed units.

## After Applying the Fix
Once you've run the SQL, try creating a product again. The error should be resolved.

## Quick Copy-Paste SQL
```sql
ALTER TABLE public.products DROP CONSTRAINT IF EXISTS products_unit_of_measure_check;
ALTER TABLE public.products ADD CONSTRAINT products_unit_of_measure_check CHECK (unit_of_measure IN ('KG', 'LITRE', 'BAG', 'PIECE', 'SET', 'BOX', 'DRUM', 'MT'));
```
