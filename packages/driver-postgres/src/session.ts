import {
  DEFAULT_PAGE_LIMIT,
  DRIVER_CAPABILITIES,
  MAX_PAGE_LIMIT,
  peekError,
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
 * 一个活的 PostgreSQL 连接。
 *
 * 连接管理：用 pg.Pool 而不是单 Client。原因是取消必须走**另一条连接**发
 * pg_cancel_backend——单连接时长查询把唯一的连接占死，取消请求根本发不出去。
 *
 * 池子里跑两类活：
 * - 数据面：每个 PgCursor 独占一条连接直到游标关闭；
 * - 控制面：introspect / describeCollection / valuePeek / ping 各借用一次即还。
 *
 * **取消不走池**：游标可能把池占满，那恰恰是最需要取消的时刻。cancel() 另开一条
 * 一次性 Client 发 pg_cancel_backend，多一次握手换"永远能取消"（见 cancel()）。
 */

/** 结果来源登记的上限，超了按插入顺序淘汰最老的（只影响 valuePeek 回源） */
const MAX_TRACKED_SOURCES = 32

/** pg 允许的最大 int，statement_timeout 之类别越界 */
const MAX_INT32 = 2_147_483_647

/**
 * 池容量。游标是独占的（一个结果流一条连接），控制面（introspect / peek / ping）
 * 也从这里借，所以留了余量：同时开 4 个大结果视图时仍有连接可以做元信息查询。
 */
const POOL_MAX = 8

/**
 * 取消专用连接的建连上限。ConnectionManager 的 cancelMs 只有 2s，超时就升级成杀进程，
 * 所以这条握手必须比它先失败（失败后退化成直接关游标，见 cancel()）。
 */
const CANCEL_CONNECT_TIMEOUT_MS = 1_500

function clampInt(value: number | undefined, min: number, max: number): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isFinite(value)) return undefined
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

/** 只把有值的字段塞进 PoolConfig：pg 会把显式 undefined 当成"用户指定了空" */
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
  /** 建池用的配置，cancel 另开旁路连接时复用 */
  private readonly poolConfig: PoolConfig
  private readonly catalog: PgTypeCatalog
  private readonly introspector: PgIntrospector
  private readonly peeker: PgValuePeeker

  /** 执行中的游标，cancel / close 靠它 */
  private readonly active = new Map<ResultId, PgCursor>()
  /** 结果集来源语句，valuePeek 的 resultCell 回源用 */
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
  /* 建连                                                              */
  /* ---------------------------------------------------------------- */

  static async connect(
    cfg: PostgresConnectionConfig,
    signal?: AbortSignal,
  ): Promise<PostgresSession> {
    if (signal?.aborted) throw peekError('CANCELLED', '建连已取消')
    const poolConfig = buildPoolConfig(cfg)
    const pool = new Pool(poolConfig)
    // 池里的空闲连接被服务端掐断时会抛 error 事件，不接住会直接崩进程
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
    if (!row) throw peekError('CONNECTION_FAILED', '无法读取服务端信息')
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
  /* 生命周期                                                          */
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
    if (this.closed) throw peekError('CONNECTION_LOST', '连接已关闭')
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

  /** 手动刷新：清掉 introspect 缓存（PLAN 第 8 节） */
  invalidateIntrospectCache(): void {
    this.introspector.invalidate()
  }

  /* ---------------------------------------------------------------- */
  /* tabularQuery                                                      */
  /* ---------------------------------------------------------------- */

  async query(req: TabularQueryRequest): Promise<Cursor> {
    this.assertOpen()
    const text = req.text.trim()
    if (text.length === 0) throw peekError('BAD_REQUEST', '查询语句为空')
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

    // cursorToken 是上一页末尾的绝对 offset，给了就覆盖 offset
    const tokenOffset = req.cursorToken === undefined ? undefined : Number(req.cursorToken)
    if (req.cursorToken !== undefined && !Number.isFinite(tokenOffset)) {
      throw peekError('BAD_REQUEST', `非法的 cursorToken: ${req.cursorToken}`)
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

    // 取满 limit 说明后面大概率还有，给出下一页的续拉游标
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
      throw peekError('CONFLICT', `结果集 ${resultId} 已在执行中`)
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
        // 关闭时把首帧 schema 留给 valuePeek，省一次探测
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
   * 真取消：走另一条连接发 pg_cancel_backend 打断服务端正在跑的语句，
   * 正在 await 的 FETCH 会以 57014 失败，被收敛成 CANCELLED。
   * 未在执行中返回 false，不抛错（契约要求）。
   *
   * **这条连接不能从池里借**：每个游标独占一条池连接直到关闭，池被游标占满时
   * pool.connect() 会一直排队到 connectionTimeoutMillis（15s），
   * 而上层的 cancelMs 只有 2s，超时后会直接杀掉整个 driver 进程，
   * 把这条连接上的所有视图一起判死。取消是低频操作，多一次握手换"永远能取消"。
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
      // 取消请求本身失败（权限不足 / 连不上）时退化成直接关游标
      await cursor.close().catch(() => {})
    }
    return true
  }

  /** 旁路连接发 pg_cancel_backend，用完立刻断开，绝不与游标抢池里的连接 */
  private async sendCancelRequest(pid: number): Promise<void> {
    const client = new Client({
      ...this.poolConfig,
      connectionTimeoutMillis: CANCEL_CONNECT_TIMEOUT_MS,
      application_name: `${this.poolConfig.application_name ?? 'peek'}-cancel`,
    })
    // 建连失败会以 error 事件的形式再抛一次，不接住会崩进程
    client.on('error', () => {})
    await client.connect()
    try {
      await client.query('SELECT pg_cancel_backend($1::int4)', [pid])
    } finally {
      // 不等 end()：取消请求已经发出去了，关连接的往返没必要计进 cancelMs 预算
      void client.end().catch(() => {})
    }
  }
}
