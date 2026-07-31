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
 * Command Bus 的副作用依赖接口。
 *
 * **bus 只认这个接口，绝不 import Connection Manager 的实现**——
 * 这样中枢可以脱离 Electron / 数据库单测，也不会和驱动侧的实现互相纠缠。
 * 由 main/index.ts 在装配时注入真实实现。
 *
 * 注意：这些方法**只负责把请求送到 driver host 并在被受理时 resolve**。
 * 结果数据不经过这里（chunk 由 driver host 通过 MessagePort 直发 renderer，
 * 见 PLAN 第 3 节），执行过程中的行数/收尾/报错通过 ResultEventSink 回填真源。
 */

export interface OpenConnectionRequest {
  connId: ConnId
  config: ConnectionConfig
  timeoutMs?: number
}

export interface OpenConnectionOutcome {
  /** 连上之后驱动实际声明的能力集（可能比 DRIVER_CAPABILITIES 更窄） */
  capabilities: Capability[]
  serverInfo?: ServerInfo
  /** driver host 的 utilityProcess pid，便于排查 */
  pid?: number
}

export interface ConnectionService {
  /** 建连；失败必须 reject（抛 PeekError 形状最好，否则由 bus 兜底收敛） */
  open(req: OpenConnectionRequest): Promise<OpenConnectionOutcome>
  /** 关连接并回收 driver host 进程；幂等 */
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
  /** 取消；目标本来就已结束时返回 false，不要抛错 */
  cancel(req: { connId: ConnId; resultId: ResultId }): Promise<boolean>
}

export interface CommandDeps {
  connections: ConnectionService
  results: ResultService
  /** 非状态类通知（toast、best-effort 副作用失败提示） */
  notify?(msg: NotifyMessage): void
}

/**
 * 占位实现：Connection Manager 还没接上时用。
 * 所有副作用一律回 INTERNAL，纯状态部分照常可跑（布局/视图命令完全可用）。
 */
export function createUnavailableDeps(reason = '连接管理器尚未接入'): CommandDeps {
  const boom = (): never => {
    throw new CommandFailure(peekError('INTERNAL', reason))
  }
  return {
    connections: {
      open: async () => boom(),
      close: async () => {
        // 没接入时关连接视为无事发生
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
