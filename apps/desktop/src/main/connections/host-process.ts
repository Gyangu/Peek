import { app, utilityProcess } from 'electron'
import type { MessagePortMain, UtilityProcess } from 'electron'
import {
  isHostEvent,
  isHostResponse,
  peekErrorMsg,
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
/* Message parsing: utilityProcess messages are `any`, so narrow to       */
/* HostOutbound first                                                    */
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
/* Single-process wrapper                                              */
/* ================================================================== */

interface PendingCall {
  method: HostMethod
  /** call() pins the type to M; storage erases it */
  resolve: (value: unknown) => void
  reject: (error: PeekError) => void
  timer: NodeJS.Timeout | null
}

export interface HostProcessHooks {
  /** One-way events from the host (status / result.* / log) */
  onEvent(event: HostEvent): void
  /** The process exited. `expected` means we asked for it. */
  onExit(code: number, expected: boolean, detail?: string): void
  /** Forwarded stdout / stderr */
  onStdio(level: NotifyLevel, text: string): void
}

export interface SpawnOptions {
  entryPath: string
  driverId: DriverId
  readyMs: number
  forwardStdio: boolean
}

/**
 * Process wrapper around one driver host (an Electron utilityProcess).
 *
 * Scope: **process lifecycle and RPC correlation only** — it knows nothing about
 * driver semantics.
 * - Lifecycle: spawn → ready handshake → serve → graceful shutdown / kill
 * - Crash isolation: when the process dies, every in-flight RPC rejects with
 *   DRIVER_CRASHED and resources are reclaimed on the spot
 * - Data plane: attachPort() hands a MessagePortMain to the process, so chunks
 *   never pass through main
 *
 * Differences from child_process (learned the hard way while writing this):
 * - `utilityProcess.fork` must be called after the app is ready;
 * - communication uses `postMessage` / the `'message'` event (structured clone),
 *   **not** `send`/`ipc`;
 * - MessagePortMain can be transferred, and the child receives it through
 *   `process.parentPort`;
 * - there is no SIGKILL-level API: `kill()` sends SIGTERM and guarantees the
 *   process gets reaped.
 */
export class DriverHostProcess {
  private child: UtilityProcess | null = null
  private childPid: number | undefined
  private ready = false
  /** We asked the process to exit (graceful shutdown or kill); distinguishes a crash from a clean exit */
  private expectedExit = false
  private exited = false
  private nextRid = 1
  private readonly pending = new Map<number, PendingCall>()
  private readyResolve: (() => void) | null = null
  private readyReject: ((err: PeekError) => void) | null = null
  private readyTimer: NodeJS.Timeout | null = null
  /** The V8 FatalError report, reported along with the exit */
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
  /* Lifecycle                                                         */
  /* ---------------------------------------------------------------- */

  /** Spawn and wait for the ready handshake. On failure the process has already been reaped and a PeekError is thrown. */
  async spawn(opts: SpawnOptions): Promise<void> {
    // utilityProcess.fork must be called after the app is ready
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
      throw peekErrorMsg(
        'DRIVER_CRASHED',
        'error.driver.hostSpawnFailed',
        { entryPath: opts.entryPath },
        { detail: err instanceof Error ? err.message : String(err) },
      )
    }

    this.child = child
    this.wire(child, opts.forwardStdio)

    const readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve
      this.readyReject = reject
      this.readyTimer = setTimeout(() => {
        this.settleReady(timeoutError('The driver ready handshake', opts.readyMs))
      }, opts.readyMs)
    })

    try {
      await readyPromise
    } catch (err) {
      // Handshake failed: leave no zombie behind
      this.forceKill()
      throw err
    }
  }

  private wire(child: UtilityProcess, forwardStdio: boolean): void {
    child.on('spawn', () => {
      this.childPid = child.pid
    })

    // The declared message type is any; take it as unknown and narrow internally
    child.on('message', (raw: unknown) => {
      this.handleMessage(raw)
    })

    child.on('error', (type: string, location: string, report: string) => {
      // An unrecoverable V8 error: an exit always follows
      this.fatalDetail = `${type} @ ${location}\n${report}`
      this.hooks.onStdio('error', `Fatal error in the driver process: ${type} @ ${location}`)
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
      this.hooks.onStdio('warn', `Unrecognized message from the driver: ${safeBrief(raw)}`)
      return
    }

    // Leniency: the contract says the host emits ready first, but if a driver forgets, any message counts as ready
    if (!this.ready) this.settleReady(null)

    if (isHostResponse(msg)) {
      const call = this.pending.get(msg.rid)
      if (!call) return // A response that arrived after the timeout; drop it
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

    // Every unfinished RPC collapses into DRIVER_CRASHED; none is left dangling
    const error = expected
      ? peekErrorMsg('CONNECTION_LOST', 'error.driver.hostClosed')
      : crashedError(detail ?? `Exit code ${code}.`)
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
   * Send one RPC and await its response.
   * Failures always reject with a **PeekError shape**, never an Error instance.
   */
  call<M extends HostMethod>(method: M, params: HostParams<M>, timeoutMs: number): Promise<HostResult<M>> {
    const child = this.child
    if (!child || this.exited) {
      return Promise.reject(crashedError('The driver process is not running.'))
    }
    const rid = this.nextRid++
    const req: HostRequestOf<M> = { kind: 'req', rid, method, params }

    return new Promise<HostResult<M>>((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(rid)
              reject(timeoutError(`The driver call ${method}`, timeoutMs))
            }, timeoutMs)
          : null

      this.pending.set(rid, {
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      })

      try {
        // postMessage uses structured clone; HostRequestOf<M> has already pinned req's shape
        child.postMessage(req)
      } catch (err) {
        this.pending.delete(rid)
        if (timer) clearTimeout(timer)
        reject(crashedError(err instanceof Error ? err.message : String(err)))
      }
    })
  }

  /** Hand over the data-plane port: the host uses it as its chunk outlet, and data stops passing through main. */
  attachPort(port: MessagePortMain): void {
    const child = this.child
    if (!child || this.exited) throw crashedError('The driver process is not running.')
    const msg: HostInbound = { kind: 'attachPort', connId: this.connId }
    child.postMessage(msg, [port])
  }

  /* ---------------------------------------------------------------- */
  /* Shutdown                                                          */
  /* ---------------------------------------------------------------- */

  /**
   * Graceful shutdown: disconnect → shutdown → wait for exit → kill as a last
   * resort. Every step swallows errors, because there is only one goal: the
   * process must die and its resources must be reclaimed.
   */
  async shutdown(opts: { disconnectMs: number; shutdownMs: number; exitMs: number }): Promise<void> {
    if (!this.alive) return
    this.expectedExit = true
    try {
      await this.call('disconnect', {}, opts.disconnectMs)
    } catch {
      /* A failed disconnect must not stop the kill that follows */
    }
    try {
      await this.call('shutdown', {}, opts.shutdownMs)
    } catch {
      /* Same here */
    }
    await this.waitExit(opts.exitMs)
    if (this.alive) this.forceKill()
  }

  /** Kill the process. PLAN section 3: a forced cancel *is* killing the process. */
  forceKill(): boolean {
    const child = this.child
    if (!child) return false
    this.expectedExit = true
    const killed = child.kill()
    // An exit event usually follows kill(); if it does not (the process was already reaped), wind things up ourselves
    if (!killed && !this.exited) this.handleExit(-1)
    return killed
  }

  /** Wait for the process to exit; returns false on timeout. */
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
/* Small helpers                                                       */
/* ================================================================== */

/** ForkOptions.env rejects undefined values, so filter them out first. */
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
