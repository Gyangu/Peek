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
  | {
      type: 'describeConnection'
      connId: ConnId
      /**
       * **Already redacted.** The three display strings are derived from the
       * redacted config (a label built from a raw URL carries the password into
       * the sidebar), and this intent is also the one that leaves main: it is
       * answered by the package's own code in another process.
       */
      config: ConnectionConfig
      soft?: boolean
    }
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
      /** Exactly one of queryVec / queryPointId; the view state keeps them exclusive */
      queryVec?: number[]
      queryPointId?: string | number
      /** Which named vector to search; omitted means the collection's default one */
      vectorName?: string
      topK: number
      scoreThreshold?: number
      filter?: FilterSpec[]
      soft?: boolean
    }
  | { type: 'cancel'; connId: ConnId; resultId: ResultId; soft?: boolean }
  /**
   * Take a package off the disk, after `packages.uninstall` has closed
   * everything that was pointing at it.
   *
   * An intent rather than work the reducer does, for the ordinary reason: a
   * reducer runs inside `produce` and this deletes a directory, kills a host
   * process and re-reads the packages root. It is planned **after** the
   * `disconnect` intents for that package's connections, and intents run in
   * order — so every driver-host process is already winding down before the
   * `driver.mjs` it loaded is removed from underneath it.
   *
   * `version` travels with it because the tombstone records which build of a
   * bundled package the user threw away (§2.5), and by the time the effect runs
   * the registry that knew it has been asked to forget it.
   */
  | { type: 'uninstallPackage'; packageId: string; version: string; soft?: boolean }

export type EffectIntentType = EffectIntent['type']

/** The hook for registering a side-effect intent, injected into a handler's pure state phase. */
export type PlanEffect = (intent: EffectIntent) => void
