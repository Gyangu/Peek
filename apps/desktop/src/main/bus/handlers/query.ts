import type { Draft } from 'immer'
import type {
  CommandInput,
  QueryCancelResult,
  QueryRunResult,
  QueryViewState,
  ResultId,
  Workspace,
} from '@peek/core'
import { fail } from '../failure'
import type { CommandHandlerMap, ReduceCtx } from '../types'
import { openView, requireConnection, requireReadyWithCapability, requireView, startQuery } from './shared'

/**
 * query.* 的纯状态部分。
 * 真正的执行走 driver host：这里只分配 resultId、把视图置 loading、登记意图。
 * 结果 chunk 不经过 main（MessagePort 直连 renderer，PLAN 第 3 节）。
 */
export const queryHandlers = {
  'query.run': {
    reduce(draft, input, ctx) {
      const view = resolveQueryView(draft, input, ctx)

      if (input.text !== undefined) view.text = input.text
      if (view.text.trim() === '') fail('BAD_REQUEST', '查询语句为空')

      const conn = requireConnection(draft, view.connId)
      requireReadyWithCapability(conn, 'tabularQuery')

      const resultId = startQuery(draft, view, ctx, {
        ...(input.params ? { params: [...input.params] } : {}),
        ...(input.maxRows !== undefined ? { maxRows: input.maxRows } : {}),
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      })

      const result: QueryRunResult = { resultId, viewId: view.id }
      return result
    },
  },

  'query.cancel': {
    reduce(draft, input, ctx) {
      const resultId = resolveResultId(draft, input)
      const meta = draft.results[resultId]
      if (!meta) fail('NOT_FOUND', `结果集 ${resultId} 不存在`)

      // 已经结束的不再打扰驱动，直接如实回 false
      if (meta.status !== 'running') {
        const settled: QueryCancelResult = { resultId, cancelled: false }
        return settled
      }

      ctx.plan({ type: 'cancel', connId: meta.connId, resultId })
      const result: QueryCancelResult = { resultId, cancelled: true }
      return result
    },

    // reduce 里是"乐观地"回 true，驱动可能回"来不及取消了"，以真源最终状态为准。
    // 本来就没在跑的（reduce 已回 false）不要在这里被改回 true。
    finalize(data, state) {
      if (!data.cancelled) return data
      return { ...data, cancelled: state.results[data.resultId]?.status === 'cancelled' }
    },
  },
} satisfies CommandHandlerMap

/** 有 viewId 就在既有 query 视图里跑，否则按 connId + text 新开一个 */
function resolveQueryView(
  draft: Draft<Workspace>,
  input: CommandInput<'query.run'>,
  ctx: ReduceCtx,
): Draft<QueryViewState> {
  if (input.viewId !== undefined) {
    const view = requireView(draft, input.viewId)
    if (view.kind !== 'query') fail('BAD_REQUEST', `视图 ${input.viewId} 不是查询视图`)
    return view
  }

  // schema 的 refine 已保证：没有 viewId 时 connId 与 text 必然都在
  if (input.connId === undefined || input.text === undefined) {
    fail('BAD_REQUEST', '需要 viewId，或者 connId + text')
  }

  const opened = openView(draft, { kind: 'query', connId: input.connId, text: input.text }, ctx, {
    ...(input.panelId !== undefined ? { panelId: input.panelId } : {}),
  })
  const view = draft.views[opened.viewId]
  if (!view || view.kind !== 'query') fail('INTERNAL', '查询视图创建失败')
  return view
}

function resolveResultId(draft: Draft<Workspace>, input: CommandInput<'query.cancel'>): ResultId {
  if (input.resultId !== undefined) return input.resultId
  if (input.viewId === undefined) fail('BAD_REQUEST', '需要 resultId 或 viewId')
  const view = requireView(draft, input.viewId)
  const resultId = 'resultId' in view ? view.resultId : undefined
  if (resultId === undefined) fail('NOT_FOUND', `视图 ${input.viewId} 当前没有在跑的结果集`)
  return resultId
}
