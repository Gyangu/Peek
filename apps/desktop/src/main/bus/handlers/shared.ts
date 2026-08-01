import type { Draft } from 'immer'
import {
  DEFAULT_PAGE_LIMIT,
  MAX_LAYOUT_DEPTH,
  MAX_LAYOUT_PANELS,
  MAX_PANEL_TABS,
  collectionRefLabel,
  countPanels,
  findPanel,
  layoutDepth,
  overflowingPanel,
  panelTabIndex,
  type Capability,
  type ConnId,
  type ConnectionState,
  type LayoutNode,
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
import { firstEmptyPanel, firstPanel, mountViewInPanel } from '../layout-ops'
import type { ReduceCtx } from '../types'

/** Default topK for a vector view */
const DEFAULT_TOP_K = 10

/* ================================================================== */
/* Writing the layout back onto a draft                                */
/* ================================================================== */

/**
 * Guard every panel-creating operation, not just the declarative one.
 *
 * The caps are a property of the tree (MAX_LAYOUT_PANELS in core), so enforcing
 * them on `layout.setLayout` alone would let a loop of `layout.split` — or of
 * `view.open` with `replace: false`, which splits a panel of its own accord —
 * walk straight past them. It lives here rather than in handlers/layout.ts so
 * that `openView` can reach it without a cycle.
 */
export function assertWithinLimits(layout: LayoutNode): void {
  if (countPanels(layout) > MAX_LAYOUT_PANELS) {
    failMsg('CONFLICT', 'error.layout.tooManyPanels', { max: MAX_LAYOUT_PANELS })
  }
  if (layoutDepth(layout) > MAX_LAYOUT_DEPTH) {
    failMsg('CONFLICT', 'error.layout.tooDeep', { max: MAX_LAYOUT_DEPTH })
  }
}

/**
 * Guard the per-panel tab cap (P5) at every entry point that can add a tab.
 *
 * Same argument as `assertWithinLimits`, and it needs its own function because
 * the two caps are reached by different commands: stacking views onto one panel
 * (`view.open` with the new `replace: false` default, `layout.moveView`, a
 * `layout.setLayout` leaf) creates no panels at all and so walks straight past
 * the panel-count guard.
 *
 * The core primitives deliberately do **not** enforce this — they are total
 * functions, and `insertPanelTab` returning "no" would force every caller to
 * handle a failure that is really a policy decision. The handler is the gate.
 */
export function assertPanelTabsWithinLimit(layout: LayoutNode): void {
  if (overflowingPanel(layout) !== null) {
    failMsg('CONFLICT', 'error.layout.tooManyTabs', { max: MAX_PANEL_TABS })
  }
}

/**
 * Install a layout tree onto the draft — but only when it really is a different
 * tree.
 *
 * The guard is not an optimisation, it is a correctness requirement, and the
 * reason is a sharp edge in immer's patch generation:
 *
 * every handler starts with `plain(draft.layout)`, and reading that property
 * makes immer create a child draft for it. Assigning the *base* object back over
 * that child draft hits immer's "you assigned the original value" branch, which
 * records `assigned_['layout'] = false` — and `false` means **removed** to the
 * patch generator. The result is a `{ op: 'remove', path: ['layout'] }` patch
 * even though nothing changed. Main's own state stays perfectly correct, so
 * nothing fails here; the renderer applies the patch, `workspace.layout` becomes
 * `undefined`, and the first component to walk the tree throws.
 *
 * The no-op tree operations (`moveViewToPanel` and `splitPanelWithView` on the
 * panel a view already occupies, invariant I6) return their argument by
 * identity precisely so this comparison can be a reference check.
 */
export function writeLayout(draft: Draft<Workspace>, next: LayoutNode): void {
  if (plain(draft.layout) === next) return
  draft.layout = next as Draft<Workspace>['layout']
}

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
  /**
   * What to do about the target panel's current contents. **Both the default and
   * the meaning of `false` changed with tabs.**
   *
   * - `false` (**the new default**) appends the view as another tab. Nothing is
   *   closed and no panel is created. It used to mean "split off a new panel",
   *   which stopped being a sensible fallback the moment a panel could hold more
   *   than one view: clicking a table in the sidebar had to choose between
   *   destroying the open one and halving the window, and tabs exist to answer
   *   exactly that.
   * - `true` closes the panel's **active** view and puts the new one in its tab
   *   position — "reuse this slot", which is what a re-run into the same pane
   *   wants. Note it takes the slot rather than appending, so the tab bar does
   *   not reshuffle under the user's cursor.
   */
  replace?: boolean
  /** Insert position in the tab bar; omitted means append. Ignored when `replace` is true. */
  index?: number
  /**
   * Show the view once it is mounted (default true).
   *
   * Internal to the bus, not a Command field: `view.open` always shows what it
   * opened. `layout.setLayout` is the one caller that needs otherwise, because a
   * leaf's `activeViewId` decides which of its tabs is visible and the views it
   * opens must not each take over the panel as they are appended.
   */
  activate?: boolean
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
  const panelId: PanelId = target.id

  // `replace` takes the departing view's tab position rather than appending, so
  // the slot the user was looking at is the slot the new view appears in. The
  // index has to be read before the close, because closing shifts everything
  // after it left by one.
  let index = opts.index
  if (opts.replace === true && target.activeViewId !== null) {
    index = panelTabIndex(target, target.activeViewId)
    closeView(draft, target.activeViewId, ctx)
  }

  const view = buildViewState(spec, ctx.ids.view())
  putView(draft, view)

  const layout = mountViewInPanel(plain(draft.layout), panelId, view.id, {
    ...(index === undefined ? {} : { index }),
    activate: opts.activate !== false,
  })
  if (layout) {
    // Opening no longer creates panels, so the panel-count cap cannot be reached
    // from here — but the tab cap now can, from every `view.open` a model makes.
    assertPanelTabsWithinLimit(layout)
    writeLayout(draft, layout)
  }
  if (opts.focus !== false) draft.focusedPanel = panelId

  const resultId = autoFetch(draft, view.id, ctx, opts.run === true)
  const result: ViewOpenResult = { viewId: view.id, panelId, kind: view.kind }
  if (resultId !== undefined) result.resultId = resultId
  return result
}

export interface CloseViewOutcome {
  /** The panel the view was detached from; null when it was not mounted anywhere */
  panelId: PanelId | null
  /**
   * The tab that took over, by the succession rule — right neighbour, then left,
   * then null for a panel that is now empty.
   *
   * **The panel itself always survives**, emptied when that was its last tab.
   * Removing a panel is `layout.close`'s job; making the last ⌘W behave
   * differently from the ones before it would be a surprise, and an empty panel
   * has been an ordinary thing in peek since before tabs (`⌘\` produces one).
   */
  activatedViewId: ViewId | null
}

/** Close a view: detach it from its panel, drop it from `views`, cancel any result it still has running. */
export function closeView(draft: Draft<Workspace>, viewId: ViewId, ctx: ReduceCtx): CloseViewOutcome {
  const view = draft.views[viewId]
  if (!view) return { panelId: null, activatedViewId: null }
  const running = runningResultOf(draft, viewId)
  if (running !== null) {
    // Best effort: a failed cancel must not stop the view from closing.
    ctx.plan({ type: 'cancel', connId: view.connId, resultId: running, soft: true })
  }
  const panelId = removeView(draft, viewId)
  if (panelId === null) return { panelId: null, activatedViewId: null }
  // Read the succession result off the tree rather than recomputing it: whatever
  // `removePanelTab` decided is by definition what the user is now looking at.
  return { panelId, activatedViewId: findPanel(plain(draft.layout), panelId)?.activeViewId ?? null }
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
      // The driver contract is "exactly one of queryVec / queryPointId", so a
      // spec carrying both is rejected here rather than at the driver: by then
      // the view exists, is mounted, and its first fetch fails for a reason the
      // caller cannot see from the workspace.
      if (spec.queryVec !== undefined && spec.queryPointId !== undefined) {
        failMsg('BAD_REQUEST', 'error.vector.queryRequired')
      }
      return {
        ...base,
        kind: 'vector',
        collection: spec.collection,
        ...(spec.queryVec ? { queryVec: spec.queryVec } : {}),
        ...(spec.queryPointId === undefined ? {} : { queryPointId: spec.queryPointId }),
        ...(spec.queryText ? { queryText: spec.queryText } : {}),
        ...(spec.vectorName === undefined ? {} : { vectorName: spec.vectorName }),
        topK: spec.topK ?? DEFAULT_TOP_K,
        ...(spec.scoreThreshold === undefined ? {} : { scoreThreshold: spec.scoreThreshold }),
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
      // Either query entry point will do; with neither the driver would reject
      // the search, so the view simply stays idle until one is filled in.
      return (view.queryVec !== undefined || view.queryPointId !== undefined)
        && canFetch(draft, view.connId, 'vectorSearch')
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
    // `queryPointId` wins when both are somehow set. The view keeps them
    // exclusive (buildViewState rejects a spec with both, applyViewPatch clears
    // the other one), so this is a belt-and-braces tie-break rather than a
    // policy: sending both is a BAD_REQUEST at the driver.
    ...(view.queryPointId !== undefined
      ? { queryPointId: view.queryPointId }
      : view.queryVec
        ? { queryVec: plain(view.queryVec) }
        : {}),
    ...(view.vectorName === undefined ? {} : { vectorName: view.vectorName }),
    topK: view.topK,
    ...(view.scoreThreshold === undefined ? {} : { scoreThreshold: view.scoreThreshold }),
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
