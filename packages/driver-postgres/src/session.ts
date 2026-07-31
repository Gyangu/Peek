import {
  DEFAULT_PAGE_LIMIT,
  DRIVER_CAPABILITIES,
  MAX_PAGE_LIMIT,
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
  type PostgresConnectionConfig,
  type ResultId,
  type ServerInfo,
  type TabularQueryRequest,
  type ValueRef,
} from '@peek/core'
import { Client, Pool, type PoolConfig } from 'pg'
import { PgCursor } from './cursor'
import { mapPgError } from './errors'
import { PgIntrospector } from './introspect'
import { PgValuePeeker, type ResultSource } from './peek'
import { buildScanSql, quoteIdent } from './sql'
import { PG_TYPE_QUERY, PgTypeCatalog } from './type-catalog'

/**
 * One live PostgreSQL connection.
 *
 * Connection management uses pg.Pool rather than a single Client, because
 * cancellation has to send pg_cancel_backend over **a different connection** —
 * with one connection, a long query occupies the only one there is and the
 * cancel request can never leave.
 *
 * Two kinds of work share the pool:
 * - data plane: each PgCursor holds a connection exclusively until it closes;
 * - control plane: introspect / describeCollection / valuePeek / ping each borrow
 *   one and hand it straight back.
 *
 * **Cancellation does not use the pool.** Cursors may well have exhausted it, and
 * that is precisely the moment cancelling matters most. cancel() opens a
 * throwaway Client of its own to send pg_cancel_backend: one extra handshake buys
 * "cancel always works" (see cancel()).
 */

/** Cap on tracked result sources; past it the oldest is evicted in insertion order (only affects valuePeek re-fetching) */
const MAX_TRACKED_SOURCES = 32

/** Largest int pg accepts, so statement_timeout and friends never overflow */
const MAX_INT32 = 2_147_483_647

/**
 * Pool capacity. Cursors are exclusive (one connection per result stream) and the
 * control plane (introspect / peek / ping) borrows from the same pool, so there
 * is headroom: with four large result views open at once, metadata queries can
 * still get a connection.
 */
const POOL_MAX = 8

/**
 * Connect timeout for the cancellation-only connection. ConnectionManager's
 * cancelMs is just 2s and escalates to killing the process when it expires, so
 * this handshake has to fail first (falling back to closing the cursor directly,
 * see cancel()).
 */
const CANCEL_CONNECT_TIMEOUT_MS = 1_500

function clampInt(value: number | undefined, min: number, max: number): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isFinite(value)) return undefined
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

/** Only set fields that actually have a value: pg reads an explicit undefined as "the user asked for empty" */
function buildPoolConfig(cfg: PostgresConnectionConfig): PoolConfig {
  const out: PoolConfig = {
    max: POOL_MAX,
    idleTimeoutMillis: 30_000,
    allowExitOnIdle: true,
    application_name: cfg.applicationName ?? 'peek',
  }
  if (cfg.url !== undefined) out.connectionString = cfg.url
  if (cfg.host !== undefined) out.host = cfg.host
  if (cfg.port !== undefined) out.port = cfg.port
  if (cfg.database !== undefined) out.database = cfg.database
  if (cfg.user !== undefined) out.user = cfg.user
  if (cfg.password !== undefined) out.password = cfg.password
  if (cfg.ssl !== undefined) out.ssl = cfg.ssl
  const timeout = clampInt(cfg.connectTimeoutMs, 100, MAX_INT32)
  out.connectionTimeoutMillis = timeout ?? 15_000
  return out
}

interface ServerProbe {
  database: string
  serverInfo: ServerInfo
}

export class PostgresSession implements DriverSession {
  readonly driverId: DriverId = 'postgres'
  readonly capabilities: ReadonlySet<Capability>
  readonly serverInfo: ServerInfo

  private readonly pool: Pool
  /** The config the pool was built from, reused for cancel's side-channel connection */
  private readonly poolConfig: PoolConfig
  private readonly catalog: PgTypeCatalog
  private readonly introspector: PgIntrospector
  private readonly peeker: PgValuePeeker

  /** Cursors currently running; cancel / close work through this */
  private readonly active = new Map<ResultId, PgCursor>()
  /** Source statement per result set, used to resolve valuePeek's resultCell refs */
  private readonly sources = new Map<ResultId, ResultSource>()

  private closed = false

  private constructor(
    pool: Pool,
    poolConfig: PoolConfig,
    catalog: PgTypeCatalog,
    probe: ServerProbe,
  ) {
    this.pool = pool
    this.poolConfig = poolConfig
    this.catalog = catalog
    this.capabilities = new Set(DRIVER_CAPABILITIES.postgres)
    this.serverInfo = probe.serverInfo
    this.introspector = new PgIntrospector({
      pool,
      catalog,
      database: probe.database,
      serverVersion: probe.serverInfo.version,
    })
    this.peeker = new PgValuePeeker({
      pool,
      catalog,
      introspector: this.introspector,
      sources: this.sources,
    })
  }

  /* ---------------------------------------------------------------- */
  /* Connecting                                                        */
  /* ---------------------------------------------------------------- */

  static async connect(
    cfg: PostgresConnectionConfig,
    signal?: AbortSignal,
  ): Promise<PostgresSession> {
    if (signal?.aborted) throw peekErrorMsg('CANCELLED', 'error.conn.connectCancelled')
    const poolConfig = buildPoolConfig(cfg)
    const pool = new Pool(poolConfig)
    // The server dropping an idle pooled connection raises an error event;
    // leaving it unhandled takes the whole process down
    pool.on('error', () => {})

    const searchPath = cfg.searchPath
    if (searchPath && searchPath.length > 0) {
      const list = searchPath.map((s) => quoteIdent(s)).join(', ')
      pool.on('connect', (client) => {
        void client.query(`SET search_path TO ${list}`).catch(() => {})
      })
    }

    try {
      const probe = await PostgresSession.probe(pool)
      const catalog = new PgTypeCatalog()
      const types = await pool.query<{
        oid: number
        typname: string
        typcategory: string
        typelem: number
      }>(PG_TYPE_QUERY)
      catalog.load(types.rows)
      return new PostgresSession(pool, poolConfig, catalog, probe)
    } catch (err) {
      await pool.end().catch(() => {})
      throw mapPgError(err, { fallback: 'CONNECTION_FAILED' })
    }
  }

  private static async probe(pool: Pool): Promise<ServerProbe> {
    const res = await pool.query<{ db: string; ver: string; full: string }>(
      `SELECT current_database() AS db,
              current_setting('server_version') AS ver,
              version() AS full`,
    )
    const row = res.rows.length > 0 ? res.rows[0] : undefined
    if (!row) throw peekErrorMsg('CONNECTION_FAILED', 'error.conn.serverInfoUnavailable')
    const flavor = /cockroach/i.test(row.full)
      ? 'CockroachDB'
      : /yugabyte/i.test(row.full)
        ? 'YugabyteDB'
        : 'PostgreSQL'
    return {
      database: row.db,
      serverInfo: { version: row.ver, flavor, extra: { banner: row.full } },
    }
  }

  /* ---------------------------------------------------------------- */
  /* Lifecycle                                                         */
  /* ---------------------------------------------------------------- */

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    const cursors = [...this.active.values()]
    this.active.clear()
    this.sources.clear()
    await Promise.all(cursors.map((c) => c.close().catch(() => {})))
    await this.pool.end().catch(() => {})
  }

  async ping(): Promise<void> {
    this.assertOpen()
    try {
      await this.pool.query('SELECT 1')
    } catch (err) {
      throw mapPgError(err, { fallback: 'CONNECTION_LOST' })
    }
  }

  private assertOpen(): void {
    if (this.closed) throw peekErrorMsg('CONNECTION_LOST', 'error.conn.closed')
  }

  /* ---------------------------------------------------------------- */
  /* introspect                                                        */
  /* ---------------------------------------------------------------- */

  async listChildren(parentId: string | null): Promise<NamespaceNode[]> {
    this.assertOpen()
    return this.introspector.listChildren(parentId)
  }

  async describeCollection(ref: CollectionRef): Promise<CollectionSchemaInfo> {
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

  async query(req: TabularQueryRequest): Promise<Cursor> {
    this.assertOpen()
    const text = req.text.trim()
    if (text.length === 0) throw peekErrorMsg('BAD_REQUEST', 'error.query.emptyText')
    const params = req.params ? [...req.params] : []
    return this.startCursor(req.resultId, text, params, {
      ...(clampInt(req.maxRows, 0, Number.MAX_SAFE_INTEGER) === undefined
        ? {}
        : { maxRows: clampInt(req.maxRows, 0, Number.MAX_SAFE_INTEGER) }),
      ...(clampInt(req.chunkRows, 1, MAX_PAGE_LIMIT) === undefined
        ? {}
        : { chunkRows: clampInt(req.chunkRows, 1, MAX_PAGE_LIMIT) }),
      ...(clampInt(req.timeoutMs, 1, MAX_INT32) === undefined
        ? {}
        : { timeoutMs: clampInt(req.timeoutMs, 1, MAX_INT32) }),
      ...(req.signal ? { signal: req.signal } : {}),
    })
  }

  /* ---------------------------------------------------------------- */
  /* collectionScan                                                    */
  /* ---------------------------------------------------------------- */

  async scan(req: CollectionScanRequest): Promise<Cursor> {
    this.assertOpen()
    const rel = PgIntrospector.requireRelation(req.ref)

    // cursorToken is the absolute offset at the end of the previous page; when
    // present it overrides offset
    const tokenOffset = req.cursorToken === undefined ? undefined : Number(req.cursorToken)
    if (req.cursorToken !== undefined && !Number.isFinite(tokenOffset)) {
      throw peekErrorMsg('BAD_REQUEST', 'error.sql.invalidCursorToken', { token: req.cursorToken })
    }
    const offset = clampInt(tokenOffset ?? req.offset ?? 0, 0, Number.MAX_SAFE_INTEGER) ?? 0
    const limit = clampInt(req.limit ?? DEFAULT_PAGE_LIMIT, 0, MAX_PAGE_LIMIT) ?? DEFAULT_PAGE_LIMIT

    const built = buildScanSql({
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
      ...(clampInt(req.chunkRows, 1, MAX_PAGE_LIMIT) === undefined
        ? {}
        : { chunkRows: clampInt(req.chunkRows, 1, MAX_PAGE_LIMIT) }),
      ...(clampInt(req.timeoutMs, 1, MAX_INT32) === undefined
        ? {}
        : { timeoutMs: clampInt(req.timeoutMs, 1, MAX_INT32) }),
      ...(req.signal ? { signal: req.signal } : {}),
    })
  }

  private async startCursor(
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
  ): Promise<Cursor> {
    if (this.active.has(resultId)) {
      throw peekErrorMsg('CONFLICT', 'error.query.alreadyRunning', { resultId })
    }
    this.trackSource(resultId, { text, params, columns: null })

    const cursor = new PgCursor({
      pool: this.pool,
      catalog: this.catalog,
      resultId,
      text,
      params,
      ...opts,
      onClosed: (): void => {
        // Hand the first-frame schema over to valuePeek on close, saving it a probe
        const src = this.sources.get(resultId)
        if (src && src.columns === null && cursor.schema) src.columns = [...cursor.schema]
        this.active.delete(resultId)
      },
    })
    this.active.set(resultId, cursor)
    try {
      await cursor.open()
    } catch (err) {
      this.active.delete(resultId)
      throw err
    }
    return cursor
  }

  private trackSource(resultId: ResultId, src: ResultSource): void {
    this.sources.set(resultId, src)
    while (this.sources.size > MAX_TRACKED_SOURCES) {
      const oldest = this.sources.keys().next()
      if (oldest.done) break
      this.sources.delete(oldest.value)
    }
  }

  /* ---------------------------------------------------------------- */
  /* valuePeek                                                         */
  /* ---------------------------------------------------------------- */

  async peekValue(ref: ValueRef, range?: ByteRange): Promise<PeekedValue> {
    this.assertOpen()
    return this.peeker.peek(ref, range)
  }

  /* ---------------------------------------------------------------- */
  /* cancel                                                            */
  /* ---------------------------------------------------------------- */

  /**
   * Real cancellation: send pg_cancel_backend over a separate connection to
   * interrupt the statement running on the server. The FETCH being awaited then
   * fails with 57014, which maps to CANCELLED. Returns false, without throwing,
   * when nothing is running (the contract requires this).
   *
   * **This connection must not come from the pool.** Each cursor holds a pooled
   * connection until it closes, so once cursors have filled the pool,
   * pool.connect() queues for the full connectionTimeoutMillis (15s) — while the
   * layer above allows only cancelMs (2s) before it kills the entire driver
   * process, taking every view on this connection down with it. Cancelling is
   * rare; one extra handshake buys "cancel always works".
   */
  async cancel(resultId: ResultId): Promise<boolean> {
    const cursor = this.active.get(resultId)
    if (!cursor || cursor.isClosed) return false
    cursor.markCancelled()
    const pid = cursor.backendPid
    if (pid === null) {
      await cursor.close().catch(() => {})
      return true
    }
    try {
      await this.sendCancelRequest(pid)
    } catch {
      // If the cancel request itself fails (insufficient privilege, cannot
      // connect), fall back to just closing the cursor
      await cursor.close().catch(() => {})
    }
    return true
  }

  /** Send pg_cancel_backend over a side-channel connection, disconnecting right after; never competes with cursors for the pool */
  private async sendCancelRequest(pid: number): Promise<void> {
    const client = new Client({
      ...this.poolConfig,
      connectionTimeoutMillis: CANCEL_CONNECT_TIMEOUT_MS,
      application_name: `${this.poolConfig.application_name ?? 'peek'}-cancel`,
    })
    // A failed connect surfaces a second time as an error event; unhandled, it
    // crashes the process
    client.on('error', () => {})
    await client.connect()
    try {
      await client.query('SELECT pg_cancel_backend($1::int4)', [pid])
    } finally {
      // Do not await end(): the cancel request is already out, and the teardown
      // round trip should not eat into the cancelMs budget
      void client.end().catch(() => {})
    }
  }
}
