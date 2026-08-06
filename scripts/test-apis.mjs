const apis = [
  ['GET', 'api/v1/parties'],
  ['GET', 'api/v1/products'],
  ['GET', 'api/v1/invoices'],
  ['GET', 'api/v1/geography'],
  ['GET', 'api/v1/analytics/dashboard'],
  ['GET', 'api/v1/party-types'],
  ['GET', 'api/v1/users'],
  ['GET', 'api/v1/schemes'],
  ['GET', 'api/v1/gst-config'],
  ['GET', 'api/v1/cd-config'],
  ['GET', 'api/v1/payments'],
  ['GET', 'api/v1/rankings'],
  ['GET', 'api/v1/inventory'],
  ['GET', 'api/v1/analytics/top-buyers'],
  ['GET', 'api/v1/analytics/top-products'],
  ['GET', 'api/v1/tracking/routes'],
  ['GET', 'api/v1/tracking/live'],
]

for (const [method, path] of apis) {
  try {
    const r = await fetch('http://localhost:3000/' + path, { method })
    const ok = r.status < 500 ? 'OK' : 'FAIL'
    console.log(ok, r.status, path)
  } catch (e) {
    console.log('ERR', path, e.message)
  }
}
