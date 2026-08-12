import {
  peekError,
  peekErrorMsg,
  type MysqlConnectionConfig,
  type PeekErrorCode,
  type ServerInfo,
} from '@peek/core'
import type { Readable } from 'node:stream'
import mysql from 'mysql2/promise'
import type {
  SqlBackend,
  SqlBackendHandle,
  SqlExecOptions,
  SqlRowStream,
  SqlRows,
} from '../connection'
import type { SqlColumnMeta } from '../dialect'
import { mapSqlError } from '../errors'
import { MYSQL_DIALECT, mysqlStatementSetupSql } from './dialect'

/**
 * The MySQL backend, on `mysql2/promise`.
 *
 * ## Connection shape: a pool, for the same reason PostgreSQL needs one
 *
 * Cancellation is `KILL QUERY <threadId>`, and it has to travel on a **different**
 * connection than the one running the query — with a single connection the
 * cancel request queues behind the statement it is trying to kill. So: a pool
 * for cursors and control-plane reads, and a throwaway connection for the kill
 * (a cursor-saturated pool is exactly when cancelling matters most, so the kill
 * must never queue for a pooled connection).
 *
 * ## Client options that are not optional
 *
 * | option | why |
 * |---|---|
 * | `rowsAsArray: true` | rows arrive as arrays: duplicate column names survive, and the columnar transpose is a loop |
 * | `supportBigNumbers: true`, `bigNumberStrings: false` | BIGINT past 2^53 comes back as a decimal string, not a silently wrong `number` |
 * | `dateStrings: true` | DATE/DATETIME stay verbatim; converting to a `Date` applies the *client's* time zone to a value the server never said was UTC |
 * | `decimalNumbers: false` | DECIMAL stays a string — it is arbitrary precision, and a float is a wrong answer |
 * | `multipleStatements: false` | the default, and it stays that way: peek runs one statement per request |
 * | `namedPlaceholders: false` | `?` is positional, which is what `SqlDialect.placeholder` promises |
 *
 * The BIGINT and DECIMAL rows are the ones that turn into silent data loss rather
 * than a visible failure, which is why they are pinned here rather than left to
 * the implementation.
 *
 * ## Streaming
 *
 * `connection.query(...).stream()` (or the `result`/`end` events with
 * `connection.pause()` / `.resume()`) is the only shape that streams: awaiting
 * the promise API buffers the whole result set in the driver process, which
 * defeats the entire chunk protocol on a million-row table. A streaming query
 * pins its connection until it ends or is destroyed, exactly like a PostgreSQL
 * cursor, so `SqlRowStream.close()` must return it to the pool on every path.
 *
 * ## Which protocol carries which statement
 *
 * One rule, applied by both `exec` and `stream`: **parameters mean the binary
 * protocol** (`execute`, a server-side prepared statement), **no parameters means
 * the text protocol** (`query`).
 *
 * The half that matters is the first: every value peek sends to MySQL travels as
 * a bound parameter, so no user value is ever spliced into statement text. The
 * second half exists because MySQL refuses to *prepare* a handful of statements
 * it will happily *run* (`ER_UNSUPPORTED_PS`), and a statement with no parameters
 * has nothing to bind and therefore nothing to protect — so it may as well take
 * the route that accepts everything the server accepts. Both protocols were
 * checked to decode identically for BIGINT, DECIMAL, BLOB, JSON and the date
 * types, which is the property that makes the rule invisible to the layers above.
 */

/**
 * Pool capacity. A streaming cursor pins its connection for its whole life and
 * the control plane (introspect / peek / ping) borrows from the same pool, so
 * there is headroom: with four large result views open at once, metadata queries
 * can still get a connection.
 */
const POOL_MAX = 8

/** Connect timeout for the cancellation-only connection; must fail well inside the caller's cancel budget */
const CANCEL_CONNECT_TIMEOUT_MS = 1_500

const DEFAULT_CONNECT_TIMEOUT_MS = 15_000

/** MySQL's binary charset: a string-ish column carrying this holds bytes, not text */
const BINARY_CHARSET = 63

/**
 * Protocol type code → the name `information_schema.DATA_TYPE` would have used.
 *
 * The wire protocol identifies a column by a number, the catalog by a name, and
 * `SqlDialect.logical` reads names — so this table is what makes a streamed
 * result and a `describeCollection` agree about what a column is.
 */
const MYSQL_TYPE_NAMES: Readonly<Record<number, string>> = {
  0: 'decimal', 246: 'decimal',
  1: 'tinyint', 2: 'smallint', 3: 'int', 9: 'mediumint', 8: 'bigint',
  4: 'float', 5: 'double',
  6: 'null',
  7: 'timestamp', 12: 'datetime', 10: 'date', 14: 'date', 11: 'time', 13: 'year',
  15: 'varchar', 253: 'varchar', 254: 'char',
  16: 'bit',
  242: 'vector',
  245: 'json',
  247: 'enum', 248: 'set',
  249: 'tinyblob', 250: 'mediumblob', 251: 'longblob', 252: 'blob',
  255: 'geometry',
}

/** The blob family, whose members are TEXT rather than BLOB when the charset is not binary */
const MYSQL_BLOB_TEXT_NAMES: Readonly<Record<number, string>> = {
  249: 'tinytext', 250: 'mediumtext', 251: 'longtext', 252: 'text',
}

/** String-ish protocol types: only these can be "binary" in the charset-63 sense */
const MYSQL_STRINGISH_TYPES: ReadonlySet<number> = new Set([15, 249, 250, 251, 252, 253, 254])

/* ------------------------------------------------------------------ */
/* mysql2 shapes this backend actually touches                         */
/* ------------------------------------------------------------------ */

/**
 * The field packet, narrowed to what a `SqlColumnMeta` needs.
 *
 * mysql2's own `FieldPacket` type is looser than the runtime object and does not
 * carry `characterSet` on every overload, so the four fields peek reads are
 * declared here instead of fighting the published typings.
 */
interface MysqlField {
  name: string
  columnType?: number
  characterSet?: number
  flags?: number
}

/** The command object returned by the *callback-style* connection, which is the only one that streams */
interface MysqlStreamCommand {
  on(event: 'fields', listener: (fields: readonly MysqlField[]) => void): unknown
  stream(options?: { highWaterMark?: number }): Readable
}

/**
 * The raw connection hiding under a promise `PoolConnection`.
 *
 * `PoolConnection.connection` is typed as another promise connection but is in
 * fact the callback-style one, and that is the object whose `query` / `execute`
 * return a streamable command rather than a promise. It is also an EventEmitter,
 * which is where a connection-level fault is reported — see
 * {@link MysqlRowStream.connectionLost}.
 */
interface MysqlRawConnection {
  threadId: number
  query(options: { sql: string; values?: readonly unknown[]; rowsAsArray?: boolean }): MysqlStreamCommand
  execute(options: { sql: string; values?: readonly unknown[]; rowsAsArray?: boolean }): MysqlStreamCommand
  on(event: 'error' | 'end', listener: (err?: unknown) => void): unknown
  off(event: 'error' | 'end', listener: (err?: unknown) => void): unknown
}

/** The pooled connection as handed to the `connection` event: callback-style, pre-handout */
interface MysqlPooledRaw {
  query(sql: string, callback: (err: unknown) => void): void
  destroy(): void
}

/** NOT_NULL_FLAG / PRI_KEY_FLAG, the two flags peek reads out of a field packet */
const FLAG_NOT_NULL = 1
const FLAG_PRI_KEY = 2

function fieldToMeta(field: MysqlField): SqlColumnMeta {
  const type = field.columnType
  const binary = type !== undefined
    && MYSQL_STRINGISH_TYPES.has(type)
    && field.characterSet === BINARY_CHARSET
  const textName = type !== undefined && !binary ? MYSQL_BLOB_TEXT_NAMES[type] : undefined
  const meta: SqlColumnMeta = {
    name: field.name,
    typeName: textName ?? (type === undefined ? null : MYSQL_TYPE_NAMES[type] ?? null),
  }
  if (type !== undefined) meta.typeCode = type
  if (binary) meta.binary = true
  const flags = field.flags
  if (typeof flags === 'number') {
    meta.nullable = (flags & FLAG_NOT_NULL) === 0
    if ((flags & FLAG_PRI_KEY) !== 0) meta.primaryKey = true
  }
  return meta
}

/* ------------------------------------------------------------------ */
/* Connection options                                                  */
/* ------------------------------------------------------------------ */

interface MysqlBaseOptions {
  uri?: string
  host?: string
  port?: number
  database?: string
  user?: string
  password?: string
  ssl?: string
  connectTimeout: number
  rowsAsArray: true
  supportBigNumbers: true
  bigNumberStrings: false
  dateStrings: true
  decimalNumbers: false
  multipleStatements: false
  namedPlaceholders: false
}

/** Only set fields that have a value: mysql2 reads an explicit undefined as a deliberate empty */
function buildOptions(cfg: MysqlConnectionConfig): MysqlBaseOptions {
  const out: MysqlBaseOptions = {
    connectTimeout: clampTimeout(cfg.connectTimeoutMs) ?? DEFAULT_CONNECT_TIMEOUT_MS,
    rowsAsArray: true,
    supportBigNumbers: true,
    bigNumberStrings: false,
    dateStrings: true,
    decimalNumbers: false,
    multipleStatements: false,
    namedPlaceholders: false,
  }
  if (cfg.url !== undefined) out.uri = cfg.url
  if (cfg.host !== undefined) out.host = cfg.host
  if (cfg.port !== undefined) out.port = cfg.port
  if (cfg.database !== undefined) out.database = cfg.database
  if (cfg.user !== undefined) out.user = cfg.user
  if (cfg.password !== undefined) out.password = cfg.password
  // mysql2 accepts the profile name form for TLS; `true` alone is not a valid value
  if (cfg.ssl === true) out.ssl = 'Amazon RDS'
  return out
}

function clampTimeout(ms: number | undefined): number | undefined {
  if (ms === undefined || !Number.isFinite(ms)) return undefined
  return Math.min(600_000, Math.max(100, Math.trunc(ms)))
}

/* ------------------------------------------------------------------ */
/* The row stream                                                      */
/* ------------------------------------------------------------------ */

class MysqlRowStream implements SqlRowStream {
  private _columns: SqlColumnMeta[] | null = null

  private readonly rows: Readable
  private readonly release: (broken: boolean) => void
  private readonly kill: () => Promise<void>

  private ended = false
  private failure: unknown = null
  /** Which code an unrecognised {@link failure} collapses to; a lost connection is not a query fault */
  private failureFallback: PeekErrorCode = 'QUERY_FAILED'
  private cancelled = false
  private closed = false
  /** Resolved by whichever of readable / end / error / connectionLost fires next */
  private waiter: (() => void) | null = null

  constructor(opts: {
    command: MysqlStreamCommand
    highWaterMark: number
    release: (broken: boolean) => void
    kill: () => Promise<void>
  }) {
    this.release = opts.release
    this.kill = opts.kill
    // Registered before `stream()` so the field packet cannot arrive first.
    //
    // `fields` is `undefined` for a statement that produced no result set: mysql2's
    // `Query.doneInsert` emits it that way before calling `done()`. A listener that
    // throws there (which `undefined.map` does) aborts `doneInsert` *before*
    // `stream.push(null)` — the readable then never ends and every `next()` waits
    // forever, with the TypeError swallowed by the pool's error handler. So the
    // guard below is not defensiveness, it is the difference between `SET`/`DO`/
    // `USE` returning an empty result and hanging the connection.
    opts.command.on('fields', (fields) => {
      if (this._columns === null) this._columns = Array.isArray(fields) ? fields.map(fieldToMeta) : []
    })
    this.rows = opts.command.stream({ highWaterMark: Math.max(1, opts.highWaterMark) })
    // Persistent listeners rather than per-wait ones: an `end` that fires between
    // two `next()` calls must still be observed, or the last batch hangs forever
    this.rows.on('readable', () => this.wake())
    this.rows.on('end', () => {
      this.ended = true
      this.wake()
    })
    this.rows.on('error', (err: unknown) => {
      this.failure = err
      this.wake()
    })
  }

  get columns(): readonly SqlColumnMeta[] | null {
    return this._columns
  }

  async next(max: number): Promise<unknown[][]> {
    const out: unknown[][] = []
    const want = Math.max(1, Math.trunc(max))
    for (;;) {
      if (this.cancelled) throw peekErrorMsg('CANCELLED', 'error.driver.queryCancelled')
      const row: unknown = this.rows.read()
      if (row !== null && row !== undefined) {
        // An OK-packet statement has no result set, and mysql2 pushes its
        // `ResultSetHeader` down the same readable a row would travel on. It is
        // the end of the data, not a row: forwarding it would put an object where
        // the columnar transpose expects a tuple, and every column would read
        // `undefined`. `rowsAsArray` is pinned on, so a real row is always an
        // array — which makes the two cases distinguishable with certainty.
        if (!Array.isArray(row)) {
          this.ended = true
          return out
        }
        out.push(row as unknown[])
        if (out.length >= want) return out
        continue
      }
      if (this.failure !== null) {
        throw mapSqlError(MYSQL_DIALECT, this.failure, { fallback: this.failureFallback })
      }
      // An empty array is the exhaustion signal (connection.ts); rows already
      // collected go out first, and the next call reports the end
      if (this.ended || this.closed) return out
      await this.waitForWake()
    }
  }

  /**
   * The connection carrying this cursor died; settle `next()` instead of waiting.
   *
   * ## The hang this prevents
   *
   * The three listeners in the constructor watch the `Query` readable, and a
   * connection-level fault never travels down it. mysql2 reports such a fault in
   * `Connection._notifyError`, which hands the error to the active command's
   * `onResult` callback — and a *streaming* query has none, so the error is
   * emitted on the **connection** (`bubbleErrorToConnection`, and unconditionally
   * so for a pooled connection) and the readable is simply abandoned: no `error`,
   * no `end`, no `readable`. `waitForWake()` then waits for an event that can
   * never arrive.
   *
   * Measured before the fix: after `KILL CONNECTION`, `next()` was still pending
   * 30s later with the server-side thread long gone. Nothing rescued it except an
   * explicit `cancel()`; in the app the whole-fetch deadline in main eventually
   * fired and reported TIMEOUT — the wrong reason, up to two minutes late, for a
   * connection that was already gone. MySQL restarts, `wait_timeout` and ordinary
   * network trouble all take this path.
   *
   * Rows already buffered in the readable are still delivered first: `next()`
   * drains what arrived before it looks at `failure`.
   */
  connectionLost(err: unknown): void {
    // A stream that already reached `end`, was cancelled, or was closed has its
    // outcome; the connection dropping afterwards changes nothing about it.
    if (this.ended || this.closed || this.cancelled || this.failure !== null) return
    this.failure = err ?? peekErrorMsg('CONNECTION_LOST', 'error.conn.lost', undefined, { retryable: true })
    this.failureFallback = 'CONNECTION_LOST'
    this.wake()
  }

  private wake(): void {
    const waiter = this.waiter
    this.waiter = null
    if (waiter) waiter()
  }

  private waitForWake(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.waiter = resolve
    })
  }

  /** `KILL QUERY` on a side connection: the one running the statement is busy */
  async cancel(): Promise<void> {
    if (this.cancelled) return
    this.cancelled = true
    this.wake()
    await this.kill()
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.wake()
    // A connection abandoned mid-result set still has rows queued on the socket;
    // handing it back to the pool in that state poisons the next borrower, so it
    // is destroyed instead. Only a stream that reached `end` is reusable.
    //
    // The connection goes first: tearing the socket down before releasing the
    // readable stops mysql2 from parsing one more row packet out of a result set
    // nobody is reading any more, which it reports as "packets out of order".
    //
    // A cancelled stream is never clean, even when it looks like it ended: MySQL
    // answers `KILL QUERY` by cutting the result set short, and mysql2 reports
    // that as a plain `end` (with a "packets out of order" warning it prints
    // itself). Reusing such a connection would hand the next borrower a socket
    // whose packet sequence is out of step.
    const clean = this.ended && this.failure === null && !this.cancelled
    this.release(!clean)
    if (!clean) this.rows.destroy()
    return Promise.resolve()
  }
}

/* ------------------------------------------------------------------ */
/* The handle                                                          */
/* ------------------------------------------------------------------ */

class MysqlHandle implements SqlBackendHandle {
  readonly serverInfo: ServerInfo
  readonly defaultSchema: string

  private readonly pool: mysql.Pool
  private readonly options: MysqlBaseOptions
  private closed = false

  constructor(pool: mysql.Pool, options: MysqlBaseOptions, serverInfo: ServerInfo, defaultSchema: string) {
    this.pool = pool
    this.options = options
    this.serverInfo = serverInfo
    this.defaultSchema = defaultSchema
  }

  /**
   * Borrow a connection and make it safe for exactly one statement.
   *
   * Both halves of "safe" are per-checkout properties, which is why this cannot
   * live on the pool's `connection` event (that fires once per *physical*
   * connect):
   *
   * - **read-only.** `tabularQuery` passes the user's statement text through
   *   untouched, so one `SET SESSION TRANSACTION READ WRITE` would leave that
   *   pooled connection writable for the rest of its life and every later
   *   borrower with it. Re-asserting here undoes any such flip.
   * - **the caller's timeout.** `max_execution_time` is the only per-statement
   *   budget MySQL has, and it is session state — so it has to be (re)set for the
   *   statement that is about to run, not once at connect.
   *
   * A connection whose setup fails is destroyed rather than returned. An ordinary
   * transaction left open by a previous borrower is *not* such a failure — this
   * comment used to claim it was, and a real MySQL 8 disagreed: `SET SESSION
   * TRANSACTION …` is perfectly legal mid-transaction, it simply applies to the
   * *next* transaction and leaves the open one exactly as writable as it was.
   * That is the whole reason `mysqlStatementSetupSql` now leads with `ROLLBACK`:
   * ending the transaction is what keeps a `START TRANSACTION READ WRITE` from
   * surviving into the next checkout.
   *
   * What does fail here is an XA transaction left ACTIVE, where `ROLLBACK` raises
   * `XAER_RMFAIL`. Destroying the connection is the right answer to that, and it
   * also rolls the XA branch back server-side.
   */
  private async borrow(text: string, timeoutMs: number | undefined): Promise<mysql.PoolConnection> {
    let conn: mysql.PoolConnection
    try {
      conn = await this.pool.getConnection()
    } catch (err) {
      throw mapSqlError(MYSQL_DIALECT, err, { sql: text, fallback: 'CONNECTION_FAILED' })
    }
    try {
      for (const stmt of mysqlStatementSetupSql(timeoutMs)) await conn.query(stmt)
    } catch (err) {
      conn.destroy()
      throw mapSqlError(MYSQL_DIALECT, err, { sql: text, fallback: 'CONNECTION_FAILED' })
    }
    return conn
  }

  async exec(text: string, params: readonly unknown[], opts?: SqlExecOptions): Promise<SqlRows> {
    if (opts?.signal?.aborted === true) throw peekErrorMsg('CANCELLED', 'error.driver.queryCancelled')
    const values = [...params]
    const request = { sql: text, values, rowsAsArray: true }
    const conn = await this.borrow(text, opts?.timeoutMs)
    let result: unknown
    try {
      // See the header: parameters mean the prepared binary protocol
      result = values.length > 0 ? await conn.execute(request) : await conn.query(request)
    } catch (err) {
      throw mapSqlError(MYSQL_DIALECT, err, { sql: text })
    } finally {
      // A completed statement leaves the socket in step, error or not, so the
      // connection is reusable; only an abandoned *stream* is not (see close())
      conn.release()
    }
    const [rows, fields] = result as [unknown, readonly MysqlField[] | undefined]
    return {
      columns: (fields ?? []).map(fieldToMeta),
      rows: Array.isArray(rows) ? (rows as unknown[][]) : [],
    }
  }

  async stream(
    text: string,
    params: readonly unknown[],
    opts: SqlExecOptions & { batchHint: number },
  ): Promise<SqlRowStream> {
    if (opts.signal?.aborted === true) throw peekErrorMsg('CANCELLED', 'error.driver.queryCancelled')
    const conn = await this.borrow(text, opts.timeoutMs)
    const raw = conn.connection as unknown as MysqlRawConnection
    const threadId = raw.threadId
    const values = [...params]
    const request = { sql: text, values, rowsAsArray: true }
    let released = false
    // Assigned once the listeners below are attached; the release path has to be
    // able to call it whether or not it got that far.
    let detach = (): void => {}
    try {
      const command = values.length > 0 ? raw.execute(request) : raw.query(request)
      const rows = new MysqlRowStream({
        command,
        highWaterMark: opts.batchHint,
        release: (broken: boolean): void => {
          if (released) return
          released = true
          // Before the connection goes anywhere: a listener left on a connection
          // handed back to the pool would fire for the *next* borrower's fault.
          detach()
          if (broken) conn.destroy()
          else conn.release()
        },
        kill: (): Promise<void> => this.killQuery(threadId),
      })

      // The connection, not the readable, is where mysql2 reports that the socket
      // died under a streaming query — see `MysqlRowStream.connectionLost`.
      const onError = (err?: unknown): void => rows.connectionLost(err)
      const onEnd = (): void => rows.connectionLost(undefined)
      raw.on('error', onError)
      raw.on('end', onEnd)
      detach = (): void => {
        raw.off('error', onError)
        raw.off('end', onEnd)
      }
      return rows
    } catch (err) {
      detach()
      conn.destroy()
      throw mapSqlError(MYSQL_DIALECT, err, { sql: text })
    }
  }

  /**
   * Interrupt one running statement.
   *
   * The connection is created for this and thrown away: every cursor holds a
   * pooled connection until it closes, so once a few large views are open
   * `getConnection()` queues — and the moment cancelling matters most is exactly
   * the moment the pool is saturated.
   */
  private async killQuery(threadId: number): Promise<void> {
    if (!Number.isFinite(threadId)) return
    let side: mysql.Connection | null = null
    try {
      side = await mysql.createConnection({
        ...this.options,
        connectTimeout: CANCEL_CONNECT_TIMEOUT_MS,
      })
      // threadId is a server-assigned integer peek never lets a user set; KILL
      // takes no placeholder, so it is truncated rather than bound
      await side.query(`KILL QUERY ${Math.trunc(threadId)}`)
    } catch {
      // Best effort: the cursor is already flagged cancelled, so no further row
      // can reach the caller whether or not the server heard us
    } finally {
      if (side) void side.end().catch(() => {})
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.pool.end().catch(() => {})
  }

  async ping(): Promise<void> {
    try {
      await this.pool.query('SELECT 1')
    } catch (err) {
      throw mapSqlError(MYSQL_DIALECT, err, { fallback: 'CONNECTION_LOST' })
    }
  }
}

/* ------------------------------------------------------------------ */
/* connect                                                             */
/* ------------------------------------------------------------------ */

export const mysqlBackend: SqlBackend<MysqlConnectionConfig> = {
  async connect(cfg: MysqlConnectionConfig, signal?: AbortSignal): Promise<SqlBackendHandle> {
    if (signal?.aborted === true) throw peekErrorMsg('CANCELLED', 'error.conn.connectCancelled')
    const options = buildOptions(cfg)
    const pool = mysql.createPool({
      ...options,
      connectionLimit: POOL_MAX,
      waitForConnections: true,
      enableKeepAlive: true,
    })
    // A dropped idle connection raises an error event; unhandled, it takes the
    // whole driver-host process down. mysql2's promise Pool types `on` with one
    // overload per known event and omits 'error', which the underlying emitter
    // does raise — hence the narrowing to the one method being used.
    ;(pool as unknown as { on(event: 'error', listener: () => void): void }).on('error', () => {})

    /**
     * Read-only enforcement for every connection the pool ever opens.
     *
     * The event fires synchronously before the connection is handed out, and
     * mysql2 keeps one ordered command queue per connection, so the setup
     * statements are guaranteed to run before the borrower's first query even
     * though nothing here is awaited. A setup that fails destroys the connection
     * rather than letting a writable one escape into the pool.
     *
     * This covers the paths that go straight through the pool (`probeServer`,
     * `assertReadOnly`, `ping`) — but it fires **once per physical connect**, not
     * per checkout, so it is not on its own a guarantee: session state survives a
     * release back into the pool, and user statement text can change it. The
     * statement paths re-assert it per borrow; see `MysqlHandle.borrow`.
     */
    const setup = MYSQL_DIALECT.sessionSetupSql()
    pool.on('connection', (pooled) => {
      const raw = pooled as unknown as MysqlPooledRaw
      for (const stmt of setup) {
        raw.query(stmt, (err: unknown) => {
          if (err) raw.destroy()
        })
      }
    })

    try {
      const probe = await probeServer(pool)
      await assertReadOnly(pool)
      return new MysqlHandle(pool, options, probe.serverInfo, probe.database)
    } catch (err) {
      await pool.end().catch(() => {})
      throw mapSqlError(MYSQL_DIALECT, err, { fallback: 'CONNECTION_FAILED' })
    }
  },
}

async function probeServer(pool: mysql.Pool): Promise<{ serverInfo: ServerInfo; database: string }> {
  const stmt = MYSQL_DIALECT.serverInfoSql()
  const result = (await pool.query({
    sql: stmt.text,
    values: [...stmt.params],
    rowsAsArray: true,
  })) as unknown as [unknown[][], readonly MysqlField[]]
  const row = result[0][0]
  if (!row) throw peekErrorMsg('CONNECTION_FAILED', 'error.conn.serverInfoUnavailable')
  const version = typeof row[0] === 'string' ? row[0] : String(row[0] ?? '')
  const database = typeof row[1] === 'string' ? row[1] : ''
  return {
    serverInfo: {
      version,
      flavor: /mariadb/i.test(version) ? 'MariaDB' : 'MySQL',
      extra: { banner: version },
    },
    database,
  }
}

/**
 * Prove the session really is read-only before handing the connection over.
 *
 * `sessionSetupSql` is fire-and-forget on the pool's `connection` event, and a
 * viewer that silently lost its read-only guarantee is worse than one that
 * refuses to connect. Servers with no such variable (older MariaDB spells it
 * `tx_read_only`) leave the check inconclusive rather than failing the connect —
 * `SET SESSION TRANSACTION READ ONLY` still ran and still applies there.
 */
async function assertReadOnly(pool: mysql.Pool): Promise<void> {
  let value: unknown
  try {
    const result = (await pool.query({
      sql: 'SELECT @@SESSION.transaction_read_only AS ro',
      rowsAsArray: true,
    })) as unknown as [unknown[][], unknown]
    value = result[0][0]?.[0]
  } catch {
    return
  }
  const on = value === 1 || value === '1' || value === true || value === 1n
  if (!on) {
    throw peekError(
      'CONNECTION_FAILED',
      'The MySQL session did not enter read-only mode; refusing to connect a read-only viewer to a writable session',
    )
  }
}
