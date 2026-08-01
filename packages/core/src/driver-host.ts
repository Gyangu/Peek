import {
  hasCapability,
  keyValueReadOptions,
  supportsCancel,
  supportsCollectionScan,
  supportsIntrospect,
  supportsKeyValue,
  supportsTabularQuery,
  supportsValuePeek,
  supportsVectorSearch,
  type ByteRange,
  type Capability,
  type ConnectionConfig,
  type Cursor,
  type Driver,
  type DriverId,
  type DriverSession,
} from './capability'
import { ACK_WINDOW, VALUE_PEEK_MAX_BYTES, type ResultPause, type ResultStreamAck, type ResultStreamMessage } from './chunk'
import { peekError, peekErrorMsg, toPeekError, type PeekError } from './errors'
import type { ResultId } from './ids'
import type {
  HostEvent,
  HostInbound,
  HostMethod,
  HostRequest,
  HostResponseOf,
  HostResult,
} from './ipc'
import type { NotifyLevel } from './ipc'

/**
 * The **driver-agnostic** driver-host runtime: one implementation of the protocol
 * declared in `ipc.ts` (HostInbound / HostOutbound), parameterized by which
 * `Driver`s it can serve.
 *
 * ## Why this lives in core
 *
 * It did not, at first. M1 put the host runtime inside `@peek/driver-postgres`,
 * where it was 95% driver-agnostic and 5% hard-wired: it defaulted to
 * `postgresDriver`, called `requirePostgresConfig` on connect, and answered
 * `vector.search` and `keyvalue.get` with UNSUPPORTED_CAPABILITY unconditionally.
 * That last part is the tell — **a capability the protocol defines was declared
 * unimplementable by the transport layer**, which is not a decision the transport
 * gets to make.
 *
 * The alternative was for each new driver package to carry its own copy of the
 * ~350 lines below, most of which is the backpressure pump. Three copies of an
 * ack-window state machine is three sets of the same race condition, and the one
 * end-to-end test that exercises it would only ever cover one of them. So the
 * runtime moved here, next to the protocol it implements, and the driver packages
 * shrank back to what a driver actually is: connect, introspect, produce cursors.
 *
 * `@peek/driver-postgres` keeps its own copy for now (its 50 tests pin that
 * implementation); it is a straight substitution whenever someone wants to make
 * it.
 *
 * ## The two planes stay separate (PLAN section 3)
 *
 * - control plane: main ↔ host over `channel`, RPC plus one-way events;
 * - data plane: host → renderer over the MessagePort handed across by
 *   `attachPort`, carrying chunks directly, with the renderer replying ack/cancel.
 *
 * Nothing here imports electron, so the whole protocol is exercisable in
 * `node:test` with an ordinary `MessageChannel`.
 */

/* ------------------------------------------------------------------ */
/* Transport abstraction: only the methods actually used                */
/* ------------------------------------------------------------------ */

/** The data-plane port (an Electron MessagePortMain, or a node MessagePort in tests) */
export interface HostDataPort {
  postMessage(message: unknown): void
  on(event: 'message', listener: (event: { data: unknown }) => void): void
  start?(): void
  close?(): void
}

export interface HostChannelMessage {
  data: unknown
  ports?: readonly HostDataPort[]
}

/** The control-plane channel to main (an Electron parentPort) */
export interface HostChannel {
  postMessage(message: unknown): void
  on(event: 'message', listener: (event: HostChannelMessage) => void): void
  start?(): void
}

/* ------------------------------------------------------------------ */
/* Driver resolution                                                    */
/* ------------------------------------------------------------------ */

/**
 * Which drivers this host process can serve.
 *
 * There is a single `driver-host.js` bundle, and main spawns it for every
 * connection regardless of driver, so the process learns which database it is
 * talking to only when `connect` arrives with a config. Registering a driver is
 * therefore adding one entry to this list — the "+1 line" half of "adding a
 * database is one package plus one line".
 */
export type DriverRegistry = ReadonlyMap<DriverId, Driver>

export function buildDriverRegistry(drivers: readonly Driver[]): DriverRegistry {
  const map = new Map<DriverId, Driver>()
  for (const driver of drivers) map.set(driver.meta.id, driver)
  return map
}

/** UNSUPPORTED_CAPABILITY with the driver and capability spelled out */
function unsupported(driverId: DriverId, capability: Capability): PeekError {
  return peekErrorMsg('UNSUPPORTED_CAPABILITY', 'error.conn.unsupportedCapability', {
    driverId,
    capability,
  })
}

/* ------------------------------------------------------------------ */
/* Inbound message recognition                                          */
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
/* Result pump: cursor frames → MessagePort, under ack-window backpressure */
/* ------------------------------------------------------------------ */

/**
 * Idle ceiling for a backpressure pause, in milliseconds.
 *
 * Once the ack window is full, waiting this long for the next ack (the viewport
 * is parked, the renderer's cache is at capacity) means packing up: close the
 * cursor and give the server-side resources back. Otherwise "paused" amounts to
 * holding a server cursor open indefinitely (PLAN section 8).
 *
 * Packing up **ends in paused, not error**: nothing went wrong with the query and
 * every row already delivered is valid. See `ResultPause` in chunk.ts for why the
 * distinction has to survive all the way out to MCP.
 */
const IDLE_ACK_TIMEOUT_MS = 60_000

/** What waitWindow decided: keep producing frames, or pause by design */
type WindowWait = 'go' | 'paused'

/**
 * Release a timer's hold on process exit, where the runtime offers that.
 *
 * Written structurally because **core is compiled with `types: []`** — it is
 * imported by the renderer as well, so it may not depend on node's globals.
 * `setTimeout` is therefore the DOM's, returning a number, while at runtime in the
 * driver host it is node's, returning a Timeout with `.unref()`.
 */
function unrefTimer(timer: unknown): void {
  if (typeof timer !== 'object' || timer === null) return
  const maybe = (timer as { unref?: unknown }).unref
  if (typeof maybe === 'function') (maybe as () => void).call(timer)
}

class StreamPump {
  readonly resultId: ResultId

  private readonly cursor: Cursor
  private readonly host: DriverHostRuntime
  private readonly idleAckMs: number
  private unacked = 0
  private lastSentSeq = -1
  private resumeFn: (() => void) | null = null
  private stopped = false
  private rows = 0
  private readonly startedAt = Date.now()
  /** Signal rejected by stop(), used to break awaits that never look at the stopped flag */
  private readonly stopSignal: Promise<never>
  private stopReject: ((reason: unknown) => void) | null = null

  constructor(host: DriverHostRuntime, resultId: ResultId, cursor: Cursor, idleAckMs: number) {
    this.host = host
    this.resultId = resultId
    this.cursor = cursor
    this.idleAckMs = idleAckMs
    this.stopSignal = new Promise<never>((_resolve, reject) => {
      this.stopReject = reject
    })
    // When stop() arrives after the pump has already finished, nothing is racing
    // this promise; an empty sink keeps it from becoming an unhandledRejection
    this.stopSignal.catch(() => {})
  }

  /** The renderer confirms it consumed through `seq` inclusive, advancing the window */
  ack(seq: number): void {
    this.unacked = Math.max(0, this.lastSentSeq - seq)
    if (this.unacked < ACK_WINDOW) this.wake()
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    // Wake waitWindow (a normal resolve; the next step of the loop sees `stopped`
    // and throws CANCELLED itself)
    this.wake()
    // Break the waits that would never wake on their own, such as waitPort
    const reject = this.stopReject
    this.stopReject = null
    if (reject) reject(peekErrorMsg('CANCELLED', 'error.driver.streamCancelled'))
  }

  private wake(): void {
    const fn = this.resumeFn
    this.resumeFn = null
    if (fn) fn()
  }

  /**
   * Suspend once ACK_WINDOW frames are unacknowledged, until an ack arrives.
   * Suspending longer than idleAckMs returns 'paused', which packs the stream up
   * and releases the server-side resources.
   *
   * **Never rejects**: a pause is not an exception, and routing it through the
   * exception channel inevitably mixes it up with real failures.
   */
  private waitWindow(): Promise<WindowWait> {
    if (this.stopped || this.unacked < ACK_WINDOW) return Promise.resolve('go')
    return new Promise<WindowWait>((resolve) => {
      const timer = setTimeout(() => {
        this.resumeFn = null
        resolve('paused')
      }, this.idleAckMs)
      // A pump waiting for an ack must not hold process exit open
      unrefTimer(timer)
      this.resumeFn = (): void => {
        clearTimeout(timer)
        resolve('go')
      }
    })
  }

  /** Pause by design: result.paused on the control plane, t:'paused' on the data plane — neither is an error */
  private announcePause(): void {
    const pause: ResultPause = {
      rows: this.rows,
      elapsedMs: Date.now() - this.startedAt,
      reason: 'idleAck',
      // English literal on purpose: this text is written into workspace state and
      // read back by MCP, which stays English forever.
      message:
        `Result stream paused: no consumption ack for ${Math.round(this.idleAckMs / 1000)}s,`
        + ' the server-side cursor and connection have been released',
      resumable: true,
    }
    this.host.sendStream({ t: 'paused', resultId: this.resultId, paused: pause })
    this.host.emit({ kind: 'evt', type: 'result.paused', resultId: this.resultId, paused: pause })
  }

  async run(): Promise<void> {
    try {
      for (;;) {
        if (this.stopped) throw peekErrorMsg('CANCELLED', 'error.driver.streamCancelled')
        // Produce nothing until the port has been handed over — natural
        // backpressure. **It has to stay interruptible**: otherwise a query issued
        // before attachPort wedges here forever, cancellation cannot wake it, and
        // the cursor holds its server-side resources indefinitely.
        const port = await Promise.race([this.host.waitPort(), this.stopSignal])
        if (await this.waitWindow() === 'paused') {
          this.announcePause()
          break
        }
        if (this.stopped) throw peekErrorMsg('CANCELLED', 'error.driver.streamCancelled')

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
/* The host itself                                                     */
/* ------------------------------------------------------------------ */

export interface DriverHostRuntimeOptions {
  /** Every driver this process can serve; `connect` picks one by config.driverId */
  drivers: readonly Driver[]
  /** What to do once a shutdown request has been handled; by default nothing (the entry decides whether to exit) */
  onShutdown?: () => void
  /** Idle ceiling for a backpressure pause; defaults to IDLE_ACK_TIMEOUT_MS, lowered in tests */
  idleAckMs?: number
}

export class DriverHostRuntime {
  private readonly channel: HostChannel
  private readonly drivers: DriverRegistry
  private readonly onShutdown: (() => void) | undefined
  private readonly idleAckMs: number

  private session: DriverSession | null = null
  private port: HostDataPort | null = null
  /** Pumps waiting for the data-plane port. Each carries a reject: closing the host has to wake them all, never leave a promise dangling */
  private portWaiters: { resolve: (p: HostDataPort) => void; reject: (e: unknown) => void }[] = []
  private readonly pumps = new Map<ResultId, StreamPump>()
  private disposed = false

  constructor(channel: HostChannel, options: DriverHostRuntimeOptions) {
    this.channel = channel
    this.drivers = buildDriverRegistry(options.drivers)
    this.onShutdown = options.onShutdown
    this.idleAckMs = options.idleAckMs !== undefined && options.idleAckMs > 0
      ? options.idleAckMs
      : IDLE_ACK_TIMEOUT_MS
    channel.on('message', (event) => {
      void this.onMessage(event)
    })
    channel.start?.()
  }

  /* ---- Outbound ---- */

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

  /** Announce that the host is up and ready for requests */
  announceReady(pid: number): void {
    this.emit({ kind: 'evt', type: 'ready', pid })
  }

  sendStream(msg: ResultStreamMessage): void {
    this.port?.postMessage(msg)
  }

  /**
   * Wait for the data-plane port rather than dropping frames.
   * Every waiter must bring its own way out (StreamPump races against
   * stopSignal); closing the host rejects all waiters registered here.
   */
  waitPort(): Promise<HostDataPort> {
    if (this.port) return Promise.resolve(this.port)
    if (this.disposed) return Promise.reject(peekErrorMsg('CANCELLED', 'error.driver.hostClosed'))
    return new Promise<HostDataPort>((resolve, reject) => {
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

  /* ---- Inbound ---- */

  private async onMessage(event: HostChannelMessage): Promise<void> {
    const msg = asInbound(event.data)
    if (!msg) return
    if (msg.kind === 'attachPort') {
      const port = event.ports?.[0]
      if (port) this.attachPort(port)
      return
    }
    await this.handleRequest(msg)
  }

  private attachPort(port: HostDataPort): void {
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
    if (!this.session) throw peekErrorMsg('CONFLICT', 'error.driver.notConnected')
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
        if (!supportsIntrospect(session)) throw unsupported(session.driverId, 'introspect')
        return { nodes: await session.listChildren(req.params.parentId) }
      }

      case 'introspect.describe': {
        const session = this.requireSession()
        if (!supportsIntrospect(session)) throw unsupported(session.driverId, 'introspect')
        return { schema: await session.describeCollection(req.params.ref) }
      }

      case 'query.run': {
        const session = this.requireSession()
        if (!supportsTabularQuery(session)) throw unsupported(session.driverId, 'tabularQuery')
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
        if (!supportsCollectionScan(session)) throw unsupported(session.driverId, 'collectionScan')
        const p = req.params
        const cursor = await session.scan({
          resultId: p.resultId,
          ref: p.ref,
          ...(p.filter === undefined ? {} : { filter: p.filter }),
          ...(p.nativeFilter === undefined ? {} : { nativeFilter: p.nativeFilter }),
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

      case 'vector.search': {
        const session = this.requireSession()
        if (!supportsVectorSearch(session)) throw unsupported(session.driverId, 'vectorSearch')
        const p = req.params
        const cursor = await session.vectorSearch({
          resultId: p.resultId,
          collection: p.collection,
          topK: p.topK,
          ...(p.queryVec === undefined ? {} : { queryVec: p.queryVec }),
          ...(p.queryPointId === undefined ? {} : { queryPointId: p.queryPointId }),
          ...(p.vectorName === undefined ? {} : { vectorName: p.vectorName }),
          ...(p.filter === undefined ? {} : { filter: p.filter }),
          ...(p.nativeFilter === undefined ? {} : { nativeFilter: p.nativeFilter }),
          ...(p.scoreThreshold === undefined ? {} : { scoreThreshold: p.scoreThreshold }),
          ...(p.offset === undefined ? {} : { offset: p.offset }),
          ...(p.columns === undefined ? {} : { columns: p.columns }),
          ...(p.withVector === undefined ? {} : { withVector: p.withVector }),
          ...(p.withPayload === undefined ? {} : { withPayload: p.withPayload }),
          ...(p.timeoutMs === undefined ? {} : { timeoutMs: p.timeoutMs }),
        })
        this.startPump(p.resultId, cursor)
        return { resultId: p.resultId }
      }

      case 'keyvalue.get': {
        const session = this.requireSession()
        if (!supportsKeyValue(session)) throw unsupported(session.driverId, 'keyValue')
        const { ref, ...window } = req.params
        // The wire form is a flat bag; core validates it into the exclusive union
        // exactly here, at the process boundary, so an offset into a hash is a
        // BAD_REQUEST rather than a silently ignored field
        return { value: await session.getValue(ref, keyValueReadOptions(window)) }
      }

      case 'value.peek': {
        const session = this.requireSession()
        if (!supportsValuePeek(session)) throw unsupported(session.driverId, 'valuePeek')
        const { ref, offset, length } = req.params
        // offset and length are independently optional in HostRpcMap, while
        // ByteRange requires both: offset alone means "from here to the ceiling",
        // not "read zero bytes"
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
      const driver = this.drivers.get(config.driverId)
      if (!driver) {
        throw peekErrorMsg('BAD_REQUEST', 'error.conn.driverNotRegistered', {
          driverId: config.driverId,
        })
      }
      const controller = new AbortController()
      const timer =
        timeoutMs === undefined
          ? null
          : setTimeout(() => controller.abort(), Math.max(1, Math.trunc(timeoutMs)))
      try {
        const session = await driver.connect(config, controller.signal)
        this.assertSessionHonoursCapabilities(session)
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

  /**
   * A session advertising a capability it did not implement is caught here, at
   * connect time, rather than an hour later when a user clicks something.
   *
   * The capability table in `capability.ts` is a promise about which methods
   * exist; the `supports*` guards are how every caller reads it. A session that
   * lies makes those guards return false and the failure surfaces as
   * "the driver does not support X" — pointing at the wrong layer entirely.
   */
  private assertSessionHonoursCapabilities(session: DriverSession): void {
    const missing: Capability[] = []
    if (hasCapability(session, 'introspect') && !supportsIntrospect(session)) missing.push('introspect')
    if (hasCapability(session, 'tabularQuery') && !supportsTabularQuery(session)) missing.push('tabularQuery')
    if (hasCapability(session, 'collectionScan') && !supportsCollectionScan(session)) missing.push('collectionScan')
    if (hasCapability(session, 'keyValue') && !supportsKeyValue(session)) missing.push('keyValue')
    if (hasCapability(session, 'vectorSearch') && !supportsVectorSearch(session)) missing.push('vectorSearch')
    if (hasCapability(session, 'valuePeek') && !supportsValuePeek(session)) missing.push('valuePeek')
    if (hasCapability(session, 'cancel') && !supportsCancel(session)) missing.push('cancel')
    if (missing.length === 0) return
    // A wiring bug in a driver package, never something a user can act on:
    // plain English literal, no catalog key.
    throw peekError(
      'INTERNAL',
      `Driver ${session.driverId} advertises ${missing.join(', ')} but implements no matching method`,
    )
  }

  private startPump(resultId: ResultId, cursor: Cursor): void {
    const pump = new StreamPump(this, resultId, cursor, this.idleAckMs)
    this.pumps.set(resultId, pump)
    void pump.run()
  }

  /** Cancel a result set: have the driver actually interrupt the server statement first, then stop the pump */
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
    // The pumps are already stopped, so nothing will ever claim the waiters they
    // registered; clear them out too
    this.rejectPortWaiters(peekErrorMsg('CANCELLED', 'error.conn.closed'))
    const session = this.session
    this.session = null
    if (session) await session.close().catch(() => {})
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    // Wake the pumps still waiting for the data-plane port before tearing the
    // session down, or they hang — cursors and all — until the process exits
    this.rejectPortWaiters(peekErrorMsg('CANCELLED', 'error.driver.hostClosed'))
    await this.closeSession()
  }
}

export function createDriverHostRuntime(
  channel: HostChannel,
  options: DriverHostRuntimeOptions,
): DriverHostRuntime {
  return new DriverHostRuntime(channel, options)
}

/* ------------------------------------------------------------------ */
/* utilityProcess entry helper                                          */
/* ------------------------------------------------------------------ */

/**
 * The slice of node's `process` this file uses.
 *
 * Declared structurally rather than imported from `@types/node`, for the reason
 * in `unrefTimer`: core compiles with `types: []` because the renderer imports
 * it. Everything below reaches `process` through `globalThis`, so in a browser
 * bundle these functions are dead code that never touches an undefined global.
 */
interface HostProcess {
  readonly pid: number
  exit(code?: number): void
  on(event: string, listener: (arg: never) => void): void
}

function hostProcess(): HostProcess | null {
  const g = globalThis as unknown as Record<string, unknown>
  const proc = g['process']
  if (typeof proc !== 'object' || proc === null) return null
  const rec = proc as Record<string, unknown>
  if (typeof rec['on'] !== 'function' || typeof rec['exit'] !== 'function') return null
  return proc as unknown as HostProcess
}

/**
 * Pull `parentPort` off `process` structurally, without reaching for `any`.
 * Returns null outside a utilityProcess — including in the renderer, which
 * bundles core and has no `process` at all.
 */
function getParentPort(): HostChannel | null {
  const g = globalThis as unknown as Record<string, unknown>
  const proc = g['process']
  if (typeof proc !== 'object' || proc === null) return null
  const candidate = (proc as Record<string, unknown>)['parentPort']
  if (typeof candidate !== 'object' || candidate === null) return null
  const obj = candidate as Record<string, unknown>
  if (typeof obj['postMessage'] !== 'function' || typeof obj['on'] !== 'function') return null
  return candidate as unknown as HostChannel
}

export interface StartDriverHostOptions {
  drivers: readonly Driver[]
  idleAckMs?: number
}

/**
 * Attach to `process.parentPort` and start serving.
 *
 * This is the whole body of a driver-host entry file: the entry imports the
 * driver packages it wants to serve and hands them over. Everything
 * electron-specific stops at `parentPort` — a MessagePortMain that happens to
 * satisfy `HostChannel` structurally.
 */
export function startDriverHostProcess(options: StartDriverHostOptions): DriverHostRuntime {
  const parentPort = getParentPort()
  const proc = hostProcess()
  if (!parentPort || !proc) {
    throw new Error(
      'The driver host must run inside an Electron utilityProcess (process.parentPort is missing)',
    )
  }

  const host = createDriverHostRuntime(parentPort, {
    drivers: options.drivers,
    ...(options.idleAckMs === undefined ? {} : { idleAckMs: options.idleAckMs }),
    onShutdown: () => {
      // Let the event loop flush the final response before exiting
      setTimeout(() => proc.exit(0), 0)
    },
  })

  proc.on('uncaughtException', (err: Error) => {
    host.log('error', `Uncaught exception in the driver host: ${err.message}`, err.stack)
  })
  proc.on('unhandledRejection', (reason: unknown) => {
    const msg = reason instanceof Error ? reason.message : String(reason)
    host.log('error', `Unhandled promise rejection in the driver host: ${msg}`)
  })

  host.announceReady(proc.pid)
  return host
}
