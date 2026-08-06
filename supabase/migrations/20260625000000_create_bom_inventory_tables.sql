-- ============================================================
-- BOM & Raw Material Inventory Tables
-- Run this in your Supabase SQL editor
-- ============================================================

-- Raw Materials / Inventory Items table
CREATE TABLE IF NOT EXISTS raw_materials (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid,
  name          text NOT NULL,
  code          text NOT NULL DEFAULT '',
  category      text NOT NULL DEFAULT 'Raw Material',
  unit          text NOT NULL DEFAULT 'kg',
  current_stock numeric(14,3) NOT NULL DEFAULT 0,
  min_stock     numeric(14,3) NOT NULL DEFAULT 0,
  max_stock     numeric(14,3) NOT NULL DEFAULT 0,
  cost_per_unit numeric(14,2) NOT NULL DEFAULT 0,
  location      text NOT NULL DEFAULT '',
  supplier      text NOT NULL DEFAULT '',
  status        text NOT NULL DEFAULT 'ACTIVE',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_raw_materials_company ON raw_materials(company_id);
CREATE INDEX IF NOT EXISTS idx_raw_materials_status ON raw_materials(status);

-- Stock Movements table
CREATE TABLE IF NOT EXISTS stock_movements (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid,
  item_id     uuid NOT NULL REFERENCES raw_materials(id) ON DELETE CASCADE,
  type        text NOT NULL CHECK (type IN ('in', 'out', 'adjustment')),
  quantity    numeric(14,3) NOT NULL,
  reason      text NOT NULL,
  reference   text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_stock_movements_company ON stock_movements(company_id);
CREATE INDEX IF NOT EXISTS idx_stock_movements_item ON stock_movements(item_id);
CREATE INDEX IF NOT EXISTS idx_stock_movements_created ON stock_movements(created_at DESC);

-- Bill of Materials table
CREATE TABLE IF NOT EXISTS bom_items (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid,
  product_name text NOT NULL,
  product_code text NOT NULL DEFAULT '',
  batch_size   numeric(14,3) NOT NULL DEFAULT 1,
  batch_unit   text NOT NULL DEFAULT 'kg',
  description  text NOT NULL DEFAULT '',
  components   jsonb NOT NULL DEFAULT '[]',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bom_items_company ON bom_items(company_id);

-- Enable RLS (Row Level Security)
ALTER TABLE raw_materials ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE bom_items ENABLE ROW LEVEL SECURITY;

-- Allow service role full access (used by our API)
DO $$
BEGIN
  -- raw_materials policies
  IF NOT EXISTS (SELECT FROM pg_policies WHERE tablename = 'raw_materials' AND policyname = 'service_role_all_raw_materials') THEN
    CREATE POLICY "service_role_all_raw_materials" ON raw_materials FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
  -- stock_movements policies
  IF NOT EXISTS (SELECT FROM pg_policies WHERE tablename = 'stock_movements' AND policyname = 'service_role_all_stock_movements') THEN
    CREATE POLICY "service_role_all_stock_movements" ON stock_movements FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
  -- bom_items policies
  IF NOT EXISTS (SELECT FROM pg_policies WHERE tablename = 'bom_items' AND policyname = 'service_role_all_bom_items') THEN
    CREATE POLICY "service_role_all_bom_items" ON bom_items FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
END $$;
