# A view the model opens lands beside the conversation, not on top of it

## What this fixes

As it stands, a `view.open` without a `panelId` has its destination decided by
`resolvePanel` (`apps/desktop/src/main/bus/handlers/shared.ts`): the focused
panel → the first empty panel → the first panel. Since tabs shipped, `replace`
defaults to `false`, so when the destination panel already holds something the
new view **appends a tab and shows it**.

For a human click that is right (every database GUI does it). For a
**conversation** it is not: the user says "open public.harness" from inside a
chat view, the focused panel is the column the chat is in, so the newly opened
table becomes a new tab in that same column and takes the foreground, **covering
the conversation itself**. The user can see neither the question they just asked
nor the answer coming next, and has to click back to the chat tab — where the
model's next sentence covers it again.

The same path is taken by `query.run` (which opens a new query view without a
`viewId`) and `conn.open` (`openTree`); all of them go through the same
`openView`.

What changes here: **when the source is not a human, no panel was specified, and
the destination happens to hold a conversation, open the view in another
column.**

Boundary (not done):

- No change to any behaviour from a human source (`source: 'ui'`) — clicking a
  table in the sidebar, dragging, and keyboard shortcuts are all as they were.
- No change to calls carrying an explicit `panelId`. If the model says where, it
  goes there, and `layout.split` / `layout.setLayout` / `layout.moveView` are all
  unaffected.
- No change to `provisional`'s slot rule: the skim slot still wins, and it comes
  from a human single click to begin with.
- No new layout concept such as "the conversation's own column", and no new field
  on `Workspace`. This rule looks only at **the tree at this moment**: does some
  panel hold a `kind: 'chat'` tab.

## The plan

One decision, inside `openView`'s destination resolution
(`handlers/shared.ts`), so that `view.open`, the query view `query.run` opens,
and `conn.open`'s tree view are all covered at once.

### When it triggers

All four must hold before the destination changes:

1. `ctx.source` is `'mcp'` or `'agent'`. `'ui'` is a human, `'system'` is an
   internal command such as a restore or a reconnect, and neither is affected.
2. The call gave no `opts.panelId`.
3. No provisional slot was obtained.
4. The panel the old rules resolve to **holds a chat tab**.

Fail any of the first three and it is the old path, with not a line diverted.

### Where it goes instead

1. The first panel in visual order (`collectPanels`, depth first, i.e. left to
   right and top to bottom) that **holds no chat**, preferring an empty one — use
   the empty column on the right rather than squeezing into a column that already
   has a table.
2. If there is none (a single column, or every column holding a conversation) →
   split in place: relative to the destination panel, `dir: 'row'`,
   `insert: 'after'`, i.e. **a new column to its right**, with the view in it.
3. If splitting would exceed the panel-count or tree-depth ceiling, **fall back
   silently** to the old behaviour (append a tab in the conversation's column).
   No error here: what the user wants is to see the table, not "nothing happened
   because the window is too full".

### Focus

When the destination changes, **`focusedPanel` does not move** — the conversation
remains the focused panel even though the view opened elsewhere.

The cost is that a model opening three tables in a row recomputes "the other
column" each time; the benefit is that the answer is stable (same tree, same chat
panel → same column), so three tables stack tidily in one column, and the moment
a person takes over, the cursor is still on the conversation.

`activate` is unchanged: the new view is the visible tab in its column. So
"opened in another column" is genuinely visible; only the keyboard focus stayed
put.

One corner: `openView` used to write `focusedPanel` **unconditionally**, which
incidentally repaired a dangling focus pointing at a panel that had gone. The
diverted branch does not write it, so one line has to make up for that — when
focus is `null` or resolves to no panel, it falls to "the column the view was
going to open in" (that is, the conversation's column) rather than the new column,
and certainly rather than being left dangling.

### Files involved

- `apps/desktop/src/main/bus/handlers/shared.ts` — a new `resolveOpenTarget`
  (with `panelHoldsChat` / `firstPanelWithoutChat` / `splitBeside`), with
  `openView` switching to it; `assertWithinLimits` gains a boolean-returning
  `withinLimits` for the silent fallback.
- `apps/desktop/src/main/mcp/tools/open-view.ts` — the sentence "Without panelId
  the view opens in the currently focused panel" is now a half-truth, and the
  avoidance rule is added. (`run_query`'s description never mentioned placement
  and is untouched.)
- `apps/desktop/src/main/mcp/instructions.ts` — a sentence in the "Panels and
  tabs" section, so the model knows this is a rule of the window rather than an
  illusion of its own (it will see a panel it did not ask for in `uiEffects`).

## Trade-offs

- **Why the test is "this panel holds a chat" rather than "which chat view the
  command came from"**: the latter is more precise, but `ReduceCtx` has no
  originating viewId, and adding one means threading it from the MCP session all
  the way to the Command Bus — changing a layer's contract for the sake of a
  placement rule. And it is not more correct anyway: with two conversations in one
  column, avoiding "the one that asked" still covers the other. Reading the tree
  as it stands solves both cases together.
- **Why a newly opened chat view is diverted too**: the rule does not look at
  what the new view is, only at the destination. Asking the model from a
  conversation to open another conversation should equally not cover the current
  one.
- **Why not just have the model call `layout.split` itself**: it can, and
  `instructions.ts` has always taught it to. But the default decides what happens
  in the overwhelming majority of cases, and "cover the person asking" is a bad
  default — expecting the model to remember to split first is outsourcing a rule
  of the window to the prompt.
- **Why the split direction is hard-coded to `row`**: peek's window is
  horizontal and a conversation is narrow to begin with; splitting vertically
  flattens both halves. Arranging them vertically on purpose is one sentence to
  `move_view` or `set_layout`.
- **Why exceeding the ceiling falls back silently rather than raising CONFLICT**:
  `assertWithinLimits` raising in `layout.split` is right (the model explicitly
  asked to split, and if it cannot, it must be told); here the split is only the
  **means**, and falling back to appending a tab still accomplishes "open this
  view", where an error would throw away what the user actually wanted.
- **What if the diverted column's tabs are full**: `CONFLICT` as before
  (`assertPanelTabsWithinLimit`). Picking a panel that is "neither full nor
  holding a chat" is possible, but that is writing policy for a problem that has
  not appeared.

## Verification

Unit tests:
`apps/desktop/src/main/bus/__tests__/open-beside-chat.test.ts` (12 cases; every
conversation in the fixture is opened with a real `view.open` rather than a
hand-written `ChatViewState`).

The diverted side:

1. The focused panel holds a chat, source `'agent'`, one column only → the tree
   gains a column (`dir: 'row'`, after the chat), the view is in the new column,
   and `focusedPanel` is still the chat's column.
2. As above but a second (empty) column exists → no split, the view lands in that
   column.
3. As above but the second column already holds a table → no split, a new tab in
   the second column, and the visible one.
4. Three columns, the second occupied and the third empty → the empty one wins.
5. Source `'mcp'` (an external client) follows the same rule as `'agent'`.
6. Two opens in a row → both land in the same column without spreading rightwards,
   and focus stays on the conversation throughout.
7. `query.run` (no viewId) takes the same path.
8. A **conversation** the model opens is diverted too.

The side that must not move:

9. Source `'ui'` → lands in the focused panel as before, tree unchanged.
10. An explicit `panelId` pointing at the chat's column → lands there as before,
    and focus follows as usual.
11. The focused panel holds no chat → lands in the focused panel as before, and
    focus follows as usual.
12. At `MAX_LAYOUT_PANELS` with a conversation in every column → no throw; falls
    back to appending a tab in the chat's column (which is not a diversion, so
    focus follows as usual).

By hand: one conversation in one full-screen column, and ask the model to open a
table — the window should become two columns, conversation on the left and table
on the right, with the input box still ready to type into; then ask for a second
table, which should land in the right column as a second tab with the left column
unmoved.
