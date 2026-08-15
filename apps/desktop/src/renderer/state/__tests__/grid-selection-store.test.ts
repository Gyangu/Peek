import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'
import { asResultId, asViewId } from '@peek/core'
import {
  clearGridSelection,
  currentGridSelection,
  publishGridSelection,
  selectionColumnCount,
  selectionRowCount,
  useGridSelectionStore,
  type GridSelectionSpec,
} from '../gridSelectionStore'

/* ==================================================================
 * The channel between a grid's selection and everything outside it.
 *
 * One slot, and the only rule with any subtlety is who may empty it.
 * See docs/design/2026-08-15-cell-range-attachment.md §2.5.
 * ================================================================== */

const VIEW_A = asViewId('view_a')
const VIEW_B = asViewId('view_b')
const RESULT = asResultId('res_1')

const cells = (viewId = VIEW_A, r1 = 4): GridSelectionSpec => ({
  kind: 'cells',
  viewId,
  resultId: RESULT,
  r0: 2,
  r1,
  columns: ['name', 'score'],
})

const rows = (viewId = VIEW_A): GridSelectionSpec => ({
  kind: 'rows',
  viewId,
  resultId: RESULT,
  rowIndexes: [1, 4, 9],
})

beforeEach(() => {
  useGridSelectionStore.setState({ selection: null })
})

describe('gridSelectionStore', () => {
  it('starts empty — nothing is selected before a grid says so', () => {
    assert.equal(currentGridSelection(), null)
  })

  it('holds the last selection published, whichever kind it is', () => {
    publishGridSelection(cells())
    assert.equal(currentGridSelection()?.kind, 'cells')
    publishGridSelection(rows())
    assert.equal(currentGridSelection()?.kind, 'rows')
  })

  it('lets a view clear its own selection', () => {
    publishGridSelection(cells())
    clearGridSelection(VIEW_A)
    assert.equal(currentGridSelection(), null)
  })

  it('ignores a clear from a view that is not the current holder', () => {
    // Two grids taking turns: A clearing after B published must not wipe B.
    // Without the guard, closing or re-running any other tab empties the store
    // under whoever is actually selected.
    publishGridSelection(cells(VIEW_B))
    clearGridSelection(VIEW_A)
    assert.equal(currentGridSelection()?.viewId, VIEW_B)
  })
})

describe('counting a selection', () => {
  it('reads a rectangle as a closed interval — r0 and r1 both count', () => {
    assert.equal(selectionRowCount(cells(VIEW_A, 4)), 3)
    assert.equal(selectionRowCount(cells(VIEW_A, 2)), 1)
  })

  it('counts hand-picked rows by how many there are, not how far apart', () => {
    assert.equal(selectionRowCount(rows()), 3)
  })

  it('reports no column count for whole rows', () => {
    // Null and not the schema width: the label reading this has to say whether
    // the columns were narrowed, and a number cannot say "they were not".
    assert.equal(selectionColumnCount(rows()), null)
    assert.equal(selectionColumnCount(cells()), 2)
  })
})
