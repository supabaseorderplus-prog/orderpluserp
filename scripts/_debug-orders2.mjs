import { createClient } from '@supabase/supabase-js';

const sb = createClient(
  'https://nsdmqbnfnauznyksxckh.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5zZG1xYm5mbmF1em55a3N4Y2toIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NDE2NjcxOSwiZXhwIjoyMDg5NzQyNzE5fQ.t05iPC_0kFJFqs7eFC4P2pOI5ojyk2pKVCTT7K4_vN0'
);

async function main() {
  // Get actual columns of orders table
  const { data, error } = await sb.from('orders').select('*').limit(1);
  if (error) {
    console.log('Error:', error.message);
  } else if (data.length > 0) {
    console.log('Orders columns:', Object.keys(data[0]).join(', '));
  } else {
    console.log('Orders table empty, trying to read column info via SQL...');
    const { data: cols, error: colErr } = await sb.rpc('exec_sql', {
      query: "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'orders' ORDER BY ordinal_position"
    });
    if (colErr) {
      // Try inserting with just an empty obj to see required cols
      console.log('Trying empty insert to see columns...');
      const r = await sb.from('orders').insert({}).select().single();
      console.log('Error:', r.error?.message);
    } else {
      console.log(cols);
    }
  }

  // Also check order_items columns
  const { data: d2, error: e2 } = await sb.from('order_items').select('*').limit(1);
  if (e2) console.log('order_items error:', e2.message);
  else if (d2.length > 0) console.log('Order_items columns:', Object.keys(d2[0]).join(', '));
  else console.log('order_items table is empty');

  // Try querying orders with a valid SELECT to check which cols exist
  const tests = ['id', 'order_number', 'billing_party_id', 'party_id', 'status', 'order_status', 'order_type', 'subtotal', 'grand_total', 'company_id', 'created_at', 'billing_path', 'territory_id', 'price_list_id', 'notes', 'delivery_date', 'salesman_id'];
  for (const col of tests) {
    const r = await sb.from('orders').select(col).limit(0);
    console.log(`  orders.${col}:`, r.error ? 'NO' : 'YES');
  }
}

main().catch(console.error);
