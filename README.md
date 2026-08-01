# peek

A standalone database viewer that also exposes itself as an MCP server, so an AI can drive the
interface a human is looking at.

**English** · [中文](./README.zh-CN.md)

Human clicks and MCP tool calls travel the **same command channel**. There is no second write path,
no shadow state for the AI, and no reconciliation step: the main process holds the one source of
truth, every mutation is a Command, and the renderer only ever receives patches. Ask Claude to open
a table and the panel appears on screen; open it yourself and the AI sees the same workspace on its
next read.

> **Status: early.** M0 (skeleton), M1 (PostgreSQL read-only pipeline), M2 (tiled layout: view
> drag-and-drop plus the `set_layout` / `move_view` tools), M3 (Redis), M4 (Qdrant) and M5
> (MySQL / SQLite) are complete, and the layout has since grown panel tabs and keyboard
> accessibility. All five databases connect, introspect and stream rows; all data access is
> read-only. Everything under [Roadmap](#roadmap) is a plan, not a feature.

---

## What works today

| Area | State |
| --- | --- |
| Databases | PostgreSQL, Redis, Qdrant, MySQL and SQLite, each behind its own driver package. The connect dialog renders a different form per driver, because the five do not describe a connection the same way — a numeric database index for Redis, a base URL and API key for Qdrant, a path on disk for SQLite. |
| Data access | Read-only, and enforced by the server wherever a server can enforce it: PostgreSQL and MySQL run inside a read-only transaction, SQLite is opened with the read-only flag plus `PRAGMA query_only`. Redis and Qdrant have no such switch, so their drivers simply issue no write command. No client-side keyword allowlist anywhere. |
| Views | All five kinds are implemented: `table`, `query`, `inspector`, `tree`, `vector`. Which ones a connection offers follows its capabilities — Redis and Qdrant have no `tabularQuery`, so no SQL editor is drawn for them; the typed key inspector appears only on Redis, and vector search only on Qdrant. |
| Layout | The tiled tree is real state, driven by Commands: `⌘\` splits left/right, `⌘⇧\` splits top/bottom, `⌘W` closes the active tab, `⌘⇧W` closes the panel, and dragging a divider dispatches `layout.setRatio`. |
| Tabs | A panel holds up to 12 views as tabs and shows one. The strip is always visible, even for a single tab, so the body height never changes; past the width of the strip it scrolls sideways. Dragging a tab onto a panel body's centre stacks it there as a new tab, onto an edge splits, and onto a tab strip inserts it at the caret — which is also how tabs are reordered. Nothing is swapped by any gesture; `swap` survives only as an explicit `onOccupied` mode for callers that name it. |
| Keyboard / a11y | Panels are `role="group"` and tab strips are real ARIA `tablist`s. An empty panel emits neither `tablist` nor `tabpanel`: a tab list with no tabs, and a tab panel no tab controls, would announce a widget that is not there. Roving tabindex is per widget — one panel element (the focused one) and one tab per strip. Panel chrome is otherwise unconditionally tabbable, because the bodies beside it (CodeMirror, the grid's toolbar and pagination) cannot be taken out of the tab order, and pretending the surrounding chrome was out of it only made `Tab` walk into a body before the strip above it. DOM focus and `focusedPanel` sync both ways, with a guard that stops a remote MCP call from pulling the caret out of a dialog or the sidebar; closing a panel's last tab hands focus back to the panel rather than dropping it to the document. Changes that move focus announce themselves through role semantics; ones that do not are announced by a single polite live region. Splitter handles are not keyboard-resizable. |
| MCP | 9 tools over Streamable HTTP, bound to `127.0.0.1:7332`, bearer-token authenticated. |
| Persistence | None. Connections, layout and results live in memory; the only file written is `~/.peek/mcp.json`. |
| Packaging | `pnpm build` emits bundles under `apps/desktop/out`, not an installer. |
| i18n | English is the default and is never auto-detected from the OS; a `zh-CN` catalog ships alongside it, switchable from the status bar. |

---

## Architecture

### Process model

```
┌────────────────────────────────────────────────────────────────┐
│ renderer (React 19)                                            │
│   tiled panels · virtualized grid · tree · inspector · editor  │
│   mirror store — a read-only replica, never edited locally     │
└────────▲──────────────────────────────────┬────────────────────┘
         │ state patches (IPC)              │ user intent → Command (IPC)
┌────────┴──────────────────────────────────▼────────────────────┐
│ main                                                           │
│   Command Bus  ◄────  MCP HTTP server (127.0.0.1:7332)         │
│   Workspace Store — the source of truth, immer patches out     │
│   Connection Manager                                           │
└────────┬───────────────────────────────────────────────────────┘
         │ spawn + control: one utilityProcess per connection
┌────────▼───────────────────────────────────────────────────────┐
│ driver host (utilityProcess)                                   │
│   driver instance · query execution · server-side cursors      │
│   result chunks ─────── MessagePort, direct ──────► renderer   │
└────────────────────────────────────────────────────────────────┘
```

Three properties fall out of that shape:

- **Drivers run out of process.** One `utilityProcess` per connection. A wedged query or a driver
  crash cannot take the window down, and killing the process is an unconditional cancel.
- **The control plane goes through main; the data plane does not.** Commands and state patches pass
  through main. Result chunks travel a `MessagePort` handed directly from the driver host to the
  renderer — once transferred, main's end is neutered, so it *cannot* intercept a data frame even in
  principle. That is the physical guarantee behind "no double serialization hop for large results".
- **MCP read tools read main's store directly**, with zero renderer round-trips.

### Command Bus

```
  human clicks  ─┐
                 ├─► Command Bus ─► zod validation ─► handler (pure) ─► patch broadcast ─► result
  MCP tool call ─┘         │
                           └─► command log (source: ui | mcp | system)
```

Every state change is a Command named `domain.verb` — `conn.open`, `view.open`, `query.run`,
`layout.split`, and so on. Handlers are pure reducers over the workspace draft; side effects are
returned as plans and executed afterwards. An MCP tool is therefore a thin shell: declare an input
schema, map it to one or more Commands, render the outcome. The command log records the `source` of
each entry, which makes a session both auditable and replayable.

### Capability model

peek does not flatten every database into a lowest common denominator. Each driver advertises what
it can do, and both the UI and the MCP tools adapt:

```
introspect · tabularQuery · collectionScan · keyValue · vectorSearch · valuePeek · cancel

postgres      introspect · tabularQuery · collectionScan · valuePeek · cancel
mysql/sqlite  same, via a shared dialect layer
redis         introspect · collectionScan · keyValue · valuePeek · cancel
qdrant        introspect · collectionScan · vectorSearch · valuePeek
```

Qdrant declines `cancel` rather than pretending: it has no server-side statement cancellation, and
the REST client offers no per-request abort, so the driver can only stop between pages. A capability
is a promise about what the UI may offer, which is why "can stop at a page boundary" is not allowed
to pass as the same thing.

Adding a database is a package plus a line — one entry in `connections/registry.ts` and one in the
`drivers` array of `driver-host/entry.ts`. Nothing in `packages/core` changed to admit Redis, Qdrant,
MySQL or SQLite; the known gaps that surfaced while proving that are listed under
[Known limitations](#known-limitations).

The per-driver table is what the UI predicts *before* a connection exists; once connected, the
session's own capability set wins, so an older server can advertise less.

### Chunk streaming and backpressure

Result sets are streamed as columnar frames, never materialized whole:

```ts
{ resultId, seq, schema?: ColumnDef[],  // schema on seq 0 only
  cols: unknown[][],                    // column-major, ready for Arrow later
  rowCount: number,
  done?: { rows, elapsedMs, truncated?, nextCursor? } }
```

- PostgreSQL rows come off a server-side `DECLARE` / `FETCH FORWARD` cursor, 500–2000 rows per
  frame, targeting 256KB–1MB.
- The renderer keeps frames exactly as received and binary-searches `(row, col)` — no pivot to row
  objects, no copy.
- Cache ceiling ~200MB with **LRU eviction**; chunks near the viewport (±3000 rows) are protected.
- **Backpressure** is an ack window: the host pauses once 4 frames are unacknowledged, and the
  renderer withholds the ack when the cache is near its ceiling or the viewport has fallen more than
  200,000 rows behind. Scrolling releases it. A stream held this way reports `paused`, which is a
  terminal-but-healthy state — the rows already loaded are valid.
- Values over 4KB arrive as a truncated preview carrying a ref; the full value is fetched on demand
  through `valuePeek`.

---

## Quick start

Requirements: **Node >= 22** (developed on 26.2), **pnpm 10.32.1** (pinned via `packageManager`), and
at least one database to point at. Development and testing have happened on macOS / Apple Silicon
only; nothing in the code is platform-specific, but no other platform has been exercised.

```bash
pnpm install          # pnpm 10 blocks install scripts by default; electron/esbuild/rollup are
                      # allow-listed in pnpm-workspace.yaml, so no extra approval step is needed

pnpm dev              # electron-vite dev: opens the window, renderer HMR, MCP server on 7332
pnpm build            # production bundles into apps/desktop/out (main / preload / renderer)
pnpm -r typecheck     # tsc --noEmit across every package; strict mode, no `any`
pnpm -r test          # node:test, 750 tests today (567 desktop + 50 postgres + 29 redis
                      #                            + 34 qdrant + 70 mysql/sqlite)
```

The desktop suite is pure logic — no Electron, no database. Each driver suite is an integration
suite that talks to a real server, and each reads its target from the environment:

```bash
PEEK_TEST_PG_URL="postgresql://user@localhost:5432/your_db" \
PEEK_TEST_REDIS_URL="redis://localhost:6379" \
PEEK_TEST_QDRANT_URL="http://localhost:6333" \
PEEK_TEST_MYSQL_URL="mysql://root:pw@localhost:3306/peek_test" \
pnpm -r test
```

The Redis, Qdrant and SQL suites provision and remove their own fixtures (all Redis keys under a
`peek:test:` prefix, a `peek_test_*` Qdrant collection, throwaway MySQL tables, a temp-directory
SQLite file) and skip themselves entirely when the server is unreachable, so an absent service is
never a failure.

There is also an end-to-end check that no unit test can stand in for, because it launches the built
app rather than importing source:

```bash
pnpm --filter @peek/desktop build
node apps/desktop/scripts/smoke-drivers.mjs
```

It starts Electron on a throwaway port, user-data directory and config directory — so an installed
peek neither blocks it nor is disturbed by it — then drives its MCP endpoint the way an AI client
would: `connect`, `introspect`, then `open_view` on the first thing the tree says is openable, for
every driver whose `PEEK_TEST_*` variable is set. That path covers what unit tests cannot: that
`driver-host.js` resolves every driver package, that no two drivers fight over `process.parentPort`,
and that chunks reach the renderer over the MessagePort.

Two caveats worth knowing before you run it. Every statement it issues is read-only, so it is safe
against a live database — row counts are measured against the server's own `count(*)` rather than
hard-coded, precisely because the development database keeps changing underneath. But the schema is
*not* discovered: the suite asserts on specific tables in the `public` schema of one particular
development database, so pointing `PEEK_TEST_PG_URL` at an arbitrary database will fail those
assertions. Making the fixture self-provisioning is open work.

---

## Using the app

The window is a normal database GUI, and nothing about it is AI-specific:

- **Connect** from the sidebar. Pick a driver, paste a connection string, and the namespace tree
  opens with it. The tree is lazily loaded a level at a time and cached until you refresh it.
- **Browse a table** by clicking it in the tree: a virtualized grid, scrollable to the last row of a
  million-row table. Shift-drag the scrollbar for 10× precision, Option-drag for 50×.
- **Write SQL** in a query view. `⌘⏎` runs the statement; the editor is CodeMirror 6 with SQL syntax.
- **Inspect a value** by double-clicking a cell; a truncated one opens on a single click and pulls
  the rest through `valuePeek`. Anything over 4KB only ever travels as a preview until you ask for
  it.
- **Arrange panels** with `⌘\` (split left/right) and `⌘⇧\` (split top/bottom). Drag a divider to
  resize; the ratio is committed on release as a `layout.setRatio` command.
- **Work in tabs.** Opening a view puts it in the focused panel as a new tab rather than replacing
  what is there, so clicking a second table no longer costs you the first one. `⌘W` closes the
  active tab and the panel stays behind, empty; `⌘⇧W` closes the panel itself. When a tab closes,
  its right neighbour takes over, else its left — never a jump to the front. A panel holds 12 tabs
  at most.
- **Move a view** by dragging a tab. The centre of a panel body stacks the view there as a new tab;
  the four edges split that panel and drop the view into the new half; the tab strip inserts it at
  the caret, which is also how you reorder tabs inside one panel. Nothing is ever closed or swapped
  by a drag. `Esc`, or releasing outside any panel, cancels. Nothing moves until the main process
  has applied the command — the preview you see while dragging is only a preview.
- **Without the mouse**: `⌘1`–`⌘8` show the Nth tab and `⌘9` the last one, `⌃Tab` / `⌃⇧Tab` cycle
  through them, and `⌘⌥1`–`⌘⌥9` focus a panel by its visual order. `⌘⌥←↑↓→` moves the focus,
  `⌘⇧←↑↓→` moves the focused view into the neighbouring panel as a tab, and `⌘⌥⇧←↑↓→` sends it
  into a new panel beyond that neighbour. Inside a tab strip, `←`/`→` move between tabs and switch
  as they go, `Home`/`End` jump to the ends, and `Delete`/`Backspace` close a tab. While the SQL
  editor has focus the arrow shortcuts are left to it — `Esc` is the way back out.
- **Switch language** in the status bar. English is the default everywhere, deliberately: the window
  is a surface shared with an AI and with bug reports, so it should read the same on every machine.

---

## Using it from Claude Code

peek starts its MCP server on launch, binds the loopback address only, and writes the endpoint plus a
bearer token to `~/.peek/mcp.json` (file `0600`, directory `0700`). The token is reused across
restarts, so a client registered once stays registered.

```bash
cat ~/.peek/mcp.json        # the "hint" field is the exact command below, token filled in

claude mcp add peek --transport http http://127.0.0.1:7332/mcp \
  --header "Authorization: Bearer <token from ~/.peek/mcp.json>"
```

The `Authorization` header is required — without it every request is rejected with 401. Requests are
additionally checked for a loopback `Host` and `Origin` (DNS-rebinding protection), and the token is
compared in constant time.

### The nine tools

| Tool | Kind | Purpose |
| --- | --- | --- |
| `read_workspace` | read | See the current UI: layout tree, every tab of every panel in tab order with the visible one marked, per-result row counts and status, connections. Mounted is not the same as on screen — a panel shows one of its tabs. Never returns row data. |
| `list_connections` | read | Every connection with its id, driver, status, actual capability set, and redacted target. |
| `connect` | command | Open a connection (`conn.open`); optionally opens a namespace tree view at the same time. |
| `introspect` | read | Expand the namespace tree (db → schema → table), up to 3 levels at a time. Returns the `ref` values `open_view` needs. Not a Command — it is a read-only driver-host RPC. |
| `open_view` | command | Put a view on screen (`view.open`): `table`, `query`, `inspector`, `tree`, `vector`. Appends it to the target panel as a new tab and shows it; `replace: true` closes that panel's visible view and takes its tab position instead. Opening in a *new panel* is `set_layout`, or `move_view` onto an edge. |
| `run_query` | command | Execute a statement (`query.run`). The AI receives the first 20 rows plus the total count; the full result stays in the UI for the human to scroll. Defaults to a 200,000-row ceiling, marked `truncated`. |
| `set_layout` | command | Declare the whole panel tree at once (`layout.setLayout`) — the way to arrange several views for comparison in a single call. Each leaf carries a `viewIds` list plus an `activeViewId`, and may also `open` new views inline: four views side by side is four leaves, four views paged in one pane is one leaf with four `viewIds`. Caps: 16 panels, depth 6, 12 tabs per panel, each view at most once in the whole tree. Views left out of the tree are closed unless `unplaced` says `keep` or `error`; `expectRev` makes the write fail rather than clobber a concurrent human edit. |
| `move_view` | command | Move one view to one panel, without resending the tree. `zone: center` stacks it there as a tab (`layout.moveView`), optionally at an `index`; `left`/`right`/`top`/`bottom` split the target panel (`layout.splitWithView`). Naming the panel a view is already in is a tab reorder, not a no-op. This is the same zone→command mapping the drag UI uses, so an AI's gesture and a human's produce identical results. |
| `activate_view` | command | Bring one of a panel's tabs to the front (`view.activate`), the way clicking its tab does. Opens, closes, moves and reorders nothing. This is the answer when `read_workspace` shows the view you want with `"visible": false`. |

There is deliberately no tool that hands a full result set to the model. Layout changes go through
the same Command Bus as the human's keyboard and mouse, so `read_workspace` always shows an AI the
panel arrangement a human just dragged into place, and vice versa.

---

## Performance

Measured on an Apple M2 Max (64GB, macOS 26.1, built-in Retina display at `devicePixelRatio` 2),
Electron 43.2, against PostgreSQL 16.4 on localhost:

| Scenario | Result |
| --- | --- |
| Continuous scrolling through a 1,000,000-row result set | p95 frame **9.3ms**, **zero** frames over 16.7ms |
| DOM node count while scrolling | constant at **~240 nodes**, independent of row count |
| `run_query` over 1,000,000 rows, end to end | **1569ms** |

These come from the M1 acceptance run on the machine above. There is no benchmark script in the
repository yet, so treat them as a recorded measurement rather than something you can reproduce with
one command.

### Why the virtual scrolling is hand-written

Chromium clamps the layout height of a single element to roughly `2^25` device pixels divided by
`devicePixelRatio` — 33,554,248px at dpr 1, but **16,777,214px at dpr 2** on any Retina display. At a
24px row that ceiling lands at about **699,000 rows**. A spacer element sized `rowCount × rowHeight`
is *silently* clamped there: rows past it are not slow, they are unreachable. The cap is not even a
constant, so hardcoding a safe value only moves the failure to the next external monitor or zoom
level.

peek's answer is that **no DOM dimension is derived from the row count**. The vertical offset is a
plain JavaScript number in virtual pixels; rows are positioned against a block origin that only moves
every 4096 rows, which keeps every pixel value that reaches the compositor under 100k (safely inside
float32 precision) and lets React's memoization bail out on ~99.98% of rows. The horizontal axis
stays native scrolling. The vertical scrollbar is drawn by hand, because with
`overflow-y: hidden` there is no native one to have.

---

## Known limitations

- **A large query pauses if you do not scroll.** With backpressure active, a 1,000,000-row query
  stops at roughly 200,000 rows and reports `paused`. This is the design working: loaded rows are
  valid, scrolling forward resumes the stream, and re-running the query restarts it. It is not an
  error state, but it does surprise people who expect a progress bar to reach the end on its own.
- **LRU-evicted chunks are never re-fetched.** Scroll far away in a result set larger than the ~200MB
  cache and back again, and the evicted rows render as empty placeholders until the query is run
  again. Row numbering stays correct; only the data is gone.
- **The MCP port is effectively fixed at 7332.** `createMcpServer` accepts a port, but nothing in the
  app surfaces it, and there is no config file for it. If the port is taken, the MCP server does not
  start — the window still works, only the AI cannot connect.
- **Row height is fixed at 24px.** Variable-height rows are not supported, and neither is wrapping a
  tall cell in place; large values open in a modal instead.
- **Accessibility stops at the panel body.** The layout has real semantics — panels are labelled
  groups, tab strips are ARIA `tablist`s with roving tabindex, DOM focus tracks the focused panel,
  and layout changes are announced. Inside a panel none of that is true yet: the hand-drawn
  scrollbar has no native semantics, keyboard navigation within the grid is minimal, and dividers
  cannot be resized from the keyboard. The semantics are asserted by unit tests but have **not**
  been verified against a real screen reader.
- **What a collection may be browsed with is a table in core, not something a driver declares.**
  `CollectionScanRequest` always carries `sort` and `offset`, but a Redis keyspace has no global order
  and Qdrant cannot combine an order with a cursor; both drivers reject such a request at scan time.
  The UI no longer offers what will be rejected — `collectionBrowseStyle` decides per collection
  *kind*, so a keyspace draws inert column headers and a forward-only pager. It is still core that
  holds that knowledge rather than the driver, so a collection that is unusual *within* its kind
  (one sortable table next to one that is not) has nowhere to say so.
- **A refused fetch empties the view.** Any `view.update` that starts a new scan switches the view to
  the new result set before the driver has answered, so a rejected request leaves an error bar over an
  empty grid rather than the rows that were there a moment ago. The gesture that used to trigger this
  from the UI (sorting a keyspace) is gone, but a failing query or a dropped connection still shows it.
- **Filtering a schemaless collection targets fields that are not columns.** A Qdrant scan returns
  `id` plus one `payload` JSON column, since the chunk protocol fixes the schema before the first row
  is read. `FilterSpec.column` therefore names a payload key that does not appear in the result, so
  the usual "click a column header to filter" gesture has nowhere to live.
- **`VectorViewState.queryText` is inert.** Drivers are forbidden from embedding, and nothing else in
  peek turns text into a vector, so the field can be set but never consumed. Vector search is driven
  by "more like this point" (`queryPointId`), which is the only entry point a human can operate.
- **The same value can arrive as a different JS type per driver.** `ColumnDef.logical` says how to
  render a cell, not what it is: a BIGINT `1` is a `number` from MySQL, a string from PostgreSQL.
  `driver-sql` normalizes within itself, but core does not pin a canonical representation across
  drivers.
- **Nothing persists across restarts** — connections, layout and query text all start empty.

---

## Roadmap

| Milestone | Scope |
| --- | --- |
| **M6** | Polish: cancel and timeout end to end, an error panel, token management, and closing the capability-model gaps listed above — paging capability bits so a cursor store can decline sorting before the header is drawn, and a canonical JS representation per `LogicalType`. |

M3 (Redis), M4 (Qdrant) and M5 (MySQL / SQLite) are complete. They were the test of the capability
model, and it held: `packages/core` did not change to accommodate a key-value store or a vector
database. What the exercise did surface is that several of core's implicit assumptions are
relational — a global sort order, an exact `limit`, a filterable field being a result column — and
those are now written down under [Known limitations](#known-limitations) rather than left implicit.

Deferred on purpose and tracked in the plan: write operations (the read-only path stabilizes first,
then a confirmation mechanism), spilling huge result sets to disk, and an Arrow binary channel (the
chunk format is already columnar to leave room for it).

---

## Repository layout

```
peek/
├─ packages/
│  ├─ core/               # Command schemas, workspace types, capability + chunk protocol,
│  │                      # errors, and the driver-host runtime every driver shares
│  ├─ driver-postgres/    # introspect · tabularQuery · collectionScan · valuePeek · cancel
│  ├─ driver-redis/       # introspect · collectionScan · keyValue · valuePeek · cancel
│  ├─ driver-qdrant/      # introspect · collectionScan · vectorSearch · valuePeek
│  └─ driver-sql/         # MySQL + SQLite behind one dialect layer; same set as postgres
├─ apps/desktop/          # electron-vite: main / preload / renderer
│  └─ src/
│     ├─ main/            # Command Bus, workspace store, connection manager, MCP server, driver host
│     ├─ preload/         # one narrow bridge: invoke / onPatch / onResultPort
│     └─ renderer/        # React UI, mirror store, result cache, virtual scrolling, i18n
└─ docs/PLAN.md           # internal design record (written in Chinese)
```

`docs/PLAN.md` is the authoritative design document — architecture decisions, the performance budget
this README reports against, and the milestone definitions. It is kept in Chinese as an internal
record; this README is the English entry point.

---

## License

**TBD.** No license has been chosen yet, which means the code is not currently licensed for reuse.
MIT is the suggested default; the repository owner needs to confirm it and add a `LICENSE` file
before that changes.
