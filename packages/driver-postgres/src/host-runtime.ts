import {
  ACK_WINDOW,
  VALUE_PEEK_MAX_BYTES,
  peekError,
  supportsCancel,
  supportsCollectionScan,
  supportsIntrospect,
  supportsTabularQuery,
  supportsValuePeek,
  toPeekError,
  type ByteRange,
  type ConnectionConfig,
  type Cursor,
  type Driver,
  type DriverSession,
  type HostEvent,
  type HostInbound,
  type HostMethod,
  type HostRequest,
  type HostResponseOf,
  type HostResult,
  type NotifyLevel,
  type PeekError,
  type ResultId,
  type ResultPause,
  type ResultStreamAck,
  type ResultStreamMessage,
} from '@peek/core'
import { postgresDriver, requirePostgresConfig } from './driver'

/**
 * driver host 运行时：按 core/ipc.ts 的 driver host 协议收发消息。
 *
 * 两条通道严格分开（PLAN 第 3 节）：
 * - 控制面：main ↔ host，走 channel，RPC + 单向事件；
 * - 数据面：host → renderer，走 attachPort 移交过来的 MessagePort，直发 chunk，
 *   renderer 回 ack/cancel 做背压。
 *
 * 这个文件不 import electron，纯 node 可跑（utilityProcess 就是 node 环境），
 * 也因此可以在 node:test 里用一对普通 MessageChannel 完整跑通。
 */

/* ------------------------------------------------------------------ */
/* 传输抽象：只描述我们真正用到的那几个方法                                 */
/* ------------------------------------------------------------------ */

export interface HostPortLike {
  postMessage(message: unknown): void
  on(event: 'message', listener: (event: { data: unknown }) => void): void
  start?(): void
  close?(): void
}

export interface HostChannelEvent {
  data: unknown
  ports?: readonly HostPortLike[]
}

export interface HostChannelLike {
  postMessage(message: unknown): void
  on(event: 'message', listener: (event: HostChannelEvent) => void): void
  start?(): void
}

/* ------------------------------------------------------------------ */
/* 入站消息识别                                                         */
/* ------------------------------------------------------------------ */

const HOST_METHODS: ReadonlySet<string> = new Set<HostMethod>([
  'connect', 'disconnect', 'ping',
  'introspect.children', 'introspect.describe',
  'query.run', 'collection.scan', 'vector.search',
  'keyvalue.get', 'value.peek', 'cancel', 'shutdown',
])

function asInbound(data: unknown): HostInbound | null {
  if (typeof data !== 'object' || data === null) return null
  const v = data as Record<string, unknown>
  if (v['kind'] === 'attachPort' && typeof v['connId'] === 'string') {
    return data as HostInbound
  }
  if (v['kind'] === 'req' && typeof v['rid'] === 'number' && typeof v['method'] === 'string') {
    if (!HOST_METHODS.has(v['method'])) return null
    return data as HostRequest
  }
  return null
}

function asAck(data: unknown): ResultStreamAck | null {
  if (typeof data !== 'object' || data === null) return null
  const v = data as Record<string, unknown>
  if (v['t'] === 'ack' && typeof v['resultId'] === 'string' && typeof v['seq'] === 'number') {
    return data as ResultStreamAck
  }
  if (v['t'] === 'cancel' && typeof v['resultId'] === 'string') {
    return data as ResultStreamAck
  }
  return null
}

/* ------------------------------------------------------------------ */
/* 结果泵：把 Cursor 的帧推到 MessagePort，实现 ack 窗口背压                */
/* ------------------------------------------------------------------ */

/**
 * 背压暂停的空闲上限（毫秒）。
 *
 * 窗口被压满之后如果这么久还没等到新的 ack（视口停着不动、renderer 缓存到顶），
 * 就主动收摊：关游标、把服务端连接与只读事务还回去。
 * 否则"暂停"等于**长期持有服务端资源**——生产库上会拦住 VACUUM（PLAN 第 8 节）。
 *
 * 收摊的**结局是 paused，不是 error**：查询本身没出任何问题，已发出的行全部有效。
 * 早先这里 reject 一个 TIMEOUT PeekError，和真 SQL 错误（42P01 之类）挤在同一个
 * error 分支里，AI 通过 MCP 拿到回执时分不清「查询挂了」和「只是停下来了」。
 */
const IDLE_ACK_TIMEOUT_MS = 60_000

/** waitWindow 的结果：继续产帧，还是按设计暂停 */
type WindowWait = 'go' | 'paused'

class StreamPump {
  readonly resultId: ResultId

  private readonly cursor: Cursor
  private readonly host: DriverHost
  private readonly idleAckMs: number
  private unacked = 0
  private lastSentSeq = -1
  private resumeFn: (() => void) | null = null
  private stopped = false
  private rows = 0
  private readonly startedAt = Date.now()
  /** stop() 时 reject 的信号，用来打断那些不看 stopped 标志的 await */
  private readonly stopSignal: Promise<never>
  private stopReject: ((reason: unknown) => void) | null = null

  constructor(host: DriverHost, resultId: ResultId, cursor: Cursor, idleAckMs: number) {
    this.host = host
    this.resultId = resultId
    this.cursor = cursor
    this.idleAckMs = idleAckMs
    this.stopSignal = new Promise<never>((_resolve, reject) => {
      this.stopReject = reject
    })
    // 泵已经正常跑完之后才 stop 的情况下没人 race 这个 Promise，
    // 挂一个空 sink 防止变成 unhandledRejection
    this.stopSignal.catch(() => {})
  }

  /** renderer 确认已消费到 seq（含），窗口向前推进 */
  ack(seq: number): void {
    this.unacked = Math.max(0, this.lastSentSeq - seq)
    if (this.unacked < ACK_WINDOW) this.wake()
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    // 唤醒 waitWindow（正常 resolve，循环体下一步自己看 stopped 抛 CANCELLED）
    this.wake()
    // 打断 waitPort 这类"永远不会自己醒"的等待
    const reject = this.stopReject
    this.stopReject = null
    if (reject) reject(peekError('CANCELLED', '结果流已被取消'))
  }

  private wake(): void {
    const fn = this.resumeFn
    this.resumeFn = null
    if (fn) fn()
  }

  /**
   * 未确认帧数达到 ACK_WINDOW 就挂起，直到 ack 到来。
   * 挂起时间超过 idleAckMs 则返回 'paused'，让整条流收摊释放服务端资源。
   *
   * **不 reject**：暂停不是异常，走异常通道就必然和真错误混在一起。
   */
  private waitWindow(): Promise<WindowWait> {
    if (this.stopped || this.unacked < ACK_WINDOW) return Promise.resolve('go')
    return new Promise<WindowWait>((resolve) => {
      const timer = setTimeout(() => {
        this.resumeFn = null
        resolve('paused')
      }, this.idleAckMs)
      // 泵在等 ack 不该拖住进程退出
      timer.unref()
      this.resumeFn = (): void => {
        clearTimeout(timer)
        resolve('go')
      }
    })
  }

  /** 按设计暂停：控制面发 result.paused，数据面发 t:'paused'，两边都不是 error */
  private announcePause(): void {
    const pause: ResultPause = {
      rows: this.rows,
      elapsedMs: Date.now() - this.startedAt,
      reason: 'idleAck',
      message:
        `结果流已暂停：${Math.round(this.idleAckMs / 1000)} 秒没有新的消费确认，`
        + '已释放服务端游标与连接',
      resumable: true,
    }
    this.host.sendStream({ t: 'paused', resultId: this.resultId, paused: pause })
    this.host.emit({ kind: 'evt', type: 'result.paused', resultId: this.resultId, paused: pause })
  }

  async run(): Promise<void> {
    try {
      for (;;) {
        if (this.stopped) throw peekError('CANCELLED', '结果流已被取消')
        // 端口还没移交过来时先不产帧，天然的背压。
        // **必须可打断**：否则 attachPort 之前发起的查询会永久卡在这里，
        // 取消也叫不醒它，游标会一直占着连接和只读事务。
        const port = await Promise.race([this.host.waitPort(), this.stopSignal])
        if (await this.waitWindow() === 'paused') {
          this.announcePause()
          break
        }
        if (this.stopped) throw peekError('CANCELLED', '结果流已被取消')

        const frame = await this.cursor.next()
        if (frame === null) break

        if (frame.seq === 0 && frame.schema) {
          this.host.emit({
            kind: 'evt',
            type: 'result.schema',
            resultId: this.resultId,
            schema: frame.schema,
          })
        }

        const msg: ResultStreamMessage = { t: 'chunk', frame }
        port.postMessage(msg)
        this.lastSentSeq = frame.seq
        this.unacked += 1
        this.rows += frame.rowCount

        if (frame.done) {
          this.host.emit({
            kind: 'evt',
            type: 'result.done',
            resultId: this.resultId,
            rows: frame.done.rows,
            elapsedMs: frame.done.elapsedMs,
            ...(frame.done.truncated === undefined ? {} : { truncated: frame.done.truncated }),
            ...(frame.done.nextCursor === undefined ? {} : { nextCursor: frame.done.nextCursor }),
          })
          break
        }
        this.host.emit({
          kind: 'evt',
          type: 'result.progress',
          resultId: this.resultId,
          rows: this.rows,
        })
      }
    } catch (err) {
      const error = toPeekError(err)
      this.host.sendStream({ t: 'error', resultId: this.resultId, error })
      this.host.emit({ kind: 'evt', type: 'result.error', resultId: this.resultId, error })
    } finally {
      await this.cursor.close().catch(() => {})
      this.host.removePump(this.resultId)
    }
  }
}

/* ------------------------------------------------------------------ */
/* host 本体                                                           */
/* ------------------------------------------------------------------ */

export interface DriverHostOptions {
  /** 默认就是 postgresDriver；测试里可以换成假的 */
  driver?: Driver
  /** shutdown 请求处理完之后的动作，默认什么都不做（由 entry 决定要不要 exit） */
  onShutdown?: () => void
  /** 背压暂停的空闲上限，默认 IDLE_ACK_TIMEOUT_MS；测试里调小 */
  idleAckMs?: number
}

export class DriverHost {
  private readonly channel: HostChannelLike
  private readonly driver: Driver
  private readonly onShutdown: (() => void) | undefined
  private readonly idleAckMs: number

  private session: DriverSession | null = null
  private port: HostPortLike | null = null
  /** 等数据面端口的泵。带 reject：host 关闭时必须把它们唤醒，不能留悬挂 Promise */
  private portWaiters: { resolve: (p: HostPortLike) => void; reject: (e: unknown) => void }[] = []
  private readonly pumps = new Map<ResultId, StreamPump>()
  private disposed = false

  constructor(channel: HostChannelLike, options: DriverHostOptions = {}) {
    this.channel = channel
    this.driver = options.driver ?? postgresDriver
    this.onShutdown = options.onShutdown
    this.idleAckMs = options.idleAckMs !== undefined && options.idleAckMs > 0
      ? options.idleAckMs
      : IDLE_ACK_TIMEOUT_MS
    channel.on('message', (event) => {
      void this.onMessage(event)
    })
    channel.start?.()
  }

  /* ---- 出站 ---- */

  emit(event: HostEvent): void {
    this.channel.postMessage(event)
  }

  log(level: NotifyLevel, message: string, detail?: string): void {
    this.emit({
      kind: 'evt',
      type: 'log',
      level,
      message,
      ...(detail === undefined ? {} : { detail }),
    })
  }

  /** 宣告自己起来了，可以收请求 */
  announceReady(pid: number): void {
    this.emit({ kind: 'evt', type: 'ready', pid })
  }

  sendStream(msg: ResultStreamMessage): void {
    this.port?.postMessage(msg)
  }

  /**
   * 数据面端口还没到就等着，绝不丢帧。
   * 等待方必须自己带打断手段（StreamPump 用 stopSignal race），
   * host 关闭时这里的 waiter 会被统一 reject。
   */
  waitPort(): Promise<HostPortLike> {
    if (this.port) return Promise.resolve(this.port)
    if (this.disposed) return Promise.reject(peekError('CANCELLED', 'driver host 已关闭'))
    return new Promise<HostPortLike>((resolve, reject) => {
      this.portWaiters.push({ resolve, reject })
    })
  }

  private rejectPortWaiters(error: PeekError): void {
    const waiters = this.portWaiters
    this.portWaiters = []
    for (const w of waiters) w.reject(error)
  }

  removePump(resultId: ResultId): void {
    this.pumps.delete(resultId)
  }

  /* ---- 入站 ---- */

  private async onMessage(event: HostChannelEvent): Promise<void> {
    const msg = asInbound(event.data)
    if (!msg) return
    if (msg.kind === 'attachPort') {
      const port = event.ports?.[0]
      if (port) this.attachPort(port)
      return
    }
    await this.handleRequest(msg)
  }

  private attachPort(port: HostPortLike): void {
    this.port = port
    port.on('message', (e) => {
      const ack = asAck(e.data)
      if (!ack) return
      if (ack.t === 'ack') {
        this.pumps.get(ack.resultId)?.ack(ack.seq)
      } else {
        void this.cancelResult(ack.resultId)
      }
    })
    port.start?.()
    const waiters = this.portWaiters
    this.portWaiters = []
    for (const w of waiters) w.resolve(port)
  }

  private async handleRequest(req: HostRequest): Promise<void> {
    try {
      const result = await this.dispatch(req)
      const res: HostResponseOf<HostMethod> = {
        kind: 'res',
        rid: req.rid,
        method: req.method,
        ok: true,
        result,
      }
      this.channel.postMessage(res)
    } catch (err) {
      const error: PeekError = toPeekError(err)
      const res: HostResponseOf<HostMethod> = {
        kind: 'res',
        rid: req.rid,
        method: req.method,
        ok: false,
        error,
      }
      this.channel.postMessage(res)
    }
  }

  private requireSession(): DriverSession {
    if (!this.session) throw peekError('CONFLICT', '尚未建立连接')
    return this.session
  }

  private async dispatch(req: HostRequest): Promise<HostResult<HostMethod>> {
    switch (req.method) {
      case 'connect':
        return this.onConnect(req.params.config, req.params.timeoutMs)

      case 'disconnect': {
        await this.closeSession()
        this.emit({ kind: 'evt', type: 'status', status: 'idle' })
        return { closed: true }
      }

      case 'ping': {
        const session = this.requireSession()
        const t0 = Date.now()
        if (session.ping) await session.ping()
        return { ok: true, rttMs: Date.now() - t0 }
      }

      case 'introspect.children': {
        const session = this.requireSession()
        if (!supportsIntrospect(session)) {
          throw peekError('UNSUPPORTED_CAPABILITY', '该连接不支持 introspect')
        }
        return { nodes: await session.listChildren(req.params.parentId) }
      }

      case 'introspect.describe': {
        const session = this.requireSession()
        if (!supportsIntrospect(session)) {
          throw peekError('UNSUPPORTED_CAPABILITY', '该连接不支持 introspect')
        }
        return { schema: await session.describeCollection(req.params.ref) }
      }

      case 'query.run': {
        const session = this.requireSession()
        if (!supportsTabularQuery(session)) {
          throw peekError('UNSUPPORTED_CAPABILITY', '该连接不支持 tabularQuery')
        }
        const p = req.params
        const cursor = await session.query({
          resultId: p.resultId,
          text: p.text,
          ...(p.params === undefined ? {} : { params: p.params }),
          ...(p.maxRows === undefined ? {} : { maxRows: p.maxRows }),
          ...(p.chunkRows === undefined ? {} : { chunkRows: p.chunkRows }),
          ...(p.timeoutMs === undefined ? {} : { timeoutMs: p.timeoutMs }),
        })
        this.startPump(p.resultId, cursor)
        return { resultId: p.resultId }
      }

      case 'collection.scan': {
        const session = this.requireSession()
        if (!supportsCollectionScan(session)) {
          throw peekError('UNSUPPORTED_CAPABILITY', '该连接不支持 collectionScan')
        }
        const p = req.params
        const cursor = await session.scan({
          resultId: p.resultId,
          ref: p.ref,
          ...(p.filter === undefined ? {} : { filter: p.filter }),
          ...(p.sort === undefined ? {} : { sort: p.sort }),
          ...(p.columns === undefined ? {} : { columns: p.columns }),
          ...(p.offset === undefined ? {} : { offset: p.offset }),
          ...(p.limit === undefined ? {} : { limit: p.limit }),
          ...(p.cursorToken === undefined ? {} : { cursorToken: p.cursorToken }),
          ...(p.chunkRows === undefined ? {} : { chunkRows: p.chunkRows }),
          ...(p.timeoutMs === undefined ? {} : { timeoutMs: p.timeoutMs }),
        })
        this.startPump(p.resultId, cursor)
        return { resultId: p.resultId }
      }

      case 'vector.search':
        throw peekError('UNSUPPORTED_CAPABILITY', 'PostgreSQL 驱动不支持 vectorSearch')

      case 'keyvalue.get':
        throw peekError('UNSUPPORTED_CAPABILITY', 'PostgreSQL 驱动不支持 keyValue')

      case 'value.peek': {
        const session = this.requireSession()
        if (!supportsValuePeek(session)) {
          throw peekError('UNSUPPORTED_CAPABILITY', '该连接不支持 valuePeek')
        }
        const { ref, offset, length } = req.params
        // HostRpcMap 的 offset/length 各自可选，而 ByteRange 两者必填：
        // 只给 offset 时按"从这里到上限"理解，别退化成取 0 字节
        const range: ByteRange | undefined =
          offset === undefined && length === undefined
            ? undefined
            : { offset: offset ?? 0, length: length ?? VALUE_PEEK_MAX_BYTES }
        return { value: await session.peekValue(ref, range) }
      }

      case 'cancel':
        return { cancelled: await this.cancelResult(req.params.resultId) }

      case 'shutdown': {
        await this.dispose()
        this.onShutdown?.()
        return { closed: true }
      }
    }
  }

  private async onConnect(
    config: ConnectionConfig,
    timeoutMs?: number,
  ): Promise<HostResult<'connect'>> {
    await this.closeSession()
    this.emit({ kind: 'evt', type: 'status', status: 'connecting' })
    try {
      const cfg = requirePostgresConfig(config)
      const controller = new AbortController()
      const timer =
        timeoutMs === undefined
          ? null
          : setTimeout(() => controller.abort(), Math.max(1, Math.trunc(timeoutMs)))
      try {
        const session = await this.driver.connect(cfg, controller.signal)
        this.session = session
        this.emit({ kind: 'evt', type: 'status', status: 'ready' })
        const result: HostResult<'connect'> = { capabilities: [...session.capabilities] }
        if (session.serverInfo) result.serverInfo = session.serverInfo
        return result
      } finally {
        if (timer) clearTimeout(timer)
      }
    } catch (err) {
      const error = toPeekError(err, 'CONNECTION_FAILED')
      this.emit({ kind: 'evt', type: 'status', status: 'error', error })
      throw error
    }
  }

  private startPump(resultId: ResultId, cursor: Cursor): void {
    const pump = new StreamPump(this, resultId, cursor, this.idleAckMs)
    this.pumps.set(resultId, pump)
    void pump.run()
  }

  /** 取消一个结果集：先让驱动真的打断服务端语句，再停泵 */
  private async cancelResult(resultId: ResultId): Promise<boolean> {
    const pump = this.pumps.get(resultId)
    let cancelled = false
    const session = this.session
    if (session && supportsCancel(session)) {
      cancelled = await session.cancel(resultId).catch(() => false)
    }
    if (pump) {
      pump.stop()
      cancelled = true
    }
    return cancelled
  }

  private async closeSession(): Promise<void> {
    for (const pump of [...this.pumps.values()]) pump.stop()
    this.pumps.clear()
    // 泵已经被 stop 打断，它们登记的等待项不会再有人认领，一并清掉
    this.rejectPortWaiters(peekError('CANCELLED', '连接已关闭'))
    const session = this.session
    this.session = null
    if (session) await session.close().catch(() => {})
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    // 先叫醒还在等数据面端口的泵，再收会话：
    // 否则它们会连同各自的游标一起挂到进程结束
    this.rejectPortWaiters(peekError('CANCELLED', 'driver host 已关闭'))
    await this.closeSession()
  }
}

export function createDriverHost(
  channel: HostChannelLike,
  options: DriverHostOptions = {},
): DriverHost {
  return new DriverHost(channel, options)
}
