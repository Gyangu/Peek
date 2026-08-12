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
import type { FieldDef, Pool, PoolClient, QueryArrayResult } from 'pg'
import { mapPgError } from './errors'
import { quoteIdent } from './sql'
import { isPeekableLogical, type PgTypeCatalog } from './type-catalog'
import { estimateCellBytes, normalizeCell } from './values'

/**
 * Server-side cursor.
 *
 * **Never `client.query()` the whole table at once**: this goes through
 * SQL-level DECLARE / FETCH FORWARD, pulling one batch of rows into memory at a
 * time and emitting each batch as a columnar ChunkFrame.
 * (pg-cursor is not installed; an equivalent SQL cursor gives the same semantics
 * with one dependency fewer.)
 *
 * Termination follows core/chunk.ts to the letter:
 * - normal end   = the last frame carries `done` (an empty result set still emits
 *                  one frame, with rowCount 0)
 * - abnormal end = next() rejects (with a PeekError), and no frame carrying
 *                  `done` will ever follow
 * - seq increments from 0 with no gaps
 */

let cursorSeq = 0

/**
 * Server-side backstop when the caller gives no timeoutMs: a single statement
 * gets at most 5 minutes. Without it, one runaway DECLARE / FETCH holds its
 * connection forever.
 */
const DEFAULT_STATEMENT_TIMEOUT_MS = 300_000

/**
 * Idle ceiling for the cursor's transaction: if frames are held back by
 * backpressure (or the host wedges), the server reclaims this
 * idle-in-transaction connection itself instead of leaving a read-only
 * transaction open indefinitely. On the normal path StreamPump's own idle
 * ceiling (60s) closes the cursor first — this is only the last line of defence.
 */
const IDLE_TX_TIMEOUT_MS = 300_000

export interface PgCursorOptions {
  pool: Pool
  catalog: PgTypeCatalog
  resultId: ResultId
  text: string
  params?: readonly unknown[]
  /** Row ceiling; going past it sets done.truncated = true */
  maxRows?: number
  /** Fixed rows per frame; when absent, adaptiveChunkRows decides */
  chunkRows?: number
  timeoutMs?: number
  signal?: AbortSignal
  /** Extra column metadata (primary key / nullable); collectionScan gets it from describeCollection */
  columnHints?: ReadonlyMap<string, { nullable?: boolean; primaryKey?: boolean }>
  /** Extra fields for the final frame's `done` (collectionScan's nextCursor) */
  finish?: (rows: number, exhausted: boolean) => Pick<ChunkDone, 'truncated' | 'nextCursor'>
  /** Close callback, so the session can drop this cursor from its active table */
  onClosed?: () => void
}

export class PgCursor implements Cursor {
  readonly resultId: ResultId

  private readonly opts: PgCursorOptions
  private readonly name: string
  private readonly startedAt = Date.now()

  private client: PoolClient | null = null
  private _backendPid: number | null = null
  private _schema: ColumnDef[] | null = null

  /** Rows already FETCHed from the server but not yet packed into a frame */
  private buffer: unknown[][] = []
  private exhausted = false
  private declared = false
  /** BEGIN has run: no matter which later step fails, the connection must be
      ROLLBACKed before it goes back to the pool, or it is handed over stuck in
      the aborted state and the next user gets 25P02 */
  private txOpen = false
  /** Fallback path: DECLARE refused the statement, so the whole result is in memory */
  private inMemory = false

  private seq = 0
  private rowsEmitted = 0
  private doneSent = false
  private closed = false
  private cancelled = false
  private avgRowBytes = 0

  constructor(opts: PgCursorOptions) {
    this.opts = opts
    this.resultId = opts.resultId
    cursorSeq += 1
    this.name = `peek_cur_${cursorSeq.toString(36)}`
  }

  get schema(): readonly ColumnDef[] | null {
    return this._schema
  }

  /** Backend pid running this cursor; cancel() targets it with pg_cancel_backend */
  get backendPid(): number | null {
    return this._backendPid
  }

  get isClosed(): boolean {
    return this.closed
  }

  /** Open the cursor: take a connection, start a read-only transaction, DECLARE. Releases the connection itself on failure. */
  async open(): Promise<void> {
    const { pool, text, params, timeoutMs } = this.opts
    this.throwIfAborted()
    let client: PoolClient
    try {
      client = await pool.connect()
    } catch (err) {
      throw mapPgError(err, { fallback: 'CONNECTION_FAILED' })
    }
    this.client = client
    try {
      const pidRes = await client.query<{ pid: number }>('SELECT pg_backend_pid()::int4 AS pid')
      const pidRow = pidRes.rows.length > 0 ? pidRes.rows[0] : undefined
      this._backendPid = typeof pidRow?.pid === 'number' ? pidRow.pid : null
      await client.query('BEGIN READ ONLY')
      this.txOpen = true
      // The caller already validated this integer; truncating again guarantees
      // nothing but digits can reach the interpolated SQL
      const statementMs =
        timeoutMs !== undefined && timeoutMs > 0
          ? Math.trunc(timeoutMs)
          : DEFAULT_STATEMENT_TIMEOUT_MS
      await this.applyTimeouts(client, statementMs)
      await client.query({
        text: `DECLARE ${quoteIdent(this.name)} NO SCROLL CURSOR FOR ${text}`,
        values: params ? [...params] : [],
      })
      this.declared = true
    } catch (err) {
      const declareError = mapPgError(err, { sql: text })
      // DECLARE only accepts SELECT / VALUES / TABLE; EXPLAIN, SHOW and friends
      // fall back to a single one-shot query
      if (this.canFallback(declareError.driverCode)) {
        try {
          await this.runInMemory()
          return
        } catch (err2) {
          await this.close()
          throw mapPgError(err2, { sql: text })
        }
      }
      await this.close()
      throw declareError
    }
  }

  /**
   * Arm two server-side safeguards on the cursor's transaction: a per-statement
   * timeout and a transaction idle timeout.
   *
   * Both are sent in one round trip (the simple query protocol allows multiple
   * statements). PostgreSQL-compatible engines (CockroachDB, Yugabyte, …) may not
   * know `idle_in_transaction_session_timeout`; that aborts the whole
   * transaction, so it has to be reopened and armed with the universally
   * supported `statement_timeout` alone — otherwise the DECLARE that follows is
   * guaranteed to fail with 25P02.
   */
  private async applyTimeouts(client: PoolClient, statementMs: number): Promise<void> {
    try {
      await client.query(
        `SET LOCAL statement_timeout = ${statementMs};`
        + ` SET LOCAL idle_in_transaction_session_timeout = ${IDLE_TX_TIMEOUT_MS}`,
      )
    } catch {
      await client.query('ROLLBACK')
      await client.query('BEGIN READ ONLY')
      await client.query(`SET LOCAL statement_timeout = ${statementMs}`)
    }
  }

  private canFallback(sqlState: string | undefined): boolean {
    return sqlState === '42601' || sqlState === '0A000' || sqlState === '25006'
  }

  /** Fallback path: the statement cannot back a cursor, so run it once and buffer the whole result */
  private async runInMemory(): Promise<void> {
    const client = this.client
    if (!client) throw peekErrorMsg('INTERNAL', 'error.driver.cursorReleased')
    // The failed statement left the transaction aborted; roll back before retrying
    await client.query('ROLLBACK')
    await client.query('BEGIN READ ONLY')
    this.txOpen = true
    // SET LOCAL does not survive into the new transaction; arm the timeouts again
    const { timeoutMs } = this.opts
    await this.applyTimeouts(
      client,
      timeoutMs !== undefined && timeoutMs > 0 ? Math.trunc(timeoutMs) : DEFAULT_STATEMENT_TIMEOUT_MS,
    )
    const res = await client.query<unknown[], unknown[]>({
      text: this.opts.text,
      values: this.opts.params ? [...this.opts.params] : [],
      rowMode: 'array',
    })
    this.ensureSchema(res.fields)
    this.buffer = res.rows
    this.exhausted = true
    this.inMemory = true
  }

  private throwIfAborted(): void {
    if (this.cancelled) throw peekErrorMsg('CANCELLED', 'error.driver.queryCancelled')
    if (this.opts.signal?.aborted) throw peekErrorMsg('CANCELLED', 'error.driver.queryCancelled')
  }

  /** Mark as cancelled: called once cancel() has sent pg_cancel_backend, so any further next() fails immediately */
  markCancelled(): void {
    this.cancelled = true
  }

  private ensureSchema(fields: readonly FieldDef[]): ColumnDef[] {
    if (this._schema) return this._schema
    const { catalog, columnHints } = this.opts
    const used = new Map<string, number>()
    const defs: ColumnDef[] = fields.map((f) => {
      // Column names have to be unique within a result set: duplicates get __2 / __3
      const seen = used.get(f.name) ?? 0
      used.set(f.name, seen + 1)
      const name = seen === 0 ? f.name : `${f.name}__${seen + 1}`
      const logical = catalog.logical(f.dataTypeID)
      const hint = columnHints?.get(f.name)
      const def: ColumnDef = {
        name,
        logical,
        nativeType: catalog.nativeType(f.dataTypeID),
      }
      if (isPeekableLogical(logical)) def.peekable = true
      if (hint?.nullable !== undefined) def.nullable = hint.nullable
      if (hint?.primaryKey) def.primaryKey = true
      return def
    })
    this._schema = defs
    return defs
  }

  /** Ensure the buffer holds at least `target` rows (or that the cursor is exhausted) */
  private async fill(target: number): Promise<void> {
    if (this.inMemory) return
    const client = this.client
    if (!client) throw peekErrorMsg('INTERNAL', 'error.driver.cursorReleased')
    while (!this.exhausted && this.buffer.length < target) {
      this.throwIfAborted()
      const want = target - this.buffer.length
      const sql = `FETCH FORWARD ${want} FROM ${quoteIdent(this.name)}`
      let res: QueryArrayResult<unknown[]>
      try {
        res = await client.query<unknown[], unknown[]>({ text: sql, rowMode: 'array' })
      } catch (err) {
        // After a cancel is sent, FETCH fails with 57014; report it as CANCELLED
        if (this.cancelled) throw peekErrorMsg('CANCELLED', 'error.driver.queryCancelled')
        throw mapPgError(err, { sql: this.opts.text })
      }
      this.ensureSchema(res.fields)
      const rows = res.rows
      for (const row of rows) this.buffer.push(row)
      if (rows.length < want) this.exhausted = true
    }
  }

  /** Rows for the next batch: the caller's fixed value if any, otherwise adapted to the observed row width */
  private nextBatchSize(): number {
    const fixed = this.opts.chunkRows
    if (fixed !== undefined && fixed > 0) return Math.trunc(fixed)
    if (this.avgRowBytes <= 0) return CHUNK_DEFAULT_ROWS
    return adaptiveChunkRows(this.avgRowBytes)
  }

  /**
   * Pull one frame. On failure, **release the connection before rethrowing** —
   * otherwise a cancelled or timed-out cursor keeps its pooled connection forever.
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
    if (this.closed) return null
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

    // Fetch one row beyond what is needed as a probe: it distinguishes "the last
    // batch landed exactly on the end" from "there is more", which avoids emitting
    // a pointless empty frame. want === 0 only happens on the degenerate
    // maxRows === 0 call, where nothing is queried and the schema stays empty.
    if (want > 0) await this.fill(want + 1)

    const take = Math.min(want, this.buffer.length)
    const rows = take > 0 ? this.buffer.splice(0, take) : []
    const schema = this._schema ?? []
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

  /** Idempotent close: roll the transaction back (which also drops the cursor) and return the connection to the pool */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    const client = this.client
    this.client = null
    this.buffer = []
    if (client) {
      let broken = false
      try {
        if (this.txOpen) await client.query('ROLLBACK')
      } catch {
        // If even ROLLBACK fails the connection is broken: destroy it rather than
        // handing it back to the pool for the next user
        broken = true
      } finally {
        client.release(broken)
      }
    }
    this.opts.onClosed?.()
  }
}
