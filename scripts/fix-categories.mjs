import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function fixCategories() {
  try {
    console.log('Adding company_id column to product_categories table...');

    // Add company_id column
    await prisma.$executeRaw`
      ALTER TABLE public.product_categories
      ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES public.parties(id) ON DELETE CASCADE;
    `;

    console.log('Column added successfully');

    // Create index
    await prisma.$executeRaw`
      CREATE INDEX IF NOT EXISTS idx_product_categories_company_id
      ON public.product_categories(company_id);
    `;

    console.log('Index created successfully');

    // Enable RLS
    await prisma.$executeRaw`
      ALTER TABLE public.product_categories ENABLE ROW LEVEL SECURITY;
    `;

    console.log('RLS enabled');

    // Drop existing policies
    await prisma.$executeRaw`
      DROP POLICY IF EXISTS "Allow authenticated users to read product_categories" ON public.product_categories;
    `;
    await prisma.$executeRaw`
      DROP POLICY IF EXISTS "Allow authenticated users to create product_categories" ON public.product_categories;
    `;
    await prisma.$executeRaw`
      DROP POLICY IF EXISTS "Allow authenticated users to update product_categories" ON public.product_categories;
    `;
    await prisma.$executeRaw`
      DROP POLICY IF EXISTS "Allow authenticated users to delete product_categories" ON public.product_categories;
    `;

    console.log('Old policies dropped');

    // Create new policies
    await prisma.$executeRaw`
      CREATE POLICY "Allow authenticated users to read product_categories"
      ON public.product_categories FOR SELECT
      TO authenticated
      USING (company_id IN (SELECT party_id FROM app_users WHERE id = auth.uid()));
    `;

    await prisma.$executeRaw`
      CREATE POLICY "Allow authenticated users to create product_categories"
      ON public.product_categories FOR INSERT
      TO authenticated
      WITH CHECK (company_id IN (SELECT party_id FROM app_users WHERE id = auth.uid()));
    `;

    await prisma.$executeRaw`
      CREATE POLICY "Allow authenticated users to update product_categories"
      ON public.product_categories FOR UPDATE
      TO authenticated
      USING (company_id IN (SELECT party_id FROM app_users WHERE id = auth.uid()))
      WITH CHECK (company_id IN (SELECT party_id FROM app_users WHERE id = auth.uid()));
    `;

    await prisma.$executeRaw`
      CREATE POLICY "Allow authenticated users to delete product_categories"
      ON public.product_categories FOR DELETE
      TO authenticated
      USING (company_id IN (SELECT party_id FROM app_users WHERE id = auth.uid()));
    `;

    console.log('New policies created successfully');
    console.log('Migration completed! You should now be able to create categories in companies.');

  } catch (error) {
    console.error('Migration failed:', error);
  } finally {
    await prisma.$disconnect();
  }
}

fixCategories();