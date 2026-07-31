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
 * driver host 事件 → 真源的回填口。
 *
 * driver host 的 HostEvent（result.schema / progress / done / error / status）
 * 由 Connection Manager 收下后调这些方法，状态机迁移全部复用 mutations.ts，
 * 不需要也不允许绕过 Command Bus 之外再写一套改状态的逻辑。
 *
 * 注意：这里只走**控制面**。结果数据本体永远不经过 main。
 */
export interface ResultEventSink {
  onSchema(resultId: ResultId, schema: ColumnDef[]): void
  onProgress(resultId: ResultId, rows: number): void
  onDone(resultId: ResultId, done: ResultDonePatch): void
  /** 背压暂停（不是错误，见 mutations.pauseResult） */
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
