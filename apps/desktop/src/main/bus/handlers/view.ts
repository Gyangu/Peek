import type { Draft } from 'immer'
import type { ViewCloseResult, ViewPatch, ViewUpdateResult, ViewState } from '@peek/core'
import { fail } from '../failure'
import type { CommandHandlerMap } from '../types'
import { autoFetch, closeView, openView, requireView } from './shared'

/**
 * view.* 的纯状态实现。
 * "开表 / 改筛选 / 翻页"在 PLAN 里统统是 view.*，所以 update 才是最常走的路径。
 */
export const viewHandlers = {
  'view.open': {
    reduce(draft, input, ctx) {
      return openView(draft, input.spec, ctx, {
        ...(input.panelId !== undefined ? { panelId: input.panelId } : {}),
        ...(input.replace !== undefined ? { replace: input.replace } : {}),
        ...(input.focus !== undefined ? { focus: input.focus } : {}),
        run: input.spec.kind === 'query' && input.spec.run === true,
      })
    },
  },

  'view.update': {
    reduce(draft, input, ctx) {
      const view = requireView(draft, input.viewId)
      if (view.kind !== input.patch.kind) {
        fail('BAD_REQUEST', `视图 ${input.viewId} 是 ${view.kind}，不能用 ${input.patch.kind} 补丁更新`)
      }

      const affectsFetch = applyViewPatch(view, input.patch)
      // table / vector 改了取数参数就默认重取；query 视图要显式 query.run
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
      const panelId = closeView(draft, input.viewId, ctx)
      const result: ViewCloseResult = { viewId: input.viewId, panelId }
      return result
    },
  },
} satisfies CommandHandlerMap

/**
 * 按 kind 施加增量补丁（kind 已在外层校验过与视图一致）。
 * 返回是否动到了会影响取数结果的字段。
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
      // 换了取数条件，旧的续拉游标（redis SCAN cursor / qdrant scroll）必须作废
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
      }
      if (patch.queryVec) {
        view.queryVec = patch.queryVec
        affects = true
      }
      if (patch.queryText !== undefined) view.queryText = patch.queryText
      if (patch.topK !== undefined) {
        view.topK = patch.topK
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
