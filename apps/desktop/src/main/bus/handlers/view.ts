import type { Draft } from 'immer'
import type {
  ViewActivateResult,
  ViewCloseResult,
  ViewPatch,
  ViewUpdateResult,
  ViewState,
} from '@peek/core'
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

      const affectsFetch = applyViewPatch(view, input.patch)
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
} satisfies CommandHandlerMap

/**
 * Apply an incremental patch by kind (the caller has already checked that the
 * kind matches the view). Returns whether any field that affects fetching changed.
 */
function applyViewPatch(view: Draft<ViewState>, patch: ViewPatch): boolean {
  if (patch.title !== undefined) view.title = patch.title

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
  }
}
