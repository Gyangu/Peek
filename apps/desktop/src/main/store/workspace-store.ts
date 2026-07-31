import { current, enablePatches, isDraft, produceWithPatches, type Draft, type Patch } from 'immer'
import {
  createEmptyWorkspace,
  snapshotWorkspace,
  type CommandName,
  type CommandSource,
  type Workspace,
  type WorkspaceReader,
  type WorkspaceSnapshot,
} from '@peek/core'

// immer's patch plugin has to be enabled explicitly, or produceWithPatches yields no patches
enablePatches()

/* ================================================================== */
/* Change metadata and subscriptions                                   */
/* ================================================================== */

/** Provenance of one state change, forwarded verbatim to the renderer with the patches */
export interface StoreChangeMeta {
  commandId?: string
  commandName?: CommandName
  source?: CommandSource
}

export interface StoreChange extends StoreChangeMeta {
  /** The rev before the change */
  fromRev: number
  /** The rev after the change */
  rev: number
  patches: Patch[]
  inversePatches: Patch[]
}

export type StoreListener = (change: StoreChange, state: Workspace) => void

export type WorkspaceRecipe<T> = (draft: Draft<Workspace>) => T

/* ================================================================== */
/* Workspace Store — the single source of truth in the main process     */
/* ================================================================== */

/**
 * PLAN sections 3 and 5: main holds the source of truth, every change produces a
 * Patch[] through immer, and those patches are broadcast to the renderer mirror.
 *
 * - `getState()` is for use inside main (Connection Manager, driver host event
 *   write-back) and contains cleartext passwords.
 * - `getSnapshot()` is what MCP's read-only tools consume directly (zero
 *   renderer round trips); it is already redacted.
 * - Anything else leaving main must go through sanitize.ts's redactWorkspace /
 *   redactPatches.
 */
export class WorkspaceStore implements WorkspaceReader {
  #state: Workspace
  readonly #listeners = new Set<StoreListener>()

  constructor(initial?: Workspace) {
    this.#state = initial ?? createEmptyWorkspace()
  }

  /** The source of truth itself (immer has deep-frozen it, so callers cannot mutate it) */
  getState(): Workspace {
    return this.#state
  }

  /** Read-only snapshot for the outside world: configs redacted, views flattened (used by both state.read and MCP's read_workspace) */
  getSnapshot(): WorkspaceSnapshot {
    return snapshotWorkspace(this.#state)
  }

  get rev(): number {
    return this.#state.rev
  }

  subscribe(listener: StoreListener): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  /**
   * Land one pure state change. A throw inside the recipe voids the entire change
   * — immer discards the draft outright — which is what makes a command all or
   * nothing.
   */
  apply(recipe: WorkspaceRecipe<void>, meta: StoreChangeMeta = {}): StoreChange {
    return this.applyWith(recipe, meta).change
  }

  /** Same as apply, but also surfaces the recipe's return value (a command's pure state phase returns result data) */
  applyWith<T>(recipe: WorkspaceRecipe<T>, meta: StoreChangeMeta = {}): { change: StoreChange; value: T } {
    const fromRev = this.#state.rev
    let value!: T
    const [next, patches, inversePatches] = produceWithPatches(this.#state, (draft) => {
      value = recipe(draft)
      // Every landed change bumps rev by 1; the renderer relies on rev continuity
      // to detect dropped batches.
      draft.rev += 1
    })

    this.#state = next
    const change: StoreChange = { ...meta, fromRev, rev: next.rev, patches, inversePatches }
    for (const listener of this.#listeners) {
      // A misbehaving subscriber (patch broadcast, logging) must not fail the
      // command in return: the state has already landed.
      try {
        listener(change, next)
      } catch (error) {
        console.error('[peek/store] patch subscriber threw', error)
      }
    }
    return { change, value }
  }
}

/* ================================================================== */
/* Draft helpers                                                       */
/* ================================================================== */

/**
 * Turn a value that may be an immer draft into a plain object.
 *
 * **Required** whenever data read off a draft has to outlive `produce` — for
 * instance when it goes into a side-effect intent. Once produce returns, the
 * draft proxy is revoked and any later access throws.
 */
export function plain<T>(value: T): T {
  return isDraft(value) ? (current(value as Draft<T>) as T) : value
}
