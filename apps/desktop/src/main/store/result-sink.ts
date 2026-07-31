import type { ColumnDef, ConnId, ConnStatus, PeekError, ResultId } from '@peek/core'
import {
  failResult,
  finishResult,
  pauseResult,
  setConnectionStatus,
  setResultProgress,
  setResultSchema,
  type ConnectionReadyPatch,
  type ResultDonePatch,
  type ResultPausePatch,
} from './mutations'
import type { WorkspaceStore } from './workspace-store'

/**
 * The one place driver host events write back into the source of truth.
 *
 * The Connection Manager receives the host's HostEvents (result.schema /
 * progress / done / error / status) and calls these methods. Every state machine
 * transition reuses mutations.ts — there is no second implementation of "change
 * the state" outside the Command Bus, and there must never be one.
 *
 * Note: this is the **control plane** only. Result data itself never passes
 * through main.
 */
export interface ResultEventSink {
  onSchema(resultId: ResultId, schema: ColumnDef[]): void
  onProgress(resultId: ResultId, rows: number): void
  onDone(resultId: ResultId, done: ResultDonePatch): void
  /** Backpressure pause — not an error, see mutations.pauseResult */
  onPaused(resultId: ResultId, pause: ResultPausePatch): void
  onError(resultId: ResultId, error: PeekError): void
  onConnectionStatus(connId: ConnId, status: ConnStatus, patch?: ConnectionReadyPatch): void
}

export function createResultEventSink(store: WorkspaceStore): ResultEventSink {
  const meta = { source: 'system' as const }
  return {
    onSchema(resultId, schema) {
      store.apply((draft) => {
        setResultSchema(draft, resultId, schema)
      }, meta)
    },
    onProgress(resultId, rows) {
      store.apply((draft) => {
        setResultProgress(draft, resultId, rows)
      }, meta)
    },
    onDone(resultId, done) {
      store.apply((draft) => {
        finishResult(draft, resultId, done)
      }, meta)
    },
    onPaused(resultId, pause) {
      store.apply((draft) => {
        pauseResult(draft, resultId, pause)
      }, meta)
    },
    onError(resultId, error) {
      store.apply((draft) => {
        failResult(draft, resultId, error)
      }, meta)
    },
    onConnectionStatus(connId, status, patch) {
      store.apply((draft) => {
        setConnectionStatus(draft, connId, status, patch)
      }, meta)
    },
  }
}
