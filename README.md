# peek

A standalone database viewer that also exposes itself as an MCP server, so an AI can drive the
interface a human is looking at.

**English** · [中文](./README.zh-CN.md)

Human clicks and MCP tool calls travel the **same command channel**. There is no second write path,
no shadow state for the AI, and no reconciliation step: the main process holds the one source of
truth, every mutation is a Command, and the renderer only ever receives patches. Ask Claude to open
a table and the panel appears on screen; open it yourself and the AI sees the same workspace on its
next read.

> **Status: early.** M0 (skeleton) and M1 (PostgreSQL read-only pipeline) are complete. PostgreSQL is
> the only database with a driver behind it, all data access is read-only, and there is no packaged
> build yet. Everything under [Roadmap](#roadmap) is a plan, not a feature.

---

## What works today

| Area | State |
| --- | --- |
| Databases | PostgreSQL only. `redis` / `qdrant` / `mysql` / `sqlite` exist as driver ids and capability declarations, with no driver behind them — picking one in the connect dialog returns `driver not registered`. |
| Data access | Read-only. Every statement runs inside `BEGIN READ ONLY`, so a write is refused by the server rather than by a client-side allowlist. |
| Views | `table`, `query`, `inspector`, `tree` are implemented. `vector` renders a result set through the same grid but has no search entry point yet. |
| Layout | The tiled tree is real state, driven by Commands: `⌘\` splits left/right, `⌘⇧\` splits top/bottom, `⌘W` closes the focused panel, and dragging a divider dispatches `layout.setRatio`. Views cannot be dragged between panels, and there is no `set_layout` MCP tool. |
| MCP | 6 tools over Streamable HTTP, bound to `127.0.0.1:7332`, bearer-token authenticated. |
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

postgres      introspect · tabularQuery · collectionScan · valuePeek · cancel   (implemented)
mysql/sqlite  same, via a shared dialect layer                                  (M5)
redis         introspect · collectionScan · keyValue · valuePeek · cancel       (M3)
qdrant        introspect · collectionScan · vectorSearch · valuePeek            (M4)
```

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
a PostgreSQL instance to point at. Development and testing have happened on macOS / Apple Silicon
only; nothing in the code is platform-specific, but no other platform has been exercised.

```bash
pnpm install          # pnpm 10 blocks install scripts by default; electron/esbuild/rollup are
                      # allow-listed in pnpm-workspace.yaml, so no extra approval step is needed

pnpm dev              # electron-vite dev: opens the window, renderer HMR, MCP server on 7332
pnpm build            # production bundles into apps/desktop/out (main / preload / renderer)
pnpm -r typecheck     # tsc --noEmit across every package; strict mode, no `any`
pnpm -r test          # node:test, 167 tests today (117 desktop + 50 driver-postgres)
```

The desktop suite is pure logic — no Electron, no database. The `driver-postgres` suite is an
integration suite that talks to a real server, defaulting to
`postgresql://postgres@localhost:5432/postgres`. Point it somewhere else with:

```bash
PEEK_TEST_PG_URL="postgresql://user@localhost:5432/your_db" pnpm -r test
```

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
- **Arrange panels** with `⌘\` (split left/right), `⌘⇧\` (split top/bottom) and `⌘W` (close). Drag a
  divider to resize; the ratio is committed on release as a `layout.setRatio` command.
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

### The six tools

| Tool | Kind | Purpose |
| --- | --- | --- |
| `read_workspace` | read | See the current UI: layout tree, what sits in each panel, per-result row counts and status, connections. Never returns row data. |
| `list_connections` | read | Every connection with its id, driver, status, actual capability set, and redacted target. |
| `connect` | command | Open a connection (`conn.open`); optionally opens a namespace tree view at the same time. |
| `introspect` | read | Expand the namespace tree (db → schema → table), up to 3 levels at a time. Returns the `ref` values `open_view` needs. Not a Command — it is a read-only driver-host RPC. |
| `open_view` | command | Put a view on screen (`view.open`): `table`, `query`, `inspector`, `tree`, `vector`. `replace: false` splits off a new panel instead of taking over the focused one. |
| `run_query` | command | Execute a statement (`query.run`). The AI receives the first 20 rows plus the total count; the full result stays in the UI for the human to scroll. Defaults to a 200,000-row ceiling, marked `truncated`. |

There is deliberately no tool that hands a full result set to the model. Splitting off a panel via
`open_view` is the only layout change an AI can make today; `set_layout` arrives with M2.

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
- **Accessibility is limited.** The hand-drawn scrollbar has no native semantics, keyboard navigation
  inside the grid is minimal, and the UI has not been tested with a screen reader.
- **The connect dialog offers all five driver ids**, though only `postgres` is registered. The others
  fail with a clear `driver not registered` error rather than being hidden.
- **Nothing persists across restarts** — connections, layout and query text all start empty.

---

## Roadmap

| Milestone | Scope |
| --- | --- |
| **M2** | Tiled layout completion: drag views between panels, plus a `set_layout` MCP tool so an AI can arrange several views side by side. |
| **M3** | Redis: `SCAN`-based browsing (never `KEYS`) and a typed inspector — the first proof that the capability model survives a non-SQL store. |
| **M4** | Qdrant: collection scroll, vector search view, vectors themselves fetched through `valuePeek`. |
| **M5** | MySQL / SQLite behind a shared SQL dialect layer. |
| **M6** | Polish: cancel and timeout end to end, an error panel, a real connection-configuration UI, token management. |

Deferred on purpose and tracked in the plan: write operations (the read-only path stabilizes first,
then a confirmation mechanism), spilling huge result sets to disk, and an Arrow binary channel (the
chunk format is already columnar to leave room for it).

---

## Repository layout

```
peek/
├─ packages/
│  ├─ core/               # Command schemas, workspace types, capability + chunk protocol, errors
│  └─ driver-postgres/    # introspect · tabularQuery · collectionScan · valuePeek · cancel
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
