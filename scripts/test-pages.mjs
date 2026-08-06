const pages = [
  'dashboard',
  'dashboard/orders',
  'dashboard/parties',
  'dashboard/products',
  'dashboard/invoices/new',
  'dashboard/payments',
  'dashboard/analytics',
  'dashboard/ledgers',
  'dashboard/pricing',
  'dashboard/users',
  'dashboard/geography',
  'dashboard/schemes',
  'dashboard/inventory',
  'dashboard/tracking',
  'dashboard/routes',
  'dashboard/rankings',
  'dashboard/exports',
  'dashboard/admin',
]

for (const p of pages) {
  try {
    const r = await fetch('http://localhost:3000/' + p)
    const ok = r.status < 500 ? 'OK' : 'FAIL'
    console.log(ok, r.status, p)
  } catch (e) {
    console.log('ERR', p, e.message)
  }
}
