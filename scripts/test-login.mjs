const r = await fetch('http://localhost:3000/api/v1/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'admin@hometech.in', password: 'Password@123' }),
})
const d = await r.json()
console.log(JSON.stringify(d, null, 2))
