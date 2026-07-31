import type { Draft } from 'immer'
import { findPanel, type LayoutCloseResult, type ViewId, type Workspace } from '@peek/core'
import { plain } from '../../store/workspace-store'
import { ensureFocusedPanel } from '../../store/mutations'
import { failMsg } from '../failure'
import { closePanel, setSplitRatio, splitPanel } from '../layout-ops'
import type { CommandHandlerMap } from '../types'
import { closeView, openView } from './shared'

/**
 * The pure state implementation of layout.*. Layout operations have no side
 * effects at all, and they are the only thing that moves along the "AI arranges
 * the workspace" path (PLAN sections 5 and 6).
 */
export const layoutHandlers = {
  'layout.split': {
    reduce(draft, input, ctx) {
      const outcome = splitPanel(plain(draft.layout), {
        panelId: input.panelId,
        dir: input.dir,
        ...(input.insert ? { insert: input.insert } : {}),
        ...(input.ratio ? { ratio: input.ratio } : {}),
        newPanelId: ctx.ids.panel(),
        newSplitId: ctx.ids.split(),
      })
      if (!outcome) failMsg('NOT_FOUND', 'error.panel.notFound', { panelId: input.panelId })

      draft.layout = outcome.layout as Draft<Workspace>['layout']
      draft.focusedPanel = outcome.panelId

      if (!input.view) return { splitId: outcome.splitId, panelId: outcome.panelId }

      const opened = openView(draft, input.view, ctx, { panelId: outcome.panelId })
      return { splitId: outcome.splitId, panelId: outcome.panelId, viewId: opened.viewId }
    },
  },

  'layout.focus': {
    reduce(draft, input) {
      if (!findPanel(plain(draft.layout), input.panelId)) {
        failMsg('NOT_FOUND', 'error.panel.notFound', { panelId: input.panelId })
      }
      draft.focusedPanel = input.panelId
      return { panelId: input.panelId }
    },
  },

  'layout.setRatio': {
    reduce(draft, input) {
      const outcome = setSplitRatio(plain(draft.layout), input.splitId, input.ratio)
      if (!outcome.ok) {
        if (outcome.reason === 'notFound') {
          failMsg('NOT_FOUND', 'error.layout.splitNotFound', { splitId: input.splitId })
        }
        // `expected` is always set on a lengthMismatch, but the type does not say
        // so; String() keeps the rendering identical either way.
        failMsg('BAD_REQUEST', 'error.layout.ratioLength', {
          expected: String(outcome.expected),
          actual: input.ratio.length,
        })
      }
      draft.layout = outcome.layout as Draft<Workspace>['layout']
      return { splitId: input.splitId, ratio: outcome.ratio }
    },
  },

  'layout.close': {
    reduce(draft, input, ctx) {
      const outcome = closePanel(plain(draft.layout), input.panelId)
      if (!outcome) failMsg('NOT_FOUND', 'error.panel.notFound', { panelId: input.panelId })

      const closedViewIds: ViewId[] = []
      // Remove the view first (which also cancels any running result set), then
      // install the new layout: closeView edits the layout too, so the reverse
      // order would overwrite its work.
      if (outcome.viewId !== null && input.closeView !== false) {
        closeView(draft, outcome.viewId, ctx)
        closedViewIds.push(outcome.viewId)
      }

      draft.layout = outcome.layout as Draft<Workspace>['layout']
      ensureFocusedPanel(draft)

      const result: LayoutCloseResult = { panelId: input.panelId, closedViewIds }
      return result
    },
  },
} satisfies CommandHandlerMap
