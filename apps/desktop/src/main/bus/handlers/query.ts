import type { Draft } from 'immer'
import type {
  CommandInput,
  QueryCancelResult,
  QueryRunResult,
  QueryViewState,
  ResultId,
  Workspace,
} from '@peek/core'
import { fail, failMsg } from '../failure'
import type { CommandHandlerMap, ReduceCtx } from '../types'
import { openView, requireConnection, requireReadyWithCapability, requireView, startQuery } from './shared'

/**
 * The pure state part of query.*.
 * Execution itself happens in the driver host; this file only allocates a
 * resultId, moves the view into loading, and registers the intent. Result chunks
 * never pass through main (MessagePort straight to the renderer, PLAN section 3).
 */
export const queryHandlers = {
  'query.run': {
    reduce(draft, input, ctx) {
      const view = resolveQueryView(draft, input, ctx)

      if (input.text !== undefined) view.text = input.text
      if (view.text.trim() === '') failMsg('BAD_REQUEST', 'error.query.emptyText')

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
      if (!meta) failMsg('NOT_FOUND', 'error.result.notFound', { resultId })

      // Already finished: do not disturb the driver, just report false honestly.
      if (meta.status !== 'running') {
        const settled: QueryCancelResult = { resultId, cancelled: false }
        return settled
      }

      ctx.plan({ type: 'cancel', connId: meta.connId, resultId })
      const result: QueryCancelResult = { resultId, cancelled: true }
      return result
    },

    // reduce answers optimistically with true; the driver may come back with
    // "too late to cancel", and the source of truth has the final say. Something
    // that was never running (reduce already said false) must not flip to true here.
    finalize(data, state) {
      if (!data.cancelled) return data
      return { ...data, cancelled: state.results[data.resultId]?.status === 'cancelled' }
    },
  },
} satisfies CommandHandlerMap

/** With a viewId, run inside that existing query view; otherwise open a new one from connId + text. */
function resolveQueryView(
  draft: Draft<Workspace>,
  input: CommandInput<'query.run'>,
  ctx: ReduceCtx,
): Draft<QueryViewState> {
  if (input.viewId !== undefined) {
    const view = requireView(draft, input.viewId)
    if (view.kind !== 'query') failMsg('BAD_REQUEST', 'error.view.notQuery', { viewId: input.viewId })
    assertConnMatches(view, input)
    return view
  }

  // The schema's refine already guarantees connId and text are both present
  // whenever viewId is absent.
  if (input.connId === undefined || input.text === undefined) {
    failMsg('BAD_REQUEST', 'error.query.needViewOrConn')
  }

  const opened = openView(draft, { kind: 'query', connId: input.connId, text: input.text }, ctx, {
    ...(input.panelId !== undefined ? { panelId: input.panelId } : {}),
  })
  const view = draft.views[opened.viewId]
  if (!view || view.kind !== 'query') failMsg('INTERNAL', 'error.view.createFailed')
  return view
}

/**
 * A viewId and a connId that name different databases is a contradiction, not a
 * hint — refuse it.
 *
 * `QueryRunInputSchema`'s refine only asks for "a viewId, or connId together with
 * text", so both may arrive together, and the old reading was that the view won:
 * `connId` was read only on the branch that opens a new view, and was otherwise
 * dropped without a word. "Run this statement on MySQL, in that panel" therefore
 * executed on the panel's PostgreSQL connection and came back `status done · 1
 * rows`, with the view still bound to postgres and nothing anywhere saying which
 * server had answered. There is no reading of the request under which that is the
 * right result, and a wrong answer that looks right is the worst shape a failure
 * can take for an agent, which will quote the rows as fact.
 *
 * Refusing rather than rebinding: the view carries a connection, a schema, a
 * result set and a cursor that all belong to the database it was opened on, and
 * silently moving it to another one trades this bug for a subtler one. The caller
 * knows which of the two it meant; it just has to say so.
 *
 * English literal rather than a message key on purpose. The renderer only ever
 * dispatches `{ viewId, text }` (`views/QueryView.tsx`), so nothing a human
 * clicks can produce this — the only caller that can is an MCP client, whose
 * surface is English forever. (If it ever becomes reachable from the UI, the fix
 * is an `error.query.*` key in `@peek/core`, not a translation here.)
 */
function assertConnMatches(
  view: Draft<QueryViewState>,
  input: CommandInput<'query.run'>,
): void {
  if (input.connId === undefined || input.connId === view.connId) return
  fail(
    'BAD_REQUEST',
    `View ${input.viewId} runs on connection ${view.connId}, not ${input.connId}.`
    + ' Drop connId to run the statement in that view, or drop viewId to open a new'
    + ' query view on that connection.',
  )
}

function resolveResultId(draft: Draft<Workspace>, input: CommandInput<'query.cancel'>): ResultId {
  if (input.resultId !== undefined) return input.resultId
  if (input.viewId === undefined) failMsg('BAD_REQUEST', 'error.query.needResultOrView')
  const view = requireView(draft, input.viewId)
  const resultId = 'resultId' in view ? view.resultId : undefined
  if (resultId === undefined) {
    failMsg('NOT_FOUND', 'error.query.noRunningResult', { viewId: input.viewId })
  }
  return resultId
}
