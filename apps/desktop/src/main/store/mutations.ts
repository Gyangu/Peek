import type { Draft } from 'immer'
import type {
  AutoRefreshStopReason,
  Capability,
  ColumnDef,
  ConnId,
  ConnStatus,
  ConnectionState,
  PanelId,
  PeekError,
  ResultId,
  ResultMeta,
  ServerInfo,
  ViewId,
  ViewState,
  Workspace,
} from '@peek/core'
import { collectPanels } from '@peek/core'
import { clearViewFromPanels } from '../bus/layout-ops'
import { plain } from './workspace-store'

/**
 * The set of pure draft mutations.
 *
 * Both a command handler's pure state phase and the write-back from Connection
 * Manager / driver host events must go through these functions, which is what
 * keeps every state machine transition to a single implementation.
 */

/** Cap on retained result metadata — metadata only, never row data. Past the cap, the oldest finished results are evicted first. */
export const MAX_RESULT_META = 200

/* ------------------------------------------------------------------ */
/* Connections                                                         */
/* ------------------------------------------------------------------ */

export function putConnection(draft: Draft<Workspace>, conn: ConnectionState): void {
  draft.connections[conn.id] = conn as Draft<ConnectionState>
}

/**
 * Write in the three strings the owning package computed for a connection.
 *
 * A second write to a connection the reducer already created, because the
 * reducer cannot wait for them: naming a connection runs in the package's host
 * process now, and a Command reduction is synchronous (design §2.3(b)). The
 * reducer seeds placeholders, this lands the answer, and both changes reach the
 * renderer as ordinary patches.
 *
 * A connection that has gone away in between is not an error — the user may have
 * closed it while the host was still thinking, and there is nothing left to name.
 */
export function setConnectionDisplay(
  draft: Draft<Workspace>,
  connId: ConnId,
  display: { label: string; detail: string; endpoint: string },
): void {
  const conn = draft.connections[connId]
  if (!conn) return
  conn.label = display.label
  conn.detail = display.detail
  conn.endpoint = display.endpoint
}

export interface ConnectionReadyPatch {
  capabilities?: Capability[]
  serverInfo?: ServerInfo
  pid?: number
  readyAt?: number
  error?: PeekError
}

/** Connection state machine transition: idle → connecting → ready / error */
export function setConnectionStatus(
  draft: Draft<Workspace>,
  connId: ConnId,
  status: ConnStatus,
  patch: ConnectionReadyPatch = {},
): void {
  const conn = draft.connections[connId]
  if (!conn) return
  conn.status = status
  if (patch.capabilities) conn.capabilities = [...patch.capabilities]
  if (patch.serverInfo) conn.serverInfo = patch.serverInfo
  if (patch.pid !== undefined) conn.pid = patch.pid
  if (patch.readyAt !== undefined) conn.readyAt = patch.readyAt
  if (patch.error) conn.error = patch.error
  else if (status !== 'error') delete conn.error
}

/**
 * Remove a connection. With `closeViews` true, every view belonging to it is
 * closed as well (and detached from its panel). Returns the closed view ids, for
 * the command result and for the side effects that cancel running result sets.
 */
export function removeConnection(
  draft: Draft<Workspace>,
  connId: ConnId,
  closeViews: boolean,
): { closedViewIds: ViewId[]; abortedResultIds: ResultId[] } {
  const closedViewIds: ViewId[] = []
  if (closeViews) {
    for (const view of Object.values(draft.views)) {
      if (view.connId === connId) closedViewIds.push(view.id)
    }
    for (const viewId of closedViewIds) removeView(draft, viewId)
  }

  const abortedResultIds: ResultId[] = []
  for (const meta of Object.values(draft.results)) {
    if (meta.connId !== connId) continue
    if (meta.status === 'running') {
      abortedResultIds.push(meta.id)
      meta.status = 'cancelled'
    }
  }

  delete draft.connections[connId]
  return { closedViewIds, abortedResultIds }
}

/* ------------------------------------------------------------------ */
/* Views                                                               */
/* ------------------------------------------------------------------ */

export function putView(draft: Draft<Workspace>, view: ViewState): void {
  draft.views[view.id] = view as Draft<ViewState>
}

/** Delete a view and detach it from its panel (the panel itself stays, just empty). */
export function removeView(draft: Draft<Workspace>, viewId: ViewId): PanelId | null {
  const detached = clearViewFromPanels(plain(draft.layout), viewId)
  if (detached.panelId !== null) draft.layout = detached.layout as Draft<Workspace>['layout']
  delete draft.views[viewId]
  return detached.panelId
}

/**
 * Turn auto-refresh on, off, or off-with-a-reason.
 *
 * Two callers, which is why it is here rather than inline in the handler: the
 * `view.update` path (a person or a model saying "every 5 seconds"), and the
 * timer itself in `main/auto-refresh.ts` when it gives up. Both write the same
 * two fields in the same order, and `stoppedBy` only ever survives on a view
 * whose interval is gone — a live interval with a stale reason attached would
 * make the toolbar explain a state it is not in.
 *
 * A view kind that cannot fetch is a silent no-op, and that branch is load-bearing
 * rather than defensive: `ViewPatchSchema` omits the field from those three
 * branches, but zod *strips* unknown keys instead of rejecting them, so the schema
 * guarantees the value never arrives — not that a caller never sent one.
 */
export function setAutoRefresh(
  draft: Draft<Workspace>,
  viewId: ViewId,
  ms: number | null,
  stoppedBy?: AutoRefreshStopReason,
): void {
  const view = draft.views[viewId]
  if (view) setAutoRefreshOn(view, ms, stoppedBy)
}

/** The same write, addressed by the view draft a patch handler already holds. */
export function setAutoRefreshOn(
  view: Draft<ViewState>,
  ms: number | null,
  stoppedBy?: AutoRefreshStopReason,
): void {
  // Narrowed by exclusion rather than by a `RefreshableView` guard: immer's
  // drafts keep the discriminated union, and a type predicate written against
  // `ViewState` does not narrow a `Draft<ViewState>`.
  if (view.kind === 'inspector' || view.kind === 'tree' || view.kind === 'chat') return
  if (ms === null) {
    delete view.autoRefreshMs
    if (stoppedBy === undefined) delete view.autoRefreshStoppedBy
    else view.autoRefreshStoppedBy = stoppedBy
    return
  }
  view.autoRefreshMs = ms
  delete view.autoRefreshStoppedBy
}

/** The still-running result set a view currently holds (cancel it when the view closes or is replaced). */
export function runningResultOf(draft: Draft<Workspace>, viewId: ViewId): ResultId | null {
  const view = draft.views[viewId]
  if (!view || !('resultId' in view) || view.resultId === undefined) return null
  const meta = draft.results[view.resultId]
  return meta && meta.status === 'running' ? meta.id : null
}

/* ------------------------------------------------------------------ */
/* Result metadata (row data only ever travels the MessagePort;         */
/* this is the control plane)                                          */
/* ------------------------------------------------------------------ */

export function startResult(draft: Draft<Workspace>, meta: ResultMeta): void {
  draft.results[meta.id] = meta as Draft<ResultMeta>
  pruneResults(draft)
}

export function setResultSchema(draft: Draft<Workspace>, resultId: ResultId, schema: ColumnDef[]): void {
  const meta = draft.results[resultId]
  if (!meta) return
  meta.schema = schema as Draft<ColumnDef[]>
}

export function setResultProgress(draft: Draft<Workspace>, resultId: ResultId, rows: number): void {
  const meta = draft.results[resultId]
  if (!meta || meta.status !== 'running') return
  meta.rows = rows
}

export interface ResultDonePatch {
  rows: number
  elapsedMs: number
  truncated?: boolean
  nextCursor?: string
}

export function finishResult(draft: Draft<Workspace>, resultId: ResultId, done: ResultDonePatch): void {
  const meta = draft.results[resultId]
  if (!meta) return
  meta.status = 'done'
  meta.rows = done.rows
  meta.elapsedMs = done.elapsedMs
  if (done.truncated !== undefined) meta.truncated = done.truncated

  const view = draft.views[meta.viewId]
  if (view && ownsResult(view, resultId)) {
    view.status = 'ready'
    delete view.error
    // A continuation cursor only means anything for collection browsing
    // (redis SCAN / qdrant scroll).
    if (view.kind === 'table') view.cursorToken = done.nextCursor
  }
}

export interface ResultPausePatch {
  rows: number
  elapsedMs: number
  reason: string
}

/**
 * The result stream paused **by design** (backpressure idle timeout; the driver
 * has already released the server-side cursor and its connection).
 *
 * This is a sibling of `done`, not of `error`:
 * - every row already loaded is **valid**, so the view stays ready (green) and
 *   no red error bar appears;
 * - it is marked truncated + resumable, which is how readers (UI and MCP) know
 *   to say "re-run to keep fetching".
 *
 * One exception: a result set that already reached a terminal state is never
 * overwritten by a pause. When a cancel and a pause race, whichever arrived
 * first wins — a cancel must not be rewritten into a pause.
 */
export function pauseResult(draft: Draft<Workspace>, resultId: ResultId, patch: ResultPausePatch): void {
  const meta = draft.results[resultId]
  if (!meta || meta.status !== 'running') return
  meta.status = 'paused'
  meta.rows = patch.rows
  meta.elapsedMs = patch.elapsedMs
  meta.truncated = true
  meta.resumable = true
  meta.pausedReason = patch.reason
  delete meta.error

  const view = draft.views[meta.viewId]
  if (view && ownsResult(view, resultId)) {
    view.status = 'ready'
    delete view.error
  }
}

/** Whether the view currently holds this result set (inspector / tree views have no resultId field). */
function ownsResult(view: Draft<ViewState>, resultId: ResultId): boolean {
  return 'resultId' in view && view.resultId === resultId
}

/**
 * The result stream terminated abnormally.
 *
 * CANCELLED is judged exactly as cancelResult judges it: **a cancel is not an
 * error**. When the driver host's StreamPump is cancelled, its only way to
 * terminate is to emit result.error(CANCELLED), so that path always lands here.
 * Marking the view as error here would mean the user clicks "cancel" and gets a
 * red error bar, and MCP's read_workspace would report status=error, leading the
 * AI to conclude the query failed. Result metadata and view status are decided in
 * this one place precisely so the two can never disagree.
 */
export function failResult(draft: Draft<Workspace>, resultId: ResultId, error: PeekError): void {
  const cancelled = error.code === 'CANCELLED'
  const meta = draft.results[resultId]
  if (meta) {
    meta.status = cancelled ? 'cancelled' : 'error'
    meta.error = error
  }
  const viewId = meta?.viewId
  if (viewId === undefined) return
  const view = draft.views[viewId]
  if (!view || !ownsResult(view, resultId)) return
  if (cancelled) {
    view.status = 'idle'
    delete view.error
  } else {
    view.status = 'error'
    view.error = error
  }
}

export function cancelResult(draft: Draft<Workspace>, resultId: ResultId): void {
  const meta = draft.results[resultId]
  if (!meta || meta.status !== 'running') return
  meta.status = 'cancelled'
  const view = draft.views[meta.viewId]
  if (view && ownsResult(view, resultId)) {
    view.status = 'idle'
    delete view.error
  }
}

/** Keep only the most recent result metadata; running results and any still referenced by a view are never evicted. */
export function pruneResults(draft: Draft<Workspace>, max: number = MAX_RESULT_META): void {
  const all = Object.values(draft.results)
  if (all.length <= max) return

  const referenced = new Set<string>()
  for (const view of Object.values(draft.views)) {
    if ('resultId' in view && view.resultId !== undefined) referenced.add(view.resultId)
  }

  const droppable = all
    .filter((m) => m.status !== 'running' && !referenced.has(m.id))
    .sort((a, b) => a.startedAt - b.startedAt)

  let overflow = all.length - max
  for (const meta of droppable) {
    if (overflow <= 0) break
    delete draft.results[meta.id]
    overflow -= 1
  }
}

/* ------------------------------------------------------------------ */
/* Focus                                                               */
/* ------------------------------------------------------------------ */

/** Fallback after the focused panel is removed: fall back to the first panel in the tree. */
export function ensureFocusedPanel(draft: Draft<Workspace>): void {
  const panels = collectPanels(plain(draft.layout))
  if (panels.length === 0) {
    draft.focusedPanel = null
    return
  }
  const focused = draft.focusedPanel
  if (focused !== null && panels.some((p) => p.id === focused)) return
  draft.focusedPanel = panels[0].id
}
