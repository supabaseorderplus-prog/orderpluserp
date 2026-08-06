// PostgREST encodes `.in()` filters into the request URL. Large ID arrays (roughly
// 400+ UUIDs) push the URL past undici's 16KB header limit and the request dies with
// UND_ERR_HEADERS_OVERFLOW before it ever reaches Supabase. Any query scoped to more
// IDs than IN_FILTER_MAX_IDS must be split into chunked requests and merged in memory.
export const IN_FILTER_MAX_IDS = 150

export function chunkIds(ids: string[], size: number = IN_FILTER_MAX_IDS): string[][] {
  if (size <= 0) throw new Error(`chunkIds: size must be positive, got ${size}`)
  const chunks: string[][] = []
  for (let i = 0; i < ids.length; i += size) {
    chunks.push(ids.slice(i, i + size))
  }
  return chunks
}

export interface ChunkQueryError {
  code?: string
  message?: string
}

export interface ChunkQueryResult<Row> {
  data: Row[] | null
  error: ChunkQueryError | null
}

// Runs `run` once per ID chunk (in parallel) and concatenates the rows.
// Chunks are disjoint so no dedupe is needed, but any per-chunk ORDER BY only
// holds within its chunk — callers that need a global order must re-sort.
export async function fetchAllInChunks<Row>(
  ids: string[],
  run: (chunk: string[]) => PromiseLike<ChunkQueryResult<Row>>,
  size: number = IN_FILTER_MAX_IDS,
): Promise<ChunkQueryResult<Row>> {
  const results = await Promise.all(chunkIds(ids, size).map((chunk) => run(chunk)))
  const rows: Row[] = []
  for (const result of results) {
    if (result.error) return { data: null, error: result.error }
    rows.push(...(result.data || []))
  }
  return { data: rows, error: null }
}

// PostgREST caps every query without an explicit range at its `max-rows` limit
// (1000 by default). A `.select()` that is meant to scan a whole table — e.g.
// building the full company party tree — silently truncates once the table grows
// past 1000 rows, dropping entire sub-trees. This pages through with `.range()`
// until a short page signals the end, so callers get every row regardless of size.
// `build` MUST apply a stable `.order()` or rows can repeat/skip across pages.
export async function fetchAllRows<Row>(
  build: (from: number, to: number) => PromiseLike<ChunkQueryResult<Row>>,
  pageSize: number = 1000,
): Promise<ChunkQueryResult<Row>> {
  if (pageSize <= 0) throw new Error(`fetchAllRows: pageSize must be positive, got ${pageSize}`)
  const all: Row[] = []
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await build(from, from + pageSize - 1)
    if (error) return { data: null, error }
    const page = data || []
    all.push(...page)
    if (page.length < pageSize) break
  }
  return { data: all, error: null }
}

// Combines both guards: chunks the `.in()` ID list (URL-overflow safe) AND pages
// each chunk with `.range()` (max-rows safe). Use this whenever an IN-filtered
// scan can itself match more than PostgREST's `max-rows` — e.g. summing every
// payment for a set of collectors, where `fetchAllInChunks` alone would silently
// cap each chunk at 1000 rows and under-count the totals. `build` MUST apply a
// stable `.order()` (a unique PK) so rows never repeat or skip across pages.
export async function fetchAllInChunksPaged<Row>(
  ids: string[],
  build: (chunk: string[], from: number, to: number) => PromiseLike<ChunkQueryResult<Row>>,
  size: number = IN_FILTER_MAX_IDS,
  pageSize: number = 1000,
): Promise<ChunkQueryResult<Row>> {
  const results = await Promise.all(
    chunkIds(ids, size).map((chunk) =>
      fetchAllRows<Row>((from, to) => build(chunk, from, to), pageSize),
    ),
  )
  const rows: Row[] = []
  for (const result of results) {
    if (result.error) return { data: null, error: result.error }
    rows.push(...(result.data || []))
  }
  return { data: rows, error: null }
}
