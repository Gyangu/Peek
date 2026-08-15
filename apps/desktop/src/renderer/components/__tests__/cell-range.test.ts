import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { isAnchor, isInRange, rangeAt, rangeCellCount, rangeFrom, rangeHasRow } from '../cellRange'

/* ==================================================================
 * The rectangular selection — 框选.
 *
 * The whole module is arithmetic over four numbers, which is exactly the kind of
 * thing that looks too simple to test until a drag upwards selects the wrong
 * half of the table. Three things are worth pinning: a rectangle is normalized
 * no matter which corner it grew from, the anchor survives that normalization
 * (the next shift-extend measures from it), and the row clamp holds the anchor
 * inside the rectangle rather than sliding it out.
 * ================================================================== */

const NO_CLAMP = 0

describe('normalization', () => {
  test('a plain click is a 1×1 rectangle', () => {
    const r = rangeAt(4, 2)
    assert.deepEqual({ r0: r.r0, r1: r.r1, c0: r.c0, c1: r.c1 }, { r0: 4, r1: 4, c0: 2, c1: 2 })
    assert.equal(rangeCellCount(r), 1)
  })

  test('dragging up and to the left gives the same rectangle as down and to the right', () => {
    const down = rangeFrom({ row: 2, col: 1 }, 6, 4, NO_CLAMP)
    const up = rangeFrom({ row: 6, col: 4 }, 2, 1, NO_CLAMP)
    assert.deepEqual(
      { r0: down.r0, r1: down.r1, c0: down.c0, c1: down.c1 },
      { r0: up.r0, r1: up.r1, c0: up.c0, c1: up.c1 },
    )
  })

  test('the anchor is kept, not re-derived from the corners', () => {
    // Dragged up-left, so the anchor is the *bottom-right* corner. A rectangle
    // alone cannot say that, which is why it is carried separately.
    const r = rangeFrom({ row: 6, col: 4 }, 2, 1, NO_CLAMP)
    assert.deepEqual(r.anchor, { row: 6, col: 4 })
    assert.ok(isAnchor(r, 6, 4))
    assert.ok(!isAnchor(r, 2, 1))
  })

  test('counts every cell it covers', () => {
    assert.equal(rangeCellCount(rangeFrom({ row: 0, col: 0 }, 2, 3, NO_CLAMP)), 12)
  })
})

describe('membership', () => {
  const r = rangeFrom({ row: 2, col: 1 }, 5, 3, NO_CLAMP)

  test('is closed on both ends', () => {
    assert.ok(isInRange(r, 2, 1))
    assert.ok(isInRange(r, 5, 3))
    assert.ok(!isInRange(r, 1, 1))
    assert.ok(!isInRange(r, 6, 3))
    assert.ok(!isInRange(r, 3, 0))
    assert.ok(!isInRange(r, 3, 4))
  })

  test('the per-row test ignores columns', () => {
    // What a row component asks before deciding whether any of its cells are in.
    assert.ok(rangeHasRow(r, 3))
    assert.ok(!rangeHasRow(r, 9))
  })

  test('nothing is in a null range', () => {
    assert.ok(!isInRange(null, 0, 0))
    assert.ok(!rangeHasRow(null, 0))
    assert.ok(!isAnchor(null, 0, 0))
    assert.equal(rangeCellCount(null), 0)
  })
})

describe('the row clamp', () => {
  test('stops the rectangle growing past the limit', () => {
    const r = rangeFrom({ row: 0, col: 0 }, 100_000, 0, 20_000)
    assert.equal(r.r1 - r.r0 + 1, 20_000)
  })

  test('clamps the dragged end, never the anchor', () => {
    // Dragging *upwards* past the limit: the far end is what gives way, so the
    // anchor stays inside its own rectangle and the next shift-extend still has
    // a highlighted cell to measure from.
    const r = rangeFrom({ row: 50_000, col: 0 }, 0, 0, 20_000)
    assert.equal(r.r1, 50_000)
    assert.equal(r.r0, 50_000 - 20_000 + 1)
    assert.ok(isInRange(r, r.anchor.row, r.anchor.col))
  })

  test('leaves a rectangle inside the limit alone', () => {
    const r = rangeFrom({ row: 10, col: 0 }, 20, 2, 20_000)
    assert.equal(r.r0, 10)
    assert.equal(r.r1, 20)
  })

  test('does not clamp columns', () => {
    // The limit exists because main reads an attachment by offset and limit over
    // *rows*. A wide result set is bounded by its own schema.
    const r = rangeFrom({ row: 0, col: 0 }, 0, 900, 20_000)
    assert.equal(r.c1, 900)
  })
})
