import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function fixHsnCodesColumn() {
  try {
    console.log('Adding company_id column to hsn_codes table...');

    // Add company_id column
    await prisma.$executeRaw`
      ALTER TABLE public.hsn_codes
      ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES public.parties(id) ON DELETE CASCADE;
    `;

    console.log('✓ company_id column added successfully');

    // Create index
    await prisma.$executeRaw`
      CREATE INDEX IF NOT EXISTS idx_hsn_codes_company_id
      ON public.hsn_codes(company_id);
    `;

    console.log('✓ Index created successfully');

    // Enable RLS
    await prisma.$executeRaw`
      ALTER TABLE public.hsn_codes ENABLE ROW LEVEL SECURITY;
    `;

    console.log('✓ RLS enabled');

    // Drop existing policies
    await prisma.$executeRaw`
      DROP POLICY IF EXISTS "Allow authenticated users to read hsn_codes" ON public.hsn_codes;
    `;
    await prisma.$executeRaw`
      DROP POLICY IF EXISTS "Allow authenticated users to create hsn_codes" ON public.hsn_codes;
    `;
    await prisma.$executeRaw`
      DROP POLICY IF EXISTS "Allow authenticated users to update hsn_codes" ON public.hsn_codes;
    `;
    await prisma.$executeRaw`
      DROP POLICY IF EXISTS "Allow authenticated users to delete hsn_codes" ON public.hsn_codes;
    `;

    console.log('✓ Old policies dropped');

    // Create new policies
    await prisma.$executeRaw`
      CREATE POLICY "Allow authenticated users to read hsn_codes"
      ON public.hsn_codes FOR SELECT
      TO authenticated
      USING (company_id IN (SELECT party_id FROM app_users WHERE id = auth.uid()));
    `;

    await prisma.$executeRaw`
      CREATE POLICY "Allow authenticated users to create hsn_codes"
      ON public.hsn_codes FOR INSERT
      TO authenticated
      WITH CHECK (company_id IN (SELECT party_id FROM app_users WHERE id = auth.uid()));
    `;

    await prisma.$executeRaw`
      CREATE POLICY "Allow authenticated users to update hsn_codes"
      ON public.hsn_codes FOR UPDATE
      TO authenticated
      USING (company_id IN (SELECT party_id FROM app_users WHERE id = auth.uid()))
      WITH CHECK (company_id IN (SELECT party_id FROM app_users WHERE id = auth.uid()));
    `;

    await prisma.$executeRaw`
      CREATE POLICY "Allow authenticated users to delete hsn_codes"
      ON public.hsn_codes FOR DELETE
      TO authenticated
      USING (company_id IN (SELECT party_id FROM app_users WHERE id = auth.uid()));
    `;

    console.log('✓ New policies created');

    console.log('Migration completed successfully!');
  } catch (error) {
    console.error('Migration failed:', error);
  } finally {
    await prisma.$disconnect();
  }
}

fixHsnCodesColumn();