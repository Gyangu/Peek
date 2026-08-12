import { app, utilityProcess } from 'electron'
import type { UtilityProcess } from 'electron'
import {
  peekErrorMsg,
  type NotifyLevel,
  type PackageHostMethod,
  type PackageHostOutbound,
  type PackageHostParams,
  type PackageHostRequestOf,
  type PackageHostResult,
  type PeekError,
} from '@peek/core'
import { crashedError, timeoutError } from '../connections/classify'
import { allowedEnv } from '../connections/spawn-policy'

/* ==================================================================
 * The process wrapper around one package host.
 *
 * `connections/host-process.ts` is the model, and everything below that looks
 * the same as that file *is* the same decision reached twice — one RPC envelope,
 * one deadline owner, one crash story (design 2026-08-07 §2.4bis f-bis: "照抄
 * driver-host，不发明第二套"). What follows is only the three places the two
 * differ, because those are the parts a reader coming from that file will
 * mis-assume.
 *
 * ## No data plane, and therefore no port
 *
 * A driver host moves rows, so its wrapper hands over a `MessagePortMain` and
 * main never sees a chunk. A package host moves answers — four requests, four
 * responses — so there is no port, no chunk framing, and no `attachPort`.
 *
 * ## No ready handshake, because the protocol has no `ready` event
 *
 * `core/package-host.ts` deliberately emits no events at all: `parentPort`
 * buffers messages until the runtime attaches its listener, so the first
 * response *is* the handshake and a host that never comes up is a request that
 * times out. What `spawn()` waits for below is therefore not a handshake but an
 * OS fact — see its comment for why waiting for it is nevertheless mandatory.
 *
 * ## No graceful shutdown, because there is nothing to close
 *
 * The driver wrapper's `shutdown()` calls `disconnect` then `shutdown` before
 * killing, because a driver host holds a live connection. This process holds no
 * connection, no cursor and no file handle, and the protocol has neither method.
 * `dispose()` kills it, which is exactly what makes §2.4bis(f) able to say an
 * uninstalled package's code really leaves memory.
 * ================================================================== */

/**
 * How a package is addressed.
 *
 * A plain string, and deliberately not `DriverId`: a package may ship several
 * drivers (`@peek/db-sql` already ships two) or none at all (a package that
 * only contributes tools). Phase B uses the workspace directory name; Phase C
 * uses the directory name under `~/.peek/packages/`, checked against
 * `PACKAGE_ID` by the loader — which is where the narrowing belongs, since this
 * file forks whatever it is handed.
 */
export type PackageId = string

/**
 * Recognize a response envelope.
 *
 * The mirror of core's `isPackageHostRequest`, and it stops at the envelope for
 * the same reason that one does — except that the trust runs the other way. The
 * package's `result` is the untrusted half of this boundary, so it stays
 * `unknown` here and is validated by whichever caller lands it: this wrapper
 * only needs `rid` to find the promise and `ok` to decide which way to settle
 * it.
 */
function isPackageHostResponse(raw: unknown): raw is PackageHostOutbound {
  if (typeof raw !== 'object' || raw === null) return false
  if (!('kind' in raw) || raw.kind !== 'res') return false
  if (!('rid' in raw) || typeof raw.rid !== 'number') return false
  return 'ok' in raw && typeof raw.ok === 'boolean'
}

interface PendingCall {
  method: PackageHostMethod
  /** call() pins the type to M; storage erases it */
  resolve: (value: unknown) => void
  reject: (error: PeekError) => void
  timer: NodeJS.Timeout | null
}

export interface PackageHostHooks {
  /** The process exited. `expected` means we asked for it. */
  onExit(code: number, expected: boolean, detail?: string): void
  /**
   * Forwarded stdout / stderr.
   *
   * The only channel a package host has for anything that is not a response —
   * core's `startPackageHostProcess` reports its uncaught exceptions through
   * `console.error` precisely because there is no event plane to report them on.
   */
  onStdio(level: NotifyLevel, text: string): void
}

export interface PackageSpawnOptions {
  entryPath: string
  /**
   * The package's own `contrib.mjs`, absolute — what the host loads once it is up.
   *
   * The counterpart of `SpawnOptions.packageEntry` on the driver side, and
   * resolved by the same scan (design §4quaterdecies). A package that ships no
   * contrib never reaches here: `registry.ts` refuses to fork one, because a host
   * with nothing to contribute would answer every request `NOT_FOUND` and main
   * could not tell that from a package that genuinely has no display.
   */
  contribEntry: string
  /** How long to wait for the OS to produce the process; see `spawn()`. */
  spawnMs: number
  forwardStdio: boolean
}

export class PackageHostProcess {
  private child: UtilityProcess | null = null
  private childPid: number | undefined
  private started = false
  /** We asked the process to exit; distinguishes a dispose from a crash */
  private expectedExit = false
  private exited = false
  private nextRid = 1
  private readonly pending = new Map<number, PendingCall>()
  private startResolve: (() => void) | null = null
  private startReject: ((err: PeekError) => void) | null = null
  private startTimer: NodeJS.Timeout | null = null
  /** The V8 FatalError report, reported along with the exit */
  private fatalDetail: string | undefined

  readonly packageId: PackageId
  private readonly hooks: PackageHostHooks

  /**
   * Fields are declared and assigned rather than written as constructor
   * parameter properties, for the reason spelled out at length on
   * `DriverHostProcess`: a parameter property is the one TypeScript construct
   * that emits code, and `--experimental-strip-types` refuses it at import time,
   * which puts this module and everything importing it out of `node --test`'s
   * reach. Keep the explicit form.
   */
  constructor(packageId: PackageId, hooks: PackageHostHooks) {
    this.packageId = packageId
    this.hooks = hooks
  }

  get pid(): number | undefined {
    return this.childPid
  }

  get alive(): boolean {
    return this.child !== null && !this.exited
  }

  /* ---------------------------------------------------------------- */
  /* Lifecycle                                                         */
  /* ---------------------------------------------------------------- */

  /**
   * Fork, and resolve once the process actually exists.
   *
   * Waiting for the `'spawn'` event is not a protocol handshake — the protocol
   * has none — it is what makes the *first* `call()` reliable.
   * `UtilityProcessWrapper::PostMessage` drops the message on the floor while
   * the child's mojo remote is still unbound, with no error and no exception, so
   * a request sent between `fork()` and `'spawn'` becomes exactly the failure
   * core's header warns about: main waits out the deadline knowing nothing. One
   * bounded wait here converts that into either a working process or a `TIMEOUT`
   * that names the stage.
   */
  async spawn(opts: PackageSpawnOptions): Promise<void> {
    // utilityProcess.fork must be called after the app is ready
    if (!app.isReady()) await app.whenReady()

    // The single allowlist from `spawn-policy.ts`, not a second copy: a package
    // host runs the same untrusted package code a driver host does, minus the
    // one thing that justifies handing over a plaintext password. `PEEK_PACKAGE_ID`
    // is added after the allowlist rather than through it — it is set by this
    // process, and listing it would read as though an inherited `PEEK_PACKAGE_ID`
    // were something a package may choose for itself.
    const env: Record<string, string> = {
      ...allowedEnv(process.env),
      PEEK_PACKAGE_ID: this.packageId,
      PEEK_PACKAGE_ENTRY: opts.contribEntry,
    }

    let child: UtilityProcess
    try {
      child = utilityProcess.fork(opts.entryPath, [`--package=${this.packageId}`], {
        // Aligned with `peek-driver-<driverId>` so that a row in Activity Monitor
        // names the package it belongs to (design §2.4bis f-bis, rule 3).
        serviceName: `peek-package-${this.packageId}`,
        stdio: opts.forwardStdio ? 'pipe' : 'inherit',
        env,
      })
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

    const startPromise = new Promise<void>((resolve, reject) => {
      this.startResolve = resolve
      this.startReject = reject
      this.startTimer = setTimeout(() => {
        this.settleStart(timeoutError('The package host process start', opts.spawnMs))
      }, opts.spawnMs)
    })

    try {
      await startPromise
    } catch (err) {
      // Failed to start: leave no zombie behind
      this.forceKill()
      throw err
    }
  }

  private wire(child: UtilityProcess, forwardStdio: boolean): void {
    child.on('spawn', () => {
      this.childPid = child.pid
      this.settleStart(null)
    })

    // The declared message type is any; take it as unknown and narrow internally
    child.on('message', (raw: unknown) => {
      this.handleMessage(raw)
    })

    child.on('error', (type: string, location: string, report: string) => {
      // An unrecoverable V8 error: an exit always follows
      this.fatalDetail = `${type} @ ${location}\n${report}`
      this.hooks.onStdio('error', `Fatal error in the package process: ${type} @ ${location}`)
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
    if (!isPackageHostResponse(raw)) {
      this.hooks.onStdio('warn', `Unrecognized message from the package host: ${safeBrief(raw)}`)
      return
    }

    const call = this.pending.get(raw.rid)
    if (!call) return // A response that arrived after the timeout; drop it
    this.pending.delete(raw.rid)
    if (call.timer) clearTimeout(call.timer)
    if (raw.ok) call.resolve(raw.result)
    else call.reject(raw.error)
  }

  private handleExit(code: number): void {
    if (this.exited) return
    this.exited = true
    const expected = this.expectedExit
    const detail = this.fatalDetail

    // Every unfinished RPC collapses into one structured error; none is left
    // dangling. Both cases reuse `crashedError` rather than splitting a disposed
    // process off as CONNECTION_LOST the way the driver wrapper does: that split
    // exists so a user-initiated disconnect does not read as a fault, and a
    // package host has no user-initiated close — it is killed, by an uninstall or
    // by quit, and in both the caller is a computation nobody is waiting on. The
    // detail still says which happened.
    const error = crashedError(
      expected
        ? 'The package host was disposed while the call was in flight.'
        : (detail ?? `Exit code ${code}.`),
    )
    for (const [rid, call] of this.pending) {
      if (call.timer) clearTimeout(call.timer)
      call.reject(error)
      this.pending.delete(rid)
    }
    this.settleStart(error)

    this.child = null
    this.childPid = undefined
    this.hooks.onExit(code, expected, detail)
  }

  private settleStart(error: PeekError | null): void {
    if (this.startTimer) {
      clearTimeout(this.startTimer)
      this.startTimer = null
    }
    const resolve = this.startResolve
    const reject = this.startReject
    this.startResolve = null
    this.startReject = null
    if (error) {
      reject?.(error)
      return
    }
    this.started = true
    resolve?.()
  }

  /* ---------------------------------------------------------------- */
  /* RPC                                                               */
  /* ---------------------------------------------------------------- */

  /**
   * Send one RPC and await its response.
   *
   * `timeoutMs` is an argument because the deadline is main's, not the package's
   * (design §2.4bis f-bis, rule 1): a package whose `autoFetch` loops forever
   * must not be able to stop a Command from reducing.
   *
   * Failures always reject with a **PeekError shape**, never an Error instance.
   */
  call<M extends PackageHostMethod>(
    method: M,
    params: PackageHostParams<M>,
    timeoutMs: number,
  ): Promise<PackageHostResult<M>> {
    const child = this.child
    if (!child || this.exited || !this.started) {
      return Promise.reject(crashedError('The package host process is not running.'))
    }
    const rid = this.nextRid++
    const req: PackageHostRequestOf<M> = { kind: 'req', rid, method, params }

    return new Promise<PackageHostResult<M>>((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(rid)
              reject(timeoutError(`The package call ${method}`, timeoutMs))
            }, timeoutMs)
          : null

      this.pending.set(rid, {
        method,
        // The one assertion in this file, and the same one `DriverHostProcess`
        // makes at the same line. The map is heterogeneous — four methods, four
        // result types — so storing the resolver erases M, and landing an
        // `unknown` back into it is exactly the conversion no sound signature
        // can express. It is confined to this line: nothing downstream re-widens,
        // and the value it covers is validated where the answer is landed.
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      })

      try {
        // postMessage uses structured clone; PackageHostRequestOf<M> has already pinned req's shape
        child.postMessage(req)
      } catch (err) {
        this.pending.delete(rid)
        if (timer) clearTimeout(timer)
        reject(crashedError(err instanceof Error ? err.message : String(err)))
      }
    })
  }

  /* ---------------------------------------------------------------- */
  /* Shutdown                                                          */
  /* ---------------------------------------------------------------- */

  /** Kill the process and wait for it to be reaped. There is nothing to close first — see the header. */
  async dispose(exitMs: number): Promise<void> {
    if (!this.alive) return
    this.forceKill()
    await this.waitExit(exitMs)
  }

  /** Kill the process. */
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
