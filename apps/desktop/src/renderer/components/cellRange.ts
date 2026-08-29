/**
 * The rectangular cell selection — the gesture a spreadsheet taught everyone to
 * expect from a table.
 *
 * Kept apart from `context-actions/selection.ts` on purpose. That module owns a
 * *set of rows*, which may be discontiguous — hand-picked with ⌘ — and this one
 * owns a *rectangle*, which is contiguous by definition. Both now reach both
 * downstreams (the clipboard and, as a `cells` attachment, the agent), so the
 * split is about the shapes and not about where they go; the earlier note
 * claiming one served only the clipboard is corrected in
 * docs/design/2026-08-15-cell-range-attachment.md §3.5. Merging them would
 * produce a union type whose every consumer branches on which half it holds.
 *
 * A pure module for the same reason `selection.ts` is one: the grid is the
 * performance core of the renderer and has to be free to hold this in whatever
 * way suits it, and rectangle arithmetic is exactly the kind of thing that gets
 * re-derived slightly differently in three places and disagrees within a week.
 *
 * The rectangle is **closed on both ends** — `{r0: 2, r1: 4}` covers rows 2, 3
 * and 4. Half-open would be the more usual choice for a range, but every other
 * index in the grid (the anchor, `visibleFirst`/`visibleLast`, the row a click
 * landed on) is an inclusive cell address, and one range in the file counting
 * differently from all of them is how off-by-ones are born.
 */

/** Where the drag started. Also the cell the value inspector is looking at. */
export interface CellPos {
  row: number
  col: number
}

/**
 * A normalized rectangle: `r0 <= r1` and `c0 <= c1` always hold.
 *
 * `anchor` is kept alongside the bounds rather than derived from them, because
 * it cannot be: after dragging up and to the left, the anchor is the rectangle's
 * *bottom-right* corner, and a rectangle alone cannot say which corner it grew
 * from. The next shift-click has to measure from that corner.
 */
export interface CellRange {
  readonly anchor: CellPos
  readonly r0: number
  readonly c0: number
  readonly r1: number
  readonly c1: number
}

/** The 1×1 rectangle a plain click makes. */
export function rangeAt(row: number, col: number): CellRange {
  return { anchor: { row, col }, r0: row, c0: col, r1: row, c1: col }
}

/**
 * The rectangle spanned by `anchor` and the cell the pointer is over now.
 *
 * `maxRows` clamps the row span — the rectangle stops growing rather than
 * growing past what may be copied. Clamping *here*, while the drag is still
 * running, is what keeps the highlight honest: it is the thing that will land on
 * the clipboard, so it must never claim more than that. Clamping at copy time
 * instead would put 20,000 rows on the clipboard while the screen showed 50,000,
 * and nobody would notice.
 *
 * The clamp is applied on the side being dragged, so the anchor's row always
 * stays inside the rectangle — an anchor outside its own selection would make
 * the next shift-extend measure from a cell that is not highlighted.
 */
export function rangeFrom(anchor: CellPos, row: number, col: number, maxRows: number): CellRange {
  let r0 = Math.min(anchor.row, row)
  let r1 = Math.max(anchor.row, row)
  if (maxRows > 0 && r1 - r0 + 1 > maxRows) {
    if (row < anchor.row) r0 = anchor.row - maxRows + 1
    else r1 = anchor.row + maxRows - 1
  }
  return {
    anchor,
    r0,
    r1,
    c0: Math.min(anchor.col, col),
    c1: Math.max(anchor.col, col),
  }
}

export function isInRange(range: CellRange | null, row: number, col: number): boolean {
  if (!range) return false
  return row >= range.r0 && row <= range.r1 && col >= range.c0 && col <= range.c1
}

/** Whether the range covers a row at all — the cheap per-row test a row component can run. */
export function rangeHasRow(range: CellRange | null, row: number): boolean {
  if (!range) return false
  return row >= range.r0 && row <= range.r1
}

export function isAnchor(range: CellRange | null, row: number, col: number): boolean {
  if (!range) return false
  return range.anchor.row === row && range.anchor.col === col
}

/** How many cells the rectangle covers. `1` means "this is just a focused cell". */
export function rangeCellCount(range: CellRange | null): number {
  if (!range) return 0
  return (range.r1 - range.r0 + 1) * (range.c1 - range.c0 + 1)
}
