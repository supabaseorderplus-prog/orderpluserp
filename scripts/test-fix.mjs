const apis = [
  ['GET', 'api/v1/cd-config'],
  ['GET', 'api/v1/inventory'],
  ['GET', 'api/v1/tracking/routes'],
  ['GET', 'api/v1/tracking/live'],
]

for (const [method, path] of apis) {
  try {
    const r = await fetch('http://localhost:3000/' + path, { method })
    const body = await r.text()
    const ok = r.status < 500 ? 'OK' : 'FAIL'
    console.log(ok, r.status, path, body.substring(0, 120))
  } catch (e) {
    console.log('ERR', path, e.message)
  }
}
