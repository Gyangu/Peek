# Auto-refresh: turning `⟳` into a switch that can be held down

> 2026-08-03. Measured against DataGrip's Auto-refresh: a result view reruns its
> own fetch at a fixed interval, for watching a table that changes, a monitoring
> SQL statement, a keyspace.
>
> Coverage (decided this round): `table` / `query` / `vector` / `package` — that
> is, all four views `autoFetch` knows about. `tree` / `inspector` / `chat` are
> out; the reasoning is in §1.3.

---

## 1. What this fixes

### 1.1 Where things stand

peek only has **manual** refresh today:

- `TableView`'s toolbar `⟳ Refresh` → `view.update { patch: refreshPatch(ref), refresh: true }`
- `QueryView`'s `▶ Run` → `query.run`
- `VectorView`'s `Search` → `view.update { …, refresh: true }`
- `CacheGapNotice`'s "Run again" → the same

All four paths end up at `autoFetch` in `handlers/shared.ts`. Which is to say
**"fetch it again" has long been implemented**; what is missing is only
something that presses it once every N seconds, and not losing the place the
user is looking at once it has been pressed.

### 1.2 The problem

1. **Watching a table in motion means a twitchy finger.** An import job writing
   a progress table, a Redis queue's length, a line of `pg_stat_activity` —
   these are all "glance at it every few seconds" scenarios, and today the only
   way is to keep clicking.
2. **Every refresh blows the viewport back to the top.** `DataGrid`'s rule today
   is "new resultId ⇒ clear column widths, clear the selection, `driver.reset()`
   and scroll to the top". For a manual refresh that is right (the user asked
   for a new batch); for an auto-refresh every 5 seconds it is a disaster.
3. **The AI cannot see "this view is auto-refreshing".** Per PLAN §5/§6,
   interface state belongs to main and `read_workspace` is the AI's eyes. If the
   interval only lives in the renderer's `useState`, that is a second copy of
   state outside the layout, one the model can neither read nor change.

### 1.3 Boundary (explicitly not done)

- **`tree` is not touched.** PLAN §8 already nails down the namespace tree's
  invalidation policy: "lazy load + cache + invalidate on connection state
  transition + invalidate on manual refresh". Automatically rescanning
  introspect is a different thing (it produces no result and travels an entirely
  different channel); if it gets done it gets its own document.
- **`inspector` / `chat` are not touched.** The former does no fetching, and for
  the latter "refresh" means nothing.
- **This does not enter `~/.peek/settings.json`.** Views, layout and query text
  do not survive across processes (the passage at the top of `settings.ts` draws
  that line), so the interval travels with the view, and when the view is gone
  it is gone.
- **No "custom interval" input box.** A set of presets first; anyone who
  genuinely needs an arbitrary value can go through `view.update`.
- **No control is drawn for the `package` view.** See §2.5.

### 1.4 Checked against the existing documents (no conflict, but two things to book)

| existing convention | source | this document's relation to it |
|---|---|---|
| every state change is a Command | PLAN §6 | obeyed: the timer only sends Commands, it never writes state directly |
| `source: 'system'` = "main's own write-back (driver host events, agent stream events)" | the `CommandSourceSchema` comment in `commands.ts` | **the meaning widens slightly**: it gains "main acting on its own, under a rule the user laid down in advance". The comment has been changed to follow |
| "new resultId ⇒ clear column widths, scroll to top" | the comment on that `useEffect` in `DataGrid.tsx` | **has to change**: see §2.6, judged by "fetch shape" instead of by resultId |
| read-only is backstopped by the server, the client does not parse statements | `2026-08-03-write-path-scope.md` §1.1 | a direct beneficiary: automatically rerunning a statement cannot turn into automatically repeated writes |
| CommandLog holds 500 | `command-log.ts` | a cost, see §3.4 |

---

## 2. The plan

### 2.1 State: `autoRefreshMs` lands on ViewState

`core/workspace.ts` gains a base layer, given only to the four views that can
fetch:

```ts
/**
 * A view that fetches for itself, and can therefore be refetched on a timer.
 * table / query / vector / package — exactly the four autoFetch knows about.
 */
export interface RefreshableViewBase extends ConnectedViewBase {
  /** Auto-refresh interval (ms). Absent = off. */
  autoRefreshMs?: number
  /** Who stopped the auto-refresh, so the toolbar can say. Cleared when an interval is set. */
  autoRefreshStoppedBy?: AutoRefreshStopReason
}

export type AutoRefreshStopReason = 'paged' | 'error'
```

`TableViewState` / `QueryViewState` / `VectorViewState` / `PackageViewState`
switch from extending `ConnectedViewBase` to extending `RefreshableViewBase`.
`InspectorViewState` / `TreeViewState` are untouched, and `ChatViewState` still
extends only `ViewBase`.

**Why not on `ViewBase`**: put it there and `chat` and `inspector` carry a field
that is forever meaningless — which is precisely why `ConnectedViewBase` was
split out in the first place, to let the compiler point out "which views have a
connection". Now it points out "which views can refresh" the same way.

New constants (core):

```ts
export const MIN_AUTO_REFRESH_MS = 1_000
export const MAX_AUTO_REFRESH_MS = 3_600_000
/** The set in the menu: 1s 5s 10s 30s 1m 5m 10m 30m 1h */
export const AUTO_REFRESH_PRESETS_MS = [1_000, 5_000, 10_000, 30_000, 60_000, 300_000, 600_000, 1_800_000, 3_600_000] as const
```

A floor of 1s: an interval below a second means nothing on a scan that has to
cross the network, and only sets backpressure and the watchdog chasing each
other's tails.

### 2.2 The command: reuse `view.update`, add nothing

`autoRefreshMs` sits at the same level as `title` — a property unrelated to the
view's content — so it goes into the **table / query / vector / package
branches** of `ViewPatchSchema`, and not into inspector / tree / chat:

```ts
autoRefreshMs: z.number().int().min(MIN_AUTO_REFRESH_MS).max(MAX_AUTO_REFRESH_MS).nullable().optional(),
```

`null` = off, absent = leave it alone. The same convention as the vector view's
`vectorName` / `scoreThreshold`.

**Write down exactly what "not in those three branches" delivers**: a zod object
**strips** unknown keys by default rather than erroring (as it does everywhere
in this file), so `{kind:'chat', autoRefreshMs: 5000}` **parses successfully with
the field gone**. A TypeScript caller is stopped earlier, by types; a JSON
caller gets silence, treated the same as any other misspelled key. The real
guarantee is "this value cannot reach a view with nowhere to put it", not
"anyone who writes it gets an error" — which is why the kind check inside main's
`setAutoRefreshOn` is load-bearing, not defensive. This came to light only while
writing the tests (the first version's assertion was `success === false`, and it
went red).

Writing this field in `applyViewPatch` **does not count as `affectsFetch`**:
turning auto-refresh on does not fetch immediately, and the first tick comes one
interval later. The reasoning is that "flip the switch" and "I want one right
now" are two intents, and the latter has a `⟳ Refresh` button right beside it.

Writes go through one function in `mutations.ts`, because §2.4's scheduler has
to write it too:

```ts
export function setAutoRefresh(
  draft: Draft<Workspace>,
  viewId: ViewId,
  ms: number | null,
  stoppedBy?: AutoRefreshStopReason,
): void
```

### 2.3 `refreshPatch` moves into core

`refreshPatch(ref)` (currently in
`renderer/components/views/browseControls.ts`) is the single definition of "what
patch to send to refresh a collection browser", and it depends only on core's
`collectionBrowseStyle`. The scheduler on the main side has to send the same
patch, so it moves next to `core/capability.ts`, and the renderer switches to
importing it from `@peek/core`.

The move is itself the payoff: **refreshing a cursor collection has to carry
`offset: 0`** (without it, it silently pages forward — the comment in
`browseControls.ts` explains it) now has one implementation for both processes
instead of two.

### 2.4 The scheduler: `main/auto-refresh.ts`

An object hung on by `main/index.ts` once the Command Bus is built, holding
`{ bus, store }`, exposing only `dispose()`.

**Why in main and not in the renderer:**

1. The state is in main, and the timer travels with the state, otherwise "is it
   on or not" has two answers.
2. "Can it refresh right now" is a judgement only main can answer accurately —
   `runningResultOf` and the connection status are both here, and the renderer's
   mirror is eventually consistent.
3. A view's life and death happen in main (`view.close`, `conn.close`,
   `layout.close`), so the timer's reclamation follows the same source of truth
   and does not depend on when React unmounts.

**Reconciling**: subscribe to `store.subscribe` and square the books after every
state change — a view carrying `autoRefreshMs` with no timer gets one, and a
timer whose view is gone / turned off / on a different interval is cleared and
rebuilt. This is "converge on the current state" rather than "maintain
incrementally by listening to events", because the latter means inserting a line
into seven or eight commands.

**What one tick does** (a chain of one-shot `setTimeout`s, not a `setInterval`):

```
tick(viewId):
  view = store.views[viewId]
  if the view is gone or autoRefreshMs is gone   -> stop, schedule nothing
  if connection status !== 'ready'               -> skip this one, schedule the next as usual
  if runningResultOf(viewId) !== null            -> skip this one, schedule the next as usual
  else:
    settle the previous round's result (below), stop itself if required
    dispatch(the refresh command, source: 'system')
  schedule the next: setTimeout(tick, autoRefreshMs)
```

The four views' "refresh command":

| kind | command |
|---|---|
| `table` | `view.update { patch: refreshPatch(ref), refresh: true }` |
| `query` | `query.run { viewId, text }` (skip this one if `text` is empty) |
| `vector` | `view.update { patch: { kind: 'vector' }, refresh: true }` |
| `package` | `view.update { patch: { kind: 'package' }, refresh: true }` |

The last two are an empty patch plus `refresh: true`: `applyViewPatch` changes
nothing, and `refresh` is explicitly true so `autoFetch` runs anyway. This is
exactly the shape the existing `nextCursorPage` already uses.

**The interval counts from "the previous tick", not from "the previous result
finishing".** When one fetch takes longer than the interval, the next tick sees
`runningResultOf` non-empty and skips — so nothing piles up, and there is no
need to chase results' settle events. The cost is that under slow queries the
real rhythm degrades to an integer multiple of the interval, which is the right
behaviour: a query that takes 12 seconds to run should never have been running
on a 5-second rhythm.

(`isSettledResultStatus` counts `paused` as settled, which happens to suit here:
backpressure holding the stream back means "the rows the user's viewport wants
have all arrived", and that is the moment the next round can begin.)

**Stopping itself after consecutive failures**: the scheduler keeps its own
`consecutiveErrors` (not in the Workspace — it is the machine's bookkeeping, not
the interface's state). Each tick first looks at the terminal status of the
previous round's `resultId`: `error` / `cancelled` counts one, anything else
resets to zero; **a round that has not reached a terminal status does not settle
the books**, and is left to the next tick, so that the same round is not counted
twice. Three in a row → `setAutoRefresh(viewId, null, 'error')`, and the timer
disappears with the next reconcile. A statement that fails forever should not be
pestering the database every 5 seconds.

`cancelled` counts as a failure too: the two paths that lead there are the
timeout watchdog and a person pressing Stop, and neither is an invitation to
come back in five seconds. And a result main has already evicted (a 200-entry
ceiling) has no readable status, and is treated as "settled and clean" — guessing
an error from missing metadata would turn a bookkeeping problem into the user's
switch being turned off.

**It keeps running while the window is not visible.** Same as DataGrip: the
point of auto-refresh is often exactly "switch away and do something else, come
back and look at the result". An inactive tab is the same — a tab is layout, not
a subscription.

### 2.5 The interface

A new control, `AutoRefreshControl`, placed in `views/ResultControls.tsx` —
alongside `CancelButton` / `CacheGapNotice`, one of "the few things the three
result views share".

```
[⟳ Refresh] [■ Cancel] │ [auto ▾]        off
[⟳ Refresh] [■ Cancel] │ [auto 5s ▾]     on
```

Opening it gives the `ui/Menu` primitive, whose contents are produced by a pure
function `autoRefreshMenuNodes()` (in `views/autoRefreshMenu.ts`, for the same
reason as `browseControls.ts`: unit tests cannot reach into a `.tsx`):

- `Off`, then the 9 presets, with the current one marked `✓`
- when `autoRefreshStoppedBy` has a value, a `note` at the top explaining why it
  stopped itself

Wiring: one each in the `TableView` / `QueryView` / `VectorView` toolbars.

**No control is drawn for the `package` view**: a package view is one whole block
drawn by `entry.render(view)`, and peek has no toolbar of its own to insert
into. The kernel side is fully supported (the field, the command and the
scheduler all recognise it), and a package that wants one draws its own button
and sends `view.update`. That is what bringing `package` into scope this round
actually means.

### 2.6 `DataGrid`: reset by "fetch shape" instead of by resultId

The current line:

```ts
useEffect(() => { setSizing({}); setSelected(null); …; driver.reset() }, [resultId, …])
```

becomes a judgement of whether this change of result is "a new answer to the
same question". The criterion is a pure function (a new file,
`views/fetchShape.ts`, unit-testable):

```ts
/** Same shape ⇒ this change of result is only "the same question asked again". */
export function fetchShapeKey(view: ViewState): string
//  table   -> ref + sort + filter + limit + offset
//  query   -> text
//  vector  -> collection + queryVec/queryPointId + vectorName + topK + threshold + filter
//  package  -> packageKind + state
//  anything else -> view.id (never equal, equivalent to "always reset")
```

`offset` goes into table's key: paging is a changed question, and scrolling to
the top is right. `autoRefreshMs` does **not**: flipping the switch should not
scroll anyone back to the top.

**The judgement happens during render, not in an effect.** By the time an effect
runs, that blank frame has already been painted. So render reaches its
conclusion on the spot with two refs (`prevRef` holding the previous
shape+resultId, `swapRef` holding whether this one is `'same'` or `'new'`), and
the layout effect only carries it out.

Shape **changed**: keep every behaviour there is today (clear column widths,
clear the selection, clear the row selection, `driver.reset()`).

Shape **unchanged** (= auto-refresh, and also = a manual `⟳`, and also =
`CacheGapNotice`'s "Run again"):

| thing | treatment | why |
|---|---|---|
| column widths `sizing` | **kept** | column widths dragged into place for ages, cleared every 5 seconds, are unusable |
| vertical position | **kept** (see below) | the entire point of auto-refresh is "stare at one spot and watch it change" |
| selected cell `selected` | **cleared** | the same reason as the row selection: it addresses by position, and after a refresh row 7 may already be a different row |
| expanded large value `expanded` | **cleared** | as above |
| row selection `rowSelection` | **cleared** | its purpose is "send these rows to the agent", and carrying positions across is exactly what that comment in `DataGrid` is wary of |
| context menu `menu` | **cleared** | the menu points at that moment just past |

**The old rows stay on screen until the new result has something to draw.** The
moment a new resultId is attached, `useResult` returns an empty snapshot and the
grid goes white once before filling back in — bearable once, but at once every 5
seconds it is a strobe. So `DataGrid` now subscribes to two results at the same
time:

- `liveSnap = useResult(resultId)` — the one that is arriving. Viewport
  reporting, LRU protection and ack backpressure all follow it, and so does the
  footer's status (running / done / elapsed), or else "refreshing right now"
  would be invisible.
- `snap = useResult(shownResultId)` — the batch on the screen. On a same-shape
  changeover, `shownResultId` points at the **previous** result first, and only
  switches once the new one has its schema, has its first row, or has already
  reached a terminal status (whichever comes first).

The previous result's rows are still in the renderer's LRU at this point (main's
`results` table holds 200, and `pruneResults` only reclaims what main has
already forgotten), so this is merely "switch a little later" and needs no extra
cache at all. On a change of shape there is no hold: keeping the old rows around
after the sort changed is lying.

**Why the vertical position still has to be saved explicitly**: the hold blocks
out the "0 rows" stretch, but when the new result has **fewer** rows than the
old one (or the hold has been released and the rows have not arrived yet),
`VScrollDriver.commit` still clamps `rawTop` to the new `maxTop`. So on the
changeover, `visibleFirst` and `atBottom` go into a ref, and once the new result
has `rowCount > 0` a single `scrollToRow(min(anchor, rowCount-1))` restores it
(at the bottom before means restored to the bottom — which, watching an
append-only table, is exactly following the tail). This restoring effect must be
declared **after** the layout effect holding `setGeometry`: layout effects run in
declaration order, and restoring before the driver knows the new row count
amounts to restoring to 0.

### 2.7 Cursor collections: paging turns it off automatically

The user's chosen rule. In a `table` view, a Redis or Qdrant collection can only
page forward, and the semantics of a refresh is "rescan from the first page"
(`refreshPatch` already defines it that way). Sitting on the first page, auto-
refresh is entirely reasonable (watching a keyspace is exactly that use); once
the user has clicked `Next page`, being dragged back to the first page every 5
seconds is unacceptable.

The test lives in the table branch of `handlers/view.ts`, **not** in the click
handler in the rendering layer — per PLAN §6, a person clicking a button and a
model sending a tool call have to land on the same rule:

```
if the view is cursor-paged (!collectionBrowseStyle(ref).offsetPaging)
  and view.cursorToken exists
  and the patch carries not one field beyond kind    // this is exactly the shape of the "next page" gesture
  and autoRefreshMs is on
then setAutoRefresh(view.id, null, 'paged')
```

The toolbar then shows `auto ▾` as off, with a note at the top of the menu
explaining that paging caused it.

---

## 3. Trade-offs

### 3.1 The timer goes in main, not in the renderer

The renderer saves a module and natively knows "is this tab visible right now".
The reason for rejecting it is in §2.4: with the state in main there is no other
way, or else "is it on or not" gets two answers — and that is the very premise
this project exists on (a person and an AI looking at one state). Visibility is
reachable from main too — this round simply decided not to use it (it keeps
running).

### 3.2 Reuse `view.update`, do not add `view.setAutoRefresh`

A new command would be more conspicuous, but it writes one field and has no side
effects whatsoever, which is the definition of `view.update`. The cost is that
MCP does **not** have an `update_view` tool today, so for now the model can read
`autoRefreshMs` (`read_workspace`) but cannot change it. That is a pre-existing
gap, not one this document creates, and filling it is not in this document's
scope.

### 3.3 The interval counts from the tick, it does not chase settle

The version that chases settle is more "accurate" (it strictly guarantees N
seconds of gap between two fetches), at the cost of the scheduler subscribing to
the result state machine and handling half-finished terminal states like
`paused`. Skipping buys the same "nothing piles up" with one `runningResultOf`
check, which is enough.

### 3.4 CommandLog gets drowned by ticks

At a capacity of 500, an auto-refresh every 5 seconds fills it in 40 minutes.
"The command log is naturally a recording of what was done" (PLAN §6) is
therefore discounted. **Accepted**, because: ticks are recorded as
`source: 'system'`, naturally separable from a person's and a model's commands;
and if you really want the recording, filter out system. The alternative that is
not accepted is "ticks do not enter the log" — that would make "why did the
interface refetch" something the log cannot answer, which is worse than the log
being filled up.

### 3.5 The interval is not persisted

Views themselves do not survive a restart (that passage in `settings.ts` draws
the line very clearly), and a setting that stores an interval but cannot store
the view is meaningless. If workspace persistence ever gets built, `autoRefreshMs`
travels along as an ordinary ViewState field.

### 3.6 `DataGrid` resets by shape, rather than being given a `preserveScroll` switch

The switch version is smaller, but it hands the judgement of "when should it
reset" to three callers to each write out. The shape function is one
implementation of one judgement, and it incidentally fixes the manual `⟳` —
today a manual refresh also clears column widths and returns to the top, which
is equally not what the user wants.

### 3.7 The grid subscribes to two results at once, rather than accepting one blank frame

The `shownResultId` layer is the easiest place in this change to get wrong:
viewport reporting has to follow "the one that is arriving" and the cells have to
follow "the batch on the screen", and the two must not cross. Accepting the blank
(no hold) saves the whole layer, at the cost of the grid strobing at a 1-second
interval. The former was chosen, and the two lines are split explicitly in the
code into two variables, `liveSnap` and `snap`, rather than one variable
oscillating between two meanings.

---

## 4. Verification

### 4.1 Unit tests

- `core/__tests__/auto-refresh-patch.test.ts` — `ViewPatchSchema` accepts
  `autoRefreshMs` on the four refreshable views; the `chat` / `tree` /
  `inspector` branches parse with the field stripped; out-of-range values
  (0 / 999 / 3600001 / 1500.5) are rejected; `null` passes; all nine presets are
  legal and strictly increasing; both of `refreshPatch`'s outputs are legal
  patches.
- `fetchShape.test.ts` — same ref, same sort ⇒ equal keys; changing offset /
  changing sort / changing text / changing topK ⇒ unequal keys; `inspector` /
  `chat` ⇒ the key contains the viewId and is never equal.
- `bus/__tests__/auto-refresh.test.ts` (main, with a fake clock injected, a real
  bus, a real store and fake deps) —
  1. set an interval ⇒ one refresh command after one interval, `source === 'system'`;
  2. a running result ⇒ that one is skipped, but the next is still scheduled;
  3. connection not ready ⇒ as above;
  4. three consecutive `error` results ⇒ turns itself off, `autoRefreshStoppedBy === 'error'`;
  5. `view.close` ⇒ the timer is cleared and no command follows;
  6. each of the four kinds sends a command of the right shape.
  Three more cases in the same file: a query view goes through `query.run` rather
  than a patch; an empty editor is skipped rather than running an empty
  statement; a "bare patch" on a cursor view turns auto-refresh off with
  `stoppedBy === 'paged'`, while the `refreshPatch` the scheduler sends itself
  (carrying `offset: 0`) is **not** mistaken for paging, and an offset-paged
  table is **not** turned off by paging either.
- `views/__tests__/auto-refresh-ui.test.ts` — the menu: presets complete and in
  order, the current item uniquely marked, `Off` sends `null`, a value in
  `stoppedBy` adds a note at the top; `formatInterval` shows no decimals for any
  of the nine presets. The shape: neither refreshing nor toggling auto-refresh
  changes the key, while paging / sorting / filtering / changing page size /
  changing table all do, and a view that does not fetch has the viewId in its
  key.

### 4.2 End to end (repeatable, costs nothing)

```bash
pnpm --filter @peek/desktop build
node apps/desktop/scripts/verify-auto-refresh.mjs
```

It brings up the build output, generates its own SQLite fixture, isolates
user-data-dir / config-dir / the MCP port, opens a table over MCP, and then uses
CDP to **click the toolbar like a person**: click `auto`, pick 1s, look at the
result. Ten checks: the control is drawn / it starts off / the reader has
scrolled away from the top / after picking 1s `autoRefreshMs` lands in the
Workspace / the button shows the interval / the view refetched itself (the
resultId changed) / the scroll position survived / the dragged column width
survived / picking Off clears the interval / nothing refetches afterwards. Exit
code 0 = all passed.

**It has already caught something the unit tests could not**: `read_workspace`'s
view brief had no `autoRefreshMs` in it — the model could not tell "this view is
changing every 5 seconds" from "this is a still picture from an hour ago". §1.2's
third item is written for exactly this, and only hooking up the real MCP revealed
it had been missed.

### 4.3 Manual

Against a PostgreSQL connection:

1. Open a table → `auto ▾` → `5s`. The button shows `auto 5s`, and the row
   count/contents update after 5 seconds.
2. Scroll to row 300, drag a column wider → wait two ticks → **both the position
   and the column width are there**, with no white flash.
3. Click `Next page` → the position returns to the top (the question changed),
   and auto-refresh is still on.
4. Change the sort → back to the top, column widths reset (the shape changed).
5. Open a query view and run `select now()` → set 1s → the time keeps jumping;
   change the statement to `select 1/0` → after three consecutive failures it
   turns itself off, and the reason is visible in the menu.
6. Open a keyspace on a Redis connection → set 5s → sitting on the first page it
   rescans normally; click `Next page` → auto-refresh goes back to Off, and the
   note at the top of the menu says paging caused it.
7. Close the connection → the tick skips silently (no error panel flooding the
   screen); it resumes by itself after reconnecting.
8. Close the view → no more commands for that view in the process (check the
   error centre / the log).

### 4.4 Regression

```bash
pnpm --filter @peek/core test
pnpm --filter @peek/desktop test
pnpm --filter @peek/desktop build
node apps/desktop/scripts/bench-scroll.mjs   # DataGrid was touched, the scroll budget needs remeasuring
```
