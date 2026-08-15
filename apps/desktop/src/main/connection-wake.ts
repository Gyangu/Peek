import {
  isRefreshableViewKind,
  type ConnId,
  type RefreshableView,
  type Workspace,
} from '@peek/core'
import type { CommandBus } from './bus'
import { refreshCommand } from './refresh-command'
import type { WorkspaceStore } from './store/workspace-store'

/**
 * When a connection comes up, fetch the views that were waiting for it.
 *
 * ## The gap this closes
 *
 * `autoFetch` (bus/handlers/shared.ts) already declines to fetch for a
 * connection that is not ready — the view stays `idle` and, in its own words,
 * "picks up on the next refresh". Nothing was that next refresh. Opening a table
 * against a connection that is still dialling left a permanently empty grid
 * until the user pressed something, and so did every view belonging to a
 * connection that dropped and came back.
 *
 * Restoring a workspace turns that from an edge case into the normal path:
 * `workspace-restore.ts` deliberately builds the layout on connections that are
 * still connecting, so *every* restored view is idle when it opens. This is what
 * fills them in.
 *
 * ## Why it watches state instead of hooking the connect effect
 *
 * The same reason `auto-refresh.ts` reconciles rather than tracking events: the
 * conditions ("is this connection up", "has this view fetched") are properties
 * of the state, several commands can change them, and reading the answer off the
 * state once per change is one rule instead of five. It also keeps the fetch a
 * Command — an effect cannot plan intents of its own, so a fetch started from
 * inside the connect effect would be a second, unaccounted-for way for a result
 * to begin.
 *
 * ## What it will not do
 *
 * - **Query views are never run.** `refreshCommand` maps a query view to
 *   `query.run`, and a restart must not execute the statement somebody left in
 *   an editor. The text comes back; pressing Run stays the user's move.
 * - **Only views that have never fetched.** `status === 'idle'` and no
 *   `resultId`: a view showing rows, an error, or a cancelled run is a view
 *   something already happened to, and re-running it behind the user's back
 *   would throw away what they were looking at.
 * - **Only on the transition.** A connection that is ready and stays ready is
 *   not a reason to fetch anything; the wake fires once per connect and once per
 *   reconnect.
 *
 * ## `readyAt`, not `status`, and this one cost a real bug
 *
 * A connection reaches `ready` in the workspace by **two** routes, and only one
 * of them means what this file needs it to mean:
 *
 *   1. the driver host emits a `status` event, which `wireConnectionEvents`
 *      forwards straight into the store — status only, no capabilities;
 *   2. `conn.open`'s effect returns, and `effects.ts` writes the status **with**
 *      the capability set the driver actually reported, and a `readyAt`.
 *
 * Route 1 lands first. In that window the connection reads `ready` while the
 * *connection manager's* own entry still has `capabilities: []`, because the
 * manager fills those in from the `connect` RPC's return value. Waking on the
 * status alone therefore fired a scan into that gap, and it came back
 * `UNSUPPORTED_CAPABILITY: Driver sqlite does not support collectionScan` — for
 * a driver that supports it, on a connection that was about to work. It
 * reproduced every time in `scripts/verify-workspace-restore.mjs`, because a
 * restored SQLite connection completes fast enough to land inside it.
 *
 * `readyAt` is written by route 2 and nothing else, so a **change** in it is
 * exactly "a handshake completed and its answers are in the store". A change
 * rather than mere presence: a reconnect leaves the previous `readyAt` in place
 * while it dials, so presence would let route 1 through again on the way back.
 */

export interface ConnectionWake {
  dispose(): void
}

export interface ConnectionWakeOptions {
  store: WorkspaceStore
  bus: CommandBus
}

export function createConnectionWake(options: ConnectionWakeOptions): ConnectionWake {
  const { store, bus } = options

  /**
   * The `readyAt` of the last settled handshake seen per connection, and
   * `undefined` for a connection that is not settled-ready right now. A change
   * is the transition; see the header for why this is not `ConnStatus`.
   */
  const seen = new Map<ConnId, number | undefined>()

  const sync = (state: Workspace, wake: boolean): void => {
    for (const key of [...seen.keys()]) {
      if (!(key in state.connections)) seen.delete(key)
    }
    for (const conn of Object.values(state.connections)) {
      const settledAt = conn.status === 'ready' ? conn.readyAt : undefined
      const before = seen.get(conn.id)
      seen.set(conn.id, settledAt)
      if (!wake) continue
      if (settledAt === undefined || settledAt === before) continue
      for (const view of idleViewsOf(state, conn.id)) {
        const command = refreshCommand(view)
        void bus.dispatch(command.name, command.input, 'system')
      }
    }
  }

  // The first pass only records. At construction every connection in the
  // workspace is one this process has not opened yet, and treating that as a
  // transition would fetch for views whose connections are still `connecting`.
  sync(store.getState(), false)

  const unsubscribe = store.subscribe((_change, state) => {
    sync(state, true)
  })

  return {
    dispose() {
      unsubscribe()
      seen.clear()
    },
  }
}

/**
 * Views on this connection that have never fetched.
 *
 * A query view is excluded here rather than at the dispatch, so that "what does
 * a wake do" is answerable by reading one function.
 */
function idleViewsOf(state: Workspace, connId: ConnId): RefreshableView[] {
  const out: RefreshableView[] = []
  for (const view of Object.values(state.views)) {
    if (!isRefreshableViewKind(view.kind)) continue
    const refreshable = view as RefreshableView
    if (refreshable.connId !== connId) continue
    if (refreshable.kind === 'query') continue
    if (refreshable.status !== 'idle' || refreshable.resultId !== undefined) continue
    out.push(refreshable)
  }
  return out
}
