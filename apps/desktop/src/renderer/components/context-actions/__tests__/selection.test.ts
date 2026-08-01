import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  EMPTY_SELECTION,
  applyRowClick,
  clearSelection,
  isRowSelected,
  selectAllRows,
  selectedIndexes,
  selectionSize,
  selectionSpan,
  type RowSelection,
} from '../selection'

/* ==================================================================
 * The selection gestures every table application has trained the user
 * to expect. They are pure functions precisely so they can be pinned
 * down here rather than re-derived, slightly differently, in the grid.
 * ================================================================== */

const plain = { shift: false, toggle: false }
const shift = { shift: true, toggle: false }
const toggle = { shift: false, toggle: true }
const shiftToggle = { shift: true, toggle: true }

describe('applyRowClick · plain click', () => {
  it('replaces the selection with one row', () => {
    const s = applyRowClick({ anchor: 1, rows: new Set([1, 2, 3]) }, 7, plain)
    assert.deepEqual(selectedIndexes(s), [7])
  })

  it('sets the anchor', () => {
    assert.equal(applyRowClick(EMPTY_SELECTION, 4, plain).anchor, 4)
  })

  it('re-clicking a selected row keeps it selected rather than toggling it off', () => {
    const s = applyRowClick({ anchor: 4, rows: new Set([4]) }, 4, plain)
    assert.deepEqual(selectedIndexes(s), [4])
  })
})

describe('applyRowClick · ctrl/cmd click', () => {
  it('adds a row without disturbing the others', () => {
    const s = applyRowClick({ anchor: 1, rows: new Set([1, 2]) }, 9, toggle)
    assert.deepEqual(selectedIndexes(s), [1, 2, 9])
  })

  it('removes a row that was already selected', () => {
    const s = applyRowClick({ anchor: 1, rows: new Set([1, 2, 9]) }, 2, toggle)
    assert.deepEqual(selectedIndexes(s), [1, 9])
  })

  it('moves the anchor, so a following shift-click extends from the row just touched', () => {
    // Finder, Explorer and every mail client behave this way. Extending from a
    // stale anchor is the thing that feels broken.
    const a = applyRowClick(EMPTY_SELECTION, 2, plain)
    const b = applyRowClick(a, 10, toggle)
    assert.equal(b.anchor, 10)
    const c = applyRowClick(b, 12, shift)
    assert.deepEqual(selectedIndexes(c), [10, 11, 12])
  })

  it('can empty the selection entirely', () => {
    const s = applyRowClick({ anchor: 3, rows: new Set([3]) }, 3, toggle)
    assert.equal(selectionSize(s), 0)
  })
})

describe('applyRowClick · shift click', () => {
  it('selects the closed range between the anchor and the click', () => {
    const a = applyRowClick(EMPTY_SELECTION, 3, plain)
    const b = applyRowClick(a, 6, shift)
    assert.deepEqual(selectedIndexes(b), [3, 4, 5, 6])
  })

  it('works backwards', () => {
    const a = applyRowClick(EMPTY_SELECTION, 6, plain)
    const b = applyRowClick(a, 3, shift)
    assert.deepEqual(selectedIndexes(b), [3, 4, 5, 6])
  })

  it('replaces the previous selection by default', () => {
    const s = applyRowClick({ anchor: 10, rows: new Set([1, 2, 3, 10]) }, 12, shift)
    assert.deepEqual(selectedIndexes(s), [10, 11, 12])
  })

  it('adds to it when ctrl/cmd is held as well', () => {
    const s = applyRowClick({ anchor: 10, rows: new Set([1, 2, 10]) }, 12, shiftToggle)
    assert.deepEqual(selectedIndexes(s), [1, 2, 10, 11, 12])
  })

  it('keeps the anchor put, so dragging the far end back and forth measures from one origin', () => {
    const a = applyRowClick(EMPTY_SELECTION, 5, plain)
    const b = applyRowClick(a, 9, shift)
    const c = applyRowClick(b, 7, shift)
    assert.equal(c.anchor, 5)
    assert.deepEqual(selectedIndexes(c), [5, 6, 7])
  })

  it('behaves as a plain click when there is no anchor to extend from', () => {
    const s = applyRowClick(EMPTY_SELECTION, 4, shift)
    assert.deepEqual(selectedIndexes(s), [4])
    assert.equal(s.anchor, 4)
  })

  it('selects a single row when the anchor is the clicked row', () => {
    const a = applyRowClick(EMPTY_SELECTION, 4, plain)
    assert.deepEqual(selectedIndexes(applyRowClick(a, 4, shift)), [4])
  })
})

describe('immutability', () => {
  it('never mutates the selection it was given', () => {
    const before: RowSelection = { anchor: 1, rows: new Set([1, 2]) }
    const snapshot = selectedIndexes(before)
    applyRowClick(before, 5, toggle)
    applyRowClick(before, 5, shift)
    applyRowClick(before, 5, plain)
    assert.deepEqual(selectedIndexes(before), snapshot)
  })
})

describe('helpers', () => {
  it('selectedIndexes sorts ascending regardless of click order', () => {
    let s = applyRowClick(EMPTY_SELECTION, 9, plain)
    s = applyRowClick(s, 2, toggle)
    s = applyRowClick(s, 5, toggle)
    assert.deepEqual(selectedIndexes(s), [2, 5, 9])
  })

  it('selectionSpan measures the reach, not the count', () => {
    let s = applyRowClick(EMPTY_SELECTION, 10, plain)
    s = applyRowClick(s, 20, toggle)
    // Two rows, but eleven positions apart — which is what main has to read.
    assert.equal(selectionSize(s), 2)
    assert.equal(selectionSpan(s), 11)
  })

  it('selectionSpan is zero for an empty selection', () => {
    assert.equal(selectionSpan(EMPTY_SELECTION), 0)
  })

  it('selectAllRows covers the whole result and handles an empty one', () => {
    assert.equal(selectionSize(selectAllRows(4)), 4)
    assert.deepEqual(selectedIndexes(selectAllRows(3)), [0, 1, 2])
    assert.equal(selectionSize(selectAllRows(0)), 0)
  })

  it('isRowSelected and clearSelection do what they say', () => {
    const s = applyRowClick(EMPTY_SELECTION, 3, plain)
    assert.equal(isRowSelected(s, 3), true)
    assert.equal(isRowSelected(s, 4), false)
    assert.equal(selectionSize(clearSelection()), 0)
  })

  it('does not clamp to the loaded window — eviction is reported at send time, not hidden here', () => {
    const s = applyRowClick(EMPTY_SELECTION, 999_999, plain)
    assert.deepEqual(selectedIndexes(s), [999_999])
  })
})
