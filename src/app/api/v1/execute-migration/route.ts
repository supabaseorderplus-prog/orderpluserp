import fs from 'node:fs'
import path from 'node:path'
import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-server'
import { runDirectSql } from '@/lib/direct-sql'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { migrationName } = body

    if (migrationName === 'create-bom-inventory-tables') {
      const sql = fs.readFileSync(
        path.join(process.cwd(), 'supabase/migrations/20260625000000_create_bom_inventory_tables.sql'),
        'utf8',
      )

      const { error } = await supabaseAdmin.rpc('exec_sql', { sql })
      if (error) {
        const applied = await runDirectSql(sql)
        if (!applied) {
          return NextResponse.json({ success: false, message: (error as any).message || 'Failed to create BOM and inventory tables' }, { status: 500 })
        }
      }

      await supabaseAdmin.rpc('exec_sql', { sql: `NOTIFY pgrst, 'reload schema';` }).then(() => null, () => null)
      return NextResponse.json({ success: true, message: 'BOM and inventory tables created successfully' })
    }

    if (migrationName === 'add-company-id-to-product-categories') {
      // Add company_id column to product_categories table if it doesn't exist
      const { error: alterError } = await supabaseAdmin.rpc('exec_sql', {
        sql: `ALTER TABLE public.product_categories ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES public.parties(id) ON DELETE CASCADE;`
      })
      if (alterError && alterError.code !== 'PGRST202') {
        return NextResponse.json({ success: false, message: (alterError as any).message || 'Failed to add company_id column' }, { status: 500 })
      }

      // Create index on company_id for filtering
      await supabaseAdmin.rpc('exec_sql', {
        sql: `CREATE INDEX IF NOT EXISTS idx_product_categories_company_id ON public.product_categories(company_id);`
      })

      // Enable RLS if not already enabled
      await supabaseAdmin.rpc('exec_sql', {
        sql: `ALTER TABLE public.product_categories ENABLE ROW LEVEL SECURITY;`
      })

      // Drop existing policies
      await supabaseAdmin.rpc('exec_sql', {
        sql: `DROP POLICY IF EXISTS "Allow authenticated users to read product_categories" ON public.product_categories;`
      })
      await supabaseAdmin.rpc('exec_sql', {
        sql: `DROP POLICY IF EXISTS "Allow authenticated users to create product_categories" ON public.product_categories;`
      })
      await supabaseAdmin.rpc('exec_sql', {
        sql: `DROP POLICY IF EXISTS "Allow authenticated users to update product_categories" ON public.product_categories;`
      })
      await supabaseAdmin.rpc('exec_sql', {
        sql: `DROP POLICY IF EXISTS "Allow authenticated users to delete product_categories" ON public.product_categories;`
      })

      // Create new policies that use party_id from users
      const { error: readError } = await supabaseAdmin.rpc('exec_sql', {
        sql: `CREATE POLICY "Allow authenticated users to read product_categories"
ON public.product_categories FOR SELECT
TO authenticated
USING (company_id IN (SELECT party_id FROM users WHERE id = auth.uid()));`
      })
      if (readError && readError.code !== 'PGRST202') {
        return NextResponse.json({ success: false, message: (readError as any).message || 'Failed to create read policy' }, { status: 500 })
      }

      const { error: createError } = await supabaseAdmin.rpc('exec_sql', {
        sql: `CREATE POLICY "Allow authenticated users to create product_categories"
ON public.product_categories FOR INSERT
TO authenticated
WITH CHECK (company_id IN (SELECT party_id FROM users WHERE id = auth.uid()));`
      })
      if (createError && createError.code !== 'PGRST202') {
        return NextResponse.json({ success: false, message: (createError as any).message || 'Failed to create insert policy' }, { status: 500 })
      }

      const { error: updateError } = await supabaseAdmin.rpc('exec_sql', {
        sql: `CREATE POLICY "Allow authenticated users to update product_categories"
ON public.product_categories FOR UPDATE
TO authenticated
USING (company_id IN (SELECT party_id FROM users WHERE id = auth.uid()))
WITH CHECK (company_id IN (SELECT party_id FROM users WHERE id = auth.uid()));`
      })
      if (updateError && updateError.code !== 'PGRST202') {
        return NextResponse.json({ success: false, message: (updateError as any).message || 'Failed to create update policy' }, { status: 500 })
      }

      const { error: deleteError } = await supabaseAdmin.rpc('exec_sql', {
        sql: `CREATE POLICY "Allow authenticated users to delete product_categories"
ON public.product_categories FOR DELETE
TO authenticated
USING (company_id IN (SELECT party_id FROM users WHERE id = auth.uid()));`
      })
      if (deleteError && deleteError.code !== 'PGRST202') {
        return NextResponse.json({ success: false, message: (deleteError as any).message || 'Failed to create delete policy' }, { status: 500 })
      }

      // Reload PostgREST schema cache so the new column is recognized
      await supabaseAdmin.rpc('exec_sql', { sql: `NOTIFY pgrst, 'reload schema';` })

      return NextResponse.json({ success: true, message: 'company_id column added and RLS policies updated successfully' })
    }

    if (migrationName === 'fix-products-unit-of-measure') {
      // Drop the existing check constraint
      const { error: dropError } = await supabaseAdmin.rpc('exec_sql', {
        sql: `ALTER TABLE public.products DROP CONSTRAINT IF EXISTS products_unit_of_measure_check;`
      })

      if (dropError && dropError.code !== 'PGRST202') {
        return NextResponse.json({ success: false, message: (dropError as any).message || 'Failed to drop constraint' }, { status: 500 })
      }

      // Add the updated check constraint with all allowed units
      const { error: addError } = await supabaseAdmin.rpc('exec_sql', {
        sql: `ALTER TABLE public.products ADD CONSTRAINT products_unit_of_measure_check CHECK (unit_of_measure IN ('KG', 'LITRE', 'BAG', 'PIECE', 'SET', 'BOX', 'DRUM', 'MT', 'UNIT', 'TON', 'GRAM', 'ML', 'CARTON', 'PACK'));`
      })

      if (addError && addError.code !== 'PGRST202') {
        return NextResponse.json({ success: false, message: (addError as any).message || 'Failed to add constraint' }, { status: 500 })
      }

      return NextResponse.json({ success: true, message: 'Migration executed successfully' })
    }

    if (migrationName === 'fix-product-categories-rls') {
      // Enable RLS if not already enabled
      await supabaseAdmin.rpc('exec_sql', {
        sql: `ALTER TABLE public.product_categories ENABLE ROW LEVEL SECURITY;`
      })

      // Drop existing policies
      await supabaseAdmin.rpc('exec_sql', {
        sql: `DROP POLICY IF EXISTS "Allow authenticated users to read product_categories" ON public.product_categories;`
      })
      await supabaseAdmin.rpc('exec_sql', {
        sql: `DROP POLICY IF EXISTS "Allow authenticated users to create product_categories" ON public.product_categories;`
      })
      await supabaseAdmin.rpc('exec_sql', {
        sql: `DROP POLICY IF EXISTS "Allow authenticated users to update product_categories" ON public.product_categories;`
      })
      await supabaseAdmin.rpc('exec_sql', {
        sql: `DROP POLICY IF EXISTS "Allow authenticated users to delete product_categories" ON public.product_categories;`
      })

      // Create new policies that use party_id instead of company_id
      const { error: readError } = await supabaseAdmin.rpc('exec_sql', {
        sql: `CREATE POLICY "Allow authenticated users to read product_categories"
ON public.product_categories FOR SELECT
TO authenticated
USING (company_id IN (SELECT party_id FROM users WHERE id = auth.uid()));`
      })
      if (readError && readError.code !== 'PGRST202') {
        return NextResponse.json({ success: false, message: (readError as any).message || 'Failed to create read policy' }, { status: 500 })
      }

      const { error: createError } = await supabaseAdmin.rpc('exec_sql', {
        sql: `CREATE POLICY "Allow authenticated users to create product_categories"
ON public.product_categories FOR INSERT
TO authenticated
WITH CHECK (company_id IN (SELECT party_id FROM users WHERE id = auth.uid()));`
      })
      if (createError && createError.code !== 'PGRST202') {
        return NextResponse.json({ success: false, message: (createError as any).message || 'Failed to create insert policy' }, { status: 500 })
      }

      const { error: updateError } = await supabaseAdmin.rpc('exec_sql', {
        sql: `CREATE POLICY "Allow authenticated users to update product_categories"
ON public.product_categories FOR UPDATE
TO authenticated
USING (company_id IN (SELECT party_id FROM users WHERE id = auth.uid()))
WITH CHECK (company_id IN (SELECT party_id FROM users WHERE id = auth.uid()));`
      })
      if (updateError && updateError.code !== 'PGRST202') {
        return NextResponse.json({ success: false, message: (updateError as any).message || 'Failed to create update policy' }, { status: 500 })
      }

      const { error: deleteError } = await supabaseAdmin.rpc('exec_sql', {
        sql: `CREATE POLICY "Allow authenticated users to delete product_categories"
ON public.product_categories FOR DELETE
TO authenticated
USING (company_id IN (SELECT party_id FROM users WHERE id = auth.uid()));`
      })
      if (deleteError && deleteError.code !== 'PGRST202') {
        return NextResponse.json({ success: false, message: (deleteError as any).message || 'Failed to create delete policy' }, { status: 500 })
      }

      return NextResponse.json({ success: true, message: 'RLS policies fixed successfully' })
    }

    if (migrationName === 'create-product-categories-table') {
      // Create the product_categories table if it doesn't exist
      const { error: tableError } = await supabaseAdmin.rpc('exec_sql', {
        sql: `CREATE TABLE IF NOT EXISTS public.product_categories (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          name VARCHAR(255) NOT NULL,
          company_id UUID REFERENCES public.parties(id) ON DELETE CASCADE,
          description TEXT,
          status VARCHAR(20) DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE', 'DELETED')),
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        );`
      })
      if (tableError && tableError.code !== 'PGRST202') {
        return NextResponse.json({ success: false, message: (tableError as any).message || 'Failed to create table' }, { status: 500 })
      }

      // Create indexes
      await supabaseAdmin.rpc('exec_sql', {
        sql: `CREATE INDEX IF NOT EXISTS idx_product_categories_company_id ON public.product_categories(company_id);`
      })
      await supabaseAdmin.rpc('exec_sql', {
        sql: `CREATE INDEX IF NOT EXISTS idx_product_categories_name ON public.product_categories(name);`
      })

      return NextResponse.json({ success: true, message: 'Product categories table created successfully' })
    }

    if (migrationName === 'product-categories-rpc') {
      // Create RPC functions to bypass PostgREST schema cache
      // First DROP existing functions (both possible parameter orders) then recreate with correct signature
      const statements = [
        `ALTER TABLE public.product_categories ADD COLUMN IF NOT EXISTS company_id UUID`,
        `CREATE INDEX IF NOT EXISTS idx_product_categories_company_id ON public.product_categories(company_id)`,
        `DROP FUNCTION IF EXISTS public.create_product_category(uuid, text)`,
        `DROP FUNCTION IF EXISTS public.create_product_category(text, uuid)`,
        `DROP FUNCTION IF EXISTS public.list_product_categories(uuid)`,
        `DROP FUNCTION IF EXISTS public.delete_product_category(uuid, uuid)`,
        `CREATE FUNCTION public.list_product_categories(p_company_id uuid)
RETURNS TABLE(id uuid, name text) LANGUAGE sql SECURITY DEFINER STABLE AS $$
  SELECT pc.id, pc.name::text FROM public.product_categories pc WHERE pc.company_id = p_company_id ORDER BY pc.name;
$$`,
        `CREATE FUNCTION public.create_product_category(p_company_id uuid, p_name text)
RETURNS TABLE(id uuid, name text) LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE new_id uuid;
BEGIN
  INSERT INTO public.product_categories (name, company_id) VALUES (p_name, p_company_id) RETURNING product_categories.id INTO new_id;
  RETURN QUERY SELECT pc.id, pc.name::text FROM public.product_categories pc WHERE pc.id = new_id;
END;
$$`,
        `CREATE FUNCTION public.delete_product_category(p_id uuid, p_company_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE public.products SET category_id = NULL WHERE category_id = p_id AND company_id = p_company_id;
  DELETE FROM public.product_categories WHERE id = p_id AND company_id = p_company_id;
END;
$$`,
        `GRANT EXECUTE ON FUNCTION public.list_product_categories(uuid) TO service_role`,
        `GRANT EXECUTE ON FUNCTION public.list_product_categories(uuid) TO authenticated`,
        `GRANT EXECUTE ON FUNCTION public.create_product_category(uuid, text) TO service_role`,
        `GRANT EXECUTE ON FUNCTION public.create_product_category(uuid, text) TO authenticated`,
        `GRANT EXECUTE ON FUNCTION public.delete_product_category(uuid, uuid) TO service_role`,
        `GRANT EXECUTE ON FUNCTION public.delete_product_category(uuid, uuid) TO authenticated`,
        `NOTIFY pgrst, 'reload schema'`,
      ]
      for (const sql of statements) {
        const { error } = await supabaseAdmin.rpc('exec_sql', { sql })
        if (error && error.code !== 'PGRST202') {
          return NextResponse.json({ success: false, message: (error as any).message || 'Migration failed' }, { status: 500 })
        }
      }
      return NextResponse.json({ success: true, message: 'Product categories RPC functions created successfully' })
    }

    if (migrationName === 'add-company-id-to-hsn-codes') {
      // Add company_id column to hsn_codes table if it doesn't exist
      const { error: alterError } = await supabaseAdmin.rpc('exec_sql', {
        sql: `ALTER TABLE public.hsn_codes ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES public.parties(id) ON DELETE CASCADE;`
      })
      if (alterError && alterError.code !== 'PGRST202') {
        return NextResponse.json({ success: false, message: (alterError as any).message || 'Failed to add company_id column' }, { status: 500 })
      }

      // Create index on company_id for filtering
      await supabaseAdmin.rpc('exec_sql', {
        sql: `CREATE INDEX IF NOT EXISTS idx_hsn_codes_company_id ON public.hsn_codes(company_id);`
      })

      // Enable RLS if not already enabled
      await supabaseAdmin.rpc('exec_sql', {
        sql: `ALTER TABLE public.hsn_codes ENABLE ROW LEVEL SECURITY;`
      })

      // Drop existing policies
      await supabaseAdmin.rpc('exec_sql', {
        sql: `DROP POLICY IF EXISTS "Allow authenticated users to read hsn_codes" ON public.hsn_codes;`
      })
      await supabaseAdmin.rpc('exec_sql', {
        sql: `DROP POLICY IF EXISTS "Allow authenticated users to create hsn_codes" ON public.hsn_codes;`
      })
      await supabaseAdmin.rpc('exec_sql', {
        sql: `DROP POLICY IF EXISTS "Allow authenticated users to update hsn_codes" ON public.hsn_codes;`
      })
      await supabaseAdmin.rpc('exec_sql', {
        sql: `DROP POLICY IF EXISTS "Allow authenticated users to delete hsn_codes" ON public.hsn_codes;`
      })

      // Create new policies that use party_id from users
      const { error: readError } = await supabaseAdmin.rpc('exec_sql', {
        sql: `CREATE POLICY "Allow authenticated users to read hsn_codes"
ON public.hsn_codes FOR SELECT
TO authenticated
USING (company_id IN (SELECT party_id FROM users WHERE id = auth.uid()));`
      })
      if (readError && readError.code !== 'PGRST202') {
        return NextResponse.json({ success: false, message: (readError as any).message || 'Failed to create read policy' }, { status: 500 })
      }

      const { error: createError } = await supabaseAdmin.rpc('exec_sql', {
        sql: `CREATE POLICY "Allow authenticated users to create hsn_codes"
ON public.hsn_codes FOR INSERT
TO authenticated
WITH CHECK (company_id IN (SELECT party_id FROM users WHERE id = auth.uid()));`
      })
      if (createError && createError.code !== 'PGRST202') {
        return NextResponse.json({ success: false, message: (createError as any).message || 'Failed to create insert policy' }, { status: 500 })
      }

      const { error: updateError } = await supabaseAdmin.rpc('exec_sql', {
        sql: `CREATE POLICY "Allow authenticated users to update hsn_codes"
ON public.hsn_codes FOR UPDATE
TO authenticated
USING (company_id IN (SELECT party_id FROM users WHERE id = auth.uid()))
WITH CHECK (company_id IN (SELECT party_id FROM users WHERE id = auth.uid()));`
      })
      if (updateError && updateError.code !== 'PGRST202') {
        return NextResponse.json({ success: false, message: (updateError as any).message || 'Failed to create update policy' }, { status: 500 })
      }

      const { error: deleteError } = await supabaseAdmin.rpc('exec_sql', {
        sql: `CREATE POLICY "Allow authenticated users to delete hsn_codes"
ON public.hsn_codes FOR DELETE
TO authenticated
USING (company_id IN (SELECT party_id FROM users WHERE id = auth.uid()));`
      })
      if (deleteError && deleteError.code !== 'PGRST202') {
        return NextResponse.json({ success: false, message: (deleteError as any).message || 'Failed to create delete policy' }, { status: 500 })
      }

      return NextResponse.json({ success: true, message: 'company_id column added to hsn_codes and RLS policies updated successfully' })
    }

    if (migrationName === 'add-party-verification') {
      const statements = [
        // Add verification columns to parties table
        `ALTER TABLE public.parties ADD COLUMN IF NOT EXISTS is_verified BOOLEAN DEFAULT false`,
        `ALTER TABLE public.parties ADD COLUMN IF NOT EXISTS verified_by UUID REFERENCES public.users(id) ON DELETE SET NULL`,
        `ALTER TABLE public.parties ADD COLUMN IF NOT EXISTS verified_at TIMESTAMP WITH TIME ZONE`,
        // Create party_visit_logs table
        `CREATE TABLE IF NOT EXISTS public.party_visit_logs (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          party_id UUID NOT NULL REFERENCES public.parties(id) ON DELETE CASCADE,
          visited_by UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
          visit_date TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
          notes TEXT,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        )`,
        // Indexes
        `CREATE INDEX IF NOT EXISTS idx_parties_is_verified ON public.parties(is_verified)`,
        `CREATE INDEX IF NOT EXISTS idx_party_visit_logs_party_id ON public.party_visit_logs(party_id)`,
        `CREATE INDEX IF NOT EXISTS idx_party_visit_logs_visit_date ON public.party_visit_logs(visit_date)`,
        // Reload PostgREST schema cache
        `NOTIFY pgrst, 'reload schema'`,
      ]
      for (const sql of statements) {
        const { error } = await supabaseAdmin.rpc('exec_sql', { sql })
        if (error && error.code !== 'PGRST202') {
          return NextResponse.json({ success: false, message: (error as any).message || 'Migration failed' }, { status: 500 })
        }
      }
      return NextResponse.json({ success: true, message: 'Party verification columns and visit_logs table created successfully' })
    }

    if (migrationName === 'fix-admin-users-phone') {
      // Fix ADMIN users who have null phone but their company has a portal_phone
      // This was caused by a bug where phone was set to null for multi-company accounts

      // Get all users with null phone that have a party_id
      const { data: usersWithNullPhone, error: usersErr } = await supabaseAdmin
        .from('users')
        .select('id, party_id')
        .is('phone', null)
        .not('party_id', 'is', null)

      if (usersErr) {
        return NextResponse.json({ success: false, message: 'Failed to fetch users' }, { status: 500 })
      }

      if (!usersWithNullPhone || usersWithNullPhone.length === 0) {
        return NextResponse.json({ success: true, message: 'No users with null phone found', fixed: 0 })
      }

      // Get party_ids
      const partyIds = usersWithNullPhone.map(u => u.party_id).filter(Boolean)

      // Fetch portal_phone for these companies
      const { data: parties, error: partiesErr } = await supabaseAdmin
        .from('parties')
        .select('id, portal_phone')
        .in('id', partyIds)
        .not('portal_phone', 'is', null)

      if (partiesErr) {
        return NextResponse.json({ success: false, message: 'Failed to fetch parties' }, { status: 500 })
      }

      // Create a map of party_id -> portal_phone
      const phoneMap: Record<string, string> = {}
      for (const party of parties || []) {
        if (party.portal_phone) {
          phoneMap[party.id] = party.portal_phone
        }
      }

      // Update users with the portal_phone from their company
      let fixedCount = 0
      for (const user of usersWithNullPhone) {
        if (user.party_id && phoneMap[user.party_id]) {
          const { error: updateErr } = await supabaseAdmin
            .from('users')
            .update({ phone: phoneMap[user.party_id] })
            .eq('id', user.id)

          if (!updateErr) {
            fixedCount++
          }
        }
      }

      return NextResponse.json({
        success: true,
        message: `Fixed ${fixedCount} users with null phone`,
        fixed: fixedCount,
        total: usersWithNullPhone.length
      })
    }

    if (migrationName === 'create-bloom-admin') {
      // Specifically create ADMIN user for BLOOM BY SHANAYA company
      const companyName = 'BLOOM BY SHANAYA'
      
      // Find the company
      const { data: company, error: companyErr } = await supabaseAdmin
        .from('parties')
        .select('id, name, portal_phone')
        .ilike('name', '%BLOOM%')
        .single()

      if (companyErr || !company) {
        return NextResponse.json({ success: false, message: 'BLOOM BY SHANAYA company not found' }, { status: 404 })
      }

      // Get ADMIN role
      const { data: adminRole } = await supabaseAdmin
        .from('roles')
        .select('id')
        .eq('name', 'ADMIN')
        .single()

      if (!adminRole) {
        return NextResponse.json({ success: false, message: 'ADMIN role not found' }, { status: 500 })
      }

      // Check if user already exists for this company
      const { data: existingUser } = await supabaseAdmin
        .from('users')
        .select('id, phone, role_id')
        .eq('party_id', company.id)
        .limit(1)

      if (existingUser && existingUser.length > 0) {
        // First, clear phone from any other user with same phone (to handle unique constraint)
        await supabaseAdmin
          .from('users')
          .update({ phone: null })
          .eq('phone', company.portal_phone)
          .neq('id', existingUser[0].id)

        // Update the existing user with phone and ADMIN role
        const { error: updateErr } = await supabaseAdmin
          .from('users')
          .update({ 
            phone: company.portal_phone,
            role_id: adminRole.id,
            status: 'ACTIVE'
          })
          .eq('id', existingUser[0].id)

        if (updateErr) {
          return NextResponse.json({
            success: false,
            message: 'Failed to update user: ' + updateErr.message
          }, { status: 500 })
        }

        // Also update the auth user's password
        const plainPassword = 'Admin@123'
        const { error: authErr } = await supabaseAdmin.auth.admin.updateUserById(existingUser[0].id, { password: plainPassword })

        if (authErr) {
          return NextResponse.json({
            success: false,
            message: 'Failed to update auth password: ' + authErr.message
          }, { status: 500 })
        }

        return NextResponse.json({
          success: true,
          message: 'Updated existing user for BLOOM BY SHANAYA with phone and ADMIN role',
          credentials: {
            phone: company.portal_phone,
            password: plainPassword
          }
        })
      }

      // Create auth user
      const companySuffix = company.id.substring(0, 8)
      const portalEmail = `${company.portal_phone}_${companySuffix}@portal.internal`
      const plainPassword = 'Admin@123'

      const { data: authCreated, error: authErr } = await supabaseAdmin.auth.admin.createUser({
        email: portalEmail,
        password: plainPassword,
        email_confirm: true,
      })

      if (authErr || !authCreated?.user) {
        return NextResponse.json({
          success: false,
          message: 'Failed to create auth user: ' + (authErr?.message || 'Unknown error')
        }, { status: 500 })
      }

      // Create user record
      const { error: userErr } = await supabaseAdmin.from('users').insert({
        id: authCreated.user.id,
        name: company.name + ' Admin',
        email: authCreated.user.email,
        phone: company.portal_phone,
        role_id: adminRole.id,
        party_id: company.id,
        status: 'ACTIVE',
      })

      if (userErr) {
        return NextResponse.json({
          success: false,
          message: 'Failed to create user record: ' + userErr.message
        }, { status: 500 })
      }

      return NextResponse.json({
        success: true,
        message: 'Created ADMIN user for BLOOM BY SHANAYA',
        credentials: {
          phone: company.portal_phone,
          password: plainPassword,
          email: portalEmail
        }
      })
    }

    if (migrationName === 'reset-bloom-password') {
      // Reset password for BLOOM BY SHANAYA admin user
      const companyName = 'BLOOM BY SHANAYA'
      
      // Find the company
      const { data: company, error: companyErr } = await supabaseAdmin
        .from('parties')
        .select('id, name, portal_phone')
        .ilike('name', '%BLOOM%')
        .single()

      if (companyErr || !company) {
        return NextResponse.json({ success: false, message: 'BLOOM BY SHANAYA company not found' }, { status: 404 })
      }

      // Find user for this company
      const { data: existingUser, error: userErr } = await supabaseAdmin
        .from('users')
        .select('id, phone, role_id')
        .eq('party_id', company.id)
        .single()

      if (userErr || !existingUser) {
        // Create user if doesn't exist
        const portalPhone = company.portal_phone || '8076239490'
        const phone = String(portalPhone).replace(/[^0-9]/g, '')
        const portalEmail = `${phone}_${company.id.substring(0, 8)}@portal.internal`
        const plainPassword = 'admin123'

        // Get ADMIN role
        const { data: roleData } = await supabaseAdmin
          .from('roles')
          .select('id')
          .eq('name', 'ADMIN')
          .single()

        // Create auth user
        const { data: authCreated, error: authErr } = await supabaseAdmin.auth.admin.createUser({
          email: portalEmail,
          password: plainPassword,
          email_confirm: true,
        })

        if (authErr || !authCreated?.user) {
          return NextResponse.json({
            success: false,
            message: 'Failed to create auth user: ' + (authErr?.message || 'Unknown error')
          }, { status: 500 })
        }

        // Create users record
        const { error: usersErr } = await supabaseAdmin.from('users').insert({
          id: authCreated.user.id,
          name: 'Admin',
          email: portalEmail,
          phone: phone,
          role_id: roleData?.id,
          party_id: company.id,
          status: 'ACTIVE',
        })

        if (usersErr) {
          await supabaseAdmin.auth.admin.deleteUser(authCreated.user.id)
          return NextResponse.json({
            success: false,
            message: 'Failed to create user record: ' + usersErr.message
          }, { status: 500 })
        }

        return NextResponse.json({
          success: true,
          message: 'Admin user created successfully',
          credentials: {
            phone: phone,
            password: plainPassword
          }
        })
      }

      // Reset password to admin123
      const plainPassword = 'admin123'
      const { error: authErr } = await supabaseAdmin.auth.admin.updateUserById(existingUser.id, { password: plainPassword })

      if (authErr) {
        return NextResponse.json({
          success: false,
          message: 'Failed to reset password: ' + authErr.message
        }, { status: 500 })
      }

      return NextResponse.json({
        success: true,
        message: 'Password reset successfully',
        credentials: {
          phone: company.portal_phone,
          password: plainPassword
        }
      })
    }

    if (migrationName === 'drop-phone-unique-constraint') {
      // Remove the unique constraint on phone to allow multiple staff accounts
      // (including multiple salesmen) to share a login mobile number.
      const { error: dropError } = await supabaseAdmin.rpc('exec_sql', {
        sql: `
          ALTER TABLE IF EXISTS public.users DROP CONSTRAINT IF EXISTS users_phone_key;
          ALTER TABLE IF EXISTS public.users DROP CONSTRAINT IF EXISTS users_phone_unique;
          ALTER TABLE IF EXISTS public.app_users DROP CONSTRAINT IF EXISTS app_users_phone_key;
          ALTER TABLE IF EXISTS public.app_users DROP CONSTRAINT IF EXISTS app_users_phone_unique;
        `
      })
      
      if (dropError && dropError.code !== 'PGRST202') {
        // PGRST202 = function doesn't exist, which is fine
        return NextResponse.json({ success: false, message: (dropError as any).message || 'Failed to drop constraint' }, { status: 500 })
      }

      // Also drop any phone unique index if it exists
      const { error: dropIndexError } = await supabaseAdmin.rpc('exec_sql', {
        sql: `
          DROP INDEX IF EXISTS public.users_phone_key;
          DROP INDEX IF EXISTS public.users_phone_idx;
          DROP INDEX IF EXISTS public.idx_users_phone;
          DROP INDEX IF EXISTS public.app_users_phone_key;
          DROP INDEX IF EXISTS public.app_users_phone_idx;
          DROP INDEX IF EXISTS public.idx_app_users_phone;
          DO $$
          BEGIN
            IF to_regclass('public.users') IS NOT NULL THEN
              CREATE INDEX IF NOT EXISTS idx_users_phone_lookup ON public.users(phone);
            END IF;
            IF to_regclass('public.app_users') IS NOT NULL THEN
              CREATE INDEX IF NOT EXISTS idx_app_users_phone_lookup ON public.app_users(phone);
            END IF;
          END $$;
          NOTIFY pgrst, 'reload schema';
        `
      })

      if (dropIndexError && dropIndexError.code !== 'PGRST202') {
        return NextResponse.json({ success: false, message: (dropIndexError as { message?: string }).message || 'Failed to drop phone index' }, { status: 500 })
      }

      return NextResponse.json({
        success: true,
        message: 'Phone unique constraint removed successfully. Multiple users and salesmen can now share a phone number.',
      })
    }

    if (migrationName === 'add-transaction-type-to-hsn') {
      // Add transaction_type column to hsn_codes table for GST templates
      const { error: alterError } = await supabaseAdmin.rpc('exec_sql', {
        sql: `ALTER TABLE public.hsn_codes ADD COLUMN IF NOT EXISTS transaction_type VARCHAR(10) DEFAULT 'intra' CHECK (transaction_type IN ('intra', 'inter'));`
      })
      
      if (alterError && alterError.code !== 'PGRST202') {
        return NextResponse.json({ success: false, message: (alterError as any).message || 'Failed to add transaction_type column' }, { status: 500 })
      }

      // Create index for faster querying
      await supabaseAdmin.rpc('exec_sql', {
        sql: `CREATE INDEX IF NOT EXISTS idx_hsn_codes_transaction_type ON public.hsn_codes(transaction_type);`
      })

      // Reload PostgREST schema cache so the new column is recognized
      await supabaseAdmin.rpc('exec_sql', { sql: `NOTIFY pgrst, 'reload schema';` })

      return NextResponse.json({
        success: true,
        message: 'transaction_type column added to hsn_codes table successfully. Schema cache reloaded.',
      })
    }

    if (migrationName === 'force-reload-schema') {
      // Force reload PostgREST schema cache using multiple methods
      try {
        // Method 1: NOTIFY
        await supabaseAdmin.rpc('exec_sql', { sql: `NOTIFY pgrst, 'reload schema';` })
      } catch (e) {
        console.log('NOTIFY failed, trying alternative method')
      }

      // Method 2: Reload schema via Supabase API
      try {
        await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/`, {
          method: 'POST',
          headers: {
            'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY!,
            'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=representation'
          },
          body: JSON.stringify({})
        })
      } catch (e) {
        console.log('Schema reload via API failed')
      }

      // Method 3: Grant permissions on the column
      await supabaseAdmin.rpc('exec_sql', {
        sql: `GRANT ALL ON public.hsn_codes TO postgres; GRANT ALL ON public.hsn_codes TO anon; GRANT ALL ON public.hsn_codes TO authenticated;`
      })

      return NextResponse.json({
        success: true,
        message: 'Schema cache reload attempted. Please restart your Supabase/PostgREST service if the column is still not visible.',
      })
    }

    if (migrationName === 'cleanup-orphaned-data') {
      // Clean up orphaned invoices that don't belong to any active company
      console.log('[MIGRATION] Starting orphaned data cleanup...')
      
      // Get all active company IDs
      const { data: activeCompanies } = await supabaseAdmin
        .from('parties')
        .select('id')
        .neq('status', 'DELETED')

      const activeCompanyIds = new Set((activeCompanies || []).map((c: { id: string }) => c.id))
      console.log('[MIGRATION] Active companies:', activeCompanyIds.size)

      // Delete invoices without valid company_id
      const { data: allInvoices, error: invoicesError } = await supabaseAdmin
        .from('invoices')
        .select('id, company_id')

      if (invoicesError) {
        console.error('[MIGRATION] Error fetching invoices:', invoicesError)
      } else {
        const orphanedInvoices = (allInvoices || []).filter((inv: { id: string; company_id: string | null }) => 
          !inv.company_id || !activeCompanyIds.has(inv.company_id)
        )
        console.log('[MIGRATION] Orphaned invoices to delete:', orphanedInvoices.length)
        
        for (const inv of orphanedInvoices) {
          await supabaseAdmin.from('invoice_items').delete().eq('invoice_id', inv.id)
          await supabaseAdmin.from('invoices').delete().eq('id', inv.id)
        }
      }

      // Delete orphaned delivery lots
      const { data: allLots } = await supabaseAdmin
        .from('delivery_lots')
        .select('id, company_id')

      if (allLots) {
        const orphanedLots = allLots.filter((lot: { id: string; company_id: string | null }) =>
          !lot.company_id || !activeCompanyIds.has(lot.company_id)
        )
        console.log('[MIGRATION] Orphaned delivery lots to delete:', orphanedLots.length)
        
        for (const lot of orphanedLots) {
          await supabaseAdmin.from('delivery_lots').delete().eq('id', lot.id)
        }
      }

      // Delete orphaned products
      const { data: allProducts } = await supabaseAdmin
        .from('products')
        .select('id, company_id')

      if (allProducts) {
        const orphanedProducts = allProducts.filter((prod: { id: string; company_id: string | null }) =>
          !prod.company_id || !activeCompanyIds.has(prod.company_id)
        )
        console.log('[MIGRATION] Orphaned products to delete:', orphanedProducts.length)
        
        for (const prod of orphanedProducts) {
          await supabaseAdmin.from('products').delete().eq('id', prod.id)
        }
      }

      // Delete orphaned HSN codes (GST templates)
      const { data: allHsn } = await supabaseAdmin
        .from('hsn_codes')
        .select('id, company_id')

      if (allHsn) {
        const orphanedHsn = allHsn.filter((hsn: { id: string; company_id: string | null }) =>
          !hsn.company_id || !activeCompanyIds.has(hsn.company_id)
        )
        console.log('[MIGRATION] Orphaned HSN codes to delete:', orphanedHsn.length)
        
        for (const hsn of orphanedHsn) {
          await supabaseAdmin.from('hsn_codes').delete().eq('id', hsn.id)
        }
      }

      return NextResponse.json({
        success: true,
        message: 'Orphaned data cleanup completed successfully.',
      })
    }

    if (migrationName === 'add-logo-and-invoice-requests') {
      const statements = [
        // Add logo_url to parties table
        `ALTER TABLE public.parties ADD COLUMN IF NOT EXISTS logo_url TEXT`,
        // Create invoice_requests table
        `CREATE TABLE IF NOT EXISTS public.invoice_requests (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          order_id UUID NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
          lot_id TEXT,
          requested_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
          party_id UUID NOT NULL REFERENCES public.parties(id) ON DELETE CASCADE,
          status VARCHAR(30) DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'CONFIRMED', 'REJECTED')),
          confirmed_at TIMESTAMP WITH TIME ZONE,
          confirmed_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
          invoice_number TEXT,
          notes TEXT,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        )`,
        `CREATE INDEX IF NOT EXISTS idx_invoice_requests_order_id ON public.invoice_requests(order_id)`,
        `CREATE INDEX IF NOT EXISTS idx_invoice_requests_party_id ON public.invoice_requests(party_id)`,
        `CREATE INDEX IF NOT EXISTS idx_invoice_requests_status ON public.invoice_requests(status)`,
        `NOTIFY pgrst, 'reload schema'`,
      ]
      for (const sql of statements) {
        const { error } = await supabaseAdmin.rpc('exec_sql', { sql })
        if (error && error.code !== 'PGRST202') {
          return NextResponse.json({ success: false, message: (error as any).message || 'Migration failed at: ' + sql.substring(0, 60) }, { status: 500 })
        }
      }
      return NextResponse.json({ success: true, message: 'logo_url column and invoice_requests table created successfully' })
    }



    if (migrationName === 'delivery-lots-rpc') {
      const statements = [
        `DROP FUNCTION IF EXISTS public.list_delivery_lots(uuid, text)`,
        `DROP FUNCTION IF EXISTS public.create_delivery_lot(uuid, uuid, text, text, text, text, uuid, text)`,
        `CREATE FUNCTION public.list_delivery_lots(p_company_id uuid, p_status text DEFAULT NULL)
RETURNS TABLE(
  id uuid,
  lot_number text,
  name text,
  dispatch_date text,
  destination text,
  vehicle_no text,
  notes text,
  status text,
  driver_id text,
  driver_name text,
  created_at text,
  updated_at text
) LANGUAGE sql SECURITY DEFINER STABLE AS $$
  SELECT
    dl.id,
    dl.lot_number::text,
    dl.name::text,
    dl.dispatch_date::text,
    dl.destination::text,
    dl.vehicle_no::text,
    dl.notes::text,
    dl.status::text,
    dl.driver_id::text,
    dl.driver_name::text,
    dl.created_at::text,
    dl.updated_at::text
  FROM public.delivery_lots dl
  WHERE (p_company_id IS NULL AND dl.company_id IS NULL)
     OR (p_company_id IS NOT NULL AND dl.company_id = p_company_id)
    AND (p_status IS NULL OR dl.status = p_status)
  ORDER BY dl.created_at DESC;
$$`,
        `CREATE FUNCTION public.create_delivery_lot(
          p_company_id uuid,
          p_created_by uuid,
          p_lot_number text,
          p_name text,
          p_dispatch_date text,
          p_destination text,
          p_vehicle_no text,
          p_notes text,
          p_driver_id uuid,
          p_driver_name text
        ) RETURNS TABLE(
          id uuid,
          lot_number text,
          name text,
          dispatch_date text,
          destination text,
          vehicle_no text,
          notes text,
          status text,
          driver_id text,
          driver_name text,
          created_at text,
          updated_at text
        ) LANGUAGE plpgsql SECURITY DEFINER AS $$
        DECLARE new_id uuid;
        BEGIN
          INSERT INTO public.delivery_lots (
            company_id, created_by, lot_number, name, dispatch_date, destination, vehicle_no, notes, status, driver_id, driver_name
          ) VALUES (
            p_company_id, p_created_by, p_lot_number, COALESCE(p_name, ''), NULLIF(p_dispatch_date, '')::date, COALESCE(p_destination, ''), COALESCE(p_vehicle_no, ''), COALESCE(p_notes, ''), 'OPEN', p_driver_id, COALESCE(p_driver_name, '')
          ) RETURNING delivery_lots.id INTO new_id;

          RETURN QUERY
          SELECT
            dl.id,
            dl.lot_number::text,
            dl.name::text,
            dl.dispatch_date::text,
            dl.destination::text,
            dl.vehicle_no::text,
            dl.notes::text,
            dl.status::text,
            dl.driver_id::text,
            dl.driver_name::text,
            dl.created_at::text,
            dl.updated_at::text
          FROM public.delivery_lots dl
          WHERE dl.id = new_id;
        END;
        $$`,
        `GRANT EXECUTE ON FUNCTION public.list_delivery_lots(uuid, text) TO service_role`,
        `GRANT EXECUTE ON FUNCTION public.list_delivery_lots(uuid, text) TO authenticated`,
        `GRANT EXECUTE ON FUNCTION public.create_delivery_lot(uuid, uuid, text, text, text, text, text, text, uuid, text) TO service_role`,
        `GRANT EXECUTE ON FUNCTION public.create_delivery_lot(uuid, uuid, text, text, text, text, text, text, uuid, text) TO authenticated`,
        `NOTIFY pgrst, 'reload schema'`,
      ]
      const errors: string[] = []
      for (const sql of statements) {
        const { error } = await supabaseAdmin.rpc('exec_sql', { sql })
        if (error && error.code !== 'PGRST202') {
          errors.push((error as any).message || 'Migration failed')
        }
      }
      return NextResponse.json({ success: errors.length === 0, message: 'delivery lots rpc migration completed', errors })
    }

    if (migrationName === 'delivery-lots-schema') {
      const statements = [
        `CREATE TABLE IF NOT EXISTS public.delivery_lots (
          id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          lot_number    text NOT NULL,
          name          text NOT NULL DEFAULT '',
          status        text NOT NULL DEFAULT 'OPEN',
          dispatch_date date,
          destination   text DEFAULT '',
          vehicle_no    text DEFAULT '',
          notes         text DEFAULT '',
          driver_id     uuid,
          driver_name   text DEFAULT '',
          company_id    uuid,
          created_by    uuid,
          created_at    timestamptz NOT NULL DEFAULT now(),
          updated_at    timestamptz NOT NULL DEFAULT now()
        )`,
        `CREATE TABLE IF NOT EXISTS public.delivery_lot_orders (
          id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          lot_id               uuid NOT NULL REFERENCES public.delivery_lots(id) ON DELETE CASCADE,
          order_id             uuid NOT NULL,
          invoice_number       text DEFAULT '',
          party_name           text DEFAULT '',
          grand_total          numeric DEFAULT 0,
          manufacturing_status text DEFAULT 'Not Started',
          created_at           timestamptz NOT NULL DEFAULT now()
        )`,
        `CREATE UNIQUE INDEX IF NOT EXISTS delivery_lot_orders_lot_order_idx
          ON public.delivery_lot_orders(lot_id, order_id)`,
        `CREATE INDEX IF NOT EXISTS delivery_lots_company_created_idx
          ON public.delivery_lots(company_id, created_at DESC)`,
        `DO $$
        BEGIN
          ALTER PUBLICATION supabase_realtime ADD TABLE public.delivery_lots;
        EXCEPTION
          WHEN duplicate_object THEN NULL;
          WHEN undefined_object THEN NULL;
        END $$`,
        `DO $$
        BEGIN
          ALTER PUBLICATION supabase_realtime ADD TABLE public.delivery_lot_orders;
        EXCEPTION
          WHEN duplicate_object THEN NULL;
          WHEN undefined_object THEN NULL;
        END $$`,
        `NOTIFY pgrst, 'reload schema'`,
      ]
      const errors: string[] = []
      for (const sql of statements) {
        const { error } = await supabaseAdmin.rpc('exec_sql', { sql })
        if (error && error.code !== 'PGRST202') {
          errors.push((error as any).message || sql.substring(0, 80))
        }
      }
      return NextResponse.json({ success: errors.length === 0, message: 'delivery lots schema migration completed', errors })
    }

    if (migrationName === 'add-procurement-status') {
      // Convert status column from enum to TEXT to support new statuses like PROCUREMENT
      const statements = [
        `ALTER TABLE public.orders ALTER COLUMN status DROP DEFAULT`,
        `ALTER TABLE public.orders ALTER COLUMN status TYPE TEXT USING status::TEXT`,
        `ALTER TABLE public.orders ALTER COLUMN status SET DEFAULT 'PENDING'`,
        `NOTIFY pgrst, 'reload schema'`,
      ]
      const errors: string[] = []
      for (const sql of statements) {
        const { error } = await supabaseAdmin.rpc('exec_sql', { sql })
        if (error && error.code !== 'PGRST202') {
          errors.push(`${sql.substring(0, 40)}: ${(error as any).message}`)
        }
      }
      return NextResponse.json({ success: true, message: 'Migration completed', errors })
    }

    if (migrationName === 'set-order-procurement') {
      const oid = body.orderId
      if (!oid) return NextResponse.json({ success: false, message: 'orderId required' }, { status: 400 })
      const { error } = await supabaseAdmin.rpc('exec_sql', {
        sql: `UPDATE public.orders SET status = 'PROCUREMENT' WHERE id = '${oid}'`
      })
      if (error) return NextResponse.json({ success: false, message: (error as any).message }, { status: 500 })
      return NextResponse.json({ success: true, message: 'Order status set to PROCUREMENT' })
    }

    if (migrationName === 'create-beat-routes-table') {
      const statements = [
        `CREATE TABLE IF NOT EXISTS public.beat_routes (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          name TEXT NOT NULL,
          salesman_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
          company_id UUID REFERENCES public.parties(id) ON DELETE CASCADE,
          is_active BOOLEAN DEFAULT true,
          created_at TIMESTAMPTZ DEFAULT now(),
          updated_at TIMESTAMPTZ DEFAULT now()
        )`,
        `CREATE TABLE IF NOT EXISTS public.route_stops (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          route_id UUID NOT NULL REFERENCES public.beat_routes(id) ON DELETE CASCADE,
          party_id UUID REFERENCES public.parties(id) ON DELETE SET NULL,
          sequence INTEGER DEFAULT 0,
          notes TEXT,
          created_at TIMESTAMPTZ DEFAULT now(),
          updated_at TIMESTAMPTZ DEFAULT now()
        )`,
        `CREATE INDEX IF NOT EXISTS idx_beat_routes_company ON public.beat_routes(company_id)`,
        `CREATE INDEX IF NOT EXISTS idx_beat_routes_salesman ON public.beat_routes(salesman_id)`,
        `CREATE INDEX IF NOT EXISTS idx_route_stops_route ON public.route_stops(route_id)`,
        `CREATE INDEX IF NOT EXISTS idx_route_stops_party ON public.route_stops(party_id)`,
        `ALTER TABLE public.beat_routes ENABLE ROW LEVEL SECURITY`,
        `ALTER TABLE public.route_stops ENABLE ROW LEVEL SECURITY`,
        `GRANT ALL ON public.beat_routes TO service_role`,
        `GRANT ALL ON public.route_stops TO service_role`,
        `NOTIFY pgrst, 'reload schema'`,
      ]
      const errors: string[] = []
      for (const sql of statements) {
        const { error } = await supabaseAdmin.rpc('exec_sql', { sql })
        if (error && error.code !== 'PGRST202') {
          errors.push(`${sql.substring(0, 40)}: ${(error as any).message}`)
        }
      }
      return NextResponse.json({ success: true, message: 'beat_routes and route_stops tables created', errors })
    }

    if (migrationName === 'add-party-balance-columns') {
      const statements = [
        `ALTER TABLE public.parties ADD COLUMN IF NOT EXISTS opening_balance FLOAT NOT NULL DEFAULT 0`,
        `ALTER TABLE public.parties ADD COLUMN IF NOT EXISTS wallet_balance FLOAT NOT NULL DEFAULT 0`,
        `CREATE INDEX IF NOT EXISTS idx_parties_opening_balance ON public.parties(opening_balance)`,
        `NOTIFY pgrst, 'reload schema'`,
      ]
      for (const sql of statements) {
        const { error } = await supabaseAdmin.rpc('exec_sql', { sql })
        if (error && error.code !== 'PGRST202') {
          return NextResponse.json({ success: false, message: (error as any).message || 'Migration failed' }, { status: 500 })
        }
      }
      return NextResponse.json({ success: true, message: 'opening_balance and wallet_balance columns added to parties table' })
    }

    if (migrationName === 'add-employee-code-to-users') {
      const statements = [
        `ALTER TABLE public.users ADD COLUMN IF NOT EXISTS employee_code TEXT`,
        `CREATE INDEX IF NOT EXISTS idx_users_employee_code ON public.users(employee_code)`,
        `NOTIFY pgrst, 'reload schema'`,
      ]
      for (const sql of statements) {
        const { error } = await supabaseAdmin.rpc('exec_sql', { sql })
        if (error && error.code !== 'PGRST202') {
          return NextResponse.json({ success: false, message: (error as any).message || 'Migration failed' }, { status: 500 })
        }
      }
      return NextResponse.json({ success: true, message: 'employee_code column added to users table' })
    }

    if (migrationName === 'add-proof-url-to-payments') {
      const statements = [
        `ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS proof_url TEXT`,
        `NOTIFY pgrst, 'reload schema'`,
      ]
      for (const sql of statements) {
        const { error } = await supabaseAdmin.rpc('exec_sql', { sql })
        if (error && error.code !== 'PGRST202') {
          return NextResponse.json({ success: false, message: (error as { message?: string }).message || 'Migration failed' }, { status: 500 })
        }
      }
      return NextResponse.json({ success: true, message: 'proof_url column added to payments table' })
    }

    if (migrationName === 'fix-schemes-party-type-constraint') {
      const { error: dropError } = await supabaseAdmin.rpc('exec_sql', {
        sql: `ALTER TABLE public.schemes DROP CONSTRAINT IF EXISTS schemes_applicable_party_type_check;`
      })
      if (dropError) {
        return NextResponse.json({ success: false, message: (dropError as any).message || 'Failed to drop constraint' }, { status: 500 })
      }

      const { error: addError } = await supabaseAdmin.rpc('exec_sql', {
        sql: `ALTER TABLE public.schemes ADD CONSTRAINT schemes_applicable_party_type_check CHECK (applicable_party_type IN ('COMPANY','CNF','SUPER_DEALER','RETAILER','SALESMAN','MANUFACTURER','ALL','INDIVIDUAL'));`
      })
      if (addError) {
        return NextResponse.json({ success: false, message: (addError as any).message || 'Failed to add constraint' }, { status: 500 })
      }

      await supabaseAdmin.rpc('exec_sql', { sql: `NOTIFY pgrst, 'reload schema';` })

      return NextResponse.json({ success: true, message: 'schemes applicable_party_type constraint updated successfully' })
    }

    return NextResponse.json({ success: false, message: 'Unknown migration' }, { status: 400 })
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : 'Failed to execute migration' },
      { status: 500 }
    )
  }
}
