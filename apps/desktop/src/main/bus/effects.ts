import type { Draft } from 'immer'
import { hasUsableRows, isSettledResultStatus } from '@peek/core'
import type {
  CommandName,
  CommandSource,
  PeekErrorCode,
  ResultId,
  ViewId,
  ViewState,
  Workspace,
} from '@peek/core'
import { failResult, cancelResult, setConnectionStatus } from '../store/mutations'
import type { WorkspaceStore } from '../store/workspace-store'
import type { CommandDeps } from './deps'
import { CommandFailure, asPeekError } from './failure'
import type { EffectIntent } from './intents'

/**
 * The side-effect phase.
 *
 * Intents registered during the pure state phase run here in order, all of them
 * leaving through the injected CommandDeps — the bus knows neither the
 * Connection Manager nor any driver. State changes produced along the way
 * (connected / failed / cancelled) go back through store.apply, which is how the
 * renderer sees the connecting → ready transition live.
 */

export interface EffectRunnerCtx {
  store: WorkspaceStore
  deps: CommandDeps
  commandId: string
  commandName: CommandName
  source: CommandSource
}

export async function runIntents(intents: readonly EffectIntent[], ctx: EffectRunnerCtx): Promise<void> {
  for (const intent of intents) {
    try {
      await runIntent(intent, ctx)
    } catch (raw) {
      const error = asPeekError(raw, fallbackCodeOf(intent))
      applyIntentFailure(intent, error, ctx)
      if (intent.soft === true) {
        ctx.deps.notify?.({
          level: 'warn',
          // NotifyMessage has no localization channel, and this text is also read
          // from the main-process log, so it stays plain English.
          message: `${ctx.commandName}: the ${intent.type} effect did not succeed`,
          detail: error.message,
        })
        continue
      }
      throw new CommandFailure(error)
    }
  }
}

async function runIntent(intent: EffectIntent, ctx: EffectRunnerCtx): Promise<void> {
  const meta = { commandId: ctx.commandId, commandName: ctx.commandName, source: ctx.source }

  switch (intent.type) {
    case 'connect': {
      const outcome = await ctx.deps.connections.open({
        connId: intent.connId,
        config: intent.config,
        ...(intent.timeoutMs !== undefined ? { timeoutMs: intent.timeoutMs } : {}),
      })
      ctx.store.apply((draft) => {
        setConnectionStatus(draft, intent.connId, 'ready', {
          capabilities: outcome.capabilities,
          ...(outcome.serverInfo ? { serverInfo: outcome.serverInfo } : {}),
          ...(outcome.pid !== undefined ? { pid: outcome.pid } : {}),
          readyAt: Date.now(),
        })
      }, meta)
      return
    }

    case 'disconnect':
      await ctx.deps.connections.close(intent.connId)
      return

    case 'runQuery':
      await ctx.deps.results.runQuery({
        connId: intent.connId,
        viewId: intent.viewId,
        resultId: intent.resultId,
        text: intent.text,
        ...(intent.params ? { params: intent.params } : {}),
        ...(intent.maxRows !== undefined ? { maxRows: intent.maxRows } : {}),
        ...(intent.timeoutMs !== undefined ? { timeoutMs: intent.timeoutMs } : {}),
      })
      return

    case 'scan':
      await ctx.deps.results.scanCollection({
        connId: intent.connId,
        viewId: intent.viewId,
        resultId: intent.resultId,
        ref: intent.ref,
        ...(intent.filter ? { filter: intent.filter } : {}),
        ...(intent.sort ? { sort: intent.sort } : {}),
        ...(intent.offset !== undefined ? { offset: intent.offset } : {}),
        ...(intent.limit !== undefined ? { limit: intent.limit } : {}),
        ...(intent.cursorToken !== undefined ? { cursorToken: intent.cursorToken } : {}),
      })
      rememberAcceptedFetch(ctx.store, intent)
      return

    case 'vectorSearch':
      await ctx.deps.results.vectorSearch({
        connId: intent.connId,
        viewId: intent.viewId,
        resultId: intent.resultId,
        collection: intent.collection,
        ...(intent.queryVec ? { queryVec: intent.queryVec } : {}),
        ...(intent.queryPointId === undefined ? {} : { queryPointId: intent.queryPointId }),
        ...(intent.vectorName === undefined ? {} : { vectorName: intent.vectorName }),
        topK: intent.topK,
        ...(intent.scoreThreshold === undefined ? {} : { scoreThreshold: intent.scoreThreshold }),
        ...(intent.filter ? { filter: intent.filter } : {}),
      })
      rememberAcceptedFetch(ctx.store, intent)
      return

    case 'cancel': {
      const cancelled = await ctx.deps.results.cancel({ connId: intent.connId, resultId: intent.resultId })
      if (!cancelled) return
      ctx.store.apply((draft) => {
        cancelResult(draft, intent.resultId)
      }, meta)
      return
    }
  }
}

/** On effect failure, push the state machine to error so a view never sits at loading forever. */
function applyIntentFailure(
  intent: EffectIntent,
  error: ReturnType<typeof asPeekError>,
  ctx: EffectRunnerCtx,
): void {
  const meta = { commandId: ctx.commandId, commandName: ctx.commandName, source: ctx.source }

  switch (intent.type) {
    case 'connect':
      ctx.store.apply((draft) => {
        setConnectionStatus(draft, intent.connId, 'error', { error })
      }, meta)
      return
    case 'runQuery':
    case 'scan':
    case 'vectorSearch':
      ctx.store.apply((draft) => {
        failResult(draft, intent.resultId, error)
        // One atomic change, not two: the error bar, the restored rows and the
        // toolbar that describes them have to reach the renderer in the same
        // patch, or the grid blanks for a frame.
        restorePreviousResult(draft, intent.viewId, intent.resultId, ACCEPTED_FETCHES.get(ctx.store))
      }, meta)
      return
    case 'disconnect':
    case 'cancel':
      return
  }
}

/* ================================================================== */
/* Which request produced which rows                                   */
/* ================================================================== */

/** The two intents whose parameters are also *view* state (see `startScan` / `startVectorSearch`). */
type AcceptedFetch = Extract<EffectIntent, { type: 'scan' | 'vectorSearch' }>

/**
 * The request behind each result set the driver actually accepted.
 *
 * ## Why this table exists
 *
 * `ResultMeta` records that a fetch happened — id, view, status, row count — but
 * not *what was asked*. Nothing else in main remembers it either: the parameters
 * live on the view, and the view is overwritten by the next request. So when a
 * refused fetch is rolled back (see {@link restorePreviousResult}) there is no
 * way to ask "under what sort and which page were these rows fetched?" — and
 * without that answer the rollback can only put the id back, leaving the toolbar
 * describing the request that failed.
 *
 * ## Why here and not on ResultMeta
 *
 * `ResultMeta` is Workspace state: it is snapshotted, patched to the renderer and
 * read by MCP. Putting a filter tree and a query vector on it would publish every
 * request parameter to all three for the sake of a rollback nobody else needs.
 * This table is effect-phase bookkeeping and never leaves main.
 *
 * Keyed by store so parallel buses (tests, primarily) cannot see each other's
 * entries, and pruned against the workspace's own result table on every write —
 * which core already caps at `MAX_RESULT_META`.
 */
const ACCEPTED_FETCHES = new WeakMap<WorkspaceStore, Map<ResultId, AcceptedFetch>>()

/** Record what a driver just agreed to run. Called only after the request was accepted. */
function rememberAcceptedFetch(store: WorkspaceStore, intent: AcceptedFetch): void {
  let table = ACCEPTED_FETCHES.get(store)
  if (!table) {
    table = new Map<ResultId, AcceptedFetch>()
    ACCEPTED_FETCHES.set(store, table)
  }
  table.set(intent.resultId, intent)
  // Follow core's own eviction rather than inventing a second policy: a result
  // that has been pruned out of the workspace can never be restored onto a view.
  if (table.size > 1) {
    const live = store.getState().results
    for (const id of [...table.keys()]) {
      if (!(id in live)) table.delete(id)
    }
  }
}

/**
 * Put back the fetch parameters that produced the rows being restored.
 *
 * ## The inconsistency this removes
 *
 * `view.update` writes the new sort / filter / page into the view during the pure
 * state phase (`applyViewPatch`), *before* the driver has agreed to anything —
 * which is right, because that is what makes the spinner and the toolbar agree
 * while the request is in flight. When the request is then refused, restoring
 * only `resultId` leaves the two halves describing different requests: the column
 * header draws a sort arrow, the pager shows the new offset, and the grid holds
 * rows fetched under the *old* conditions. The view then describes a request the
 * server rejected, which is worse than the empty grid it replaced — an empty grid
 * with an error bar is at least honest.
 *
 * A query view is deliberately left alone: its `text` is what the user typed, and
 * an editor that rewrites your statement because the server disliked it would be
 * its own bug. Only the parameters that were *derived* into a request roll back,
 * which is exactly what this table holds. `queryText` on a vector view is in the
 * same category — a human's input, never sent to a driver — so it stays too.
 */
function restoreFetchParams(view: Draft<ViewState>, fetch: AcceptedFetch): void {
  if (fetch.type === 'scan') {
    if (view.kind !== 'table') return
    view.ref = fetch.ref
    if (fetch.filter) view.filter = fetch.filter
    else delete view.filter
    if (fetch.sort) view.sort = fetch.sort
    else delete view.sort
    if (fetch.offset !== undefined) view.page.offset = fetch.offset
    if (fetch.limit !== undefined) view.page.limit = fetch.limit
    // The continuation cursor belongs to the restored page, not to the refused one.
    if (fetch.cursorToken !== undefined) view.cursorToken = fetch.cursorToken
    else delete view.cursorToken
    return
  }

  if (view.kind !== 'vector') return
  view.collection = fetch.collection
  // Exactly one query entry point, the same rule `applyViewPatch` enforces.
  if (fetch.queryPointId !== undefined) {
    view.queryPointId = fetch.queryPointId
    delete view.queryVec
  } else if (fetch.queryVec) {
    view.queryVec = fetch.queryVec
    delete view.queryPointId
  }
  if (fetch.vectorName !== undefined) view.vectorName = fetch.vectorName
  else delete view.vectorName
  view.topK = fetch.topK
  if (fetch.scoreThreshold !== undefined) view.scoreThreshold = fetch.scoreThreshold
  else delete view.scoreThreshold
  if (fetch.filter) view.filter = fetch.filter
  else delete view.filter
}

/**
 * A fetch was refused before it ever produced a row — put the previous result back.
 *
 * ## The bug this fixes
 *
 * Every command that starts a scan moves the view onto the new resultId *before*
 * the driver has agreed to anything (`beginResult`): the view goes to `loading`
 * and points at a result set that does not exist yet. That is right while the
 * request is in flight — it is what makes the spinner honest. It is wrong the
 * moment the request is **rejected**, because the view is then pointing at a
 * result set that will never receive a single frame. What the user saw was an
 * error bar over an empty grid, and the page of data they were reading a second
 * ago was gone — for a typo in a filter, or a connection that had just dropped.
 *
 * Losing data to a *failed* request is the wrong way round. The request failed;
 * the previous answer is still exactly as true as it was. So the view goes back to
 * it, and the error is left where an error belongs: on the ViewError bar, layered
 * over the data that is still good.
 *
 * ## Which result counts as "previous"
 *
 * The newest one this view started that still holds usable rows. `done`, `paused`
 * and `cancelled` all qualify — core is explicit that a pause and a cancel keep
 * every row that arrived (see `pauseResult` / `failResult` in store/mutations).
 * `error` does not: falling back onto another empty grid would trade one blank
 * screen for an older blank screen.
 *
 * ## The id is not the whole rollback
 *
 * The fetch parameters go back with it — see {@link restoreFetchParams}. Moving
 * only `resultId` leaves a table view drawing a sort arrow and a page number for
 * the request that was refused, over rows fetched under the previous conditions:
 * a toolbar describing one request and a grid holding another.
 *
 * ## Why here and not in beginResult
 *
 * Because only the effect phase knows the request was refused. `beginResult` runs
 * in the pure state phase, before anything has been asked of the driver, and the
 * common case — the fetch is accepted — must not pay for the failing one.
 *
 * Failures that arrive *after* the stream has started take a different route
 * (`result.error` from the driver host into the ResultEventSink) and are
 * deliberately left alone: by then the new result set is real, it may already hold
 * rows, and replacing it with an older one would discard data the user can see.
 */
function restorePreviousResult(
  draft: Draft<Workspace>,
  viewId: ViewId,
  failedResultId: ResultId,
  accepted: ReadonlyMap<ResultId, AcceptedFetch> | undefined,
): void {
  const view = draft.views[viewId]
  // Only while the view still points at the failed fetch. Anything else means
  // something newer has already claimed it, and that one wins.
  if (!view || !('resultId' in view) || view.resultId !== failedResultId) return

  let best: { id: ResultId; startedAt: number } | null = null
  for (const meta of Object.values(draft.results)) {
    if (meta.viewId !== viewId || meta.id === failedResultId) continue
    // Both conditions, from core, and neither is redundant: `hasUsableRows` rules
    // out `error`, `isSettledResultStatus` rules out `running`. A fetch this view
    // started earlier and never finished has already been cancelled by
    // `beginResult`, and pointing the view back at it would resurrect a spinner.
    if (!hasUsableRows(meta.status) || !isSettledResultStatus(meta.status)) continue
    if (meta.rows <= 0) continue
    // `>=` rather than `>`: two fetches can share a millisecond, and `results` is
    // insertion-ordered, so the later entry of a tie is the later request. With a
    // strict `>` the *older* one won, and the view fell back past a page the user
    // had actually been looking at.
    if (best === null || meta.startedAt >= best.startedAt) best = { id: meta.id, startedAt: meta.startedAt }
  }
  if (best === null) return

  view.resultId = best.id
  // Nothing recorded means the request predates this table (or was a query, whose
  // parameters are the user's text and stay). The id still goes back: rows the
  // user can read beat a blank grid either way.
  const fetch = accepted?.get(best.id)
  if (fetch) restoreFetchParams(view, fetch)
}

function fallbackCodeOf(intent: EffectIntent): PeekErrorCode {
  switch (intent.type) {
    case 'connect':
      return 'CONNECTION_FAILED'
    case 'runQuery':
    case 'scan':
    case 'vectorSearch':
      return 'QUERY_FAILED'
    default:
      return 'INTERNAL'
  }
}
