import pg from 'pg'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Simple .env.local parser
function getDatabaseUrl() {
  const envPath = path.join(__dirname, '..', '.env.local')
  if (!fs.existsSync(envPath)) return null
  
  const content = fs.readFileSync(envPath, 'utf8')
  const lines = content.split('\n')
  for (const line of lines) {
    if (line.startsWith('DATABASE_URL=')) {
      return line.split('DATABASE_URL=')[1].trim()
    }
  }
  return null
}

const databaseUrl = getDatabaseUrl()

if (!databaseUrl) {
  console.error('Error: DATABASE_URL not found in .env.local')
  process.exit(1)
}

async function forceCacheReload() {
  const client = new pg.Client({
    connectionString: databaseUrl,
    ssl: { rejectUnauthorized: false }
  })

  try {
    console.log('Connecting to database directly...')
    await client.connect()
    console.log('Connected!')

    console.log("Executing: NOTIFY pgrst, 'reload schema';")
    await client.query("NOTIFY pgrst, 'reload schema';")
    console.log('Successfully sent reload signal to PostgREST!')

    console.log('Waiting 2 seconds for cache to update...')
    await new Promise(resolve => setTimeout(resolve, 2000))

    console.log('Schema reload process complete.')
  } catch (error) {
    console.error('Direct DB connection failed:', error.message)
  } finally {
    await client.end()
  }
}

forceCacheReload()
