# The data editor: first work out what the "read-only" guarantee costs

> 2026-08-03. `docs/design/2026-08-03-driver-package-boundary.md` §2.6 left the
> data editor a one-sentence placeholder: "add a `mutate` capability, the write
> spelling goes into the package, the editing interface follows the kind.
> **Not this round.**"
>
> This document is the precondition for making good on that sentence. Before
> touching anything, the whole write path was swept, and the conclusion is that
> **the sentence understates the problem**: it treats writing as one more row in a
> capability table, whereas what actually has to move is a **guarantee** that is
> already delivered, already written into the README's feature table, and already
> watched by tests against real servers.
>
> **This document implements no write operation.** What it produces is: a list of
> conflicts, a list of costs, and a staged scope proposal. §5 is the three
> decisions a person has to make.

---

## 1. What this fixes

### 1.1 Today: read-only is not "writing has not been done yet", it is a guarantee that was built

This is the foundation of the whole document, so the evidence goes first. peek's
read-only is **backed by the server**, and the client parses not one statement:

| engine | mechanism | location |
|---|---|---|
| PostgreSQL | `BEGIN READ ONLY` on every cursor | `db-postgres/src/cursor.ts:137`, and the two degraded reopen paths `:188`, `:203` |
| MySQL | every connection checkout runs `['ROLLBACK', 'SET SESSION TRANSACTION READ ONLY', …]` | `db-sql/src/mysql/dialect.ts:101`, applied at `backend.ts:453` (both `exec` and `stream` go through it) |
| SQLite | `PRAGMA query_only = 1` re-asserted before every `prepare`, plus the read-only open flag | `db-sql/src/sqlite/backend.ts:281` (`assertQueryOnly`), call sites `:291`/`:314`; the flag at `:384` |
| Redis | no `tabularQuery` capability; the session only sends read commands, and there is **no general `sendCommand` outlet** | `db-redis/src/manifest.ts:42` |
| Qdrant | the same, only sends `getCollection/getCollections/query/retrieve/scroll/versionInfo` | `db-qdrant/src/manifest.ts:50` |

**There is no keyword allowlist anywhere**, and that is a position written down
explicitly (`db-sql/src/session.ts:155`):

> Read-only is enforced by the connection, not by inspecting the text… parsing SQL
> to decide whether it writes is a losing game — `WITH … SELECT` looks like a write
> to a naive matcher, a stored procedure call looks like a read, and the database
> already has an answer that cannot be fooled.

`README.md:31` lists "No client-side keyword allowlist anywhere" as a feature.

**This guarantee is watched by tests against real servers** — but unevenly:

- MySQL: `__tests__/mysql-readonly.test.ts:114` tries the escape routes one by one
  (explicit read-write transactions, `INSERT…SELECT`, `UPDATE…WHERE`, `TRUNCATE`),
  asserting on a server-side `COUNT(*)` each time.
- SQLite: `__tests__/sqlite.test.ts:435` runs `PRAGMA query_only = 0` and then
  INSERT/UPDATE/DROP.
- **PostgreSQL: none.** Nowhere in `db-postgres/src/__tests__/` does anything
  attempt a write or assert that a write is refused. **The strongest link in the
  chain is the least tested one**, and it happens to be the link that is about to
  have a hole cut in it.

### 1.2 Cracks that already exist (not caused by this round, but a write feature magnifies them)

- **Stored procedures** (`README.md:463`, `PLAN.md:573`): MySQL's `CALL` is a
  read-shaped statement, and the write happens on the server side. The only defence
  is an account with no write privileges. Known, recorded.
- **SQLite's `readOnly` checkbox can be turned off over MCP**: the `connect` tool
  reuses `commandSchemas['conn.open']` wholesale (`mcp/tools/connect.ts:13`), and
  `SqliteConnectionConfigSchema` exposes `readOnly?: boolean`. A model can open a
  writable handle, and all that stands in its way is `assertQueryOnly`.
- **In-memory SQLite is always opened read-write**: `sqlite/backend.ts:384`,
  `const readOnly = memory ? false : cfg.readOnly ?? true`.
- **`valuePeek` re-runs the user's statement outside any transaction**:
  `db-postgres/src/peek.ts:84` and `:169` call `pool.query()` directly, wrapping
  `src.text` into `SELECT * FROM (…)`. A subquery cannot be an INSERT, so this is
  not an outlet for typed SQL; but a volatile function inside the source SELECT
  runs here **without `READ ONLY` protection**. The documentation should not assume
  every path is read-only.

### 1.3 "Read-only, always." — the list of promises

The promises that would have to change, quoted verbatim (this is the conflict list
CLAUDE.md asks for):

| # | location | verbatim | audience |
|---|---|---|---|
| 1 | `renderer/i18n/messages/en/sidebar.ts:78` | `PostgreSQL, MySQL, SQLite, Redis or Qdrant. Read-only, always.` | users, the first-run guide |
| 2 | `renderer/i18n/messages/zh-CN/sidebar.ts:65` | `……始终只读。` | the same |
| 3 | `main/mcp/instructions.ts:85` | `Every tool is read-only data browsing (this first version does not write data back).` | **every model that connects** |
| 4 | `README.md:19` / `README.zh-CN.md:15` | `all data access is read-only` / `所有数据访问都是只读的` | readers |
| 5 | `README.md:31` / `README.zh-CN.md:26` | the whole feature-table cell, including "No client-side keyword allowlist anywhere" | readers |
| 6 | `README.md:514` / `README.zh-CN.md:447` | `write operations (the read-only path stabilizes first, then a confirmation mechanism)` | readers |
| 7 | `PLAN.md:16` | a non-goal: `数据编辑写回（先只读，写操作留接口后加）` | ourselves |
| 8 | `PLAN.md:421` | `写操作……**条件接近但未到**……需要一套独立的确认与回滚语义` | ourselves |

Number 3 matters most: it is the first paragraph of prose every MCP client and
embedded agent reads, and it becomes false the day a `data.mutate` tool ships.

**A self-contradiction already in the tree, found along the way**:
`instructions.ts:85` says "every tool is read-only", while `run_query` labels
itself `readOnlyHint: false, destructiveHint: true` (`tools/run-query.ts:74`). The
annotations are saying the **interface** will change, the prose is saying the
**data** will not, and the model reads both answers at once. This should be fixed
whether or not the editor is built.

Number 6 needs care over its wording: what the README promises is "the read-only
path stabilizes first, **then a confirmation mechanism**". Which is to say **the
confirmation mechanism has to exist before the README changes**, not the other way
round.

### 1.4 Boundary (explicitly not done here)

- No write operation is implemented, no `mutate` capability is added, no
  `data.mutate` Command is added.
- No promise text is changed — not one word until §5 is decided.
- No design for Redis's six shape editors, and none for Qdrant's upsert (reasoning
  in §3.2).

---

## 2. The cost list: five structural problems that have to be solved first

Ordered by "leaving this unsolved corrupts data", not by effort.

### 2.1 Addressing: the one safe address shape exists, and nobody has ever built one

`ValueRef` has a `relationCell{collection, pk, column}` arm
(`core/capability.ts:429`) — exactly the shape `UPDATE … WHERE pk` needs. It is
**consumed** by `db-postgres/src/peek.ts:187` and `db-sql/src/peek.ts:201`, and
**displayed** at `InspectorView.tsx:451`.

**But no production code anywhere in the repository constructs one.** Zero
producers outside tests. Not the renderer, not main, not MCP.

And the renderer cannot reach an authoritative source for primary keys:

- **`PeekBridge` has no `describeCollection`** (`core/ipc.ts:283`), only
  `introspect` (child nodes only), `peekValue` and `getKeyValue`.
  `introspect.describe` can only be issued from main (`manager.ts:306`), and the
  callers are chat-host and the ACP context resolver.
- The renderer's **only** knowledge of primary keys is `ColumnDef.primaryKey` on
  the frame-0 schema, whose sole consumer today is a tooltip string at
  `DataGrid.tsx:565`.

Three consequences, each of which bounds the first version's scope:

1. **Cells in the query view cannot be addressed safely.** `columnHints` is only
   passed in from `scan()` (`db-sql/src/session.ts:225`); a `tabularQuery` result
   **carries no columnHints**, so cells in the query view have no primary key.
2. **Redis / Qdrant scans never set `primaryKey`.**
3. **`columnHints` swallows every failure** (`db-postgres/src/introspect.ts:349`,
   "Not worth failing over") — one failed describe silently produces a scan schema
   with no primary-key markings at all. For reading, that costs a tooltip; for
   writing, it makes "thought there was no primary key" indistinguishable from
   "there really is no primary key".

**A table with no primary key has no fallback.** Grepping the whole repository for
`ctid` returns nothing. PostgreSQL's `ctid` is a ready-made answer (stable within a
snapshot, unstable across `UPDATE`/`VACUUM FULL`), and `indexes` is already
populated (`introspect.ts:321` reads `indisunique`, and a unique index can stand in
for a primary key), but neither is used, and `CollectionSchemaInfo` has no field
today that can express "this is a substitute address, not a real primary key".

### 2.2 Truncation: the value on screen may be only the first 4KB

`TruncatedValue` (`core/chunk.ts:104`) carries a `VALUE_PREVIEW_BYTES` (4KB)
preview. Worse, **"fetch the full value" may also be only a prefix**: all three
fetch points pass `length: VALUE_PEEK_MAX_BYTES`, `PeekedValue` carries an `eof`
flag, and the UI says "incomplete" only on the base64 branch
(`ValueModal.tsx:126`).

**Submitting the text on screen back = silently truncating a 10MB value to 4KB.**
The only things distinguishing "this is the value" from "this is a prefix" today
are `isTruncatedValue()` and `PeekedValue.eof`.

There is a read-your-own-writes hazard as well: `TruncatedValue.ref` is
**optional**, and when it is missing `ValueModal` falls back to a `resultCell` ref,
which a driver resolves by **re-running the source statement**
(`db-sql/src/peek.ts:26`) — and the row may have changed since the scan.

`error.value.gone` (`core/error-messages.ts:139`, "The value is gone (the row was
deleted or the result set changed)") shows the read path already knows this failure
mode; the write path needs the same concept as a **precondition**, not merely as an
error code.

### 2.3 The grid cannot carry inline editing (as it stands)

`DataGrid.tsx` is hand-virtualized, and its performance rests on one explicit
invariant (`:65`): "rows are memo components, cells are plain divs rather than
components". Specifically:

- **The selected cell is nearly inert**: `selected: {row, col}` holds **row and
  column indices into the result set**, not a primary key and not a column name.
  Two writers, three readers, and its only effect is one CSS class and a fallback
  for ⌘C. The comment (`:128`) claims it "drives the value inspector" — **it does
  not**.
- **The keyboard model is pure scrolling**: no `ArrowLeft`/`ArrowRight`
  (horizontal is native `scrollLeft`), no `Enter`/`F2`/`Tab`, no type-to-edit. The
  whole grid is **one tab stop** (`tabIndex={0}` on `.grid-wrap`), and cells are
  divs with no `role` and no `tabIndex` — the accessibility tree has no cells in it
  at all.
- **Cells carry no event handlers**; clicks work by row-level delegation plus
  reading the column number back out of `data-col` (`:713`). Putting an `<input>`
  in a cell makes the delegating handler fail to read `data-col` and return early.
- **`onKeyDown` has no text-entry exemption**: `useGlobalKeys.ts:208`'s
  `isTextEntry` only exists at the global layer. An input inside a cell bubbles up
  and `Space`/`ArrowUp`/`PageUp`/`Home` are all `preventDefault()`ed into scrolling
  — **typing a space in a cell pages the grid**.
- **Virtualization silently unmounts the editor**: rows render only
  `renderFirst…renderLast`, and columns are virtualized by TanStack Virtual with
  `overscan: 3` — **scroll three columns sideways and the cell is unmounted**,
  taking the React-managed input, its focus and its uncommitted text with it,
  emitting no event. And the grid has no `scrollIntoView` anywhere (`:282` is
  actively pinning `scrollTop` back to 0).

Three further forces can destroy an editor mid-edit: a change of `resultId` resets
`selected` (and TableView's refresh / paging / sorting all send `refresh: true` and
mint a new result), LRU eviction makes the `getCell` beneath the editor start
returning placeholders, and a streaming `dataVersion` forces a re-render.

**There are only two honest options**: the editor is an absolutely positioned
sibling of `.grid-surface` (positioned from `geom`, closed by any scroll or
refresh), or editing happens in a modal rather than in the cell.

Incidentally: the `ui/` control layer today has only `Button` / `Segmented` /
`Menu` / `Gallery`, **no text input control at all**, and `ui/CLAUDE.md` forbids
inventing a style class in place.

### 2.4 The Command Bus cannot hand a value back

`runIntent` is typed `Promise<void>` (`bus/effects.ts:58`), and not one of the six
cases hands a value back to `CommandResult`. `ResultService`'s contract states
plainly that it "only delivers the request to the driver host, and resolves when it
is **accepted**" (`bus/deps.ts:26`).

So "N rows affected" has no ready channel. Two postures:

- **Copy `connect`**: the effect writes its result into the store and `finalize`
  reads it back (`effects.ts:68` + `handlers/conn.ts:71`) — meaning write results
  enter Workspace state.
- **Give `runIntent` a return value** — which means changing `runIntents`'s loop,
  `applyIntentFailure` (`effects.ts:138`) and `fallbackCodeOf` (`:356`), three
  exhaustive switches.

There are also three pieces of wiring where missing one fails silently
(`core/driver-host.ts`): the `HOST_METHODS` permit table (`:125` — for a method not
in the table, `asInbound` returns null outright and **sends no response at all**,
leaving the main side hanging until the 30s `rpcMs` timeout), `dispatch`'s switch
(`:495`), and `assertSessionHonoursCapabilities` (`:666`, **a hand-written list**;
missing an entry means a driver that "declares mutate without implementing it" is
not caught at connect time).

And: **the timeout machinery hangs off the kind of result** (`timeouts.ts:208`
maps only query/scan/vectorSearch, and `deadline.ts` books by resultId). A write
that produces no resultId **falls outside the whole deadline system**, leaving only
`rpcMs`.

### 2.5 After a write, nothing will become correct

- **main holds not one row of data** (`core/ipc.ts:76`), so main **cannot
  invalidate a range of rows**; it can only prompt a fresh fetch. The existing
  mechanism is not invalidation, it is `autoFetch` starting a new result
  (`handlers/shared.ts:372`).
- **There is no index of "which views are looking at this table"**:
  `Workspace.views` is a flat record, and finding the affected views from a
  `CollectionRef` requires a full scan. "Which views does one write have to
  refresh" has no answer in the code.
- **The driver-side cache of the namespace tree is essentially uninvalidatable**:
  all three drivers have `invalidateIntrospectCache()`
  (`db-postgres/src/session.ts:319` and so on), with **zero callers repository
  wide**. And the `refresh` flag breaks halfway down — it is on the wire
  (`ipc.ts:166` → `driver-rpc.ts:95` → `manager.ts:294`), but
  `DriverHostRuntime.dispatch` drops it (`driver-host.ts:513`), because
  `DriverSession.listChildren(parentId)` has no `refresh` parameter in its
  signature at all. **Any write that changes a schema is invisible until a
  reconnect.** This is a pre-existing hole, and a write feature runs straight into
  it.

---

## 3. Scope proposal

### 3.1 Writability is a **connection-level** property, not a button in a view

This is not a preference, it is forced by the facts in §1.1: read-only is backed at
the **connection/transaction level**, not at the statement level. `BEGIN READ ONLY`
is one line at the head of every cursor, `SET SESSION TRANSACTION READ ONLY` is one
line at every checkout — "just write this once" has nowhere to live in that
machinery, and the only thing expressible is "this connection is writable".

So:

- `ConnectionConfig` gains an **explicit writable switch**, off by default.
  SQLite's `readOnly` checkbox is already a precedent for this shape (and precisely
  for that reason, "Read-only, always." already overreaches today).
- A writable connection gets a **permanently visible marking** in the sidebar and
  the status bar. There is no read-only badge anywhere in the renderer today
  (checked: `SqlEditor.tsx` and `DataGrid.tsx` do not mention it), so adding one
  means adding it in both places.
- **Keep the "do not parse statements" principle**: a writable connection is not
  "UPDATE has been allowed through", it is **no read-only transaction is opened**.
  Not one allowlist entry is added, and `README.md:31`'s sentence can stay exactly
  as it is.

### 3.2 The first version does one thing: relation tables with a primary key, a single cell, a single-value UPDATE

In scope:

- Drivers: **postgres / mysql / sqlite** (all three share `UPDATE … WHERE pk`, and
  `quoteIdent` / `qualifiedName` / `ParamList` / `renderWhere` are all reusable;
  `peek.ts:186`'s `resolveRelationCell` is about 20 lines away from being an
  UPDATE's WHERE clause)
- Views: **only a collectionScan table view** (the query view has no primary key,
  see §2.1)
- Target: **a single cell**, in a table that **has a primary key**, whose value is
  **not truncated**

Out of scope, and each one needs its own refusal message (not a silent disable):

| what is refused | why |
|---|---|
| cells in a query view | no columnHints, so a `relationCell` cannot be constructed |
| tables with no primary key | no fallback address (§2.1); `ctid` is a possible follow-up, not the first version |
| truncated or peekable values | §2.2 — either force a full fetch and refuse on `!eof`, or do not go down this path at all |
| Redis | six shapes need six editors (`HSET`/`SET`/`LSET`/`ZADD`/`XADD`/…), and MULTI/EXEC **is not rollback** |
| Qdrant | only upsert, no transactions, no rollback |
| MCP write tools | §5, decision three |

**Why Redis/Qdrant are deferred specifically**: these two drivers' read-only today
is **purely constructive** — they simply have no write calls, and there is no
switch to turn off. Adding writes to them means building a write path from scratch
for a driver that has never had one, with no transaction to fall back on. The
relational databases at least have `BEGIN`/`ROLLBACK`.

### 3.3 Confirmation and audit: the "confirmation mechanism" the README promised

`PLAN.md:421` says "a separate set of confirmation and rollback semantics is
needed". What is already in the tree is less than one imagines:

**Usable**: `MenuItemNode.confirm` + `confirmNodes()` (`ui/menuModel.ts:93`) —
selecting an item that carries `confirm` does not execute it, but **replaces the
whole menu** with `[cancel, that action (danger)]`, cancel first so that it takes
focus. Its comment puts it well: this is not "two clicks", it is "the second click
lands somewhere harmless". "Forget connection" at `connectionMenu.ts:72` is the only
live example in the repository. And `ui/spec.ts`'s `caution` variant ("not
destructive, but the consequence outlives this moment") is exactly the register of a
write.

**Not usable — do not assume otherwise**:

- `ConfirmPair.tsx` has **zero callers** (even its CSS is orphaned). Its two old
  callers were deleted during the context-menu round on the grounds of "one path per
  thing". Its comment is still the best argument in the repository about confirmation
  semantics, but it is not a ready-made pattern.
- `context-actions/consent.ts` is **a one-time disclosure**, and its own comment
  says plainly that it "is not a permission system" and that "a dialog on every
  attachment will be clicked through mindlessly within a day, which is worse than no
  dialog". Writes want exactly the opposite — **confirmation every time**. What is
  reusable is the mechanism (versioned localStorage + external store + a dialog that
  **replaces** the menu instead of stacking on top of it) and the reasoning, not this
  particular gate.
- ACP's `requestPermission` is the only genuine human-in-the-loop point in the
  repository, but it governs **the embedded agent's tool calls**, cannot reach the
  Command Bus, and does not cover external MCP clients at all.

One lesson to copy from the `consent-gate.test.ts` incident: **the component
holding the pending action must render the confirmation itself**. Back then
`ContextMenu` called `onClose()` unconditionally and unmounted the hook holding the
pending attachment, so the gate **never fired** and the gesture vanished silently.

**Audit**: `bus/command-log.ts` is a 500-entry in-memory ring recording
`source/name/input/ok/…`, with **no consumer anywhere in the repository**; it is
never written to disk, and it dies with the process. Its file header claims it is
"by construction a replayable, testable recording of the session" — today it is
neither replayable nor visible.

For a read-only application, no persistent record is acceptable. **For writes,
`ResultMeta.origin`'s attribution chain (`workspace.ts:405`, written once at
creation and never changed afterwards) is the only evidence of "who changed the
data"**, and it lives inside two bounded structures: `Workspace.results` keeps 200,
and the command log is a 500-entry in-memory ring. Giving the command log a consumer
and persisting it is precisely the IPC channel `PLAN.md:405` **deliberately refused**
to add — writes change the arithmetic of that decision.

---

## 4. Trade-offs

### 4.1 Why not just "pop a permission dialog on every write" and be done

Because external MCP clients are not on that path at all. `mcp/executor.ts`
dispatches straight to the Command Bus, and the only access control is the bearer
token in `~/.peek/mcp.json` — **all or nothing: holding it means holding every
tool**. Adding a confirmation dialog to the UI constrains it not at all. So
"confirmation" and "who may write" are two separate questions, and §5 asks them
separately.

### 4.2 Why not rely on parsing statements (even just to "refuse DROP")

`README.md:31` lists "no client-side allowlist" as a feature, and
`db-sql/src/session.ts:155` argues why parsing must lose. Adding an allowlist
**reverses a position that was written down explicitly**, and after reversing it
still cannot stop stored procedures — losing the principle without buying the
guarantee. §3.1's connection-level switch does not touch this principle.

### 4.3 Why the first version does not do inline editing, and leans towards a modal

§2.3's three hard constraints (unmounted after three columns of horizontal scroll,
no text-entry exemption so a space pages the grid, a reset on any `resultId` change)
mean inline editing first requires giving the grid a cell keyboard model, plus a
`.grid-surface`-level floating editor, plus an `isTextEntry` guard. That is a round
of work on its own, and its risk is **losing the user's input**, not corrupting
data. A modal (reusing the existing `ValueModal` shape plus `useModalDialog`) lets
the first version concentrate its risk on the one thing that matters: whether the
write is correct.

Inline editing is worth doing, but **after the write path is proved correct**, not
alongside it.

### 4.4 Why not fill in PostgreSQL's read-only tests first and then talk

They should be filled in first — but they are not a substitute for this round, they
are its **precondition**. In §1.1's table pg is the only engine with no
"write refused" test, and pg is also the first driver a hole gets cut in. **Before
adding a writable path to pg, give it read-only regression tests on a par with
mysql's**, or once the hole is cut there is nothing left to prove the default path
is still shut. This is listed in §6.

---

## 5. Three decisions that need a person

None of these three is a technical choice; they are product and safety boundaries,
and code should not pick them on a person's behalf.

### Decision one: what "Read-only, always." becomes

Three options:

- **A. A connection-level switch, read-only by default** (§3.1). The wording
  becomes "read-only by default; a writable connection has to be turned on
  explicitly and is marked permanently". The README's feature cell is rewritten
  wholesale, and `instructions.ts:85` changes to speak per connection.
- **B. Stay read-only, and open the editor only for local SQLite files.** SQLite
  already has the `readOnly` checkbox, so this is the smallest change, and "people
  connected to a production database cannot be hurt by accident". The price is that
  the feature does not exist for most use cases.
- **C. Do not build the editor**, and clear §2's five structural problems as
  separate technical debts (three of which — `invalidateIntrospectCache` having zero
  callers, the broken `refresh` flag, pg's missing read-only tests — should be fixed
  either way).

### Decision two: whether MCP clients may write

`connect`/`run_query` are already exposed to any client holding the token, and the
token is all or nothing. If `data.mutate` goes onto MCP, **any process holding the
token can change the database with nobody in the loop**.

- **A. No MCP write tool in the first version**; writes can only originate from the
  interface. (Recommended: ACP's permission system does not cover external clients,
  so do not open this surface yet.)
- **B. Give MCP a write tool, but require a writable connection**, i.e. the model
  must first persuade a person to open one.
- **C. Give it as usual**, relying on `destructiveHint` and the audit.

### Decision three: how far the audit goes

- **A. Persist the command log and make it visible in the interface** (adding back
  the IPC channel `PLAN.md:405` deliberately left out).
- **B. Only add a "recent writes" list beside the error center**, not persisted.
- **C. Add nothing**, relying on `ResultMeta.origin` as it stands. (Not
  recommended: it lives inside a 200-entry cap.)

---

## 6. Prerequisite fixes — ✅ done 2026-08-03

These four are independent of §5's three decisions and should be fixed whichever
route is taken, so they were done first.

### 6.1 PostgreSQL's read-only regression tests (§4.4)

Added `packages/db-postgres/src/__tests__/postgres-readonly.test.ts`, 6 cases, run
against a real server, with every assertion landing on a count taken from an
**independent `pg.Client`** rather than on the driver's own report: direct writes
(including `INSERT…SELECT` / `TRUNCATE` / `DROP` / DDL), explicitly widening the
transaction (`BEGIN` + `SET TRANSACTION READ WRITE`, four times round), flipping the
session-level `default_transaction_read_only`, plus two control cases (reads still
work, and the connection is still usable after a refusal — the latter guards against
the false green of "everything afterwards fails because the transaction is aborted").

**It bites when tested**: replacing the three `BEGIN READ ONLY`s in `cursor.ts` with
`BEGIN` fails the three "write refused" cases while the three control cases still
pass — the failure lands on the guarantee itself, not on connectivity.

A precondition was fixed along the way: `errors.ts`'s SQLSTATE table **had no
`25006` (read_only_sql_transaction)**, and class `25` was not in the prefix switch
either, so a read-only violation fell all the way through to the generic backstop and
became an unclassified failure. It now maps to `CONFLICT` — matching sqlite
(`SQLITE_READONLY`) and mysql (`ER_OPTION_PREVENTS_STATEMENT`). Three engines
refusing the same write for the same reason should not produce three different codes.

### 6.2 + 6.3 The broken `refresh` chain and the zero-caller `invalidateIntrospectCache` (§2.5)

These two are the same thing: `refresh` has nowhere to land because
`DriverSession.listChildren` has no parameter to receive it; and
`invalidateIntrospectCache()` has no callers because nothing has any reason to call
it.

`listChildren(parentId, refresh?)` gained the parameter, `driver-host.ts` forwards
it, and the four drivers each wired it up (redis accepts and explicitly ignores it —
its keyspace tree is SCANned live every time and never had a cache).

**The scan report is inaccurate here, and was corrected during implementation**: it
said all three drivers have a "describe/hierarchy cache". In fact `PgIntrospector`
has only one table, `describeCache` (`introspect.ts:183`), and `listChildren` queries
`pg_catalog` every time; **only `db-sql` caches the hierarchy itself** (`schemaCache`
+ `relationCache`, `introspect.ts:119`). So staleness on postgres means **not seeing
a new column**, not not seeing a new table. The tests were written to that real shape
(the first version was written to the report's shape and was falsified on the spot by
its own guard assertion — without refresh, a new table still appeared immediately).

New case, `refresh clears the describe cache…`: look at a table → somebody adds a
column behind the driver's back → look again (must still be the old one, proving the
cache exists) → `listChildren(refresh: true)` → look again (must be the new one).
**It bites when tested**: delete the one `if (refresh === true)` line in the session
and the case fails.

A user-visible bug was confirmed fixed along with it: the tree's **⟳ refresh button
was half a no-op** — `TreeView.tsx:80` clears the renderer's cache and refetches with
`refresh: true`, while the driver answers from its own cache as before. MCP's
`introspect` tool also exposes `refresh` (`tools/introspect.ts:21`), equally a no-op.

### 6.4 The MCP instructions' self-contradiction (§1.3)

`instructions.ts`'s "Every tool is read-only data browsing" fights `run_query`'s own
`destructiveHint: true`. It becomes two sentences, separating the two senses of
"destructive": the data side explains that **statements are not inspected, and it is
the server that refuses** (naming `CONFLICT`, so the model does not treat it as an
obstacle to route around), and the interface side explains that `destructiveHint`
refers to things on the screen disappearing, not to data.

### 6.5 Verification points for the implementation round itself (not started)

- Assert against a **real server**: a writable connection can write, and a read-only
  connection **still** cannot (both directions have to be tested; testing only the
  first is testing nothing). §6.1's suite is the ready-made baseline for the second.
- A missing primary key, a primary-key value changed after the read (a write needs a
  precondition, not just an error code), a truncated value refused, a `!eof` peek
  result refused.
- After a write, watching the other views onto the same table become correct — or
  stating explicitly that they will not, and why.

Verification points for the implementation round itself (written into that round's
document; only the failure modes that must be covered are recorded here):

- Assert against a **real server**: a writable connection can write, and a read-only
  connection **still** cannot (both directions have to be tested; testing only the
  first is testing nothing).
- A missing primary key, a primary-key value changed after the read (a write needs a
  precondition, not just an error code), a truncated value refused, a `!eof` peek
  result refused.
- After a write, watching the other views onto the same table become correct — or
  stating explicitly that they will not, and why.
