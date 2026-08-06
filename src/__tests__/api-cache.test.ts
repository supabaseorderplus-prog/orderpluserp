import { describe, it, expect, beforeEach, vi } from 'vitest'

// Exercises the GET stale-while-revalidate micro-cache + in-flight de-dup added to
// src/lib/api.ts. This is the single chokepoint every dashboard page fetches through,
// so a regression here would affect the whole app — hence direct behavioural coverage.

function makeJsonResponse(payload: unknown) {
  return {
    ok: true,
    status: 200,
    headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  } as unknown as Response
}

describe('api() GET micro-cache + de-dup', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  let api: typeof import('@/lib/api').api
  let clearApiCache: typeof import('@/lib/api').clearApiCache

  beforeEach(async () => {
    const store = new Map<string, string>([
      ['accessToken', 'token-abc-1234567890'],
      ['user', JSON.stringify({ role: 'SALESMAN', party_id: 'p1' })],
    ])
    // Minimal browser globals so api()'s window/localStorage branches run.
    ;(globalThis as Record<string, unknown>).window = {}
    ;(globalThis as Record<string, unknown>).localStorage = {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    }

    fetchMock = vi.fn(async () => makeJsonResponse({ success: true, data: [1, 2, 3] }))
    ;(globalThis as Record<string, unknown>).fetch = fetchMock

    // Re-import fresh each test so module-level caches start empty.
    vi.resetModules()
    const mod = await import('@/lib/api')
    api = mod.api
    clearApiCache = mod.clearApiCache
    clearApiCache()
  })

  it('de-duplicates concurrent identical GETs into a single network request', async () => {
    const [a, b] = await Promise.all([
      api('/api/v1/orders'),
      api('/api/v1/orders'),
    ])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(a).toEqual({ success: true, data: [1, 2, 3] })
    expect(b).toEqual(a)
  })

  it('serves a cached GET within the TTL window without hitting the network again', async () => {
    await api('/api/v1/orders')
    await api('/api/v1/orders')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('returns a clone so a caller mutating the result cannot corrupt the cache', async () => {
    const first = (await api('/api/v1/orders')) as { data: number[] }
    first.data.push(999)
    const second = (await api('/api/v1/orders')) as { data: number[] }
    expect(second.data).toEqual([1, 2, 3])
  })

  it('bypasses the cache when noCache is set', async () => {
    await api('/api/v1/orders')
    await api('/api/v1/orders', { noCache: true })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('flushes cached reads after a mutation so the next GET is fresh', async () => {
    await api('/api/v1/orders')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await api('/api/v1/orders', { method: 'POST', body: { x: 1 } })
    await api('/api/v1/orders')
    // GET(1) + POST(1) + fresh GET(1) = 3
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('does not share cache across different scopes (company/user)', async () => {
    await api('/api/v1/orders')
    // Switch active company → key changes → must refetch.
    ;((globalThis as Record<string, unknown>).localStorage as { getItem: (key: string) => string | null }).getItem = (k: string) => {
      if (k === 'accessToken') return 'token-abc-1234567890'
      if (k === 'user') return JSON.stringify({ role: 'ADMIN', party_id: 'p1' })
      if (k === 'activeCompanyId') return 'company-2'
      return null
    }
    await api('/api/v1/orders')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
