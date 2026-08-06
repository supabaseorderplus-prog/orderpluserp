import fs from 'node:fs'
import dns from 'node:dns/promises'
import path from 'node:path'

type PgClientConfig = {
  connectionString?: string
  ssl?: { rejectUnauthorized: boolean; servername?: string }
  host?: string
  port?: number
  user?: string
  password?: string
  database?: string
}

function readEnvFileValue(key: string): string | undefined {
  try {
    const envPath = path.join(process.cwd(), '.env.local')
    if (!fs.existsSync(envPath)) return undefined
    const content = fs.readFileSync(envPath, 'utf8')
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq === -1) continue
      const name = trimmed.slice(0, eq).trim()
      if (name !== key) continue
      const raw = trimmed.slice(eq + 1).trim()
      return raw.replace(/^['"]|['"]$/g, '')
    }
  } catch (err) {
    console.warn('[direct-sql] env file read failed:', err instanceof Error ? err.message : err)
  }
  return undefined
}

function getDbUrl(): string | undefined {
  return (
    process.env.SUPABASE_POOLER_URL ||
    process.env.DATABASE_POOL_URL ||
    process.env.SUPABASE_DB_URL ||
    process.env.DATABASE_URL ||
    readEnvFileValue('SUPABASE_POOLER_URL') ||
    readEnvFileValue('DATABASE_POOL_URL') ||
    readEnvFileValue('SUPABASE_DB_URL') ||
    readEnvFileValue('DATABASE_URL')
  )
}

async function buildPgConfig(dbUrl: string): Promise<PgClientConfig> {
  const ssl = dbUrl.includes('supabase') ? { rejectUnauthorized: false } : undefined

  try {
    const parsed = new URL(dbUrl)
    const hostname = parsed.hostname
    if (!hostname) {
      return { connectionString: dbUrl, ssl }
    }

    const port = parsed.port ? Number(parsed.port) : 5432
    const user = decodeURIComponent(parsed.username)
    const password = decodeURIComponent(parsed.password)
    const database = parsed.pathname.replace(/^\//, '')

    try {
      const ipv4 = await dns.lookup(hostname, { family: 4 })
      return {
        host: ipv4.address,
        port,
        user,
        password,
        database,
        ssl: ssl ? { ...ssl, servername: hostname } : undefined,
      }
    } catch (ipv4Err) {
      console.warn(
        '[direct-sql] IPv4 resolution failed, trying hostname directly:',
        ipv4Err instanceof Error ? ipv4Err.message : ipv4Err,
      )
      return {
        host: hostname,
        port,
        user,
        password,
        database,
        ssl,
      }
    }
  } catch (err) {
    console.warn('[direct-sql] IPv4 resolution failed, falling back to default connection string:', err instanceof Error ? err.message : err)
    return { connectionString: dbUrl, ssl }
  }
}

// A single shared connection pool for the whole process. Previously every call
// opened a brand-new client (DNS lookup + TLS + auth handshake) and closed it,
// which under concurrency exhausted Postgres' connection limit and added
// hundreds of ms of handshake latency to *every* query. The pool reuses warm
// connections and caps concurrency so a traffic spike can't open unbounded
// sockets. Stored on globalThis so Next.js HMR in dev doesn't leak pools.
type PgPoolLike = {
  query: (sql: string) => Promise<{ rows?: unknown[] }>
  on: (event: 'error', cb: (err: Error) => void) => void
}

const globalForPg = globalThis as unknown as {
  __pgPool?: PgPoolLike | null
  __pgPoolInit?: Promise<PgPoolLike | null>
}

const PG_POOL_MAX = Number(process.env.PG_POOL_MAX || 10)

async function getPool(): Promise<PgPoolLike | null> {
  if (globalForPg.__pgPool !== undefined && globalForPg.__pgPool !== null) {
    return globalForPg.__pgPool
  }
  if (globalForPg.__pgPoolInit) return globalForPg.__pgPoolInit

  globalForPg.__pgPoolInit = (async () => {
    const dbUrl = getDbUrl()
    if (!dbUrl) {
      globalForPg.__pgPool = null
      return null
    }
    try {
      // pg is CommonJS; depending on @types/pg version the Pool ctor is exposed
      // on the namespace or under `default`. Resolve defensively.
      const pgModule = (await import('pg')) as unknown as {
        Pool?: new (config: unknown) => PgPoolLike
        default?: { Pool: new (config: unknown) => PgPoolLike }
      }
      const PoolCtor = pgModule.Pool ?? pgModule.default?.Pool
      if (!PoolCtor) {
        console.warn('[direct-sql] pg.Pool constructor not available')
        globalForPg.__pgPool = null
        return null
      }
      const config = await buildPgConfig(dbUrl)
      const pool = new PoolCtor({
        ...config,
        max: PG_POOL_MAX,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 10_000,
        allowExitOnIdle: true,
      })
      // An idle client erroring out must not crash the process.
      pool.on('error', (err) => {
        console.warn('[direct-sql] idle pool client error:', err?.message ?? err)
      })
      globalForPg.__pgPool = pool
      return pool
    } catch (err) {
      console.warn('[direct-sql] pool init failed:', err instanceof Error ? err.message : err)
      globalForPg.__pgPool = null
      return null
    } finally {
      globalForPg.__pgPoolInit = undefined
    }
  })()

  return globalForPg.__pgPoolInit
}

export async function runDirectSql(sql: string): Promise<boolean> {
  const pool = await getPool()
  if (!pool) return false
  try {
    await pool.query(sql)
    return true
  } catch (err) {
    console.warn('[direct-sql] failed:', err instanceof Error ? err.message : err)
    return false
  }
}

export async function queryDirectSql<T = Record<string, unknown>>(sql: string): Promise<T[] | null> {
  const pool = await getPool()
  if (!pool) return null
  try {
    const result = await pool.query(sql)
    return (result.rows || []) as T[]
  } catch (err) {
    console.warn('[direct-sql] query failed:', err instanceof Error ? err.message : err)
    return null
  }
}


export async function executeDirectSql<T = Record<string, unknown>>(sql: string): Promise<T[] | null> {
  const pool = await getPool()
  if (!pool) return null
  try {
    const result = await pool.query(sql)
    return (result.rows || []) as T[]
  } catch (err) {
    console.warn('[direct-sql] execute failed:', err instanceof Error ? err.message : err)
    return null
  }
}
