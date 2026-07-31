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
 * Side-effect intents.
 *
 * A handler's **pure state phase only registers intents** (`ctx.plan(...)`) and
 * touches no I/O; once the state change has landed, the Command Bus hands the
 * batch to effects.ts. The payoff: handlers stay unit-testable pure functions,
 * and "actually connect / actually query" lives in exactly one place.
 *
 * Constraint: an intent may carry **plain data only**. Anything read off the
 * draft must go through `plain()` first — otherwise the draft proxy is revoked
 * when `produce` returns, and the effect phase blows up on first access.
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

/** The hook for registering a side-effect intent, injected into a handler's pure state phase. */
export type PlanEffect = (intent: EffectIntent) => void
