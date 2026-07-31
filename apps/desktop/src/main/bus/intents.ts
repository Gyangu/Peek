import type {
  CollectionRef,
  ConnId,
  ConnectionConfig,
  FilterSpec,
  ResultId,
  SortSpec,
  ViewId,
} from '@peek/core'

/**
 * 副作用意图。
 *
 * handler 的**纯状态阶段只登记意图**（`ctx.plan(...)`），不碰任何 I/O；
 * Command Bus 在状态落地之后统一交给 effects.ts 执行。
 * 好处：handler 全是可单测的纯函数，而"真正去连库/跑查询"集中在一处。
 *
 * 约束：意图里只能放**普通数据**。从 draft 上读出来的对象必须先过 `plain()`，
 * 否则 produce 结束后 draft 代理被吊销，执行阶段一访问就炸。
 */
export type EffectIntent =
  | { type: 'connect'; connId: ConnId; config: ConnectionConfig; timeoutMs?: number; soft?: boolean }
  | { type: 'disconnect'; connId: ConnId; soft?: boolean }
  | {
      type: 'runQuery'
      connId: ConnId
      viewId: ViewId
      resultId: ResultId
      text: string
      params?: unknown[]
      maxRows?: number
      timeoutMs?: number
      soft?: boolean
    }
  | {
      type: 'scan'
      connId: ConnId
      viewId: ViewId
      resultId: ResultId
      ref: CollectionRef
      filter?: FilterSpec[]
      sort?: SortSpec[]
      offset?: number
      limit?: number
      cursorToken?: string
      soft?: boolean
    }
  | {
      type: 'vectorSearch'
      connId: ConnId
      viewId: ViewId
      resultId: ResultId
      collection: string
      queryVec?: number[]
      topK: number
      filter?: FilterSpec[]
      soft?: boolean
    }
  | { type: 'cancel'; connId: ConnId; resultId: ResultId; soft?: boolean }

export type EffectIntentType = EffectIntent['type']

/** 登记副作用意图的口子，注入给 handler 的纯状态阶段 */
export type PlanEffect = (intent: EffectIntent) => void
