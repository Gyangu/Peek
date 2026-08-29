# Dragging a selection in the grid: row drag-select and a rectangular cell range

## 1. What this fixes

### Where things stand

`DataGrid` has only two kinds of selection today:

- **The focused cell**, `selected: {row, col} | null` — click a cell; it drives
  the value inspector (`ValueModal`) and the fallback for `⌘C`.
- **The row set**, `rowSelection: RowSelection` — used by "send these rows to
  chat" and TSV copying, maintained by the pure functions in
  `context-actions/selection.ts`.

Both **know only discrete clicks**. `applyRowClick` handles plain / shift / ⌘
clicks, and `handleRowSelect` returns immediately when there is no modifier and
the click did not land on the row-number column. There is no `mousedown` +
`mousemove` drag logic anywhere in the renderer.

At the same time `body` carries `user-select: none` (styles.css:1290) and cells do
not opt out, so **holding the mouse down and dragging across the grid gives no
feedback at all**: no native text selection, no row selection, no region
selection.

The comment at `DataGrid.tsx:417-422` says dragging across cells is a row
selection gesture, but that gesture was never implemented. The documentation (the
comment) and the code diverge here, and this change fixes that too.

### The problem

For a database client, "box off a block of data and copy it" is the first
operation there is. Today it has to be done one row at a time with ⌘-clicks, or
cell by cell by double-clicking a modal open — and the latter does not even work
for short strings (`isExpandable` returns true only for strings over 80
characters or containing a newline).

### Boundary

Two things:

1. **Row drag-select** — press in the row-number column and drag up or down to
   select a continuous run of rows. This delivers the gesture the comment
   promised, reusing the existing `RowSelection` and everything downstream of it
   (chat attachments, row TSV copying).
2. **A rectangular cell range** — drag from any cell to another cell to select a
   rectangle, and `⌘C` copies it as TSV. This is a new selection model.

**Not doing**:

- Not restoring native text selection (`user-select: none` stays). The grid is
  virtualised, and a native selection crossing rows would pick up overscan rows
  and invisible DOM fragments, so what comes out does not match what is on screen.
- No non-rectangular multiple selection (⌘-dragging several rectangles). Excel has
  it, but it serves formula references there; the only thing downstream in Peek is
  copying, and there is no right answer for assembling several rectangles into
  TSV.
- No keyboard extension of a selection (shift+arrows). Arrows are scroll semantics
  today (because `overflow-y: hidden` took native scrolling away), and changing
  those semantics needs its own review; left for later.
- No change to the chat attachment's data contract. A rectangle does **not**
  participate in `ChatAttachment`; the reason is in §3.

  > **This item was overturned on 2026-08-15**, and the reason §3 gave turns out
  > on checking to be wrong. A rectangle now has a `cells` kind of attachment; see
  > docs/design/2026-08-15-cell-range-attachment.md.

## 2. The plan

### 2.1 The two selections are **mutually exclusive**: only one exists at any moment

| | what it is | downstream |
|---|---|---|
| `rowSelection: RowSelection` | a set of row indices (need not be contiguous) | chat attachments, row TSV copying, row highlighting, `SelectionActionBar` |
| `range: CellRange \| null` | one closed rectangle `{r0,c0,r1,c1}` + an anchor | rectangle TSV copying, cell highlighting, value inspector focus |

The key decision: **the focused cell is absorbed by the rectangle**. The old
`selected: CellPos | null` degenerates into the `range`'s anchor — clicking one
cell is a 1×1 rectangle. That leaves one source of truth for "where am I
looking", and `ValueModal`, the context menu's `contextTarget.cell` and `⌘C` all
read from the anchor.

On top of that, **establishing one clears the other**:

- any action on a cell (a click or a drag) → `rowSelection` is cleared;
- any action in the row-number column (a click or a drag) → `range` becomes null.

A click counts as a selection too; a 1×1 rectangle is not a "cursor" but a real
range.

The reason is that it saves two sets of rules that should not have to exist. Allow
them to coexist and two patches of highlight hang on the screen at once, so you
need a four-level background-colour priority, and a three-branch `⌘C` priority to
decide "which of these did you actually mean to copy". **Needing a priority rule
to disambiguate is itself the sign that the state should not coexist** — of two
selections on screen only one is the sentence the user is currently saying; the
other is left over from the previous one.

> **This overturns an existing record.** Above `handleRowSelect` in `DataGrid.tsx`
> it used to say: a cell click **must not** replace the row selection, because
> "people click cells constantly to read values, and wiping out a row selection
> they had built up every time would make the feature painful to use". That reason
> held while "the focused cell" was the only concept there was — clicking to read
> a value expressed no selection intent. Now that the cell side has a real
> selection, "clicking once" collapses the range to 1×1, which is a deliberate act
> rather than browsing. The cost is still there (a half-built row selection is
> wiped out by one misclick), but two patches of highlight on screen at once, with
> only a priority table to explain which one wins, is the bigger cost.

### 2.2 What `⌘C` copies

After exclusivity there is no priority left to state — at most one selection
exists:

1. There is a rectangle → spanning several cells, copy the rectangle (TSV, with
   headers, and only the selected columns); 1×1, copy the value itself (no
   headers, the same as today's "copy value");
2. otherwise there is a row selection → copy those rows (unchanged);
3. neither → do not swallow the event.

### 2.2.1 A right-click inside a selection does not change it

Right-click **on a selected row**, or **inside the rectangle**, and both kinds of
selection stay exactly as they are — that is precisely where "send these rows to
chat" and "copy this block" live in the menu, and if a right-click cleared the
selection there would be nothing left to act on by the time the menu opened.
Clicking outside the selection follows the exclusivity rule above.

### 2.3 How the drag is implemented

A `dragRef` holds the gesture in progress:

```ts
type GridDrag =
  | { kind: 'rows'; anchor: number; additive: boolean; base: RowSelection }
  | { kind: 'cells'; anchor: CellPos }
```

- `mousedown` landing in the row-number column (`data-gutter`) → `kind: 'rows'`;
  landing on a cell (`data-col`) → `kind: 'cells'`. `base` is a snapshot of the
  row selection at press time, used for the incremental merge of a ⌘-drag — every
  `mousemove` recomputes from the snapshot rather than accumulating on the
  previous frame's result, otherwise dragging back would not deselect rows.
- `mousemove` is bound on `window` (not on the row elements). Dragging outside the
  grid, or out of the window, has to keep following, as drag gestures generally do.
- `mouseup` is bound on `window`, clears `dragRef` and unbinds.
- `onCellClick`'s expansion logic does not fire during a drag: the `click` event
  that follows a `mouseup` is swallowed if this gesture moved (crossed a cell
  boundary). Otherwise one drag pops the modal open.

### 2.4 Hit testing is arithmetic, not DOM

`document.elementFromPoint` is **not** used to look up `data-col` during a drag,
for two reasons: during auto-scroll the pointer can be outside the grid, where
there are no cells; and under virtualisation the overscan rows are real DOM, so
`elementFromPoint` hits rows that are off screen.

Pure arithmetic instead, `hitTest(clientX, clientY)`:

- **Row**: `row = floor((clientY - bodyTop + driver.metrics.top) / ROW_H)`, where
  `bodyTop = wrapRect.top + HEAD_H`. Then clamp to `[0, rowCount-1]`.
- **Column**: `x = clientX - wrapRect.left + scrollEl.scrollLeft - GUTTER_W`,
  located by one linear scan of the prefix sums of `widths`. The column count is
  bounded (the schema's width), a linear scan is enough, and it is not worth
  maintaining a prefix-sum array for it.

This arithmetic is the same geometry as `vscroll.ts`'s (`ROW_H`, `HEAD_H`, `top`),
so the selection and the rows on screen are always aligned, including on the frame
that crosses a 4096-row origin boundary — because it reads `driver.metrics.top`
(virtual pixels), not the DOM transform.

### 2.5 Auto-scroll at the edges

While the drag is within 24px of the grid's top or bottom, a
`requestAnimationFrame` loop calls `driver.scrollBy(±step)`, with `step` growing
linearly with how far into the edge it is (capped at 3 rows per frame). After each
frame's scroll, `hitTest` is re-run against **the last recorded pointer
coordinates**, so with the pointer still and the content scrolling the selection
keeps extending — this is what Finder and Excel do. The rAF is cancelled on
`mouseup`.

### 2.6 The rectangle's upper bound

The rectangle's row span is clamped to `MAX_SELECTION_SPAN` (20,000, from
`selection.ts`). Once the bound is reached, dragging further down leaves the
selection where it is.

This truncates **at construction time**, not at copy time, for a reason that is
the opposite of but shares a root with the record in `selection.ts` about "a
selection is not clamped to the loaded window": the highlight on screen has to be
exactly the thing that will be copied. Stopping at construction lets the user see
that they hit the bound; truncating only at copy time means the highlight says 50
thousand rows and the clipboard has 20 thousand, and nobody would notice.

(Row drag-select still goes through `applyRowClick`, which does not clamp — as
today; and `⌘A`'s `rowCount > MAX_SELECTION_SPAN` guard does not change either.)

### 2.7 Cells that have not loaded

A rectangle can cover rows that have not arrived from the stream yet (`getCell`
returns a pending marker). On copy those cells are written with the same pending
text `ValueModal` uses, and `CopyPlan` counts them separately and reports the
count in the toast — the same pattern as the existing `truncated` count: give what
is in hand, and say plainly what is missing.

### 2.8 Files involved

| file | change |
|---|---|
| `components/cellRange.ts` | **new**. The `CellRange` type and pure functions: `rangeFrom`, `normalize`, `isInRange`, `rangeCellCount`, `clampRange`. Like `selection.ts` it is a pure module and can be unit-tested. |
| `components/gridCopy.ts` | new `copyRangePlan(src, range)`; `CopyPlan` gains a `pending` count. |
| `components/DataGrid.tsx` | `selected` → `range`; the drag state machine, window listeners, `hitTest`, auto-scroll; `⌘C` priority; passing `inRange` down to the row component. |
| `util/format.ts` | `cellSurfaceClass` gains an `inRange` level, ranked below the focused cell and above the row selection. |
| `i18n/messages/{en,zh-CN}/grid.ts` | two strings: rectangle copy done, and the pending note. |
| `components/__tests__/cell-range.test.ts` | **new**, cases for the pure functions. |
| `components/__tests__/grid-copy.test.ts` | added cases for `copyRangePlan`. |

### 2.9 The highlight's levels

`cellSurfaceClass(odd, rowSelected, cellSelected)` gains an `inRange` level:

1. the anchor cell (accent outline, the existing `SURFACE_CELL_SELECTED`)
2. inside the rectangle (`bg-bg-sel`, no outline)
3. the row is selected (`bg-row-sel`)
4. zebra striping / resting state

Of the first three, levels 2 and 3 **cannot both be true by construction** (§2.1),
so the order between them is not a rule a user can observe; it just defines the
impossible combination as well, so that behaviour is not undefined the day some
change lets them collide.

No outline is drawn around the rectangle as a whole — under virtualisation the
rectangle's top and bottom edges can be off screen, and half a box drawn is more
confusing than none. Per-cell backgrounds already express the extent.

## 3. Trade-offs

**Why the rectangle does not participate in chat attachments.**
~~`ChatAttachment`'s contract is "one view + a set of row indices", and main's
`resolveAttachment` re-reads those rows by offset/limit. Making it accept a subset
of columns amounts to requiring every driver's read path to support projection,
which is a data-plane change and far beyond the boundary of an interaction fix. A
cell range serves the clipboard only; to send something to the agent, select
rows.~~

> **Void (2026-08-15).** This paragraph is wrong, and the counter-example is in
> the very file it names: `resolve.ts`'s `resolveCell` has been doing column
> projection all along — it reads the whole row, then picks one column out by name
> with `findIndex`. Column trimming happens after main receives the rows, and the
> driver knows nothing about it. What was written here imagined "a subset of
> columns" as a projection pushed down to the data source, while the actual
> implementation sits a layer above that. A rectangle now has an attachment kind of
> its own; the design is in docs/design/2026-08-15-cell-range-attachment.md. Struck
> through rather than deleted: this is a wrong conclusion written because the
> neighbouring implementation in the same file was never checked, and it is worth
> leaving where it is.

**Why not `user-select: text` plus a native selection.** Anyone who has tried this
route hits the same wall: in a virtualised list the native selection runs into
off-screen overscan rows, the text `window.getSelection().toString()` returns does
not match the region boxed on screen, and horizontal virtualisation makes the
scrolled-away columns vanish from the text outright. Computing the rectangle
yourself is the only way the correspondence between selection and data is
determinate.

**Why window listeners rather than pointer capture.** `setPointerCapture` is more
modern, but the capture hangs on a specific row element, and rows are unmounted by
virtualisation while scrolling — the capture goes with them, and the drag breaks
mid-scroll. Window listeners depend on no node that can disappear.

**Given the exclusivity, why not merge them into one state.** A single unified
"selection" union expressing both the row set and the rectangle was considered.
Exclusivity does make it hold at the type level, but the two have entirely
different downstreams (one goes to the agent, one to the clipboard), the row
selection allows gaps (the scattered rows a ⌘-click produces) and a rectangle is
contiguous by definition. With a merged union, the first thing every consumer does
is branch on which half it got — which only moves the `if` out of the state and
into every use site. Exclusivity is one rule **at write time** (establishing one
clears the other), and writing it in one place is enough.

**Why nothing weaker than "clear the other" to soften coexistence**, such as
greying out the unfocused selection. Trying to keep both visible with one primary
and one secondary moves the priority out of the code and into the colour scheme,
and the user still has to learn "the grey one is the one `⌘C` will not copy". One
fewer highlight is easier to explain than one more colour.

## 4. Verification

Automatic:

- `cell-range.test.ts` — normalising a backwards drag, a single-cell rectangle,
  `MAX_SELECTION_SPAN` truncation, `isInRange` boundaries.
- `grid-copy.test.ts` — the rectangle contains only the selected columns, headers
  line up, TSV escaping, the pending count.
- The existing `grid-layout.test.ts` must continue to pass (the DOM structure did
  not change).

By hand (against a table with a few thousand rows):

0. Select a few rows, then click any cell → all the row highlighting disappears and
   only that one cell is left; and the other way round, box off some cells then
   click a row number → the rectangle disappears. At any moment there is only one
   selection on screen.
1. Press in the row-number column and drag down → a run of rows highlights, the
   `SelectionActionBar` appears with the right count; dragging back shrinks it.
2. Hold ⌘ and drag → it adds incrementally on top of the existing row selection;
   dragging back undoes the newly added part and leaves the existing part alone.
3. Drag diagonally across cells → the rectangle highlights; after `⌘C`, paste into
   a spreadsheet and the rows and columns match what was boxed.
4. Drag to the bottom edge of the grid and hold → it scrolls down automatically and
   the selection keeps extending; release to stop.
5. Releasing after a drag must not pop the value modal open; clicking without
   dragging behaves exactly as before (a click expands a truncated value, a
   double-click expands long text).
6. Drag past the bound (>20,000 rows) → the highlight stops at the bound and grows
   no further.
7. Refresh (a new result of the same shape) → both kinds of selection are cleared,
   consistent with the existing swap logic.
8. Select several rows and then **right-click on one of them** → the row selection
   survives and "add these rows to the chat" is still in the menu; right-click on a
   cell outside the selection → the row selection is cleared and the menu becomes
   the one for that single cell.

### 4.1 Record of the by-hand run (2026-08-14)

Steps 0–8 above were all run against a dev instance, with `pg-local`'s
`SELECT i, md5(i::text), i*7, 'row '||i FROM generate_series(1,50000) i` as the
data source (50,000 rows × 4 columns). Input was injected as real events via CDP
`Input.dispatchMouseEvent` / `dispatchKeyEvent`, and the assertions read the DOM
class names directly (`bg-rownum-sel` / `bg-bg-sel` / `outline-accent`) plus the
toast text.

Step 6 (the 20,000-row bound) was not triggered by a long drag but by an
equivalent path: the anchor landed on row 417, `End` jumped to the end of the
table, then shift-click, after which `⌘C`'s toast reported **"Copied 20000
cells."** while the number of highlighted cells visible in the rows at the end of
the table was 0 — the bound holds, and the highlight matches what would be copied.

**One thing that could not be verified**: whether a real keyboard `⌘C` is
swallowed first by the macOS Edit menu. `menu.ts` has `{ role: 'copy' }` (and
`{ role: 'selectAll' }`, which corresponds to the grid's ⌘A), and macOS menu
accelerators are handled before the event reaches the page. CDP injection bypasses
the native menu, so what it proves is that the renderer's handler is correct, not
that the key path itself is clear; and this machine has no accessibility
permission, so real keystrokes cannot be sent. The risk was not introduced by this
change (row copying's ⌘C has always made the same assumption), but this change
makes ⌘C the only outlet for the cell range, so it is worth checking on its own. If
it is being swallowed, the usual fix is `registerAccelerator: false` on those two
menu items, or listening for the DOM `copy` event on the grid.
