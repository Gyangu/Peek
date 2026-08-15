import { create } from 'zustand'
import type { PointerEvent as ReactPointerEvent } from 'react'
import type { DropZone, PanelId, TabRect, ViewId } from '@peek/core'
import { dispatch } from '../state/dispatch'
import { useWorkspaceStore } from '../state/workspaceStore'
import {
  IDLE,
  UNPLACED_ORIGIN,
  armDrag,
  cancelDrag,
  isDragging,
  isOverVoid,
  panelDropZone,
  panelTabCaret,
  pointerMoved,
  releaseDrag,
  remeasureDrag,
  tabCaretLine,
  type DragOrigin,
  type DragPoint,
  type DragState,
  type PanelHit,
} from './dragMachine'

/**
 * The live half of view dragging: a registry of panel elements, the pointer
 * plumbing, and a store the panels subscribe to.
 *
 * All the decisions live in `dragMachine.ts`; this file only measures rectangles,
 * listens to events, and dispatches the one Command a release produces. Nothing
 * here writes to the workspace mirror — the layout moves when main's patch
 * arrives, exactly like the divider drag, which paints a guide line and only then
 * sends `layout.setRatio`.
 */

interface DragStoreState {
  drag: DragState
}

export const useDragStore = create<DragStoreState>(() => ({ drag: IDLE }))

/* ================================================================== */
/* 1. Panel registry                                                   */
/* ================================================================== */

const panelEls = new Map<PanelId, HTMLElement>()
const panelHeadEls = new Map<PanelId, HTMLElement>()

/**
 * Panels report their DOM node here so a drag can hit-test against real
 * rectangles. A registry beats `elementFromPoint` because it keeps the geometry
 * in one place we can measure once per gesture, and it does not care what is
 * layered on top of the panel.
 */
export function registerPanelEl(panelId: PanelId, el: HTMLElement | null): void {
  if (el) panelEls.set(panelId, el)
  else panelEls.delete(panelId)
}

/**
 * The same, for the tab strip's band.
 *
 * A second registry rather than a field on the first: the head mounts and
 * unmounts with the panel but is a different element, and a drop needs both its
 * height (to tell a strip drop from a body drop) and the tabs inside it (to
 * resolve the caret).
 */
export function registerPanelHeadEl(panelId: PanelId, el: HTMLElement | null): void {
  if (el) panelHeadEls.set(panelId, el)
  else panelHeadEls.delete(panelId)
}

/**
 * Tabs are found by role rather than by a third registry keyed on ViewId.
 *
 * The strip is a horizontally scrolling container, so a tab's box is the only
 * honest source for where it currently sits; querying the live DOM at
 * measurement time cannot go stale the way a registry written at render time
 * can. Reading `role="tab"` also means the caret is resolved against exactly the
 * elements a screen reader walks — one definition of "the tabs", not two.
 */
function measureTabRects(head: HTMLElement, panelLeft: number): TabRect[] {
  const rects: TabRect[] = []
  for (const el of head.querySelectorAll('[role="tab"]')) {
    const r = el.getBoundingClientRect()
    rects.push({ left: r.left - panelLeft, width: r.width })
  }
  return rects
}

function measurePanels(): PanelHit[] {
  const hits: PanelHit[] = []
  for (const [panelId, el] of panelEls) {
    if (!el.isConnected) continue
    const r = el.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) continue
    const head = panelHeadEls.get(panelId)
    const headRect = head?.isConnected === true ? head.getBoundingClientRect() : null
    hits.push({
      panelId,
      rect: { left: r.left, top: r.top, width: r.width, height: r.height },
      tabBarHeight: headRect === null ? 0 : headRect.height,
      tabRects: head === undefined || headRect === null ? [] : measureTabRects(head, r.left),
    })
  }
  return hits
}

/* ================================================================== */
/* 1b. Keeping the measurement honest while a second writer is active  */
/* ================================================================== */

/**
 * Re-measure after the panels have been laid out again.
 *
 * A workspace patch is applied synchronously inside the store's `setState`, well
 * before React has committed the new tree, so measuring on the spot would read
 * the *old* boxes and cache them as if they were fresh. One animation frame is
 * enough for the commit and the browser's layout pass to have happened; when
 * there is no rAF (tests, a background window) the direct call is still better
 * than keeping geometry that is known to be stale.
 */
function scheduleRemeasure(): void {
  const run = (): void => {
    setDrag(remeasureDrag(useDragStore.getState().drag, measurePanels))
  }
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run)
  else run()
}

/**
 * Watch the workspace revision for the duration of one gesture.
 *
 * The renderer is not the only writer: MCP's `set_layout` and `move_view` and the
 * keyboard split shortcuts all rebuild the tree, and any of them can land while a
 * view is being dragged. Without this, the drag keeps hit-testing against the
 * window as it looked when the gesture started — the highlight is painted in the
 * panel's current position while the drop is decided from its old one, so a
 * release over what is visibly panel A dispatches `toPanelId: panel_b`.
 *
 * Re-measuring rather than cancelling is the deliberate choice: cancelling
 * throws away a gesture the user is still making, while a re-measure is a pure
 * DOM read that leaves the standing rule ("the renderer never updates the layout
 * optimistically") completely intact.
 */
function watchLayoutRevision(): () => void {
  let lastRev = useWorkspaceStore.getState().workspace?.rev ?? -1
  return useWorkspaceStore.subscribe((state) => {
    const rev = state.workspace?.rev ?? -1
    if (rev === lastRev) return
    lastRev = rev
    scheduleRemeasure()
  })
}

/* ================================================================== */
/* 2. Gesture controller                                               */
/* ================================================================== */

/** Body classes carry the two global cursor states; see `styles.css`. */
const BODY_DRAGGING = 'view-dragging'
const BODY_NO_DROP = 'view-drag-nodrop'

let activePointerId: number | null = null

function point(e: PointerEvent | ReactPointerEvent): DragPoint {
  return { x: e.clientX, y: e.clientY }
}

function setDrag(next: DragState): void {
  // The body classes are derived state, so they are reconciled unconditionally —
  // a stale `grabbing` cursor outliving its drag is worse than a redundant
  // `classList.toggle`, which costs nothing when the class is already right.
  document.body.classList.toggle(BODY_DRAGGING, isDragging(next))
  document.body.classList.toggle(BODY_NO_DROP, isOverVoid(next))
  if (useDragStore.getState().drag === next) return
  useDragStore.setState({ drag: next })
}

/**
 * Begin a drag from a tab. Safe to call on every `pointerdown`: it bails on
 * non-primary buttons and on presses that landed on a button (the tab's own ✕,
 * or one of the panel's actions), and a press that never travels
 * `DRAG_THRESHOLD_PX` stays a click.
 *
 * `preventDefault()` is deliberately *not* called — that would suppress the
 * compatibility mouse events, and with them the focus the click is meant to
 * move. Text selection is held off with `user-select` in CSS instead.
 */
export function beginViewDrag(
  e: ReactPointerEvent<HTMLElement>,
  viewId: ViewId,
  fromPanelId: PanelId,
  from: DragOrigin = UNPLACED_ORIGIN,
): void {
  if (e.button !== 0 || activePointerId !== null) return
  if (e.target instanceof Element && e.target.closest('button')) return

  activePointerId = e.pointerId
  const captureEl = e.currentTarget
  try {
    captureEl.setPointerCapture(e.pointerId)
  } catch {
    // Capture is an optimisation (it keeps the pointer stream when the cursor
    // leaves the window); the window listeners below work without it.
  }
  setDrag(armDrag(viewId, fromPanelId, point(e), from))
  const unwatchLayout = watchLayoutRevision()

  const finish = (commit: boolean): void => {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    window.removeEventListener('pointercancel', onAbort)
    window.removeEventListener('lostpointercapture', onAbort)
    window.removeEventListener('keydown', onKey, true)
    window.removeEventListener('blur', onBlur)
    unwatchLayout()
    const pointerId = activePointerId
    activePointerId = null
    if (pointerId !== null && captureEl.hasPointerCapture(pointerId)) {
      captureEl.releasePointerCapture(pointerId)
    }

    const state = useDragStore.getState().drag
    if (!commit) {
      setDrag(cancelDrag())
      return
    }
    // Measured one final time: the command that goes out has to describe the
    // window as it is at the moment of release, not as it was when the drag
    // began — otherwise a layout change that landed a frame ago would send the
    // view to a panel the user is not pointing at.
    const outcome = releaseDrag(state, measurePanels)
    setDrag(outcome.state)
    const command = outcome.command
    if (!command) return
    // Narrowed per member so `dispatch` keeps its per-command input type.
    if (command.name === 'layout.moveView') void dispatch('layout.moveView', command.input)
    else void dispatch('layout.splitWithView', command.input)
  }

  const onMove = (ev: PointerEvent): void => {
    if (ev.pointerId !== activePointerId) return
    setDrag(pointerMoved(useDragStore.getState().drag, point(ev), measurePanels))
  }
  const onUp = (ev: PointerEvent): void => {
    if (ev.pointerId !== activePointerId) return
    finish(true)
  }
  const onAbort = (ev: PointerEvent): void => {
    if (ev.pointerId !== activePointerId) return
    finish(false)
  }
  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key !== 'Escape') return
    // Swallow it: Escape during a drag means "abandon this gesture", not whatever
    // else Escape does in the focused view.
    ev.preventDefault()
    ev.stopPropagation()
    finish(false)
  }
  const onBlur = (): void => {
    finish(false)
  }

  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
  window.addEventListener('pointercancel', onAbort)
  window.addEventListener('lostpointercapture', onAbort)
  window.addEventListener('keydown', onKey, true)
  window.addEventListener('blur', onBlur)
}

/* ================================================================== */
/* 3. Selectors                                                        */
/* ================================================================== */

/**
 * The zone to paint on this panel, or `null`. Returns a plain string so the
 * default `Object.is` equality holds and a panel re-renders only when its own
 * highlight changes — not on every pointer move.
 */
export function usePanelDropZone(panelId: PanelId): DropZone | null {
  return useDragStore((s) => panelDropZone(s.drag, panelId))
}

/**
 * The gap index the insertion line sits in for this panel, or `null`.
 *
 * Scalar for the same reason as the zone above, and separate from
 * `useTabCaretLine` because a panel wants to know *that* it is the strip under
 * the pointer (to stop dimming itself as a mere drag source) without
 * re-rendering every time the line moves a pixel.
 */
export function usePanelTabCaret(panelId: PanelId): number | null {
  return useDragStore((s) => panelTabCaret(s.drag, panelId))
}

/**
 * The insertion line in viewport coordinates, or `null`.
 *
 * Read as three scalars, never as an object: zustand v5 hands the selector's
 * result to `useSyncExternalStore` as the snapshot, and a fresh object each call
 * fails its identity check and re-renders forever.
 */
export function useTabCaretLine(): { x: number; top: number; height: number } | null {
  const x = useDragStore((s) => tabCaretLine(s.drag)?.x ?? null)
  const top = useDragStore((s) => tabCaretLine(s.drag)?.top ?? null)
  const height = useDragStore((s) => tabCaretLine(s.drag)?.height ?? null)
  if (x === null || top === null || height === null) return null
  return { x, top, height }
}

/** True on the panel the dragged view came from, so it can dim itself. */
export function useIsDragSource(panelId: PanelId): boolean {
  return useDragStore((s) => isDragging(s.drag) && s.drag.fromPanelId === panelId)
}

/** The view being dragged, or `null` when no drag is in flight. */
export function useDraggingViewId(): ViewId | null {
  return useDragStore((s) => (isDragging(s.drag) ? s.drag.viewId : null))
}

/** Pointer position for the floating drag label; changes on every move. */
export function useDragPointer(): DragPoint | null {
  const x = useDragStore((s) => (isDragging(s.drag) ? s.drag.pointer.x : null))
  const y = useDragStore((s) => (isDragging(s.drag) ? s.drag.pointer.y : null))
  return x === null || y === null ? null : { x, y }
}
