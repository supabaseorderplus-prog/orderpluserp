import { describe, it, expect } from 'vitest'
import { IN_FILTER_MAX_IDS, chunkIds, fetchAllInChunks, fetchAllInChunksPaged } from '@/lib/supabase-in-chunks'

const makeIds = (count: number) => Array.from({ length: count }, (_, i) => `id-${i}`)

describe('chunkIds', () => {
  it('returns a single chunk when the list fits the limit', () => {
    const ids = makeIds(IN_FILTER_MAX_IDS)
    expect(chunkIds(ids)).toEqual([ids])
  })

  it('splits oversized lists into limit-sized chunks preserving order', () => {
    const ids = makeIds(IN_FILTER_MAX_IDS * 2 + 7)
    const chunks = chunkIds(ids)
    expect(chunks).toHaveLength(3)
    expect(chunks[0]).toHaveLength(IN_FILTER_MAX_IDS)
    expect(chunks[1]).toHaveLength(IN_FILTER_MAX_IDS)
    expect(chunks[2]).toHaveLength(7)
    expect(chunks.flat()).toEqual(ids)
  })

  it('returns no chunks for an empty list', () => {
    expect(chunkIds([])).toEqual([])
  })

  it('rejects a non-positive chunk size', () => {
    expect(() => chunkIds(makeIds(3), 0)).toThrow()
  })
})

describe('fetchAllInChunks', () => {
  it('concatenates rows from every chunk', async () => {
    const ids = makeIds(10)
    const { data, error } = await fetchAllInChunks(
      ids,
      async (chunk) => ({ data: chunk.map((id) => ({ id })), error: null }),
      4,
    )
    expect(error).toBeNull()
    expect(data?.map((r) => r.id)).toEqual(ids)
  })

  it('surfaces the first chunk error and returns no data', async () => {
    const ids = makeIds(10)
    let call = 0
    const { data, error } = await fetchAllInChunks(
      ids,
      async (chunk) => {
        call += 1
        if (call === 2) return { data: null, error: { code: '500', message: 'boom' } }
        return { data: chunk.map((id) => ({ id })), error: null }
      },
      4,
    )
    expect(data).toBeNull()
    expect(error).toEqual({ code: '500', message: 'boom' })
  })

  it('treats null chunk data as empty rather than failing', async () => {
    const { data, error } = await fetchAllInChunks(
      makeIds(3),
      async () => ({ data: null, error: null }),
      2,
    )
    expect(error).toBeNull()
    expect(data).toEqual([])
  })
})

describe('fetchAllInChunksPaged', () => {
  // Models a PostgREST table that caps every request at `maxRows` rows: a single
  // page (as plain fetchAllInChunks does) would silently truncate the result —
  // the exact bug that turned salesman wallets negative on the board.
  const makeStore = (maxRows: number, rowsPerId: Record<string, number>) =>
    async (chunk: string[], from: number, to: number) => {
      const all: { id: string; owner: string }[] = []
      for (const owner of chunk) {
        for (let i = 0; i < (rowsPerId[owner] || 0); i += 1) all.push({ id: `${owner}-${i}`, owner })
      }
      all.sort((a, b) => a.id.localeCompare(b.id))
      const requested = all.slice(from, to + 1)
      return { data: requested.slice(0, maxRows), error: null }
    }

  it('pages past the per-request row cap so nothing is truncated', async () => {
    // 2500 rows for one owner, server caps each request at 1000 → needs 3 pages.
    const { data, error } = await fetchAllInChunksPaged(
      ['a'],
      makeStore(1000, { a: 2500 }),
      IN_FILTER_MAX_IDS,
      1000,
    )
    expect(error).toBeNull()
    expect(data).toHaveLength(2500)
    expect(new Set(data?.map((r) => r.id)).size).toBe(2500) // no repeats across pages
  })

  it('sums every row across chunks and pages (no under-count)', async () => {
    const ids = makeIds(5)
    const rowsPerId = { 'id-0': 1500, 'id-1': 10, 'id-2': 0, 'id-3': 1001, 'id-4': 300 }
    const { data, error } = await fetchAllInChunksPaged(
      ids,
      makeStore(1000, rowsPerId),
      2, // small chunk size to exercise multiple chunks too
      1000,
    )
    expect(error).toBeNull()
    expect(data).toHaveLength(1500 + 10 + 0 + 1001 + 300)
  })

  it('surfaces a page error and returns no data', async () => {
    const { data, error } = await fetchAllInChunksPaged(
      makeIds(3),
      async () => ({ data: null, error: { code: '500', message: 'boom' } }),
      2,
      1000,
    )
    expect(data).toBeNull()
    expect(error).toEqual({ code: '500', message: 'boom' })
  })
})
