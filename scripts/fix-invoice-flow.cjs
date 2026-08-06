const fs = require('fs');
const pg = require('pg');
const env = fs.readFileSync('.env.local', 'utf8');
const m = env.match(/SUPABASE_DB_URL=(.*)/);
if (!m) throw new Error('SUPABASE_DB_URL missing');
const url = m[1].trim();
const sql = `
alter table public.orders add column if not exists billing_party_id uuid;

update public.orders
set billing_party_id = buyer_id
where billing_party_id is null and buyer_id is not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'orders_billing_party_id_fkey'
  ) then
    alter table public.orders
      add constraint orders_billing_party_id_fkey
      foreign key (billing_party_id) references public.parties(id) on delete set null;
  end if;
end$$;

create index if not exists idx_orders_billing_party_id on public.orders(billing_party_id);

create table if not exists public.invoice_requests (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  lot_id text,
  requested_by uuid null,
  party_id uuid not null references public.parties(id) on delete cascade,
  status varchar(30) default 'PENDING' check (status in ('PENDING', 'CONFIRMED', 'REJECTED')),
  confirmed_at timestamptz,
  confirmed_by uuid null,
  invoice_number text,
  notes text,
  company_id uuid null,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table public.invoice_requests add column if not exists company_id uuid;
alter table public.invoice_requests add column if not exists requested_by uuid;
alter table public.invoice_requests add column if not exists confirmed_by uuid;

create index if not exists idx_invoice_requests_order_id on public.invoice_requests(order_id);
create index if not exists idx_invoice_requests_party_id on public.invoice_requests(party_id);
create index if not exists idx_invoice_requests_status on public.invoice_requests(status);
create index if not exists idx_invoice_requests_company_id on public.invoice_requests(company_id);
`;
(async () => {
  const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query(sql);
  const ordersCols = await client.query("select column_name from information_schema.columns where table_schema='public' and table_name='orders' order by ordinal_position");
  const invoiceCols = await client.query("select column_name from information_schema.columns where table_schema='public' and table_name='invoice_requests' order by ordinal_position");
  const invoiceCount = await client.query("select count(*)::int as count from public.invoice_requests");
  console.log(JSON.stringify({
    orders_columns: ordersCols.rows.map(r => r.column_name),
    invoice_request_columns: invoiceCols.rows.map(r => r.column_name),
    invoice_request_count: invoiceCount.rows[0].count,
  }, null, 2));
  await client.end();
})().catch(async (err) => {
  console.error(err);
  process.exit(1);
});
