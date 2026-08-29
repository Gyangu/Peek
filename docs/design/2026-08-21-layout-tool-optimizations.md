# Five refinements to the layout tools

## What this fixes

`set_layout` is the heaviest tool on the MCP surface: one tree describing the
whole window, applied atomically. It works, and this is not a bug fix — it is
smoothing five rough surfaces that a period of use has exposed. Each in turn:

1. **`layout.setRatio` has no MCP tool.** `read_workspace` goes out of its way to
   emit every split's `id` / `dir` / `ratio`, and the comment on that line in
   `summary.ts` reads "which layout.setRatio needs" — but there is no such tool
   under `mcp/tools/`. So an AI that only wants to pull the left column from 0.5
   to 0.65 has one route: **resend the whole tree** with `set_layout`, paying for
   the whole tree in tokens and doing it in the teeth of `unplaced`'s default
   (omit one view and it closes). A purely visual nudge should not cost that.

2. **A view created by `open` cannot be selected by `activeViewId`.** The schema
   forbids it and the reason holds — a new view has no id until the command has
   run. The consequence is that "open three queries in a pane and show the
   second" cannot be done in one call and needs `set_layout` plus
   `activate_view`, two round trips. The comment in `workspace-restore.ts` exists
   because of exactly this restriction.

3. **The same input is parsed by zod three times.** For the sake of `.strict()`
   (which catches a misspelled field name like `viewId`, which would otherwise be
   dropped silently and then have its view closed by the default
   `unplaced:"close"`), the tool layer restates the whole recursion as
   `StrictSpecNodeSchema`, then parses core's `LayoutSetLayoutInputSchema` in full
   again inside a `superRefine`, and then the dispatcher parses it once more. Two
   of the three definitions are copies, and copies drift.

4. **`unplaced` defaults to `close`, and "omitted" looks exactly like "meant to
   close".** The strict schema catches a misspelled field; it cannot catch a model
   **leaving a view out** of the list — and leaving one out closes it along with
   its connection and its result set. The default's own justification ("the tree
   is the whole window") holds; the problem is the silence, in that the caller
   never said it wanted to close anything.

5. **`TREE_DOC` is about 3.1KB (≈800 tokens) and goes out every session.** The
   whole "Tabs or panes?" passage duplicates the MCP `instructions`, and of the
   two complete examples one is a variation of the other.

Boundary: **Command semantics do not change at all.** `layout.setLayout`'s
`unplaced` still defaults to `close`, and `layout.setRatio`'s behaviour does not
change by a word. The new rule in point 4 is added at the MCP tool layer only —
only a model omits things, and the trees that `workspace-restore.ts` and the
renderer send in are program-generated and should not pay for it. Also not done:
no presets for `set_layout` (`grid` / `columns` shorthands), no compact DSL, no
changes to the `MAX_*` ceilings, and nothing about performance — at 16 panels ×
12 tabs the traversal cost is negligible, and changing this in performance's name
would be self-deception.

## The plan

### 1. A new `set_ratio` tool

`apps/desktop/src/main/mcp/tools/set-ratio.ts`, a thin shell over the existing
`layout.setRatio`:

```json
{"splitId": "split_1", "ratio": [0.65, 0.35]}
```

Two pre-checks, together in one `requireSplitRatio` function (`layout-check.ts`'s
established position: diagnosis, existing so that a failure carries its own fix):

- the split does not exist → NOT_FOUND, listing every current split with its
  `dir`, child count and current ratio. The handler can only answer
  `error.layout.splitNotFound`, which cannot distinguish "stale id" from
  "misspelled".
- the ratio's length does not match → BAD_REQUEST, saying how many children this
  split has.

No `expectRev`: changing a ratio destroys nothing, and a stale `splitId` is
already stopped by NOT_FOUND. A second optimistic lock would only widen the tool
surface.

### 2. A panel leaf gains `activeOpenIndex`

The restriction that `activeViewId` may only point at an existing view stays —
it is correct. A parallel field is added, pointing at an index in the `open`
array:

```json
{"type":"panel","open":[<q1>,<q2>,<q3>],"activeOpenIndex":1}
```

The two are mutually exclusive (the schema refuses both at once), and
`activeOpenIndex` must be less than `open.length`.

The path: `LayoutSpecPanel` gains the field → `BuiltLeaf` passes it through →
`layout.setLayout`'s reduce activates the corresponding view with the existing
pure function `activateViewInTree`, **after** every `open` on that leaf has been
created. The position matters: before that, "the second one" does not exist yet.

### 3. Strict moves up into core, and the tool layer's copy is deleted

- `LayoutSpecPanelSchema` and `LayoutSpecSplitSchema` are defined `.strict()` in
  core. The recursion is `z.lazy(discriminatedUnion([panel, split]))`, and strict
  members make the whole tree strict — the tool layer restated the recursion in
  the first place precisely because `.strict()` cannot reach a `z.lazy` defined
  elsewhere, and adding it at the source removes that problem.
- Core extracts the cross-node validation into a named
  `refineLayoutSpecInput(value, ctx)`, which both
  `LayoutSetLayoutInputSchema` and the tool layer's `InputSchema` `.superRefine`.
  The tool layer therefore **no longer** re-parses core's schema in full: one
  parse fewer, one copy fewer.
- `StrictSpecNodeSchema` is deleted outright.

Callers to confirm: `toLayoutSpec` in `workspace-restore.ts` emits only `type` /
`key` / `dir` / `ratio` / `children`, which is clean; the renderer does not
construct specs.

### 4. An omission is refused, and `close` must be explicit

In the tool layer's `toCommands`: compute the open views absent from the tree, and
if any **exist** and the caller did **not** pass `unplaced` explicitly, fail with
CONFLICT, listing the missing views along with their `describe`.

```
set_layout: 3 open views are absent from the tree and this call did not say what to
do with them: view_2 (Table public.orders), view_3 (Query on conn_1), view_5 (Chat).
Pass unplaced:"close" to close them, "keep" to park them, or add them to the tree.
```

So all four outcomes have their own spelling and none of them is the one that
happens by default:

| intent | spelling |
| --- | --- |
| close the omitted ones | `unplaced:"close"` |
| keep them, unshown | `unplaced:"keep"` |
| I am sure I omitted nothing | `unplaced:"error"` (errors if something was) |
| the tree covers everything | omit it; passes as before |

The Command's default does not change, so this rule applies to MCP callers only.

### 5. A gentle compression of `TREE_DOC`

The "Tabs or panes?" passage goes entirely (`instructions` already covers it, and
more completely); the two complete examples merge into one that demonstrates
split, multiple tabs, `open` and `focusKey` together; the rules are tightened word
by word. Every hard rule survives, along with at least one complete JSON example
that can be copied verbatim — that is what a model holds onto to get a tree right
first time, and cannot be cut to save tokens.

Measured: 2,822 → 2,249 characters (**-20%**), and that is **after adding** an
entire rule for `activeOpenIndex`. (The initial estimate was -30%; that number had
not accounted for the space the new field would take.)

## Trade-offs

- **Why point 4 does not change the Command's default.** Changing
  `layout.setLayout`'s default would reach `workspace-restore.ts` (called at
  startup, and passing no `unplaced`) and any future internal caller, none of
  which ever "omits" anything — their trees are program-generated. Putting the
  rule at the tool layer has a further benefit: the error message can carry each
  missing view's `describe`, where the handler has only a `count`.
- **Why point 4 is not a `keep` default.** `keep` would accumulate ghost views in
  the window that the user cannot see and cannot discover from the interface, each
  holding a connection and a result set. "If it is unclear, say so" is more
  honest than "if it is unclear, hide it".
- **Why point 2 is not a `key` on the `open` spec.** `ViewOpenSpec` is a shape
  shared by `view.open`, `layout.split` and `set_layout`, and polluting it for a
  field meaningful only inside `set_layout` is not a fair trade. An index written
  on the leaf is scoped to exactly that leaf.
- **Why point 1 does not fold the ratio into `move_view`.** A ratio and "where to
  move a view" are two different things, and forcing them together lengthens
  `move_view`'s parameter list again — while dragging a splitter is an
  independent gesture to begin with.
- **Why point 5 is not an aggressive compression.** The tree is the one input a
  model cannot cheaply feel its way to by trial and error, and the cost of getting
  it wrong once (a round trip plus an error the user can see) far exceeds the few
  hundred tokens saved per session.
- **`set_layout` keeps its ability to resend the whole tree** (it is not
  restricted now that `set_ratio` exists): rearranging the whole window is still
  its job, and `set_ratio` merely lifts out the most common nudge.

## Verification

Automated:

- `apps/desktop/src/main/mcp/__tests__/layout-tools.test.ts`
  - a tree omitting a view with no `unplaced` → CONFLICT, naming the omitted ids
    in the message;
  - the same tree with an explicit `unplaced:"close"` → emits a command as
    before;
  - a tree covering every view with no `unplaced` → passes;
  - an unknown field (`{"type":"panel","viewId":"view_1"}`) is still refused —
    behaviour unchanged by moving strict upwards;
  - `set_ratio`: emits one `layout.setRatio` normally; an unknown `splitId` →
    NOT_FOUND listing the existing splits; a mismatched ratio length →
    BAD_REQUEST saying how many children that split has.
- `apps/desktop/src/main/bus/__tests__/layout-ops.test.ts`
  - the new view that `activeOpenIndex` points at is the one finally visible;
  - `activeOpenIndex` together with `activeViewId` → refused by the schema;
  - an out-of-range `activeOpenIndex` → refused by the schema.

By hand: `pnpm test` (including `format:check`) and `pnpm typecheck` all green;
open the app and have the embedded agent run "widen the left column a bit",
confirming it reaches for `set_ratio` rather than resending the whole tree.
