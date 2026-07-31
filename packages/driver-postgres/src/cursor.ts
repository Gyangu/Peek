import {
  CHUNK_DEFAULT_ROWS,
  adaptiveChunkRows,
  peekError,
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
 * 服务端游标。
 *
 * **不使用 client.query() 一次性拉全表**：走 SQL 层的 DECLARE / FETCH FORWARD，
 * 每次只把一批行拉进内存，打成列式 ChunkFrame 吐出。
 * （pg-cursor 未安装，这里用等价的 SQL 游标实现，语义一致且少一个依赖。）
 *
 * 终止约定严格按 core/chunk.ts：
 * - 正常结束 = 末帧带 done（空结果集也发一帧，rowCount 0）
 * - 异常结束 = next() reject（PeekError 形状），此后不会再有带 done 的帧
 * - seq 从 0 连续递增
 */

let cursorSeq = 0

/**
 * 调用方没给 timeoutMs 时的服务端兜底：单条语句最多跑 5 分钟。
 * 没有这道兜底的话，一条跑飞的 DECLARE / FETCH 会一直占着连接。
 */
const DEFAULT_STATEMENT_TIMEOUT_MS = 300_000

/**
 * 游标事务的空闲上限：帧被背压压住（或 host 卡死）时，
 * 服务端自己把这条 idle in transaction 的连接收掉，不让只读事务无限期挂着。
 * 正常路径下 StreamPump 的空闲上限（60s）会先一步关掉游标，这里只是最后一道保险。
 */
const IDLE_TX_TIMEOUT_MS = 300_000

export interface PgCursorOptions {
  pool: Pool
  catalog: PgTypeCatalog
  resultId: ResultId
  text: string
  params?: readonly unknown[]
  /** 最多取多少行，超出则 done.truncated = true */
  maxRows?: number
  /** 固定单帧行数；不给则按 adaptiveChunkRows 自适应 */
  chunkRows?: number
  timeoutMs?: number
  signal?: AbortSignal
  /** 列元信息补充（主键 / nullable），collectionScan 时由 describeCollection 提供 */
  columnHints?: ReadonlyMap<string, { nullable?: boolean; primaryKey?: boolean }>
  /** 末帧 done 的额外字段（collectionScan 的 nextCursor） */
  finish?: (rows: number, exhausted: boolean) => Pick<ChunkDone, 'truncated' | 'nextCursor'>
  /** 关闭时回调，供 session 从 active 表里摘掉 */
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

  /** 已从服务端 FETCH 回来但还没打包成帧的行 */
  private buffer: unknown[][] = []
  private exhausted = false
  private declared = false
  /** 已经 BEGIN 过：无论后续哪一步失败，归还连接前都必须 ROLLBACK，
      否则事务停在 aborted 状态被下一个使用者继承（25P02） */
  private txOpen = false
  /** 退化路径：DECLARE 不支持该语句时，整份结果已在内存里 */
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

  /** 执行本游标的后端进程 pid，cancel 用它发 pg_cancel_backend */
  get backendPid(): number | null {
    return this._backendPid
  }

  get isClosed(): boolean {
    return this.closed
  }

  /** 建游标：独占一个连接，开只读事务，DECLARE。失败时自己释放连接。 */
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
      // 整数已由调用方校验，这里再截一次，保证不可能拼进非法内容
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
      // DECLARE 只接受 SELECT / VALUES / TABLE；EXPLAIN、SHOW 之类退化成一次性查询
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
   * 给游标事务上两道服务端保险：语句级超时 + 事务空闲超时。
   *
   * 两条一起发（简单查询协议支持多语句）。
   * 兼容实现（CockroachDB / Yugabyte 等）可能不认识 idle_in_transaction_session_timeout，
   * 这时整个事务会被打成 aborted，必须重开事务再只设通用的 statement_timeout——
   * 否则后面的 DECLARE 一定以 25P02 失败。
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

  /** 退化路径：语句不能建游标时，直接跑一次并把结果放进 buffer */
  private async runInMemory(): Promise<void> {
    const client = this.client
    if (!client) throw peekError('INTERNAL', '游标连接已释放')
    // 上一条语句失败会让事务进入 aborted 状态，先回滚再重来
    await client.query('ROLLBACK')
    await client.query('BEGIN READ ONLY')
    this.txOpen = true
    // 新事务里 SET LOCAL 已经失效，超时保险要重新上一遍
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
    if (this.cancelled) throw peekError('CANCELLED', '查询已被取消')
    if (this.opts.signal?.aborted) throw peekError('CANCELLED', '查询已被取消')
  }

  /** 标记为已取消：cancel() 发出 pg_cancel_backend 后调用，让后续 next() 立即失败 */
  markCancelled(): void {
    this.cancelled = true
  }

  private ensureSchema(fields: readonly FieldDef[]): ColumnDef[] {
    if (this._schema) return this._schema
    const { catalog, columnHints } = this.opts
    const used = new Map<string, number>()
    const defs: ColumnDef[] = fields.map((f) => {
      // 结果集内列名必须唯一：重名的追加 __2 / __3
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

  /** 保证 buffer 里至少有 target 行（或已到末尾） */
  private async fill(target: number): Promise<void> {
    if (this.inMemory) return
    const client = this.client
    if (!client) throw peekError('INTERNAL', '游标连接已释放')
    while (!this.exhausted && this.buffer.length < target) {
      this.throwIfAborted()
      const want = target - this.buffer.length
      const sql = `FETCH FORWARD ${want} FROM ${quoteIdent(this.name)}`
      let res: QueryArrayResult<unknown[]>
      try {
        res = await client.query<unknown[], unknown[]>({ text: sql, rowMode: 'array' })
      } catch (err) {
        // 取消发出后 FETCH 会以 57014 失败，统一收敛成 CANCELLED
        if (this.cancelled) throw peekError('CANCELLED', '查询已被取消')
        throw mapPgError(err, { sql: this.opts.text })
      }
      this.ensureSchema(res.fields)
      const rows = res.rows
      for (const row of rows) this.buffer.push(row)
      if (rows.length < want) this.exhausted = true
    }
  }

  /** 下一批该取多少行：优先用调用方指定值，否则按已观测行宽自适应 */
  private nextBatchSize(): number {
    const fixed = this.opts.chunkRows
    if (fixed !== undefined && fixed > 0) return Math.trunc(fixed)
    if (this.avgRowBytes <= 0) return CHUNK_DEFAULT_ROWS
    return adaptiveChunkRows(this.avgRowBytes)
  }

  /**
   * 拉一帧。出错时**先释放连接再把错误抛出去**——
   * 否则被取消/超时的游标会一直占着池里的连接不还。
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

    // 多取一行作探针：能区分"刚好取完"和"还有下一批"，避免多发一个空帧。
    // want === 0 只在 maxRows === 0 这种退化调用下出现，此时不查库，schema 为空数组。
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
      // 滑动平均，避免个别宽行把 chunk 尺寸抖没
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

  /** 幂等关闭：回滚事务（顺带关掉游标）并把连接还给池 */
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
        // ROLLBACK 都失败说明这条连接已经坏了，销毁而不是还回池里接着用
        broken = true
      } finally {
        client.release(broken)
      }
    }
    this.opts.onClosed?.()
  }
}
