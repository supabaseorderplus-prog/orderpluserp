import { createClient } from '@supabase/supabase-js';

const sb = createClient(
  'https://nsdmqbnfnauznyksxckh.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5zZG1xYm5mbmF1em55a3N4Y2toIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NDE2NjcxOSwiZXhwIjoyMDg5NzQyNzE5fQ.t05iPC_0kFJFqs7eFC4P2pOI5ojyk2pKVCTT7K4_vN0'
);

async function main() {
  // Check many potential column names
  const cols = [
    'id', 'order_number', 'order_type', 'status', 'order_status',
    'billing_party_id', 'party_id', 'customer_id', 'buyer_id',
    'billing_path', 'territory_id', 'price_list_id', 'salesman_id',
    'subtotal', 'grand_total', 'total', 'discount', 'tax',
    'notes', 'delivery_date', 'created_at', 'updated_at',
    'company_id', 'created_by', 'is_cancelled',
    'amount_paid', 'amount_outstanding', 'payment_status',
    'supply_date', 'due_date', 'invoice_id'
  ];
  
  const existing = [];
  for (const col of cols) {
    const r = await sb.from('orders').select(col).limit(0);
    if (!r.error) existing.push(col);
  }
  console.log('ORDERS columns:', existing.join(', '));

  // Check order_items columns
  const itemCols = [
    'id', 'order_id', 'product_id', 'quantity', 'unit_price', 'line_total',
    'notes', 'created_at', 'discount_percent', 'discount_amount',
    'taxable_amount', 'gst_rate', 'cgst_amount', 'sgst_amount', 'igst_amount',
    'hsn_code', 'sku', 'price_list_id', 'status'
  ];
  
  const existingItems = [];
  for (const col of itemCols) {
    const r = await sb.from('order_items').select(col).limit(0);
    if (!r.error) existingItems.push(col);
  }
  console.log('ORDER_ITEMS columns:', existingItems.join(', '));

  // Test insert with minimal valid data
  console.log('\n--- Test minimal insert ---');
  const r = await sb.from('orders').insert({
    order_number: 'TEST-DEL-001',
    order_type: 'STANDARD',
    subtotal: 100,
    grand_total: 100,
    status: 'PENDING',
  }).select().single();
  
  if (r.error) {
    console.log('ERROR:', r.error.message, r.error.code);
  } else {
    console.log('SUCCESS! Full row:', JSON.stringify(r.data, null, 2));
    // Clean up
    await sb.from('orders').delete().eq('id', r.data.id);
    console.log('Cleaned up');
  }
}

main().catch(console.error);
