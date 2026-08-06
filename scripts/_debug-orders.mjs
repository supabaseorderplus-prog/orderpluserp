import { createClient } from '@supabase/supabase-js';

const sb = createClient(
  'https://nsdmqbnfnauznyksxckh.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5zZG1xYm5mbmF1em55a3N4Y2toIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NDE2NjcxOSwiZXhwIjoyMDg5NzQyNzE5fQ.t05iPC_0kFJFqs7eFC4P2pOI5ojyk2pKVCTT7K4_vN0'
);

async function main() {
  // 1. Check orders table
  console.log('--- ORDERS TABLE ---');
  const r1 = await sb.from('orders').select('*').limit(0);
  console.log('exists?', r1.error ? 'NO: ' + r1.error.message : 'YES');

  // 2. Check order_items table
  console.log('--- ORDER_ITEMS TABLE ---');
  const r2 = await sb.from('order_items').select('*').limit(0);
  console.log('exists?', r2.error ? 'NO: ' + r2.error.message : 'YES');

  // 3. Try a test insert
  console.log('--- TEST ORDER INSERT ---');
  const r3 = await sb.from('orders').insert({
    order_number: 'TEST-DELETE-ME',
    order_type: 'STANDARD',
    billing_party_id: '00000000-0000-0000-0000-000000000000',
    billing_path: 'A',
    subtotal: 0,
    grand_total: 0,
    order_status: 'SUBMITTED',
  }).select().single();
  if (r3.error) {
    console.log('INSERT ERROR:', r3.error.message, r3.error.code, r3.error.details);
  } else {
    console.log('INSERT OK:', r3.data.id);
    await sb.from('orders').delete().eq('id', r3.data.id);
  }

  // 4. List all tables to see what we have
  console.log('--- ALL TABLES ---');
  const r4 = await sb.rpc('get_party_descendants', { root_id: '00000000-0000-0000-0000-000000000000' });
  console.log('RPC works?', r4.error ? 'NO' : 'YES');
}

main().catch(console.error);
