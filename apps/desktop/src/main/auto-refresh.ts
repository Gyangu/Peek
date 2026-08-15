import {
  isRefreshableViewKind,
  type RefreshableView,
  type ResultId,
  type ViewId,
  type Workspace,
} from '@peek/core'
import type { CommandBus } from './bus'
import { refreshCommand, resultIdOf } from './refresh-command'
import { setAutoRefresh } from './store/mutations'
import type { WorkspaceStore } from './store/workspace-store'

/**
 * Auto-refresh: "fetch this view again every N seconds", DataGrip-style.
 *
 * ## Why the timer lives in main
 *
 * The interval itself is `RefreshableViewBase.autoRefreshMs` — ordinary view
 * state, in main's source of truth, visible to `read_workspace`. Putting the
 * timer anywhere else would give "is it on?" two answers, and the one property
 * this project exists to keep is that the human and the model look at the same
 * state.
 *
 * It also puts the timer where the two questions it has to ask are answered
 * authoritatively: *is a fetch already running for this view* (`runningResultOf`)
 * and *is the connection up* (`ConnectionState.status`). The renderer's mirror is
 * eventually consistent; a tick that read it could fire a second scan on top of
 * the first.
 *
 * ## What a tick is
 *
 * A chain of one-shot timers, not `setInterval`, and the interval is measured
 * **from tick to tick rather than from the end of the previous fetch**. When a
 * fetch outlives its interval the next tick finds a running result and skips —
 * so nothing piles up, and the effective rate degrades to a multiple of the
 * interval. That is the honest behaviour: a statement that takes twelve seconds
 * was never going to run on a five-second beat.
 *
 * (`isSettledResultStatus` counts `paused` as settled, which suits this exactly:
 * backpressure pausing a stream means the rows the viewport asked for have
 * arrived, and that is the moment a next round may begin.)
 *
 * ## What it deliberately does not do
 *
 * It does not stop while the window is hidden or the view's tab is in the
 * background. Watching something change while you do other work is most of the
 * point, and a tab is a layout fact, not a subscription.
 *
 * Design record: docs/design/2026-08-03-auto-refresh.md
 */

/** Failures in a row before a view turns its own timer off. */
export const AUTO_REFRESH_ERROR_LIMIT = 3

interface Tracked {
  timer: ReturnType<typeof setTimeout>
  /** The interval this timer was armed for; a change re-arms it. */
  intervalMs: number
  /** The result the last tick started, so the next one can grade it. */
  lastResultId: ResultId | null
  consecutiveErrors: number
}

export interface AutoRefreshScheduler {
  /** Number of views currently being ticked — for tests and for the status bar, if it ever wants it. */
  readonly size: number
  dispose(): void
}

export interface AutoRefreshOptions {
  store: WorkspaceStore
  bus: CommandBus
  /** Injectable for tests; defaults to the real timers. */
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void
}

export function createAutoRefreshScheduler(options: AutoRefreshOptions): AutoRefreshScheduler {
  const { store, bus } = options
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer =
    options.clearTimer ??
    ((handle) => {
      clearTimeout(handle)
    })

  const tracked = new Map<ViewId, Tracked>()

  const stop = (viewId: ViewId): void => {
    const entry = tracked.get(viewId)
    if (!entry) return
    clearTimer(entry.timer)
    tracked.delete(viewId)
  }

  const arm = (viewId: ViewId, intervalMs: number, carry: Omit<Tracked, 'timer' | 'intervalMs'>): void => {
    tracked.set(viewId, {
      ...carry,
      intervalMs,
      timer: setTimer(() => {
        tick(viewId)
      }, intervalMs),
    })
  }

  /**
   * One beat. Every exit that is not "this view is done with timers" re-arms, so
   * a skipped tick (disconnected, still fetching) is a pause rather than a stop —
   * reconnecting resumes on its own, which is what someone watching a flaky
   * server wants.
   */
  const tick = (viewId: ViewId): void => {
    const entry = tracked.get(viewId)
    if (!entry) return
    const state = store.getState()
    const view = refreshableView(state, viewId)
    if (!view || view.autoRefreshMs === undefined) {
      tracked.delete(viewId)
      return
    }

    const graded = gradeLastRound(state, entry)
    if (graded.consecutiveErrors >= AUTO_REFRESH_ERROR_LIMIT) {
      tracked.delete(viewId)
      store.apply(
        (draft) => {
          setAutoRefresh(draft, viewId, null, 'error')
        },
        { source: 'system' },
      )
      return
    }

    // A round that has not settled yet keeps its id, so the next tick grades it
    // instead of forgetting it; a graded one is dropped so it cannot be counted
    // twice.
    const next = {
      lastResultId: graded.consumed ? null : entry.lastResultId,
      consecutiveErrors: graded.consecutiveErrors,
    }

    if (canFetchNow(state, view)) {
      const command = refreshCommand(view)
      // The result id only exists once the command lands, and dispatch is async;
      // the entry is looked up again there because the view may be gone by then,
      // and because `arm` below will have replaced this one.
      void bus.dispatch(command.name, command.input, 'system').then((result) => {
        const live = tracked.get(viewId)
        if (!live) return
        live.lastResultId = result.ok ? resultIdOf(result.data) : null
      })
      next.lastResultId = null
    }

    arm(viewId, view.autoRefreshMs, next)
  }

  /**
   * Converge on the current state rather than tracking events.
   *
   * Seven or eight commands can start, stop or destroy a timer (`view.update`,
   * `view.close`, `conn.close`, `layout.close`, the scheduler's own give-up …).
   * Reading the answer off the state once per change is one rule instead of
   * eight, and it cannot drift from what `read_workspace` reports.
   */
  const reconcile = (state: Workspace): void => {
    for (const viewId of [...tracked.keys()]) {
      const view = refreshableView(state, viewId)
      if (!view || view.autoRefreshMs === undefined) stop(viewId)
    }
    for (const view of Object.values(state.views)) {
      if (!isRefreshableViewKind(view.kind)) continue
      const ms = (view as RefreshableView).autoRefreshMs
      if (ms === undefined) continue
      const entry = tracked.get(view.id)
      if (entry === undefined) {
        arm(view.id, ms, { lastResultId: null, consecutiveErrors: 0 })
      } else if (entry.intervalMs !== ms) {
        // A new interval restarts the clock rather than shortening the current
        // wait: "every 30 minutes" chosen 29 minutes in should not fire now.
        clearTimer(entry.timer)
        arm(view.id, ms, { lastResultId: entry.lastResultId, consecutiveErrors: entry.consecutiveErrors })
      }
    }
  }

  const unsubscribe = store.subscribe((_change, state) => {
    reconcile(state)
  })
  reconcile(store.getState())

  return {
    get size() {
      return tracked.size
    },
    dispose() {
      unsubscribe()
      for (const viewId of [...tracked.keys()]) stop(viewId)
    },
  }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function refreshableView(state: Workspace, viewId: ViewId): RefreshableView | null {
  const view = state.views[viewId]
  if (!view || !isRefreshableViewKind(view.kind)) return null
  return view as RefreshableView
}

/**
 * Whether this beat may fire at all.
 *
 * Both answers come from main's own state on purpose — see the note at the top
 * of the file about why the renderer's mirror is not good enough to gate a
 * second scan on.
 */
function canFetchNow(state: Workspace, view: RefreshableView): boolean {
  if (state.connections[view.connId]?.status !== 'ready') return false
  if (view.resultId !== undefined && state.results[view.resultId]?.status === 'running') return false
  // Nothing to run again. Not an error and not a reason to stop the timer: the
  // user may be part-way through typing the statement.
  if (view.kind === 'query' && view.text.trim() === '') return false
  return true
}

/**
 * Grade the round the previous tick started: how many failures in a row now, and
 * whether that round has been accounted for.
 *
 * `cancelled` counts as a failure. The two ways a refresh gets cancelled are the
 * deadline expiring and a person pressing Stop, and neither is an invitation to
 * try the same thing again in five seconds.
 *
 * A result that main has already evicted from `results` (the 200-entry cap) is
 * unreadable, so it is treated as consumed-and-clean rather than as a failure —
 * guessing "error" from missing metadata would switch the timer off for a
 * bookkeeping reason.
 */
function gradeLastRound(state: Workspace, entry: Tracked): { consecutiveErrors: number; consumed: boolean } {
  if (entry.lastResultId === null) return { consecutiveErrors: entry.consecutiveErrors, consumed: false }
  const status = state.results[entry.lastResultId]?.status
  if (status === 'running') return { consecutiveErrors: entry.consecutiveErrors, consumed: false }
  if (status === 'error' || status === 'cancelled') {
    return { consecutiveErrors: entry.consecutiveErrors + 1, consumed: true }
  }
  return { consecutiveErrors: 0, consumed: true }
}
