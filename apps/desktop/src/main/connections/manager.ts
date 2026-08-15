import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { WebContents } from 'electron'
import {
  newConnId,
  peekErrorMsg,
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
  type KeyValueWindow,
  type NamespaceNode,
  type NotifyLevel,
  type PeekError,
  type PeekedValue,
  type ResultId,
  type ServerInfo,
  type ValueRef,
} from '@peek/core'
import {
  classifyConnectError,
  classifyExecError,
  crashedError,
  notFoundConn,
  notReadyConn,
  timeoutError,
  unsupported,
} from './classify'
import { ResultDeadlines, type DeadlineTimerApi } from './deadline'
import { resolveHostDir } from './spawn-policy'
import { DEFAULT_TIMEOUTS, resolveExecutionTimeout, type ExecutionKind, type Timeouts } from './timeouts'
import { TypedEmitter } from './emitter'
import { DriverHostProcess } from './host-process'
import { DataPlaneLink } from './port-broker'
import { lookupDriver } from './registry'
import { packageIdForDriver } from '../../drivers/installed'
import { packageEntryPaths } from '../packages/locations'
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
/* Internal bookkeeping                                                */
/* ================================================================== */

interface ConnEntry {
  connId: ConnId
  driverId: DriverId
  config: ConnectionConfig
  status: ConnStatus
  capabilities: Capability[]
  serverInfo?: ServerInfo
  error?: PeekError
  readyAt?: number
  host: DriverHostProcess
  link: DataPlaneLink
  /** Result sets currently streaming; each has to be failed when the process dies, or the UI spins forever */
  activeResults: Set<ResultId>
  /**
   * Result sets this manager has already settled as TIMEOUT.
   *
   * Cancelling a timed-out request makes the driver terminate its stream the only
   * way it can — by emitting `result.error(CANCELLED)` — and that event would land
   * on a result whose reason has already been decided. Without this set the user
   * sees "cancelled" for something they never cancelled, and the deadline they
   * configured leaves no trace anywhere. Ids are removed as the driver's late
   * answer arrives.
   */
  timedOutResults: Set<ResultId>
  /**
   * Something elsewhere already moved status to a terminal value (a forced
   * cancel, a failed connect); the exit callback must not overwrite it.
   */
  statusSettled: boolean
}

/* ================================================================== */
/* ConnectionManager                                                   */
/* ================================================================== */

/**
 * The Connection Manager: host-process management for drivers (PLAN section 3,
 * the process model).
 *
 * One connection = one Electron utilityProcess = one data-plane MessagePort.
 *
 * - **Crash isolation**: a dead process affects only its own connection and
 *   leaves the main window untouched. In-flight RPCs collapse into
 *   DRIVER_CRASHED, in-flight result sets each get a result.error, the port
 *   closes and the entry is removed.
 * - **Forced cancel = kill the process**: when cooperative cancel times out, or
 *   the driver has no cancel capability, the process is killed outright.
 * - **The data plane bypasses main**: the port is handed over once at connect
 *   time, and from then on chunks go from the host straight to the renderer.
 *
 * Upward it is injected into the Command Bus as `ConnectionEffects`; state
 * changes reach the bus through `events`.
 */
export class ConnectionManager implements ConnectionEffects {
  /** Event outlet: the Command Bus subscribes to status / result.*, the notification layer to log / crashed */
  readonly events = new TypedEmitter<ConnectionEventMap>()

  private readonly conns = new Map<ConnId, ConnEntry>()
  private readonly timeouts: Timeouts
  private readonly hostDir: string
  private readonly forwardStdio: boolean
  /** Whole-fetch deadlines; see ./deadline.ts for why main and not the driver holds this clock. */
  private readonly deadlines: ResultDeadlines
  private webContents: WebContents | null = null

  constructor(options: ConnectionManagerOptions = {}) {
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts }
    this.deadlines = new ResultDeadlines(options.timers)
    // The main bundle and the driver-host bundle both live in out/main (see electron.vite.config.ts)
    if (options.hostDir !== undefined) {
      this.hostDir = options.hostDir
    } else {
      const decision = resolveHostDir(import.meta.dirname, process.env, options.allowHostDirOverride ?? false)
      this.hostDir = decision.dir
      // Loud, always. The whole point of the check is that this variable stops
      // being able to change where the plaintext-password process loads from
      // *quietly*; a silent success would keep the half that matters.
      if (decision.note !== null) console.error(`[peek/error] ${decision.note}`)
    }
    this.forwardStdio = options.forwardStdio ?? true
  }

  /* ---------------------------------------------------------------- */
  /* Renderer binding (the far end of the data-plane handover)         */
  /* ---------------------------------------------------------------- */

  /**
   * Bind the renderer. Call once after the window is created, and again on every
   * renderer reload (did-finish-load): the old port dies with the old document,
   * so a fresh channel is opened and handed over automatically.
   */
  attachRenderer(wc: WebContents): void {
    this.webContents = wc
    for (const entry of this.conns.values()) {
      this.deliverPort(entry)
    }
  }

  /** The renderer is gone (window closed). Connections and processes stay alive; the port is handed over again on the next attach. */
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
      this.emitLog(entry.connId, 'error', 'Failed to hand over the data-plane port', briefOf(err))
    }
  }

  /* ---------------------------------------------------------------- */
  /* Connect / disconnect                                              */
  /* ---------------------------------------------------------------- */

  async connect(config: ConnectionConfig, options: ConnectOptions = {}): Promise<ConnectOutcome> {
    const registration = lookupDriver(config.driverId)
    if (!registration) {
      throw peekErrorMsg(
        'BAD_REQUEST',
        'error.conn.driverNotRegistered',
        { driverId: config.driverId },
        { detail: 'Register it in src/main/connections/registry.ts to enable it.' },
      )
    }

    const entryPath = join(this.hostDir, registration.entryFile)
    if (!existsSync(entryPath)) {
      throw peekErrorMsg('INTERNAL', 'error.driver.hostBuildMissing', undefined, {
        detail:
          `${entryPath} not found; check that electron-vite's main.rollupOptions.input ` +
          'still declares the driver-host entry.',
      })
    }

    // The other half of the entry: peek's host bundle above, the package's own
    // `driver.mjs` here. Both are resolved before the fork so that a package that
    // went missing between the scan and this connect fails as a named error
    // rather than as a child that exits during its first import.
    //
    // Two lookups because they answer two questions and the second can fail on
    // its own: which package owns this driver (the registry the window and main
    // share), and where that package keeps its code (main only).
    const packageId = packageIdForDriver(config.driverId)
    const entries = packageId === null ? null : packageEntryPaths(packageId)
    if (entries === null) {
      throw peekErrorMsg('INTERNAL', 'error.driver.hostBuildMissing', undefined, {
        detail:
          `No installed package was found for driver '${config.driverId}'. It is in the registry, ` +
          'so the scan accepted it and its directory has gone away since.',
      })
    }

    const connId = options.connId ?? newConnId()
    // Reconnect: reap the old process first — one connId must never own two processes
    if (this.conns.has(connId)) await this.disconnect(connId)

    const host = new DriverHostProcess(connId, {
      onEvent: (event) => this.handleHostEvent(connId, event),
      onExit: (code, expected, detail) => this.handleHostExit(connId, code, expected, detail),
      onStdio: (level, text) => this.emitLog(connId, level, text),
    })

    const entry: ConnEntry = {
      connId,
      driverId: config.driverId,
      config,
      status: 'connecting',
      capabilities: [],
      host,
      link: new DataPlaneLink(connId, host),
      activeResults: new Set<ResultId>(),
      timedOutResults: new Set<ResultId>(),
      statusSettled: false,
    }
    this.conns.set(connId, entry)
    this.setStatus(entry, 'connecting')

    try {
      await host.spawn({
        entryPath,
        packageEntry: entries.driver,
        driverId: config.driverId,
        readyMs: this.timeouts.readyMs,
        forwardStdio: this.forwardStdio,
      })

      // Build the data plane first, so the driver can start pushing chunks into the port the moment connect returns
      entry.link.open()
      this.deliverPort(entry)

      const connectTimeout = options.timeoutMs ?? configConnectTimeout(config) ?? this.timeouts.connectMs
      const result = await host.call('connect', { connId, config, timeoutMs: connectTimeout }, connectTimeout)

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
      // A failed connect must not leave a zombie process behind
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
    // Wind up in-flight result sets first so the UI does not spin forever
    this.failActiveResults(entry, peekErrorMsg('CANCELLED', 'error.conn.closed'))
    entry.link.close()
    await entry.host.shutdown({
      disconnectMs: this.timeouts.disconnectMs,
      shutdownMs: this.timeouts.shutdownMs,
      exitMs: this.timeouts.exitMs,
    })
    this.conns.delete(connId)
    this.setStatus(entry, 'idle')
  }

  /** Called before the app quits: reap every driver process. */
  async disposeAll(): Promise<void> {
    const ids = [...this.conns.keys()]
    await Promise.all(ids.map((id) => this.disconnect(id).catch(() => undefined)))
    this.conns.clear()
    this.deadlines.clearAll()
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
  /* Fetching: start only; the data travels the MessagePort            */
  /* ---------------------------------------------------------------- */

  async runQuery(connId: ConnId, params: HostParams<'query.run'>): Promise<StartResultOutcome> {
    const entry = this.requireReady(connId)
    this.requireCapability(entry, 'tabularQuery')
    return this.startResult(entry, 'query.run', params, 'query', params.resultId)
  }

  async scan(connId: ConnId, params: HostParams<'collection.scan'>): Promise<StartResultOutcome> {
    const entry = this.requireReady(connId)
    this.requireCapability(entry, 'collectionScan')
    return this.startResult(entry, 'collection.scan', params, 'scan', params.resultId)
  }

  async vectorSearch(connId: ConnId, params: HostParams<'vector.search'>): Promise<StartResultOutcome> {
    const entry = this.requireReady(connId)
    this.requireCapability(entry, 'vectorSearch')
    return this.startResult(entry, 'vector.search', params, 'vectorSearch', params.resultId)
  }

  /**
   * The shared skeleton of the three fetch methods.
   * The RPC only *starts* the work: it succeeds as soon as the driver returns a
   * resultId, and row data goes from the host straight to the renderer.
   *
   * Two clocks are set here, and they measure different things. `startTimeout`
   * bounds the RPC that starts the work. The **deadline** bounds the whole fetch,
   * chunks included, and is armed before the request is sent so the two do not
   * stack into twice the budget the caller asked for.
   */
  private async startResult(
    entry: ConnEntry,
    method: 'query.run' | 'collection.scan' | 'vector.search',
    params: HostParams<'query.run'> | HostParams<'collection.scan'> | HostParams<'vector.search'>,
    kind: ExecutionKind,
    resultId: ResultId,
  ): Promise<StartResultOutcome> {
    // The caller's own timeoutMs wins; otherwise the connection override, then the
    // configured default (0 anywhere means "no deadline"). This is the single
    // place the UI's "no timeout field" problem is solved: a request that names no
    // budget still gets one.
    const timeoutMs = resolveExecutionTimeout(entry.connId, kind, params.timeoutMs)

    // Limit for the start phase: build on the caller's execution timeout plus a grace period, otherwise use the default
    const startTimeout =
      timeoutMs === undefined ? this.timeouts.queryStartMs : timeoutMs + this.timeouts.queryGraceMs

    // Tell the driver too, so a cooperative one can stop the statement itself
    // rather than leaving it to be killed from here.
    const outbound = { ...params, ...(timeoutMs === undefined ? {} : { timeoutMs }) }

    // Register before sending: the driver may start emitting chunks or result.done before the RPC response arrives
    entry.activeResults.add(resultId)
    this.armDeadline(entry, resultId, timeoutMs)
    try {
      let res: HostResult<'query.run' | 'collection.scan' | 'vector.search'>
      switch (method) {
        case 'query.run':
          res = await entry.host.call('query.run', outbound as HostParams<'query.run'>, startTimeout)
          break
        case 'collection.scan':
          res = await entry.host.call(
            'collection.scan',
            outbound as HostParams<'collection.scan'>,
            startTimeout,
          )
          break
        case 'vector.search':
          res = await entry.host.call('vector.search', outbound as HostParams<'vector.search'>, startTimeout)
          break
      }
      return { resultId: res.resultId }
    } catch (raw) {
      entry.activeResults.delete(resultId)
      this.deadlines.clear(resultId)
      const error = classifyExecError(raw)
      // Timed out while starting: make a best effort to stop that resultId driver-side rather than leave a dangling cursor
      if (error.code === 'TIMEOUT' && entry.host.alive) {
        void entry.host.call('cancel', { resultId }, this.timeouts.cancelMs).catch(() => undefined)
      }
      throw error
    }
  }

  /**
   * Arm the whole-fetch deadline.
   *
   * On expiry the order matters and is not the obvious one:
   *
   *   1. drop the result from `activeResults` **first**, so the cancel that
   *      follows cannot also report it as CANCELLED and overwrite the reason it
   *      actually stopped;
   *   2. emit `result.error` with a TIMEOUT PeekError — that is what settles the
   *      result set and the view;
   *   3. ask the driver to wind the cursor down, best effort — see
   *      {@link stopExpiredResult} for why this is *not* the same escalation
   *      `query.cancel` performs.
   *
   * Step 3 changes nothing about the answer the user already has; step 2 is the
   * one that has to be right.
   */
  private armDeadline(entry: ConnEntry, resultId: ResultId, timeoutMs: number | undefined): void {
    this.deadlines.arm(resultId, timeoutMs, (ms) => {
      if (!entry.activeResults.delete(resultId)) return
      // Claim the reason before cancelling: the cancel below makes a cooperative
      // driver end its stream with CANCELLED, and that late event must not rewrite
      // a deadline into something the user never asked for.
      entry.timedOutResults.add(resultId)
      const error = timeoutError('the request', ms)
      this.events.emit('result.error', { connId: entry.connId, resultId, error })
      this.emitLog(entry.connId, 'warn', `Request ${resultId} passed its ${ms}ms deadline; stopping it`)
      void stopExpiredResult(
        {
          hostAlive: entry.host.alive,
          capabilities: entry.capabilities,
          askDriver: (id) => entry.host.call('cancel', { resultId: id }, this.timeouts.cancelMs),
          warn: (message, detail) => this.emitLog(entry.connId, 'warn', message, detail),
        },
        resultId,
      )
    })
  }

  /* ---------------------------------------------------------------- */
  /* Single values                                                     */
  /* ---------------------------------------------------------------- */

  async getValue(connId: ConnId, ref: ValueRef, window?: KeyValueWindow): Promise<KeyValueResult> {
    const entry = this.requireReady(connId)
    this.requireCapability(entry, 'keyValue')
    try {
      const res = await entry.host.call(
        'keyvalue.get',
        {
          ref,
          // Spread field by field rather than `...window`: the host params are a
          // closed shape, and a stray key from the renderer must not ride along.
          ...(window?.limit === undefined ? {} : { limit: window.limit }),
          ...(window?.offset === undefined ? {} : { offset: window.offset }),
          ...(window?.cursorToken === undefined ? {} : { cursorToken: window.cursorToken }),
          ...(window?.match === undefined ? {} : { match: window.match }),
        },
        this.timeouts.rpcMs,
      )
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
  /* Cancellation                                                      */
  /* ---------------------------------------------------------------- */

  /**
   * Cancel a result set.
   *
   * Path one (cooperative): the driver declares the cancel capability → send a
   *   cancel RPC, done once it returns within 2s.
   * Path two (forced): the driver has no cancel capability, or the cooperative
   *   cancel timed out or failed, or the caller asked for force → **kill the
   *   process**, which is exactly what PLAN section 3 specifies. Killing the
   *   process kills the connection too, so status goes to error and the UI has
   *   to reconnect.
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
      this.deadlines.clear(resultId)
      return { cancelled: res.cancelled, killed: false }
    } catch (raw) {
      this.emitLog(
        connId,
        'warn',
        'Cooperative cancel failed; escalating to killing the driver process',
        briefOf(raw),
      )
      await this.killForCancel(entry, resultId)
      return { cancelled: true, killed: true }
    }
  }

  private async killForCancel(entry: ConnEntry, resultId: ResultId): Promise<void> {
    const cancelled = peekErrorMsg('CANCELLED', 'error.driver.streamCancelled')
    // The targeted result set reports CANCELLED; every other in-flight one reports a lost connection.
    this.deadlines.clear(resultId)
    if (entry.activeResults.has(resultId)) {
      entry.activeResults.delete(resultId)
      this.events.emit('result.error', { connId: entry.connId, resultId, error: cancelled })
    }
    const lost = peekErrorMsg('CONNECTION_LOST', 'error.conn.killedForCancel', undefined, {
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
  /* Miscellaneous                                                     */
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
  /* Internals                                                         */
  /* ---------------------------------------------------------------- */

  private requireReady(connId: ConnId): ConnEntry {
    const entry = this.conns.get(connId)
    if (!entry) throw notFoundConn(String(connId))
    if (entry.status !== 'ready') throw notReadyConn(String(connId), entry.status)
    if (!entry.host.alive) throw crashedError('The driver process has exited.')
    return entry
  }

  private requireCapability(entry: ConnEntry, capability: Capability): void {
    if (!entry.capabilities.includes(capability)) throw unsupported(entry.driverId, capability)
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

  /** Declare every in-flight result set dead, so the UI never sits at loading forever. */
  private failActiveResults(entry: ConnEntry, error: PeekError): void {
    if (entry.activeResults.size === 0) return
    for (const resultId of [...entry.activeResults]) {
      entry.activeResults.delete(resultId)
      this.deadlines.clear(resultId)
      this.events.emit('result.error', { connId: entry.connId, resultId, error })
    }
  }

  private handleHostEvent(connId: ConnId, event: HostEvent): void {
    const entry = this.conns.get(connId)
    // A result this manager already settled as TIMEOUT has had its say. The
    // driver's own terminal event for it arrives second and is dropped, exactly
    // once — see `timedOutResults`.
    if (
      entry &&
      (event.type === 'result.error' || event.type === 'result.done' || event.type === 'result.paused') &&
      entry.timedOutResults.delete(event.resultId)
    ) {
      this.deadlines.clear(event.resultId)
      return
    }
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
        this.deadlines.clear(event.resultId)
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
        // A pause is terminal too: the cursor is released and no further frames
        // will arrive, so drop it from the in-flight set.
        entry?.activeResults.delete(event.resultId)
        this.deadlines.clear(event.resultId)
        this.events.emit('result.paused', { connId, resultId: event.resultId, paused: event.paused })
        return
      }
      case 'result.error': {
        entry?.activeResults.delete(event.resultId)
        this.deadlines.clear(event.resultId)
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
   * The driver host exited. **This is where crash isolation is enforced**:
   * whether the exit was clean or a crash, this guarantees the port is closed,
   * in-flight result sets are failed, and the entry is removed.
   */
  private handleHostExit(connId: ConnId, code: number, expected: boolean, detail?: string): void {
    const entry = this.conns.get(connId)
    if (!entry) return

    entry.link.close()

    const error = expected
      ? peekErrorMsg('CONNECTION_LOST', 'error.driver.hostClosed')
      : crashedError(detail ?? `The driver process exited unexpectedly with code ${code}.`)

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
/* What a deadline is allowed to do                                    */
/* ================================================================== */

/**
 * The far side of a connection, as seen by an expiring deadline.
 *
 * A narrow record rather than the `ConnEntry` itself, and that is a safety
 * property rather than a testing convenience: **the only lever handed out here is
 * the polite one**. There is no path from this type to `killForCancel`, so the
 * escalation `cancel()` performs cannot find its way back onto the deadline path
 * by someone reaching for the method that was already there.
 */
export interface DeadlineStopTarget {
  hostAlive: boolean
  capabilities: readonly Capability[]
  /** The cooperative cancel RPC. Only reached when `capabilities` includes 'cancel'. */
  askDriver(resultId: ResultId): Promise<unknown>
  /** Report that the polite ask did not work. Nothing escalates afterwards. */
  warn(message: string, detail?: string): void
}

export type DeadlineStopOutcome =
  /** The driver was asked to stop the cursor and agreed. */
  | 'asked'
  /** The driver was asked and did not answer; the connection is left open anyway. */
  | 'ask-failed'
  /** Nothing to ask — no `cancel` capability, or the host is already gone. */
  | 'left-alone'

/**
 * Wind down the cursor behind a request that outlived its deadline.
 *
 * **Deliberately not `ConnectionManager.cancel()`**, and that is the entire point
 * of this function. `cancel()` escalates to `killForCancel` whenever the driver
 * declares no `cancel` capability — killing the driver process, dropping the
 * connection, and failing every *other* in-flight result on it as
 * CONNECTION_LOST. That is a defensible thing to do when a person asks for it. It
 * is not a defensible thing for a default timeout to do on their behalf, to a
 * connection they are still using, with nobody having pressed anything.
 *
 * qdrant is the concrete case: the one driver in `DRIVER_CAPABILITIES` without
 * `cancel`, with default budgets of 120s (scan) and 60s (vector search) that no
 * UI yet exposes. Before this, either budget expiring **disconnected the user**.
 * The renderer already refuses to put that escalation behind a button —
 * `views/ResultControls.tsx` disables Cancel there and says why, because peek's
 * only remaining lever is killing the driver process and firing that from a
 * button labelled Cancel "is not a thing to do to someone by surprise". A silent
 * default deadline is more of a surprise, not less.
 *
 * What replaces the kill: nothing, and nothing is needed. The result has already
 * been settled as TIMEOUT by the caller, so the user's answer does not depend on
 * any of this — it decides only how tidily the far side lets go. A cooperative
 * driver is asked politely. A driver that cannot be asked stops on its own
 * `timeoutMs`, which travelled out with the request and holds the same number the
 * deadline was armed with (qdrant's scroll cursor checks it at every batch
 * boundary and throws TIMEOUT itself).
 *
 * The process is still killed where killing is the honest answer: an explicit
 * `force` cancel, and `handleHostExit` for a host that really did die.
 */
export async function stopExpiredResult(
  target: DeadlineStopTarget,
  resultId: ResultId,
): Promise<DeadlineStopOutcome> {
  if (!target.hostAlive || !target.capabilities.includes('cancel')) return 'left-alone'
  try {
    await target.askDriver(resultId)
    return 'asked'
  } catch (raw) {
    // Still no escalation. A host that will not answer its cancel RPC is a
    // connection worth closing, but that is the user's call — and the request
    // they were waiting on has already been answered.
    target.warn(
      `Could not stop request ${resultId} after its deadline; the connection is left open`,
      briefOf(raw),
    )
    return 'ask-failed'
  }
}

/* ================================================================== */
/* Small helpers                                                       */
/* ================================================================== */

function toRuntime(entry: ConnEntry): ConnectionRuntime {
  return {
    connId: entry.connId,
    driverId: entry.driverId,
    status: entry.status,
    capabilities: [...entry.capabilities],
    ...(entry.serverInfo === undefined ? {} : { serverInfo: entry.serverInfo }),
    ...(entry.error === undefined ? {} : { error: entry.error }),
    ...(entry.host.pid === undefined ? {} : { pid: entry.host.pid }),
    ...(entry.readyAt === undefined ? {} : { readyAt: entry.readyAt }),
    activeResults: [...entry.activeResults],
  }
}

/** sqlite configs have no connectTimeoutMs, so narrow with `in` rather than reading blindly. */
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
