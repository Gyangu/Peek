import {
  ACK_WINDOW,
  VALUE_PEEK_MAX_BYTES,
  peekErrorMsg,
  supportsCancel,
  supportsCollectionScan,
  supportsIntrospect,
  supportsTabularQuery,
  supportsValuePeek,
  toPeekError,
  type ByteRange,
  type Capability,
  type ChunkFrame,
  type ConnectionConfig,
  type Cursor,
  type Driver,
  type DriverId,
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
 * Driver host runtime: speaks the driver host protocol defined in core/ipc.ts.
 *
 * The two planes stay strictly separate (PLAN section 3):
 * - control plane: main ↔ host over `channel`, RPC plus one-way events;
 * - data plane: host → renderer over the MessagePort handed across by
 *   attachPort, carrying chunks directly, with the renderer replying ack/cancel
 *   for backpressure.
 *
 * This file imports nothing from electron and runs on plain node (utilityProcess
 * is a node environment), which is also why the whole protocol can be exercised
 * end to end in node:test with an ordinary MessageChannel.
 */

/** UNSUPPORTED_CAPABILITY with the driver and capability spelled out */
function unsupported(driverId: DriverId, capability: Capability): PeekError {
  return peekErrorMsg('UNSUPPORTED_CAPABILITY', 'error.conn.unsupportedCapability', {
    driverId,
    capability,
  })
}

/* ------------------------------------------------------------------ */
/* Transport abstraction: only the methods actually used                */
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
/* Inbound message recognition                                          */
/* ------------------------------------------------------------------ */

const HOST_METHODS: ReadonlySet<string> = new Set<HostMethod>([
  'connect',
  'disconnect',
  'ping',
  'introspect.children',
  'introspect.describe',
  'query.run',
  'collection.scan',
  'vector.search',
  'keyvalue.get',
  'value.peek',
  'cancel',
  'shutdown',
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
 * cursor and give the server connection and its read-only transaction back.
 * Otherwise "paused" amounts to **holding server resources indefinitely**, which
 * on a production database blocks VACUUM (PLAN section 8).
 *
 * Packing up **ends in paused, not error**: nothing went wrong with the query and
 * every row already delivered is valid. This used to reject with a TIMEOUT
 * PeekError, which put a by-design pause in the same error branch as a real SQL
 * failure (a 42P01, say) — leaving an AI reading the MCP receipt unable to tell
 * "the query broke" from "it merely stopped".
 */
const IDLE_ACK_TIMEOUT_MS = 60_000

/** What waitWindow decided: keep producing frames, or pause by design */
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
  /**
   * Wall time spent parked — waiting for the data port, or for an ack. That is
   * the reader's pace, not the query's, and it is subtracted out before any
   * elapsed time reaches a reader (design 2026-08-25).
   */
  private stalledMs = 0
  /** Signal rejected by stop(), used to break awaits that never look at the stopped flag */
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

  /** Time `work` and bank it as stall: every await it wraps is a wait on the reader. */
  private async stall<T>(work: Promise<T>): Promise<T> {
    const parked = Date.now()
    try {
      return await work
    } finally {
      this.stalledMs += Date.now() - parked
    }
  }

  /**
   * A cursor's wall clock, less everything spent parked — the query's own time.
   *
   * Clamped at zero. The cursor's clock and this one are independent `Date.now()`
   * readings taken from different starting points, and a negative duration is
   * never the right thing to show anybody.
   */
  private queryMs(wallMs: number): number {
    return Math.max(0, wallMs - this.stalledMs)
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
      timer.unref()
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
      elapsedMs: this.queryMs(Date.now() - this.startedAt),
      reason: 'idleAck',
      // English literal on purpose: this text is written into workspace state and
      // read back by MCP, which stays English forever.
      message:
        `Result stream paused: no consumption ack for ${Math.round(this.idleAckMs / 1000)}s,` +
        ' the server-side cursor and connection have been released',
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
        // the cursor holds its connection and read-only transaction indefinitely.
        const port = await this.stall(Promise.race([this.host.waitPort(), this.stopSignal]))
        if ((await this.stall(this.waitWindow())) === 'paused') {
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

        // Both planes have to carry the same number, so the correction lands on the
        // frame *before* it is posted rather than only on the event emitted after.
        // A copy, not a mutation: the frame came from a driver package, and
        // overwriting a field it just set is how this pump would come to depend on
        // that package's internals.
        const outgoing: ChunkFrame = frame.done
          ? { ...frame, done: { ...frame.done, elapsedMs: this.queryMs(frame.done.elapsedMs) } }
          : frame

        const msg: ResultStreamMessage = { t: 'chunk', frame: outgoing }
        port.postMessage(msg)
        this.lastSentSeq = frame.seq
        this.unacked += 1
        this.rows += frame.rowCount

        if (outgoing.done) {
          this.host.emit({
            kind: 'evt',
            type: 'result.done',
            resultId: this.resultId,
            rows: outgoing.done.rows,
            elapsedMs: outgoing.done.elapsedMs,
            ...(outgoing.done.truncated === undefined ? {} : { truncated: outgoing.done.truncated }),
            ...(outgoing.done.nextCursor === undefined ? {} : { nextCursor: outgoing.done.nextCursor }),
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

export interface DriverHostOptions {
  /** Defaults to postgresDriver; tests substitute a fake */
  driver?: Driver
  /** What to do once a shutdown request has been handled; by default nothing (the entry decides whether to exit) */
  onShutdown?: () => void
  /** Idle ceiling for a backpressure pause; defaults to IDLE_ACK_TIMEOUT_MS, lowered in tests */
  idleAckMs?: number
}

export class DriverHost {
  private readonly channel: HostChannelLike
  private readonly driver: Driver
  private readonly onShutdown: (() => void) | undefined
  private readonly idleAckMs: number

  private session: DriverSession | null = null
  private port: HostPortLike | null = null
  /** Pumps waiting for the data-plane port. Each carries a reject: closing the host has to wake them all, never leave a promise dangling */
  private portWaiters: { resolve: (p: HostPortLike) => void; reject: (e: unknown) => void }[] = []
  private readonly pumps = new Map<ResultId, StreamPump>()
  private disposed = false

  constructor(channel: HostChannelLike, options: DriverHostOptions = {}) {
    this.channel = channel
    this.driver = options.driver ?? postgresDriver
    this.onShutdown = options.onShutdown
    this.idleAckMs =
      options.idleAckMs !== undefined && options.idleAckMs > 0 ? options.idleAckMs : IDLE_ACK_TIMEOUT_MS
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
  waitPort(): Promise<HostPortLike> {
    if (this.port) return Promise.resolve(this.port)
    if (this.disposed) return Promise.reject(peekErrorMsg('CANCELLED', 'error.driver.hostClosed'))
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

  /* ---- Inbound ---- */

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
        if (!supportsIntrospect(session)) {
          throw unsupported(session.driverId, 'introspect')
        }
        return { nodes: await session.listChildren(req.params.parentId) }
      }

      case 'introspect.describe': {
        const session = this.requireSession()
        if (!supportsIntrospect(session)) {
          throw unsupported(session.driverId, 'introspect')
        }
        return { schema: await session.describeCollection(req.params.ref) }
      }

      case 'query.run': {
        const session = this.requireSession()
        if (!supportsTabularQuery(session)) {
          throw unsupported(session.driverId, 'tabularQuery')
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
          throw unsupported(session.driverId, 'collectionScan')
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
        throw unsupported(this.driver.meta.id, 'vectorSearch')

      case 'keyvalue.get':
        throw unsupported(this.driver.meta.id, 'keyValue')

      case 'value.peek': {
        const session = this.requireSession()
        if (!supportsValuePeek(session)) {
          throw unsupported(session.driverId, 'valuePeek')
        }
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

  private async onConnect(config: ConnectionConfig, timeoutMs?: number): Promise<HostResult<'connect'>> {
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

export function createDriverHost(channel: HostChannelLike, options: DriverHostOptions = {}): DriverHost {
  return new DriverHost(channel, options)
}
