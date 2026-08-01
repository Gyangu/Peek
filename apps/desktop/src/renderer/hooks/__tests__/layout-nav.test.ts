import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  asPanelId,
  asSplitId,
  dropZonePlacement,
  makePanel,
  type LayoutNode,
  type PanelId,
} from '@peek/core'
import {
  DIRECTIONS,
  arrowDirection,
  directionPlacement,
  directionZone,
  findPanelInDirection,
  panelBoxes,
  panelIdAt,
  type Direction,
} from '../layout-nav'

/* ==================================================================
 * Geometric focus movement.
 *
 * The property under test throughout: **the answer follows what the user sees,
 * not how the tree happens to be nested**. `row(A, col(B, C))` puts B and C to
 * the right of A even though neither is A's sibling, and any implementation that
 * walks the tree instead of the rectangles gets that wrong.
 * ================================================================== */

/* ------------------------------------------------------------------ */
/* Construction helpers                                                */
/* ------------------------------------------------------------------ */

let splitSeq = 0
const P = (n: string): PanelId => asPanelId(`panel_${n}`)
// Empty panels throughout: geometry is a function of the tree's shape and the
// split ratios alone, and nothing in this file reads what a panel holds. Built
// through `makePanel` rather than as an object literal so that P1 (an empty
// panel has a null active tab) holds by construction here too.
const panel = (n: string): LayoutNode => makePanel(P(n))
const split = (dir: 'row' | 'col', children: LayoutNode[], ratio?: number[]): LayoutNode => ({
  type: 'split',
  id: asSplitId(`split_${String(++splitSeq)}`),
  dir,
  ratio: ratio ?? children.map(() => 1 / children.length),
  children,
})

/** `findPanelInDirection`, with the ids written the short way the fixtures use. */
const go = (root: LayoutNode, from: string, dir: Direction): string | null => {
  const hit = findPanelInDirection(root, P(from), dir)
  return hit === null ? null : hit.replace('panel_', '')
}

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

/** One panel, nothing around it. */
const solo = panel('a')

/** a | b */
const pair = split('row', [panel('a'), panel('b')])

/**
 * The irregular case that motivates the whole file:
 *
 *   ┌───────┬───────┐
 *   │       │   b   │
 *   │   a   ├───────┤
 *   │       │   c   │
 *   └───────┴───────┘
 */
const nested = split('row', [panel('a'), split('col', [panel('b'), panel('c')])])

/**
 * A 2×2 grid built as a column of rows — so "up" and "down" cross the outer
 * split while "left" and "right" stay inside an inner one.
 *
 *   ┌───┬───┐
 *   │ a │ b │
 *   ├───┼───┤
 *   │ c │ d │
 *   └───┴───┘
 */
const grid = split('col', [
  split('row', [panel('a'), panel('b')]),
  split('row', [panel('c'), panel('d')]),
])

/**
 * Deliberately mismatched edges: the left column is split at 50%, the right one
 * at 25/75, so no panel lines up with its opposite number.
 *
 *   ┌───────┬───────┐
 *   │   a   │   c   │  c ends at 25%
 *   │       ├───────┤
 *   ├───────┤       │
 *   │   b   │   d   │
 *   └───────┴───────┘
 */
const uneven = split('row', [
  split('col', [panel('a'), panel('b')], [0.5, 0.5]),
  split('col', [panel('c'), panel('d')], [0.25, 0.75]),
])

/* ------------------------------------------------------------------ */

describe('panelBoxes', () => {
  it('tiles the unit square: depth-first order, no gaps, no overlaps', () => {
    const boxes = panelBoxes(grid)
    assert.deepEqual(
      boxes.map((b) => b.panelId),
      [P('a'), P('b'), P('c'), P('d')],
    )
    const area = boxes.reduce((sum, b) => sum + b.width * b.height, 0)
    assert.ok(Math.abs(area - 1) < 1e-9, `boxes cover ${String(area)} of the unit square`)
    for (const [i, x] of boxes.entries()) {
      for (const y of boxes.slice(i + 1)) {
        const overlap =
          Math.max(0, Math.min(x.left + x.width, y.left + y.width) - Math.max(x.left, y.left)) *
          Math.max(0, Math.min(x.top + x.height, y.top + y.height) - Math.max(x.top, y.top))
        assert.equal(overlap, 0, 'two panels claim the same area')
      }
    }
  })

  it('honours the split ratios, and normalizes ones that do not sum to 1', () => {
    const boxes = panelBoxes(split('row', [panel('a'), panel('b')], [3, 1]))
    assert.deepEqual(boxes[0], { panelId: P('a'), left: 0, top: 0, width: 0.75, height: 1 })
    assert.deepEqual(boxes[1], { panelId: P('b'), left: 0.75, top: 0, width: 0.25, height: 1 })
  })

  it('a column split divides the y axis, not the x axis', () => {
    const boxes = panelBoxes(split('col', [panel('a'), panel('b')]))
    assert.deepEqual(boxes[0], { panelId: P('a'), left: 0, top: 0, width: 1, height: 0.5 })
    assert.deepEqual(boxes[1], { panelId: P('b'), left: 0, top: 0.5, width: 1, height: 0.5 })
  })
})

describe('findPanelInDirection — flat layouts', () => {
  it('a lone panel has no neighbour in any direction', () => {
    for (const dir of DIRECTIONS) assert.equal(go(solo, 'a', dir), null)
  })

  it('side by side: right and left connect them, up and down do not', () => {
    assert.equal(go(pair, 'a', 'right'), 'b')
    assert.equal(go(pair, 'b', 'left'), 'a')
    assert.equal(go(pair, 'a', 'left'), null)
    assert.equal(go(pair, 'b', 'right'), null)
    assert.equal(go(pair, 'a', 'up'), null)
    assert.equal(go(pair, 'a', 'down'), null)
  })

  it('an unknown panel id yields null rather than throwing', () => {
    assert.equal(findPanelInDirection(pair, P('nope'), 'right'), null)
  })

  it('does not return the panel it started from', () => {
    for (const dir of DIRECTIONS) assert.notEqual(go(pair, 'a', dir), 'a')
  })
})

describe('findPanelInDirection — irregular nesting', () => {
  it('crosses the tree: right of the tall panel is the top of the stacked pair', () => {
    // b and c are nephews of a, not siblings. Both touch a's right edge equally,
    // and the fixed tie-break (top-most) is what makes this reproducible.
    assert.equal(go(nested, 'a', 'right'), 'b')
  })

  it('both stacked panels find the tall one on their left', () => {
    assert.equal(go(nested, 'b', 'left'), 'a')
    assert.equal(go(nested, 'c', 'left'), 'a')
  })

  it('the stacked pair are each other’s up and down', () => {
    assert.equal(go(nested, 'b', 'down'), 'c')
    assert.equal(go(nested, 'c', 'up'), 'b')
    assert.equal(go(nested, 'b', 'up'), null)
    assert.equal(go(nested, 'c', 'down'), null)
  })

  it('the tall panel has nothing above or below it', () => {
    assert.equal(go(nested, 'a', 'up'), null)
    assert.equal(go(nested, 'a', 'down'), null)
  })
})

describe('findPanelInDirection — 2×2 grid', () => {
  it('moves within a row and across the outer split alike', () => {
    assert.equal(go(grid, 'a', 'right'), 'b')
    assert.equal(go(grid, 'b', 'left'), 'a')
    assert.equal(go(grid, 'a', 'down'), 'c')
    assert.equal(go(grid, 'c', 'up'), 'a')
    assert.equal(go(grid, 'd', 'up'), 'b')
    assert.equal(go(grid, 'd', 'left'), 'c')
  })

  it('never jumps diagonally: the near neighbour wins over the far one', () => {
    // Both c and d lie below a; only c shares a's horizontal span.
    assert.equal(go(grid, 'a', 'down'), 'c')
    assert.equal(go(grid, 'b', 'down'), 'd')
  })

  it('every edge panel reports null on the way out of the window', () => {
    assert.equal(go(grid, 'a', 'up'), null)
    assert.equal(go(grid, 'a', 'left'), null)
    assert.equal(go(grid, 'd', 'down'), null)
    assert.equal(go(grid, 'd', 'right'), null)
  })

  it('a move and its opposite are inverse for every pair the grid connects', () => {
    const opposite: Record<Direction, Direction> = {
      left: 'right',
      right: 'left',
      up: 'down',
      down: 'up',
    }
    for (const from of ['a', 'b', 'c', 'd']) {
      for (const dir of DIRECTIONS) {
        const there = go(grid, from, dir)
        if (there === null) continue
        assert.equal(go(grid, there, opposite[dir]), from, `${from} ${dir} is not reversible`)
      }
    }
  })
})

describe('findPanelInDirection — misaligned edges', () => {
  it('keeps to the panels that actually touch the source edge', () => {
    // a spans y 0…0.5. To its right, c spans 0…0.25 and d spans 0.25…1, so both
    // overlap a — d by 0.25, c by 0.25. Equal overlap, so the top-most wins.
    assert.equal(go(uneven, 'a', 'right'), 'c')
    // b spans 0.5…1 and only d reaches into it.
    assert.equal(go(uneven, 'b', 'right'), 'd')
  })

  it('a panel whose neighbour spans several rows still resolves', () => {
    assert.equal(go(uneven, 'c', 'left'), 'a')
    // d spans 0.25…1, overlapping a by 0.25 and b by 0.5: b shares more.
    assert.equal(go(uneven, 'd', 'left'), 'b')
  })

  it('is deterministic — the same tree and key always land in the same place', () => {
    for (let i = 0; i < 5; i++) assert.equal(go(uneven, 'a', 'right'), 'c')
  })
})

describe('findPanelInDirection — deep and lopsided', () => {
  /**
   *   ┌───┬───────┐
   *   │   │   b   │
   *   │ a ├───┬───┤
   *   │   │ c │ d │
   *   └───┴───┴───┘
   * Depth 3, and the right column's lower half is itself split.
   */
  const deep = split('row', [
    panel('a'),
    split('col', [panel('b'), split('row', [panel('c'), panel('d')])]),
  ])

  it('reaches three levels down for the panel on the other side of an edge', () => {
    assert.equal(go(deep, 'a', 'right'), 'b')
    assert.equal(go(deep, 'c', 'left'), 'a')
    assert.equal(go(deep, 'd', 'left'), 'c')
  })

  it('a panel spanning two panels below it goes to the first of them', () => {
    assert.equal(go(deep, 'b', 'down'), 'c')
    assert.equal(go(deep, 'c', 'up'), 'b')
    assert.equal(go(deep, 'd', 'up'), 'b')
  })

  it('the deepest panel still finds its way back out to the left column', () => {
    // Nothing shares d's left edge except c, which is why "left, left" is the
    // route back to a — one keystroke per boundary crossed, never a leap.
    const viaC = go(deep, 'd', 'left')
    assert.equal(viaC, 'c')
    assert.equal(viaC === null ? null : go(deep, viaC, 'left'), 'a')
  })

  it('every panel is reachable from every other by repeated moves', () => {
    const ids = ['a', 'b', 'c', 'd']
    for (const start of ids) {
      const seen = new Set<string>([start])
      const queue = [start]
      while (queue.length > 0) {
        const here = queue.shift()
        if (here === undefined) break
        for (const dir of DIRECTIONS) {
          const next = go(deep, here, dir)
          if (next !== null && !seen.has(next)) {
            seen.add(next)
            queue.push(next)
          }
        }
      }
      assert.equal(seen.size, ids.length, `panels unreachable from ${start}`)
    }
  })
})

describe('panelIdAt', () => {
  it('addresses panels in visual order and refuses to wrap', () => {
    assert.equal(panelIdAt(grid, 0), P('a'))
    assert.equal(panelIdAt(grid, 3), P('d'))
    assert.equal(panelIdAt(grid, 4), null)
    assert.equal(panelIdAt(grid, -1), null)
  })
})

describe('direction ↔ drop zone', () => {
  it('maps arrow keys to directions and nothing else', () => {
    assert.equal(arrowDirection('ArrowLeft'), 'left')
    assert.equal(arrowDirection('ArrowRight'), 'right')
    assert.equal(arrowDirection('ArrowUp'), 'up')
    assert.equal(arrowDirection('ArrowDown'), 'down')
    assert.equal(arrowDirection('a'), null)
    assert.equal(arrowDirection('Left'), null)
  })

  it('routes through the same table the mouse uses, so both gestures agree', () => {
    // If these ever diverge, ⌘⌥⇧→ and a drop on the right edge would produce
    // different Commands from the same intent.
    assert.deepEqual(directionZone('up'), 'top')
    assert.deepEqual(directionZone('down'), 'bottom')
    for (const dir of DIRECTIONS) {
      assert.deepEqual(directionPlacement(dir), dropZonePlacement(directionZone(dir)))
    }
    assert.deepEqual(directionPlacement('right'), { dir: 'row', insert: 'after' })
    assert.deepEqual(directionPlacement('up'), { dir: 'col', insert: 'before' })
  })
})
