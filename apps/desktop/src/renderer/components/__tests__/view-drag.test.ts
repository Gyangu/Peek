import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { PanelIdSchema, ViewIdSchema, type DropZone, type PanelId, type ViewId } from '@peek/core'
import {
  DRAG_THRESHOLD_PX,
  IDLE,
  armDrag,
  cancelDrag,
  dropCommandFor,
  hitPanel,
  isDragging,
  isOverVoid,
  panelDropZone,
  panelTabCaret,
  pointerMoved,
  releaseDrag,
  remeasureDrag,
  resolveTarget,
  tabCaretLine,
  type DragOrigin,
  type DragState,
  type PanelHit,
} from '../dragMachine'

/* ==================================================================
 * The drag gesture as a state machine: idle → armed → dragging → dropped or
 * cancelled.
 *
 * Everything the gesture decides is decided here — when a press becomes a drag,
 * which panel is under the pointer, which zone of it, and which single Command
 * (if any) the release earns. `dragStore.ts` only supplies pointer events and
 * measured rectangles, so pinning this down covers the interesting half without
 * a browser.
 *
 * The rule the whole design hangs on: **a drag produces at most one Command and
 * never an optimistic update.** The last suite guards that structurally.
 * ================================================================== */

const A = PanelIdSchema.parse('panel_a')
const B = PanelIdSchema.parse('panel_b')
const C = PanelIdSchema.parse('panel_c')
const V = ViewIdSchema.parse('view_1')

/** Three panels side by side, 400x300 each, no gaps. */
const PANELS: PanelHit[] = [
  { panelId: A, rect: { left: 0, top: 0, width: 400, height: 300 } },
  { panelId: B, rect: { left: 400, top: 0, width: 400, height: 300 } },
  { panelId: C, rect: { left: 800, top: 0, width: 400, height: 300 } },
]

const measure = (): PanelHit[] => PANELS

/** Arm on A and drag to a viewport point, in one step. */
function dragTo(x: number, y: number, viewId: ViewId = V, from: PanelId | null = A): DragState {
  const armed = armDrag(viewId, from, { x: 0, y: 0 })
  return pointerMoved(armed, { x, y }, measure)
}

describe('idle → armed → dragging: the threshold', () => {
  it('a press alone arms nothing visible', () => {
    const armed = armDrag(V, A, { x: 100, y: 100 })
    assert.equal(armed.phase, 'armed')
    assert.equal(isDragging(armed), false)
    // Nothing is painted yet, so a press is indistinguishable from a click.
    assert.equal(panelDropZone(armed, A), null)
    assert.equal(panelDropZone(armed, B), null)
    assert.equal(dropCommandFor(armed), null)
  })

  it('stays armed below the threshold — a click must not become a drag', () => {
    const armed = armDrag(V, A, { x: 100, y: 100 })
    const jitter = pointerMoved(armed, { x: 100 + DRAG_THRESHOLD_PX - 1, y: 100 }, measure)
    assert.equal(jitter.phase, 'armed')
    assert.equal(dropCommandFor(jitter), null)
  })

  it('becomes a drag once the pointer has travelled the threshold', () => {
    const armed = armDrag(V, A, { x: 100, y: 100 })
    const dragging = pointerMoved(armed, { x: 100 + DRAG_THRESHOLD_PX, y: 100 }, measure)
    assert.equal(dragging.phase, 'dragging')
    assert.ok(isDragging(dragging))
    assert.equal(dragging.viewId, V)
    assert.equal(dragging.fromPanelId, A)
  })

  it('measures the panels once per gesture, not once per pointer event', () => {
    // A pointer move cannot have moved a panel, so re-measuring on each one would
    // buy a forced reflow and nothing else. Measurement is invalidated by the
    // events that *can* move a panel instead — see `remeasureDrag` below.
    let calls = 0
    const counted = (): PanelHit[] => {
      calls += 1
      return PANELS
    }
    let state: DragState = armDrag(V, A, { x: 100, y: 100 })
    state = pointerMoved(state, { x: 102, y: 100 }, counted) // below threshold
    assert.equal(calls, 0)
    state = pointerMoved(state, { x: 500, y: 150 }, counted)
    state = pointerMoved(state, { x: 600, y: 150 }, counted)
    state = pointerMoved(state, { x: 900, y: 150 }, counted)
    assert.equal(calls, 1)
  })

  it('a move on an idle machine changes nothing', () => {
    assert.equal(pointerMoved(IDLE, { x: 10, y: 10 }, measure), IDLE)
  })

  it('returns the same object when neither the pointer nor the target moved', () => {
    // Referential stability is what keeps the store from waking every panel on a
    // duplicated pointer event.
    const dragging = dragTo(500, 150)
    assert.equal(pointerMoved(dragging, { x: 500, y: 150 }, measure), dragging)
  })
})

describe('hit testing', () => {
  it('finds the panel containing the point', () => {
    assert.equal(hitPanel(PANELS, { x: 200, y: 150 })?.panelId, A)
    assert.equal(hitPanel(PANELS, { x: 500, y: 150 })?.panelId, B)
    assert.equal(hitPanel(PANELS, { x: 1000, y: 150 })?.panelId, C)
  })

  it('returns null outside every panel — the sidebar, the status bar, off-window', () => {
    assert.equal(hitPanel(PANELS, { x: -30, y: 150 }), null)
    assert.equal(hitPanel(PANELS, { x: 600, y: 900 }), null)
    assert.equal(hitPanel(PANELS, { x: 5000, y: 5000 }), null)
    assert.equal(resolveTarget(PANELS, { x: 600, y: 900 }), null)
  })

  it('resolves the zone in panel-local coordinates', () => {
    // 405 is 5px into B, i.e. B's left band — not B's centre and not A.
    assert.deepEqual(resolveTarget(PANELS, { x: 405, y: 150 }), {
      panelId: B,
      drop: { kind: 'zone', zone: 'left' },
    })
    assert.deepEqual(resolveTarget(PANELS, { x: 600, y: 150 }), {
      panelId: B,
      drop: { kind: 'zone', zone: 'center' },
    })
    assert.deepEqual(resolveTarget(PANELS, { x: 600, y: 4 }), {
      panelId: B,
      drop: { kind: 'zone', zone: 'top' },
    })
  })
})

describe('drop → Command', () => {
  it('a centre drop stacks the view as a tab and shows it', () => {
    // This overturns M2, where the centre of an occupied panel swapped the two
    // views. Stacking displaces nothing, so there is no second view to catch;
    // `index` is absent because appending is the default and the end of the strip
    // is where the eye expects a new tab.
    const cmd = dropCommandFor(dragTo(600, 150))
    assert.deepEqual(cmd, {
      name: 'layout.moveView',
      input: { viewId: V, toPanelId: B, activate: true, onOccupied: 'stack' },
    })
  })

  it('no gesture anywhere on any panel asks for a swap', () => {
    // `swap` survives as a Command mode an AI can name, and it is deliberately
    // unreachable from the mouse: a modifier-drag for it would be undiscoverable,
    // and stacking is strictly less surprising. The M2 centre-drop swap is gone.
    for (const panel of PANELS) {
      for (let x = 0; x <= panel.rect.width; x += 13) {
        for (let y = 0; y <= panel.rect.height; y += 13) {
          const cmd = dropCommandFor(dragTo(panel.rect.left + x, panel.rect.top + y))
          if (cmd?.name === 'layout.moveView') assert.notEqual(cmd.input.onOccupied, 'swap')
        }
      }
    }
  })

  it('each edge drop splits the target the way the preview promised', () => {
    const cases: [number, number, DropZone, 'row' | 'col', 'before' | 'after'][] = [
      [405, 150, 'left', 'row', 'before'],
      [795, 150, 'right', 'row', 'after'],
      [600, 4, 'top', 'col', 'before'],
      [600, 296, 'bottom', 'col', 'after'],
    ]
    for (const [x, y, zone, dir, insert] of cases) {
      const state = dragTo(x, y)
      assert.equal(panelDropZone(state, B), zone)
      assert.deepEqual(dropCommandFor(state), {
        name: 'layout.splitWithView',
        input: { viewId: V, panelId: B, dir, insert },
      })
    }
  })

  it('never asks for onOccupied: replace, anywhere on any panel', () => {
    // Replace would silently close somebody else's view. Stacking loses nothing
    // and is its own undo, which is the entire reason the drag exists.
    for (const panel of PANELS) {
      for (let x = 0; x <= panel.rect.width; x += 13) {
        for (let y = 0; y <= panel.rect.height; y += 13) {
          const cmd = dropCommandFor(dragTo(panel.rect.left + x, panel.rect.top + y))
          if (cmd?.name === 'layout.moveView') assert.equal(cmd.input.onOccupied, 'stack')
        }
      }
    }
  })

  it('always carries the view that was picked up', () => {
    const other = ViewIdSchema.parse('view_2')
    for (const [x, y] of [
      [600, 150],
      [405, 150],
      [1000, 296],
    ] as const) {
      const cmd = dropCommandFor(dragTo(x, y, other))
      assert.equal(cmd?.input.viewId, other)
    }
  })
})

describe('no-ops and cancellation — none of these send a Command', () => {
  it('dropping on the panel the view came from is a no-op, not an error', () => {
    // Centre is plainly identity; an edge drop on your own panel is too *while
    // the view is its only tab*, because the split empties the source and
    // collapses it straight back (invariant I6). These panels are measured
    // without a strip, which is exactly that case — see the tearing-out suite
    // below for what a second tab changes.
    for (const [x, y] of [
      [200, 150],
      [4, 150],
      [396, 150],
      [200, 4],
      [200, 296],
    ] as const) {
      const state = dragTo(x, y)
      assert.equal(dropCommandFor(state), null, `(${String(x)},${String(y)}) should be a no-op`)
      // And it draws no highlight: promising a split that will immediately
      // collapse would be a lie.
      assert.equal(panelDropZone(state, A), null)
      // But it is not `no-drop` either — nothing is forbidden, it just does nothing.
      assert.equal(isOverVoid(state), false)
    }
  })

  it('releasing outside every panel sends nothing and reads as no-drop', () => {
    const state = dragTo(600, 900)
    assert.ok(isDragging(state))
    assert.equal(state.target, null)
    assert.equal(isOverVoid(state), true)
    assert.equal(releaseDrag(state).command, null)
  })

  it('Escape (and a cancelled pointer) drops the gesture on the floor', () => {
    const state = dragTo(600, 150)
    assert.notEqual(dropCommandFor(state), null) // it *would* have moved
    assert.equal(cancelDrag().phase, 'idle')
  })

  it('releasing before the threshold sends nothing', () => {
    const armed = armDrag(V, A, { x: 100, y: 100 })
    assert.deepEqual(releaseDrag(armed), { state: IDLE, command: null })
    assert.deepEqual(releaseDrag(IDLE), { state: IDLE, command: null })
  })

  it('a release always returns to idle, whether or not it produced a Command', () => {
    assert.equal(releaseDrag(dragTo(600, 150)).state.phase, 'idle')
    assert.equal(releaseDrag(dragTo(200, 150)).state.phase, 'idle')
    assert.equal(releaseDrag(dragTo(600, 900)).state.phase, 'idle')
  })
})

describe('a second writer moves the layout mid-gesture', () => {
  /* The renderer is not the only thing that rearranges panels: MCP's set_layout
   * and move_view rewrite the tree whenever the model decides to, and the
   * keyboard split shortcuts do it from this window. Any of them can land while
   * a view is in mid-air, and the rectangles captured when the drag began then
   * describe a window that no longer exists. */

  /** The same three panels, but A and B have swapped places. */
  const SWAPPED: PanelHit[] = [
    { panelId: B, rect: { left: 0, top: 0, width: 400, height: 300 } },
    { panelId: A, rect: { left: 400, top: 0, width: 400, height: 300 } },
    { panelId: C, rect: { left: 800, top: 0, width: 400, height: 300 } },
  ]

  it('re-measuring retargets the pointer at whatever is under it now', () => {
    // Dragging view_1 out of A, hovering the right half of the screen — B.
    let state = dragTo(600, 150)
    assert.deepEqual(panelDropZone(state, B), 'center')

    // An MCP set_layout swaps the two columns. Without a re-measure the gesture
    // still believes the right half is B, so the highlight would be painted over
    // a panel the drop no longer refers to.
    state = remeasureDrag(state, () => SWAPPED)
    assert.equal(panelDropZone(state, B), null)
    assert.equal(panelDropZone(state, A), null, 'A is the source panel: no highlight, and no command')
    assert.equal(dropCommandFor(state), null, 'the pointer now sits over the panel the view came from')
  })

  it('a release re-measures, so the command describes the window as it is now', () => {
    const state = dragTo(600, 150)
    // Stale geometry would send the view to B — which is now on the far side of
    // the screen from the cursor.
    assert.deepEqual(releaseDrag(state).command, {
      name: 'layout.moveView',
      input: { viewId: V, toPanelId: B, activate: true, onOccupied: 'stack' },
    })
    // Measured at the moment of release, the pointer is over A, the source panel,
    // and the honest answer is that this drop does nothing.
    assert.equal(releaseDrag(state, () => SWAPPED).command, null)
  })

  it('re-measuring while the pointer is over a panel that has been closed drops the target', () => {
    const state = dragTo(1000, 150) // over C
    assert.equal(panelDropZone(state, C), 'center')
    const withoutC = remeasureDrag(state, () => PANELS.slice(0, 2))
    assert.equal(withoutC.phase, 'dragging')
    assert.equal(panelDropZone(withoutC, C), null)
    assert.equal(isOverVoid(withoutC), true, 'nothing is under the pointer any more')
    assert.equal(releaseDrag(withoutC).command, null, 'and a release over nothing sends nothing')
  })

  it('re-measuring is inert when nothing actually moved', () => {
    // Referential stability matters here: every panel subscribes to this state,
    // and a workspace revision bumps on changes that touch no panel at all — a
    // query finishing, a connection going ready.
    const state = dragTo(600, 150)
    assert.equal(remeasureDrag(state, () => PANELS.map((p) => ({ ...p }))), state)
  })

  it('re-measuring an idle or armed machine is a no-op', () => {
    assert.equal(remeasureDrag(IDLE, () => SWAPPED), IDLE)
    const armed = armDrag(V, A, { x: 100, y: 100 })
    assert.equal(remeasureDrag(armed, () => SWAPPED), armed)
  })
})

describe('what the panels paint', () => {
  it('highlights exactly one panel — the one under the pointer', () => {
    const state = dragTo(600, 150)
    assert.equal(panelDropZone(state, A), null)
    assert.equal(panelDropZone(state, B), 'center')
    assert.equal(panelDropZone(state, C), null)
  })

  it('paints nothing at all while the pointer is over no panel', () => {
    const state = dragTo(600, 900)
    for (const p of [A, B, C]) assert.equal(panelDropZone(state, p), null)
  })

  it('the highlight follows the pointer across a panel boundary', () => {
    let state = dragTo(600, 150)
    assert.equal(panelDropZone(state, B), 'center')
    state = pointerMoved(state, { x: 1000, y: 150 }, measure)
    assert.equal(panelDropZone(state, B), null)
    assert.equal(panelDropZone(state, C), 'center')
  })
})

/* ==================================================================
 * The tab strip.
 *
 * Everything below is new with tabs, and one standing rule changes here:
 * "dropping a view on the panel it is already in is a no-op" was unconditional
 * and is not any more. It is how a tab is reordered, and it is a no-op only when
 * the resulting index *and* the active tab both come out unchanged.
 * ================================================================== */

/**
 * A and B, each with a 30px strip. A holds three tabs (100 / 100 / 60 wide), B
 * holds two (120 each). Tab rectangles are panel-local, so B's first tab spans
 * viewport 400..520.
 */
const TABBED: PanelHit[] = [
  {
    panelId: A,
    rect: { left: 0, top: 0, width: 400, height: 300 },
    tabBarHeight: 30,
    tabRects: [
      { left: 0, width: 100 },
      { left: 100, width: 100 },
      { left: 200, width: 60 },
    ],
  },
  {
    panelId: B,
    rect: { left: 400, top: 0, width: 400, height: 300 },
    tabBarHeight: 30,
    tabRects: [
      { left: 0, width: 120 },
      { left: 120, width: 120 },
    ],
  },
]

/** Drag `V` out of `from` (at tab `origin`) and hover a viewport point. */
function dragTab(x: number, y: number, from: PanelId | null, origin: DragOrigin): DragState {
  const armed = armDrag(V, from, { x: 0, y: 200 }, origin)
  return pointerMoved(armed, { x, y }, () => TABBED)
}

/** The commonest case: the tab that was pressed is the one on screen. */
const ACTIVE_FIRST: DragOrigin = { index: 0, active: true }

describe('dropping on another panel’s strip', () => {
  it('inserts at the caret the pointer names', () => {
    // Viewport 470 is 70px into B, past its first tab's midpoint (60) and short
    // of its second (180): the gap between them, index 1.
    assert.deepEqual(dropCommandFor(dragTab(470, 10, A, ACTIVE_FIRST)), {
      name: 'layout.moveView',
      input: { viewId: V, toPanelId: B, index: 1, activate: true, onOccupied: 'stack' },
    })
  })

  it('inserts before the first tab and after the last one', () => {
    const before = dropCommandFor(dragTab(410, 10, A, ACTIVE_FIRST))
    const after = dropCommandFor(dragTab(790, 10, A, ACTIVE_FIRST))
    assert.equal(before?.name === 'layout.moveView' ? before.input.index : null, 0)
    // Past the last tab is where the panel's action buttons are, and a drop there
    // appends rather than doing nothing.
    assert.equal(after?.name === 'layout.moveView' ? after.input.index : null, 2)
  })

  it('does not lose the off-by-one correction: an arriving view uses the caret as-is', () => {
    // The dragged view occupies no slot in B's strip, so no gap shifts when it is
    // lifted out of A — caret and index are the same number.
    for (const [x, caret] of [
      [410, 0],
      [470, 1],
      [790, 2],
    ] as const) {
      const state = dragTab(x, 10, A, { index: 2, active: true })
      assert.equal(panelTabCaret(state, B), caret)
      const cmd = dropCommandFor(state)
      assert.equal(cmd?.name === 'layout.moveView' ? cmd.input.index : null, caret)
    }
  })

  it('draws a caret, never a zone highlight', () => {
    const state = dragTab(470, 10, A, ACTIVE_FIRST)
    assert.equal(panelDropZone(state, B), null, 'a strip drop must not paint a block')
    assert.equal(panelTabCaret(state, B), 1)
    assert.equal(panelTabCaret(state, A), null, 'only the panel under the pointer')
  })

  it('still reads the body zones below the strip', () => {
    // The band is 30px; everything under it is the ordinary five-zone geometry,
    // measured against the body rectangle.
    const state = dragTab(600, 150, A, ACTIVE_FIRST)
    assert.equal(panelTabCaret(state, B), null)
    assert.equal(panelDropZone(state, B), 'center')
  })
})

describe('reordering inside the panel a tab already lives in', () => {
  it('is a real command, not the no-op it used to be', () => {
    // Tab 0 dragged past all three midpoints (50 / 150 / 230): caret 3, and one
    // less because lifting it out shifts the later gaps left.
    assert.deepEqual(dropCommandFor(dragTab(250, 10, A, ACTIVE_FIRST)), {
      name: 'layout.moveView',
      input: { viewId: V, toPanelId: A, index: 2, activate: true, onOccupied: 'stack' },
    })
  })

  it('moves a tab leftwards without the correction', () => {
    const cmd = dropCommandFor(dragTab(20, 10, A, { index: 2, active: true }))
    assert.deepEqual(cmd, {
      name: 'layout.moveView',
      input: { viewId: V, toPanelId: A, index: 0, activate: true, onOccupied: 'stack' },
    })
  })

  it('is a no-op in both gaps adjacent to where the tab already is', () => {
    // Left of itself (caret 0) and right of itself (caret 1) both resolve to
    // index 0, which is where it already is — and it is already the visible tab,
    // so nothing at all would change.
    for (const x of [10, 60]) {
      assert.equal(dropCommandFor(dragTab(x, 10, A, ACTIVE_FIRST)), null, `x=${String(x)}`)
    }
  })

  it('is NOT a no-op for a background tab dropped where it already is', () => {
    // Same index, different screen: the drop activates it. Membership is not
    // visibility, and collapsing the two here would silently drop the activation.
    const cmd = dropCommandFor(dragTab(120, 10, A, { index: 1, active: false }))
    assert.deepEqual(cmd, {
      name: 'layout.moveView',
      input: { viewId: V, toPanelId: A, index: 1, activate: true, onOccupied: 'stack' },
    })
  })

  it('still draws its caret on the source panel', () => {
    // The M2 rule "never highlight the panel the view came from" survives only for
    // the body. Suppressing the strip's feedback would leave the commonest tab
    // gesture with no preview at all.
    const state = dragTab(250, 10, A, ACTIVE_FIRST)
    assert.equal(panelTabCaret(state, A), 3)
    assert.equal(panelDropZone(state, A), null)
    assert.equal(isOverVoid(state), false)
  })

  it('leaves the centre of the source panel’s body a no-op', () => {
    // The centre means "put it in this panel", and it is already in this panel.
    const state = dragTab(200, 150, A, ACTIVE_FIRST)
    assert.equal(dropCommandFor(state), null)
    assert.equal(panelDropZone(state, A), null)
    assert.equal(isOverVoid(state), false)
  })
})

describe('tearing a tab out onto its own panel’s edge', () => {
  /* The rule M2 stated unconditionally — "an edge drop on your own panel is a
   * no-op" — holds only while the view is that panel's *only* tab. With a
   * neighbour left behind the source is never emptied, so nothing collapses and
   * the split stands. This is the same condition `splitPanelWithView` checks on
   * the main side; the gesture was simply stricter than the tree. */

  it('splits when the source panel has other tabs', () => {
    // A holds three tabs, so pulling one out leaves two behind.
    assert.deepEqual(dropCommandFor(dragTab(4, 150, A, ACTIVE_FIRST)), {
      name: 'layout.splitWithView',
      input: { viewId: V, panelId: A, dir: 'row', insert: 'before' },
    })
    assert.deepEqual(dropCommandFor(dragTab(200, 296, A, ACTIVE_FIRST)), {
      name: 'layout.splitWithView',
      input: { viewId: V, panelId: A, dir: 'col', insert: 'after' },
    })
  })

  it('highlights exactly the edges it will act on', () => {
    assert.equal(panelDropZone(dragTab(4, 150, A, ACTIVE_FIRST), A), 'left')
    assert.equal(panelDropZone(dragTab(396, 150, A, ACTIVE_FIRST), A), 'right')
    // …and nothing in the centre, which stays a no-op.
    assert.equal(panelDropZone(dragTab(200, 150, A, ACTIVE_FIRST), A), null)
  })

  it('is still a no-op when the view is the panel’s only tab', () => {
    // One tab in the strip: the split would create a panel, the move would empty
    // this one, and the collapse would put the tree back (invariant I6).
    const lone: PanelHit[] = [
      {
        panelId: A,
        rect: { left: 0, top: 0, width: 400, height: 300 },
        tabBarHeight: 30,
        tabRects: [{ left: 0, width: 100 }],
      },
    ]
    const armed = armDrag(V, A, { x: 0, y: 200 }, ACTIVE_FIRST)
    for (const [x, y] of [
      [4, 150],
      [396, 150],
      [200, 296],
    ] as const) {
      const state = pointerMoved(armed, { x, y }, () => lone)
      assert.equal(dropCommandFor(state), null, `(${String(x)},${String(y)}) should be a no-op`)
      assert.equal(panelDropZone(state, A), null)
      assert.equal(isOverVoid(state), false)
    }
  })
})

describe('where the insertion line is drawn', () => {
  it('sits on the leading edge of the tab the caret precedes', () => {
    // B's second tab starts at panel-local 120, i.e. viewport 520.
    assert.deepEqual(tabCaretLine(dragTab(470, 10, A, ACTIVE_FIRST)), {
      x: 520,
      top: 0,
      height: 30,
    })
    assert.deepEqual(tabCaretLine(dragTab(410, 10, A, ACTIVE_FIRST)), { x: 400, top: 0, height: 30 })
  })

  it('sits past the last tab when the caret is at the end', () => {
    // B's tabs end at panel-local 240.
    assert.deepEqual(tabCaretLine(dragTab(790, 10, A, ACTIVE_FIRST)), { x: 640, top: 0, height: 30 })
  })

  it('is clamped into the panel, so a full strip still shows its last gap', () => {
    // A strip filled to the last subpixel: the trailing gap sits at 400.5 in a
    // 400px panel. Rectangles come from `getBoundingClientRect`, so fractions are
    // the normal case, and an unclamped line would be drawn half a pixel outside
    // the panel that clips it — invisible exactly when the strip is full.
    const full: PanelHit[] = [
      {
        panelId: A,
        rect: { left: 0, top: 0, width: 400, height: 300 },
        tabBarHeight: 30,
        tabRects: [
          { left: 0, width: 200 },
          { left: 200, width: 200.5 },
        ],
      },
    ]
    const state = pointerMoved(armDrag(V, null, { x: 0, y: 200 }), { x: 390, y: 10 }, () => full)
    assert.equal(panelTabCaret(state, A), 2)
    assert.deepEqual(tabCaretLine(state), { x: 400, top: 0, height: 30 })
  })

  it('is drawn from the same rectangles the caret was resolved against', () => {
    // Not from a second read of the DOM: the line and the Command must never
    // point at different gaps.
    const state = dragTab(470, 10, A, ACTIVE_FIRST)
    const line = tabCaretLine(state)
    assert.ok(line)
    const caret = panelTabCaret(state, B)
    assert.equal(caret, 1)
    assert.equal(line.x, TABBED[1].rect.left + (TABBED[1].tabRects?.[1].left ?? 0))
  })

  it('is nothing at all unless a strip is the target', () => {
    assert.equal(tabCaretLine(IDLE), null)
    assert.equal(tabCaretLine(armDrag(V, A, { x: 0, y: 0 })), null)
    assert.equal(tabCaretLine(dragTab(600, 150, A, ACTIVE_FIRST)), null, 'body drop')
    assert.equal(tabCaretLine(dragTab(600, 900, A, ACTIVE_FIRST)), null, 'over nothing')
  })
})

describe('a strip that changes shape mid-gesture', () => {
  it('re-measures the tabs, not just the panels', () => {
    // A tab closing in another window moves every caret in that strip. Treating
    // the strip as part of the panel's geometry is what makes the re-measure
    // notice; otherwise the line keeps pointing at a gap that no longer exists.
    const narrowed: PanelHit[] = [
      TABBED[0],
      { ...TABBED[1], tabRects: [{ left: 0, width: 120 }] },
    ]
    const state = dragTab(470, 10, A, ACTIVE_FIRST)
    assert.equal(panelTabCaret(state, B), 1)
    const after = remeasureDrag(state, () => narrowed)
    assert.notEqual(after, state, 'the strip change went unnoticed')
    assert.equal(panelTabCaret(after, B), 1)
    assert.deepEqual(tabCaretLine(after), { x: 520, top: 0, height: 30 })
  })

  it('is still inert when nothing moved, tabs included', () => {
    const state = dragTab(470, 10, A, ACTIVE_FIRST)
    assert.equal(
      remeasureDrag(state, () => TABBED.map((p) => ({ ...p, tabRects: p.tabRects?.map((r) => ({ ...r })) }))),
      state,
    )
  })
})

/* ==================================================================
 * Structural guards.
 *
 * The wiring cannot be executed here (node has no DOM), so what is pinned down
 * instead is the shape of it: which element carries the drag, and the standing
 * rule that the renderer never edits the layout locally. Both are the kind of
 * thing a later refactor breaks silently.
 * ================================================================== */

const src = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

const PANEL_TSX = src('../Panel.tsx')
const PANEL_TABS_TSX = src('../PanelTabs.tsx')
const DRAG_STORE = src('../dragStore.ts')
const DRAG_MACHINE = src('../dragMachine.ts')
const CSS = src('../../styles.css')

function ruleBody(css: string, selector: string): string {
  const start = css.indexOf(`\n${selector} {`)
  assert.notEqual(start, -1, `styles.css has no rule for ${selector}`)
  const open = css.indexOf('{', start)
  const close = css.indexOf('}', open)
  return css.slice(open + 1, close)
}

describe('structure — no optimistic updates', () => {
  it('the drag layer never writes to the workspace mirror', () => {
    // The layout tree lives in main. Everything the drag draws is a temporary
    // visual, and the tree does not move until a patch arrives.
    for (const [name, code] of [
      ['dragStore.ts', DRAG_STORE],
      ['dragMachine.ts', DRAG_MACHINE],
    ] as const) {
      assert.ok(!code.includes('useWorkspaceStore.setState'), `${name} writes the mirror`)
      assert.ok(!/\bapplyPatches\b/.test(code), `${name} applies patches itself`)
    }
  })

  it('the only commands a drop can send are the two layout moves', () => {
    const dispatched = [...DRAG_STORE.matchAll(/dispatch\('([^']+)'/g)].map((m) => m[1])
    assert.deepEqual(dispatched.sort(), ['layout.moveView', 'layout.splitWithView'])
  })

  it('every onOccupied the machine can produce is a stack', () => {
    // Spelled out in the source rather than left to the schema default, so that
    // a future flip of that default cannot quietly turn every drag into a swap.
    const modes = [...DRAG_MACHINE.matchAll(/onOccupied:\s*'([a-z]+)'/g)].map((m) => m[1])
    assert.deepEqual([...new Set(modes)], ['stack'])
  })

  it('the store watches the workspace revision for the length of a gesture', () => {
    // Reading the mirror is not writing it: the drag has to notice when a second
    // writer (MCP, a keyboard split) rearranges the panels under the cursor, or
    // it keeps hit-testing against a window that is no longer on screen. Both the
    // subscription and its teardown have to be there — a subscription that
    // outlives the gesture would re-measure forever.
    assert.match(DRAG_STORE, /useWorkspaceStore\.subscribe\(/, 'nothing watches for layout changes')
    assert.match(DRAG_STORE, /remeasureDrag\(/, 'a layout change never re-measures')
    assert.match(DRAG_STORE, /unwatchLayout\(\)/, 'the watch is never torn down')
  })

  it('the release measures once more before it decides where the view goes', () => {
    // Otherwise the command describes the window as it was when the drag started.
    assert.match(DRAG_STORE, /releaseDrag\(state,\s*measurePanels\)/)
  })
})

describe('structure — where the gesture lives', () => {
  it('the drag handle is a tab, not the panel body', () => {
    // Moved from the panel head to the individual tabs, because the thing being
    // dragged is now one of several. The body still owns grid scrolling and text
    // selection, and taking its pointer stream would still break both.
    const tab = PANEL_TABS_TSX.indexOf("role=\"tab\"")
    assert.notEqual(tab, -1, 'no tab element to drag')
    assert.ok(PANEL_TABS_TSX.includes('beginViewDrag'), 'a tab does not start a drag')
    assert.ok(PANEL_TABS_TSX.includes('onPointerDown'), 'a tab has no pointer handler')
    const body = PANEL_TSX.indexOf('className="panel-body"')
    assert.notEqual(body, -1)
    assert.ok(
      !PANEL_TSX.slice(body).includes('onPointerDown'),
      'the panel body must not start a drag',
    )
  })

  it('the tab ✕ closes the view and the panel ✕ closes the panel', () => {
    // The pre-tab head had to guess between the two, and the guess is now spelled
    // out: a per-tab ✕ leaves the panel's own ✕ one unambiguous job.
    const dispatched = [...PANEL_TABS_TSX.matchAll(/dispatch\('([^']+)'/g)].map((m) => m[1])
    assert.deepEqual(
      [...new Set(dispatched)].sort(),
      // `view.promote` joined the set when tabs learned to be provisional: a
      // double-click on an italic tab keeps it. It is the strip's only other
      // verb, and it still touches exactly one view.
      ['layout.close', 'layout.split', 'view.activate', 'view.close', 'view.promote'],
    )
    assert.ok(!PANEL_TSX.includes("dispatch('view.close'"), 'the panel still closes a view')
  })

  it('the strip carries a drag origin, so a reorder knows what it is reordering', () => {
    // Without the index and the active flag, a same-panel drop cannot tell a
    // reorder from a no-op — the two differ only by where the tab already was.
    assert.match(PANEL_TABS_TSX, /beginViewDrag\(e,\s*viewId,\s*panelId,\s*\{\s*index/)
  })

  it('every panel registers itself as a drop target and reports its zone', () => {
    assert.ok(PANEL_TSX.includes('registerPanelEl'), 'panels are not in the hit-test registry')
    assert.ok(PANEL_TSX.includes('data-drop-zone'), 'the resolved zone is not observable')
    assert.ok(PANEL_TSX.includes('<PanelDropOverlay'), 'panels draw no drop preview')
    assert.ok(
      PANEL_TABS_TSX.includes('registerPanelHeadEl'),
      'the strip is not measurable, so a tab drop cannot be resolved',
    )
  })

  it('the overlay is positioned against the panel and cannot swallow the pointer', () => {
    // `pointer-events: none` is load-bearing: the overlay covers the panel, and a
    // hit-testable one would eat the release that ends the drag.
    assert.match(ruleBody(CSS, '.panel-drop-overlay'), /pointer-events:\s*none/)
    assert.match(ruleBody(CSS, '.panel-drop-overlay'), /position:\s*absolute/)
    assert.match(ruleBody(CSS, '.panel'), /position:\s*relative/)
    assert.match(ruleBody(CSS, '.view-drag-ghost'), /pointer-events:\s*none/)
    assert.match(ruleBody(CSS, '.tab-insert-caret'), /pointer-events:\s*none/)
    assert.match(ruleBody(CSS, '.tab-insert-caret'), /position:\s*fixed/)
  })

  it('the strip scrolls itself, and the scroll never leaks out of it', () => {
    // The forbidden zone, restated in CSS: the strip is a horizontal scroll
    // container, it is not the grid's, and `overflow-x` must not reach the panel
    // or the page.
    assert.match(ruleBody(CSS, '.panel-tabs'), /overflow-x:\s*auto/)
    assert.match(ruleBody(CSS, '.panel-tabs'), /overflow-y:\s*hidden/)
    assert.match(ruleBody(CSS, '.panel'), /overflow:\s*hidden/)
    assert.match(ruleBody(CSS, '.panel-tab'), /min-width:\s*var\(--tab-min-width\)/)
  })

  it('the strip keeps the head height it replaced, so the body never resizes', () => {
    // The body is a pixel-virtualised grid, and the scroll subsystem is off
    // limits. A strip that appeared with the second tab would change the body's
    // height at runtime; occupying the existing bar keeps it constant.
    assert.match(ruleBody(CSS, '.panel-head'), /height:\s*var\(--bar-h\)/)
    assert.ok(
      !PANEL_TABS_TSX.includes('viewIds.length > 1'),
      'the strip is hidden for a single tab somewhere',
    )
  })

  it('the action buttons are named for a screen reader, not left as bare glyphs', () => {
    // An accessible name is computed from aria-label, then content, then title.
    // A button whose only content is "⊞" therefore announces the glyph and its
    // `title` never wins — the label has to be explicit, and the glyph hidden.
    //
    // The name now arrives as `<Button icon label={…}>`, which emits both the
    // aria-label and the tooltip. Asserted on `label=` rather than on the raw
    // attribute because the requirement is that the control **has a name**, and
    // pinning the assertion to one spelling of it is what made this test fail a
    // migration that strengthened the very property it guards: `icon` makes the
    // label a type error to omit, which `aria-label` never was.
    const actions = PANEL_TABS_TSX.slice(PANEL_TABS_TSX.indexOf('panel-actions'))
    for (const key of ['panel.splitRow', 'panel.splitCol', 'panel.closePanel']) {
      assert.ok(
        actions.includes(`label={t('${key}')}`),
        `the ${key} button has no accessible name of its own`,
      )
    }
    for (const glyph of ['⊞', '⊟', '✕']) {
      assert.ok(
        actions.includes(`<span aria-hidden="true">${glyph}</span>`),
        `the ${glyph} glyph is exposed to the accessibility tree`,
      )
    }
  })
})
