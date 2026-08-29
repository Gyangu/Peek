# The header spans the panel's full width

## What this fixes

### Where things stand

`DataGrid`'s header is a `sticky top-0` bar whose width comes from the inline
`totalWidth`:

```
totalWidth = GUTTER_W + Σ column widths        // DataGrid.tsx:365
```

It renders unconditionally — results or not, columns or not, the bar is there. It
carries `bg-bg-2` and a bottom `shadow-rule-b-strong`, and its first child is the
row-number corner block, likewise fixed at `w-gutter` with a right-hand
`shadow-rule-r-strong`.

So the moment `totalWidth` is less than the panel's width, the bar stops partway
across and `.grid-scroll`'s `bg-bg` shows to the right of it. Two situations run
into this:

1. **The empty state** — with no statement run yet there is no schema and no
   columns, so `totalWidth` equals `GUTTER_W` (54px). A 54px dark block therefore
   appears in the top left corner with a rule under it and a rule down its right
   side, hanging above the "Write a statement and run it" prompt. It is not data
   and it is not misaligned — it is a zero-column header, drawn as usual. That is
   exactly what the user sees.
2. **Columns narrower than the panel** — a query selecting two or three columns
   leaves the header stopping just past the last column, with the bottom rule
   stopping with it. The data rows do the same, but that rule is drawn by the
   header, so the break is where the eye goes.

The overlay prompts (`grid.notRun` / `query.empty` / `grid.noRows`) are a
separate layer over the whole `.grid-wrap` and know nothing of the header, so a
prompt and this stump appear together.

### The problem

Both situations are two faces of one bug: **the header's width is being taken
from the content**. The header is a piece of the panel's furniture. Its lower
bound should be the panel; only its upper bound is the content.

### Boundary

This changes the lower bound on the width of the header bar (and its internal
gutter corner block), and nothing else. Explicitly not done:

- **The data rows do not change.** `GridRow` still receives `totalWidth`, and a
  row's hover highlight and selection background still stop at the right of the
  last column. That is a question about how wide a row is, which is a different
  question from how wide the furniture across the top of the panel is; fixing
  both together would drag `GridRow`'s memo arguments in as well.
- **No special case for the empty state.** Not rendering the bar at all when
  `shownResultId`/`schema` is empty would fix one of the two situations and leave
  the other (columns narrower than the panel) exactly as it is.
- No geometry in `vscroll.ts` changes. Not one number here enters a scroll
  calculation.

## The plan

Give the bar a lower bound equal to the scroll container's width: two class names,
no new rules, no new state, no measurement.

Two places in `DataGrid.tsx`:

```
// grid-inner (:1084)
- <div className="grid-inner relative h-full" style={{ width: totalWidth }}>
+ <div className="grid-inner relative h-full min-w-full" style={{ width: totalWidth }}>

// the header bar (:1085-1088)
- className="sticky top-0 z-4 h-head bg-bg-2 shadow-rule-b-strong"
+ className="sticky top-0 z-4 h-head bg-bg-2 shadow-rule-b-strong min-w-full"
  style={{ width: totalWidth }}
```

Why both and not the header alone: `min-width: 100%` resolves against the
**containing block**. The header's containing block is `grid-inner`, and
`grid-inner` is itself a narrow `width: totalWidth` strip — add it only to the
header and it still stretches to 54px. So the lower bound has to be passed down
one level from `.grid-scroll`: `grid-inner`'s `min-w-full` is relative to the
scroll container, and the header's `min-w-full` is relative to a `grid-inner`
that now spans it.

Where `width` and `min-width` coexist the larger wins, so:

- columns wider than the panel (the normal case for a database viewer) →
  `totalWidth` wins, behaviour is exactly as it is today, and the header travels
  with a horizontal scroll;
- columns narrower, or no columns → the panel's width wins, the bar spans, and
  the small block in the empty state becomes a complete empty header with the
  overlay prompt sitting over it as before.

The gutter corner block needs no change: it is a fixed `w-gutter`, `sticky
left-0`, and a wider bar does not affect it.

`min-w-full` on `grid-inner` creates no new scrollable width for the scroll
container — `min-width: 100%` is the container's own width, not a pixel more.

Nothing is added to the stylesheet. Both of these are purely "what does this node
look like", which the Tailwind migration
(`2026-08-04-tailwind-migration.md`) assigns to the class-name side; the grid
section of `styles.css` is now down to `.grid-row { font-size: 0 }`, which
survives only because class names cannot express it, and there is no equivalent
here.

## Trade-offs

**Do not render the bar at all in the empty state.** The least work, and the
small block in the empty state disappears cleanly. But it treats only the empty
state: a query returning two columns still leaves the header stopping short. And
it introduces a rendering branch — whether the header exists now depends on
`shownResultId`, which is one more piece of state to keep in your head. Rejected.

**Take the header out of horizontal scrolling** (pin it to the panel and let only
the columns scroll). This would indeed keep the bar full width always, but it
moves the header out of the content layer and into the panel layer, so the column
titles would have to subtract `scrollLeft` themselves — taking over a job the
browser does for free. Far more expensive than what is being fixed. Rejected.

**Measure the panel's width in JS and write `Math.max(totalWidth, panelWidth)`
into the inline style.** The panel's width is already measured on `wrapRef`. But
this makes the bar's width depend on state that changes with the window, which is
one more resize → re-render; there is no reason to move a max CSS can compute
into React. Rejected.

## Verification

Automatic:

- `grid-layout.test.ts` should continue to pass. It asserts hierarchy and the
  `grid-` prefix, and neither change here touches the node structure or adds a
  selector.
- `audit-shipped-css.mjs` — `min-w-full` is an existing Tailwind utility;
  confirm no rule is minted that nothing wears.

By hand, on a real machine:

1. Open a Query tab and **do not** run it — no 54px dark block in the top left
   corner; a complete empty header across the top with its rule running to the
   panel's right edge, and "Write a statement and run it" in the middle as
   before.
2. Run `select customer, total from orders where total > 10` (two columns, far
   narrower than the panel) — the header does not stop past the last column, and
   the bottom rule runs to the right edge.
3. Run a query with enough columns to need horizontal scrolling — the header
   travels with the columns exactly as before, and shows no gap at the far right.
4. Resize the window and the panel; in states 1 and 2 the bar re-spans as it
   goes.
