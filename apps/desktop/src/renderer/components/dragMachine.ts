import {
  dropZonePlacement,
  isDropEdgeZone,
  resolvePanelDrop,
  tabDropIndex,
  type CommandInput,
  type DropZone,
  type PanelDrop,
  type PanelId,
  type TabRect,
  type ViewId,
} from '@peek/core'

/**
 * The view-drag state machine.
 *
 * Deliberately free of React, zustand and the DOM: everything here is a pure
 * function over plain data, so the whole gesture — threshold, hit testing, zone
 * resolution, cancellation, and the Command that finally goes out — is unit
 * testable without a browser. `dragStore.ts` is the thin layer that feeds it
 * pointer events and rectangles measured from real elements.
 *
 * The one invariant worth stating up front: **this module never mutates the
 * workspace and never produces an optimistic update.** Its output is at most one
 * Command, handed to `dispatch` on release; the layout tree does not move until
 * main broadcasts a patch.
 */

/* ================================================================== */
/* 1. Geometry helpers                                                 */
/* ================================================================== */

/**
 * How far the pointer must travel before a press on a panel head becomes a drag.
 *
 * Without it every click on the title bar would start a (zero-length) drag and
 * fight with `layout.focus`; 4px is the same order as the divider's own slop and
 * is below the noise floor of a deliberate click, even on a trackpad.
 */
export const DRAG_THRESHOLD_PX = 4

export interface DragPoint {
  /** Viewport coordinates, i.e. `PointerEvent.clientX` / `clientY`. */
  x: number
  y: number
}

/** A panel's rectangle in viewport coordinates — `getBoundingClientRect()`, narrowed. */
export interface PanelRect {
  left: number
  top: number
  width: number
  height: number
}

/**
 * One candidate drop target: a panel, where it currently sits on screen, and the
 * geometry of its tab strip.
 *
 * The strip has to be measured with the panel rather than looked up later: the
 * hit test decides between "a zone of the body" and "a gap between two tabs" from
 * one point, and the two answers cannot come from geometry read at two different
 * instants — a re-measure mid-gesture would otherwise leave the caret describing
 * a strip that has since scrolled.
 *
 * Both tab fields are optional so that a panel can be described without one: a
 * test fixture, or a panel measured before its strip has laid out. Absent means a
 * band of zero height, which resolves every point through the five body zones —
 * exactly the pre-tab behaviour.
 */
export interface PanelHit {
  panelId: PanelId
  rect: PanelRect
  /** Height of the tab strip band along the panel's top edge. */
  tabBarHeight?: number
  /** Tab extents in panel-local x, in tab-bar order. */
  tabRects?: readonly TabRect[]
}

function tabBarHeightOf(hit: PanelHit): number {
  return hit.tabBarHeight ?? 0
}

function tabRectsOf(hit: PanelHit): readonly TabRect[] {
  return hit.tabRects ?? []
}

export function pointInRect(rect: PanelRect, point: DragPoint): boolean {
  return (
    point.x >= rect.left &&
    point.x <= rect.left + rect.width &&
    point.y >= rect.top &&
    point.y <= rect.top + rect.height
  )
}

/**
 * The panel under the pointer, or `null` when the pointer is over the sidebar,
 * the status bar, or anywhere else outside the layout.
 *
 * Panels never overlap, so first match wins and the order of `panels` only
 * matters on a shared edge — where either answer describes the same pixel.
 */
export function hitPanel(panels: readonly PanelHit[], point: DragPoint): PanelHit | null {
  for (const panel of panels) {
    if (pointInRect(panel.rect, point)) return panel
  }
  return null
}

export function distance(a: DragPoint, b: DragPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

/* ================================================================== */
/* 2. States                                                           */
/* ================================================================== */

/**
 * Where a drop would land: a panel, plus which part of it the pointer is in —
 * one of the five body zones, or a gap in the tab strip.
 */
export interface DragTarget {
  panelId: PanelId
  drop: PanelDrop
}

/**
 * What the dragged view was doing before it was picked up.
 *
 * Both fields exist for one decision each, and both are about the *source*
 * panel, so neither can be recovered from the pointer:
 *
 * - `index` is what turns a caret into a `layout.moveView` index when the drop
 *   lands back on the panel the drag started from (see `tabDropIndex`);
 * - `active` is what makes "dropped exactly where it was" a no-op only when the
 *   view was already the visible tab. Dragging a *background* tab back onto its
 *   own slot still activates it, and that is a change worth sending.
 */
export interface DragOrigin {
  /** The view's index in its source panel's tab bar; null when it was unplaced. */
  index: number | null
  /** Whether it was its panel's active tab. */
  active: boolean
}

/** An unplaced view: no slot to return to, and nothing on screen to leave unchanged. */
export const UNPLACED_ORIGIN: DragOrigin = { index: null, active: true }

export interface DragIdle {
  phase: 'idle'
}

/**
 * The pointer is down on a panel head but has not moved far enough to be a drag.
 * Nothing is drawn in this phase — it is indistinguishable from a click until the
 * threshold is crossed.
 */
export interface DragArmed {
  phase: 'armed'
  viewId: ViewId
  /** The panel the view is being dragged out of; `null` for an unplaced view. */
  fromPanelId: PanelId | null
  /** The tab the view was: its index in `fromPanelId`, and whether it was showing. */
  from: DragOrigin
  origin: DragPoint
  pointer: DragPoint
}

export interface DragActive {
  phase: 'dragging'
  viewId: ViewId
  fromPanelId: PanelId | null
  from: DragOrigin
  origin: DragPoint
  pointer: DragPoint
  /** `null` while the pointer is outside every panel. */
  target: DragTarget | null
  /** Panel rectangles, measured once when the drag started. */
  panels: readonly PanelHit[]
}

export type DragState = DragIdle | DragArmed | DragActive

export const IDLE: DragIdle = { phase: 'idle' }

export function isDragging(state: DragState): state is DragActive {
  return state.phase === 'dragging'
}

/* ================================================================== */
/* 3. Transitions                                                      */
/* ================================================================== */

/** `idle → armed`. Called from `pointerdown` on a tab. */
export function armDrag(
  viewId: ViewId,
  fromPanelId: PanelId | null,
  origin: DragPoint,
  from: DragOrigin = UNPLACED_ORIGIN,
): DragArmed {
  return { phase: 'armed', viewId, fromPanelId, from, origin, pointer: origin }
}

/**
 * `armed → armed | dragging`, `dragging → dragging`.
 *
 * The panel rectangles are captured when the threshold is crossed and then
 * reused, because a pointer move on its own cannot have changed them —
 * re-measuring per event would buy a forced reflow and nothing else.
 *
 * What *can* change them is a second writer: an MCP `set_layout` or `move_view`,
 * or a keyboard split from another window. Those are picked up by
 * `remeasureDrag` instead, driven by the workspace revision rather than by the
 * pointer (see `dragStore.ts`), and the release re-measures once more before it
 * decides. Caching here is therefore an optimisation over *when* to measure, not
 * an assumption that the layout is frozen.
 */
export function pointerMoved(
  state: DragState,
  pointer: DragPoint,
  measurePanels: () => readonly PanelHit[],
): DragState {
  if (state.phase === 'idle') return state

  if (state.phase === 'armed') {
    if (distance(state.origin, pointer) < DRAG_THRESHOLD_PX) {
      return state.pointer.x === pointer.x && state.pointer.y === pointer.y ? state : { ...state, pointer }
    }
    const panels = measurePanels()
    return {
      phase: 'dragging',
      viewId: state.viewId,
      fromPanelId: state.fromPanelId,
      from: state.from,
      origin: state.origin,
      pointer,
      target: resolveTarget(panels, pointer),
      panels,
    }
  }

  const target = resolveTarget(state.panels, pointer)
  if (state.pointer.x === pointer.x && state.pointer.y === pointer.y && sameTarget(state.target, target)) {
    return state
  }
  return { ...state, pointer, target }
}

/** Which panel, and which part of it, a viewport point falls into. */
export function resolveTarget(panels: readonly PanelHit[], pointer: DragPoint): DragTarget | null {
  const hit = hitPanel(panels, pointer)
  if (!hit) return null
  return {
    panelId: hit.panelId,
    drop: resolvePanelDrop(
      {
        width: hit.rect.width,
        height: hit.rect.height,
        tabBarHeight: tabBarHeightOf(hit),
        tabRects: tabRectsOf(hit),
      },
      pointer.x - hit.rect.left,
      pointer.y - hit.rect.top,
    ),
  }
}

function sameDrop(a: PanelDrop, b: PanelDrop): boolean {
  if (a.kind === 'tab') return b.kind === 'tab' && a.caret === b.caret
  return b.kind === 'zone' && a.zone === b.zone
}

function sameTarget(a: DragTarget | null, b: DragTarget | null): boolean {
  if (a === null || b === null) return a === b
  return a.panelId === b.panelId && sameDrop(a.drop, b.drop)
}

function sameTabRects(a: readonly TabRect[], b: readonly TabRect[]): boolean {
  if (a.length !== b.length) return false
  return a.every((rect, i) => rect.left === b[i].left && rect.width === b[i].width)
}

function samePanels(a: readonly PanelHit[], b: readonly PanelHit[]): boolean {
  if (a.length !== b.length) return false
  return a.every((hit, i) => {
    const other = b[i]
    return (
      hit.panelId === other.panelId &&
      hit.rect.left === other.rect.left &&
      hit.rect.top === other.rect.top &&
      hit.rect.width === other.rect.width &&
      hit.rect.height === other.rect.height &&
      // The strip counts as geometry: a tab closing elsewhere moves every caret
      // in that panel, and a stale rect would draw the insertion line in a gap
      // the drop no longer refers to.
      tabBarHeightOf(hit) === tabBarHeightOf(other) &&
      sameTabRects(tabRectsOf(hit), tabRectsOf(other))
    )
  })
}

/**
 * `dragging → dragging` against freshly measured rectangles, keeping the pointer
 * where it is.
 *
 * The renderer is not the only writer of the layout: while a hand holds a view
 * mid-air, an MCP `set_layout` can rebuild the whole tree, and a keyboard split
 * can move every panel on screen. The rectangles captured when the drag started
 * then describe a window that no longer exists — and because the highlight is
 * drawn in the panel's own coordinates while the hit test uses the cached box,
 * the preview and the command would disagree: the user would see the highlight
 * on the panel under the cursor and the drop would land somewhere else.
 *
 * This is a read of the DOM and nothing more. No optimistic update: the layout
 * still moves only when main's patch arrives — this just stops the gesture from
 * arguing with a layout that has already moved.
 */
export function remeasureDrag(state: DragState, measurePanels: () => readonly PanelHit[]): DragState {
  if (!isDragging(state)) return state
  const panels = measurePanels()
  const target = resolveTarget(panels, state.pointer)
  // Referential stability: the common case is that nothing under the pointer
  // actually moved, and every panel subscribes to this store.
  if (samePanels(state.panels, panels) && sameTarget(state.target, target)) return state
  return { ...state, panels, target }
}

/** Esc, `pointercancel`, lost capture, or an unmounted source — all end the same way. */
export function cancelDrag(): DragIdle {
  return IDLE
}

export interface DropOutcome {
  state: DragIdle
  /** The single Command to dispatch, or `null` when the gesture was a no-op. */
  command: DropCommand | null
}

/**
 * `dragging → idle`, reporting the Command the release earned (possibly none).
 *
 * `measurePanels` is optional but should always be supplied by real callers: one
 * last measurement is what guarantees the dispatched command matches the window
 * as it stands at the instant of release, rather than as it stood when the drag
 * began. Tests that drive the machine with fixed rectangles omit it.
 */
export function releaseDrag(state: DragState, measurePanels?: () => readonly PanelHit[]): DropOutcome {
  const fresh = measurePanels === undefined ? state : remeasureDrag(state, measurePanels)
  return { state: IDLE, command: dropCommandFor(fresh) }
}

/* ================================================================== */
/* 4. Zone → Command                                                   */
/* ================================================================== */

/**
 * The Command a drop produces. A discriminated union rather than a bare pair so
 * that the caller narrows on `name` and `dispatch` still type-checks its input —
 * no casts, no `any`.
 */
export type DropCommand =
  | { name: 'layout.moveView'; input: CommandInput<'layout.moveView'> }
  | { name: 'layout.splitWithView'; input: CommandInput<'layout.splitWithView'> }

/**
 * Whether the view being dragged is the only tab of the panel it came from.
 *
 * This is the one fact that decides whether an edge drop on the *source* panel
 * is real work or churn, and it is read from `panels` — the geometry measured
 * when the gesture started and refreshed by `remeasureDrag` — rather than from a
 * field on `DragOrigin`, so the judgement, the highlight and the caret all come
 * from one snapshot. An absent strip (a test fixture, or a panel measured before
 * its head laid out) counts as lone, which is the pre-tab behaviour.
 */
function sourceIsLoneTab(state: DragActive): boolean {
  const hit = state.panels.find((p) => p.panelId === state.fromPanelId)
  return (hit === undefined ? [] : tabRectsOf(hit)).length <= 1
}

/**
 * The Command for the current target, or `null` when releasing here would change
 * nothing.
 *
 * ## What a gesture can ask for
 *
 * Three things, and only three:
 * - **body centre** → append as a tab and show it. This replaces M2's centre =
 *   swap. Stacking displaces nothing, so there is no second view to catch and
 *   nowhere for it to be silently unmounted to; the end of the strip is where
 *   the eye expects a new thing to appear, and the user let go because they want
 *   to look at it, so it activates.
 * - **body edge** → split, unchanged from M2.
 * - **tab strip** → insert at the caret, which is also how a tab is reordered
 *   inside its own panel.
 *
 * `onOccupied` is spelled out as `'stack'` rather than left to the default: it
 * is the whole of the semantic change, and a future flip of the default must not
 * quietly turn every drag into a swap. `'swap'` and `'replace'` remain reachable
 * as Commands (an AI can name them) but **no gesture produces them** — a
 * modifier-drag would be undiscoverable, and replace would close somebody else's
 * view without being asked.
 *
 * ## What produces `null`
 *
 * - the pointer is outside every panel (the sidebar, the status bar, off-window);
 * - the source panel's **body centre**: that is where the view already is;
 * - the source panel's **body edges**, but only while the view is that panel's
 *   only tab — then the split would create a panel, the move would empty the
 *   source next to it, and the collapse would put the tree back where it started
 *   (invariant I6). With a neighbour left behind nothing is emptied, nothing
 *   collapses, and "pull this tab out beside its neighbours" is a real split —
 *   which is also the condition `splitPanelWithView` checks on the main side;
 * - the source panel's **strip**, but only at the caret the view already
 *   occupies, and only when it was already the active tab. This is the rule the
 *   pre-tab contract got to state unconditionally, and it no longer holds
 *   unconditionally: dropping a view on the panel it is already in is exactly
 *   how tabs are reordered.
 */
export function dropCommandFor(state: DragState): DropCommand | null {
  if (!isDragging(state) || !state.target) return null
  const { target } = state
  const samePanel = target.panelId === state.fromPanelId

  if (target.drop.kind === 'tab') {
    const fromIndex = samePanel ? state.from.index : null
    const index = tabDropIndex(target.drop.caret, fromIndex)
    if (samePanel && index === fromIndex && state.from.active) return null
    return {
      name: 'layout.moveView',
      input: {
        viewId: state.viewId,
        toPanelId: target.panelId,
        index,
        activate: true,
        onOccupied: 'stack',
      },
    }
  }

  if (samePanel && (!isDropEdgeZone(target.drop.zone) || sourceIsLoneTab(state))) return null

  if (isDropEdgeZone(target.drop.zone)) {
    const { dir, insert } = dropZonePlacement(target.drop.zone)
    return {
      name: 'layout.splitWithView',
      input: { viewId: state.viewId, panelId: target.panelId, dir, insert },
    }
  }
  // No `index`: appending is the default, and naming the end of a strip whose
  // length this module does not know would be a guess.
  return {
    name: 'layout.moveView',
    input: {
      viewId: state.viewId,
      toPanelId: target.panelId,
      activate: true,
      onOccupied: 'stack',
    },
  }
}

/* ================================================================== */
/* 5. Rendering queries                                                */
/* ================================================================== */

/**
 * The body zone to paint on `panelId`, or `null` for no highlight.
 *
 * The source panel is excluded exactly where `dropCommandFor` returns `null` —
 * its centre always, its edges only while the dragged view is its only tab —
 * because promising a split that will immediately collapse would be a lie. The
 * excluded zones get the `drag-source` treatment instead: dimmed, but never
 * `no-drop`, which would read as an error when the gesture is merely idempotent.
 *
 * Its **strip** is not excluded, and that is the change tabs force: reordering
 * happens entirely inside one panel, so suppressing its feedback would leave the
 * commonest tab gesture with no preview at all. The strip's feedback is the
 * caret below, not a highlight block, which is why this function returns `null`
 * for every tab drop regardless of panel.
 */
export function panelDropZone(state: DragState, panelId: PanelId): DropZone | null {
  if (!isDragging(state) || !state.target) return null
  if (state.target.panelId !== panelId) return null
  if (state.target.drop.kind === 'tab') return null
  if (panelId === state.fromPanelId) {
    if (!isDropEdgeZone(state.target.drop.zone) || sourceIsLoneTab(state)) return null
  }
  return state.target.drop.zone
}

/** The insertion caret to draw in `panelId`'s strip, or `null`. Source panel included. */
export function panelTabCaret(state: DragState, panelId: PanelId): number | null {
  if (!isDragging(state) || !state.target) return null
  if (state.target.panelId !== panelId) return null
  return state.target.drop.kind === 'tab' ? state.target.drop.caret : null
}

/** Where the insertion line goes, in viewport coordinates. */
export interface TabCaretLine {
  x: number
  top: number
  height: number
}

/**
 * The insertion line for the current target, in viewport coordinates, or `null`.
 *
 * Derived from the very rectangles the caret was resolved against rather than
 * from the DOM, so the line cannot end up in a different gap from the one the
 * drop will use. It is clamped into the panel because the caret past the last
 * tab of a full strip lands on the strip's right edge, and a line drawn a pixel
 * outside would be clipped away exactly when it matters most.
 */
export function tabCaretLine(state: DragState): TabCaretLine | null {
  if (!isDragging(state)) return null
  const target = state.target
  if (!target || target.drop.kind !== 'tab') return null
  const hit = state.panels.find((p) => p.panelId === target.panelId)
  if (!hit) return null
  const rects = tabRectsOf(hit)
  const at = rects[target.drop.caret]
  const last = rects[rects.length - 1]
  const localX = at ? at.left : last ? last.left + last.width : 0
  const height = tabBarHeightOf(hit) || hit.rect.height
  return {
    x: hit.rect.left + Math.min(Math.max(localX, 0), hit.rect.width),
    top: hit.rect.top,
    height,
  }
}

/** True while the pointer is over no panel at all — the cursor turns `no-drop`. */
export function isOverVoid(state: DragState): boolean {
  return isDragging(state) && state.target === null
}
