import type {
  Capability,
  CollectionRef,
  CollectionSchemaInfo,
  ColumnDef,
  ConnId,
  ConnStatus,
  ConnectionConfig,
  DriverId,
  HostParams,
  HostResult,
  KeyValueResult,
  KeyValueWindow,
  NamespaceNode,
  NotifyLevel,
  PeekError,
  PeekedValue,
  ResultId,
  ResultPause,
  ServerInfo,
  ValueRef,
} from '@peek/core'
import type { DeadlineTimerApi } from './deadline'
import type { Timeouts } from './timeouts'

/* ================================================================== */
/* 1. Runtime view of a connection (internal to main, never in Workspace) */
/* ================================================================== */

/**
 * The runtime record the Connection Manager keeps for itself.
 * `ConnectionState` in the Workspace is the **source of truth** and is owned by
 * the Command Bus; this is only the process-side mirror, which pushes its
 * changes to the bus through events.
 */
export interface ConnectionRuntime {
  connId: ConnId
  driverId: DriverId
  /**
   * There is deliberately **no `label`** here any more.
   *
   * The mirror used to carry one, derived from the config by a second call to a
   * second copy of the naming rules. A connection is named exactly once now,
   * when `conn.open` reduces, and the name is stored on `ConnectionState` — so a
   * label on the mirror could only ever be a value that agrees with the source
   * of truth until the day it does not. Nothing read it.
   */
  status: ConnStatus
  /** The real capability set, filled in by the host once ready */
  capabilities: Capability[]
  serverInfo?: ServerInfo
  error?: PeekError
  /** The driver host's utilityProcess pid */
  pid?: number
  readyAt?: number
  /** Result sets currently streaming (used to fail them all on a crash, and to clean up on disconnect) */
  activeResults: ResultId[]
}

/* ================================================================== */
/* 2. The side-effect interface (injected into the Command Bus)         */
/* ================================================================== */

export interface ConnectOptions {
  /** Reuse an existing connection id (reconnect); a new one is minted when absent */
  connId?: ConnId
  /** Override the connect timeout; falls back to config.connectTimeoutMs or the default */
  timeoutMs?: number
}

export interface ConnectOutcome {
  connId: ConnId
  /** The capability set the driver actually reports once connected */
  capabilities: Capability[]
  serverInfo?: ServerInfo
  pid?: number
}

export interface CancelOutcome {
  /** The target really was cancelled (false when it had already finished) */
  cancelled: boolean
  /** Whether this went down the "forced cancel = kill the process" path (PLAN section 3) */
  killed: boolean
}

/** The return value of starting a streaming fetch (query / scan / vectorSearch) */
export interface StartResultOutcome {
  resultId: ResultId
}

/**
 * The side-effect interface the Connection Manager exposes to the Command Bus.
 *
 * Conventions:
 * - **Every method rejects with a PeekError shape**, never an Error instance, so
 *   callers can simply apply `toPeekError(e)` (core's version returns a PeekError
 *   unchanged).
 * - query/scan/vectorSearch return only a resultId; **data frames bypass main**
 *   and go from the driver host straight to the renderer over a MessagePort
 *   (PLAN section 3).
 * - Parameter shapes match `HostRpcMap` in `@peek/core` exactly, so neither side
 *   has to restate them.
 */
export interface ConnectionEffects {
  /** Connect: spawn the utilityProcess → ready handshake → connect RPC */
  connect(config: ConnectionConfig, options?: ConnectOptions): Promise<ConnectOutcome>

  /** Disconnect gracefully and reclaim the process; returns silently when the connection does not exist */
  disconnect(connId: ConnId): Promise<void>

  /** Lazy loading of the namespace tree; a null parentId fetches the root level */
  introspect(connId: ConnId, parentId: string | null, refresh?: boolean): Promise<NamespaceNode[]>

  /** Structural description of a collection (column definitions, primary key, estimated row count) */
  describeCollection(connId: ConnId, ref: CollectionRef): Promise<CollectionSchemaInfo>

  /** Start an ad-hoc query; returns a resultId */
  runQuery(connId: ConnId, params: HostParams<'query.run'>): Promise<StartResultOutcome>

  /** Start a collection scan; returns a resultId */
  scan(connId: ConnId, params: HostParams<'collection.scan'>): Promise<StartResultOutcome>

  /** Start a vector search; returns a resultId */
  vectorSearch(connId: ConnId, params: HostParams<'vector.search'>): Promise<StartResultOutcome>

  /**
   * Fetch a typed value by key (the redis inspector).
   * `window` pages a large structure; omitted asks the driver for its default
   * first window (see KeyValueReadOptions).
   */
  getValue(connId: ConnId, ref: ValueRef, window?: KeyValueWindow): Promise<KeyValueResult>

  /** Fetch a large value in full, on demand */
  peekValue(
    connId: ConnId,
    ref: ValueRef,
    range?: { offset?: number; length?: number },
  ): Promise<PeekedValue>

  /**
   * Cancel a result set.
   * Tries the driver's cooperative cancel first; on timeout, or when the driver
   * does not support it, **escalates to killing the process** (PLAN section 3).
   */
  cancel(connId: ConnId, resultId: ResultId, options?: { force?: boolean }): Promise<CancelOutcome>

  /** Health check */
  ping(connId: ConnId): Promise<HostResult<'ping'>>

  /** Read-only: one connection's current runtime state */
  getRuntime(connId: ConnId): ConnectionRuntime | null

  /** Read-only: every connection */
  listRuntimes(): ConnectionRuntime[]

  /** Read-only: whether a connection has a capability (once connected, the driver's own declaration wins) */
  hasCapability(connId: ConnId, capability: Capability): boolean
}

/* ================================================================== */
/* 3. Event table (Connection Manager → Command Bus / notifications)    */
/* ================================================================== */

export interface ResultDoneInfo {
  rows: number
  elapsedMs: number
  truncated?: boolean
  nextCursor?: string
}

/**
 * Events emitted by the Connection Manager.
 * The Command Bus subscribes to status / result.* and writes the changes back
 * into the Workspace source of truth, broadcasting patches; the notification
 * layer subscribes to log / crashed and raises toasts.
 */
export interface ConnectionEventMap extends Record<string, unknown> {
  /** Connection state machine transition (idle → connecting → ready / error) */
  status: { connId: ConnId; status: ConnStatus; error?: PeekError; pid?: number }
  /** The first frame's schema arrived; main uses it to fill in ResultMeta.schema */
  'result.schema': { connId: ConnId; resultId: ResultId; schema: ColumnDef[] }
  /** The result set finished normally */
  'result.done': { connId: ConnId; resultId: ResultId; info: ResultDoneInfo }
  /** The result set paused by design (backpressure idle timeout) — **not an error**; every row already emitted is valid */
  'result.paused': { connId: ConnId; resultId: ResultId; paused: ResultPause }
  /** The result set terminated abnormally */
  'result.error': { connId: ConnId; resultId: ResultId; error: PeekError }
  /** Row-count heartbeat for long-running queries */
  'result.progress': { connId: ConnId; resultId: ResultId; rows: number }
  /** Driver host logs (including forwarded stdout/stderr) */
  log: { connId: ConnId; level: NotifyLevel; message: string; detail?: string }
  /** The driver host exited unexpectedly: the process has been reaped and the connection is unusable */
  crashed: { connId: ConnId; error: PeekError; code: number; expected: boolean }
  /** The data-plane port has been handed to the renderer (for troubleshooting) */
  'port.attached': { connId: ConnId; pid?: number }
}

/* ================================================================== */
/* 4. Manager construction options                                     */
/* ================================================================== */

export interface ConnectionManagerOptions {
  /**
   * Directory holding the driver host build output. Defaults to the directory of
   * the main bundle itself (out/main).
   *
   * Passing it here is the *explicit* form and is taken as given — a caller that
   * names a directory has already decided. The environment variable
   * `PEEK_DRIVER_HOST_DIR` is the other form, and it is checked rather than
   * trusted; see `resolveHostDir` in `./manager` and `allowHostDirOverride`
   * below.
   */
  hostDir?: string
  /**
   * Whether `PEEK_DRIVER_HOST_DIR` may relocate the driver host at all.
   *
   * `main/index.ts` passes `!app.isPackaged`, so a shipped peek ignores the
   * variable outright: nothing in a packaged build needs to load its own bundle
   * from somewhere else, and the driver host is the process that receives
   * unredacted passwords. Defaults to **false** — a caller that has not thought
   * about it gets the safe answer, and every existing test passes `hostDir`
   * explicitly anyway.
   */
  allowHostDirOverride?: boolean
  /** Override the per-stage timeouts */
  timeouts?: Partial<Timeouts>
  /** Turn the driver host's stdout/stderr into log events (default true) */
  forwardStdio?: boolean
  /**
   * Timer functions for whole-fetch deadlines. Real timers by default; injected
   * only by tests, which have to drive an expiry without waiting out the budget.
   */
  timers?: DeadlineTimerApi
}
