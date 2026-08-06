import { createClient } from '@supabase/supabase-js'

// Supabase configuration
const supabaseUrl = 'https://slgrxczjnburhggnmaew.supabase.co'
const supabaseServiceKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNsZ3J4Y3pqbmJ1cmhnZ25tYWV3Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MTYwNTg1OSwiZXhwIjoyMDg3MTgxODU5fQ.Kv3w4mDrMwFbV4OQXVEVO-Lr7sNGbQFCWuFM_MHs0yo'

// Create Supabase client with service role key
const supabase = createClient(supabaseUrl, supabaseServiceKey)

async function executeMigration() {
  try {
    console.log('Creating categories table...')
    
    // Create the categories table using raw SQL
    const { data, error } = await supabase.rpc('exec_sql', {
      sql: `
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
        
        CREATE INDEX IF NOT EXISTS idx_categories_parent_category_id ON public.categories(parent_category_id);
        CREATE INDEX IF NOT EXISTS idx_categories_status ON public.categories(status);
        CREATE INDEX IF NOT EXISTS idx_categories_name ON public.categories(name);
        
        ALTER TABLE public.categories ENABLE ROW LEVEL SECURITY;
        
        CREATE POLICY IF NOT EXISTS "Allow authenticated users to read categories"
        ON public.categories FOR SELECT
        TO authenticated
        USING (true);
        
        CREATE POLICY IF NOT EXISTS "Allow authenticated users to create categories"
        ON public.categories FOR INSERT
        TO authenticated
        WITH CHECK (true);
        
        CREATE POLICY IF NOT EXISTS "Allow authenticated users to update categories"
        ON public.categories FOR UPDATE
        TO authenticated
        USING (true)
        WITH CHECK (true);
        
        CREATE POLICY IF NOT EXISTS "Allow authenticated users to delete categories"
        ON public.categories FOR DELETE
        TO authenticated
        USING (true);
        
        CREATE OR REPLACE FUNCTION public.update_updated_at_column()
        RETURNS TRIGGER AS $$
        BEGIN
          NEW.updated_at = NOW();
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
        
        DROP TRIGGER IF EXISTS update_categories_updated_at ON public.categories;
        CREATE TRIGGER update_categories_updated_at
        BEFORE UPDATE ON public.categories
        FOR EACH ROW
        EXECUTE FUNCTION public.update_updated_at_column();
        
        INSERT INTO public.categories (name, description) VALUES
          ('Electronics', 'Electronic products and devices'),
          ('Chemicals', 'Chemical products and materials'),
          ('Construction', 'Construction materials and supplies'),
          ('Industrial', 'Industrial equipment and supplies'),
          ('Packaging', 'Packaging materials and supplies')
        ON CONFLICT DO NOTHING;
      `
    })
    
    if (error) {
      console.error('Error executing migration:', error)
      console.log('\nPlease run the SQL manually in Supabase SQL Editor:')
      console.log('https://supabase.com/dashboard/project/slgrxczjnburhggnmaew/sql/new')
      console.log('\nSQL file location: supabase-migrations/create_categories_table.sql')
    } else {
      console.log('Migration completed successfully!')
      console.log('Categories table created with default data.')
    }
    
  } catch (error) {
    console.error('Migration failed:', error)
    process.exit(1)
  }
}

executeMigration()
