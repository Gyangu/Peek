import {
  CHUNK_DEFAULT_ROWS,
  VECTOR_RESULT_COLUMNS,
  adaptiveChunkRows,
  decodeScanCursor,
  encodeScanCursor,
  peekError,
  peekErrorMsg,
  type ChunkDone,
  type ChunkFrame,
  type ColumnDef,
  type Cursor,
  type FilterSpec,
  type ResultId,
  type SortSpec,
} from '@peek/core'
import type { Schemas } from '@qdrant/js-client-rest'
import { estimateRowBytes, pointToRow, type QdrantPoint, type QdrantRowShape } from './points'

/**
 * `scroll` and `search` as core `Cursor`s, plus the request-side translation
 * (FilterSpec → qdrant filter, SortSpec → order_by).
 *
 * Both produce points; the only differences are the source of the next page and
 * whether there is a `score` column, so one cursor serves both.
 *
 * ## Paging
 *
 * | request        | qdrant call                       | next page                |
 * |----------------|-----------------------------------|--------------------------|
 * | collectionScan | POST /collections/…/points/scroll  | `next_page_offset`       |
 * | vectorSearch   | POST /collections/…/points/query   | none — topK is the whole |
 *
 * `next_page_offset` is a point id (string, number, or null when the collection
 * is exhausted). `ChunkDone.nextCursor` is a **string**, so a numeric offset is
 * JSON-encoded on the way out and JSON-parsed on the way back in; a driver that
 * stringifies it naively turns point 42 into the uuid-shaped string "42" and the
 * next page silently starts from the beginning.
 *
 * A search has no continuation: `topK` bounds it, `offset` pages it, and the
 * cursor emits one frame (or however many `chunkRows` splits it into) and ends
 * with `done` carrying no `nextCursor` (`continuable: false`).
 *
 * ## Vectors are not fetched
 *
 * `with_vector` defaults to false, always. The vector body is reachable through
 * valuePeek on a `qdrantPoint` ref (PLAN section 4), and pulling 1536 floats per
 * row into a listing wastes the entire chunk budget on data no one is looking at.
 */

export interface QdrantPointCursorOptions {
  resultId: ResultId
  /** Column layout, decided before the first page (see points.ts) */
  shape: QdrantRowShape
  /** Rows per frame; when absent, adaptiveChunkRows decides from the observed row width */
  chunkRows?: number
  /** Stop after this many rows */
  maxRows?: number
  /**
   * Whether stopping at `maxRows` sets `done.truncated`.
   *
   * A scroll uses `maxRows` for its *page size*, and a page boundary is paging,
   * not truncation — the relational drivers express the same limit as SQL LIMIT
   * and so never raise the flag. Reaching the end of a page therefore reports
   * only `nextCursor`, and this stays true for the callers who mean a real
   * ceiling.
   *
   * It suppresses the flag **only when a `nextCursor` actually goes out**: the
   * two carry the same fact, and dropping both would make a page that was cut
   * short indistinguishable from the end of the collection.
   */
  reportTruncation?: boolean
  timeoutMs?: number
  signal?: AbortSignal
  /**
   * Whether an unfinished result set may hand back a `nextCursor`. A scroll can
   * (its continuation is a point id the server understands); a search cannot —
   * its page numbers mean nothing to `points/scroll`, and handing one out would
   * produce a "next page" that silently reads a different result set.
   */
  continuable?: boolean
  /**
   * Fetch one page. `offset` is the continuation token from the previous page,
   * or undefined for the first. Returning `nextOffset: null` ends the iteration.
   */
  fetchPage(offset: string | number | undefined, limit: number): Promise<QdrantPointPage>
  onClosed?: () => void
}

export interface QdrantPointPage {
  points: QdrantPoint[]
  /** null when the collection is exhausted (or the request has no continuation, e.g. a search) */
  nextOffset: string | number | null
}

export class QdrantPointCursor implements Cursor {
  readonly resultId: ResultId

  private readonly opts: QdrantPointCursorOptions
  private readonly startedAt = Date.now()

  /** Points already fetched from the server but not yet packed into a frame */
  private buffer: QdrantPoint[] = []
  /** Continuation for the page after the one in `buffer`; null once the server said "no more" */
  private nextOffset: string | number | null = null
  private started = false
  private exhausted = false

  private seq = 0
  private rowsEmitted = 0
  private doneSent = false
  private closed = false
  private avgRowBytes = 0

  constructor(opts: QdrantPointCursorOptions) {
    this.opts = opts
    this.resultId = opts.resultId
  }

  /** Known up front for this cursor: the shape is decided before the first page */
  get schema(): readonly ColumnDef[] | null {
    return this.opts.shape.columns
  }

  get isClosed(): boolean {
    return this.closed
  }

  /**
   * Pull one frame. Termination follows core/chunk.ts to the letter:
   * - normal end   = the last frame carries `done` (an empty collection still
   *                  emits one frame, rowCount 0)
   * - abnormal end = next() rejects with a PeekError, and no `done` frame follows
   * - seq increments from 0 with no gaps
   */
  async next(): Promise<ChunkFrame | null> {
    try {
      return await this.fetchFrame()
    } catch (err) {
      await this.close().catch(() => {})
      throw err
    }
  }

  private async fetchFrame(): Promise<ChunkFrame | null> {
    if (this.doneSent || this.closed) return null
    this.throwIfAborted()

    const { maxRows } = this.opts
    let want = this.nextBatchSize()
    let hitMaxRows = false
    if (maxRows !== undefined && maxRows >= 0) {
      const remain = maxRows - this.rowsEmitted
      if (remain <= 0) {
        hitMaxRows = true
        want = 0
      } else if (remain < want) {
        want = remain
        hitMaxRows = true
      }
    }

    // One row beyond what is needed acts as a probe: it separates "this page
    // landed exactly on the end" from "there is more", which both avoids an empty
    // trailing frame and gives `nextCursor` an exact resume point (the probe row
    // itself). want === 0 only happens on the degenerate maxRows === 0 call.
    if (want > 0) await this.fill(want + 1)

    const take = Math.min(want, this.buffer.length)
    const points = take > 0 ? this.buffer.splice(0, take) : []
    const schema = this.opts.shape.columns

    const cols: unknown[][] = Array.from({ length: schema.length }, () => [])
    let frameBytes = 0
    for (const point of points) {
      const row = pointToRow(point, this.opts.shape)
      for (let c = 0; c < schema.length; c += 1) {
        const bucket = cols[c]
        if (bucket) bucket.push(row[c] ?? null)
      }
      frameBytes += estimateRowBytes(row)
    }

    this.rowsEmitted += points.length
    if (points.length > 0) {
      const observed = frameBytes / points.length
      // Rolling average, so one unusually wide row cannot collapse the chunk size
      this.avgRowBytes = this.avgRowBytes === 0 ? observed : this.avgRowBytes * 0.5 + observed * 0.5
    }

    const truncatedByMax = hitMaxRows && (this.buffer.length > 0 || !this.exhausted)
    const finished = truncatedByMax || (this.exhausted && this.buffer.length === 0)

    const frame: ChunkFrame = {
      resultId: this.resultId,
      seq: this.seq,
      cols,
      rowCount: points.length,
    }
    if (this.seq === 0) frame.schema = schema
    this.seq += 1

    if (finished) {
      const extra = this.finish(this.rowsEmitted, this.exhausted && !truncatedByMax)
      // `reportTruncation: false` says "a page boundary is paging, not
      // truncation" — and that only holds while `nextCursor` is there to say the
      // same thing. Without one (an ordered scroll, a search) a `done` cut short
      // by `maxRows` would be byte-identical to a completed one, so a consumer —
      // or a model reading an MCP receipt — would conclude the collection holds
      // exactly the rows it was handed. The flag is the only signal left.
      const silent = this.opts.reportTruncation === false && extra.nextCursor !== undefined
      frame.done = {
        rows: this.rowsEmitted,
        elapsedMs: Date.now() - this.startedAt,
        ...(truncatedByMax && !silent ? { truncated: true } : {}),
        ...extra,
      }
      this.doneSent = true
      await this.close()
    }
    return frame
  }

  /** Ensure the buffer holds at least `target` points (or that the scroll is exhausted) */
  private async fill(target: number): Promise<void> {
    while (!this.exhausted && this.buffer.length < target) {
      this.throwIfAborted()
      const want = target - this.buffer.length
      const from = this.started ? (this.nextOffset ?? undefined) : undefined
      const page = await this.opts.fetchPage(from, want)
      this.started = true
      for (const point of page.points) this.buffer.push(point)
      this.nextOffset = page.nextOffset
      // A null continuation is the server saying "that was the last page". A page
      // that came back empty *without* saying so would otherwise spin forever.
      if (page.nextOffset === null || page.points.length === 0) this.exhausted = true
    }
  }

  /** Rows for the next batch: the caller's fixed value if any, otherwise adapted to the observed row width */
  private nextBatchSize(): number {
    const fixed = this.opts.chunkRows
    if (fixed !== undefined && fixed > 0) return Math.trunc(fixed)
    if (this.avgRowBytes <= 0) return CHUNK_DEFAULT_ROWS
    return adaptiveChunkRows(this.avgRowBytes)
  }

  private throwIfAborted(): void {
    if (this.closed) throw peekErrorMsg('CANCELLED', 'error.driver.queryCancelled')
    if (this.opts.signal?.aborted) throw peekErrorMsg('CANCELLED', 'error.driver.queryCancelled')
    const budget = this.opts.timeoutMs
    if (budget !== undefined && budget > 0 && Date.now() - this.startedAt > budget) {
      throw peekErrorMsg('TIMEOUT', 'error.query.timedOut', { operation: 'Scroll', ms: budget })
    }
  }

  /**
   * Idempotent.
   *
   * There is nothing server-side to release — a scroll is a stateless POST, and
   * `@qdrant/js-client-rest` exposes no per-request AbortSignal, so an in-flight
   * request runs to completion and its result is dropped. That is exactly why
   * this driver does not advertise `cancel`.
   */
  close(): Promise<void> {
    if (this.closed) return Promise.resolve()
    this.closed = true
    this.buffer = []
    this.opts.onClosed?.()
    return Promise.resolve()
  }

  /**
   * Extra fields for the final frame's `done` — the encoded next_page_offset.
   *
   * The resume point is the **first point that was fetched but not emitted**
   * (qdrant's scroll `offset` is inclusive: "start reading from this id"), which
   * is the probe row whenever one was read. Only when the buffer is empty does
   * the server's own `next_page_offset` apply.
   */
  protected finish(_rows: number, exhausted: boolean): Pick<ChunkDone, 'truncated' | 'nextCursor'> {
    if (exhausted) return {}
    if (this.opts.continuable === false) return {}
    const head = this.buffer[0]
    const resume = head !== undefined ? head.id : (this.nextOffset ?? undefined)
    if (resume === undefined) return {}
    return { nextCursor: encodeScrollOffset(resume) }
  }
}

/**
 * Encode / decode a scroll continuation as core's `ScanCursor`.
 *
 * The boundary is the next point id, JSON-encoded so the id's *type* survives:
 * `42` and `'42'` are different points to qdrant, and both spell `42` in plain
 * text. `JSON.stringify` gives `42` for the number and `"42"` for the string,
 * which round-trips.
 *
 * The `skip` half of a `ScanCursor` is always 0 here, and that is not an
 * oversight: scroll's `offset` is inclusive, so the driver resumes *at* the first
 * point it has not emitted rather than after a page boundary — the probe row it
 * keeps buffered is what makes that possible. The field is still part of the
 * token because the envelope is shared, and because sharing the envelope is what
 * makes a redis token handed to qdrant a BAD_REQUEST. It used to be read as a
 * string point id, scrolled from a point that does not exist, and answered with
 * an empty page.
 */
export function encodeScrollOffset(offset: string | number): string {
  return encodeScanCursor({ driverId: 'qdrant', boundary: JSON.stringify(offset), skip: 0 })
}

export function decodeScrollOffset(token: string): string | number {
  const boundary = decodeScanCursor(token, 'qdrant').boundary
  try {
    const parsed: unknown = JSON.parse(boundary)
    if (typeof parsed === 'string' || typeof parsed === 'number') return parsed
  } catch {
    // A boundary that is not JSON cannot have been minted by encodeScrollOffset.
    // Reading it as a literal string id is the only interpretation that cannot
    // lose data, and the envelope has already established which driver it is from.
  }
  return boundary
}

/* ================================================================== */
/* FilterSpec → qdrant filter                                          */
/* ================================================================== */

type QdrantFilter = Schemas['Filter']
type QdrantCondition = Schemas['Condition']

/** Qdrant's four filter clauses; anything else in a nativeFilter is refused. */
const NATIVE_FILTER_KEYS = new Set(['must', 'should', 'must_not', 'min_should'])

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Validate a caller-supplied qdrant filter.
 *
 * `nativeFilter` is the escape hatch for predicates FilterSpec cannot express
 * (nested / geo / has_id). Silently ignoring one that is not understood would
 * return **more** points than the caller asked for with no way to notice, so an
 * unrecognized shape is a hard BAD_REQUEST — the contract in
 * `CollectionScanRequest.nativeFilter`.
 *
 * The text is a plain English literal on purpose: nativeFilter only ever comes
 * from an MCP caller, and that surface stays English.
 */
export function normalizeNativeFilter(value: unknown): QdrantFilter {
  if (!isPlainObject(value)) {
    throw peekError(
      'BAD_REQUEST',
      'qdrant nativeFilter must be a filter object with must / should / must_not / min_should',
    )
  }
  const keys = Object.keys(value)
  if (keys.length === 0) {
    throw peekError('BAD_REQUEST', 'qdrant nativeFilter is empty; omit it instead')
  }
  const unknownKeys = keys.filter((k) => !NATIVE_FILTER_KEYS.has(k))
  if (unknownKeys.length > 0) {
    throw peekError(
      'BAD_REQUEST',
      `qdrant nativeFilter has unsupported key(s) ${unknownKeys.join(', ')};`
        + ' only must, should, must_not and min_should are accepted',
    )
  }
  return value as QdrantFilter
}

function isMatchValue(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
}

function isPointId(value: unknown): value is string | number {
  return typeof value === 'string' || typeof value === 'number'
}

function requireValue(spec: FilterSpec): unknown {
  if (spec.value === undefined) {
    throw peekErrorMsg('BAD_REQUEST', 'error.sql.filterMissingValue', {
      column: spec.column,
      op: spec.op,
    })
  }
  return spec.value
}

function requireArray(spec: FilterSpec): unknown[] {
  const value = requireValue(spec)
  if (!Array.isArray(value)) {
    throw peekErrorMsg('BAD_REQUEST', 'error.sql.filterValueNotArray', { column: spec.column })
  }
  return value
}

/** `in` needs a homogeneous list: qdrant's AnyVariants is string[] **or** number[], never mixed. */
function anyVariants(spec: FilterSpec, values: unknown[]): string[] | number[] {
  if (values.every((v) => typeof v === 'string')) return values as string[]
  if (values.every((v) => typeof v === 'number')) return values as number[]
  throw peekError(
    'BAD_REQUEST',
    `Filter ${spec.column} in requires a list of all strings or all numbers`,
  )
}

/** A range bound is a number, or an ISO-8601 timestamp (qdrant's DatetimeRange takes the same field). */
function rangeBound(spec: FilterSpec): number | string {
  const value = requireValue(spec)
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return value
  throw peekError(
    'BAD_REQUEST',
    `Filter ${spec.column} ${spec.op} requires a number or an ISO-8601 datetime`,
  )
}

/** Strip SQL wildcards: qdrant has no LIKE, only full-text match on an indexed text field. */
function likeText(spec: FilterSpec): string {
  const value = requireValue(spec)
  if (typeof value !== 'string') {
    throw peekError('BAD_REQUEST', `Filter ${spec.column} ${spec.op} requires a string`)
  }
  return value.replace(/[%_]/g, ' ').trim()
}

/**
 * "Has no value" in a UI means both readings qdrant separates: the key is absent
 * (is_empty) and the key is explicitly JSON null (is_null). A nested filter is
 * itself a valid Condition, so the two are ORed in place.
 */
function emptyCondition(key: string): QdrantCondition {
  return { should: [{ is_empty: { key } }, { is_null: { key } }] }
}

interface ConditionBuckets {
  must: QdrantCondition[]
  mustNot: QdrantCondition[]
}

function pushSpec(spec: FilterSpec, out: ConditionBuckets, idColumn: string): void {
  const key = spec.column

  if (key === idColumn) {
    // The id column is not payload: it is addressed with has_id
    switch (spec.op) {
      case 'eq':
      case 'neq': {
        const value = requireValue(spec)
        if (!isPointId(value)) {
          throw peekError('BAD_REQUEST', `Filter ${key} ${spec.op} requires a point id`)
        }
        const cond: QdrantCondition = { has_id: [value] }
        if (spec.op === 'eq') out.must.push(cond)
        else out.mustNot.push(cond)
        return
      }
      case 'in': {
        const values = requireArray(spec)
        const ids = values.filter(isPointId)
        if (ids.length !== values.length) {
          throw peekError('BAD_REQUEST', `Filter ${key} in requires a list of point ids`)
        }
        out.must.push({ has_id: ids })
        return
      }
      default:
        throw peekError(
          'BAD_REQUEST',
          `Filter on ${key} supports only eq, neq and in on a qdrant collection`,
        )
    }
  }

  switch (spec.op) {
    case 'eq':
    case 'neq': {
      const value = requireValue(spec)
      if (!isMatchValue(value)) {
        throw peekError(
          'BAD_REQUEST',
          `Filter ${key} ${spec.op} requires a string, number or boolean`,
        )
      }
      const cond: QdrantCondition = { key, match: { value } }
      if (spec.op === 'eq') out.must.push(cond)
      else out.mustNot.push(cond)
      return
    }
    case 'in':
      out.must.push({ key, match: { any: anyVariants(spec, requireArray(spec)) } })
      return
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte':
      out.must.push({ key, range: { [spec.op]: rangeBound(spec) } })
      return
    case 'like':
    case 'ilike':
    case 'contains': {
      // Qdrant's only substring-ish predicate is full-text match, which needs a
      // text index on the key; without one the server rejects it, and that
      // message passes through verbatim rather than being guessed at here.
      const value = spec.op === 'contains' ? requireValue(spec) : likeText(spec)
      if (typeof value !== 'string') {
        if (!isMatchValue(value)) {
          throw peekError('BAD_REQUEST', `Filter ${key} contains requires a scalar value`)
        }
        // contains on an array payload field: an exact match already means
        // "any element equals" in qdrant
        out.must.push({ key, match: { value } })
        return
      }
      out.must.push({ key, match: { text: value } })
      return
    }
    case 'isNull':
      out.must.push(emptyCondition(key))
      return
    case 'isNotNull':
      out.mustNot.push(emptyCondition(key))
      return
  }
}

export interface BuildFilterOptions {
  filter?: readonly FilterSpec[]
  /** Passed through verbatim and ANDed in; rejected when it is not a filter object */
  nativeFilter?: unknown
  /** Which column name means the point id; defaults to the `id` column of a vector result */
  idColumn?: string
}

/**
 * Translate the portable filter model into a qdrant filter.
 *
 * All FilterSpecs are ANDed (`must` / `must_not`), matching every other driver;
 * a `nativeFilter` is nested in as one more `must` condition, because a Filter is
 * itself a valid Condition in qdrant.
 */
export function buildQdrantFilter(opts: BuildFilterOptions): QdrantFilter | undefined {
  const idColumn = opts.idColumn ?? VECTOR_RESULT_COLUMNS.id
  const buckets: ConditionBuckets = { must: [], mustNot: [] }
  for (const spec of opts.filter ?? []) pushSpec(spec, buckets, idColumn)
  if (opts.nativeFilter !== undefined) {
    buckets.must.push(normalizeNativeFilter(opts.nativeFilter) as QdrantCondition)
  }
  if (buckets.must.length === 0 && buckets.mustNot.length === 0) return undefined
  return {
    ...(buckets.must.length > 0 ? { must: buckets.must } : {}),
    ...(buckets.mustNot.length > 0 ? { must_not: buckets.mustNot } : {}),
  }
}

/**
 * SortSpec → scroll's `order_by`.
 *
 * Qdrant orders a scroll by **one** indexed payload key and nothing else — there
 * is no multi-key ordering and no ordering by point id. Quietly honouring only
 * the first of three sort columns would produce a result the caller believes is
 * sorted three ways, so anything beyond what the server can do is refused.
 */
export function buildOrderBy(
  sort: readonly SortSpec[] | undefined,
  idColumn: string = VECTOR_RESULT_COLUMNS.id,
): Schemas['OrderByInterface'] | undefined {
  if (!sort || sort.length === 0) return undefined
  if (sort.length > 1) {
    throw peekError('BAD_REQUEST', 'A qdrant scroll can order by at most one payload key')
  }
  const spec = sort[0]
  if (!spec) return undefined
  if (spec.column === idColumn) {
    // Scroll is already in id order; asking for it explicitly is the one case
    // where "cannot order by that key" would be needlessly pedantic
    if (spec.dir === 'asc') return undefined
    throw peekError('BAD_REQUEST', 'A qdrant scroll cannot order by point id descending')
  }
  return { key: spec.column, direction: spec.dir }
}
