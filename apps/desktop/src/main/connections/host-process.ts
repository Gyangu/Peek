import { app, utilityProcess } from 'electron'
import type { MessagePortMain, UtilityProcess } from 'electron'
import {
  isHostEvent,
  isHostResponse,
  peekError,
  type ConnId,
  type DriverId,
  type HostEvent,
  type HostInbound,
  type HostMethod,
  type HostOutbound,
  type HostParams,
  type HostRequestOf,
  type HostResult,
  type NotifyLevel,
  type PeekError,
} from '@peek/core'
import { crashedError, timeoutError } from './classify'

/* ================================================================== */
/* 消息解析：utilityProcess 的 message 是 any，先收敛成 HostOutbound       */
/* ================================================================== */

function parseHostOutbound(raw: unknown): HostOutbound | null {
  if (typeof raw !== 'object' || raw === null) return null
  const msg = raw as Record<string, unknown>
  if (msg['kind'] === 'res' && typeof msg['rid'] === 'number' && typeof msg['ok'] === 'boolean') {
    return raw as HostOutbound
  }
  if (msg['kind'] === 'evt' && typeof msg['type'] === 'string') {
    return raw as HostOutbound
  }
  return null
}

/* ================================================================== */
/* 单进程封装                                                          */
/* ================================================================== */

interface PendingCall {
  method: HostMethod
  /** 类型在 call() 里已按 M 钉死，这里擦除存储 */
  resolve: (value: unknown) => void
  reject: (error: PeekError) => void
  timer: NodeJS.Timeout | null
}

export interface HostProcessHooks {
  /** host 发来的单向事件（status / result.* / log） */
  onEvent(event: HostEvent): void
  /** 进程退出。expected 表示是我们主动关的 */
  onExit(code: number, expected: boolean, detail?: string): void
  /** stdout / stderr 转发 */
  onStdio(level: NotifyLevel, text: string): void
}

export interface SpawnOptions {
  entryPath: string
  driverId: DriverId
  readyMs: number
  forwardStdio: boolean
}

/**
 * 一个 driver host（electron utilityProcess）的进程封装。
 *
 * 职责边界：**只管进程与 RPC 配对**，不认识具体驱动语义。
 * - 生命周期：spawn → ready 握手 → 服务 → 优雅关闭 / 强杀
 * - 崩溃隔离：进程挂了，所有在飞 RPC 统一 reject DRIVER_CRASHED，资源就地回收
 * - 数据面：attachPort() 把 MessagePortMain 移交给进程，chunk 不经过 main
 *
 * 与 child_process 的差异（写实现时踩过的点）：
 * - `utilityProcess.fork` 必须在 app ready 之后调用；
 * - 通信用 `postMessage` / `'message'` 事件（结构化克隆），**不是** `send`/`ipc`；
 * - 支持 transfer MessagePortMain，子进程侧用 `process.parentPort` 收；
 * - 没有 `SIGKILL` 级 API，`kill()` 走 SIGTERM 并保证进程被 reap。
 */
export class DriverHostProcess {
  private child: UtilityProcess | null = null
  private childPid: number | undefined
  private ready = false
  /** 我们主动要求退出（优雅关闭或强杀），用来区分崩溃与正常退出 */
  private expectedExit = false
  private exited = false
  private nextRid = 1
  private readonly pending = new Map<number, PendingCall>()
  private readyResolve: (() => void) | null = null
  private readyReject: ((err: PeekError) => void) | null = null
  private readyTimer: NodeJS.Timeout | null = null
  /** V8 FatalError 的现场，退出时一并上报 */
  private fatalDetail: string | undefined

  constructor(
    readonly connId: ConnId,
    private readonly hooks: HostProcessHooks,
  ) {}

  get pid(): number | undefined {
    return this.childPid
  }

  get alive(): boolean {
    return this.child !== null && !this.exited
  }

  get isReady(): boolean {
    return this.ready && this.alive
  }

  /* ---------------------------------------------------------------- */
  /* 生命周期                                                          */
  /* ---------------------------------------------------------------- */

  /** spawn 并等待 ready 握手。失败时进程已被回收，抛 PeekError。 */
  async spawn(opts: SpawnOptions): Promise<void> {
    // utilityProcess.fork 必须在 app ready 之后
    if (!app.isReady()) await app.whenReady()

    const env = sanitizeEnv({
      ...process.env,
      PEEK_CONN_ID: String(this.connId),
      PEEK_DRIVER_ID: opts.driverId,
    })

    let child: UtilityProcess
    try {
      child = utilityProcess.fork(
        opts.entryPath,
        [`--conn=${String(this.connId)}`, `--driver=${opts.driverId}`],
        {
          serviceName: `peek-driver-${opts.driverId}`,
          stdio: opts.forwardStdio ? 'pipe' : 'inherit',
          env,
        },
      )
    } catch (err) {
      throw peekError('DRIVER_CRASHED', `无法启动 driver 进程：${opts.entryPath}`, {
        detail: err instanceof Error ? err.message : String(err),
      })
    }

    this.child = child
    this.wire(child, opts.forwardStdio)

    const readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve
      this.readyReject = reject
      this.readyTimer = setTimeout(() => {
        this.settleReady(timeoutError('driver 进程 ready 握手', opts.readyMs))
      }, opts.readyMs)
    })

    try {
      await readyPromise
    } catch (err) {
      // 握手失败：不留僵尸
      this.forceKill()
      throw err
    }
  }

  private wire(child: UtilityProcess, forwardStdio: boolean): void {
    child.on('spawn', () => {
      this.childPid = child.pid
    })

    // message 的声明类型是 any；这里用 unknown 收，内部自行收窄
    child.on('message', (raw: unknown) => {
      this.handleMessage(raw)
    })

    child.on('error', (type: string, location: string, report: string) => {
      // V8 不可续错误：exit 一定紧随其后
      this.fatalDetail = `${type} @ ${location}\n${report}`
      this.hooks.onStdio('error', `driver 进程致命错误：${type} @ ${location}`)
    })

    child.on('exit', (code: number) => {
      this.handleExit(code)
    })

    if (forwardStdio) {
      child.stdout?.on('data', (chunk: unknown) => {
        const text = decodeChunk(chunk)
        if (text) this.hooks.onStdio('info', text)
      })
      child.stderr?.on('data', (chunk: unknown) => {
        const text = decodeChunk(chunk)
        if (text) this.hooks.onStdio('error', text)
      })
    }
  }

  private handleMessage(raw: unknown): void {
    const msg = parseHostOutbound(raw)
    if (!msg) {
      this.hooks.onStdio('warn', `收到无法识别的 driver 消息：${safeBrief(raw)}`)
      return
    }

    // 容错：契约规定 host 起来先发 ready；万一驱动漏发，收到任何消息也视为已就绪
    if (!this.ready) this.settleReady(null)

    if (isHostResponse(msg)) {
      const call = this.pending.get(msg.rid)
      if (!call) return // 超时后迟到的响应，丢弃
      this.pending.delete(msg.rid)
      if (call.timer) clearTimeout(call.timer)
      if (msg.ok) call.resolve(msg.result)
      else call.reject(msg.error)
      return
    }

    if (isHostEvent(msg)) {
      if (msg.type === 'ready') this.childPid = msg.pid
      this.hooks.onEvent(msg)
    }
  }

  private handleExit(code: number): void {
    if (this.exited) return
    this.exited = true
    const expected = this.expectedExit
    const detail = this.fatalDetail

    // 未完成的 RPC 全部收敛成 DRIVER_CRASHED，绝不悬空
    const error = expected
      ? peekError('CONNECTION_LOST', 'driver 进程已关闭')
      : crashedError(detail ?? `退出码 ${code}`)
    for (const [rid, call] of this.pending) {
      if (call.timer) clearTimeout(call.timer)
      call.reject(error)
      this.pending.delete(rid)
    }
    this.settleReady(error)

    this.child = null
    this.childPid = undefined
    this.hooks.onExit(code, expected, detail)
  }

  private settleReady(error: PeekError | null): void {
    if (this.readyTimer) {
      clearTimeout(this.readyTimer)
      this.readyTimer = null
    }
    const resolve = this.readyResolve
    const reject = this.readyReject
    this.readyResolve = null
    this.readyReject = null
    if (error) {
      reject?.(error)
      return
    }
    this.ready = true
    resolve?.()
  }

  /* ---------------------------------------------------------------- */
  /* RPC                                                               */
  /* ---------------------------------------------------------------- */

  /**
   * 发一条 RPC 并等响应。
   * 失败一律 reject **PeekError 形状**（不是 Error 实例）。
   */
  call<M extends HostMethod>(method: M, params: HostParams<M>, timeoutMs: number): Promise<HostResult<M>> {
    const child = this.child
    if (!child || this.exited) {
      return Promise.reject(crashedError('driver 进程不在运行'))
    }
    const rid = this.nextRid++
    const req: HostRequestOf<M> = { kind: 'req', rid, method, params }

    return new Promise<HostResult<M>>((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(rid)
              reject(timeoutError(`driver 调用 ${method}`, timeoutMs))
            }, timeoutMs)
          : null

      this.pending.set(rid, {
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      })

      try {
        // postMessage 走结构化克隆；req 的形状已由 HostRequestOf<M> 钉死
        child.postMessage(req)
      } catch (err) {
        this.pending.delete(rid)
        if (timer) clearTimeout(timer)
        reject(crashedError(err instanceof Error ? err.message : String(err)))
      }
    })
  }

  /** 移交数据面端口：host 收到后把它作为 chunk 出口，数据不再经过 main */
  attachPort(port: MessagePortMain): void {
    const child = this.child
    if (!child || this.exited) throw crashedError('driver 进程不在运行')
    const msg: HostInbound = { kind: 'attachPort', connId: this.connId }
    child.postMessage(msg, [port])
  }

  /* ---------------------------------------------------------------- */
  /* 关闭                                                              */
  /* ---------------------------------------------------------------- */

  /**
   * 优雅关闭：disconnect → shutdown → 等退出 → 兜底强杀。
   * 每一步都吞错，目标只有一个：进程一定死掉，资源一定回收。
   */
  async shutdown(opts: { disconnectMs: number; shutdownMs: number; exitMs: number }): Promise<void> {
    if (!this.alive) return
    this.expectedExit = true
    try {
      await this.call('disconnect', {}, opts.disconnectMs)
    } catch {
      /* 关连接失败不影响后续强杀 */
    }
    try {
      await this.call('shutdown', {}, opts.shutdownMs)
    } catch {
      /* 同上 */
    }
    await this.waitExit(opts.exitMs)
    if (this.alive) this.forceKill()
  }

  /** 强杀。PLAN 第 3 节：强制取消 = 杀进程。 */
  forceKill(): boolean {
    const child = this.child
    if (!child) return false
    this.expectedExit = true
    const killed = child.kill()
    // kill() 之后 exit 事件通常会来；万一没来（进程已被 reap），主动收尾
    if (!killed && !this.exited) this.handleExit(-1)
    return killed
  }

  /** 等进程退出，超时返回 false */
  waitExit(ms: number): Promise<boolean> {
    if (this.exited) return Promise.resolve(true)
    return new Promise<boolean>((resolve) => {
      const child = this.child
      if (!child) {
        resolve(true)
        return
      }
      const timer = setTimeout(() => resolve(false), ms)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve(true)
      })
    })
  }
}

/* ================================================================== */
/* 小工具                                                              */
/* ================================================================== */

/** ForkOptions.env 不接受 undefined 值，先过滤 */
function sanitizeEnv(src: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(src)) {
    if (typeof v === 'string') out[k] = v
  }
  return out
}

function decodeChunk(chunk: unknown): string {
  if (typeof chunk === 'string') return chunk.trimEnd()
  if (chunk instanceof Uint8Array) return Buffer.from(chunk).toString('utf8').trimEnd()
  return String(chunk).trimEnd()
}

function safeBrief(value: unknown): string {
  try {
    const text = JSON.stringify(value) ?? String(value)
    return text.length > 200 ? `${text.slice(0, 200)}…` : text
  } catch {
    return String(value)
  }
}
