-- Create product_categories table
CREATE TABLE IF NOT EXISTS public.product_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  parent_category_id UUID REFERENCES public.product_categories(id) ON DELETE SET NULL,
  description TEXT,
  icon_url VARCHAR(500),
  status VARCHAR(20) DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE', 'DELETED')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  created_by UUID
);

-- Create index on parent_category_id for hierarchy queries
CREATE INDEX IF NOT EXISTS idx_product_categories_parent_category_id ON public.product_categories(parent_category_id);

-- Create index on status for filtering
CREATE INDEX IF NOT EXISTS idx_product_categories_status ON public.product_categories(status);

-- Create index on name for sorting
CREATE INDEX IF NOT EXISTS idx_product_categories_name ON public.product_categories(name);

-- Enable Row Level Security
ALTER TABLE public.product_categories ENABLE ROW LEVEL SECURITY;

-- Create policy to allow all authenticated users to read product_categories
CREATE POLICY IF NOT EXISTS "Allow authenticated users to read product_categories"
ON public.product_categories FOR SELECT
TO authenticated
USING (true);

-- Create policy to allow all authenticated users to create product_categories
CREATE POLICY IF NOT EXISTS "Allow authenticated users to create product_categories"
ON public.product_categories FOR INSERT
TO authenticated
WITH CHECK (true);

-- Create policy to allow all authenticated users to update product_categories
CREATE POLICY IF NOT EXISTS "Allow authenticated users to update product_categories"
ON public.product_categories FOR UPDATE
TO authenticated
USING (true)
WITH CHECK (true);

-- Create policy to allow all authenticated users to delete product_categories
CREATE POLICY IF NOT EXISTS "Allow authenticated users to delete product_categories"
ON public.product_categories FOR DELETE
TO authenticated
USING (true);

-- Create function to update updated_at timestamp
CREATE OR REPLACE FUNCTION public.update_product_categories_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger to automatically update updated_at
DROP TRIGGER IF EXISTS update_product_categories_updated_at ON public.product_categories;
CREATE TRIGGER update_product_categories_updated_at
BEFORE UPDATE ON public.product_categories
FOR EACH ROW
EXECUTE FUNCTION public.update_product_categories_updated_at();

-- Insert some default product categories
INSERT INTO public.product_categories (name, description) VALUES
  ('Electronics', 'Electronic products and devices'),
  ('Chemicals', 'Chemical products and materials'),
  ('Construction', 'Construction materials and supplies'),
  ('Industrial', 'Industrial equipment and supplies'),
  ('Packaging', 'Packaging materials and supplies')
ON CONFLICT DO NOTHING;
