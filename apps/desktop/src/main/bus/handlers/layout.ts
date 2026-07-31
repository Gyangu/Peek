import type { Draft } from 'immer'
import { findPanel, type LayoutCloseResult, type ViewId, type Workspace } from '@peek/core'
import { plain } from '../../store/workspace-store'
import { ensureFocusedPanel } from '../../store/mutations'
import { fail } from '../failure'
import { closePanel, setSplitRatio, splitPanel } from '../layout-ops'
import type { CommandHandlerMap } from '../types'
import { closeView, openView } from './shared'

/**
 * layout.* 的纯状态实现。布局操作全部无副作用，
 * 是"AI 摆布局"这条链路上唯一会动的东西（PLAN 第 5 / 6 节）。
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
      if (!outcome) fail('NOT_FOUND', `面板 ${input.panelId} 不存在`)

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
        fail('NOT_FOUND', `面板 ${input.panelId} 不存在`)
      }
      draft.focusedPanel = input.panelId
      return { panelId: input.panelId }
    },
  },

  'layout.setRatio': {
    reduce(draft, input) {
      const outcome = setSplitRatio(plain(draft.layout), input.splitId, input.ratio)
      if (!outcome.ok) {
        if (outcome.reason === 'notFound') fail('NOT_FOUND', `split ${input.splitId} 不存在`)
        fail('BAD_REQUEST', `ratio 长度应为 ${outcome.expected}，收到 ${input.ratio.length}`)
      }
      draft.layout = outcome.layout as Draft<Workspace>['layout']
      return { splitId: input.splitId, ratio: outcome.ratio }
    },
  },

  'layout.close': {
    reduce(draft, input, ctx) {
      const outcome = closePanel(plain(draft.layout), input.panelId)
      if (!outcome) fail('NOT_FOUND', `面板 ${input.panelId} 不存在`)

      const closedViewIds: ViewId[] = []
      // 先删视图（会顺带取消在跑的结果集），再换上新布局：
      // closeView 内部也会改 layout，顺序反了会被覆盖掉
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
