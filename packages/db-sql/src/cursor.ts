import {
  CHUNK_DEFAULT_ROWS,
  adaptiveChunkRows,
  peekErrorMsg,
  type ChunkDone,
  type ChunkFrame,
  type ColumnDef,
  type Cursor,
  type ResultId,
  type ValueRef,
} from '@peek/core'
import type { SqlRowStream } from './connection'
import type { SqlColumnMeta, SqlDialect } from './dialect'
import { estimateCellBytes, isPeekableLogical, normalizeCell } from './values'

/**
 * The shared SQL cursor: one `SqlRowStream` → columnar `ChunkFrame`s.
 *
 * Identical in behaviour to `PgCursor`, and it must stay that way, because the
 * renderer's result cache and the MCP receipt logic are written against those
 * exact semantics (core/chunk.ts):
 *
 * - normal end   = the last frame carries `done`; an empty result set still emits
 *                  one frame, `rowCount: 0`, with `done`;
 * - abnormal end = `next()` rejects with a PeekError and no `done` frame follows;
 * - `seq` starts at 0 and increments with no gaps;
 * - `schema` rides on frame 0 only;
 * - rows per frame come from `chunkRows` when the caller fixed one, otherwise from
 *   core's `adaptiveChunkRows` fed by the observed row width. **Do not invent a
 *   local sizing rule** — chunk sizing is a cross-driver budget, and the one
 *   implementation lives in core.
 *
 * ## The one difference from PgCursor
 *
 * PostgreSQL holds a server-side cursor inside a read-only transaction, so its
 * cursor owns a pooled connection for its whole life. Here the batching lives in
 * the backend (`SqlRowStream`), because MySQL streams rows over the protocol and
 * SQLite iterates a synchronous statement — neither has a `DECLARE … FETCH`. The
 * consequences the implementation must respect:
 *
 * - a MySQL stream **pins its connection** until `close()`, exactly like the PG
 *   cursor, so `close()` on every exit path is not optional;
 * - a SQLite stream blocks the thread while it runs, so the backend has to yield
 *   between batches (see connection.ts) or the ack window never advances and the
 *   pump's idle timeout fires on a query that is working perfectly.
 */

export interface SqlCursorOptions {
  dialect: SqlDialect
  resultId: ResultId
  /** Opens the underlying stream. Called once, lazily, on the first `next()`. */
  open(batchHint: number): Promise<SqlRowStream>
  /** Row ceiling; going past it sets `done.truncated` */
  maxRows?: number
  /** Fixed rows per frame; when absent, `adaptiveChunkRows` decides */
  chunkRows?: number
  signal?: AbortSignal
  /** Extra column metadata from `describeCollection` (nullable / primary key) */
  columnHints?: ReadonlyMap<string, { nullable?: boolean; primaryKey?: boolean }>
  /** Extra fields for the final frame's `done` — `collectionScan` supplies `nextCursor` */
  finish?: (rows: number, exhausted: boolean) => Pick<ChunkDone, 'truncated' | 'nextCursor'>
  /** Close callback, so the session can drop this cursor from its active table */
  onClosed?: () => void
}

export class SqlCursor implements Cursor {
  readonly resultId: ResultId

  private readonly opts: SqlCursorOptions
  private readonly startedAt = Date.now()

  private stream: SqlRowStream | null = null
  private _schema: ColumnDef[] | null = null

  /** Rows already pulled from the backend but not yet packed into a frame */
  private buffer: unknown[][] = []
  private exhausted = false

  private seq = 0
  private rowsEmitted = 0
  private doneSent = false
  private closed = false
  private cancelled = false
  private avgRowBytes = 0

  constructor(opts: SqlCursorOptions) {
    this.opts = opts
    this.resultId = opts.resultId
  }

  /** Null until the first batch has been pulled: neither backend reports columns before then */
  get schema(): readonly ColumnDef[] | null {
    return this._schema
  }

  /** True once `close()` has run; `SqlSession.cancel` checks it before acting */
  get isClosed(): boolean {
    return this.closed
  }

  /**
   * Build the frame-0 schema from the stream's column metadata plus the hints.
   *
   * Duplicate output names are disambiguated the same way db-postgres does
   * it — `name`, `name__2`, `name__3` — because `ColumnDef.name` must be unique
   * within a result set and `select a.id, b.id from …` is entirely ordinary SQL.
   */
  protected buildSchema(): ColumnDef[] {
    if (this._schema) return this._schema
    const { dialect, columnHints } = this.opts
    const metas: readonly SqlColumnMeta[] = this.stream?.columns ?? []
    const used = new Map<string, number>()
    const defs: ColumnDef[] = metas.map((meta) => {
      const seen = used.get(meta.name) ?? 0
      used.set(meta.name, seen + 1)
      const logical = dialect.logical(meta)
      const hint = columnHints?.get(meta.name)
      const def: ColumnDef = {
        name: seen === 0 ? meta.name : `${meta.name}__${seen + 1}`,
        logical,
        nativeType: dialect.nativeTypeName(meta),
      }
      if (isPeekableLogical(logical)) def.peekable = true
      // The stream's own metadata wins over the hint: a scan projecting one column
      // of a table knows that column's nullability better than the table-level map
      // only when it reported it at all, which node:sqlite never does
      const nullable = meta.nullable ?? hint?.nullable
      if (nullable !== undefined) def.nullable = nullable
      if (meta.primaryKey === true || hint?.primaryKey === true) def.primaryKey = true
      return def
    })
    this._schema = defs
    return defs
  }

  async next(): Promise<ChunkFrame | null> {
    try {
      return await this.fetchFrame()
    } catch (err) {
      // Release the backend resources before rethrowing: a MySQL stream holds a
      // pooled connection, and a failed cursor that keeps it holds it forever
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

    // Pull one row beyond what is needed as a probe: it distinguishes "the last
    // batch landed exactly on the end" from "there is more", which avoids emitting
    // a pointless empty frame. `want === 0` only happens on the degenerate
    // maxRows === 0 call, where nothing is read and the schema stays empty.
    await this.fill(want > 0 ? want + 1 : 0)

    const take = Math.min(want, this.buffer.length)
    const rows = take > 0 ? this.buffer.splice(0, take) : []
    const schema = this.buildSchema()
    const rowStart = this.rowsEmitted

    const cols: unknown[][] = Array.from({ length: schema.length }, () => [])
    let frameBytes = 0
    for (let r = 0; r < rows.length; r += 1) {
      const row = rows[r] ?? []
      for (let c = 0; c < schema.length; c += 1) {
        const def = schema[c]
        if (!def) continue
        const globalRow = rowStart + r
        const normalized = normalizeCell(row[c], {
          logical: def.logical,
          makeRef: (): ValueRef => ({
            kind: 'resultCell',
            resultId: this.resultId,
            row: globalRow,
            col: c,
          }),
        })
        const bucket = cols[c]
        if (bucket) bucket.push(normalized)
        frameBytes += estimateCellBytes(normalized)
      }
    }

    this.rowsEmitted += rows.length
    if (rows.length > 0) {
      const observed = frameBytes / rows.length
      // Rolling average, so one unusually wide row cannot collapse the chunk size
      this.avgRowBytes = this.avgRowBytes === 0 ? observed : this.avgRowBytes * 0.5 + observed * 0.5
    }

    const truncatedByMax = hitMaxRows && (this.buffer.length > 0 || !this.exhausted)
    const finished = truncatedByMax || (this.exhausted && this.buffer.length === 0)

    const frame: ChunkFrame = {
      resultId: this.resultId,
      seq: this.seq,
      cols,
      rowCount: rows.length,
    }
    if (this.seq === 0) frame.schema = schema
    this.seq += 1

    if (finished) {
      const extra = this.opts.finish?.(this.rowsEmitted, this.exhausted && !truncatedByMax) ?? {}
      const done: ChunkDone = {
        rows: this.rowsEmitted,
        elapsedMs: Date.now() - this.startedAt,
        ...(truncatedByMax ? { truncated: true } : {}),
        ...extra,
      }
      frame.done = done
      this.doneSent = true
      await this.close()
    }
    return frame
  }

  /** Ensure the buffer holds at least `target` rows, or that the stream is exhausted */
  private async fill(target: number): Promise<void> {
    const stream = await this.ensureStream(target)
    while (!this.exhausted && this.buffer.length < target) {
      this.throwIfAborted()
      const batch = await stream.next(target - this.buffer.length)
      // An empty batch is the stream's only end-of-data signal (connection.ts)
      if (batch.length === 0) {
        this.exhausted = true
        break
      }
      for (const row of batch) this.buffer.push(row)
    }
  }

  /**
   * Open the backend stream on first use.
   *
   * Deliberately lazy: `SqlSession.query` hands back a `Cursor` without touching
   * the database, so a caller that opens a view and never scrolls it never takes a
   * connection out of the pool. The statement's own errors therefore surface on
   * the first `next()`, which is where the host runtime already funnels them into
   * the stream's error message.
   */
  private async ensureStream(batchHint: number): Promise<SqlRowStream> {
    if (this.stream) return this.stream
    this.throwIfAborted()
    const stream = await this.opts.open(Math.max(1, batchHint))
    this.stream = stream
    // A cancel that arrived while the stream was opening still has to take effect
    if (this.cancelled) void stream.cancel().catch(() => {})
    return stream
  }

  /** Rows for the next batch: the caller's fixed value if any, otherwise adapted to the observed row width */
  private nextBatchSize(): number {
    const fixed = this.opts.chunkRows
    if (fixed !== undefined && fixed > 0) return Math.trunc(fixed)
    if (this.avgRowBytes <= 0) return CHUNK_DEFAULT_ROWS
    return adaptiveChunkRows(this.avgRowBytes)
  }

  private throwIfAborted(): void {
    if (this.cancelled || this.opts.signal?.aborted === true) {
      throw peekErrorMsg('CANCELLED', 'error.driver.queryCancelled')
    }
  }

  /** Idempotent: closes the stream, releases the connection, fires `onClosed` */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    const stream = this.stream
    this.stream = null
    this.buffer = []
    if (stream) await stream.close().catch(() => {})
    this.opts.onClosed?.()
  }

  /**
   * Mark the cursor cancelled so the next `next()` fails immediately, and ask the
   * backend to stop the statement it is running.
   *
   * The backend half is what differs between the two databases and is why it lives
   * behind `SqlRowStream.cancel()`: MySQL sends `KILL QUERY <threadId>` on a second
   * connection, SQLite has no interrupt to send and simply stops at its next batch
   * boundary. Both are best effort and neither is awaited — `SqlSession.cancel`
   * answers within its own deadline, and the flag set here already guarantees no
   * further rows reach the caller.
   */
  markCancelled(): void {
    if (this.cancelled) return
    this.cancelled = true
    const stream = this.stream
    if (stream) void stream.cancel().catch(() => {})
  }
}
