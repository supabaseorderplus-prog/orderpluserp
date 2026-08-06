const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const sql = `
  CREATE TABLE IF NOT EXISTS public.wallets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    role_id UUID REFERENCES public.roles(id) ON DELETE SET NULL,
    balance NUMERIC(15,2) NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    UNIQUE(user_id)
  );

  CREATE INDEX IF NOT EXISTS idx_wallets_user ON public.wallets(user_id);
  CREATE INDEX IF NOT EXISTS idx_wallets_role ON public.wallets(role_id);
  ALTER TABLE public.wallets DISABLE ROW LEVEL SECURITY;

  INSERT INTO public.wallets (user_id, role_id, balance)
  SELECT u.id, u.role_id, 0
  FROM public.users u
  WHERE u.role_id IN (
    '5baf0593-cbf3-4055-9ecb-6b677428d902',
    '6939dd37-38b1-480f-8d99-7bcbb62fd7cd',
    '8c37ee59-6b4e-4769-847f-894784f9087b',
    'afdb5d5b-f8c1-47d3-86c4-0de438f87428'
  )
  AND u.status = 'ACTIVE'
  ON CONFLICT (user_id) DO NOTHING;
`;

async function createTable() {
  // Supabase doesn't expose a direct SQL execution endpoint via the JS client
  // We need to use the Management API or run this in the Dashboard
  console.log('Please run the following SQL in your Supabase Dashboard SQL Editor:');
  console.log('\n---START SQL---\n');
  console.log(sql);
  console.log('\n---END SQL---\n');
}

createTable();
