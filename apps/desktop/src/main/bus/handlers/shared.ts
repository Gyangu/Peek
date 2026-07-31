import type { Draft } from 'immer'
import {
  DEFAULT_PAGE_LIMIT,
  collectionRefLabel,
  findPanel,
  type Capability,
  type ConnId,
  type ConnectionState,
  type PanelId,
  type PanelNode,
  type QueryViewState,
  type ResultId,
  type TableViewState,
  type VectorViewState,
  type ViewId,
  type ViewOpenSpec,
  type ViewOpenResult,
  type ViewState,
  type Workspace,
} from '@peek/core'
import { plain } from '../../store/workspace-store'
import { putView, removeView, runningResultOf, startResult } from '../../store/mutations'
import { failMsg } from '../failure'
import { firstEmptyPanel, firstPanel, setPanelView, splitPanel } from '../layout-ops'
import type { ReduceCtx } from '../types'

/** Default topK for a vector view */
const DEFAULT_TOP_K = 10

/* ================================================================== */
/* Lookups and validation                                              */
/* ================================================================== */

export function requireConnection(draft: Draft<Workspace>, connId: ConnId): Draft<ConnectionState> {
  const conn = draft.connections[connId]
  if (!conn) failMsg('NOT_FOUND', 'error.conn.notFound', { connId })
  return conn
}

export function requireView(draft: Draft<Workspace>, viewId: ViewId): Draft<ViewState> {
  const view = draft.views[viewId]
  if (!view) failMsg('NOT_FOUND', 'error.view.notFound', { viewId })
  return view
}

/**
 * The connection must be ready and have the capability. Fails with something
 * actionable rather than letting the driver layer report whatever it reports.
 */
export function requireReadyWithCapability(conn: Draft<ConnectionState>, cap: Capability): void {
  if (conn.status !== 'ready') {
    failMsg(
      'CONFLICT',
      'error.conn.notReady',
      { label: conn.label, status: conn.status },
      // The underlying failure is driver text: passed through, never translated.
      { detail: conn.error?.message },
    )
  }
  if (!conn.capabilities.includes(cap)) {
    failMsg('UNSUPPORTED_CAPABILITY', 'error.conn.unsupportedCapability', {
      driverId: conn.driverId,
      capability: cap,
    })
  }
}

/**
 * Whether an automatic fetch is possible: connected, and the capability is there.
 * When it is not, the view sits quietly at idle instead of raising an error.
 */
function canFetch(draft: Draft<Workspace>, connId: ConnId, cap: Capability): boolean {
  const conn = draft.connections[connId]
  return conn !== undefined && conn.status === 'ready' && conn.capabilities.includes(cap)
}

/**
 * Where a view lands: explicit panel → focused panel → first empty panel → first panel.
 * An explicit panel that does not exist is a NOT_FOUND, so an AI holding a stale
 * panelId finds out immediately.
 */
export function resolvePanel(draft: Draft<Workspace>, panelId?: PanelId): PanelNode {
  const layout = plain(draft.layout)
  if (panelId !== undefined) {
    const explicit = findPanel(layout, panelId)
    if (!explicit) failMsg('NOT_FOUND', 'error.panel.notFound', { panelId })
    return explicit
  }
  const focused = draft.focusedPanel
  if (focused !== null) {
    const hit = findPanel(layout, focused)
    if (hit) return hit
  }
  return firstEmptyPanel(layout) ?? firstPanel(layout) ?? failMsg('INTERNAL', 'error.layout.noPanels')
}

/* ================================================================== */
/* Opening views                                                       */
/* ================================================================== */

export interface OpenViewOptions {
  panelId?: PanelId
  /** When the target panel already holds a view: true replaces it, false splits off a new panel. Default true. */
  replace?: boolean
  /** Default true */
  focus?: boolean
  /** Run a query view as soon as it opens */
  run?: boolean
}

export function openView(
  draft: Draft<Workspace>,
  spec: ViewOpenSpec,
  ctx: ReduceCtx,
  opts: OpenViewOptions = {},
): ViewOpenResult {
  // The connection must exist, but need not be ready yet: the view opens now and
  // fetches once the connection comes up.
  requireConnection(draft, spec.connId)

  const target = resolvePanel(draft, opts.panelId)
  let panelId: PanelId = target.id

  if (target.viewId !== null) {
    if (opts.replace === false) {
      const outcome = splitPanel(plain(draft.layout), {
        panelId: target.id,
        dir: 'row',
        newPanelId: ctx.ids.panel(),
        newSplitId: ctx.ids.split(),
      })
      if (!outcome) failMsg('INTERNAL', 'error.panel.splitFailed', { panelId: target.id })
      draft.layout = outcome.layout as Draft<Workspace>['layout']
      panelId = outcome.panelId
    } else {
      closeView(draft, target.viewId, ctx)
    }
  }

  const view = buildViewState(spec, ctx.ids.view())
  putView(draft, view)

  const layout = setPanelView(plain(draft.layout), panelId, view.id)
  if (layout) draft.layout = layout as Draft<Workspace>['layout']
  if (opts.focus !== false) draft.focusedPanel = panelId

  const resultId = autoFetch(draft, view.id, ctx, opts.run === true)
  const result: ViewOpenResult = { viewId: view.id, panelId, kind: view.kind }
  if (resultId !== undefined) result.resultId = resultId
  return result
}

/** Close a view: detach it from its panel, drop it from `views`, cancel any result it still has running. */
export function closeView(draft: Draft<Workspace>, viewId: ViewId, ctx: ReduceCtx): PanelId | null {
  const view = draft.views[viewId]
  if (!view) return null
  const running = runningResultOf(draft, viewId)
  if (running !== null) {
    // Best effort: a failed cancel must not stop the view from closing.
    ctx.plan({ type: 'cancel', connId: view.connId, resultId: running, soft: true })
  }
  return removeView(draft, viewId)
}

function buildViewState(spec: ViewOpenSpec, id: ViewId): ViewState {
  const base = { id, connId: spec.connId, status: 'idle' as const, ...(spec.title ? { title: spec.title } : {}) }
  switch (spec.kind) {
    case 'table':
      return {
        ...base,
        kind: 'table',
        ref: spec.ref,
        ...(spec.filter ? { filter: spec.filter } : {}),
        ...(spec.sort ? { sort: spec.sort } : {}),
        page: { offset: spec.offset ?? 0, limit: spec.limit ?? DEFAULT_PAGE_LIMIT },
      }
    case 'query':
      return { ...base, kind: 'query', text: spec.text ?? '' }
    case 'inspector':
      return { ...base, kind: 'inspector', ref: spec.ref }
    case 'tree':
      return { ...base, kind: 'tree', expanded: spec.expanded ?? [] }
    case 'vector':
      return {
        ...base,
        kind: 'vector',
        collection: spec.collection,
        ...(spec.queryVec ? { queryVec: spec.queryVec } : {}),
        ...(spec.queryText ? { queryText: spec.queryText } : {}),
        topK: spec.topK ?? DEFAULT_TOP_K,
        ...(spec.filter ? { filter: spec.filter } : {}),
      }
  }
}

/* ================================================================== */
/* Starting a fetch                                                    */
/* ================================================================== */

/**
 * Automatic fetch after a view opens or changes.
 * When the connection is not ready, or the driver lacks the capability, this is
 * **not** an error: the view stays idle and picks up on the next refresh.
 */
export function autoFetch(
  draft: Draft<Workspace>,
  viewId: ViewId,
  ctx: ReduceCtx,
  runQuery = false,
): ResultId | undefined {
  const view = draft.views[viewId]
  if (!view) return undefined
  switch (view.kind) {
    case 'table':
      return canFetch(draft, view.connId, 'collectionScan') ? startScan(draft, view, ctx) : undefined
    case 'vector':
      return view.queryVec !== undefined && canFetch(draft, view.connId, 'vectorSearch')
        ? startVectorSearch(draft, view, ctx)
        : undefined
    case 'query':
      return runQuery && view.text.trim() !== '' && canFetch(draft, view.connId, 'tabularQuery')
        ? startQuery(draft, view, ctx, {})
        : undefined
    default:
      return undefined
  }
}

/**
 * The common opening move: allocate result metadata and move the view into loading.
 *
 * `summary` is workspace state that MCP reads, so it stays English — see the
 * language rule in `docs/PLAN.md` and `@peek/core/error-messages`.
 */
function beginResult(
  draft: Draft<Workspace>,
  view: Draft<ViewState>,
  ctx: ReduceCtx,
  summary: string,
): ResultId {
  // Cancel the view's previous in-flight result before paging or re-running.
  // This has to happen before `view.resultId` is overwritten: once it points at
  // the new result, nobody can address the old one to cancel it any more
  // (query.cancel only locates results through view.resultId). It would keep
  // holding a server-side cursor, a connection and a read-only transaction —
  // and because no view in the renderer reports a viewport for it, backpressure
  // no longer applies at all. That orphaned stream runs flat out and eats the
  // whole 200MB cache budget (PLAN section 8).
  const prev = runningResultOf(draft, view.id)
  if (prev !== null) {
    // soft: a failed cancel is a warning, it must not sink this fetch command.
    ctx.plan({ type: 'cancel', connId: view.connId, resultId: prev, soft: true })
  }

  const resultId = ctx.ids.result()
  // Switch on `kind` rather than `'resultId' in view`: the property is optional,
  // so `in` is false until something assigns it.
  if (view.kind === 'table' || view.kind === 'query' || view.kind === 'vector') {
    view.resultId = resultId
  }
  view.status = 'loading'
  delete view.error
  startResult(draft, {
    id: resultId,
    connId: view.connId,
    viewId: view.id,
    status: 'running',
    rows: 0,
    startedAt: ctx.now,
    summary,
  })
  return resultId
}

export function startScan(draft: Draft<Workspace>, view: Draft<TableViewState>, ctx: ReduceCtx): ResultId {
  const ref = plain(view.ref)
  const resultId = beginResult(draft, view, ctx, `Scan ${collectionRefLabel(ref)}`)
  ctx.plan({
    type: 'scan',
    connId: view.connId,
    viewId: view.id,
    resultId,
    ref,
    ...(view.filter ? { filter: plain(view.filter) } : {}),
    ...(view.sort ? { sort: plain(view.sort) } : {}),
    offset: view.page.offset,
    limit: view.page.limit,
    ...(view.cursorToken !== undefined ? { cursorToken: view.cursorToken } : {}),
  })
  return resultId
}

export function startVectorSearch(
  draft: Draft<Workspace>,
  view: Draft<VectorViewState>,
  ctx: ReduceCtx,
): ResultId {
  const resultId = beginResult(draft, view, ctx, `Vector search ${view.collection} topK ${view.topK}`)
  ctx.plan({
    type: 'vectorSearch',
    connId: view.connId,
    viewId: view.id,
    resultId,
    collection: view.collection,
    ...(view.queryVec ? { queryVec: plain(view.queryVec) } : {}),
    topK: view.topK,
    ...(view.filter ? { filter: plain(view.filter) } : {}),
  })
  return resultId
}

export interface RunQueryOptions {
  params?: unknown[]
  maxRows?: number
  timeoutMs?: number
}

export function startQuery(
  draft: Draft<Workspace>,
  view: Draft<QueryViewState>,
  ctx: ReduceCtx,
  opts: RunQueryOptions,
): ResultId {
  const text = view.text
  const resultId = beginResult(draft, view, ctx, oneLine(text))
  ctx.plan({
    type: 'runQuery',
    connId: view.connId,
    viewId: view.id,
    resultId,
    text,
    ...(opts.params ? { params: opts.params } : {}),
    ...(opts.maxRows !== undefined ? { maxRows: opts.maxRows } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  })
  return resultId
}

function oneLine(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}
