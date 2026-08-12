import type { Draft } from 'immer'
import {
  DEFAULT_PAGE_LIMIT,
  MAX_LAYOUT_DEPTH,
  MAX_LAYOUT_PANELS,
  MAX_PANEL_TABS,
  collectPanels,
  collectionRefLabel,
  countPanels,
  findPanel,
  findPanelOfView,
  layoutDepth,
  overflowingPanel,
  panelTabIndex,
  type Capability,
  type ConnId,
  type ConnectionState,
  type LayoutNode,
  type PackageViewText,
  type PanelId,
  type PanelNode,
  type PackageViewState,
  type PackageViewStateShape,
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
import { firstEmptyPanel, firstPanel, mountViewInPanel, splitPanel } from '../layout-ops'
import type { ReduceCtx } from '../types'
import { buildChatViewState, stageChatAttachments } from './chat'

/**
 * The views that fetch data — everything except `inspector`, `tree` and `chat`.
 *
 * Named because `beginResult` and its callers only ever apply to these four, and
 * saying so in the type is what keeps a chat view (which has no `connId` at all)
 * from having to be defended against at every line of the fetch path.
 *
 * `PackageViewState` is in here rather than beside it on a path of its own,
 * because that is the entire claim being made about package views: they fetch
 * through the *same* machinery — the same cancel-the-previous-result rule, the
 * same `ResultMeta` with an `origin`, the same backpressure and deadline. A
 * second fetch path for packages would be a second place for all of that to be
 * got wrong, and the first thing to drift would be the invisible one (the
 * orphaned-cursor rule in `beginResult`).
 */
type FetchingViewState = TableViewState | QueryViewState | VectorViewState | PackageViewState

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
 * The same two caps, asked rather than enforced.
 *
 * Only one caller wants this shape: the split `openView` performs to keep a model
 * from covering the conversation (see `resolveOpenTarget`). There the split is a
 * *means*, not the request — a window too full to divide should still open the
 * view, as a tab, rather than fail the command.
 */
function withinLimits(layout: LayoutNode): boolean {
  return countPanels(layout) <= MAX_LAYOUT_PANELS && layoutDepth(layout) <= MAX_LAYOUT_DEPTH
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

/* ------------------------------------------------------------------ */
/* Keeping a model from opening things on top of the conversation      */
/* ------------------------------------------------------------------ */

/** Does this panel hold a chat tab? */
function panelHoldsChat(draft: Draft<Workspace>, panel: PanelNode): boolean {
  return panel.viewIds.some((viewId) => draft.views[viewId]?.kind === 'chat')
}

/**
 * The nearest panel that is not showing a conversation, in visual order (left to
 * right, top to bottom). An empty one wins: "the right-hand pane is free" is a
 * better answer than squeezing another tab in beside a table.
 */
function firstPanelWithoutChat(draft: Draft<Workspace>, exclude: PanelId): PanelNode | null {
  const candidates = collectPanels(plain(draft.layout)).filter(
    (panel) => panel.id !== exclude && !panelHoldsChat(draft, panel),
  )
  return candidates.find((panel) => panel.viewIds.length === 0) ?? candidates[0] ?? null
}

/**
 * Open a column to the right of `target` and hand it back — or null when the tree
 * caps say no, in which case the caller falls back to a tab.
 *
 * `row` is written in rather than chosen: peek's window is wide and a chat pane is
 * already the narrow one; splitting it horizontally squashes both halves. A model
 * that wants the result underneath says so with `move_view` / `set_layout`.
 */
function splitBeside(draft: Draft<Workspace>, target: PanelNode, ctx: ReduceCtx): PanelNode | null {
  const outcome = splitPanel(plain(draft.layout), {
    panelId: target.id,
    dir: 'row',
    insert: 'after',
    newPanelId: ctx.ids.panel(),
    newSplitId: ctx.ids.split(),
  })
  if (!outcome || !withinLimits(outcome.layout)) return null
  writeLayout(draft, outcome.layout)
  return findPanel(plain(draft.layout), outcome.panelId)
}

/**
 * Where a view opened *by a model* lands.
 *
 * The plain rule — focused panel, append as a tab — is right for a hand and wrong
 * for an assistant. When the user asks the conversation to open a table, the
 * focused panel is the conversation's own, so the table arrives as a tab in front
 * of it and hides the very message that asked for it. The next thing the model
 * says is hidden too.
 *
 * So a command from `mcp` / `agent` that named no panel, and that would land where
 * a chat is, goes to the next panel without one — splitting a column off to the
 * right if there is no such panel. `ui` (a hand) and `system` (recovery) are
 * untouched, and so is any caller that named a panel: saying where is a decision,
 * and this rule only fills in a blank.
 *
 * `redirected` is what suppresses the focus move in `openView`: the view appears
 * elsewhere, the conversation keeps the cursor. Because the answer is a function
 * of the tree alone, a run of opens lands in the same column each time rather than
 * walking rightwards.
 *
 * The judgement is "this panel has a chat in it", not "this command came from that
 * chat" — `ReduceCtx` carries no originating view, and threading one through from
 * the MCP session would not even be more correct: with two conversations stacked
 * in one column, avoiding only the caller still covers the other one.
 */
function resolveOpenTarget(
  draft: Draft<Workspace>,
  opts: OpenViewOptions,
  ctx: ReduceCtx,
): { panel: PanelNode; redirectedFrom: PanelNode | null } {
  const target = resolvePanel(draft, opts.panelId)
  const byModel = ctx.source === 'mcp' || ctx.source === 'agent'
  if (opts.panelId !== undefined || !byModel || !panelHoldsChat(draft, target)) {
    return { panel: target, redirectedFrom: null }
  }
  const elsewhere = firstPanelWithoutChat(draft, target.id) ?? splitBeside(draft, target, ctx)
  // No room to divide: a tab in front of the conversation is still better than
  // refusing to open what was asked for.
  return elsewhere ? { panel: elsewhere, redirectedFrom: target } : { panel: target, redirectedFrom: null }
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
  /** Open as the one provisional view — see `ViewBase.provisional` and `takeProvisionalSlot`. */
  provisional?: boolean
}

/**
 * Find the provisional view's slot, and vacate it.
 *
 * Returns the panel and tab index the new view should take, or null when there
 * is nothing to reuse — which is the ordinary case and means the caller falls
 * back to `panelId` / `replace` / append.
 *
 * **A streaming chat is promoted instead of replaced.** Closing a chat view
 * cancels a turn in flight (`AcpManager.closeChat`), and resuming a conversation
 * runs one, so "click a row, click the next one before the first has loaded"
 * would silently kill the first load. Keeping it costs a tab; replacing it costs
 * work the user cannot see was thrown away. It stops being provisional at the
 * same moment, because a conversation that is talking is one the user is using.
 */
function takeProvisionalSlot(
  draft: Draft<Workspace>,
  ctx: ReduceCtx,
): { panelId: PanelId; index: number } | null {
  const previous = Object.values(draft.views).find((v) => v.provisional === true)
  if (!previous) return null
  if (previous.kind === 'chat' && previous.streamingMessageId !== null) {
    delete previous.provisional
    return null
  }
  const panel = findPanelOfView(plain(draft.layout), previous.id)
  // A provisional view that sits in no panel cannot lend a slot; clear the flag
  // so the Workspace is not left claiming a provisional view nobody can see.
  if (!panel) {
    delete previous.provisional
    return null
  }
  const index = panelTabIndex(panel, previous.id)
  closeView(draft, previous.id, ctx)
  return { panelId: panel.id, index }
}

export function openView(
  draft: Draft<Workspace>,
  spec: ViewOpenSpec,
  ctx: ReduceCtx,
  opts: OpenViewOptions = {},
): ViewOpenResult {
  // The connection must exist, but need not be ready yet: the view opens now and
  // fetches once the connection comes up.
  //
  // A chat is the one view that is not a window onto a connection (see
  // `ConnectedViewBase`), so it has nothing to check here — and when it *does*
  // name one, that is advisory: a conversation about a database the user has
  // since disconnected is still a conversation, and refusing to open it would be
  // a worse answer than opening it unbound.
  if (spec.kind !== 'chat') requireConnection(draft, spec.connId)

  // A provisional open aims at the provisional view's slot wherever it is,
  // ahead of `panelId` / `replace`: "the tab I was skimming in" is a better
  // target than "whatever panel is focused", and it is the whole reason
  // skimming does not accumulate tabs.
  const slot = opts.provisional === true ? takeProvisionalSlot(draft, ctx) : null

  const placement = slot
    ? { panel: resolvePanel(draft, slot.panelId), redirectedFrom: null }
    : resolveOpenTarget(draft, opts, ctx)
  const target = placement.panel
  const panelId: PanelId = target.id

  // `replace` takes the departing view's tab position rather than appending, so
  // the slot the user was looking at is the slot the new view appears in. The
  // index has to be read before the close, because closing shifts everything
  // after it left by one.
  let index = slot ? slot.index : opts.index
  if (slot === null && opts.replace === true && target.activeViewId !== null) {
    index = panelTabIndex(target, target.activeViewId)
    closeView(draft, target.activeViewId, ctx)
  }

  const view = buildViewState(spec, ctx)
  if (opts.provisional === true) view.provisional = true
  putView(draft, view)
  // Staging happens after the view is in `views` so a bad descriptor aborts the
  // whole command — immer discards the draft, and no half-built conversation is
  // left mounted.
  if (spec.kind === 'chat' && spec.attachments && spec.attachments.length > 0) {
    const chat = draft.views[view.id]
    if (chat?.kind === 'chat') stageChatAttachments(draft, chat, spec.attachments, ctx)
  }

  const layout = mountViewInPanel(plain(draft.layout), panelId, view.id, {
    ...(index === undefined ? {} : { index }),
    activate: opts.activate !== false,
  })
  if (layout) {
    // `resolveOpenTarget` is the one thing here that can create a panel, and it
    // checks the tree caps itself (it falls back to a tab rather than failing).
    // The tab cap is reachable from every `view.open` a model makes.
    assertPanelTabsWithinLimit(layout)
    writeLayout(draft, layout)
  }
  // A redirected open deliberately leaves focus where it was: the view was moved
  // out of the conversation's way, so taking the conversation's focus with it
  // would undo half the point.
  //
  // "Where it was" has to be somewhere, though. An open used to repair a focus
  // that pointed at a panel which no longer exists (it always assigned), so a
  // redirect falls back to the panel it was aimed at — the conversation's own —
  // rather than leaving a dangling id behind.
  if (opts.focus !== false) {
    const from = placement.redirectedFrom
    if (from === null) draft.focusedPanel = panelId
    else if (draft.focusedPanel === null || !findPanel(plain(draft.layout), draft.focusedPanel)) {
      draft.focusedPanel = from.id
    }
  }

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
  // `runningResultOf` is already null for a chat (it holds no `resultId`), so the
  // `connId` test only narrows the type — it is not a second condition.
  if (running !== null && view.connId !== undefined) {
    // Best effort: a failed cancel must not stop the view from closing.
    ctx.plan({ type: 'cancel', connId: view.connId, resultId: running, soft: true })
  }
  const panelId = removeView(draft, viewId)
  if (panelId === null) return { panelId: null, activatedViewId: null }
  // Read the succession result off the tree rather than recomputing it: whatever
  // `removePanelTab` decided is by definition what the user is now looking at.
  return { panelId, activatedViewId: findPanel(plain(draft.layout), panelId)?.activeViewId ?? null }
}

function buildViewState(spec: ViewOpenSpec, ctx: ReduceCtx): ViewState {
  const id = ctx.ids.view()
  // Chat is built elsewhere: everything it decides (no agent session yet, a
  // restrictive default permission mode) is chat policy rather than view
  // plumbing, and it is the one kind with no `connId` to put in `base`.
  if (spec.kind === 'chat') {
    return buildChatViewState(id, ctx.ids.chat(), {
      ...(spec.connId === undefined ? {} : { connId: spec.connId }),
      ...(spec.permissionMode === undefined ? {} : { permissionMode: spec.permissionMode }),
      ...(spec.title === undefined ? {} : { title: spec.title }),
      ...(spec.resumeSessionId === undefined ? {} : { resumeSessionId: spec.resumeSessionId }),
    })
  }
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
    // The kernel builds the envelope and nothing else: `state` is the package's
    // shape, so main stores it as it arrived and lets the package's own schema be
    // the thing that ever looked at it. Defaulting to `{}` rather than leaving it
    // undefined keeps `applyViewPatch`'s merge from having to special-case a
    // view that has never been patched.
    //
    // The two strings come from the answer the bus fetched before this reduction
    // began — the same answer `startPackageFetch` reads a few lines below. They
    // are written here rather than after the fact so that the view is never
    // broadcast without them: a tab that appears with the fallback title and
    // renames itself a moment later is a flicker nobody asked for.
    case 'package': {
      const text = packageTextOf(ctx)
      return {
        ...base,
        ...packageViewOf(spec),
        ...(text === undefined ? {} : { packageText: text }),
      }
    }
  }
}

/**
 * The question a package is asked about a view that does not exist yet.
 *
 * Shared with `buildViewState` above rather than rebuilt in the caller, because
 * the two must agree exactly: whatever `prepare` describes to the package is the
 * view the reducer then creates, and a `state` defaulted in one place and not
 * the other would have the package answering about a view nobody opened.
 */
export function packageViewOf(spec: Extract<ViewOpenSpec, { kind: 'package' }>): PackageViewStateShape {
  return {
    kind: 'package',
    packageKind: spec.packageKind,
    connId: spec.connId,
    state: spec.state ?? {},
  }
}

/**
 * What the package said this view is called and shows, or nothing.
 *
 * `undefined` rather than blank strings when no answer came back: `viewTitle`
 * and `describeView` already fall back for a view nobody can speak for, and a
 * stored empty string would be a worse answer than no answer — it reads as "the
 * package says this view has no name". A view that already had text keeps it,
 * one patch stale, which beats blanking a tab because a host was slow.
 */
export function packageTextOf(ctx: ReduceCtx): PackageViewText | undefined {
  const answer = ctx.prepared?.packageView
  if (answer === undefined) return undefined
  return { title: answer.title, describe: answer.describe }
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
    case 'package':
      return startPackageFetch(draft, view, ctx)
    default:
      return undefined
  }
}

/**
 * What a package view fetches, decided by its own registration.
 *
 * ## Why the package is asked rather than inspected
 *
 * Every branch above reads fields the kernel declared and therefore understands
 * (`view.ref`, `view.text`, `view.queryVec`). A package view's `state` is an
 * opaque record the kernel stores verbatim and has no schema for, so the only
 * honest way to turn it into a fetch is to ask the code that declared it. That
 * code — `ViewKindRegistration.autoFetch` — is also the reason a self-drawn
 * Tier C frame is not a statement-composition surface: the frame can patch
 * `state`, and this is what decides what `state` becomes.
 *
 * ## Why the answer arrives instead of being computed
 *
 * `autoFetch` used to be called right here, in main. It is package code, and
 * package code no longer runs in the process that can decrypt every saved
 * credential (design 2026-08-07 §2.4bis b); it runs in that package's host
 * process, which is on the other side of an asynchronous boundary. A reduction
 * cannot cross one — its synchrony is what makes every check-and-set in these
 * handlers race-free — so the question is asked *before* the reduction, by the
 * command's `prepare` stage, and what reaches here is the answer (§2.4bis e).
 *
 * ## The four ways this returns undefined, and why none of them is an error
 *
 * - **nothing was prepared**: no package could be asked, or none was. That
 *   covers a kind no installed package registers, a host that crashed or timed
 *   out, and a command that opens views without preparing (`layout.split`,
 *   `layout.setLayout` — they open a package view idle, and the next
 *   `view.update` or auto-refresh tick fetches it). A workspace persisted while
 *   a package was installed and restored after it was removed lands here too,
 *   already rendering `view.packageMissing` on screen; failing the Command
 *   instead would make restoring a workspace fail as a whole.
 * - **`autoFetch` returned null**: the registration's own answer, and a
 *   legitimate one — a view that only shows what is in its state. This is the
 *   case the old `default: return undefined` could not tell apart from the first
 *   one, which is why `null` is a declared value rather than a missing field.
 * - **the connection cannot do it**: same rule every built-in gets from
 *   `canFetch`. The view stays idle rather than planning a request the driver is
 *   contractually obliged to reject.
 */
function startPackageFetch(
  draft: Draft<Workspace>,
  view: Draft<PackageViewState>,
  ctx: ReduceCtx,
): ResultId | undefined {
  // Plain data by construction: it came back through a structured clone, so
  // there is no longer any way for a draft proxy to end up inside an effect
  // intent — the hazard the old `plain(view)` call here existed to head off.
  const fetch = ctx.prepared?.packageView?.fetch
  if (fetch === undefined || fetch === null) return undefined
  if (!canFetch(draft, view.connId, fetch.capability)) return undefined

  switch (fetch.capability) {
    case 'tabularQuery': {
      const resultId = beginResult(draft, view, ctx, oneLine(fetch.text))
      ctx.plan({
        type: 'runQuery',
        connId: view.connId,
        viewId: view.id,
        resultId,
        text: fetch.text,
        ...(fetch.params ? { params: [...fetch.params] } : {}),
        ...(fetch.maxRows !== undefined ? { maxRows: fetch.maxRows } : {}),
      })
      return resultId
    }
    case 'collectionScan': {
      const resultId = beginResult(draft, view, ctx, `Scan ${collectionRefLabel(fetch.ref)}`)
      ctx.plan({
        type: 'scan',
        connId: view.connId,
        viewId: view.id,
        resultId,
        ref: fetch.ref,
        offset: fetch.offset ?? 0,
        limit: fetch.limit ?? DEFAULT_PAGE_LIMIT,
      })
      return resultId
    }
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
  view: Draft<FetchingViewState>,
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
  view.resultId = resultId
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
    // Recorded here and never again: when this result fails half a minute from
    // now, the write-back that marks it failed knows only that a driver reported
    // it. Who asked is knowable only at this moment.
    origin: ctx.source,
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
