import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { WebContents } from 'electron'
import {
  defaultConnectionLabel,
  newConnId,
  peekError,
  type Capability,
  type CollectionRef,
  type CollectionSchemaInfo,
  type ConnId,
  type ConnStatus,
  type ConnectionConfig,
  type DriverId,
  type HostEvent,
  type HostParams,
  type HostResult,
  type KeyValueResult,
  type NamespaceNode,
  type NotifyLevel,
  type PeekError,
  type PeekedValue,
  type ResultId,
  type ServerInfo,
  type ValueRef,
} from '@peek/core'
import {
  DEFAULT_TIMEOUTS,
  classifyConnectError,
  classifyExecError,
  crashedError,
  notFoundConn,
  notReadyConn,
  unsupported,
  type Timeouts,
} from './classify'
import { TypedEmitter } from './emitter'
import { DriverHostProcess } from './host-process'
import { DataPlaneLink } from './port-broker'
import { lookupDriver } from './registry'
import type {
  CancelOutcome,
  ConnectOptions,
  ConnectOutcome,
  ConnectionEffects,
  ConnectionEventMap,
  ConnectionManagerOptions,
  ConnectionRuntime,
  StartResultOutcome,
} from './types'

/* ================================================================== */
/* 内部记录                                                            */
/* ================================================================== */

interface ConnEntry {
  connId: ConnId
  driverId: DriverId
  label: string
  config: ConnectionConfig
  status: ConnStatus
  capabilities: Capability[]
  serverInfo?: ServerInfo
  error?: PeekError
  readyAt?: number
  host: DriverHostProcess
  link: DataPlaneLink
  /** 正在流的结果集；进程死掉时要逐个报错，避免 UI 上永远转圈 */
  activeResults: Set<ResultId>
  /**
   * 已经在别处把 status 置成终态（强制取消 / 建连失败），
   * exit 回调不要再覆盖一次。
   */
  statusSettled: boolean
}

/* ================================================================== */
/* ConnectionManager                                                   */
/* ================================================================== */

/**
 * 连接管理器：driver 的宿主进程管理（PLAN 第 3 节进程模型）。
 *
 * 一个连接 = 一个 electron utilityProcess = 一条数据面 MessagePort。
 *
 * - **崩溃隔离**：进程挂了只影响这一条连接，主窗口毫发无伤；
 *   在飞 RPC 收敛成 DRIVER_CRASHED，在飞结果集逐个发 result.error，端口关闭，entry 移除。
 * - **强制取消 = 杀进程**：协作式 cancel 超时或驱动没有 cancel 能力时直接强杀。
 * - **数据面不经过 main**：只在建连时移交一次端口，之后 chunk 由 host 直发 renderer。
 *
 * 对上以 `ConnectionEffects` 注入给 Command Bus；状态变化通过 `events` 推给 Bus。
 */
export class ConnectionManager implements ConnectionEffects {
  /** 事件出口：Command Bus 订阅 status / result.*，通知层订阅 log / crashed */
  readonly events = new TypedEmitter<ConnectionEventMap>()

  private readonly conns = new Map<ConnId, ConnEntry>()
  private readonly timeouts: Timeouts
  private readonly hostDir: string
  private readonly forwardStdio: boolean
  private webContents: WebContents | null = null

  constructor(options: ConnectionManagerOptions = {}) {
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts }
    // main bundle 与 driver-host bundle 同在 out/main（见 electron.vite.config.ts）
    this.hostDir = options.hostDir ?? process.env['PEEK_DRIVER_HOST_DIR'] ?? import.meta.dirname
    this.forwardStdio = options.forwardStdio ?? true
  }

  /* ---------------------------------------------------------------- */
  /* renderer 绑定（数据面移交的另一端）                                 */
  /* ---------------------------------------------------------------- */

  /**
   * 绑定 renderer。窗口创建后调用一次；renderer 每次重载（did-finish-load）也要再调，
   * 旧端口随旧文档销毁，这里会自动换新通道重新移交。
   */
  attachRenderer(wc: WebContents): void {
    this.webContents = wc
    for (const entry of this.conns.values()) {
      this.deliverPort(entry)
    }
  }

  /** renderer 没了（窗口关闭）；连接与进程保持存活，等下次 attach 再移交端口 */
  detachRenderer(): void {
    this.webContents = null
  }

  private deliverPort(entry: ConnEntry): void {
    const wc = this.webContents
    if (!wc || wc.isDestroyed()) return
    try {
      if (entry.link.deliver(wc, entry.host.pid)) {
        this.events.emit('port.attached', {
          connId: entry.connId,
          ...(entry.host.pid === undefined ? {} : { pid: entry.host.pid }),
        })
      }
    } catch (err) {
      this.emitLog(entry.connId, 'error', '数据面端口移交失败', briefOf(err))
    }
  }

  /* ---------------------------------------------------------------- */
  /* 建连 / 断连                                                        */
  /* ---------------------------------------------------------------- */

  async connect(config: ConnectionConfig, options: ConnectOptions = {}): Promise<ConnectOutcome> {
    const registration = lookupDriver(config.driverId)
    if (!registration) {
      throw peekError('BAD_REQUEST', `尚未注册驱动：${config.driverId}`, {
        detail: '在 src/main/connections/registry.ts 里注册后即可使用',
      })
    }

    const entryPath = join(this.hostDir, registration.entryFile)
    if (!existsSync(entryPath)) {
      throw peekError('INTERNAL', 'driver host 构建产物缺失', {
        detail: `找不到 ${entryPath}；确认 electron-vite 的 main.rollupOptions.input 里有 driver-host 入口`,
      })
    }

    const connId = options.connId ?? newConnId()
    // 重连：先把旧进程收干净，绝不允许同一个 connId 挂两个进程
    if (this.conns.has(connId)) await this.disconnect(connId)

    const host = new DriverHostProcess(connId, {
      onEvent: (event) => this.handleHostEvent(connId, event),
      onExit: (code, expected, detail) => this.handleHostExit(connId, code, expected, detail),
      onStdio: (level, text) => this.emitLog(connId, level, text),
    })

    const entry: ConnEntry = {
      connId,
      driverId: config.driverId,
      label: defaultConnectionLabel(config),
      config,
      status: 'connecting',
      capabilities: [],
      host,
      link: new DataPlaneLink(connId, host),
      activeResults: new Set<ResultId>(),
      statusSettled: false,
    }
    this.conns.set(connId, entry)
    this.setStatus(entry, 'connecting')

    try {
      await host.spawn({
        entryPath,
        driverId: config.driverId,
        readyMs: this.timeouts.readyMs,
        forwardStdio: this.forwardStdio,
      })

      // 数据面先建好：connect 一返回，驱动就能立刻往端口里吐 chunk
      entry.link.open()
      this.deliverPort(entry)

      const connectTimeout = options.timeoutMs ?? configConnectTimeout(config) ?? this.timeouts.connectMs
      const result = await host.call(
        'connect',
        { connId, config, timeoutMs: connectTimeout },
        connectTimeout,
      )

      entry.capabilities = [...result.capabilities]
      if (result.serverInfo !== undefined) entry.serverInfo = result.serverInfo
      entry.readyAt = Date.now()
      delete entry.error
      this.setStatus(entry, 'ready')

      return {
        connId,
        capabilities: [...entry.capabilities],
        ...(entry.serverInfo === undefined ? {} : { serverInfo: entry.serverInfo }),
        ...(host.pid === undefined ? {} : { pid: host.pid }),
      }
    } catch (raw) {
      const error = classifyConnectError(raw)
      entry.error = error
      entry.statusSettled = true
      this.setStatus(entry, 'error', error)
      // 建连失败不留僵尸进程
      entry.link.close()
      host.forceKill()
      this.conns.delete(connId)
      throw error
    }
  }

  async disconnect(connId: ConnId): Promise<void> {
    const entry = this.conns.get(connId)
    if (!entry) return
    entry.statusSettled = true
    // 在飞结果集先收尾，UI 不会永远转圈
    this.failActiveResults(entry, peekError('CANCELLED', '连接已关闭'))
    entry.link.close()
    await entry.host.shutdown({
      disconnectMs: this.timeouts.disconnectMs,
      shutdownMs: this.timeouts.shutdownMs,
      exitMs: this.timeouts.exitMs,
    })
    this.conns.delete(connId)
    this.setStatus(entry, 'idle')
  }

  /** app 退出前调用：把所有 driver 进程收干净 */
  async disposeAll(): Promise<void> {
    const ids = [...this.conns.keys()]
    await Promise.all(ids.map((id) => this.disconnect(id).catch(() => undefined)))
    this.conns.clear()
    this.webContents = null
  }

  /* ---------------------------------------------------------------- */
  /* introspect                                                        */
  /* ---------------------------------------------------------------- */

  async introspect(connId: ConnId, parentId: string | null, refresh?: boolean): Promise<NamespaceNode[]> {
    const entry = this.requireReady(connId)
    this.requireCapability(entry, 'introspect')
    try {
      const res = await entry.host.call(
        'introspect.children',
        { parentId, ...(refresh === undefined ? {} : { refresh }) },
        this.timeouts.rpcMs,
      )
      return res.nodes
    } catch (raw) {
      throw classifyExecError(raw)
    }
  }

  async describeCollection(connId: ConnId, ref: CollectionRef): Promise<CollectionSchemaInfo> {
    const entry = this.requireReady(connId)
    this.requireCapability(entry, 'introspect')
    try {
      const res = await entry.host.call('introspect.describe', { ref }, this.timeouts.rpcMs)
      return res.schema
    } catch (raw) {
      throw classifyExecError(raw)
    }
  }

  /* ---------------------------------------------------------------- */
  /* 取数：只发起，数据走 MessagePort                                    */
  /* ---------------------------------------------------------------- */

  async runQuery(connId: ConnId, params: HostParams<'query.run'>): Promise<StartResultOutcome> {
    const entry = this.requireReady(connId)
    this.requireCapability(entry, 'tabularQuery')
    return this.startResult(entry, 'query.run', params, params.timeoutMs, params.resultId)
  }

  async scan(connId: ConnId, params: HostParams<'collection.scan'>): Promise<StartResultOutcome> {
    const entry = this.requireReady(connId)
    this.requireCapability(entry, 'collectionScan')
    return this.startResult(entry, 'collection.scan', params, params.timeoutMs, params.resultId)
  }

  async vectorSearch(connId: ConnId, params: HostParams<'vector.search'>): Promise<StartResultOutcome> {
    const entry = this.requireReady(connId)
    this.requireCapability(entry, 'vectorSearch')
    return this.startResult(entry, 'vector.search', params, params.timeoutMs, params.resultId)
  }

  /**
   * 三个取数方法的共同骨架。
   * RPC 只负责"发起"：驱动返回 resultId 就算成功，行数据由 host 直发 renderer。
   */
  private async startResult(
    entry: ConnEntry,
    method: 'query.run' | 'collection.scan' | 'vector.search',
    params: HostParams<'query.run'> | HostParams<'collection.scan'> | HostParams<'vector.search'>,
    timeoutMs: number | undefined,
    resultId: ResultId,
  ): Promise<StartResultOutcome> {
    // 发起阶段的上限：调用方给了执行超时就在它基础上留宽限，否则用默认值
    const startTimeout =
      timeoutMs === undefined ? this.timeouts.queryStartMs : timeoutMs + this.timeouts.queryGraceMs

    // 先登记再发请求：驱动可能在 RPC 响应之前就开始吐 chunk / 发 result.done
    entry.activeResults.add(resultId)
    try {
      let res: HostResult<'query.run' | 'collection.scan' | 'vector.search'>
      switch (method) {
        case 'query.run':
          res = await entry.host.call('query.run', params as HostParams<'query.run'>, startTimeout)
          break
        case 'collection.scan':
          res = await entry.host.call('collection.scan', params as HostParams<'collection.scan'>, startTimeout)
          break
        case 'vector.search':
          res = await entry.host.call('vector.search', params as HostParams<'vector.search'>, startTimeout)
          break
      }
      return { resultId: res.resultId }
    } catch (raw) {
      entry.activeResults.delete(resultId)
      const error = classifyExecError(raw)
      // 发起阶段超时：尽力让驱动也把这个 resultId 停掉，别留悬空游标
      if (error.code === 'TIMEOUT' && entry.host.alive) {
        void entry.host
          .call('cancel', { resultId }, this.timeouts.cancelMs)
          .catch(() => undefined)
      }
      throw error
    }
  }

  /* ---------------------------------------------------------------- */
  /* 单值                                                              */
  /* ---------------------------------------------------------------- */

  async getValue(connId: ConnId, ref: ValueRef): Promise<KeyValueResult> {
    const entry = this.requireReady(connId)
    this.requireCapability(entry, 'keyValue')
    try {
      const res = await entry.host.call('keyvalue.get', { ref }, this.timeouts.rpcMs)
      return res.value
    } catch (raw) {
      throw classifyExecError(raw)
    }
  }

  async peekValue(
    connId: ConnId,
    ref: ValueRef,
    range?: { offset?: number; length?: number },
  ): Promise<PeekedValue> {
    const entry = this.requireReady(connId)
    this.requireCapability(entry, 'valuePeek')
    try {
      const res = await entry.host.call(
        'value.peek',
        {
          ref,
          ...(range?.offset === undefined ? {} : { offset: range.offset }),
          ...(range?.length === undefined ? {} : { length: range.length }),
        },
        this.timeouts.rpcMs,
      )
      return res.value
    } catch (raw) {
      throw classifyExecError(raw)
    }
  }

  /* ---------------------------------------------------------------- */
  /* 取消                                                              */
  /* ---------------------------------------------------------------- */

  /**
   * 取消一个结果集。
   *
   * 路径一（协作式）：驱动声明了 cancel 能力 → 发 cancel RPC，2s 内返回即完事。
   * 路径二（强制）：驱动没有 cancel 能力，或协作式取消超时/失败，或调用方要求 force
   *   → **杀进程**（PLAN 第 3 节明确的语义）。进程死了连接也就没了，
   *     状态置 error，UI 需要重连。
   */
  async cancel(connId: ConnId, resultId: ResultId, options?: { force?: boolean }): Promise<CancelOutcome> {
    const entry = this.conns.get(connId)
    if (!entry) throw notFoundConn(String(connId))

    if (options?.force === true || !entry.capabilities.includes('cancel') || !entry.host.alive) {
      await this.killForCancel(entry, resultId)
      return { cancelled: true, killed: true }
    }

    try {
      const res = await entry.host.call('cancel', { resultId }, this.timeouts.cancelMs)
      entry.activeResults.delete(resultId)
      return { cancelled: res.cancelled, killed: false }
    } catch (raw) {
      this.emitLog(connId, 'warn', '协作式取消失败，升级为强制终止 driver 进程', briefOf(raw))
      await this.killForCancel(entry, resultId)
      return { cancelled: true, killed: true }
    }
  }

  private async killForCancel(entry: ConnEntry, resultId: ResultId): Promise<void> {
    const cancelled = peekError('CANCELLED', '已取消')
    // 被取消的那个先报 CANCELLED，其余在飞结果集报连接丢失
    if (entry.activeResults.has(resultId)) {
      entry.activeResults.delete(resultId)
      this.events.emit('result.error', { connId: entry.connId, resultId, error: cancelled })
    }
    const lost = peekError('CONNECTION_LOST', '为强制取消已终止 driver 进程，请重新连接', {
      retryable: true,
    })
    this.failActiveResults(entry, lost)

    entry.statusSettled = true
    entry.error = lost
    entry.link.close()
    entry.host.forceKill()
    await entry.host.waitExit(this.timeouts.exitMs)
    this.conns.delete(entry.connId)
    this.setStatus(entry, 'error', lost)
  }

  /* ---------------------------------------------------------------- */
  /* 杂项                                                              */
  /* ---------------------------------------------------------------- */

  async ping(connId: ConnId): Promise<HostResult<'ping'>> {
    const entry = this.requireReady(connId)
    try {
      return await entry.host.call('ping', {}, this.timeouts.cancelMs)
    } catch (raw) {
      throw classifyExecError(raw)
    }
  }

  getRuntime(connId: ConnId): ConnectionRuntime | null {
    const entry = this.conns.get(connId)
    return entry ? toRuntime(entry) : null
  }

  listRuntimes(): ConnectionRuntime[] {
    return [...this.conns.values()].map(toRuntime)
  }

  hasCapability(connId: ConnId, capability: Capability): boolean {
    const entry = this.conns.get(connId)
    return entry !== undefined && entry.capabilities.includes(capability)
  }

  /* ---------------------------------------------------------------- */
  /* 内部                                                              */
  /* ---------------------------------------------------------------- */

  private requireReady(connId: ConnId): ConnEntry {
    const entry = this.conns.get(connId)
    if (!entry) throw notFoundConn(String(connId))
    if (entry.status !== 'ready') throw notReadyConn(String(connId), entry.status)
    if (!entry.host.alive) throw crashedError('driver 进程已退出')
    return entry
  }

  private requireCapability(entry: ConnEntry, capability: Capability): void {
    if (!entry.capabilities.includes(capability)) throw unsupported(capability)
  }

  private setStatus(entry: ConnEntry, status: ConnStatus, error?: PeekError): void {
    entry.status = status
    this.events.emit('status', {
      connId: entry.connId,
      status,
      ...(error === undefined ? {} : { error }),
      ...(entry.host.pid === undefined ? {} : { pid: entry.host.pid }),
    })
  }

  private emitLog(connId: ConnId, level: NotifyLevel, message: string, detail?: string): void {
    this.events.emit('log', {
      connId,
      level,
      message,
      ...(detail === undefined ? {} : { detail }),
    })
  }

  /** 把还在飞的结果集统一判死，避免 UI 永远 loading */
  private failActiveResults(entry: ConnEntry, error: PeekError): void {
    if (entry.activeResults.size === 0) return
    for (const resultId of [...entry.activeResults]) {
      entry.activeResults.delete(resultId)
      this.events.emit('result.error', { connId: entry.connId, resultId, error })
    }
  }

  private handleHostEvent(connId: ConnId, event: HostEvent): void {
    const entry = this.conns.get(connId)
    switch (event.type) {
      case 'ready':
        return
      case 'status': {
        if (!entry) return
        entry.status = event.status
        if (event.error !== undefined) entry.error = event.error
        this.setStatus(entry, event.status, event.error)
        return
      }
      case 'result.schema':
        this.events.emit('result.schema', { connId, resultId: event.resultId, schema: event.schema })
        return
      case 'result.done': {
        entry?.activeResults.delete(event.resultId)
        this.events.emit('result.done', {
          connId,
          resultId: event.resultId,
          info: {
            rows: event.rows,
            elapsedMs: event.elapsedMs,
            ...(event.truncated === undefined ? {} : { truncated: event.truncated }),
            ...(event.nextCursor === undefined ? {} : { nextCursor: event.nextCursor }),
          },
        })
        return
      }
      case 'result.paused': {
        // 暂停也是终态：游标已释放，这个结果集不会再有帧，从在飞集合里摘掉。
        entry?.activeResults.delete(event.resultId)
        this.events.emit('result.paused', { connId, resultId: event.resultId, paused: event.paused })
        return
      }
      case 'result.error': {
        entry?.activeResults.delete(event.resultId)
        this.events.emit('result.error', {
          connId,
          resultId: event.resultId,
          error: classifyExecError(event.error),
        })
        return
      }
      case 'result.progress':
        this.events.emit('result.progress', { connId, resultId: event.resultId, rows: event.rows })
        return
      case 'log':
        this.emitLog(connId, event.level, event.message, event.detail)
        return
    }
  }

  /**
   * driver host 退出。**崩溃隔离的收口**：
   * 无论正常还是崩溃，这里都保证端口关闭、在飞结果集判死、entry 移除。
   */
  private handleHostExit(connId: ConnId, code: number, expected: boolean, detail?: string): void {
    const entry = this.conns.get(connId)
    if (!entry) return

    entry.link.close()

    const error = expected
      ? peekError('CONNECTION_LOST', 'driver 进程已关闭')
      : crashedError(detail ?? `driver 进程异常退出，退出码 ${code}`)

    this.failActiveResults(entry, error)
    this.conns.delete(connId)

    if (!expected) {
      entry.error = error
      entry.statusSettled = true
      this.setStatus(entry, 'error', error)
      this.events.emit('crashed', { connId, error, code, expected })
      return
    }
    if (!entry.statusSettled) {
      this.setStatus(entry, 'idle')
    }
  }
}

/* ================================================================== */
/* 小工具                                                              */
/* ================================================================== */

function toRuntime(entry: ConnEntry): ConnectionRuntime {
  return {
    connId: entry.connId,
    driverId: entry.driverId,
    label: entry.label,
    status: entry.status,
    capabilities: [...entry.capabilities],
    ...(entry.serverInfo === undefined ? {} : { serverInfo: entry.serverInfo }),
    ...(entry.error === undefined ? {} : { error: entry.error }),
    ...(entry.host.pid === undefined ? {} : { pid: entry.host.pid }),
    ...(entry.readyAt === undefined ? {} : { readyAt: entry.readyAt }),
    activeResults: [...entry.activeResults],
  }
}

/** sqlite 的 config 没有 connectTimeoutMs，用 in 收窄而不是硬取 */
function configConnectTimeout(config: ConnectionConfig): number | undefined {
  if ('connectTimeoutMs' in config && typeof config.connectTimeoutMs === 'number') {
    return config.connectTimeoutMs
  }
  return undefined
}

function briefOf(value: unknown): string {
  if (value instanceof Error) return value.message
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}
