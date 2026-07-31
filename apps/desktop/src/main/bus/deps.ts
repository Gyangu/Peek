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
  queryVec?: number[]
  topK: number
  filter?: FilterSpec[]
}

export interface ResultService {
  runQuery(req: RunQueryRequest): Promise<void>
  scanCollection(req: ScanCollectionRequest): Promise<void>
  vectorSearch(req: VectorSearchRequest): Promise<void>
  /** Cancel. Returns false when the target had already finished — do not throw. */
  cancel(req: { connId: ConnId; resultId: ResultId }): Promise<boolean>
}

export interface CommandDeps {
  connections: ConnectionService
  results: ResultService
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
