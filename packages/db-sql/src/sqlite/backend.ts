import { accessSync, constants as fsConstants, statSync } from 'node:fs'
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite'
import { setImmediate as yieldToLoop } from 'node:timers/promises'
import { peekErrorMsg, type ServerInfo, type SqliteConnectionConfig } from '@peek/core'
import type { SqlBackend, SqlBackendHandle, SqlExecOptions, SqlRowStream, SqlRows } from '../connection'
import type { SqlColumnMeta } from '../dialect'
import { mapSqlError } from '../errors'
import { SQLITE_DEFAULT_SCHEMA, SQLITE_DIALECT } from './dialect'

/**
 * The SQLite backend, on **`node:sqlite`** — node's built-in module, not
 * `better-sqlite3`.
 *
 * ## Why the built-in, and not better-sqlite3
 *
 * `better-sqlite3` is a native addon: it compiles against a specific V8 ABI, so
 * every Electron upgrade needs an `electron-rebuild` pass, the rebuilt binary has
 * to be shipped inside the app bundle, and a mismatch does not fail at build time
 * — it throws `NODE_MODULE_VERSION` at the user, at runtime, inside a
 * utilityProcess whose only symptom is a connection that will not open.
 *
 * `node:sqlite` has none of that: it is compiled into the runtime. Verified in
 * this repo's Electron 43 (Node 24.18) — `DatabaseSync`, `StatementSync`,
 * `iterate()`, `columns()`, `setReturnArrays()` and `setReadBigInts()` are all
 * present, and a real query runs. It is equally present in the Node the unit
 * tests run under, so the driver is testable outside Electron.
 *
 * The API is a near-superset of what this driver needs:
 * - `new DatabaseSync(path, { readOnly: true })` — read-only is an *open flag*
 *   here, not a statement, which is why `SqlDialect.sessionSetupSql` is nearly
 *   empty for SQLite;
 * - `StatementSync.columns()` gives `{ name, type, table, database }` per column,
 *   which is where `SqlColumnMeta.typeName` comes from (null for expressions);
 * - `setReturnArrays(true)` produces row-major arrays, matching `SqlRows`;
 * - `setReadBigInts(true)` keeps 64-bit INTEGERs exact instead of rounding them
 *   into a float — the same silent-data-loss trap as MySQL's BIGINT.
 *
 * ## The one hard constraint: it is synchronous
 *
 * Every call blocks the thread. In the driver host that is tolerable — one
 * utilityProcess per connection — **provided the event loop gets a turn between
 * batches**, because the backpressure ack, the cancel flag and the host's own
 * RPC all live on that loop. Therefore:
 *
 * - `SqlRowStream.next(max)` pulls at most `max` rows from `StatementSync.iterate()`
 *   and then yields (`await new Promise(r => setImmediate(r))` or equivalent)
 *   before resolving. Draining the iterator in one go turns a large table into a
 *   frozen connection with no cancel and no progress events.
 * - Cancellation is cooperative: a flag checked between batches. There is no
 *   interrupt API on the synchronous handle, so a single oversized batch is
 *   uncancellable — one more reason batches stay small.
 *
 * ## Opening the file
 *
 * `readOnly: true` fails outright when the file does not exist (SQLITE_CANTOPEN),
 * which is the desired behaviour: peek is a viewer, and silently creating an
 * empty database because of a typo in a path is worse than an error.
 * `error.file.notFound` / `error.file.notReadable` are the two catalog keys for
 * that path — check the path before opening so the user gets those rather than a
 * bare SQLITE_CANTOPEN.
 */

/** The one path that is not a file on disk; it can only ever be a fresh empty database */
const MEMORY_PATH = ':memory:'

/**
 * A `SQLInputValue` for whatever a caller bound.
 *
 * node:sqlite accepts five shapes and throws a `TypeError` on anything else — and
 * `true` is the one a caller reaches for constantly, since `FilterSpec.value` is
 * `unknown` and a boolean column filter is ordinary. SQLite has no boolean type
 * of its own (1 / 0 is how it stores one), so the conversion is not a
 * reinterpretation, it is the same value spelled the way the engine spells it.
 */
function toSqliteParam(value: unknown): SQLInputValue {
  if (value === null || value === undefined) return null
  switch (typeof value) {
    case 'string':
    case 'number':
    case 'bigint':
      return value
    case 'boolean':
      return value ? 1 : 0
    case 'object':
      break
    default:
      return String(value)
  }
  if (value instanceof Uint8Array) return value
  if (value instanceof Date) return value.toISOString()
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

function bindParams(params: readonly unknown[]): SQLInputValue[] {
  return params.map(toSqliteParam)
}

/**
 * Column metadata for a prepared statement.
 *
 * `type` is the **declared** type of the origin column, and is null for an
 * expression — SQLite genuinely does not know what `length(x)` is until it has a
 * value. `refineColumns` fills those in from the first row.
 */
function statementColumns(stmt: StatementSync): SqlColumnMeta[] {
  let raw: ReturnType<StatementSync['columns']>
  try {
    raw = stmt.columns()
  } catch {
    // A statement with no result set (a pragma assignment, say) has no columns
    return []
  }
  return raw.map((c) => ({ name: c.name, typeName: c.type }))
}

/**
 * Fill in the columns SQLite could not type, from the storage class of the first
 * non-null value seen.
 *
 * This is the "falls back to the JS type of the first non-null value" clause in
 * `SqlDialect.logical`, and it happens **inside the first batch** — the chunk
 * protocol puts the schema on frame 0 and never repeats it, so a refinement that
 * arrived later could not be published. A column that is null all the way through
 * the first batch stays untyped, which reads as `any` / `unknown`: honest, since
 * nothing has been seen that would say otherwise.
 */
function refineColumns(columns: SqlColumnMeta[], rows: readonly unknown[][]): void {
  const pending: number[] = []
  for (let i = 0; i < columns.length; i += 1) {
    const col = columns[i]
    if (col && (col.typeName === null || col.typeName === '')) pending.push(i)
  }
  if (pending.length === 0) return
  for (const row of rows) {
    for (let p = pending.length - 1; p >= 0; p -= 1) {
      const idx = pending[p]
      if (idx === undefined) continue
      const value = row[idx]
      if (value === null || value === undefined) continue
      const col = columns[idx]
      if (col) col.typeName = storageClassOf(value)
      pending.splice(p, 1)
    }
    if (pending.length === 0) return
  }
}

/** SQLite's own five storage classes, which is exactly what a value tells us */
function storageClassOf(value: unknown): string {
  if (typeof value === 'bigint') return 'integer'
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'real'
  if (typeof value === 'string') return 'text'
  if (value instanceof Uint8Array) return 'blob'
  return 'text'
}

/* ------------------------------------------------------------------ */
/* The row stream                                                      */
/* ------------------------------------------------------------------ */

class SqliteRowStream implements SqlRowStream {
  private _columns: SqlColumnMeta[] | null = null

  private readonly stmt: StatementSync
  private readonly iterator: NodeJS.Iterator<unknown>
  private readonly signal: AbortSignal | undefined

  private ended = false
  private cancelled = false
  private closed = false
  private refined = false

  constructor(stmt: StatementSync, params: readonly unknown[], signal?: AbortSignal) {
    this.stmt = stmt
    this.signal = signal
    stmt.setReturnArrays(true)
    stmt.setReadBigInts(true)
    this.iterator = stmt.iterate(...bindParams(params)) as NodeJS.Iterator<unknown>
    this._columns = statementColumns(stmt)
  }

  get columns(): readonly SqlColumnMeta[] | null {
    return this._columns
  }

  async next(max: number): Promise<unknown[][]> {
    this.throwIfCancelled()
    const want = Math.max(1, Math.trunc(max))
    const out: unknown[][] = []
    if (!this.ended && !this.closed) {
      try {
        while (out.length < want) {
          const step = this.iterator.next()
          if (step.done === true) {
            this.ended = true
            break
          }
          out.push(step.value as unknown[])
        }
      } catch (err) {
        this.ended = true
        throw mapSqlError(SQLITE_DIALECT, err, { fallback: 'QUERY_FAILED' })
      }
    }
    if (!this.refined) {
      this.refined = true
      if (this._columns) refineColumns(this._columns, out)
    }
    // Hand the event loop a turn: the ack window, the cancel flag and the host's
    // own RPC all live on it, and nothing above has run while this batch was read
    await yieldToLoop()
    this.throwIfCancelled()
    return out
  }

  private throwIfCancelled(): void {
    if (this.cancelled || this.signal?.aborted === true) {
      throw peekErrorMsg('CANCELLED', 'error.driver.queryCancelled')
    }
  }

  /** Cooperative: there is no interrupt to send, so the flag is checked at the next batch boundary */
  cancel(): Promise<void> {
    this.cancelled = true
    return Promise.resolve()
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve()
    this.closed = true
    // Finalize the underlying statement; an iterator left open holds a read lock
    // on the database file for as long as the handle lives
    this.iterator.return?.(undefined)
    return Promise.resolve()
  }
}

/* ------------------------------------------------------------------ */
/* The handle                                                          */
/* ------------------------------------------------------------------ */

class SqliteHandle implements SqlBackendHandle {
  readonly serverInfo: ServerInfo
  readonly defaultSchema = SQLITE_DEFAULT_SCHEMA

  private readonly db: DatabaseSync
  private closed = false

  constructor(db: DatabaseSync, serverInfo: ServerInfo) {
    this.db = db
    this.serverInfo = serverInfo
  }

  /**
   * Re-assert the engine-level read-only flag, immediately before every prepare.
   *
   * `query_only` is a **runtime-settable** pragma, and `tabularQuery` passes the
   * user's statement text through untouched — so `PRAGMA query_only = 0` is a
   * statement peek will happily run, after which an INSERT or a DROP on a handle
   * opened read-write (`readOnly: false`, which the connect config and therefore
   * the MCP `connect` tool both allow) succeeds against the real file. Setting it
   * once at connect is not a guarantee; setting it before each statement is.
   *
   * The cost is a single in-process pragma with no I/O, on a synchronous handle —
   * far below the noise floor of preparing the statement that follows.
   *
   * On a handle that *was* opened read-only this is redundant but harmless: the
   * VFS flag already refuses every write, and `PRAGMA query_only = 0` there is
   * accepted while changing nothing.
   */
  private assertQueryOnly(): void {
    for (const stmt of SQLITE_DIALECT.sessionSetupSql()) this.db.exec(stmt)
  }

  exec(text: string, params: readonly unknown[], opts?: SqlExecOptions): Promise<SqlRows> {
    if (opts?.signal?.aborted === true) {
      return Promise.reject(peekErrorMsg('CANCELLED', 'error.driver.queryCancelled'))
    }
    this.assertOpen()
    try {
      this.assertQueryOnly()
      const stmt = this.db.prepare(text)
      stmt.setReturnArrays(true)
      stmt.setReadBigInts(true)
      const rows = stmt.all(...bindParams(params)) as unknown as unknown[][]
      const columns = statementColumns(stmt)
      refineColumns(columns, rows)
      return Promise.resolve({ columns, rows })
    } catch (err) {
      return Promise.reject(mapSqlError(SQLITE_DIALECT, err, { sql: text }))
    }
  }

  stream(
    text: string,
    params: readonly unknown[],
    opts: SqlExecOptions & { batchHint: number },
  ): Promise<SqlRowStream> {
    if (opts.signal?.aborted === true) {
      return Promise.reject(peekErrorMsg('CANCELLED', 'error.driver.queryCancelled'))
    }
    this.assertOpen()
    try {
      this.assertQueryOnly()
      const stmt = this.db.prepare(text)
      return Promise.resolve(new SqliteRowStream(stmt, params, opts.signal))
    } catch (err) {
      return Promise.reject(mapSqlError(SQLITE_DIALECT, err, { sql: text }))
    }
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve()
    this.closed = true
    try {
      this.db.close()
    } catch {
      // Already closed, or closed underneath us; either way there is nothing left to do
    }
    return Promise.resolve()
  }

  ping(): Promise<void> {
    this.assertOpen()
    try {
      this.db.prepare('SELECT 1').get()
      return Promise.resolve()
    } catch (err) {
      return Promise.reject(mapSqlError(SQLITE_DIALECT, err, { fallback: 'CONNECTION_LOST' }))
    }
  }

  private assertOpen(): void {
    if (this.closed) throw peekErrorMsg('CONNECTION_LOST', 'error.conn.closed')
  }
}

/* ------------------------------------------------------------------ */
/* connect                                                             */
/* ------------------------------------------------------------------ */

/**
 * Fail on a bad path with a message that names the path.
 *
 * Without this the user gets `SQLITE_CANTOPEN: unable to open database file`,
 * which does not say *which* file or *why* — and a typo in a path is the single
 * most common way this connection fails.
 */
function assertReadableFile(file: string): void {
  let isFile: boolean
  try {
    isFile = statSync(file).isFile()
  } catch {
    throw peekErrorMsg('CONNECTION_FAILED', 'error.file.notFound', { file })
  }
  if (!isFile) throw peekErrorMsg('CONNECTION_FAILED', 'error.file.notFound', { file })
  try {
    accessSync(file, fsConstants.R_OK)
  } catch {
    throw peekErrorMsg('CONNECTION_FAILED', 'error.file.notReadable', { file })
  }
}

export const sqliteBackend: SqlBackend<SqliteConnectionConfig> = {
  connect(cfg: SqliteConnectionConfig, signal?: AbortSignal): Promise<SqlBackendHandle> {
    if (signal?.aborted === true) {
      return Promise.reject(peekErrorMsg('CANCELLED', 'error.conn.connectCancelled'))
    }
    const memory = cfg.file === MEMORY_PATH
    if (!memory) assertReadableFile(cfg.file)

    // A viewer defaults to read-only; `:memory:` cannot be opened that way (there
    // is nothing to open), and an empty scratch database has nothing to protect
    const readOnly = memory ? false : (cfg.readOnly ?? true)

    let db: DatabaseSync
    try {
      db = new DatabaseSync(cfg.file, { readOnly })
    } catch (err) {
      return Promise.reject(mapSqlError(SQLITE_DIALECT, err, { fallback: 'CONNECTION_FAILED' }))
    }

    try {
      // The open flag is the OS-level guarantee; `query_only` is the engine-level
      // one, and it is what covers a handle that had to be opened read-write.
      // Being a runtime-settable pragma it is not a *durable* guarantee on its
      // own — user SQL can clear it — so `SqliteHandle.assertQueryOnly` re-asserts
      // it before every statement. This is the initial setup only.
      for (const stmt of SQLITE_DIALECT.sessionSetupSql()) db.exec(stmt)
      const info = SQLITE_DIALECT.serverInfoSql()
      const versionStmt = db.prepare(info.text)
      versionStmt.setReturnArrays(true)
      const row = versionStmt.all(...bindParams(info.params)) as unknown as unknown[][]
      const version = typeof row[0]?.[0] === 'string' ? (row[0][0] as string) : 'unknown'
      return Promise.resolve(
        new SqliteHandle(db, {
          version,
          flavor: 'SQLite',
          extra: { file: cfg.file, readOnly: String(readOnly) },
        }),
      )
    } catch (err) {
      try {
        db.close()
      } catch {
        // The handle never became usable; nothing to report from closing it
      }
      return Promise.reject(mapSqlError(SQLITE_DIALECT, err, { fallback: 'CONNECTION_FAILED' }))
    }
  },
}
