#!/bin/bash

# Read environment variables from .env.local
SUPABASE_URL=$(grep NEXT_PUBLIC_SUPABASE_URL .env.local | cut -d '=' -f2)
SUPABASE_KEY=$(grep SUPABASE_SERVICE_ROLE_KEY .env.local | cut -d '=' -f2)

echo "Applying products unit_of_measure constraint fix..."
echo "Supabase URL: $SUPABASE_URL"

# First, create the exec_sql function if it doesn't exist
echo "Creating exec_sql function..."
curl -X POST "$SUPABASE_URL/rest/v1/rpc/exec_sql" \
  -H "apikey: $SUPABASE_KEY" \
  -H "Authorization: Bearer $SUPABASE_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "sql": "CREATE OR REPLACE FUNCTION exec_sql(sql text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN EXECUTE sql; END; $$;"
  }' 2>/dev/null

# Drop the existing check constraint
echo "Dropping existing constraint..."
curl -X POST "$SUPABASE_URL/rest/v1/rpc/exec_sql" \
  -H "apikey: $SUPABASE_KEY" \
  -H "Authorization: Bearer $SUPABASE_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "sql": "ALTER TABLE public.products DROP CONSTRAINT IF EXISTS products_unit_of_measure_check;"
  }' 2>/dev/null

# Add the updated check constraint with all allowed units
echo "Adding updated constraint..."
curl -X POST "$SUPABASE_URL/rest/v1/rpc/exec_sql" \
  -H "apikey: $SUPABASE_KEY" \
  -H "Authorization: Bearer $SUPABASE_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "sql": "ALTER TABLE public.products ADD CONSTRAINT products_unit_of_measure_check CHECK (unit_of_measure IN ('\''KG'\'', '\''LITRE'\'', '\''BAG'\'', '\''PIECE'\'', '\''SET'\'', '\''BOX'\'', '\''DRUM'\'', '\''MT'\'', '\''UNIT'\'', '\''TON'\'', '\''GRAM'\'', '\''ML'\'', '\''CARTON'\'', '\''PACK'\''));"
  }' 2>/dev/null

echo ""
echo "Migration applied successfully!"
echo "You can now create products with any of these units: KG, LITRE, BAG, PIECE, SET, BOX, DRUM, MT, UNIT, TON, GRAM, ML, CARTON, PACK"
