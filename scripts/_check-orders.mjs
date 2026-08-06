import { createClient } from '@supabase/supabase-js';
const sb = createClient(
  'https://nsdmqbnfnauznyksxckh.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5zZG1xYm5mbmF1em55a3N4Y2toIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NDE2NjcxOSwiZXhwIjoyMDg5NzQyNzE5fQ.t05iPC_0kFJFqs7eFC4P2pOI5ojyk2pKVCTT7K4_vN0'
);

async function check() {
  // Check orders table
  const { data, error } = await sb.from('orders').select('*').limit(1);
  console.log('=== ORDERS TABLE ===');
  if (error) {
    console.log('ERROR:', JSON.stringify(error, null, 2));
  } else {
    console.log('OK, row count:', data.length);
    if (data.length > 0) console.log('Columns:', Object.keys(data[0]).join(', '));
  }

  // Check order_items table
  const { data: d2, error: e2 } = await sb.from('order_items').select('*').limit(1);
  console.log('\n=== ORDER_ITEMS TABLE ===');
  if (e2) {
    console.log('ERROR:', JSON.stringify(e2, null, 2));
  } else {
    console.log('OK, row count:', d2.length);
    if (d2.length > 0) console.log('Columns:', Object.keys(d2[0]).join(', '));
  }

  // Try inserting a test order to see exact error
  console.log('\n=== TEST INSERT INTO ORDERS ===');
  const seq = Date.now().toString(36).toUpperCase();
  const { data: d3, error: e3 } = await sb.from('orders').insert({
    order_number: `TEST/DEL/${seq}`,
    order_type: 'STANDARD',
    billing_party_id: '00000000-0000-0000-0000-000000000000', // dummy
    billing_path: 'A',
    subtotal: 100,
    grand_total: 100,
    order_status: 'SUBMITTED',
  }).select().single();
  
  if (e3) {
    console.log('INSERT ERROR:', JSON.stringify(e3, null, 2));
  } else {
    console.log('INSERT OK, id:', d3.id);
    // Clean up
    await sb.from('orders').delete().eq('id', d3.id);
    console.log('Cleaned up test row');
  }
}

check();
