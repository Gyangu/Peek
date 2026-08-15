import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  ColumnResizer,
  applyResize,
  clampWidth,
  columnWindowKey,
  resolveWidth,
  resolveWidths,
  type ColumnSizing,
  type ColumnWindowItem,
  type GridColumn,
} from '../columnModel'

/* ==================================================================
 * The column axis, after TanStack Table was taken out of it.
 *
 * The grid held a `useReactTable` whose data was permanently `[]` — a
 * general-purpose table engine (~106 kB of `@tanstack/table-core`) reduced to
 * three jobs: default width, user override, drag. Those three now live in
 * columnModel.ts, and this file is the net under them.
 *
 * What is worth pinning is not "a width comes back" but the two properties the
 * old engine provided for free and that a hand-rolled model is exactly where you
 * lose:
 *
 *   1. **Absolute drag arithmetic.** Every move is `startSize + (x - startX)`.
 *      The tempting version — "current width + delta since the last move" —
 *      looks identical on a slow synthetic drag and drifts on a real one,
 *      because the browser coalesces pointermoves and because a clamp swallows
 *      the deltas that would have carried the pointer back out again. The
 *      "dragged past the minimum and back" case below is the one that fails.
 *   2. **Referential bail-out.** `applyResize` must return the *same object*
 *      when the width did not change, or every sub-pixel pointermove re-renders
 *      the header row and every visible cell.
 * ================================================================== */

const col = (id: string, size: number, minSize = 44, maxSize = 1200): GridColumn => ({
  id,
  size,
  minSize,
  maxSize,
})

describe('resolveWidth — the default, the override, and the bounds', () => {
  it('with no override, a column renders at its own size', () => {
    assert.equal(resolveWidth(col('0:id', 150), {}), 150)
  })

  it('an override wins over the default', () => {
    assert.equal(resolveWidth(col('0:id', 150), { '0:id': 320 }), 320)
  })

  it('an override is re-clamped, not trusted', () => {
    // Sizing outlives the gesture that produced it while minSize/maxSize come
    // from the schema, so a stored width can legitimately fall out of bounds.
    const c = col('0:id', 150, 44, 400)
    assert.equal(resolveWidth(c, { '0:id': 5000 }), 400, 'above maxSize must come back as maxSize')
    assert.equal(resolveWidth(c, { '0:id': 1 }), 44, 'below minSize must come back as minSize')
  })

  it('one column’s override does not leak into another', () => {
    const columns = [col('0:id', 150), col('1:id', 150)]
    // Two columns can share a *name* (SELECT a.id, b.id), which is why the id
    // carries the index. Widths must stay independent.
    assert.deepEqual(resolveWidths(columns, { '1:id': 500 }), [150, 500])
  })

  it('resolveWidths preserves column order', () => {
    const columns = [col('0:a', 100), col('1:b', 200), col('2:c', 300)]
    assert.deepEqual(resolveWidths(columns, {}), [100, 200, 300])
  })
})

describe('clampWidth', () => {
  it('is inclusive at both ends and leaves interior values alone', () => {
    assert.equal(clampWidth(44, 44, 1200), 44)
    assert.equal(clampWidth(1200, 44, 1200), 1200)
    assert.equal(clampWidth(300, 44, 1200), 300)
  })
})

describe('ColumnResizer — the drag state machine', () => {
  it('has no active column until a gesture begins', () => {
    assert.equal(new ColumnResizer().activeId, null)
  })

  it('a drag resolves to startSize plus the total pointer delta', () => {
    const r = new ColumnResizer()
    const c = col('0:id', 150)
    assert.equal(r.begin(c, 1, 500, 150), true)
    assert.equal(r.activeId, '0:id')
    assert.deepEqual(r.moveTo(1, 540), { columnId: '0:id', width: 190 })
    assert.deepEqual(r.moveTo(1, 460), { columnId: '0:id', width: 110 })
  })

  it('dragging past the minimum and back returns to the right width', () => {
    /* The regression that separates absolute arithmetic from accumulated deltas.
     * Starting at 150 with minSize 44, the pointer goes 300px left (clamped to
     * 44, i.e. 62px of travel discarded) and then comes back to where it began.
     * Absolute: 150 + 0 = 150. Accumulated: 44 + 300 = 344, and the column is
     * 194px too wide with no way for the user to see why. */
    const r = new ColumnResizer()
    r.begin(col('0:id', 150), 1, 500, 150)
    assert.deepEqual(r.moveTo(1, 200), { columnId: '0:id', width: 44 }, 'clamped at minSize')
    assert.deepEqual(r.moveTo(1, 500), { columnId: '0:id', width: 150 }, 'back to the starting width')
  })

  it('the same overshoot at the top end also unwinds cleanly', () => {
    const r = new ColumnResizer()
    r.begin(col('0:id', 1000, 44, 1200), 1, 0, 1000)
    assert.deepEqual(r.moveTo(1, 900), { columnId: '0:id', width: 1200 }, 'clamped at maxSize')
    assert.deepEqual(r.moveTo(1, 100), { columnId: '0:id', width: 1100 })
  })

  it('ignores a pointer that is not the one dragging', () => {
    // A second finger landing on a trackpad mid-drag must not hijack the gesture
    const r = new ColumnResizer()
    r.begin(col('0:id', 150), 1, 500, 150)
    assert.equal(r.begin(col('1:id', 150), 2, 900, 150), false, 'a second pointer must not take over')
    assert.equal(r.activeId, '0:id')
    assert.equal(r.moveTo(2, 700), null, 'the intruding pointer moves nothing')
    assert.equal(r.end(2), false, 'and cannot end the gesture either')
    assert.equal(r.activeId, '0:id')
  })

  it('moving before any gesture began resolves to nothing', () => {
    assert.equal(new ColumnResizer().moveTo(1, 500), null)
  })

  it('end releases the gesture, and moves after it are inert', () => {
    const r = new ColumnResizer()
    r.begin(col('0:id', 150), 1, 500, 150)
    assert.equal(r.end(1), true)
    assert.equal(r.activeId, null)
    assert.equal(r.moveTo(1, 600), null, 'a stray move after pointerup must not resize anything')
    assert.equal(r.end(1), false, 'ending twice is a no-op, not a second release')
  })

  it('a fresh gesture starts from the width the previous one left behind', () => {
    const r = new ColumnResizer()
    r.begin(col('0:id', 150), 1, 500, 150)
    const first = r.moveTo(1, 600)
    r.end(1)
    assert.equal(first?.width, 250)
    // The caller passes the *current* width as startSize, so drags compose
    r.begin(col('0:id', 150), 2, 0, first?.width ?? 0)
    assert.deepEqual(r.moveTo(2, 50), { columnId: '0:id', width: 300 })
  })
})

describe('applyResize — the referential bail-out React depends on', () => {
  it('returns the very same object when the width is unchanged', () => {
    const prev: ColumnSizing = { '0:id': 200 }
    assert.equal(
      applyResize(prev, { columnId: '0:id', width: 200 }),
      prev,
      'a new object here re-renders the header row and every visible cell on each sub-pixel move',
    )
  })

  it('returns a new object when the width changed, leaving the old one untouched', () => {
    const prev: ColumnSizing = { '0:id': 200 }
    const next = applyResize(prev, { columnId: '0:id', width: 201 })
    assert.notEqual(next, prev)
    assert.deepEqual(next, { '0:id': 201 })
    assert.deepEqual(prev, { '0:id': 200 }, 'the previous state must not be mutated')
  })

  it('adds a first override without disturbing its neighbours', () => {
    assert.deepEqual(applyResize({ '0:a': 100 }, { columnId: '1:b', width: 250 }), {
      '0:a': 100,
      '1:b': 250,
    })
  })
})

/* ==================================================================
 * columnWindowKey — the drag-lags-one-step bug.
 *
 * Reproduced over CDP against the *built* app before the fix, and reproduced
 * identically against the TanStack Table version, so it is a pre-existing defect
 * rather than a regression from replacing it. Dragging a header out from 110px
 * to 200px, in to the 44px minimum, then back to 110px left the column sitting
 * at 44: each measurement rendered one gesture-step behind, and the last one
 * never arrived at all.
 *
 * Cause: the grid caches the virtual-column array so memoized rows can bail out
 * while scrolling, and the cache key was built from the *column model's* widths.
 * The virtualizer's measurements trail the model by one commit, so on the commit
 * that finally carries the right sizes the key has already stopped changing and
 * the corrected items are discarded.
 * ================================================================== */
describe('columnWindowKey — the cached column window must follow what is rendered', () => {
  const item = (index: number, start: number, size: number): ColumnWindowItem => ({
    index,
    start,
    end: start + size,
  })

  it('a re-measure that changes only the sizes must change the key', () => {
    /* The exact shape of the bug. Same first index, same last index, and the
     * caller's widthKey has already been updated on the previous commit — so
     * every ingredient of the old key is identical, while the geometry that
     * actually reaches the DOM is not. */
    const widthKey = '200,150,150'
    const stale = [item(0, 0, 110), item(1, 110, 150), item(2, 260, 150)]
    const measured = [item(0, 0, 200), item(1, 200, 150), item(2, 350, 150)]
    assert.notEqual(
      columnWindowKey(measured, widthKey),
      columnWindowKey(stale, widthKey),
      'the corrected measurements would be dropped, and the column would render one drag-step behind',
    )
  })

  it('a width change in the last column alone still moves the key', () => {
    const cols = [item(0, 0, 100), item(1, 100, 100)]
    const widened = [item(0, 0, 100), item(1, 100, 260)]
    assert.notEqual(columnWindowKey(widened, 'x'), columnWindowKey(cols, 'x'))
  })

  it('two interior columns changing by equal and opposite amounts still moves the key', () => {
    // `last.end` is blind to this one, which is why widthKey stays in the key.
    const before = [item(0, 0, 100), item(1, 100, 100), item(2, 200, 100)]
    const after = [item(0, 0, 100), item(1, 100, 140), item(2, 240, 60)]
    assert.notEqual(columnWindowKey(after, '100,140,60'), columnWindowKey(before, '100,100,100'))
  })

  it('scrolling the column window changes the key', () => {
    const atLeft = [item(0, 0, 100), item(1, 100, 100)]
    const scrolled = [item(1, 100, 100), item(2, 200, 100)]
    assert.notEqual(columnWindowKey(scrolled, 'x'), columnWindowKey(atLeft, 'x'))
  })

  it('an unchanged window keeps the same key, so vertical scrolling never rebuilds the array', () => {
    // The whole reason the cache exists: GridRow is memoized on its props, and a
    // fresh cols array every frame defeats that for the entire visible window.
    const cols = [item(0, 0, 100), item(1, 100, 100)]
    assert.equal(columnWindowKey(cols, 'x'), columnWindowKey([...cols], 'x'))
  })

  it('an empty window is still a stable, distinct key', () => {
    assert.equal(columnWindowKey([], 'x'), columnWindowKey([], 'x'))
    assert.notEqual(columnWindowKey([], 'x'), columnWindowKey([], 'y'))
  })
})

/* ==================================================================
 * And the reason the module exists at all: the grid must not reach for a table
 * engine again. This is a source assertion because the cost being guarded is a
 * bundle cost — it does not show up in any behavioural test, which is precisely
 * how 106 kB of row-model machinery survived in a component that renders no rows.
 * ================================================================== */
describe('the grid pays for no general-purpose table engine', () => {
  const gridSrc = readFileSync(fileURLToPath(new URL('../DataGrid.tsx', import.meta.url)), 'utf8')

  it('DataGrid does not import @tanstack/react-table', () => {
    assert.ok(
      !/@tanstack\/react-table/.test(gridSrc),
      'the column axis is three arithmetic operations (columnModel.ts); a table engine that is ' +
        'handed `data: []` is ~106 kB of row models, grouping, filtering and pagination for nothing',
    )
  })

  it('and nothing else can import it either, because it is not a dependency', () => {
    // Stronger than the line above, which only watches one file. The package
    // stayed declared for a release after the last import went away: rollup had
    // tree-shaken it, so no measurement noticed, and a dependency nobody removes
    // is an invitation to import it again.
    const pkg = readFileSync(fileURLToPath(new URL('../../../../package.json', import.meta.url)), 'utf8')
    const deps = JSON.parse(pkg) as { dependencies?: Record<string, string> }
    assert.equal(deps.dependencies?.['@tanstack/react-table'], undefined)
  })

  it('DataGrid gets its headers and widths from the in-house model', () => {
    assert.match(gridSrc, /useColumnModel\(columns, sizing, setSizing\)/)
  })
})
