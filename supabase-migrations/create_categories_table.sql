-- Create categories table
CREATE TABLE IF NOT EXISTS public.categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  parent_category_id UUID REFERENCES public.categories(id) ON DELETE SET NULL,
  description TEXT,
  icon_url VARCHAR(500),
  status VARCHAR(20) DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE', 'DELETED')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  created_by UUID
);

-- Create index on parent_category_id for hierarchy queries
CREATE INDEX IF NOT EXISTS idx_categories_parent_category_id ON public.categories(parent_category_id);

-- Create index on status for filtering
CREATE INDEX IF NOT EXISTS idx_categories_status ON public.categories(status);

-- Create index on name for sorting
CREATE INDEX IF NOT EXISTS idx_categories_name ON public.categories(name);

-- Enable Row Level Security
ALTER TABLE public.categories ENABLE ROW LEVEL SECURITY;

-- Create policy to allow all authenticated users to read categories
CREATE POLICY "Allow authenticated users to read categories"
ON public.categories FOR SELECT
TO authenticated
USING (true);

-- Create policy to allow all authenticated users to create categories
CREATE POLICY "Allow authenticated users to create categories"
ON public.categories FOR INSERT
TO authenticated
WITH CHECK (true);

-- Create policy to allow all authenticated users to update categories
CREATE POLICY "Allow authenticated users to update categories"
ON public.categories FOR UPDATE
TO authenticated
USING (true)
WITH CHECK (true);

-- Create policy to allow all authenticated users to delete categories
CREATE POLICY "Allow authenticated users to delete categories"
ON public.categories FOR DELETE
TO authenticated
USING (true);

-- Create function to update updated_at timestamp
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger to automatically update updated_at
CREATE TRIGGER update_categories_updated_at
BEFORE UPDATE ON public.categories
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

-- Insert some default categories
INSERT INTO public.categories (name, description) VALUES
  ('Electronics', 'Electronic products and devices'),
  ('Chemicals', 'Chemical products and materials'),
  ('Construction', 'Construction materials and supplies'),
  ('Industrial', 'Industrial equipment and supplies'),
  ('Packaging', 'Packaging materials and supplies')
ON CONFLICT DO NOTHING;
