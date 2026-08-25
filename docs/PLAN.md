# peek — a general-purpose database viewer whose UI can be driven by MCP

**English** · [中文原文](./PLAN.zh-CN.md)

> 2026-07-31 initial plan. Decision record: initial support for PostgreSQL / Redis / Qdrant /
> MySQL·SQLite; the AI operates only the built-in views (no pushing custom HTML); the UI is a
> multi-panel tiled paradigm; project name peek.

## 1. Positioning

A standalone Electron desktop app:

- A person can use it as an ordinary database GUI (connecting to a database, browsing tables,
  querying data, scanning keys, querying vectors).
- At the same time it exposes an MCP HTTP server on localhost; the AI (Claude Code and others)
  drives the same UI through MCP tools: opening views, running queries, arranging the layout,
  reading state.
- Human and AI actions **go through the same command channel**, so the state is always
  consistent.

Non-goals (explicitly not doing in the first phase): the AI pushing custom HTML views, multiple
windows, collaboration/remote access, ~~editing data and writing it back (read-only first,
write operations left as an interface to add later)~~. **Item four was voided on 2026-08-14** —
a person can edit data at any time; the agent needs a connection-level switch, see
`design/2026-08-14-agent-write-switch.md`; §10's "Write operations" section is still the old
one, to be filled in once that document closes out. The first three items still stand, but
**the first one needs to be clear about who it forbids**: after M8, a **package** can draw its
own view (neo4j's `graph` is exactly that — it ships its own `ui/index.html`), and this is not
a loosening of that non-goal — what it forbids is **the AI, mid-conversation, pushing in a
piece of HTML on the spot**; what it permits is **a package the person installed themselves**
bringing its own UI: the install is a click the person makes in settings, it can be uninstalled
afterward, and at runtime it is locked inside a frame with **no network** (`probe-hardening.mjs`
tests this every single time). The difference lies in who makes the decision, and whether that
decision can be reversed.
**But do not read "the person clicked it" as "there is a gate"**: the entry point checks
nothing — what you install is what runs (end of §4). The settings panel carries only a single
sentence spelling out what installing a package means (`trustNote`), with no confirmation
dialog.

**As of 2026-08-15, this same criterion also governs the chat panel.** The embedded agent's
capabilities have three switches — built-in file and command tools, a working directory,
self-configured MCP servers — all off by default; with them off, it is exactly the panel peek
has always had, the one that can "only talk about the database in front of it," and
`verify-chat-security.mjs` verifies this by running probes against a real agent. Turning any one
of them on is the same transaction: **a decision made in settings, reversible, with a sentence
alongside it spelling out what it means, and no confirmation dialog.** Of these, the file-tools
switch hands over something bigger than a list of tools — it simultaneously voids the guarantee
that "the panel cannot approve its own permission prompts," because that guarantee's basis was
precisely that "the agent has no file-reading tool at all." peek does not guard against this;
it only reports it honestly. See
`design/2026-08-15-chat-panel-full-capability.md` §2.5.
## 2. Tech Stack

| Layer | Choice | Rationale |
|---|---|---|
| Shell | Electron + electron-vite | Independent windows, full Node ecosystem for drivers |
| UI | React 19 + TypeScript | — |
| State | zustand (main as the source of truth + renderer mirror, synced via patches) | Light, can be driven manually |
| Table | An in-house column model + in-house vertical virtual scrolling; TanStack Virtual kept only for horizontal | See the revision below |
| Editor | CodeMirror 6 | An order of magnitude lighter than Monaco, sufficient for SQL |
| Layout | An in-house tiled tree (settled, not using dockview) | Layout is state, and must be drivable by Command |
| Control | An in-house `renderer/ui/`, no shadcn / Radix / CVA | Density differs by a factor of two (shadcn 36px vs peek's 24px row height); what was missing is a single point where it converges, not a dependency. See `design/2026-08-02-control-spec.md` §3.1 |
| Styling | **Tailwind v4** (CSS-first, `@theme` carries the tokens, peek's own scale: font sizes 10/11/12/14/16, line boxes 12/18/20/24, spacing 2/4/8/16/24/32, Tailwind's text/leading/radius namespaces cleared out) | 2026-08-04 reversal: originally zero-dependency hand-written CSS. The motivation was a technical experiment, not defect-driven; the three floors were kept, in equivalent or stronger form. §29 at one point used Tailwind's defaults exclusively, and the result was an interface that lost its primary/secondary hierarchy, with text on horizontal bars landing entirely on half-pixels; §31 measured out the cause, §32 established peek's own scale and moved the 1px stroke out of boxes that get centered. See `design/2026-08-04-tailwind-migration.md` §29–§32. From 2026-08-15, there are **two color palettes**: `@theme` is dark and doubles as the default, `:root[data-theme='light']` overrides the base colors, and 8 `color-mix()`-derived tokens follow automatically (measured in Electron). The three-way preference dark/light/system is stored in `settings.json`, resolved by main and broadcast — the window background color, the traffic lights, and the package iframe all use the same answer. The contrast contract runs once for each of the two themes. See `design/2026-08-15-light-and-dark-theme.md` |
| MCP | @modelcontextprotocol/sdk, Streamable HTTP | Independent process lifecycle, Claude connects and uses it at will |
| Repo | pnpm monorepo | Each driver is its own package, unit-testable and reusable |
| Formatting | prettier (`printWidth: 110`, no semicolons, single quotes; **does not touch `.md`**) | Introduced 2026-08-15; before this there was no formatting/lint tooling at all. The width was not chosen, it was measured — among four candidates, 110 produced the smallest diff, because it echoes the author's own line width (p99=103). `.md` is excluded because prettier pads table column widths by code-point count, and CJK tables get wrecked. `format:check` is hooked into `pnpm test`. See `design/2026-08-15-prettier.md` |
| Embedded agent | Pluggable backend: an ACP subprocess (Claude Code / Codex) or a built-in endpoint loop (pi-agent-core + pi-ai). Capabilities are configurable: built-in tools, working directory, and a self-configured MCP server each have their own toggle, all off by default | The chat panel is itself a view; the agent connects back to its own MCP. See `design/2026-08-03-pluggable-agent-backends.md` and `design/2026-08-15-chat-panel-full-capability.md` |

**Revision to the table stack (after M1→M6 measurement)**: the initial version specified
TanStack Table + TanStack Virtual, and neither survived.

- **Vertical**: TanStack Virtual's spacer height is silently clamped by Chromium (at dpr=2,
  16,777,214px ≈ 699,000 rows), so rows past that point in a million-row result set are not
  reachable at all. Switched to an in-house `vscroll.ts`: no dimension in the DOM is derived from
  rowCount. See §8 for detail.
- **The horizontal column model**: TanStack Table was fed `data: []` — because pouring a
  million rows into `getCoreRowModel` materializes a million Row objects, directly violating
  "never materialized whole, at any time." So it was left with only three jobs: default column
  width, the override width after a user drag, and the drag gesture itself. Carrying ~106 kB of
  table-core (row model, grouping, filtering, pagination, faceting, expansion, pinned columns)
  for these three things is not worth it — replaced with `columnModel.ts` (about 150 lines).
- **Horizontal virtualization**: TanStack Virtual is kept — the column count is on the order of
  tens to hundreds, so its overhead is negligible; the chat panel's message list also uses the
  same package.

```
peek/
├─ packages/                 # Source. Built into on-disk database packages at build time; not part of the app bundle
│  ├─ core/                  # Command, Workspace state types, capability interfaces, chunk protocol
│  ├─ db-postgres/
│  ├─ db-redis/
│  ├─ db-qdrant/
│  ├─ db-neo4j/              # Since 2026-08-07. The first package to contribute a view kind (graph)
│  └─ db-sql/                # MySQL/SQLite (shared SQL dialect layer)
├─ apps/desktop/             # electron-vite: main / preload / renderer / package-host
│  └─ scripts/               # Build, packaging, benchmark, audit, and verification scripts. See §9.1
└─ docs/
```

**`packages/` is source, not part of the app bundle** (since 2026-08-07). `scripts/build-packages.mjs`
builds each of the five packages into an `out/packages/<id>/` (`peek-package.json` +
`driver.mjs` + `contrib.mjs`; neo4j additionally has a `ui/`), shipped with the app and copied
into `~/.peek/packages/` on first start. So the "six databases" are five packages in the repo
(`db-sql` alone produces both MySQL and SQLite), five directories on disk, and the app's own
bundle does not contain a single database client — see the `driver-host.js` row in the table in
§8.2.
## 3. Process model and the data plane

```
┌─────────────────────────────────────────────────────────────────┐
│  renderer (React)                                               │
│    tiled panels / virtualized table / tree / inspector / editor │
└───────▲─────────────────────────────────────┬───────────────────┘
    state patch (IPC)                   user intent → Command (IPC)
┌───────┴─────────────────────────────────────▼───────────────────┐
│  main                                                           │
│    Command Bus ◄── MCP HTTP Server (127.0.0.1:7332)             │
│    Workspace Store (the source of truth)                        │
│    Connection Manager                                           │
│    Package Registry (manifest read from ~/.peek/packages/)      │
└───────┬─────────────────────────────────────┬───────────────────┘
    spawn (one per connection)          spawn (one per package, launched lazily)
┌───────▼────────────────────────────────┐ ┌──▼─────────────────────────────────────────────┐
│  driver host (utilityProcess)          │ │  package host                                  │
│    driver instance + queries + cursors │ │    the package's own contrib                   │
│    loads driver.mjs from disk          │ │    four questions, four answers, no data plane │
│    chunk ─MessagePort─► window         │ │    no port, no network                         │
└────────────────────────────────────────┘ └────────────────────────────────────────────────┘
```

Key points:

- **The driver runs in a utilityProcess**: one process per connection. A hung query or a
  driver crash does not affect the window; killing the process is the forced cancel.
- **The control plane goes through main, the data plane does not**: Command and state patches
  go through main; query result chunks pass directly between driver host and the renderer over
  a MessagePort, avoiding double-hop serialization for large data.
- **MCP's read-state tools read main's Workspace Store directly**, zero round trips through the
  renderer.
- **Logs converge on a single point in main, and this did not require inventing any
  cross-process protocol** (2026-08-15): the stdout/stderr of driver host and package host were
  already forwarded by main's process wrapper, the renderer's console goes through
  `console-message`, and the ACP agent's stderr goes through the manager — the output of all six
  kinds of process **already reached main to begin with**. So the sink that writes to disk is
  installed in exactly one place, main, and **main is the only writer**, which incidentally
  eliminates the hardest boundary case in home-grown log rotation (concurrent appends). Two
  gaps of the same shape were fixed along with it: the renderer's forwarding and ACP's `noise`
  judgment were both originally **discarded at the point of collection**; now both only decide
  the level — what is dropped at the point of collection is gone for good, and what
  troubleshooting needs is exactly those few warn lines before the crash. See
  [`design/2026-08-15-logging-and-audit.md`](design/2026-08-15-logging-and-audit.md) §3.3.
- **Not a single line of a package's code runs inside main** (M8): it has its own
  utilityProcess, one per package, launched lazily (twenty installed packages equal twenty
  processes that have **not** started — which view kinds a connection can open is answerable by
  reading the manifest alone). This is not isolation for its own sake, it is the direct
  consequence of decision 6: with no signature/hash verification, "what it can touch once
  installed" is the only place still left to tighten. **Convention-based measures are
  meaningless here** — statically scanning `main.mjs` to forbid importing `node:fs` is defeated
  by a single line, `globalThis.process.mainModule.require('fs')`. The process boundary is
  enforced by the operating system, it cannot be gotten around, so it is the only one that
  actually works. main therefore keeps the one capability that is genuinely unique to it:
  calling `safeStorage.decryptString` on every credential that gets persisted to disk.
  `package host` copies driver host's RPC envelope, timeout ownership, and crash story wholesale
  — **it did not invent a second one**; the three differences (no data plane and hence no port,
  no ready handshake and hence the first response is the handshake, no graceful shutdown because
  there is nothing to shut down) are written in the header comment of
  `main/packages/host-process.ts`.
## 4. The Capability Model (first-cut split)

peek does not flatten every database into a lowest common denominator. Each driver declares a
capability set, and the UI and MCP tools adapt themselves by capability:

```ts
interface Driver {
  meta: { id: string; displayName: string };
  capabilities: Set<Capability>;
  connect(cfg: ConnectionConfig): Promise<Session>;
}

type Capability =
  | 'introspect'      // namespace tree: db→schema→table / db→key-pattern / collection
  | 'tabularQuery'    // free-form query statements (SQL, etc.), returns a tabular stream
  | 'collectionScan'  // sequential/paginated browsing of a collection (table, keyspace, collection)
  | 'keyValue'        // fetch by key + a typed inspector (redis hash/list/zset...)
  | 'vectorSearch'    // vector similarity search (qdrant)
  | 'valuePeek'       // on-demand full fetch of a large value (long text/blob/the vector itself)
  | 'cancel';         // cancel an in-flight operation

// Six-database comparison (verified 2026-08-13 by reading each peek-package.json on disk):
// postgres: introspect + tabularQuery + collectionScan + valuePeek + cancel
// mysql/sqlite: same (via the db-sql dialect layer)
// neo4j:    same, word for word — see below
// redis:    introspect(key pattern tree) + collectionScan(SCAN) + keyValue + valuePeek + cancel
// qdrant:   introspect(collections) + collectionScan(scroll) + vectorSearch + valuePeek
```

**The neo4j line is worth a second look**: a graph database reports a capability set
identical, word for word, to PostgreSQL's, because what Cypher returns is exactly a tabular
stream — `tabularQuery` speaks to that, not to "it is a relational database."
**Its "graph" side is not on this axis at all** — it is in the view kind the package
contributes (`graph`, see §5, the seventh view kind). This is the first instance of the
capability axis and the view kind each governing its own segment: capability answers "what
operations can this connection perform," view kind answers "what do these operations render
as," and a new database can touch only the latter.

**"Each driver declares a capability set" used to be backwards** (fixed 2026-08-03). This
sentence has been here since M1, but the code ran the other way: `core/capability.ts` held a
`DRIVER_CAPABILITIES` table declaring every driver's capabilities, and the five driver
packages each `import`ed it back as **their own** single source of truth
(`new Set(DRIVER_CAPABILITIES.postgres)`). The loop was self-consistent, and the contract
tests were green — both ends were reading the same cell — it was only that core was
describing a package it could not see.

Now each package declares it in its own `manifest.ts` (`DriverManifest.capabilities`), and its
`Driver` and `DriverSession` read from that same declaration, so "what is claimed" and "what
is implemented" are the same array, not two arrays that happen to be equal.
`DRIVER_CAPABILITIES` has been deleted from core; the prediction the UI and MCP need before
connecting is assembled by the app from each manifest
(`apps/desktop/src/drivers/manifests.ts`) — a driver package depends on core, and core
importing a driver package back would form a cycle, so **the shape lives in core, the roster
lives in the app**.

`DriverManifest` is this principle landed, and it governs more than capability alone: the
connection form, the display name, the SQL dialect, and the MCP endpoint text all moved back
into the package with it. It is exposed through a sub-entry point, `@peek/db-x/manifest`, that
**never touches the database client**, so the renderer can describe a database without
carrying its client along.
See [`design/2026-08-03-driver-package-boundary.md`](design/2026-08-03-driver-package-boundary.md).

**The capability axis itself did not change; what changed is where that table comes from**
(2026-08-07, Phase C). `DriverManifest` is no longer the export of a TypeScript sub-entry
point — it is a block of **pure data** on disk, in `~/.peek/packages/<id>/peek-package.json`:
the capability set, the connection form, the display template, the view kinds, and the MCP
tools all live there, and `PackageManifestSchema` judges whether it qualifies at load time.
`apps/desktop/src/drivers/manifests.ts` still exists, but it is now **how the registry is
read** (`installedDrivers()`), not the roster itself: the earlier line "the shape lives in
core, the roster lives in the app" now has to become **the shape lives in core, the roster
lives on disk**. `DriverId` is therefore an open string rather than a closed union, and the
six databases peek ships with take the same path — distributed with the app, copied into that
directory on first start, and uninstallable just like a package the user installed themselves.
See
[`design/2026-08-07-database-packages-from-disk.md`](design/2026-08-07-database-packages-from-disk.md),
whose §2.9 is the price of this trade: **the entry point checks nothing**: what you install is
what runs.

Constraints (part of the performance hard limits):

- Redis always uses a SCAN cursor; KEYS is forbidden. The type inspector dispatches by TYPE.
- Qdrant goes through scroll, fetching only the payload by default; the vector itself is
  pulled on demand through valuePeek.
- Every collectionScan / tabularQuery must implement cursor-style streaming returns.
## 5. Workspace State Model (Tiled Layout)

Layout is state; the AI changing the layout = sending a Command that changes this tree:

```ts
interface Workspace {
  rev: number;                   // +1 each time a Command lands; broadcast patches carry it, the renderer uses it to detect dropped frames
  connections: Record<ConnId, ConnectionState>;
  layout: LayoutNode;            // the tiled tree
  views: Record<ViewId, ViewState>;
  results: Record<ResultId, ResultMeta>;   // includes origin: who initiated it, recorded at creation time, see §10
  focusedPanel: PanelId | null;
}

type LayoutNode =
  | { type: 'split'; dir: 'row' | 'col'; ratio: number[]; children: LayoutNode[] }
  | { type: 'panel'; id: PanelId; viewId: ViewId | null };

type ViewState =
  | { kind: 'table';    connId; ref: CollectionRef; filter?; sort?; page }   // browsing a collection
  | { kind: 'query';    connId; text: string; resultId?: ResultId }          // free-form query
  | { kind: 'inspector';connId; ref: ValueRef }                              // inspecting a single value/row
  | { kind: 'tree';     connId }                                             // namespace tree
  | { kind: 'vector';   connId; collection; queryVec?; topK; filter? }       // vector search
  | { kind: 'chat';     connId?; sessionId?; … }                             // embedded agent conversation
  | { kind: 'package'; packageKind; connId; state; ref? };                   // a view contributed by a package (M8)
```

**The sixth view kind, `chat`, was not planned — it grew in** (see §9). It is also the only
view kind whose `connId` is optional — a chat panel can exist without being bound to any
connection, while the other six always belong to some connection. So any reader narrowing
on `kind` gets no connection guarantee on the `chat` branch.

**The seventh is `PackageViewState`, added in M8.** It is written as one member of the
union rather than turning the whole union into a registry, **so that every
`switch (view.kind)` in the repository stays exhaustive** — a call site that finishes
handling the six built-in kinds and then calls it done fails to compile, so "what do I do
when I get a package view here" becomes a question the compiler asks, not a blank panel.

**Note that `kind: 'package'` is a literal; the package's own name lives in
`packageKind`** (neo4j's `graph` is the only one today). The first version made the
discriminant field the package's kind name directly, with a brand added to avoid colliding
with the built-ins — **it compiled, and it quietly destroyed every `switch` in the
repository**: once the discriminant field is derived from `string` (the brand is still a
`string`), `ViewState` is no longer a discriminated union, and `case 'table':` no longer
narrows. After the change, the first typecheck reported "`ViewState` has no property `ref`
in `case 'table':`" — that message is the compiler saying exactly this. So the union is
**closed at seven members**, and the openness lives one layer down, where it costs nothing.
See `core/view-kinds.ts`.

**It is also the only view kind where "the view is not the same as what it displays."** The
other six vanish when closed, and reopening creates a new one; when `chat` is closed the
conversation survives on the agent side — the view is just one window onto it, and it can
be closed and remounted later from the conversation list. The conversation's identity is
`agentSessionId` (the key for that history on the agent side); `chatId` is only the runtime
handle for "this particular mount." See
[`design/2026-08-02-chat-session-management.md`](design/2026-08-02-chat-session-management.md).

The four kinds that fetch their own data (`table` / `query` / `vector` / `package`)
additionally share a `RefreshableViewBase` layer, carrying an `autoRefreshMs` —
DataGrip-style auto-refresh, where the interval is ordinary view state, the timer lives in
the main process (`main/auto-refresh.ts`), so `read_workspace` can see it and
`view.update` can change it. See
[`design/2026-08-03-auto-refresh.md`](design/2026-08-03-auto-refresh.md).

Synchronization mechanism: the main process holds the source of truth; after every Command
lands, it broadcasts a JSON patch (immer patches) to the renderer, and the renderer's
mirror store applies it. The renderer never modifies state directly.
## 6. Command Bus

Every state change is a Command. UI events and MCP tool calls converge on the same
entry point:

`COMMAND_NAMES` (`core/commands.ts`) stands at **39** today, named uniformly as
`domain.verb`:

```ts
conn.open / close / book.list / book.forget
view.open / update / close / activate / promote        // opening a table, changing a filter, paging — all view.*
query.run / cancel
layout.split / focus / setRatio / close / moveView / splitWithView / setLayout
chat.send / cancel / clear / attach / detach / respondPermission / setMode
     / sessions.list / sessions.delete
     / ask / answer                                    // agent asks a question and suspends waiting for an answer; a human answers
mcp.read / configure
settings.read / write
packages.read / install / uninstall / restore          // M8
state.read                                             // read-only, for MCP to query the current UI state
app.notify                                             // says something to the user, does not change the Workspace
```

Every Command: zod schema validation → handler (a pure function that changes the
Workspace + triggers side effects) → patch broadcast → returns a result. **Adding
an MCP tool = declaring an inputSchema + mapping it to some number of Commands** —
the tool layer is always a thin shell. A bonus capability: the Command log is
naturally an operation recording, replayable and testable.

**"Replayable" was an empty claim before 2026-08-15** — worth noting: that
recording lived in a 500-entry in-memory ring, zeroed the moment the process
exited, and a recording that vanishes on exit is not a recording. Now it is also
written to `~/.peek/logs/commands.jsonl` (one JSON line per entry, with
`redactCommandInput` already run ahead of it), and persistence to disk is not
bound by the 500-entry limit. Two read-only commands were added alongside it,
`log.read` / `log.readCommands` — **kernel verbs, which do not violate the rule
below, "a package cannot add verbs to it"** — they belong to the same category
as `state.read` / `settings.read`. See
[`design/2026-08-15-logging-and-audit.md`](design/2026-08-15-logging-and-audit.md).

**This table stays closed on purpose — a package cannot add verbs to it** (M8) —
a decision that is the reverse of §4's "move the roster to disk," and the reason
is obvious once you have read this table: all 39 names **are kernel-generic**
(connection, layout, chat, settings, notification); not one of them belongs to a
specific database. What a package actually needs is not a new verb, but for the
existing `view.open` and `view.update` to accept its `kind`. So only those two
commands' per-kind payload unions each grow by one member, and every guarantee
built on the closed table stays untouched: `CommandInput<K>`, `CommandResultMap`,
`_assertNoMissingResult`, `coreHandlers satisfies Required<CommandHandlerMap>`,
and the hundreds of `dispatch('view.update', …)` call sites in the renderer. See
the header comment on `view.open` in `core/commands.ts`.
## 7. MCP Service

- Streamable HTTP, bound to loopback only. The preferred port comes from `mcpPort` in
  `~/.peek/settings.json`, defaulting to 7332; when it is taken, scan forward across 8 ports —
  wherever it lands, a toast explains it and prompts re-copying the registration command; it
  only fails once all eight are taken. `PEEK_MCP_PORT` is an override switch for integration
  use: it only overrides, it does not write back to the user's preference. On startup a bearer
  token is generated and written to `~/.peek/mcp.json` (file 0600 / directory 0700); how to
  connect:
  `claude mcp add peek --transport http http://127.0.0.1:7332/mcp --header "Authorization: Bearer <token>"`
- **The token does not go into logs** (fixed in M6). This command line used to be printed to
  stdout for a person to copy, but the token equals full control over the window and every
  database connection inside it, and stdout's audience is wider than it looks: the terminal's
  scrollback buffer, CI logs, crash reports, and whatever `PEEK_FORWARD_CONSOLE` forwards to.
  Now the log prints only the address; the copyable command exists in only two places with
  access control — that 0600 file, and the copy button on the settings panel. The regression is
  watched from both sides by `mcp-endpoint.test.ts` and `verify-chat-security.mjs`.
  **2026-08-15 addendum: a fourth name joined the audience list, and it is the most persistent
  one** — `~/.peek/logs/` is a file, it outlives stdout, and the entire reason it exists is to
  be packaged up by the user and sent to someone else. Directory 0700 / file 0600 is the same
  spec; `scrub.ts` is a backstop (it registers the token's literal value plus pattern matching),
  but **the real guarantee still lives at the call site**: the token is never passed into any
  log call at all. `verify-chat-security.mjs` therefore gained a section — after running the
  real app, it greps the entire logs directory; zero hits for the token. A run that writes
  nothing at all is called out in so many words as "this check has proven nothing," not passed
  off as green.
- The **MCP Endpoint** category of the settings page (title-bar gear / `⌘,`) is responsible for
  changing the port and rotating the token; both explicitly prompt that registered clients need
  to re-register. The entry originally lived on the sidebar's "Connections" header row, but what
  it manages is the MCP endpoint, which has nothing to do with connections; as the number of
  configurable items grew, the preferences were folded into one unified settings page. See
  `docs/design/2026-08-02-settings-panel.md`.
- Built-in reference tools (a thin shell; the user adds and removes their own afterward). There
  are **16** today, one file per tool under `tools/`:
  - Read: `read_workspace` / `list_connections` / `introspect` / `read_chat`
  - Connections and data: `connect` / `run_query` / `cancel_query`
  - Views and layout: `open_view` / `activate_view` / `move_view` / `set_layout` / `set_ratio`
  - Chat: `send_chat` / `control_chat`
  - Notification and asking: `notify` / `ask` — two tools that act on the person, not the
    window. The former says its piece and leaves; the latter suspends and waits for an answer
    (`design/2026-08-15-notifications.md`,
    `design/2026-08-15-agent-asks-a-question.md`)
- The tool registry is independent of the kernel: each file under `tools/*.ts` declares
  `{name, schema, toCommands}`; changing a tool does not touch the kernel.
- **16 is not the length of `tools/list`** (since 2026-08-07). A database package can
  contribute its own tools; they do not live under `tools/` and are not compiled with the app:
  the manifest's `tools` key declares them, the package's own `contrib.mjs` implements them, and
  they run inside the package host. Of the six databases bundled by default today, only neo4j
  uses this path (`expand_node`), so a default install ends up at 15 + 1. **The directionality
  of this matters**: installing a package makes `tools/list` grow; uninstalling it has to make
  it shrink back — the latter direction is the one the gap has opened up twice, and it is now
  guarded by a single filter in `drivers/contribution.ts`, see §11.2.
- **The embedded agent connects back to this same process's MCP**: the Claude Code running in
  the chat panel is handed exactly this endpoint, so "the model in the panel" and "the external
  client" use the same set of tools, the same Command Bus. This is exactly the point of
  `read_chat` / `control_chat` — an external client can watch and drive the embedded one.
## 8. Performance budget (hard limits, measured against as you implement)

| item | budget |
|---|---|
| cold start to interactive | < 1.5s |
| extra overhead for query results' first chunk (excluding DB time) | < 100ms |
| table scrolling (1M-row result set) | 60fps, no materialized whole |
| renderer result-cache cap | ~200MB, LRU eviction of remote chunks |
| chunk size | target 256KB–1MB, adaptive, 500–2000 rows |
| backpressure | ack window (fetching pauses once unacknowledged chunks ≤ 4) |
| large value | preview truncated to 4KB, full value goes through valuePeek |
| introspect | tree lazily loaded + cached + invalidated on connection-state transitions + invalidated on manual refresh |

### 8.1 Measured (reproducible since M6, no longer hand-copied)

Two scripts, both booting the **built app** and isolating user-data-dir / config-dir / MCP
ports:

```bash
pnpm --filter @peek/desktop build
node apps/desktop/scripts/bench-startup.mjs   # cold/warm start + bundle size
node apps/desktop/scripts/bench-scroll.mjs    # run_query + frame time + DOM node count
```

`bench-startup.mjs` uses `NODE_OPTIONS=--import` to inject a probe that reads `ready-to-show` /
`did-finish-load`, **not by stuffing instrumentation into `src/main/index.ts`** — instrumentation
ends up in the built app, and it also changes the thing being measured.
`bench-scroll.mjs` generates its own SQLite fixture (no dependency on any database service); it
first drives `connect` + `run_query` via MCP, then hooks up CDP and samples while scrolling the
table.

M2 Max / macOS 26.1 / dpr 2 / 120Hz / Electron 43.2 / 1-million-row SQLite fixture.
**This entry is the measurement taken when M6 was closed out; it was not rerun when this document
was aligned on 08-13** — the built-bundles table in §8.2 was reweighed, these two scripts were
not. The strongest reason to remeasure in between is M8: drivers now load from disk, and both
the cold-start path and `run_query`'s first chunk gained an extra round of package parsing.
Run it once and you will know — the two commands are above.

| item | budget | measured |
|---|---|---|
| cold start to ready-to-show (warm, median) | < 1.5s | **518ms** (min 481 / p95 566) |
| cold start to ready-to-show (first run) | < 1.5s | **802ms** |
| dropped frames over a 600-frame, 1M-row scroll | 60fps | **0** |
| main-thread time per frame (handler + style + layout) | — | median **0.20ms** / p95 **0.30ms** / max **0.80ms** |
| `.grid-surface` element count | no materialized whole | 1M rows **279–369**, 200K rows **306–396** |
| `run_query` end-to-end, 1M rows | — | **2124ms** |

Three footnotes that must be read together:

1. **Frame interval is not speed.** rAF-to-rAF is locked to vsync, so the median naturally
   equals the refresh period. What actually matters is "dropped-frame count" (an interval
   exceeding 1.5 refresh periods) and "main-thread time per frame."
2. **DOM node count is determined only by the viewport, not by the size of the result set**:
   node count did not rise when row count increased fivefold (the two runs rendered 41 rows
   and 44 rows respectively, so the 1M-row run was actually slightly lower). The range within
   a single run is overscan expanding and contracting as scrolling reaches either end.
3. **"End-to-end" presupposes the reader is scrolling down.** Backpressure holds delivery as
   soon as it detects the delivered row count running too far ahead of the viewport, so a
   "never scrolling" benchmark measures a pause timeout, not the query — the first version of
   this script reported "60,483ms / 207,000 rows" for exactly this reason. The table above was
   measured by driving the viewport continuously to the end; that is the condition that clears
   the row gate.

### 8.2 Built bundles

electron-vite defaults all three targets to `minify: false`. After M6 turned it on
(main/renderer use esbuild):

| Bundle | Unminified (08-04) | M6 close-out | 2026-08-04 | **2026-08-13 measured** |
|---|---|---|---|---|
| renderer index | 1,371,728 | 531,276 | 619,683 | **629,981** |
| renderer SqlEditor chunk | 882,083 | 433,857 | 433,873 | **434,951** |
| renderer CSS | 62,506 | 32,185 | 43,393 | **37,734** |
| main index | 499,821 | 197,594 | 248,093 | **285,640** |
| main shared chunk | — | 39,067 (called commands at the time) | 57,270 (called manifest at the time) | **38,819** (package-host) |
| main driver-host | 5,428,315 | 2,037,865 | 2,677,387 | **12,044** ⟵ |
| package-host | — | — | — | **21,094** |
| preload | 10,988 | 8,486 | 10,988 | **16,228** (**deliberately not minified**, see below) |
| **app bundle total** | — | 3,281,138 (~3.2MB) | 4,116,349 (~4.1MB) | **1,477,816 (~1.5MB)** |
| the five database packages (`out/packages/`) | — | — | — | **3,676,674 (~3.7MB)** |

**The `driver-host` row is the single largest change in number anywhere in this plan:
2,677,387 → 12,044.**
It was not optimized down; it is the other side of the bill for the move in §4 — the five
database clients disappeared entirely from the app bundle, and `driver-host.js` is left as
nothing but a shell that loads `driver.mjs` from disk according to `PEEK_PACKAGE_ENTRY`.
So the "total" column is not directly comparable between 08-04 and 08-13: the former is an
app carrying every database inside it, the latter is an **empty** app plus five packages
that can be uninstalled. To compare the real totals, it is 4,116,349 against 5,154,490
(1.5MB + 3.7MB), a difference of 1,038,141 B. **No itemized attribution was done**, but the
largest single piece is the neo4j package's own 860,609 B — it did not exist as of 08-04.

In the same period, `out/` also holds 1,972,006 B of `render-probe/` (probe pages and
fixtures) — neither total column above includes it.

**The "does not ship" that used to stand here was wrong, and was already wrong on the day it was
written** (2026-08-24). `package-mac.mjs` stages all of `out/` except `out/packages`, and
@electron/packager is handed that staging directory with no `ignore`, so the probe lands in
`Contents/Resources/app/out/render-probe/` — the 08-12 bundle still sitting in `release/` carries
it, at 2.0 MB. Keeping it out of the columns above is still right for what they measure, the
app's own code; it was never right as a statement about what a user downloads.

The "Unminified" column is the value from the 2026-08-04 remeasurement (temporarily flipping
`MINIFY` to `false`, building once to measure it, then reverting it); the 08-13 pass did not
remeasure it. The M6 column keeps its original value untouched; the gap between it and 08-04
**is mostly not a change in minification ratio, it is six months of features growing in** —
driver-host growing from 3.9MB to 5.4MB is new drivers, main index is the command plane.

Only the renderer CSS row can be traced back to one specific change: the Tailwind migration
lifted it from 40,794 B to 43,393 B (+6.4%), and at the same time renderer index went from
606,500 B to 619,683 B (+2.2%). Both "before the migration" figures were measured on the
same tree on the day the migration started, not the M6 column above.
**The built cost of the atomic classes is higher than the hand-written CSS it replaced** —
the opposite of what the migration design document's §5.3 originally expected. Details and
reasons are in `design/2026-08-04-tailwind-migration.md` §5.3 and the Phase 3 section.
In passing: CSS's minification ratio dropped from −44% to −31% — there is not much left to
squeeze out of the utility classes themselves.

**By 08-13 this row has already fallen back to 37,734 B** — 7.5% lower than the 40,794 B
before the migration. **Do not read this as overturning the conclusion above**: several
style changes landed in those nine days (the form primitives dropped four rules from
`styles.css`, `audit-shipped-css.mjs` started asking questions of the bundle), **no A/B test
was run**, so who gets credit for this 5.7 KB drop is unknown. The earlier statement that
"the atomic classes cost more than hand-written CSS" measured the difference between
switching and not switching on the same tree on the same day — that comparison still holds;
this row only shows that **the total is no longer that number**.

(Running `bench-startup.mjs` prints the current values. The renderer index row is worth
noting: partway through M6 someone wanted to kick `zod` out of the renderer bundle, by
hand-writing a validation rule table to replace `ConnectionConfigSchema`. The A/B
measurement's conclusion was **the opposite** — the hand-written version came to 533,140 B,
the real-schema version to 531,272 B; the hand-written version was actually 1,868 B larger,
and it was a second copy of the very contract the main process actually executes. The
reason: `core`'s `ids.ts` and `errors.ts` are themselves built on zod, every command and
every error in the renderer needs them, so the zod runtime necessarily ends up in the
bundle. That change has since been reverted, with 5 tests added to lock in "validation
shares a source with main". Do not try this a second time.)

- main enables `keepNames`: the main process is the only call stack that actually gets read
  (uncaught rejections, driver-host crashes, `PeekError` thrown to MCP), and the cost,
  measured on driver-host, is < 2%.
- **preload is deliberately not minified.** `contextBridge.executeInMainWorld({ func })`
  takes the function's **source text** into the main world and evals it there, so the
  function must be fully self-contained. With `keepNames` on, esbuild generates
  `var a = (r, o) => Object.defineProperty(r, "name", …)` in module scope and rewrites the
  nested function inside `bootstrapMainWorld` to call `a(…)`; in the main world this is a
  bare `ReferenceError: a is not defined` — bootstrap falls into its degraded branch and
  **the data plane disappears silently**: the window still opens, commands still run, only
  the result MessagePort never arrives again. This was measured, not deduced.
  Plain minification with keepNames off happens to stay self-contained today, but that is a
  coincidence of the current minifier plus the current source, and the entire gain it buys
  is 4.6 kB — not worth it.

chunk frame format (columnar, leaving room for a future switch to Arrow/ArrayBuffer):

```ts
{ resultId, seq, schema?: ColumnDef[],   // first frame carries schema
  cols: unknown[][],                     // stored by column
  done?: { rows: number; elapsedMs: number } }  // elapsedMs excludes backpressure parks
```
## 9. Milestones

- **M0 Skeleton**: monorepo + electron-vite boots the window; the core package defines the
  Command/state/chunk protocol; Command Bus + patch sync works end to end; the MCP server
  starts up on 7332, `read_workspace` returns real state.
  ✅ Acceptance: Claude reads UI state through MCP; clicking a button and issuing a tool call
  go through the same log.
- **M1 PG minimal closed loop**: db-postgres (utilityProcess + streaming chunks); table view +
  virtualization; the four tools `connect / introspect / open_view / run_query` are available.
  ✅ Acceptance: the AI says "open such-and-such table in such-and-such database" and the UI
  actually opens it; scrolling a million rows does not stall.
- **M2 Tiled layout**: the layout tree + drag-to-split + `set_layout`; the AI can arrange
  multiple views for comparison.
- **M3 Redis**: SCAN browsing + a typed inspector, validating the non-SQL path of the
  capability model.
- **M4 Qdrant**: collection scroll + a vector search view.
- **M5 MySQL/SQLite**: the db-sql dialect layer, validating the SQL abstraction.
- **ACP chat panel** (unplanned, grew in between M5 and M6): the agent runs inside the `chat`
  view and connects back to this same process's MCP, closing the loop; result rows enter
  context only as an attachment the human explicitly stages; permission prompts are answered
  by the human. §5's view kinds therefore go from five to six. At first there was only one
  tier, Claude Code, later split into pluggable backends (an ACP subprocess / a
  user-configured LLM endpoint), see `design/2026-08-03-pluggable-agent-backends.md`.
- **M6 Polish**: ✅ Done. Six pieces landed:
  1. **Cancellation / timeouts, end to end**: `connections/timeouts.ts` centralizes every
     timeout constant (per-phase timeouts + the whole-execution budget); every query / scan /
     vectorSearch runs under a watchdog; expiry and an explicit `query.cancel` go through the
     same escalation path (ask the driver to stop first, kill the process if that times out).
     Added the MCP tool `cancel_query`.
  2. **Error panel**: a status bar badge + a copyable error center, keeping the most recent
     100 entries.
  3. **Persistence**: `mcp.json` / `connections.json` / `settings.json` under `~/.peek`;
     credentials are encrypted by the OS keychain via Electron's built-in `safeStorage`,
     stored separately from the config describing the server. The connection book is written
     only after `conn.open` **succeeds** — `conn.open` is still the only write path.
     **Starting 2026-08-15 there is one more file, `workspace.json`** (the layout tree + each
     view's definition), see the crossed-out entry under "Still open" below.
  4. **Port and token management**: see §7.
  5. **capability's three grains**: per-driver (the original table), per-collection
     (`CollectionSchemaInfo.browse` declares sortable columns / filterable columns / whether
     sorting terminates pagination), per-value (the canonical JS representation in
     `core/values.ts`).
     Fixed two real data bugs along the way: PG's `BIGINT 1` used to be a string, and `DATE`
     used to be a `Date` at local midnight (serialized east of Greenwich, it came out a full
     day off). `core/cursor.ts` defines a unified cross-driver encoding for cursorToken, fixing
     along the way "qdrant would treat redis's token as a point id, start scrolling from a
     point that does not exist, and silently return an empty page".
  6. **Build and measurement**: built bundles minified (6.2MB → 3.2MB, excluding preload, see
     §8.2), two benchmark scripts, one executable chat-safety verification script (§9.1),
     pulled the generic table engine out of the table view.
- **M7 Session management**: when M6 closed out, the chat panel had only one entry point (a
  button in an empty panel) and one lifecycle (closing the tab meant losing it). M7 pulls the
  session out of the view: a persistent entry point in the status bar, a session list, history
  restoration, deletion. **No new persistence layer** — `claude-agent-acp` already advertises
  `loadSession` and `sessionCapabilities.list/delete`; the history has always lived in the
  agent's own cwd (`~/.peek/chat`), and what peek does is wire it out. **After multiple
  backends, this has one correction**: the three tiers keep their history in different places;
  for the endpoint tier there is no agent side at all, so `~/.peek/chat/sessions.json` keeps an
  index containing **only routing** (which session belongs to which tier); the transcript still
  exists in exactly one place, still in its own source. The reasoning is in
  `design/2026-08-03-pluggable-agent-backends.md` §3.5. The design and trade-offs are in
  [`design/2026-08-02-chat-session-management.md`](design/2026-08-02-chat-session-management.md).
  The verification script `scripts/verify-chat-sessions.ts` is covered in §9.1 — it has caught
  a bug that unit tests did not catch; run it first before changing the ACP layer.

  **The "no new persistence layer" line has since been split apart by backend** (2026-08-03).
  The original statement assumed "the history has always lived on the agent side" — true for
  the ACP tier, not true for the endpoint tier: there is no agent process there, and not
  persisting to disk does not mean "there is exactly one copy of the history," it means **zero
  copies** — measured behavior is that closing the tab permanently deletes it, and the session
  list is always empty. The dividing line now is **whether the body of this conversation has
  another owner**: the ACP tier still stores not a single byte, and replays via `session/load`;
  the endpoint tier is stored by peek itself, at `~/.peek/chat/endpoint/<sessionId>.json`.
  Also added a re-fetch channel for after the renderer reloads (`CHAT_RESTORE`), shared by both
  tiers. The reasoning, the measured data compared against Zed, and the trade-offs are in
  [`design/2026-08-03-chat-history-ownership.md`](design/2026-08-03-chat-history-ownership.md).

- **UI pass** (unplanned, 2026-08-04 to 08-06, between M7 and M8): not a single new feature;
  what changed is how this window reads and where it converges. The Tailwind v4 migration and
  peek's own type scale (last row of the §2 table), settings moved out of the sidebar and into
  the macOS app menu, the sidebar became collapsible, the control layer and the legibility
  baseline. What this batch has in common is **turning repeated eyeballing into an assertion
  that can go red** — `theme-contrast.test.ts`, `type-scale.test.ts`, and
  `control-spec.test.ts` were all established at this point. See
  `design/2026-08-04-tailwind-migration.md`, `2026-08-04-settings-into-app-menu.md`,
  `2026-08-04-sidebar-collapse.md`, `2026-08-02-ui-legibility-baseline.md`.

- **M8 Database packages installed from disk + Electron hardening** (2026-08-07): **Phase C**,
  planned in `2026-08-03-plugin-architecture.md` §2.1 — not a new direction. What the user
  wanted was "the read-only 'which databases are installed' table in settings, turned into
  something the user could install and uninstall themselves." The shape of what landed is in
  §4 and the directory tree in §2; here we record only what **else** it changed:
  1. **`DriverId` went from a closed union to an open string.** "How many places adding a
     database touches" went from 15 → 7 → **0**; the price is that those 4 remaining places,
     once enforced by the compiler, became load-time validation instead (a manifest missing a
     field is refused at load, and named). From "it will not compile" to "it will not
     install" — both fail loudly, but the latter fails at runtime.
  2. **Package code does not enter main** (Decision 7): packages run inside a dedicated
     package-host utilityProcess. The reason is Decision 6 — since there is no signature/hash
     verification, "what it can touch once it is installed" is the only place left to tighten,
     and every convention-based measure (statically scanning `contrib.mjs` to forbid importing
     `electron` / `node:fs`) can be bypassed by `globalThis.process.mainModule.require('fs')`.
     **The process boundary is enforced by the operating system — there is no way around it.**
     (That file was still called `main.mjs` in the first half of the design document, renamed
     after Decision 7 — the old name implied it ran inside main, which is exactly what this
     decision rules out.)
  3. **Hardening and Phase C done in one pass** (Decision 8, against the recommendation):
     acceptance items grew from 27 to 40, a batch of which have nothing to do with database
     packages. The cost is recorded honestly in that document's §0.
  4. **The sixth database, neo4j, arrived at this point too**, and the way it arrived is
     itself the acceptance test: it is the first package to **contribute a view kind**
     (`graph`, with its own `ui/`), i.e. the first proof that "a package can bring more than
     just a driver." §5's seventh view kind and the "the only exception" entry in §11.2 both
     came out of it.
  See [`design/2026-08-07-database-packages-from-disk.md`](design/2026-08-07-database-packages-from-disk.md),
  whose §2.9 is the price of this trade: **the entry point checks nothing**: what you install
  is what runs.

- **M8 Wrap-up** (2026-08-11 to 08-13): what surfaced once Phase C landed, plus the debt it
  incurred on its own. Grouped into three by topic:
  1. **Filling out the "install/uninstall" axis** — package admin pulled out of
     `main/index.ts` (`2026-08-11-package-admin-out-of-main.md`); contributed kinds go into a
     roster so "missed filtering on uninstall" cannot happen again
     (`2026-08-11-package-contribution-roster.md`); the connect dialog's default driver is the
     last remaining compile-time database manifest in the window
     (`2026-08-11-connect-dialog-default-driver.md`); the validation code that only ever runs
     in the main process was moved out of the window's bundle
     (`2026-08-12-main-only-parse-out-of-the-window.md`).
  2. **Nailing guards to shipped code** (`2026-08-12-guards-nailed-to-shipped-code.md`) —
     after Phase C, three compile-time tables had no production consumer left; deleting them
     changed the built bundle by not one byte, and turned five tests red. **An assertion
     nailed to code that never ships — when it goes red, no one knows whether it needs
     attention** — so the tables were deleted along with their guards, replaced by putting the
     question to the built bundle instead. The rest of where this principle landed is in §9.1.
  3. **Four unrelated items**: the one-and-a-half seconds to open an old conversation (the
     snapshot renders first, `2026-08-06-opening-a-stored-conversation.md`); redis's namespace
     tree now says so when a level cannot be fully scanned
     (`2026-08-12-redis-truncated-namespace-level.md` and its fixture `-sample-fixture.md`);
     the cost of opening a package view is now measured in bytes and one-time milliseconds
     (`2026-08-12-package-open-cost-benchmark.md`); the starting permission is now read live
     rather than read once at launch (`2026-08-13-permission-mode-takes-effect.md`); form
     primitives (`2026-08-13-settings-form-primitives.md`, see the control-layer entry in
     §11.2).
### 9.1 Repeatable verification

Beyond `smoke-drivers.mjs`, M6 adds `verify-chat-security.mjs`. It replaces two things that
sat in `src/` unrun by anyone (`acp/__tests__/smoke.manual.ts` is not in any test glob;
`acp/__poc__/inject.poc.ts` only prints a document for a human to judge) — both are deleted.

```bash
pnpm --filter @peek/desktop build
node apps/desktop/scripts/verify-chat-security.mjs            # online, costs tokens (four real conversation turns)
node apps/desktop/scripts/verify-chat-security.mjs --offline  # free, can run in CI
```

It verifies the session sandbox's shape, the source of the MCP tool manifest, that a prompt
asking for shell access gets no shell, that injection in a database cell is not executed, that
the bearer token enters neither the transcript nor stdout, and closing the loop and the batch
budget. Exit code 0 = all passed.

M7 adds another one, the same kind but **costs no tokens** (`session/list` reads the
directory, `session/load` replays — not a single prompt is sent), reads the real
`~/.peek/chat` and neither writes nor deletes:

```bash
cd apps/desktop
node --import ./src/main/bus/__tests__/ts-resolve.hooks.mjs scripts/verify-chat-sessions.ts
```

What it verifies: the directory listing is complete, filtering by cwd, `loading → ready`,
replay lands in the transcript, closing the view does not destroy the session. **Touch the
ACP layer and this is what you run**: a unit test can only cross-check against the stub
sitting next to it, and the two of them missed something together, once — at the time the
stub only replayed agent messages, so it was perfectly self-consistent with the translator
that "drops every `user_message_chunk`," and only running the real agent showed that the
restored conversation was a monologue by Claude.

Two lessons are recorded here, because both are cases of "an assertion aimed at the wrong
target":

- **Do not hardcode the tool count.** The original assertion was "exactly 12 tools"; adding
  `cancel_query` triggered a false alarm. Changed to derive the count from the running
  server, then reconcile it against `tools/*.ts` in the repo.
- **Do not assert on the model's wording.** The canary assertion originally was "the nonce
  appears in the reply, and it matches `/cannot|unable|no .*tool/`" — the first time the
  model refused with "I don't have a Bash tool" it went red, while both structural
  assertions were still green at the time. Changed to a structural criterion: the output of
  `echo <nonce>` must be a nonce **occupying a line by itself**, while a reference to it
  inside an explanation is inline. The real evidence is always "no tool outside peek was
  ever called" — the text is only corroborating evidence.

### 9.2 The full picture now: three guards are already inside `pnpm build`

The two scripts above still have to be run by hand. The batch added after M8 **does not** —
they are part of `pnpm build`; a passing build means they passed:

```jsonc
"build": "build:packages && electron-vite build && build:package-host
          && audit-package-boundary.mjs && audit-shipped-css.mjs && probe:render"
```

| Script | Question it asks | Why it must ask the built artifact |
|---|---|---|
| `build-packages.mjs` | Whether the `tools` export of each package's built `contrib.mjs`, and the `tools` key of the `peek-package.json` written right next to it, are the same set of names | Deleting one mapping changes the byte count and fails the build — two compile-time arrays cannot do that |
| `audit-package-boundary.mjs` | What main's build output **can load** | "`grep expand_node out/main/index.js` → 0" was once treated as proof that the boundary held, when it was only a property of the call graph at the time |
| `audit-shipped-css.mjs` | What is inside the stylesheet the app actually loads | Every other style guard reads the **source**; it answers "who wrote what" |
| `render-probe/` | The pixels actually rendered: reachability, hit-testing, contrast, four interaction states | A 28px misalignment cannot be told apart by eye. This one covers the connection dialog, the control gallery, and the consent dialog (once in Chinese, once in English) |

The remaining manual scripts, grouped into four by purpose:

- **Smoke and end-to-end**: `smoke-drivers.mjs`, `verify-auto-refresh.mjs`,
  `verify-chat-restore.mjs` (drives the real built app over CDP, verifying against the class
  of defect where "every part is correct, only the wiring is missing")
- **Security**: `probe-hardening.mjs` (makes a real window attempt the three things it must
  refuse, and watches it refuse), `verify-fuses.mjs` (reads the fuses back from the
  **packaged binary** — every way `flipFuses` writing them can go wrong is silent)
- **Measurement**: `bench-startup.mjs`, `bench-scroll.mjs`, `bench-package-frame.mjs`
- **Vocabulary**: `check-package-vocabulary.mjs`, already hooked in ahead of `pnpm test`

**The shared premise behind this batch of scripts is written in
`2026-08-12-guards-nailed-to-shipped-code.md`, and it is worth remembering on its own**: an
assertion should be nailed to something that ships. An assertion nailed to something that
does not ship — when it goes red, nobody knows whether it needs to be dealt with, and that is
exactly the moment it most needs to be believed.
## 10. Open questions

### Settled

- ~~Tiled layout: build in-house vs. dockview~~: **Decided, build in-house.** The layout
  tree is the true state driven by Command; dockview holds its own layout state, and wiring
  it in would mean introducing a second write path. Built in-house since M2.
- ~~Whether "can it be sorted" is a table in core or a declaration from the driver~~:
  **Decided, the driver declares it per collection.** `CollectionSchemaInfo.browse` +
  `resolveCollectionBrowseStyle`, landed in M6.
- ~~How many JS representations one `LogicalType` maps to~~: **Decided, exactly one.**
  `core/values.ts`, asserted against a real server for all four drivers.
- ~~MCP port hardcoded~~: **Decided, configurable + scans forward on conflict.** See §7.
- ~~Whether connections are persisted~~: **Decided, persisted, credentials go through the
  OS keychain.** See §9, M6, item 3.
- ~~How timeout settings enter the UI~~: **Decided, land as a global preference first,
  connection-level overrides belong to `ConnectDialog`.** The settings page's "Query &
  Timeouts" category exposes only three execution timeouts (`queryMs` / `scanMs` /
  `vectorSearchMs`), written into `settings.json`'s `executionTimeouts` and fed to
  `setTimeoutSettings` at startup; the nine stage timeouts are the protocol's own
  self-protection, not a user preference, and do not enter the UI. See
  `docs/design/2026-08-02-settings-panel.md` §3.2, §3.3.
- ~~The error center's `source` attribution is a heuristic~~: **Decided, record the
  initiator on the thing being created** (2026-08-02). The fix originally recorded here was
  "send main's command log to the renderer, which requires adding an IPC channel + a
  preload member." That route was both expensive and insufficient: the `query.run` log
  entry is **successful**; the failure happens thirty seconds later, and the renderer still
  has to do its own `resultId → commandId → source` correlation — and that correlation is
  exactly what "record the initiator at creation time" delivers in one step. Now
  `ResultMeta.origin` / `ConnectionState.origin` are written by the Command Bus at the
  moment of creation, **with zero IPC channels added**. The heuristic it replaced was wrong
  in precisely the scenario where it most needed to work: a query that ran for thirty
  seconds before timing out has no in-flight command by the time it fails, no matter who
  started it, so a query a human clicked gets recorded as the agent's doing. This also
  collapsed the panel's enum down to core's `CommandSource`, making it possible for the
  first time to separate the embedded chat panel (`agent`) from an external MCP client
  (`mcp`). See
  [`design/2026-08-02-failure-attribution-and-degraded-boot.md`](design/2026-08-02-failure-attribution-and-degraded-boot.md).
  **Addendum, 2026-08-15: the rejected route was reopened, but it did not cost a cent.** Be
  precise about what was rejected — what was rejected then was the **use** (using the
  command log for attribution), and that judgment still holds today; `origin` has not moved
  an inch. "Let a human see what just happened" is a different use, and that reasoning does
  not apply to it. And the price tag from before — "an IPC channel + a preload member" — is
  not needed at all this time: reading goes through `log.readCommands`, which is an ordinary
  Command; `PeekBridge` gained no member, and not one line of preload changed. The cost
  shifted to something else, and that is recorded too — **the panel is pull-based, not
  real-time** (one read on open + 2s polling), and this is not a loss, because the
  real-time property of "it just blew up" was already guaranteed by the error center's
  subscription; the only thing that is not real-time is scrolling back through history.
  There is one more self-referential trap: `log.*` does not enter the command log, or the
  panel, left open, would flush the audit trail clean at two entries a second; `state.read`
  is **deliberately not skipped**, for a reason recorded on `UNRECORDED` in
  `command-log.ts`.
- ~~**Whether layout and open views are persisted** (added in M6)~~: **Decided,
  persisted** (2026-08-15). The original text said what stood in the way was
  `TableViewState.cursorToken` — it carries driver identity and gets a flat `BAD_REQUEST`
  across versions, so "restoring layout has to distinguish between 'view definition' and
  'in-session cursor,' and store only the former." That dividing line **was already in the
  type system** — nobody had pointed it out yet: `ViewOpenSpec` is the definition,
  `ViewState` is the definition plus session state, and `cursorToken` / `resultId` /
  `status` live only on the latter. So there was no need to invent an allowlist of storable
  fields — **store the spec**, and the spec has no cursor to store. The second consequence
  outweighs the first: restoring is therefore a sequence of `conn.open` →
  `layout.setLayout` → `view.open` → `view.activate`, which **travels through exactly the
  same command channel as a human or an AI**; a hand-edited, broken `workspace.json` can at
  worst leave some view unable to open — it cannot construct an illegal tree. The only new
  mechanism is "wake, once a connection is ready, the views hanging under it that have not
  yet fetched data" (`main/connection-wake.ts`), which incidentally fixed a problem that
  had always existed: those views were also empty after a reconnect. See
  [`design/2026-08-15-workspace-persistence.md`](design/2026-08-15-workspace-persistence.md).

### Still open

- Result-set spill to disk (overflowing oversized results to disk): do it once the budget
  is exceeded. **The trigger has not arrived** — the 200MB LRU has not hit its ceiling yet.
- Write operations (UPDATE/DELETE/SET): **the blocking point for this one has now been
  identified, and it is not the one originally written here** (2026-08-03). The original
  text said "close to the trigger but not there — M6 fitted the brakes, what is still
  missing is a set of confirmation and rollback semantics," which treated it as something
  whose **engineering was not yet finished**. Before starting work, the entire write
  path was swept end to end, and the conclusion is **it is stuck on three decisions only a
  human can make, not stuck on engineering**:

  1. **What "Read-only, always." becomes** — a connection-level switch (default read-only)
     / open only for local SQLite files / no editor at all. This line is in the README's
     feature table and in the MCP's `instructions`.
  2. **Whether an MCP client can write** — `connect` / `run_query` are already open to any
     client holding the token, and the token is all-or-nothing. Once a write tool ships,
     **any process that gets the token can modify the database, with no human in the
     loop**.
  3. ~~**How far the audit trail goes**~~ — **Decided, written to disk and visible in the
     UI** (2026-08-15), and decided before the write path landed. This is not jumping the
     gun: the two items above are stuck on decisions only a human can make, and this is the
     only one of the three that is **pure engineering** — doing it first means one fewer
     decision by the time the write path lands, and by then the audit trail is not freshly
     built, it is one that has already been running a while and has already been read by a
     human. Today `commands.jsonl` records source / redacted input / ok / rev / elapsed
     time for **every** Command, and the panel's "Commands" tab filters by source — that is
     also the first time `CommandSource` becomes fully visible: before this, the
     distinction that had been recorded since M2 and that `command-origin.test.ts` had
     always watched had exactly one way out, a label on **failed** entries in the error
     center; nobody could see it on the successful ones. See
     [`design/2026-08-15-logging-and-audit.md`](design/2026-08-15-logging-and-audit.md)
     §2.2.

  There is also an implicit premise to correct: peek's read-only mode **is not "writes have
  not been built yet," it is a guarantee that has been built**, enforced by the server, and
  the client does not parse a single line of SQL (PG issues `BEGIN READ ONLY` per cursor,
  MySQL resets on every checkout, SQLite re-asserts `PRAGMA query_only` before every
  prepare, redis/qdrant have no general-purpose exit at all). **There is no keyword
  allowlist of any kind, and this is deliberate** — parsing SQL to decide whether it writes
  is a game you cannot win (`WITH … SELECT` looks like a write to a naive matcher, a
  stored-procedure call looks like a read), and the database itself has an answer that
  cannot be fooled. So the phrase "flip the read-only switch the other way" does not even
  make sense: there is no such switch. Four preparatory fixes unrelated to any of the three
  decisions have already been made (including a read-only regression test PG had always
  been missing, 6 test cases). For the full conflict list, cost list, and phased
  recommendation, see
  [`design/2026-08-03-write-path-scope.md`](design/2026-08-03-write-path-scope.md) §5.
- Arrow binary channel: the chunk interface is already columnar; switch once the IPC
  bottleneck has been measured and quantified. **The trigger has not arrived** — §8.1
  measured a median of 0.20ms of main-thread time per frame; the bottleneck is not in
  serialization.
- Developer ID signing and notarization: **the trigger has not arrived, and what triggers
  it is distribution, not security** — the day the first `.dmg` / `.zip` goes up on a
  GitHub Release. An unnotarized app downloaded from a browser gets flatly blocked by
  Gatekeeper, and before that day it is not even an option. It incidentally solves two
  things nothing else fixes today: (a) the hardened runtime (`--options runtime`) **is not
  honored by AMFI under ad-hoc signing** — measured 2026-08-15, under both the `runtime`
  and `runtime,restrict` combinations, `DYLD_INSERT_LIBRARIES` still injects into the main
  process and all three helpers, while VS Code, another Electron app (Developer ID + the
  same flag), blocked the same probe; (b) ad-hoc's designated requirement is bound to the
  cdhash, so every `pnpm package` mismatches the keychain ACL and pops one more
  authorization dialog, training people to click allow on sight. The two entitlements
  needed have already been verified: copy them over. See
  [`design/2026-08-15-hardened-runtime.md`](design/2026-08-15-hardened-runtime.md).
### Deliberately not doing (recorded so the next round does not reopen the discussion)

- **Startup time optimization**: the measured median hot start is 518ms; the hard limit is
  1.5s, three times the headroom. The ACP agent is launched lazily and is not on the
  startup path.
- **Splitting driver-host into per-driver bundles / lazy loading**: `driver-host.js` is
  2.0MB minified, but that process is only spawned when the user clicks "Connect"; the
  overhead is masked by the database handshake and is not on any measured hard limit.
- **Changing the driver registry from `Partial<Record>` to a full `Record`**:
  `bus/__tests__/driver-registry.test.ts` already asserts "every manifest must have a
  corresponding spawn line"; the type change would only relocate the same guarantee, and it
  would cost "a package can be written completely before it is listed." **This decision
  still holds, but both ends of it have been renamed** (2026-08-07): the thing is now
  `driverRegistry()` in `connections/registry.ts` (a function, not a constant), and what
  the assertion checks against has changed from the now-deleted `DRIVER_CAPABILITIES` to
  `driverManifests()`. That test's header comment references **this section** back; read it
  before renaming it.
- **Real screen-reader a11y verification / choosing a LICENSE**: see §11.2 — these two are
  not things an agent should do on someone's behalf.

## 11. Technical-debt ledger

TODOs written here instead of scattered through the code: the repository's source has no
`TODO` / `FIXME` / `XXX` anywhere at all, the debt all lives in documentation and comments —
do not expect grep to find it.

### 11.1 Dead exports — ✅ Cleared (second round, 2026-08-15)

The criterion: **across the whole repository (tests included), the declaration site is the
only reference**. All were deleted when M6 was closed out; after the deletion, typecheck
showed zero errors and tests were all green.

**This column grows back on its own** — after the M6 clearing, 18 more had accumulated by
2026-08-15; see the second table below. The criterion is unchanged, and so is the scanning
method (take each `export`'s name, count its occurrences across the whole repository, 1
occurrence means dead).

#### Second round (2026-08-15, 18)

| Symbol | Location | Disposition |
|---|---|---|
| `AgentEndpointApi` / `AgentMcpServerInput` / `AnyCommandEnvelope` / `UnplacedPolicy` | `core/commands.ts` | ✅ Deleted (all were type aliases coined in passing next to a schema; the schema itself is still in use) |
| `IpcChannel` / `CommandInvokeMessage` | `core/ipc.ts` | ✅ Deleted |
| `FilterOp` | `core/capability.ts` | ✅ Deleted |
| `PeekErrorI18n` | `core/errors.ts` | ✅ Deleted |
| `ViewStateOf` | `core/workspace.ts` | ✅ Deleted |
| `PackageToolMeta` | `core/mcp-tools.ts` | ✅ Deleted |
| `PackageHostInbound` | `core/package-host.ts` | ✅ Deleted, and the comment was changed — see below |
| `EffectIntentType` | `main/bus/intents.ts` | ✅ Deleted |
| `registeredViewKindNames` | `drivers/viewKinds.ts` | ✅ Deleted |
| `readDrag` | `renderer/components/dragStore.ts` | ✅ Deleted |
| `OTHER_ID` | `renderer/components/chat/QuestionPrompt.tsx` | ✅ Deleted (along with the `OTHER_OPTION_ID` import, which only a comment still referenced) |
| `useSettingsSection` | `renderer/state/settingsDialogStore.ts` | ✅ Deleted |
| `detachResultPort` / `cancelResultStream` | `renderer/state/resultCache.ts` | ✅ Deleted |

Three points worth recording separately:

- **Comments lie, and they tell the same lie.** The header comments on
  `registeredViewKindNames`, `readDrag`, and `OTHER_ID` all say "for the tests" / "Exported
  for the tests," and the scanning criterion **includes tests** — no test used any of them.
  "Exported for the tests" is the most common disguise for a dead export in this repository;
  the next scan should doubt that sentence first.
- **`PackageHostInbound` is the price of symmetry.** It is paired with
  `PackageHostOutbound`, and the comment said "both directions are named because it is what
  main's process wrapper imports" — only Outbound actually is. After deleting Inbound the
  comment was changed too; it now speaks only of Outbound, with this history left in the
  comment.
- **What `detachResultPort` deleted was a cleanup path that was never wired up.**
  `attachResultPort` has a real call site in `renderer/state/sync.ts`; detach did not: when a
  connection disconnects, the port sitting in `portsByConn` is left untouched, and it only
  gets swapped out when **the same connId attaches again** (the attach branch in
  `resultCache.ts` closes the old one itself). So the current state is "every connId that has
  ever disconnected leaves behind one dead MessagePort entry" — small in size, but it does
  accumulate. **What needs fixing is the call site, not keeping the function around as a
  placeholder** — if this is actually done, the original 12 lines are in `git show`, and it
  only counts if they are written together with their call site.

#### First round (M6)

| Symbol | Location | Disposition |
|---|---|---|
| `requireBridge` / `BridgeUnavailable` | `renderer/bridge.ts` | ✅ Deleted |
| `chatTStatic` | `renderer/components/chat/i18n.ts` | ✅ Disappeared along with the file (chat i18n has been folded into `i18n/messages/`) |
| `focusTargets` / `panelIdsOf` | `main/mcp/ui-effects.ts` | ✅ Deleted (along with two orphaned imports, `collectPanels` / `ViewId`) |
| `sendResultPort` | `main/bus/ipc-main.ts` | ✅ Deleted (along with `MessagePortMain` / `ResultPortMessage`) |
| `isErrorMessageKey` | `core/error-messages.ts` | ✅ Deleted |
| `isPluralForms` | `core/messages.ts` | ✅ Deleted |
| `activeViewOf` | `core/workspace.ts` | ✅ Deleted |
| `makeCommandEnvelope` | `core/commands.ts` | ✅ Deleted |
| `CHUNK_TARGET_BYTES_MIN` | `core/chunk.ts` | ✅ Deleted |
| `throwPeek` | `db-postgres/errors.ts` | ✅ Deleted |
| `PG_TYPE_QUERY_BY_OID` | `db-postgres/type-catalog.ts` | ✅ Deleted |

⚠️ A past misjudgment, kept here as a counterexample: `CHUNK_TARGET_BYTES_MAX` /
`CHUNK_TARGET_ROWS_MIN` / `CHUNK_TARGET_ROWS_MAX` were once listed as dead exports — **they
are not** — `chunk.ts` itself uses them (`pickChunkRows`), and deleting them as dead code
would fail compilation outright. They are merely "unnecessary exports": in the same block,
`ACK_WINDOW`, `VALUE_PREVIEW_BYTES`, and `CHUNK_DEFAULT_ROWS` are all genuinely referenced by
other packages, only these three are not. This round changed that to **dropping the
`export` while keeping the constants**, and the comment now states that `pickChunkRows` is
the sole answer to "how big should the next frame be" — exporting the bare numbers is an
invitation for every driver to re-derive it on its own.
### 11.2 Known structural issues

- ~~**"Adding a database = one package + one line" is what the comment claims, not the
  fact**~~ — ✅ Fixed 2026-08-03. The header comment in `driver-host/entry.ts` has said this
  for a long time; an actual count comes to **15 places**, scattered across three packages, of
  which **7 places are in the frozen contract** (`capability.ts`'s `DRIVER_IDS`,
  `DRIVER_CAPABILITIES`, the config schema union, and the four redact / label / detail /
  identity switches), with another 3 in main, 3 in the renderer, and 2 in the build config.
  Worse, the 3 UI-side tables (the connection form, SQL dialect, MCP endpoint copy)
  **are not compiler-enforced** — `SqlEditor.dialectOf` has a `default:` fallback, and the
  missed branch in `summary.ts` only degrades to worse copy — so a new database can quietly
  end up with half its functionality missing. Now it is down to **7 places, each one line, 4
  of them compiler-enforced** (`DriverId` is a closed union). The mechanism is
  `DriverManifest` plus a sub-entry point that never touches the database client; see §4 and
  [`design/2026-08-03-driver-package-boundary.md`](design/2026-08-03-driver-package-boundary.md).
  **Addendum, 2026-08-11: those 7 places are gone too — it is now 0 places.** Packages install
  from `~/.peek/packages/`; adding a database requires changing not one line of this
  repository — what was measured is an `echo` fixture living outside the repository: run
  `packages.install` inside the **running app**, and it shows up in the connection dialog on
  the spot, connects, introspects, and scans rows. The 4 compiler-enforced places disappear
  once `DriverId` becomes open, and what replaces them is load-time validation (a manifest
  missing a field gets its load refused and is named, in `main/packages/loader.ts`) — from
  "it will not compile" to "it will not install"; both fail loudly, but the latter fails at
  runtime, and that is the price of this trade. **One exception, do not forget it**: when a
  package **contributes a view kind**, the function half of `ViewKindRegistration`
  (`describe` / `title` / `autoFetch` / `collectionRef`) is still compiled into
  `drivers/viewKinds.ts`, so neo4j's `graph` is a counterexample to "0 places"; the reasoning
  and the remaining steps are written in that file's header comment and in 2026-08-07
  §2.4bis(d). **The dangerous side of this exception is now closed** (2026-08-11): the
  compile-time half outlives uninstall, so the direction that actually goes wrong is
  **uninstall** — `tools/list` used to keep offering `expand_node` after neo4j was
  uninstalled, within that same session, in a new session, and even after a restart with the
  directory already gone. Now the "is it installed" filter is written in exactly one place,
  `definePackageContribution` in `drivers/contribution.ts`; all three tables (drivers / view
  kinds / MCP tools) derive from it, and a fourth kind of contribution cannot skip it even if
  it tries. **Everyone tests the install direction; the uninstall direction has no
  witness** — that is the common trait of this class of gap, see
  [`design/2026-08-11-package-contribution-roster.md`](design/2026-08-11-package-contribution-roster.md).
  Measured: the renderer chunk went 563,734 → 571,660 B (+7.9 KB, which is the form data
  itself), while driver-host actually dropped −153,640 B (core got hoisted into a shared
  chunk); grepping the chunk for twelve client-signature strings turned up zero hits. Along
  the way, a TypeScript fact worth recording: **`satisfies` does not preserve `labelKey`'s
  literal type** — what it provides is contextual typing, and a string literal annotated with
  a `string` context widens, while a sibling field in the same object whose context is a
  literal union, such as `type: 'text'`, **does not**. So the file reads completely normally —
  only that one field silently becomes `string`, and the check that depends on it still
  "passes" — over the empty set. Switched to a `const` type parameter (`defineManifest`).
  Three constructions that turn the check into a no-op are listed in its comment.


- **Column-width dragging used to lag one step behind** (fixed in M6): `DataGrid` caches a
  virtualized column array for memoized rows to reuse, and the cache key used to be built from
  "the column model's width", while what actually renders is the **virtualizer's measured
  value**, which lags the model by one commit. So the key for the render right after a measure
  did not change, and the correct measured value got dropped: dragging a column width would
  lag by one step — a drag through 110 → 200 → 44 → 110 ended up stuck at 44. Now the key is
  built from the virtualized column's own geometry (`columnWindowKey`). This defect reproduced
  identically on the TanStack Table version as well; it was not introduced by switching column
  models.
- ~~**When preload's `bootstrapMainWorld` fails, it degrades silently**~~ — ✅ Fixed
  2026-08-02. The degraded path itself is still there (it is correct: if the control plane can
  be saved, it should be saved), but now it speaks up: `PeekBridge` gained a **required**
  member, `dataPlane: 'ok' | 'degraded'`; both paths must each declare themselves, and the
  compiler guarantees there is no third path that quietly gets forgotten. The renderer reads
  it in `startErrorCollection()` and fires an error toast, which the existing toast
  subscription records into the error center (no extra `recordError` call, or the same thing
  would be recorded twice). Measured: after forcing bootstrap to throw and rebuilding, opening
  the window produced 1 toast plus a status-bar `⚠ 1 new`, and after recovery, `dataPlane:
  'ok'` and zero toasts. In passing, this also fixed a wrong comment in `core/ipc.ts` — it
  said degradation makes those optional members disappear, but in fact they go through plain
  `ipcRenderer.invoke`, and the degraded path implements all of them; the only thing that
  actually disappears is `onResultPort`.
- ~~**`KeyValueWindow` is still a flat bag across the process boundary**~~ — ✅ Closed out
  2026-08-02, **but the conclusion is the opposite of what was originally written here**. The
  original line said "to unify it, just change `driver-rpc.ts` to call
  `keyValueReadOptions()`"; doing that would get it backwards: what `driver-rpc.ts` produces is
  the **on-the-wire shape** `KeyValueWindow`, and its flatness is deliberate (cross-process
  JSON, which the compiler cannot police), while `keyValueReadOptions()` is already called in
  the correct place — `core/driver-host.ts:593`, on the driver-host side. So the "flatten it"
  half is **not being done**. Clearing it up turned up what was actually broken, and it was a
  different matter: `KeyValueWindow.shape` **is connected on neither end** — `keyWindow.ts`
  reads `result.value.shape` to pick a field but never sends it, and `readKeyValueWindow` never
  parses it either. So `keyValueReadOptions` always takes the "infer from whichever field is
  filled" branch, and the stronger check named in the comment, "validate against `shape`",
  never ran in production. Of the five pageable shapes, two were inferred wrong: a stream that
  only fills `cursor` was judged `map`, and a sortedSet that only fills `offset` was judged
  `list` (the data itself was not wrong — the driver ultimately dispatches by the real TYPE —
  but that boundary check was a no-op). Two lines were wired up to fix it, see
  [`design/2026-08-02-keyvalue-window-shape.md`](design/2026-08-02-keyvalue-window-shape.md).
- ~~**`packages/core` has no test script**~~ — ✅ Added 2026-08-02. The previous round's PG
  fixture fix let `pnpm -r test` run to completion for the first time, and for the first time
  made it visible that **`packages/core` was not in the list**: the frozen contract that all
  five other packages depend on, and the command `pnpm --filter @peek/core test` did not exist
  at all. Now it does, with 56 test cases. The scope of the move turned out larger than what
  was originally recorded here: filtering by "is the thing under test in core," **five** files
  are pure core-contract tests scattered across three directories, and among them
  `drop-zone.test.ts`, which tests `layout-dnd.ts`, has its **entire module** living in core,
  yet the test itself sat in `renderer/components/__tests__/`. `driver-errors.test.ts` stayed
  in desktop, and that is the **correct** location, not a compromise: it imports four drivers
  at once, and moving it into core would invert the dependency graph. The price is that core's
  tsconfig split into two — `types: []` is a real constraint (production code is not allowed
  to see the node runtime; measured: adding one line of `process.env` alone fails the compile),
  and lifting that so tests can see `node:test` incidentally sanctions `process.env` appearing
  in `errors.ts`. See
  [`design/2026-08-02-core-test-script.md`](design/2026-08-02-core-test-script.md).
- ~~**Inside the agent, an error gets computed and then thrown away**~~ — ✅ Fixed 2026-08-15,
  and the shape of this one is worth recording on its own. `classifyAgentEvent` computes a
  `reason` for every event it drops — eleven of them, including `unknown:${type}`, meaning
  "the SDK or the model sent a shape this build does not recognize" — and then `loop.ts` throws
  away all eleven with a single `case 'ignored': return` line. **Note this is not "forgot to
  log it" — the information was already generated, reached the exit, and was thrown away
  there**: the header comment in `events.ts` states in black and white that "an unrecognised
  shape is **reported**," and it is not. The symptoms were all silent — a turn of conversation
  ends empty, the model claims to have called a tool and the transcript has nothing for it —
  and the cost of fixing it was writing an already-computed string into a sink that already
  existed. Two more places share the same shape: ACP's `noise` check **drops stderr at the
  point of collection** (the last few lines before an agent crashes are often exactly what is
  in that discarded batch), and `toParameters` silently falls back to an empty schema (its own
  comment argues the danger of silently dropping a tool, and then this very fallback is itself
  silent). The judgment of severity level **stays in the file that recognizes the event**
  (`AgentEventOutcome` carries a `level`), rather than being guessed at the call site from the
  `reason` string — the latter breaks the moment something gets renamed, and breaks silently.
  The test that asserts a level once for each of the eleven branches has its real value not in
  "is the level correct," but in **being a checklist that has to change together with
  `classifyAgentEvent`**: add a twelfth branch without deciding how loud it should be, and that
  test turns red. See
  [`design/2026-08-15-logging-and-audit.md`](design/2026-08-15-logging-and-audit.md) §1.1ter,
  §3.7.
- **`ConnectionManager` can only be unit-tested with stubs**: it depends on electron via
  `host-process.ts` / `port-broker.ts`, and importing those two modules inside `node:test`
  blows up. `manager.ts` itself only type-imports electron, so once those two are swapped for
  stubs the real implementation is testable — `bus/__tests__/deadline-escalation.test.ts` does
  exactly this. Two historical obstacles have been cleared: `package.json`'s test glob now
  covers `src/main/connections/__tests__`; the TypeScript parameter properties in
  `host-process.ts` / `port-broker.ts` (the one syntax strip-only type erasure does not
  support, which throws `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` outright) have been rewritten as
  explicit field assignments, so what now gets reported is the true statement "electron is
  unavailable," not a syntax error pointing at a file you never meant to import.
  ~~The real end state is giving these two modules an electron stub.~~ ✅ Done on 2026-08-02:
  the stub went from an **inline JS source string** (injected by the `load` hook — just a blob
  of text as far as `tsc` is concerned) to a real module under `connections/__tests__/`,
  redirected there by the `resolve` hook. The key gain is that `call()` is now typed against
  `HostRpcMap` — under the old approach, adding one required field to `HostResult<'connect'>`
  left the stub still returning the old shape while **the tests stayed green**, exactly the
  species recorded in §9.1 as "the stub and the code under test corroborating each other and
  being wrong together." Measured: adding a required field to `HostResult<'connect'>`, the
  first compile error now lands on the stub file.
  Separately, the surface `manager.ts` uses is 7 + 3 members; the stub file gives it a name,
  and **the real class is asserted against the same interface too** (the reverse does not
  work: the real class has `private` fields, and class-to-class assignment does not go
  through; assigning to an interface that lists only public members does). The hidden channel
  `globalThis.__peekStubCaps` was removed along with it. See
  [`design/2026-08-02-connection-manager-stubs.md`](design/2026-08-02-connection-manager-stubs.md).
- ~~**`@tanstack/react-table` is still in `package.json`'s dependency table**~~ — ✅ Removed on
  2026-08-02. The built bundle size did not change, as expected (rollup had already
  tree-shaken it out). While at it, the `column-model.test.ts` assertion that only scanned
  `DataGrid.tsx` was extended to scan the dependency table too — the original assertion only
  looked at one file, and a dependency nobody removes is an open invitation for somewhere else
  to re-import it.
- ~~**The PostgreSQL test database is not self-provisioned**~~ — ✅ Fixed on 2026-08-02.
  `postgres.test.ts` and `host.test.ts` used to assert against three tables under the
  `public` schema of some business database on some machine, while `PEEK_TEST_PG_URL`'s
  fallback value pointed at the **empty** `postgres@localhost/postgres` — the default path was
  itself the failure path. The underestimated consequence: `pnpm -r test` runs in topological
  order, so **the entire command broke off right here**, and not one package after it ever
  ran. Now `__tests__/fixture.ts` uses a bare `pg.Client` (the driver issues
  `SET TRANSACTION READ ONLY` on every transaction, which DDL cannot get past) to create
  tables in its own schema, with schema names fixed per test file (`peek_test_pg` /
  `peek_test_host`) rather than random — a `before` hook that drops then creates lets
  leftovers from a crash heal themselves, needs no cleanup logic, and so does not accidentally
  kill a concurrent run. The acceptance test is "it still passes against a swapped-in empty
  database"; see
  [`design/2026-08-02-postgres-test-fixture.md`](design/2026-08-02-postgres-test-fixture.md) §4.
- **qdrant's per-collection browse refinement does not reach the renderer**:
  `ViewSummary.browse` carries only a kind-level answer (`workspace.ts` fills it with
  `collectionBrowseStyle(v.ref)`), while the `sortableColumns` in
  `CollectionSchemaInfo.browse` needs a round trip through `describeCollection` to obtain.
  The stopgap is already landed: `browseControls.ts` answers `sortable: false` across the
  board for `vectorCollection`, because the table view draws the fixed projection `id` +
  `payload`, and those two names can never be payload index keys — meaning that column header
  is guaranteed BAD_REQUEST under any configuration. Sorting by a specified index key through
  MCP `view.update` is unaffected. The full fix = browse cached through main into
  ViewSummary, with DataGrid graying out columns individually against an allowlist.
- **The remaining gap in read-only is stored procedures**: MySQL resets the transaction
  access mode on every checkout, which blocks every statement the client itself can send; it
  cannot block a stored procedure that already exists in the database and opens its own
  read-write transaction internally (a single `CALL` is enough). The only way to close it is
  an account with no write privileges.
- **a11y semantics are only asserted by unit tests, never exercised against a real screen
  reader.** This one needs a person running VoiceOver by hand; an agent doing it would not
  mean anything. The 2026-08-02 legibility baseline
  ([`design/2026-08-02-ui-legibility-baseline.md`](design/2026-08-02-ui-legibility-baseline.md))
  added two more ARIA attributes (the toast's `role="alert"`, the permission panel's
  assertive live region), again propped up by nothing but DOM assertions — **the debt only
  grows; it never shrinks.** The half that can be checked automatically has already been
  filled in: contrast and the type-size floor are now locked by
  `renderer/__tests__/theme-contrast.test.ts` and `type-scale.test.ts`, and will not quietly
  drift back to 2.5:1 and 9px. The control spec from the same day also added
  `data-peek-action` as a stable identifier for icon buttons, again propped up by nothing but
  DOM assertions.
  **The half that can be checked automatically has grown further still** (as of M8):
  `render-probe` renders against the real built app and **reads pixels back from the
  framebuffer** — contrast is calibrated against 8 reference samples (covering alpha,
  `opacity`, transparent ancestors, and nested fade groups), and the `:hover` / `:active` /
  `:focus` states are each entered and re-read, with hit testing confirming the button is
  actually reachable. What makes this stronger than a source-level assertion is that it sees
  the result **after compositing**. **But it is not a screen reader**: it measures what is
  visible, and reading order, role announcements, and focus traps still have no witness. The
  debt on this one has not shrunk.
- **The control layer is built, the migration is complete** (2026-08-02, with the primitive
  checklist updated per 08-03 / 08-13): `renderer/ui/` had two primitives at the time —
  `Button` and `Segmented` — plus a single `spec.ts` source of truth and a set of assertions
  that nail the spec down in CI. 87 bare `<button>` elements have been migrated, leaving
  `MIGRATION_LEDGER` with only `TreeView.tsx` (stuck on someone else's uncommitted changes).
  This ledger **can only get shorter**, but "no adding new files to it" cannot be checked
  mechanically (a new file is not on the ledger to begin with, so adding it there is
  indistinguishable from a legitimate mid-migration state) — it is enforced by a person.
  **The migration overturned the ledger's own premise**: not every `<button>` should be a
  `<Button>`. The remaining 5 are menu items, disclosure headers, and one tab — they need
  button **semantics**, not anything from the control layer — and now belong to
  `NOT_CONTROLS`, each entry required to state a reason and the element count.
  There were four **primitives not yet built** on the list at the time, with the use count
  counted, not guessed (this is also the reason the migration was finished before designing
  them). Two are now done:

  | Primitive | Use count at the time | Current status |
  |---|---|---|
  | `<Menu>` | 3 menu-item sites | ✅ 2026-08-03. 2 of them removed; the `AttachmentBar` site is still exempt, because it anchors to a **button** while `<Menu>` anchors to a **point** — element anchoring was deliberately deferred, not invented for one caller |
  | `<Field>` | 18 form-element sites | ✅ 2026-08-13, landed as four exports from `Form.tsx` (`Form` / `FormRow` / `FormHint` / `FormActions`). It also turned the `.form-row` **class-name convention that nothing actually executed** into an API, moving hint alignment from arithmetic to layout |
  | `<Disclosure>` | 2 disclosure-header sites | ❌ Still does not exist |
  | `<Dialog>` | 4 modal sites | ❌ Still does not exist, behavior covered by `useModalDialog` (`ValueModal` / `ConnectDialog` / `SettingsDialog` / `ConsentDialog`) |

  `PRIMITIVES` is therefore three files (`Button` / `Segmented` / `Menu`) — a primitive must
  render a real element, so their own bare `<button>` elements are on neither the migration
  ledger nor `NOT_CONTROLS`. See
  [`design/2026-08-02-control-spec.md`](design/2026-08-02-control-spec.md) §2.9.1,
  [`design/2026-08-02-segmented-control.md`](design/2026-08-02-segmented-control.md),
  [`design/2026-08-03-context-menu-primitive.md`](design/2026-08-03-context-menu-primitive.md), and
  [`design/2026-08-13-settings-form-primitives.md`](design/2026-08-13-settings-form-primitives.md).
- **`data-peek-exposure` currently has no consumer**: control spec §2.6 defines the
  `human-only` / `agent-ok` boundary and pins down with a test that "a permission-prompt
  button is always human-only," but the MCP tool that reads it does not exist yet. This is
  **deliberate** — reserving the interface and settling the boundary first beats half a
  feature. When layer B (an agent clicking buttons) actually gets built, this is the entry
  point, not a patch.
- **Three batches of manual verification were written down but never walked** (counted on
  2026-08-13 while aligning this document). Every batch is a set of steps explicitly listed
  in a design document, every one is "the half automation cannot reach," and **nothing was
  recording that they are still owed** — this entry is that record:

  | Source | Steps owed | Why it cannot be reached by automation |
  |---|---|---|
  | `2026-08-13-permission-mode-takes-effect.md` §4 | 5 | **This is the most urgent batch.** The wiring in `chat-host.ts` has no unit test of its own; that document states outright that "the wiring falls to manual-verification step 2" — meaning this fix is currently proven only indirectly. Testing it requires the real manager, store, and effect loop all present at once, and `main/__tests__/` today has only the one hardening file |
  | `2026-08-13-settings-form-primitives.md` §4 | 8 | The probe can reach the connection dialog but not settings — every settings section needs `settings.read` before it has any content, and there is no preload behind the probe page |
  | `2026-08-12-main-only-parse-out-of-the-window.md` §4.5 | 2 | Installing/uninstalling a package to see the copy the user sees, and the error for a broken `peek-package.json` |

  The document behind the second batch points out a way out in passing: adding a check to the
  probe for "all second-column elements within the same `form-grid` share a left edge" would
  turn its step 1 into something that runs on every build. By the repository's own rules that
  is a separate change with its own design space (a new pane or a new check, how to feed it
  data) — **it should go through the documentation process on its own**.
- ~~**`LICENSE` is still TBD.**~~ — ✅ settled 2026-08-24: **MIT**, with `LICENSE` in the tree and
  the License section of both READMEs pointing at it.
