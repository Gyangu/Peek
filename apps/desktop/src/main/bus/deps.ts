import { peekError } from '@peek/core'
import type {
  Capability,
  CollectionRef,
  ConnId,
  ConnectionConfig,
  FilterSpec,
  NotifyMessage,
  ResultId,
  ServerInfo,
  SortSpec,
  ViewId,
} from '@peek/core'
import { CommandFailure } from './failure'

/**
 * The Command Bus's side-effect dependency interface.
 *
 * **The bus knows only this interface and never imports the Connection Manager
 * implementation** — that is what lets the hub be unit-tested without Electron
 * or a database, and keeps it from getting tangled up with the driver side.
 * main/index.ts injects the real implementation during assembly.
 *
 * Note: these methods **only deliver the request to the driver host and resolve
 * once it has been accepted**. Result data does not pass through here (the
 * driver host sends chunks straight to the renderer over a MessagePort — PLAN
 * section 3); row counts, completion and errors flow back into the source of
 * truth through the ResultEventSink.
 */

export interface OpenConnectionRequest {
  connId: ConnId
  config: ConnectionConfig
  timeoutMs?: number
}

export interface OpenConnectionOutcome {
  /** The capability set the driver actually reports once connected (may be narrower than DRIVER_CAPABILITIES) */
  capabilities: Capability[]
  serverInfo?: ServerInfo
  /** The driver host's utilityProcess pid, for troubleshooting */
  pid?: number
}

export interface ConnectionService {
  /** Open a connection. Failures must reject — ideally with a PeekError shape, otherwise the bus collapses it. */
  open(req: OpenConnectionRequest): Promise<OpenConnectionOutcome>
  /** Close the connection and reclaim the driver host process. Idempotent. */
  close(connId: ConnId): Promise<void>
}

/**
 * The three strings that name a connection, as the owning package computes them.
 *
 * The same triple `DriverDisplay` declares, and the reason it is a service here
 * rather than a function call is process boundaries: the package's code runs in
 * its own host now (design §2.4bis), so naming a connection is asynchronous, and
 * the bus reaches it the way it reaches every other side effect.
 */
export interface ConnectionDisplayService {
  /** The config must already be redacted; see `EffectIntent['describeConnection']`. */
  describe(req: { config: ConnectionConfig }): Promise<{ label: string; detail: string; endpoint: string }>
}

export interface RunQueryRequest {
  connId: ConnId
  viewId: ViewId
  resultId: ResultId
  text: string
  params?: unknown[]
  maxRows?: number
  timeoutMs?: number
}

export interface ScanCollectionRequest {
  connId: ConnId
  viewId: ViewId
  resultId: ResultId
  ref: CollectionRef
  filter?: FilterSpec[]
  sort?: SortSpec[]
  offset?: number
  limit?: number
  cursorToken?: string
}

export interface VectorSearchRequest {
  connId: ConnId
  viewId: ViewId
  resultId: ResultId
  collection: string
  /** Exactly one of queryVec / queryPointId reaches the driver (core's VectorSearchRequest) */
  queryVec?: number[]
  queryPointId?: string | number
  /** Which named vector to search; omitted means the collection's default one */
  vectorName?: string
  topK: number
  scoreThreshold?: number
  filter?: FilterSpec[]
}

export interface ResultService {
  runQuery(req: RunQueryRequest): Promise<void>
  scanCollection(req: ScanCollectionRequest): Promise<void>
  vectorSearch(req: VectorSearchRequest): Promise<void>
  /** Cancel. Returns false when the target had already finished — do not throw. */
  cancel(req: { connId: ConnId; resultId: ResultId }): Promise<boolean>
}

/**
 * The disk side of `packages.uninstall`.
 *
 * Narrow on purpose — one method, and not the install path. Installing changes
 * no Workspace state, so its handler does the work directly (a `read` handler
 * may do I/O, as every `config/handlers.ts` entry does); uninstalling closes
 * connections first, which means a reducer, which means the rest has to arrive
 * here as an intent like every other side effect.
 */
export interface PackageAdminService {
  /**
   * Kill the package's host, delete its directory, tombstone it if peek ships
   * one under that id, then re-read the packages root and tell everybody.
   *
   * Rejects when the directory could not be removed. That is not a courtesy
   * failure: reporting success would tell the caller a database is gone while
   * its `driver.mjs` is still on disk and will be registered again at the next
   * launch.
   */
  uninstall(req: { packageId: string; version: string }): Promise<void>
}

export interface CommandDeps {
  connections: ConnectionService
  results: ResultService
  /**
   * Optional, unlike the two above, because a peek with no package hosts is still
   * a working peek: every connection keeps the placeholder the reducer seeded and
   * nothing else degrades. The two above have no such fallback — without them a
   * connection cannot be opened at all.
   */
  display?: ConnectionDisplayService
  /**
   * Optional for the same reason `display` is: a bus assembled without one is a
   * peek that cannot uninstall a package, which is a smaller thing than a peek
   * that cannot open a connection. Unlike `display`, its absence is **not**
   * degraded silently — see the `uninstallPackage` case in effects.ts.
   */
  packages?: PackageAdminService
  /** Non-state notifications (toasts, warnings about best-effort side effects that failed) */
  notify?(msg: NotifyMessage): void
}

/**
 * Placeholder implementation, used before the Connection Manager is wired up.
 * Every side effect fails with INTERNAL while the pure state phase keeps working,
 * so layout and view commands remain fully usable.
 */
export function createUnavailableDeps(reason = 'The connection manager is not wired up yet'): CommandDeps {
  const boom = (): never => {
    throw new CommandFailure(peekError('INTERNAL', reason))
  }
  return {
    connections: {
      open: async () => boom(),
      close: async () => {
        // Nothing is wired up, so closing a connection is a no-op
      },
    },
    results: {
      runQuery: async () => boom(),
      scanCollection: async () => boom(),
      vectorSearch: async () => boom(),
      cancel: async () => false,
    },
  }
}
