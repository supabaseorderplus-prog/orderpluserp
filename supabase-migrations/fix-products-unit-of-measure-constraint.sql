-- Fix products_unit_of_measure_check constraint to allow all units used in the application
-- This migration updates the check constraint to include every unit used by the application

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
