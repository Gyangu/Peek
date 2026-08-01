import {
  DEFAULT_PAGE_LIMIT,
  DRIVER_CAPABILITIES,
  MAX_PAGE_LIMIT,
  peekError,
  peekErrorMsg,
  type ByteRange,
  type Capability,
  type ChunkDone,
  type CollectionRef,
  type CollectionScanRequest,
  type CollectionSchemaInfo,
  type Cursor,
  type DriverId,
  type DriverSession,
  type NamespaceNode,
  type PeekedValue,
  type ResultId,
  type ServerInfo,
  type TabularQueryRequest,
  type ValueRef,
} from '@peek/core'
import type { SqlBackendHandle, SqlRowStream } from './connection'
import { SqlCursor } from './cursor'
import type { SqlDialect, SqlFlavor } from './dialect'
import { SqlIntrospector } from './introspect'
import { SqlValuePeeker, type SqlResultSource } from './peek'
import { buildScanSql } from './sql'

/**
 * One live SQL connection — **the same class for MySQL and for SQLite**.
 *
 * That is the whole claim `driver-sql` is here to test. A session is a dialect
 * plus a backend handle plus the shared machinery (introspector, cursors, value
 * peeker); if either database needs a branch inside this class, the dialect
 * interface is missing something and the fix belongs there, not here.
 *
 * Capabilities: introspect + tabularQuery + collectionScan + valuePeek + cancel,
 * for both, straight out of `DRIVER_CAPABILITIES` — so the advertised set and the
 * implemented methods cannot drift (core's host runtime asserts this at connect
 * time).
 *
 * ## Cancellation, which is where the two databases stop resembling each other
 *
 * - **MySQL**: real, server-side. Every connection has a `threadId`, and
 *   `KILL QUERY <id>` sent **on a second connection** interrupts the statement —
 *   the same shape as PostgreSQL's `pg_cancel_backend`, and for the same reason:
 *   the connection running the query is busy, so the cancel cannot travel on it.
 * - **SQLite**: cooperative. `node:sqlite` is synchronous; there is no second
 *   thread to interrupt from, and no interrupt API exposed. `cancel()` marks the
 *   cursor, which stops at its next batch boundary. Batches are small, so the
 *   observable delay is a batch, not a table.
 *
 * Both advertise `cancel` because both genuinely stop the result stream. Neither
 * may return a rejected promise when nothing is running: the contract is
 * `false`, not a throw.
 */

/** Cap on tracked result sources; past it the oldest is evicted (only affects valuePeek re-fetching) */
const MAX_TRACKED_SOURCES = 32

export interface SqlSessionOptions {
  dialect: SqlDialect
  handle: SqlBackendHandle
}

/** Clamp an optional integer, dropping it entirely when it is absent or not a number */
function clampInt(value: number | undefined, min: number, max: number): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

export class SqlSession implements DriverSession {
  readonly driverId: DriverId
  readonly capabilities: ReadonlySet<Capability>
  readonly serverInfo: ServerInfo

  protected readonly dialect: SqlDialect
  protected readonly handle: SqlBackendHandle
  protected readonly introspector: SqlIntrospector
  protected readonly peeker: SqlValuePeeker
  /** Statement per result set, used to resolve valuePeek's `resultCell` refs */
  protected readonly sources = new Map<string, SqlResultSource>()
  /** Cursors currently running; `cancel` and `close` work through this */
  protected readonly active = new Map<ResultId, SqlCursor>()

  private closed = false

  constructor(opts: SqlSessionOptions) {
    this.dialect = opts.dialect
    this.handle = opts.handle
    this.driverId = opts.dialect.flavor
    this.capabilities = new Set(capabilitiesFor(opts.dialect.flavor))
    this.serverInfo = opts.handle.serverInfo
    this.introspector = new SqlIntrospector({ dialect: opts.dialect, handle: opts.handle })
    this.peeker = new SqlValuePeeker({
      dialect: opts.dialect,
      handle: opts.handle,
      sources: this.sources,
    })
  }

  /* ---------------------------------------------------------------- */
  /* Lifecycle                                                         */
  /* ---------------------------------------------------------------- */

  /** Idempotent: close every running cursor first, then the handle */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    const cursors = [...this.active.values()]
    this.active.clear()
    this.sources.clear()
    await Promise.all(cursors.map((c) => c.close().catch(() => {})))
    await this.handle.close().catch(() => {})
  }

  async ping(): Promise<void> {
    this.assertOpen()
    await this.handle.ping()
  }

  private assertOpen(): void {
    if (this.closed) throw peekErrorMsg('CONNECTION_LOST', 'error.conn.closed')
  }

  /* ---------------------------------------------------------------- */
  /* introspect                                                        */
  /* ---------------------------------------------------------------- */

  listChildren(parentId: string | null): Promise<NamespaceNode[]> {
    this.assertOpen()
    return this.introspector.listChildren(parentId)
  }

  describeCollection(ref: CollectionRef): Promise<CollectionSchemaInfo> {
    this.assertOpen()
    return this.introspector.describeCollection(ref)
  }

  /** Manual refresh: drop the introspect cache (PLAN section 8) */
  invalidateIntrospectCache(): void {
    this.introspector.invalidate()
  }

  /* ---------------------------------------------------------------- */
  /* tabularQuery                                                      */
  /* ---------------------------------------------------------------- */

  /**
   * Run a statement the user typed.
   *
   * Read-only is enforced by the connection, not by inspecting the text
   * (`SqlDialect.sessionSetupSql` for MySQL, the open flag for SQLite): parsing
   * SQL to decide whether it writes is a losing game — `WITH … SELECT` looks like
   * a write to a naive matcher, a stored procedure call looks like a read, and
   * the database already has an answer that cannot be fooled.
   */
  // `async` even though nothing is awaited: `scan` genuinely is asynchronous, and
  // a sibling that threw synchronously would make the two behave differently for
  // any caller holding the promise rather than the call
  async query(req: TabularQueryRequest): Promise<Cursor> {
    this.assertOpen()
    const text = req.text.trim()
    if (text.length === 0) throw peekErrorMsg('BAD_REQUEST', 'error.query.emptyText')
    const params = req.params ? [...req.params] : []
    return this.startCursor(req.resultId, text, params, {
      ...optional('maxRows', clampInt(req.maxRows, 0, Number.MAX_SAFE_INTEGER)),
      ...optional('chunkRows', clampInt(req.chunkRows, 1, MAX_PAGE_LIMIT)),
      ...optional('timeoutMs', clampInt(req.timeoutMs, 1, Number.MAX_SAFE_INTEGER)),
      ...(req.signal ? { signal: req.signal } : {}),
    })
  }

  /* ---------------------------------------------------------------- */
  /* collectionScan                                                    */
  /* ---------------------------------------------------------------- */

  /**
   * Browse one table.
   *
   * `cursorToken` is the absolute row offset of the next page, decimal-encoded —
   * the same convention as driver-postgres, deliberately, so the table view and
   * the MCP tools treat all three SQL drivers identically. A malformed token is
   * BAD_REQUEST (`error.sql.invalidCursorToken`), never a silent restart from
   * row 0.
   *
   * `nativeFilter` has no meaning for a SQL driver — `FilterSpec` covers what SQL
   * can express — so receiving one must be rejected with BAD_REQUEST rather than
   * ignored (see `CollectionScanRequest.nativeFilter`).
   */
  async scan(req: CollectionScanRequest): Promise<Cursor> {
    this.assertOpen()
    if (req.nativeFilter !== undefined) {
      // Silently dropping it would hand the caller more rows than they asked for
      // with no way to notice. Plain English literal: only an MCP caller can
      // produce a nativeFilter, and that surface is never localized.
      throw peekError(
        'BAD_REQUEST',
        `The ${this.dialect.flavor} driver has no native filter dialect; express the predicate with filter[] instead`,
      )
    }
    const rel = SqlIntrospector.requireRelation(this.dialect, this.handle.defaultSchema, req.ref)

    // cursorToken is the absolute offset at the end of the previous page; when
    // present it overrides offset
    const tokenOffset = req.cursorToken === undefined ? undefined : Number(req.cursorToken)
    if (
      req.cursorToken !== undefined
      && (tokenOffset === undefined || !Number.isFinite(tokenOffset) || tokenOffset < 0)
    ) {
      throw peekErrorMsg('BAD_REQUEST', 'error.sql.invalidCursorToken', { token: req.cursorToken })
    }
    const offset = clampInt(tokenOffset ?? req.offset ?? 0, 0, Number.MAX_SAFE_INTEGER) ?? 0
    const limit = clampInt(req.limit ?? DEFAULT_PAGE_LIMIT, 0, MAX_PAGE_LIMIT) ?? DEFAULT_PAGE_LIMIT

    const built = buildScanSql(this.dialect, {
      ref: rel,
      ...(req.filter ? { filter: req.filter } : {}),
      ...(req.sort ? { sort: req.sort } : {}),
      ...(req.columns ? { columns: req.columns } : {}),
      offset,
      limit,
    })

    const hints = await this.introspector.columnHints(rel)

    // A full page usually means there is more, so hand back a cursor for the next one
    const finish = (rows: number): Pick<ChunkDone, 'truncated' | 'nextCursor'> =>
      rows >= limit && limit > 0 ? { nextCursor: String(offset + rows) } : {}

    return this.startCursor(req.resultId, built.text, built.params, {
      columnHints: hints,
      finish,
      ...optional('chunkRows', clampInt(req.chunkRows, 1, MAX_PAGE_LIMIT)),
      ...optional('timeoutMs', clampInt(req.timeoutMs, 1, Number.MAX_SAFE_INTEGER)),
      ...(req.signal ? { signal: req.signal } : {}),
    })
  }

  /**
   * Wire one statement up to a cursor.
   *
   * The stream is opened lazily by the cursor, so this is synchronous apart from
   * the bookkeeping: the `open` callback below is what finally reaches the
   * backend, on the first `next()`.
   */
  private startCursor(
    resultId: ResultId,
    text: string,
    params: unknown[],
    opts: {
      maxRows?: number
      chunkRows?: number
      timeoutMs?: number
      signal?: AbortSignal
      columnHints?: ReadonlyMap<string, { nullable?: boolean; primaryKey?: boolean }>
      finish?: (rows: number, exhausted: boolean) => Pick<ChunkDone, 'truncated' | 'nextCursor'>
    },
  ): Cursor {
    if (this.active.has(resultId)) {
      throw peekErrorMsg('CONFLICT', 'error.query.alreadyRunning', { resultId })
    }
    this.trackSource(resultId, { text, params, columns: null })

    const { timeoutMs, signal, ...cursorOpts } = opts
    const cursor: SqlCursor = new SqlCursor({
      dialect: this.dialect,
      resultId,
      ...cursorOpts,
      ...(signal ? { signal } : {}),
      open: (batchHint: number): Promise<SqlRowStream> =>
        this.handle.stream(text, params, {
          batchHint,
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
          ...(signal ? { signal } : {}),
        }),
      onClosed: (): void => {
        // Hand the frame-0 schema over to valuePeek on close, saving it a probe
        const src = this.sources.get(resultId)
        if (src && src.columns === null && cursor.schema) src.columns = [...cursor.schema]
        this.active.delete(resultId)
      },
    })
    this.active.set(resultId, cursor)
    return cursor
  }

  /* ---------------------------------------------------------------- */
  /* valuePeek                                                         */
  /* ---------------------------------------------------------------- */

  peekValue(ref: ValueRef, range?: ByteRange): Promise<PeekedValue> {
    this.assertOpen()
    return this.peeker.peek(ref, range)
  }

  /* ---------------------------------------------------------------- */
  /* cancel                                                            */
  /* ---------------------------------------------------------------- */

  /** See the class comment: server-side for MySQL, cooperative for SQLite. False, never a throw, when nothing is running. */
  async cancel(resultId: ResultId): Promise<boolean> {
    const cursor = this.active.get(resultId)
    if (!cursor || cursor.isClosed) return false
    // Sets the flag (so no further row can reach the caller) and asks the backend
    // to stop; the backend half is best effort and is not awaited, because the
    // layer above allows only a couple of seconds before it kills the process
    cursor.markCancelled()
    return true
  }

  /** Remember the statement behind a result set, evicting the oldest past the cap */
  protected trackSource(resultId: ResultId, src: SqlResultSource): void {
    this.sources.set(resultId, src)
    while (this.sources.size > MAX_TRACKED_SOURCES) {
      const oldest = this.sources.keys().next()
      if (oldest.done) break
      this.sources.delete(oldest.value)
    }
  }
}

/** The capability set for a flavor, read straight off core's table so there is one source of truth */
export function capabilitiesFor(flavor: SqlFlavor): readonly Capability[] {
  return DRIVER_CAPABILITIES[flavor]
}

/** `{ key: value }` when the value exists, `{}` when it does not — keeps optional fields off the object entirely */
function optional<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Partial<Record<K, V>>)
}
