import type { ServerInfo } from '@peek/core'
import type { SqlColumnMeta } from './dialect'

/**
 * The I/O half of the SQL driver: everything the dialect layer deliberately does
 * not know about.
 *
 * Two backends implement it, and they are as different as two SQL databases get:
 *
 * | | mysql2 | node:sqlite |
 * |---|---|---|
 * | transport      | TCP, async, connection pool | a file handle, **synchronous** |
 * | streaming      | protocol-level row events with pause/resume | `StatementSync.iterate()` |
 * | cancellation   | `KILL QUERY <threadId>` on a second connection | cooperative, between batches |
 * | concurrency    | several connections at once | one handle, one statement at a time |
 *
 * The shared `SqlCursor` is written against `SqlRowStream` alone, which is why it
 * works for both: it asks for the next batch and gets one, without caring whether
 * that meant awaiting a socket or draining a synchronous iterator.
 *
 * ## Why sqlite's synchronicity is a contract concern, not an implementation detail
 *
 * `node:sqlite` has no asynchronous API — `DatabaseSync` blocks the thread for
 * the duration of every call. Inside the driver host that is survivable (one
 * utilityProcess per connection, so only this connection stalls), but only if the
 * event loop gets a turn **between batches**: the backpressure pump, the ack
 * handler and the cancellation flag all live on that loop. So
 * `SqlRowStream.next()` for SQLite must yield to the macrotask queue before
 * returning each batch, and must never drain a whole table in one call. The
 * batch-at-a-time shape below is what makes that possible.
 */

/* ================================================================== */
/* 1. Results                                                          */
/* ================================================================== */

/**
 * A finished, small result: the control plane (introspection, value peeking,
 * `SELECT VERSION()`) uses this. **Row data for a view never comes back this
 * way** — that is `SqlRowStream`'s job, because a result set has to be streamable
 * (PLAN section 8).
 *
 * Rows are row-major arrays, not objects: it is what both backends can produce
 * natively (`rowsAsArray` in mysql2, `setReturnArrays` in node:sqlite), it
 * survives duplicate column names, and transposing arrays into the columnar
 * chunk layout is a loop rather than a key lookup per cell.
 */
export interface SqlRows {
  columns: SqlColumnMeta[]
  rows: unknown[][]
}

/**
 * A streaming result, pulled one batch at a time.
 *
 * Contract:
 * - `columns` is available as soon as the first batch has been pulled, and never
 *   changes afterwards (it becomes the chunk protocol's frame-0 schema);
 * - `next(max)` returns at most `max` rows, and an empty array **only** when the
 *   stream is exhausted;
 * - `close()` is idempotent and releases the underlying statement/connection;
 * - after `cancel()` the next `next()` rejects with a `CANCELLED` PeekError.
 */
export interface SqlRowStream {
  readonly columns: readonly SqlColumnMeta[] | null
  next(max: number): Promise<unknown[][]>
  close(): Promise<void>
  /** Best effort: MySQL kills the running query server-side, SQLite stops at the next batch */
  cancel(): Promise<void>
}

/* ================================================================== */
/* 2. The backend                                                      */
/* ================================================================== */

export interface SqlExecOptions {
  /** Server-side statement timeout where the dialect has one; SQLite has none and ignores it */
  timeoutMs?: number
  signal?: AbortSignal
}

/**
 * One live database handle (a pool for MySQL, a file handle for SQLite).
 *
 * Created by `SqlBackend.connect` and owned by exactly one `SqlSession`.
 */
export interface SqlBackendHandle {
  readonly serverInfo: ServerInfo
  /**
   * The default schema of this connection: MySQL's current database, or `'main'`
   * for SQLite. `SqlIntrospector` uses it to decide which node the tree opens on,
   * and `qualify()` uses it to resolve a `RelationRef` whose schema is empty.
   */
  readonly defaultSchema: string

  /** Run a small statement to completion. Never used for view data. */
  exec(text: string, params: readonly unknown[], opts?: SqlExecOptions): Promise<SqlRows>

  /**
   * Start a streaming statement.
   *
   * `batchHint` is the cursor's current target rows-per-frame; a backend may use
   * it to size its own prefetch, and must not treat it as a total row ceiling.
   */
  stream(
    text: string,
    params: readonly unknown[],
    opts: SqlExecOptions & { batchHint: number },
  ): Promise<SqlRowStream>

  /** Idempotent; closes every pooled connection / the file handle */
  close(): Promise<void>

  /** Round-trip check for `DriverSession.ping` */
  ping(): Promise<void>
}

/** Connect-side factory. One per database, selected by the driver. */
export interface SqlBackend<C> {
  connect(cfg: C, signal?: AbortSignal): Promise<SqlBackendHandle>
}
