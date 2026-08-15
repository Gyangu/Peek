/**
 * Row selection — the state a grid needs before "add these rows to the chat"
 * means anything.
 *
 * `DataGrid` tracks a single focused **cell** (`{row, col}`), which is all the
 * value inspector ever needed. Attaching rows needs a *set*, with the two
 * gestures every table in every application has taught the user to expect:
 * shift-click extends a range, ctrl/cmd-click toggles one row.
 *
 * ## Why this is a pure module and not a hook
 *
 * The grid renders hundreds of thousands of rows and is the performance core of
 * the renderer (`DataGrid.tsx` explains what that costs). Selection has to be
 * something the grid can hold in whatever way suits it — `useState`, a ref, a
 * store — without this file having an opinion. Pure `(state, event) -> state`
 * functions can also be pinned down exactly, and the range arithmetic below is
 * precisely the kind of thing that is re-derived slightly differently in three
 * places and disagrees within a week.
 *
 * ## The rules, stated once
 *
 * - a plain click **replaces** the selection with one row and sets the anchor;
 * - ctrl/cmd-click **toggles** one row and moves the anchor to it, so a following
 *   shift-click extends from the row just touched (this is what Finder, Explorer
 *   and every mail client do; extending from a stale anchor feels broken);
 * - shift-click selects the closed range between the anchor and the clicked row,
 *   **replacing** the selection unless ctrl/cmd is also held, in which case the
 *   range is added to it;
 * - shift-click with no anchor behaves as a plain click, because there is nothing
 *   to extend from.
 *
 * Selection is deliberately **not** clamped to the loaded window. A user can
 * select rows that have since been evicted from the cache, and the honest place
 * to discover that is at send time, where `resolveAttachment` reports precisely
 * which rows it could not supply. Silently dropping them here would make the
 * attachment quietly smaller than the highlight on screen.
 */

/**
 * Widest span of rows an attachment may cover, mirrored from `MAX_ROW_SPAN` in
 * `main/acp/context/resolve.ts`.
 *
 * **Deliberately duplicated rather than shared.** The two live in different
 * processes, and the only place both could import from is `@peek/core`, which is
 * the contract package — putting a renderer ergonomics constant there would make
 * every driver depend on it. The duplication is safe in the direction that
 * matters: main enforces the real limit, and this copy exists only so the UI can
 * warn *before* a message is sent instead of turning it into an error. A copy
 * that drifts low warns too eagerly; a copy that drifts high falls back to main's
 * refusal, which is where the guarantee actually lives.
 */
export const MAX_SELECTION_SPAN = 20_000

export interface RowSelection {
  /** Where a shift-extend measures from. Null means nothing has been clicked yet. */
  readonly anchor: number | null
  /** Selected row indexes, absolute within the result set. */
  readonly rows: ReadonlySet<number>
}

export const EMPTY_SELECTION: RowSelection = { anchor: null, rows: new Set() }

/** The modifier keys a click carried. */
export interface ClickModifiers {
  shift: boolean
  /** `metaKey || ctrlKey` — the caller collapses the platform difference. */
  toggle: boolean
}

export function applyRowClick(selection: RowSelection, index: number, mods: ClickModifiers): RowSelection {
  if (mods.shift && selection.anchor !== null) {
    const range = rangeBetween(selection.anchor, index)
    // Additive extend keeps what was there; a plain extend replaces it. The
    // anchor does not move on a shift-click — dragging the far end of a range
    // back and forth has to stay measured from the same origin.
    const rows = mods.toggle ? union(selection.rows, range) : range
    return { anchor: selection.anchor, rows }
  }

  if (mods.toggle) {
    const rows = new Set(selection.rows)
    if (rows.has(index)) rows.delete(index)
    else rows.add(index)
    return { anchor: index, rows }
  }

  return { anchor: index, rows: new Set([index]) }
}

/**
 * The selection while a drag is in progress: the range from where the button
 * went down to the row the pointer is over now.
 *
 * `base` is the selection as it stood **when the drag started**, not the one
 * from the previous frame. Every move re-derives the whole answer from it, which
 * is what makes dragging back the way you came give rows up again; folding each
 * frame into the last would make the gesture a ratchet that only ever adds.
 *
 * `additive` keeps `base` and adds the range to it (the ⌘-drag), which is the
 * same rule `applyRowClick` follows for shift+⌘. Without it the range replaces
 * the selection outright.
 *
 * The anchor is passed in rather than read from `base`, because a drag has its
 * own origin — the row the button went down on — and it must not move while the
 * far end is being dragged around.
 */
export function applyRowDrag(
  base: RowSelection,
  anchor: number,
  index: number,
  additive: boolean,
): RowSelection {
  const range = rangeBetween(anchor, index)
  return { anchor, rows: additive ? union(base.rows, range) : range }
}

/** Select every row in `[0, rowCount)`. Bounded by the caller, since the grid knows the count. */
export function selectAllRows(rowCount: number): RowSelection {
  if (rowCount <= 0) return EMPTY_SELECTION
  const rows = new Set<number>()
  for (let i = 0; i < rowCount; i += 1) rows.add(i)
  return { anchor: 0, rows }
}

export function clearSelection(): RowSelection {
  return EMPTY_SELECTION
}

export function isRowSelected(selection: RowSelection, index: number): boolean {
  return selection.rows.has(index)
}

export function selectionSize(selection: RowSelection): number {
  return selection.rows.size
}

/**
 * The selection as a sorted array — the form `ChatAttachment.rowIndexes` takes.
 *
 * Sorted because the attachment is serialized in this order and a model reading
 * "rows at indexes 9, 2, 40" would reasonably wonder whether the order carried
 * meaning. It does not.
 */
export function selectedIndexes(selection: RowSelection): number[] {
  return [...selection.rows].sort((a, b) => a - b)
}

/**
 * How far apart the selection reaches.
 *
 * `resolveAttachment` refuses a selection spanning more rows than it is willing
 * to read (it addresses rows by offset and limit, so two rows 500,000 apart mean
 * reading everything between them). Exposing the span here lets the UI warn
 * *before* the user sends, rather than turning a message into an error.
 */
export function selectionSpan(selection: RowSelection): number {
  if (selection.rows.size === 0) return 0
  const sorted = selectedIndexes(selection)
  const first = sorted[0] ?? 0
  const last = sorted[sorted.length - 1] ?? 0
  return last - first + 1
}

function rangeBetween(a: number, b: number): Set<number> {
  const lo = Math.min(a, b)
  const hi = Math.max(a, b)
  const out = new Set<number>()
  for (let i = lo; i <= hi; i += 1) out.add(i)
  return out
}

function union(a: ReadonlySet<number>, b: ReadonlySet<number>): Set<number> {
  const out = new Set(a)
  for (const n of b) out.add(n)
  return out
}
