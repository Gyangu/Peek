# Tearing a tab out of the panel it already lives in

## What this fixes

As it stands, dragging a tab onto the edge zone of **any** panel body splits the
layout — except for the panel the tab came from. `dropCommandFor` carries an
unconditional `if (samePanel) return null`
(`apps/desktop/src/renderer/components/dragMachine.ts`), so whenever the drop
target equals the drag's origin panel, none of the five zones in the body
produces a command; `panelDropZone` unconditionally erases the source panel's
highlight for the same reason.

The consequence: with only one panel open (full screen), the only panel
available to drop onto *is* the source panel, so **there is no way to split by
dragging at all** — only the keyboard shortcut or the MCP `set_layout`. With
several panels open, "pull this tab out next to itself" is blocked the same way.

The original justification for the restriction is invariant I6: splitting onto
yourself creates a new panel → the source panel is emptied → it collapses back →
nothing has happened except that a panel id changed.

But that reasoning only holds when **the source panel has just this one tab
left**. The main process narrowed the condition to exactly that long ago —
`wouldCollapseBack` in `splitPanelWithView`
(`apps/desktop/src/main/bus/layout-ops.ts`) explicitly requires
`source.id === target.id && source.viewIds.length === 1`, and its comment reads:
pulling one tab out of a three-tab panel and placing it alongside that same
panel empties nothing, and the split stands.

So what changes here is that **the renderer's gesture test catches up with the
semantics the main process already has**. This is not a relaxation of I6.

Boundary (not done here):

- `splitPanelWithView` and every other piece of main-process logic are untouched
  — they are already right.
- No modifier-key gestures, and no new gesture entry point for `swap` or
  `replace`.
- The **centre zone** of the source panel's body stays a no-op (the view is
  already there); only the four edges open up.
- A single-tab panel dragged onto itself stays a no-op, with behaviour entirely
  unchanged.

## The plan

One file changes: `apps/desktop/src/renderer/components/dragMachine.ts`.

A new internal test: was the source panel measured as holding one tab or fewer
when the drag began. The data is already in `DragActive.panels` —
`PanelHit.tabRects` is measured off `role="tab"` at the start of the drag — so
`DragState` needs no new field and nothing has to read the workspace. A missing
`tabRects` (test fixture, strip not yet laid out) is treated as ≤ 1, preserving
the old behaviour.

```ts
function sourceIsLoneTab(state: DragActive): boolean {
  const hit = state.panels.find((p) => p.panelId === state.fromPanelId)
  return (hit?.tabRects?.length ?? 0) <= 1
}
```

Two places relax:

1. `dropCommandFor`: `if (samePanel) return null` becomes — when the drop lands
   on the source panel, anything outside an edge zone is null (the centre is a
   no-op), and an edge zone emits `layout.splitWithView` only when the source
   panel holds more than one tab.
2. `panelDropZone`: the source panel's highlight is likewise only offered for
   "multiple tabs, edge zone", so that the preview and the command that actually
   lands are always the same judgement. Nothing lights up without responding.

`isDropEdgeZone` and `dropZonePlacement` are reused as they are, and the shape of
the command does not change.

## Trade-offs

- **Why not add a `siblingCount` field to `DragOrigin`**: that would require
  every `beginViewDrag` call site to count tabs, and the only call site,
  `PanelTabs`, has already rendered those tabs — it would store the same fact
  twice. The measurements in `panels` are the one geometry source trusted for
  the duration of a drag (`remeasureDrag` refreshes them when a second writer
  changes the layout), and deriving the test from them guarantees it, the
  highlight and the caret all read the same snapshot.
- **Why not let the centre zone split as well**: the centre zone means "put it
  into this panel", and for the source panel that is staying put. Making it
  split would collide with what the centre zone means on every other panel.
- **Why not add a second guard in the main process**: the main process already
  guards (`moved: false`). With the renderer relaxed, a single-tab case that
  slipped through would only come back as a `moved: false` result, and would not
  damage the tree.

## Verification

- Four cases added to the `dragMachine` unit tests
  (`apps/desktop/src/renderer/components/__tests__/view-drag.test.ts`):
  single-tab source panel, edge → null (regression); multi-tab source panel,
  edge → `layout.splitWithView`; source panel centre → null (whatever the tab
  count); and `panelDropZone`'s highlight agreeing with the command across all
  four combinations.
- By hand: one full-screen panel with two tabs (say "object tree" and "chat"),
  drag "chat" to the right edge — a highlight should appear and the layout
  should split into two columns; drag it back to the centre of the left column's
  body and the panels should merge again.
- By hand, regression: with only one tab left in a panel, drag it to that
  panel's own edge — no highlight, no change.
