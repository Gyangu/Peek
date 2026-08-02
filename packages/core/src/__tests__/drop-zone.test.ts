import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  DROP_EDGE_MAX_PX,
  DROP_EDGE_MIN_PX,
  DROP_EDGE_RATIO,
  DROP_ZONES,
  dropZoneHighlight,
  dropZonePlacement,
  edgeBand,
  isDropEdgeZone,
  resolveDropZone,
  resolvePanelDrop,
  resolveTabInsertCaret,
  tabDropIndex,
  type DropZone,
  type TabRect,
} from '../index'

/* ==================================================================
 * Drop-zone geometry — the pure half of view dragging.
 *
 * This is the function that turns "where the cursor is" into "which Command
 * runs", so every pixel of a panel has to map to exactly one answer, and the
 * same pixel has to map to the same answer every time. It is pure and has no
 * DOM in it, which is the whole reason it lives in core rather than in the
 * component: it can be pinned down here, once, instead of being re-derived by
 * hand from a running window.
 * ================================================================== */

const RECT = { width: 400, height: 300 }

describe('edgeBand', () => {
  it('is a fraction of the panel between the two clamps', () => {
    // 300 * 0.25 = 75, inside [24, 96]
    assert.equal(edgeBand(300), 300 * DROP_EDGE_RATIO)
    assert.equal(edgeBand(300), 75)
  })

  it('clamps up on a small panel and down on a large one', () => {
    // A pure fraction is wrong at both ends: 25% of 2000px would swallow half the
    // panel, 25% of 60px would be unhittable.
    assert.equal(edgeBand(60), DROP_EDGE_MIN_PX)
    assert.equal(edgeBand(2000), DROP_EDGE_MAX_PX)
    assert.equal(edgeBand(400), DROP_EDGE_MAX_PX) // 100 clamps to 96
  })

  it('is zero for a degenerate size', () => {
    assert.equal(edgeBand(0), 0)
    assert.equal(edgeBand(-10), 0)
    assert.equal(edgeBand(Number.NaN), 0)
  })
})

describe('resolveDropZone — the four edges and the middle', () => {
  it('resolves the reference points of a 400x300 panel', () => {
    assert.equal(resolveDropZone(RECT, 10, 150), 'left')
    assert.equal(resolveDropZone(RECT, 200, 150), 'center')
    assert.equal(resolveDropZone(RECT, 200, 5), 'top')
    assert.equal(resolveDropZone(RECT, 395, 295), 'right')
    assert.equal(resolveDropZone(RECT, 200, 297), 'bottom')
  })

  it('clamps a point outside the rectangle to the nearest edge instead of the centre', () => {
    // The pointer leaving the panel by a pixel must not flip the preview to a
    // move; hit testing has already decided this panel is the target.
    assert.equal(resolveDropZone(RECT, -50, 150), 'left')
    assert.equal(resolveDropZone(RECT, 460, 150), 'right')
    assert.equal(resolveDropZone(RECT, 200, -8), 'top')
    assert.equal(resolveDropZone(RECT, 200, 400), 'bottom')
  })

  it('switches an axis off entirely when the panel is too short to host its bands', () => {
    // 2 * 24 >= 40, so a 40px-tall panel has no reachable top or bottom band —
    // without this rule it would have no reachable centre either.
    const flat = { width: 400, height: 40 }
    assert.equal(resolveDropZone(flat, 200, 5), 'center')
    assert.equal(resolveDropZone(flat, 200, 35), 'center')
    // The horizontal bands still work on the same panel.
    assert.equal(resolveDropZone(flat, 4, 20), 'left')
  })

  it('compares normalized penetration, not pixel distance, so corners behave', () => {
    // 800x120: horizontal band 96, vertical band 30. The point is 10px from the
    // top and 20px from the left, yet it is proportionally deeper into the left
    // band (0.208) than into the top one (0.333).
    const wide = { width: 800, height: 120 }
    assert.equal(edgeBand(wide.width), 96)
    assert.equal(edgeBand(wide.height), 30)
    assert.equal(resolveDropZone(wide, 20, 10), 'left')
  })

  it('breaks ties in a fixed order, so one pixel always yields one Command', () => {
    // 48/96 === 37.5/75 === 0.5: left wins over top by the documented order.
    assert.equal(resolveDropZone(RECT, 48, 37.5), 'left')
    // Mirrored corner: right and bottom tie, right wins.
    assert.equal(resolveDropZone(RECT, 400 - 48, 300 - 37.5), 'right')
  })

  it('falls back to the centre for a degenerate rectangle', () => {
    assert.equal(resolveDropZone({ width: 0, height: 0 }, 0, 0), 'center')
    assert.equal(resolveDropZone({ width: Number.NaN, height: 300 }, 10, 10), 'center')
  })

  it('never returns anything outside the five zones, anywhere on the panel', () => {
    for (let x = 0; x <= RECT.width; x += 7) {
      for (let y = 0; y <= RECT.height; y += 7) {
        const zone = resolveDropZone(RECT, x, y)
        assert.ok(
          (DROP_ZONES as readonly string[]).includes(zone),
          `(${String(x)},${String(y)}) produced ${zone}`,
        )
        // And it is deterministic — the same pixel twice.
        assert.equal(resolveDropZone(RECT, x, y), zone)
      }
    }
  })
})

describe('zone → split placement', () => {
  it('maps each edge to the split a human would expect', () => {
    assert.deepEqual(dropZonePlacement('left'), { dir: 'row', insert: 'before' })
    assert.deepEqual(dropZonePlacement('right'), { dir: 'row', insert: 'after' })
    assert.deepEqual(dropZonePlacement('top'), { dir: 'col', insert: 'before' })
    assert.deepEqual(dropZonePlacement('bottom'), { dir: 'col', insert: 'after' })
  })

  it('treats exactly the four edges as edges', () => {
    assert.equal(isDropEdgeZone('center'), false)
    for (const zone of ['left', 'right', 'top', 'bottom'] as const) {
      assert.equal(isDropEdgeZone(zone), true)
    }
  })
})

describe('highlight geometry', () => {
  it('covers the whole panel for a move and half of it for a split', () => {
    // The edge preview is half the panel because that is what the split produces:
    // the new panel gets an even share. Preview and result describe one thing.
    assert.deepEqual(dropZoneHighlight('center'), { left: 0, top: 0, width: 1, height: 1 })
    assert.deepEqual(dropZoneHighlight('left'), { left: 0, top: 0, width: 0.5, height: 1 })
    assert.deepEqual(dropZoneHighlight('right'), { left: 0.5, top: 0, width: 0.5, height: 1 })
    assert.deepEqual(dropZoneHighlight('top'), { left: 0, top: 0, width: 1, height: 0.5 })
    assert.deepEqual(dropZoneHighlight('bottom'), { left: 0, top: 0.5, width: 1, height: 0.5 })
  })

  it('stays inside the panel for every zone', () => {
    for (const zone of DROP_ZONES as readonly DropZone[]) {
      const r = dropZoneHighlight(zone)
      assert.ok(r.left >= 0 && r.top >= 0, `${zone} starts outside the panel`)
      assert.ok(r.left + r.width <= 1, `${zone} overflows horizontally`)
      assert.ok(r.top + r.height <= 1, `${zone} overflows vertically`)
      assert.ok(r.width > 0 && r.height > 0, `${zone} is empty`)
    }
  })

  it('places the preview on the side the split will insert into', () => {
    // `before` on a row means the new panel is to the left, so the highlight must
    // be the left half — the two are read together and cannot drift apart.
    for (const zone of ['left', 'right', 'top', 'bottom'] as const) {
      const { dir, insert } = dropZonePlacement(zone)
      const r = dropZoneHighlight(zone)
      const leading = dir === 'row' ? r.left === 0 : r.top === 0
      assert.equal(leading, insert === 'before', `${zone} previews the wrong half`)
    }
  })
})

/* ==================================================================
 * The tab strip: a layer above the five zones.
 *
 * Two questions the pre-tab geometry never had to answer — which gap in the
 * strip a pointer names, and what that gap means once the dragged tab is lifted
 * out of the strip it is being measured against. Both are pure arithmetic, and
 * both are the kind of thing that is off by one for a week if it is derived by
 * hand in a component.
 * ================================================================== */

/** Three tabs, 100 / 100 / 60 wide, laid out left to right without gaps. */
const TABS: TabRect[] = [
  { left: 0, width: 100 },
  { left: 100, width: 100 },
  { left: 200, width: 60 },
]

describe('resolveTabInsertCaret — which gap the pointer names', () => {
  it('counts the tabs whose midpoint is to the left of the pointer', () => {
    assert.equal(resolveTabInsertCaret(TABS, 0), 0)
    assert.equal(resolveTabInsertCaret(TABS, 49), 0)
    assert.equal(resolveTabInsertCaret(TABS, 51), 1)
    assert.equal(resolveTabInsertCaret(TABS, 149), 1)
    assert.equal(resolveTabInsertCaret(TABS, 151), 2)
    assert.equal(resolveTabInsertCaret(TABS, 231), 3)
  })

  it('breaks the midpoint tie towards the gap before the tab, always the same way', () => {
    // Exactly on a midpoint is a real pixel a user can sit on; like the zone
    // tie-break, the direction is arbitrary but fixed.
    assert.equal(resolveTabInsertCaret(TABS, 50), 0)
    assert.equal(resolveTabInsertCaret(TABS, 150), 1)
  })

  it('names a gap, so it spans 0..n and clamps past both ends', () => {
    assert.equal(resolveTabInsertCaret(TABS, -400), 0, 'before the first tab')
    assert.equal(resolveTabInsertCaret(TABS, 9999), TABS.length, 'after the last one')
    // Past the last tab is where the action buttons live, and appending is what
    // a drop there should mean.
    assert.equal(resolveTabInsertCaret(TABS, 260), 3)
  })

  it('is 0 for an empty strip', () => {
    for (const x of [-10, 0, 40, 5000]) assert.equal(resolveTabInsertCaret([], x), 0)
  })

  it('never leaves the range for any pixel of the strip', () => {
    for (let x = -20; x <= 300; x += 3) {
      const caret = resolveTabInsertCaret(TABS, x)
      assert.ok(Number.isInteger(caret) && caret >= 0 && caret <= TABS.length, `x=${String(x)}`)
    }
  })

  it('does not reorder the strip it is measuring', () => {
    // Tab order is meaningful state (P6). A helper that sorted its input would
    // destroy exactly the thing under test, so the array must come back untouched.
    const before = TABS.map((r) => ({ ...r }))
    resolveTabInsertCaret(TABS, 130)
    assert.deepEqual(TABS, before)
  })
})

describe('tabDropIndex — caret position → the index a Command carries', () => {
  it('is the caret itself for a view arriving from elsewhere', () => {
    for (const caret of [0, 1, 2, 3]) assert.equal(tabDropIndex(caret, null), caret)
  })

  it('loses one when a tab moves rightwards inside its own strip', () => {
    // Dragging tab 0 into the gap between 1 and 2 (caret 2) lands it at index 1:
    // lifting it out shifts every later gap one place left. This is the off-by-one
    // that a caret-position `index` would have pushed onto every caller.
    assert.equal(tabDropIndex(2, 0), 1)
    assert.equal(tabDropIndex(3, 0), 2)
    assert.equal(tabDropIndex(3, 1), 2)
  })

  it('keeps the caret when a tab moves leftwards or stays put', () => {
    assert.equal(tabDropIndex(0, 2), 0)
    assert.equal(tabDropIndex(1, 2), 1)
    assert.equal(tabDropIndex(2, 2), 2)
  })

  it('maps both gaps adjacent to a tab back onto that tab — the two no-op drops', () => {
    // Releasing just left of yourself (caret === fromIndex) and just right of
    // yourself (caret === fromIndex + 1) both mean "stay where you are".
    for (const from of [0, 1, 2]) {
      assert.equal(tabDropIndex(from, from), from)
      assert.equal(tabDropIndex(from + 1, from), from)
    }
  })
})

describe('resolvePanelDrop — the strip band, and the body underneath it', () => {
  const GEOM = { width: 400, height: 300, tabBarHeight: 30, tabRects: TABS }

  it('routes the strip band to a caret, whatever the x', () => {
    assert.deepEqual(resolvePanelDrop(GEOM, 10, 0), { kind: 'tab', caret: 0 })
    assert.deepEqual(resolvePanelDrop(GEOM, 130, 15), { kind: 'tab', caret: 1 })
    assert.deepEqual(resolvePanelDrop(GEOM, 380, 29), { kind: 'tab', caret: 3 })
  })

  it('gives the band priority over the edge zone it overlaps', () => {
    // Without the band this point is deep in the top edge — i.e. a split. The
    // strip is drawn on top of nothing, so it has to win outright.
    assert.equal(resolveDropZone(GEOM, 200, 5), 'top')
    assert.deepEqual(resolvePanelDrop(GEOM, 200, 5), { kind: 'tab', caret: 2 })
  })

  it('measures the five zones against the BODY rectangle, not the panel', () => {
    // The strip takes its band off the top, so the body's own top edge is y=30
    // and its height is 270. At panel y=95 the body band (67.5px) still reaches,
    // while the panel band (75px) would already have given up and said centre.
    assert.deepEqual(resolvePanelDrop(GEOM, 200, 95), { kind: 'zone', zone: 'top' })
    assert.equal(resolveDropZone({ width: 400, height: 300 }, 200, 95), 'center')
  })

  it('leaves a reachable centre on a panel short enough for the band to matter', () => {
    // 108px tall: 78px of body once the strip has its 30. Measured against the
    // whole panel the top and bottom bands would meet in the middle and the body
    // would have no centre at all — which is the failure this rebasing prevents.
    const short = { width: 400, height: 108, tabBarHeight: 30, tabRects: TABS }
    assert.deepEqual(resolvePanelDrop(short, 200, 69), { kind: 'zone', zone: 'center' })
    assert.deepEqual(resolvePanelDrop(short, 200, 33), { kind: 'zone', zone: 'top' })
    assert.deepEqual(resolvePanelDrop(short, 200, 105), { kind: 'zone', zone: 'bottom' })
  })

  it('behaves exactly as before for a panel measured without a strip', () => {
    const bare = { width: 400, height: 300, tabBarHeight: 0, tabRects: [] }
    for (const [x, y] of [
      [10, 150],
      [200, 150],
      [200, 5],
      [395, 295],
      [200, 297],
    ] as const) {
      assert.deepEqual(resolvePanelDrop(bare, x, y), {
        kind: 'zone',
        zone: resolveDropZone({ width: 400, height: 300 }, x, y),
      })
    }
  })

  it('answers exactly one of the two kinds for every point of the panel', () => {
    for (let x = 0; x <= 400; x += 11) {
      for (let y = 0; y <= 300; y += 7) {
        const drop = resolvePanelDrop(GEOM, x, y)
        if (drop.kind === 'tab') {
          assert.ok(y < 30, `(${String(x)},${String(y)}) resolved to a tab below the strip`)
          assert.ok(drop.caret >= 0 && drop.caret <= TABS.length)
        } else {
          assert.ok(y >= 30, `(${String(x)},${String(y)}) resolved to a zone inside the strip`)
          assert.ok((DROP_ZONES as readonly string[]).includes(drop.zone))
        }
      }
    }
  })
})
