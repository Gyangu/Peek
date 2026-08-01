/**
 * What a tool call actually did to the window, derived rather than declared.
 *
 * ## The problem this solves
 *
 * peek's whole premise is that the AI and the human are looking at the same
 * window. But a tool's receipt has always been written from the *inside*: "view.open
 * ran, here is its return value". A model reading that says "I opened a view" —
 * which is true, and useless to the person watching, who wants to know that
 * `public.harness` just appeared in the right-hand pane, and who would quite like
 * to click on it.
 *
 * Computing it by **diffing the workspace snapshot before and after the commands**
 * rather than having each tool announce its own changes buys three things:
 *
 * 1. it is impossible for a tool to lie or to forget. A tool that opens a view as
 *    a side effect of something else reports it too;
 * 2. it catches the *consequences*. `set_layout` with the default unplaced policy
 *    closes views nobody named, and a hand-written receipt would describe the tree
 *    it built rather than the three tabs that vanished;
 * 3. a tool added later gets this for free, which is the difference between a
 *    convention and a property.
 *
 * ## Why the payload matters as much as the prose
 *
 * The embedded chat panel renders the agent's tool calls, and ACP passes a tool's
 * result through to the client verbatim. So the structured half of this — `viewId`,
 * `panelId`, and a ready-made `focus` command — is what lets the chat bubble
 * "Opened public.harness in the right pane" be a *button* that brings that pane
 * forward. The prose half is what the model reads back to the user. Both are
 * generated from the same diff so they cannot disagree.
 */

import {
  collectPanels,
  findParentSplit,
  type LayoutNode,
  type PanelId,
  type ResultMeta,
  type ViewId,
  type ViewSummary,
  type WorkspaceSnapshot,
} from '@peek/core'

/* ================================================================== */
/* 1. The record                                                        */
/* ================================================================== */

export type UiEffectKind =
  | 'view.opened'
  | 'view.closed'
  | 'view.moved'
  | 'view.shown'
  | 'view.hidden'
  | 'view.retitled'
  | 'result.started'
  | 'connection.opened'
  | 'connection.closed'
  | 'focus.moved'

/**
 * One visible consequence of a tool call.
 *
 * `summary` is **always English and always complete on its own** — it is read by
 * the model and quoted to the user, and it is the only field a plain-text client
 * will see. The ids beside it are for a client that can do something with them.
 */
export interface UiEffect {
  kind: UiEffectKind
  summary: string
  viewId?: string
  panelId?: string
  /** Where that panel sits, in words: "the right pane", "pane 2 of 3". */
  panelPlacement?: string
  connId?: string
  resultId?: string
  title?: string
  /**
   * A Command a client may dispatch to put this effect's subject on screen.
   *
   * Present only when there is somewhere to go: a view that was opened, moved or
   * pushed behind another tab. Absent for a view that was closed, because there is
   * nothing left to focus. Spelled as a Command rather than as a bare id so a
   * renderer wires the button up without a lookup table of its own.
   */
  focus?: { command: 'view.activate'; viewId: string }
}

/* ================================================================== */
/* 2. Naming a panel in words                                           */
/* ================================================================== */

/**
 * Describe where a panel is, the way a person would point at it.
 *
 * "The right pane" is what someone says; `root.0.1` is what the tree calls it, and
 * nobody looking at a screen can find a panel from that. The rule is deliberately
 * shallow — it names the panel's position **within its immediate split** and stops
 * there. A deeper description ("the lower half of the right half") is accurate,
 * unreadable, and past the point where a panel id plus a highlight is the better
 * answer anyway.
 */
export function panelPlacement(layout: LayoutNode, panelId: PanelId): string {
  const parent = findParentSplit(layout, panelId)
  if (parent === null) return 'the only pane'
  const index = parent.children.findIndex((c) => c.id === panelId)
  if (index < 0) return 'a pane'
  const count = parent.children.length
  if (count === 2) {
    if (parent.dir === 'row') return index === 0 ? 'the left pane' : 'the right pane'
    return index === 0 ? 'the top pane' : 'the bottom pane'
  }
  const axis = parent.dir === 'row' ? 'left to right' : 'top to bottom'
  return `pane ${String(index + 1)} of ${String(count)} (${axis})`
}

/* ================================================================== */
/* 3. The diff                                                          */
/* ================================================================== */

interface Placement {
  panelId: PanelId | null
  visible: boolean
  title: string
  kind: string
  describe: string
}

function placements(snap: WorkspaceSnapshot): Map<string, Placement> {
  const out = new Map<string, Placement>()
  for (const v of snap.views) {
    out.set(String(v.id), {
      panelId: v.panelId,
      visible: v.visible,
      title: v.title,
      kind: v.kind,
      describe: v.describe,
    })
  }
  return out
}

function viewLabel(v: Placement | ViewSummary): string {
  const title = 'title' in v ? v.title : ''
  return title === '' ? 'a view' : title
}

/**
 * Everything that changed on screen between two snapshots.
 *
 * Ordered by how much a reader cares: things that appeared, then things that
 * moved, then things that went away, then bookkeeping. A model that reads only the
 * first line should have read the most important one.
 */
export function diffUiEffects(before: WorkspaceSnapshot, after: WorkspaceSnapshot): UiEffect[] {
  if (before.rev === after.rev) return []

  const wasThere = placements(before)
  const isThere = placements(after)
  const opened: UiEffect[] = []
  const moved: UiEffect[] = []
  const closed: UiEffect[] = []
  const rest: UiEffect[] = []

  const where = (panelId: PanelId | null): string =>
    panelId === null ? 'no pane (it is open but unplaced)' : panelPlacement(after.layout, panelId)

  for (const [viewId, now] of isThere) {
    const then = wasThere.get(viewId)
    const place = where(now.panelId)
    const at = now.panelId === null ? {} : { panelId: String(now.panelId), panelPlacement: place }

    if (then === undefined) {
      opened.push({
        kind: 'view.opened',
        summary: `Opened ${now.kind} view "${viewLabel(now)}" in ${place} — ${now.describe}`,
        viewId,
        ...at,
        title: now.title,
        focus: { command: 'view.activate', viewId },
      })
      continue
    }
    if (then.panelId !== now.panelId) {
      moved.push({
        kind: 'view.moved',
        summary: `Moved "${viewLabel(now)}" to ${place}`,
        viewId,
        ...at,
        title: now.title,
        focus: { command: 'view.activate', viewId },
      })
      continue
    }
    // Only reported for a view that stayed where it was: a move already implies a
    // visibility change, and saying both would double-count one gesture.
    if (then.visible !== now.visible) {
      moved.push(
        now.visible
          ? {
              kind: 'view.shown',
              summary: `Brought "${viewLabel(now)}" to the front of ${place}`,
              viewId,
              ...at,
              title: now.title,
              focus: { command: 'view.activate', viewId },
            }
          : {
              kind: 'view.hidden',
              summary: `"${viewLabel(now)}" is now a background tab of ${place} and is no longer on screen`,
              viewId,
              ...at,
              title: now.title,
              focus: { command: 'view.activate', viewId },
            },
      )
      continue
    }
    if (then.title !== now.title) {
      rest.push({
        kind: 'view.retitled',
        summary: `Renamed "${then.title}" to "${now.title}"`,
        viewId,
        ...at,
        title: now.title,
      })
    }
  }

  for (const [viewId, then] of wasThere) {
    if (isThere.has(viewId)) continue
    closed.push({
      kind: 'view.closed',
      // No `focus`: there is nothing left to bring forward, and offering a button
      // that would fail is worse than offering none.
      summary: `Closed ${then.kind} view "${viewLabel(then)}"`,
      viewId,
      title: then.title,
    })
  }

  const knownResults = new Set(before.results.map((r) => String(r.id)))
  for (const r of after.results) {
    if (knownResults.has(String(r.id))) continue
    rest.push(resultEffect(r, after))
  }

  const knownConns = new Set(before.connections.map((c) => String(c.id)))
  for (const c of after.connections) {
    if (knownConns.has(String(c.id))) continue
    rest.push({
      kind: 'connection.opened',
      summary: `Connected to ${c.label} (${c.driverId}), status ${c.status}`,
      connId: String(c.id),
    })
  }
  const liveConns = new Set(after.connections.map((c) => String(c.id)))
  for (const c of before.connections) {
    if (liveConns.has(String(c.id))) continue
    rest.push({
      kind: 'connection.closed',
      summary: `Disconnected from ${c.label}`,
      connId: String(c.id),
    })
  }

  if (before.focusedPanel !== after.focusedPanel && after.focusedPanel !== null) {
    rest.push({
      kind: 'focus.moved',
      summary: `The keyboard focus is now on ${panelPlacement(after.layout, after.focusedPanel)}`,
      panelId: String(after.focusedPanel),
      panelPlacement: panelPlacement(after.layout, after.focusedPanel),
    })
  }

  return [...opened, ...moved, ...closed, ...rest]
}

function resultEffect(r: ResultMeta, after: WorkspaceSnapshot): UiEffect {
  const view = after.views.find((v) => v.id === r.viewId)
  const place =
    view === undefined || view.panelId === null ? '' : ` in ${panelPlacement(after.layout, view.panelId)}`
  return {
    kind: 'result.started',
    summary: `Started fetching${place}: ${r.summary ?? 'a result set'} (${r.status})`,
    resultId: String(r.id),
    viewId: String(r.viewId),
    ...(view?.panelId == null ? {} : { panelId: String(view.panelId) }),
    ...(view === undefined
      ? {}
      : { focus: { command: 'view.activate' as const, viewId: String(view.id) } }),
  }
}

/* ================================================================== */
/* 4. Rendering                                                         */
/* ================================================================== */

/**
 * The section appended to a write tool's receipt.
 *
 * The heading is fixed text on purpose. Both a model and a renderer key off it,
 * and a heading that varies with what happened is a heading nobody can match on.
 */
export const UI_EFFECTS_HEADING = 'What changed on screen'

export function renderUiEffects(effects: readonly UiEffect[]): string {
  if (effects.length === 0) return `${UI_EFFECTS_HEADING}: nothing (the window is unchanged).`
  const lines = effects.map((e) => `- ${e.summary}`)
  return `${UI_EFFECTS_HEADING}:\n${lines.join('\n')}`
}

/** Collect only the view ids a client could usefully jump to. */
export function focusTargets(effects: readonly UiEffect[]): ViewId[] {
  const out: ViewId[] = []
  const seen = new Set<string>()
  for (const e of effects) {
    if (e.focus === undefined || seen.has(e.focus.viewId)) continue
    seen.add(e.focus.viewId)
    out.push(e.focus.viewId as ViewId)
  }
  return out
}

/** Panels the window currently has — used by receipts that want to name one. */
export function panelIdsOf(snap: WorkspaceSnapshot): PanelId[] {
  return collectPanels(snap.layout).map((p) => p.id)
}
