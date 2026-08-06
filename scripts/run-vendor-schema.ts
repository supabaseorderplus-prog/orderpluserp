import { ensureVendorsSchema } from '../src/lib/vendors'

async function main() {
  const ok = await ensureVendorsSchema()
  console.log(JSON.stringify({ ok }))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
