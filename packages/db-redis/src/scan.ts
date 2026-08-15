import {
  CHUNK_DEFAULT_ROWS,
  KEYSPACE_SCAN_COLUMNS,
  KEYSPACE_SCAN_SCHEMA,
  SCAN_COUNT_HINT,
  adaptiveChunkRows,
  encodeScanCursor,
  peekErrorMsg,
  tryDecodeScanCursor,
  type ChunkDone,
  type ChunkFrame,
  type ColumnDef,
  type Cursor,
  type FilterSpec,
  type KeyPatternRef,
  type ResultId,
} from '@peek/core'

/**
 * SCAN as a core `Cursor`: the file where "browse a keyspace" is made to fit the
 * columnar chunk protocol.
 *
 * ## How SCAN maps onto the protocol
 *
 * | chunk protocol            | redis                                            |
 * |---------------------------|--------------------------------------------------|
 * | one row                   | one key                                          |
 * | columns                   | `KEYSPACE_SCAN_SCHEMA` (key/type/ttlMs/size/bytes/encoding) |
 * | `ChunkDone.nextCursor`    | the SCAN cursor, omitted when it came back '0'   |
 * | `chunkRows`               | how many keys to accumulate before emitting a frame |
 * | COUNT                     | `SCAN_COUNT_HINT` — a work hint, not a page size |
 *
 * The mismatch that matters: **SCAN returns an unpredictable number of keys per
 * call** — zero is entirely normal, and a single call may return more than COUNT.
 * So one frame is not one SCAN call. The cursor loops, accumulating keys until it
 * has `chunkRows` of them or the iteration ends, and only then emits a frame.
 * Emitting one frame per SCAN call would produce thousands of near-empty frames
 * and blow the ack window apart for no reason.
 *
 * The second mismatch: SCAN guarantees every key present for the whole iteration
 * is returned **at least once** — duplicates are allowed and, on a rehashing
 * keyspace, common. Dedupe within an iteration is not attempted (it would mean
 * holding every key seen so far in memory, which is exactly what SCAN exists to
 * avoid); the row count of a keyspace scan is therefore an upper bound, and the
 * `size` column is per-key truth while the row total is not.
 *
 * The third mismatch, and the one that shapes the fetch loop: **a redis cursor
 * only addresses a page boundary**, while `maxRows` can land anywhere inside a
 * page. The resolution is core's `ScanCursor` — a boundary plus an intra-page
 * skip. The boundary is the real SCAN cursor that fetched the page the cut landed
 * in, and the skip is how many of *that page's* matching rows were already
 * accounted for.
 *
 * That shape started life here, as this driver's private `"<boundary>:<skip>"`
 * string, and then moved to core, because it is not a redis fact: it is what
 * every store whose cursor addresses pages rather than rows needs, and solving it
 * privately meant the next such driver would solve it again or fail to notice it
 * (see core/cursor.ts). Naming the page rather than some earlier boundary keeps
 * the re-scan to one page: a keyspace mutating underneath can throw the resume
 * off by at most that page, and never by everything since the last boundary.
 *
 * The rule that follows, and it is not negotiable: **at most `maxRows` rows are
 * emitted.** `limit` is what the table view labels its page range with and what
 * an MCP receipt reports, so overshooting it by a SCAN page turns "1 – 50" into
 * 501 rows and makes consecutive pages overlap. Rows fetched past the ceiling are
 * dropped and re-read on the next request; that costs one page of re-scanning per
 * page turn, which is the price of a cursor store that cannot address a row.
 */

/** A continuation token, split into the SCAN boundary and the rows to drop after it */
export interface RedisResumePoint {
  cursor: string
  skip: number
}

/** A SCAN cursor is a decimal counter; anything else was not minted by this driver */
const SCAN_BOUNDARY_RE = /^\d+$/

/**
 * True when `token` is a well-formed continuation minted by *this* cursor.
 *
 * Both halves are checked: core's envelope (`redis:<skip>:<boundary>`, which
 * rejects a token another driver minted) and the boundary itself, which has to
 * be a decimal SCAN cursor.
 */
export function isRedisResumeToken(token: string): boolean {
  const parsed = tryDecodeScanCursor(token)
  return parsed !== null && parsed.driverId === 'redis' && SCAN_BOUNDARY_RE.test(parsed.boundary)
}

/** Decode a continuation token; an unparsable one resumes from the start rather than throwing */
export function parseRedisResumeToken(token: string): RedisResumePoint {
  const parsed = tryDecodeScanCursor(token)
  if (parsed === null || parsed.driverId !== 'redis' || !SCAN_BOUNDARY_RE.test(parsed.boundary)) {
    return { cursor: '0', skip: 0 }
  }
  return { cursor: parsed.boundary, skip: parsed.skip }
}

/** Mint one: the page the next row is in, plus how many of its rows already went out */
export function redisResumeToken(cursor: string, skip: number): string {
  return encodeScanCursor({ driverId: 'redis', boundary: cursor, skip })
}

export interface RedisScanCursorOptions {
  resultId: ResultId
  ref: KeyPatternRef
  /** Resume point; absent means a fresh iteration from '0' */
  cursorToken?: string
  /** Client-side filters left over after MATCH / TYPE were pushed into SCAN */
  filter?: readonly FilterSpec[]
  /** Rows per frame; when absent, adaptiveChunkRows decides from the observed row width */
  chunkRows?: number
  /** Stop after this many rows and set `done.truncated` */
  maxRows?: number
  /**
   * Drop this many matching keys before emitting any.
   *
   * SCAN has no OFFSET, so this is a client-side skip and costs a full walk of
   * the keys it steps over — it exists because `TableViewState.page.offset` can
   * be set explicitly. Ordinary paging goes through `cursorToken`, which is O(1).
   */
  skip?: number
  /** Projection over KEYSPACE_SCAN_SCHEMA; when absent the full schema is emitted */
  columns?: readonly ColumnDef[]
  /**
   * Ceiling on keys examined in one scan request, filtered-out ones included.
   *
   * A selective client-side filter over a 50-million-key database would otherwise
   * walk the whole keyspace inside a single `next()`. On reaching it the scan ends
   * normally with `truncated` and a `nextCursor`, so the caller can continue
   * rather than wait.
   */
  maxScannedKeys?: number
  timeoutMs?: number
  signal?: AbortSignal
  /** Fetch one page of keys plus their metadata; the session supplies the pipelined implementation */
  fetchPage(cursor: string, count: number): Promise<RedisScanPage>
  onClosed?: () => void
}

/** One SCAN round trip, with the per-key metadata already pipelined in */
export interface RedisScanPage {
  /** The cursor to pass to the next call; '0' means the iteration completed */
  cursor: string
  rows: RedisKeyRow[]
}

/** One row of a keyspace scan; field order matches KEYSPACE_SCAN_SCHEMA */
export interface RedisKeyRow {
  key: string
  type: string
  /** PTTL in ms; -1 = no expiry. null when unknown */
  ttlMs: number | null
  /** Element count (hash fields, list length, …); null for a string or when not cheap to get */
  size: number | null
  /** MEMORY USAGE in bytes; null when the server refuses it */
  bytes: number | null
  /** OBJECT ENCODING; null when unavailable */
  encoding: string | null
}

/** Default ceiling on keys examined per scan request; see `maxScannedKeys` */
export const DEFAULT_MAX_SCANNED_KEYS = 200_000

/** Read one scan column off a row, by the canonical column name */
function cellOf(row: RedisKeyRow, column: string): unknown {
  switch (column) {
    case KEYSPACE_SCAN_COLUMNS.key:
      return row.key
    case KEYSPACE_SCAN_COLUMNS.type:
      return row.type
    case KEYSPACE_SCAN_COLUMNS.ttlMs:
      return row.ttlMs
    case KEYSPACE_SCAN_COLUMNS.size:
      return row.size
    case KEYSPACE_SCAN_COLUMNS.bytes:
      return row.bytes
    case KEYSPACE_SCAN_COLUMNS.encoding:
      return row.encoding
    default:
      return null
  }
}

/** Rough wire size of one scan row; feeds adaptiveChunkRows */
function rowBytes(row: RedisKeyRow): number {
  return (
    Buffer.byteLength(row.key, 'utf8') +
    row.type.length +
    (row.encoding?.length ?? 0) +
    // three numeric columns plus the per-row envelope
    40
  )
}

/* ------------------------------------------------------------------ */
/* Client-side filtering                                               */
/* ------------------------------------------------------------------ */

function compare(a: unknown, b: unknown): number | null {
  if (typeof a === 'number' && typeof b === 'number') return a - b
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0
  const na = Number(a)
  const nb = Number(b)
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb
  return null
}

function looseEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || a === undefined || b === null || b === undefined) return false
  return String(a) === String(b)
}

/**
 * SQL `LIKE` / `ILIKE` against one cell.
 *
 * Written out rather than delegated to redis: MATCH is a *glob*, `%` and `_` mean
 * nothing to it, so a `like` filter that reached the server would silently match
 * the wrong keys.
 */
function likeMatches(value: string, pattern: string, insensitive: boolean): boolean {
  let rx = ''
  for (const ch of pattern) {
    if (ch === '%') rx += '.*'
    else if (ch === '_') rx += '.'
    else rx += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${rx}$`, insensitive ? 'is' : 's').test(value)
}

/** Evaluate one FilterSpec against one scan row. Unknown columns never match. */
export function rowMatchesFilter(row: RedisKeyRow, spec: FilterSpec): boolean {
  const cell = cellOf(row, spec.column)
  switch (spec.op) {
    case 'isNull':
      return cell === null || cell === undefined
    case 'isNotNull':
      return cell !== null && cell !== undefined
    case 'eq':
      return looseEquals(cell, spec.value)
    case 'neq':
      return !looseEquals(cell, spec.value)
    case 'in':
      return Array.isArray(spec.value) && spec.value.some((v) => looseEquals(cell, v))
    case 'contains':
      return cell !== null && cell !== undefined && String(cell).includes(String(spec.value))
    case 'like':
      return cell !== null && cell !== undefined && likeMatches(String(cell), String(spec.value), false)
    case 'ilike':
      return cell !== null && cell !== undefined && likeMatches(String(cell), String(spec.value), true)
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte': {
      if (cell === null || cell === undefined) return false
      const cmp = compare(cell, spec.value)
      if (cmp === null) return false
      if (spec.op === 'lt') return cmp < 0
      if (spec.op === 'lte') return cmp <= 0
      if (spec.op === 'gt') return cmp > 0
      return cmp >= 0
    }
  }
}

/** One SCAN page held by the cursor, tagged with the cursor that fetched it */
interface BufferedPage {
  /** Re-issuing SCAN with this cursor re-produces `rows` */
  cursor: string
  /** The page's matching rows, in server order */
  rows: RedisKeyRow[]
  /** How many of `rows` have been skipped or emitted already */
  consumed: number
}

export class RedisScanCursor implements Cursor {
  readonly resultId: ResultId

  private readonly opts: RedisScanCursorOptions
  private readonly startedAt = Date.now()
  private readonly columns: readonly ColumnDef[]
  private readonly maxScanned: number
  private readonly deadline: number | null

  /**
   * SCAN pages fetched but not fully handed out, oldest first.
   *
   * Rows are kept grouped by the page that produced them rather than flattened,
   * because the continuation token is `<the cursor that fetched this page>:<rows
   * of it already accounted for>` — and that address only exists while a row
   * remembers which page it came from.
   */
  private pages: BufferedPage[] = []
  /** Rows across `pages` that are neither skipped nor emitted yet */
  private buffered = 0
  /** The cursor the next SCAN call uses; always a page boundary */
  private cursor: string
  private exhausted = false
  /** Keys examined so far, filtered-out ones included */
  private scanned = 0
  /** Matching rows still to be dropped for the caller's `skip` (an explicit offset) */
  private toSkip: number
  /**
   * Matching rows to drop off the **first** fetched page, from the continuation
   * token. Deliberately not merged into `toSkip`: see `fill` for why a leftover
   * must be discarded rather than carried into the next page.
   */
  private resumeSkip: number
  private fetchedAny = false

  private _schema: readonly ColumnDef[] | null = null
  private seq = 0
  private rowsEmitted = 0
  private doneSent = false
  private closed = false
  private cancelled = false
  private avgRowBytes = 0

  constructor(opts: RedisScanCursorOptions) {
    this.opts = opts
    this.resultId = opts.resultId
    const resume =
      opts.cursorToken === undefined ? { cursor: '0', skip: 0 } : parseRedisResumeToken(opts.cursorToken)
    this.cursor = resume.cursor
    this.columns = opts.columns ?? KEYSPACE_SCAN_SCHEMA
    this.maxScanned = opts.maxScannedKeys ?? DEFAULT_MAX_SCANNED_KEYS
    this.toSkip = Math.max(0, Math.trunc(opts.skip ?? 0))
    this.resumeSkip = resume.skip
    this.deadline =
      opts.timeoutMs !== undefined && opts.timeoutMs > 0 ? Date.now() + Math.trunc(opts.timeoutMs) : null
  }

  /** Filled on the first frame; always the (possibly projected) keyspace scan schema */
  get schema(): readonly ColumnDef[] | null {
    return this._schema
  }

  get isClosed(): boolean {
    return this.closed
  }

  /**
   * Pull one frame. Termination follows core/chunk.ts to the letter:
   * - normal end   = the last frame carries `done` (an empty keyspace still emits
   *                  one frame, rowCount 0)
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
    if (this.doneSent) return null
    // Cancellation is checked *before* the closed guard: cancel() closes the
    // cursor, and answering the next pull with a bare null would look exactly
    // like a normal end that simply forgot its `done` frame.
    this.throwIfAborted()
    if (this.closed) return null
    this._schema ??= this.columns

    // The row ceiling is enforced *here*, not only in the fetch loop: a SCAN page
    // is whatever size the server felt like, so stopping the fetch is not the same
    // as stopping the emission. Rows past the ceiling stay unread and the
    // continuation token points at them.
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

    if (want > 0) await this.fill(want)

    const rows = this.takeRows(want)

    const cols: unknown[][] = this.columns.map((col) => rows.map((row) => cellOf(row, col.name)))
    this.rowsEmitted += rows.length
    if (rows.length > 0) {
      let total = 0
      for (const row of rows) total += rowBytes(row)
      const observed = total / rows.length
      // Rolling average, so one unusually long key cannot collapse the chunk size
      this.avgRowBytes = this.avgRowBytes === 0 ? observed : this.avgRowBytes * 0.5 + observed * 0.5
    }

    const frame: ChunkFrame = {
      resultId: this.resultId,
      seq: this.seq,
      cols,
      rowCount: rows.length,
    }
    // A fresh object per column: the schema travels to the renderer and must
    // not alias the module-level KEYSPACE_SCAN_SCHEMA constant
    if (this.seq === 0) frame.schema = this.columns.map((c) => ({ ...c }))
    this.seq += 1

    // Three ways to finish: the row ceiling cut the scan short, the iteration
    // ended, or a work ceiling (keys examined, deadline) stopped the fetching.
    const truncatedByMax = hitMaxRows && (this.buffered > 0 || !this.exhausted)
    const stoppedByBudget = this.buffered === 0 && !this.exhausted && this.hitWorkCeiling()
    if (truncatedByMax || stoppedByBudget || (this.exhausted && this.buffered === 0)) {
      frame.done = {
        rows: this.rowsEmitted,
        elapsedMs: Date.now() - this.startedAt,
        ...this.finish(this.rowsEmitted, this.exhausted && !truncatedByMax),
      }
      this.doneSent = true
      await this.close()
    }
    return frame
  }

  /**
   * Keep SCANning until `target` matching rows are buffered, the iteration ends,
   * or a ceiling stops it.
   *
   * Whole pages go in — a page is the smallest thing a SCAN cursor can address —
   * so the buffer routinely overshoots `target`. The overshoot is emitted on the
   * next frame or dropped and re-read; what it never does is reach the caller as
   * extra rows past `maxRows`.
   */
  private async fill(target: number): Promise<void> {
    while (!this.exhausted && this.buffered < target && !this.reachedCeiling()) {
      this.throwIfAborted()
      const from = this.cursor
      const page = await this.opts.fetchPage(from, SCAN_COUNT_HINT)
      this.cursor = page.cursor
      this.scanned += page.rows.length
      const matched = page.rows.filter((row) => this.matches(row))

      let consumed = 0
      if (!this.fetchedAny && this.resumeSkip > 0) {
        consumed = Math.min(this.resumeSkip, matched.length)
        // A leftover means this page came back with fewer matching keys than when
        // the token was minted — the keyspace moved underneath, which SCAN allows.
        // The leftover is **dropped rather than carried into the next page**: a
        // carried skip would silently swallow rows the caller has never seen,
        // while dropping it can at worst re-deliver a few. Between a miss and a
        // duplicate, a keyspace browser owes the user the duplicate.
        this.resumeSkip = 0
      }
      this.fetchedAny = true
      // An explicit offset, unlike the token's skip, is a whole-scan position and
      // does span pages
      const offsetHere = Math.min(this.toSkip, matched.length - consumed)
      this.toSkip -= offsetHere
      consumed += offsetHere

      if (consumed < matched.length) {
        this.pages.push({ cursor: from, rows: matched, consumed })
        this.buffered += matched.length - consumed
      }
      if (page.cursor === '0') this.exhausted = true
    }
  }

  /** Hand out up to `n` rows, oldest page first, dropping a page once it is spent */
  private takeRows(n: number): RedisKeyRow[] {
    const out: RedisKeyRow[] = []
    while (out.length < n && this.pages.length > 0) {
      const head = this.pages[0]
      if (head === undefined) break
      const take = Math.min(n - out.length, head.rows.length - head.consumed)
      for (let i = 0; i < take; i += 1) {
        const row = head.rows[head.consumed + i]
        if (row !== undefined) out.push(row)
      }
      head.consumed += take
      if (head.consumed >= head.rows.length) this.pages.shift()
    }
    this.buffered -= out.length
    return out
  }

  private matches(row: RedisKeyRow): boolean {
    const filters = this.opts.filter
    if (!filters || filters.length === 0) return true
    return filters.every((spec) => rowMatchesFilter(row, spec))
  }

  /** A ceiling (row count, work budget, deadline) says stop fetching more pages */
  private reachedCeiling(): boolean {
    const { maxRows } = this.opts
    if (maxRows !== undefined && maxRows >= 0 && this.rowsEmitted + this.buffered >= maxRows) {
      return true
    }
    return this.hitWorkCeiling()
  }

  /**
   * The ceilings that are about *work done*, not about rows wanted.
   *
   * Kept apart from the row ceiling because they end the scan for a different
   * reason: hitting `maxRows` is the request being satisfied, hitting the work
   * budget is the request being cut short with rows still out there.
   */
  private hitWorkCeiling(): boolean {
    if (this.scanned >= this.maxScanned) return true
    return this.deadline !== null && Date.now() >= this.deadline
  }

  /** Rows for the next frame: the caller's fixed value if any, otherwise adapted to the row width */
  private nextBatchSize(): number {
    const fixed = this.opts.chunkRows
    if (fixed !== undefined && fixed > 0) return Math.trunc(fixed)
    if (this.avgRowBytes <= 0) return CHUNK_DEFAULT_ROWS
    return adaptiveChunkRows(this.avgRowBytes)
  }

  private throwIfAborted(): void {
    if (this.cancelled) throw peekErrorMsg('CANCELLED', 'error.driver.queryCancelled')
    if (this.opts.signal?.aborted) throw peekErrorMsg('CANCELLED', 'error.driver.queryCancelled')
  }

  /** Idempotent; stops the iteration and drops the buffered pages */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.pages = []
    this.buffered = 0
    this.opts.onClosed?.()
    await Promise.resolve()
  }

  /** Mark cancelled so the next iteration stops instead of issuing another SCAN */
  markCancelled(): void {
    this.cancelled = true
  }

  /**
   * Extra fields for the final frame's `done`.
   *
   * A completed iteration hands out **no `nextCursor`** — SCAN answers a finished
   * walk with cursor '0', and returning that would restart the scan from the
   * beginning, so a caller paging forward would loop over the keyspace forever.
   */
  protected finish(_rows: number, exhausted: boolean): Pick<ChunkDone, 'truncated' | 'nextCursor'> {
    if (exhausted) return {}
    const point = this.resumePoint()
    // Boundary '0' with nothing skipped is the *start* of an iteration, not a
    // resume point, and it can only come out of a request that consumed nothing
    // at all (maxRows 0). Handing it back would tell the caller to start over;
    // `truncated` alone says the honest thing, which is that there is more and
    // this request delivered none.
    if (point.cursor === '0' && point.skip === 0) return { truncated: true }
    return { truncated: true, nextCursor: redisResumeToken(point.cursor, point.skip) }
  }

  /**
   * Where the next request picks up.
   *
   * With rows still held, that is **the page they came from**, plus how many of
   * its matching rows are already accounted for — never an older boundary. That
   * bound matters: only the one page named by the token has to still look the way
   * it did for the skip to line up, so a keyspace mutating underneath can throw
   * the resume off by at most a page rather than by everything since the last
   * boundary.
   *
   * With nothing held, the boundary alone addresses it, plus whatever is left of
   * an explicit offset that ran out of keyspace before it ran out of count.
   */
  private resumePoint(): RedisResumePoint {
    const head = this.pages[0]
    if (head === undefined) return { cursor: this.cursor, skip: this.toSkip }
    return { cursor: head.cursor, skip: head.consumed }
  }
}
