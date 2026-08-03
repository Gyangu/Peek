import type { Draft } from 'immer'
import { collectionBrowseStyle } from '@peek/core'
import type {
  ViewActivateResult,
  ViewCloseResult,
  ViewPatch,
  ViewPromoteResult,
  ViewUpdateResult,
  ViewState,
} from '@peek/core'
import { setAutoRefresh, setAutoRefreshOn } from '../../store/mutations'
import { plain } from '../../store/workspace-store'
import { failMsg } from '../failure'
import { activateViewInTree } from '../layout-ops'
import type { CommandHandlerMap } from '../types'
import { autoFetch, closeView, openView, requireView, writeLayout } from './shared'

/**
 * The pure state implementation of view.*.
 * In PLAN, "open a table", "change a filter" and "page through results" are all
 * view.* — which is why `update` is the hottest path here.
 */
export const viewHandlers = {
  'view.open': {
    reduce(draft, input, ctx) {
      return openView(draft, input.spec, ctx, {
        ...(input.panelId !== undefined ? { panelId: input.panelId } : {}),
        ...(input.replace !== undefined ? { replace: input.replace } : {}),
        ...(input.provisional !== undefined ? { provisional: input.provisional } : {}),
        ...(input.index !== undefined ? { index: input.index } : {}),
        ...(input.focus !== undefined ? { focus: input.focus } : {}),
        run: input.spec.kind === 'query' && input.spec.run === true,
      })
    },
  },

  'view.update': {
    reduce(draft, input, ctx) {
      const view = requireView(draft, input.viewId)
      if (view.kind !== input.patch.kind) {
        failMsg('BAD_REQUEST', 'error.view.kindMismatch', {
          viewId: input.viewId,
          actual: view.kind,
          expected: input.patch.kind,
        })
      }

      // Read before the patch is applied: "was this a page-forward?" is a
      // question about the state the gesture arrived in.
      const pagedForward = isCursorPageForward(view, input.patch)

      const affectsFetch = applyViewPatch(view, input.patch)
      if (pagedForward) setAutoRefresh(draft, view.id, null, 'paged')
      // Changing fetch parameters on a table / vector view refetches by default;
      // a query view needs an explicit query.run.
      const refresh = input.refresh ?? (affectsFetch && view.kind !== 'query')

      const result: ViewUpdateResult = { viewId: view.id }
      if (refresh) {
        const resultId = autoFetch(draft, view.id, ctx, true)
        if (resultId !== undefined) result.resultId = resultId
      }
      return result
    },
  },

  'view.close': {
    reduce(draft, input, ctx) {
      requireView(draft, input.viewId)
      const { panelId, activatedViewId } = closeView(draft, input.viewId, ctx)
      const result: ViewCloseResult = { viewId: input.viewId, panelId, activatedViewId }
      return result
    },
  },

  /**
   * Show a view that is already open — the tab bar's one irreducible operation.
   *
   * It is a Command rather than renderer-local state for the same reason
   * everything else here is: `activeViewId` lives on the layout tree, main owns
   * that tree, the renderer is a read-only mirror, and an AI that cannot reach
   * this cannot bring a hidden view to the front.
   *
   * A view that exists but sits in no panel is `NOT_FOUND` with its own message
   * rather than a silent no-op: "show this tab" has no meaning for a view that is
   * in no tab bar, and the fix (`layout.moveView`) is different from the fix for
   * a view that does not exist.
   */
  'view.activate': {
    reduce(draft, input) {
      requireView(draft, input.viewId)

      const outcome = activateViewInTree(plain(draft.layout), input.viewId)
      if (!outcome) failMsg('NOT_FOUND', 'error.view.notMounted', { viewId: input.viewId })

      // Identity-preserving: activating the tab that is already showing writes
      // nothing to the draft and broadcasts no patch.
      writeLayout(draft, outcome.layout)
      if (input.focusPanel !== false) draft.focusedPanel = outcome.panelId

      const result: ViewActivateResult = {
        viewId: input.viewId,
        panelId: outcome.panelId,
        previousViewId: outcome.previousViewId,
        focusedPanel: draft.focusedPanel,
      }
      return result
    },
  },

  /**
   * Keep a provisional view. See `ViewBase.provisional`.
   *
   * Not an error when the view was never provisional — every caller is a user
   * saying "I am using this", and that is already true of a kept view. The
   * result says which of the two happened so a caller that cares can tell.
   */
  'view.promote': {
    reduce(draft, input) {
      const view = requireView(draft, input.viewId)
      const promoted = view.provisional === true
      if (promoted) delete view.provisional
      const result: ViewPromoteResult = { viewId: input.viewId, promoted }
      return result
    },
  },
} satisfies CommandHandlerMap

/**
 * "This patch is the Next-page gesture on a cursor-paged collection."
 *
 * A cursor store only addresses forward, so the sole way to advance is to re-run
 * the scan with the token the last page handed back — which is a `view.update`
 * carrying *nothing but* its `kind`. That empty shape is what identifies the
 * gesture, and it is also exactly what auto-refresh must not do: `refreshPatch`
 * sends `offset: 0` on such a collection precisely so a refresh restarts the scan
 * instead of paging.
 *
 * So the two cannot coexist. Once the reader has walked to page four, a timer
 * that restarts the scan every five seconds would drag them back to page one, and
 * a timer that advanced instead would be a page-turner rather than a refresher.
 * Auto-refresh yields, with a reason the toolbar can show.
 *
 * It is decided here rather than in the button's click handler because PLAN §6's
 * rule is that a human and a model reach the same rules through the same command
 * — `move_view`-style tooling that pages a collection forward has to lose the
 * timer too.
 */
function isCursorPageForward(view: Draft<ViewState>, patch: ViewPatch): boolean {
  if (view.kind !== 'table' || patch.kind !== 'table') return false
  if (view.autoRefreshMs === undefined) return false
  if (view.cursorToken === undefined) return false
  if (collectionBrowseStyle(view.ref).offsetPaging) return false
  // Any field at all makes this something other than "give me the next page".
  return (
    patch.ref === undefined
    && patch.filter === undefined
    && patch.sort === undefined
    && patch.offset === undefined
    && patch.limit === undefined
    && patch.autoRefreshMs === undefined
    && patch.title === undefined
  )
}

/**
 * Apply an incremental patch by kind (the caller has already checked that the
 * kind matches the view). Returns whether any field that affects fetching changed.
 */
function applyViewPatch(view: Draft<ViewState>, patch: ViewPatch): boolean {
  if (patch.title !== undefined) view.title = patch.title
  // Auto-refresh is a property *of* the view, like its title, rather than of what
  // it shows — so it is written for every kind that can carry it, before the
  // per-kind switch, and it deliberately does not count as affecting the fetch:
  // switching the timer on does not mean "and fetch right now". The button next
  // to it means that.
  if ('autoRefreshMs' in patch && patch.autoRefreshMs !== undefined) {
    setAutoRefreshOn(view, patch.autoRefreshMs)
  }

  switch (patch.kind) {
    case 'table': {
      if (view.kind !== 'table') return false
      let affects = false
      let invalidatesCursor = false
      if (patch.ref) {
        view.ref = patch.ref
        affects = true
        invalidatesCursor = true
      }
      if (patch.filter) {
        view.filter = patch.filter
        affects = true
        invalidatesCursor = true
      }
      if (patch.sort) {
        view.sort = patch.sort
        affects = true
        invalidatesCursor = true
      }
      if (patch.offset !== undefined) {
        view.page.offset = patch.offset
        affects = true
        invalidatesCursor = true
      }
      if (patch.limit !== undefined) {
        view.page.limit = patch.limit
        affects = true
      }
      // The fetch conditions changed, so the old continuation cursor (redis SCAN
      // cursor / qdrant scroll) has to be invalidated.
      if (invalidatesCursor) delete view.cursorToken
      return affects
    }

    case 'query': {
      if (view.kind !== 'query') return false
      if (patch.text !== undefined) view.text = patch.text
      return false
    }

    case 'inspector': {
      if (view.kind !== 'inspector') return false
      if (patch.ref) view.ref = patch.ref
      return false
    }

    case 'tree': {
      if (view.kind !== 'tree') return false
      if (patch.expanded) view.expanded = patch.expanded
      if (patch.selected !== undefined) {
        if (patch.selected === null) delete view.selected
        else view.selected = patch.selected
      }
      return false
    }

    case 'vector': {
      if (view.kind !== 'vector') return false
      let affects = false
      if (patch.collection !== undefined) {
        view.collection = patch.collection
        affects = true
        // A different collection invalidates both the point reference and the
        // named vector: neither means anything in the new collection, and
        // carrying them over produces a confident search against nonsense.
        delete view.queryPointId
        delete view.vectorName
      }
      // The two query entry points are mutually exclusive (see VectorViewState):
      // writing one clears the other, so the view can never plan a search the
      // driver is contractually obliged to reject.
      if (patch.queryVec) {
        view.queryVec = patch.queryVec
        delete view.queryPointId
        affects = true
      }
      if (patch.queryPointId !== undefined) {
        view.queryPointId = patch.queryPointId
        delete view.queryVec
        affects = true
      }
      if (patch.queryText !== undefined) view.queryText = patch.queryText
      if (patch.vectorName !== undefined) {
        // null is "use the collection's default vector again", which is a
        // different request from leaving the field alone.
        if (patch.vectorName === null) delete view.vectorName
        else view.vectorName = patch.vectorName
        affects = true
      }
      if (patch.topK !== undefined) {
        view.topK = patch.topK
        affects = true
      }
      if (patch.scoreThreshold !== undefined) {
        if (patch.scoreThreshold === null) delete view.scoreThreshold
        else view.scoreThreshold = patch.scoreThreshold
        affects = true
      }
      if (patch.filter) {
        view.filter = patch.filter
        affects = true
      }
      return affects
    }

    /**
     * A chat has nothing patchable but its title, which `applyViewPatch` has
     * already written above. Every other field is either the agent's
     * (`agentSessionId`, `agentStatus`, `usage` — written by the stream, never by
     * a caller) or a transition with a side effect `view.update` cannot carry:
     * `chat.setMode` has to reach `session/set_mode`, `chat.respondPermission` has
     * to unblock a waiting JSON-RPC request.
     */
    case 'chat':
      return false

    /**
     * A plugin view's state is merged key by key, and every merge counts as
     * affecting the fetch.
     *
     * **Merged, not replaced**, for the same reason every built-in patch above is
     * a bag of per-field optionals: `{offset: 40}` has to move the page without
     * clearing the filter, and a caller forced to resend the whole state to
     * change one field would race with the user changing another.
     *
     * **`null` deletes.** A patch cannot express "remove this key" any other way,
     * and the built-in patches already use `null` for exactly that (the vector
     * view's `vectorName` and `scoreThreshold`).
     *
     * **`affects` is unconditionally true when anything changed**, unlike the
     * built-ins which know which of their fields feed a fetch. The kernel does
     * not know which of a plugin's keys matter, and the two possible mistakes are
     * not symmetric: over-fetching costs a redundant scan, under-fetching leaves
     * a view showing stale rows with nothing on screen to say so. The
     * registration's `autoFetch` is what decides whether that turns into a real
     * request — returning `null` there makes this free.
     */
    case 'plugin': {
      if (view.kind !== 'plugin') return false
      if (patch.state === undefined) return false
      const next: Record<string, unknown> = { ...view.state }
      let changed = false
      for (const [key, value] of Object.entries(patch.state)) {
        if (value === null) {
          if (key in next) {
            delete next[key]
            changed = true
          }
          continue
        }
        if (next[key] !== value) changed = true
        next[key] = value
      }
      if (!changed) return false
      view.state = next
      return true
    }
  }
}
