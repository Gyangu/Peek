# Workspace persistence: close it, open it, the desk is still there

## 1. What this fixes

### Where things stand

Four things live under `~/.peek` today: `mcp.json` (endpoint and token),
`connections.json` (the connection book, with credentials in the keychain),
`settings.json` (MCP port, timeouts, zoom, agent settings), `chat/` (session
index and snapshots), `packages/` (installed database packages).

What is not stored is written at `main/config/index.ts:22`:

> Layout, open views, query text and results are still in memory only.

The README's feature table (line 41) and its "known limitations" (line 573) both
repeat that sentence, and M7's scope (README:588) lists "persisting layout and
open views". So this is not an oversight; it is something scheduled and not
reached.

`docs/PLAN.md:660` records why it has stayed undone:

> What is in the way is not storage, it is the `cursorToken` in `TableViewState`
> — it carries a driver identity today and is uniformly `BAD_REQUEST` across
> versions (deliberately: refusing beats returning the wrong rows). So restoring
> a layout has to be able to tell "view definition" from "in-session cursor", and
> store only the former.

### The problem

A restart means laying the desk out again: how the panels were split, which tabs
each panel had open, which tab was in front, the half-written SQL in a query
editor — all from scratch. The connection book survives, but the connection book
only answers "which machine do I connect to", not "what was I looking at".

### Boundary

**Doing**: putting the workspace's **definition** into `~/.peek/workspace.json`,
and rebuilding the desk from it on the next launch. The definition is this:

- the shape of the layout tree (a split's direction and ratio, the nesting of
  panels)
- each panel's tab composition and order, which tab is active, which panel has
  focus
- each view's definition: a table's `ref`/`filter`/`sort`/`page`, a query's
  `text`, a tree's `expanded`/`selected`, a vector's search parameters, a chat's
  session id, a package view's `state`
- **which saved connection** each view points at

**Not doing**:

- **Result sets do not go to disk.** README:575 promised "Result sets are
  memory-only by design and always will be", and that does not move. "Very large
  results spill to disk" is a separate open item in PLAN, unrelated to this.
- **`cursorToken` is not stored.** It is an in-session cursor; see §2.1.
- **A query that is running is not stored.** After a restart nothing is "still
  running".
- **Provisional views are not stored.** Their definition is "opened for a look,
  not meant to be kept" (`workspace.ts`'s `ViewBase.provisional`), so storing one
  is self-contradictory.
- **Renderer-local preferences do not move.** Language, appearance, sidebar
  collapse, the session bar, and the record of consent for context actions all
  live in `localStorage` (`renderer/i18n/store.ts`, `state/persistedFlag.ts`,
  `components/context-actions/consent.ts`); that is a separate mechanism, and it
  is neither merged nor relocated here.
- **No multiple windows.** A non-goal in PLAN §1, which is why the workspace file
  is singular.
- **No automatic protection against a crash loop.** See §3.F.

## 2. The plan

### 2.1 What is stored is a `ViewOpenSpec`, not a `ViewState`

The dividing line PLAN:660 asks for — "view definition" against "in-session
cursor" — **is already in the type system**, it has just never been pointed at as
the answer to persistence:

| | type | where |
|---|---|---|
| view definition | `ViewOpenSpec` | `packages/core/src/commands.ts:164-360` |
| definition + session state | `ViewState` | `packages/core/src/workspace.ts:213-` |

`cursorToken`, `resultId`, `status`, `error`, `autoRefreshStoppedBy`,
`packageText` and `showingSnapshot` all grow on the latter only. The former is
the input to `view.open`, and was always a complete description of "what a view
should be".

So persistence does not have to invent a "storable view", and does not have to
write a field allowlist — **store the spec**, and there is no cursor in a spec to
store. The blocker PLAN records disappears on its own under this choice.

The second consequence matters just as much: restoring therefore goes through
**exactly the same command channel a human and an AI go through** (PLAN §1). No
new write path pours state into the Workspace Store, and every check on
`layout.setLayout` / `view.open` / `view.update` (P1–P6, tree depth, panel cap,
tab cap) still runs on the restored data. A hand-edited, broken `workspace.json`
can at most stop one view from opening; it cannot produce an illegal tree.

### 2.2 The file

`~/.peek/workspace.json`, 0600, written the way `config/json-file.ts` writes
(temp file + rename, so a crash leaves no half file). Under `~/.peek` rather than
`userData`, for the reason in `config/paths.ts`'s header comment: everything Peek
writes goes in a directory a person can open.

```jsonc
{
  "version": 1,
  "savedAt": "2026-08-15T07:55:00.000Z",
  // the connections referenced, by the connection book's identity rather than by connId
  "connections": [
    { "ref": "c1", "identity": "postgres|db.internal|5432|shop|gy" }
  ],
  "views": [
    {
      "ref": "v1",
      "conn": "c1",
      "spec": { "kind": "table", "ref": { … }, "filter": [ … ], "offset": 0, "limit": 200 },
      // the two things a spec cannot hold but that are worth keeping, see step 5 of §2.4
      "autoRefreshMs": 5000,
      "treeSelected": "public.orders"
    }
  ],
  "layout": {
    "type": "split", "dir": "row", "ratio": [0.3, 0.7],
    "children": [
      { "type": "panel", "key": "p1", "views": ["v1"], "active": "v1" },
      { "type": "panel", "key": "p2", "views": ["v2", "v3"], "active": "v3" }
    ]
  },
  "focusPanel": "p2"
}
```

**A connection by `identity`, not by `connId`**: a `ConnId` is minted fresh on
every run and means nothing across processes. `identity` is the connection book's
key (the "Identity" section of `config/connection-book.ts`;
`SavedConnection.identity` at `commands.ts:1812`), and what it names is "which
account on which server" — exactly the right answer to "which database is this
view looking at". A view's `spec.connId` is replaced on the way out with an
in-file reference like `conn: "c1"`, and swapped back for a real `ConnId` on
restore.

`ref` is an id local to the file, not a `ViewId`. Same reason: a `ViewId` is
minted fresh each time.

### 2.3 When it writes

Project once inside `WorkspaceStore`'s listener → compare against the previous
projection → only on a change, schedule a 250 ms debounced write; on
`before-quit`, flush once synchronously (the persister's disposer flushes before
it disposes, and disposers run first in `shutdown`, so the last operation always
reaches disk).

The projection is cheap (views are in the tens) and the comparison is on the
serialised string. **While a query is running, `ResultMeta.rows` changes every
frame, and there is no `results` in the projection at all**, so that whole stream
of patches costs not one write — the second thing "store the spec" buys for free.

### 2.4 The order of restoring

All of it happens before `createWindow()` (`main/index.ts:1001`), so the window
reads a complete workspace the moment it comes up, rather than drawing an empty
desk and then jumping to a full one.

1. **Read the file.** A parse failure or a schema failure → rename the file to
   `workspace.json.bad` (keep the evidence, do not delete it), start from an empty
   workspace, and `notify` an error. A failed restore never blocks startup.

2. **Open the connections, but do not wait for them.** For each `identity` in the
   file, look for an entry in the connection book:
   - not found (the user forgot it) → the views hanging off that connection are
     skipped as a group, with a `notify` explaining;
   - found → `book.hydrate` to merge the credentials back out of the keychain →
     `conn.open`.

   **The handshake is not awaited**: `conn.open`'s reducer is synchronous, and it
   writes a `status:'connecting'` connection into the workspace and hands back a
   `connId` on the spot (`bus/handlers/conn.ts:29-46`); the actual handshake is
   the `connect` intent, which runs in an effect (`bus/effects.ts:61`). So the
   layout can be built immediately on connIds that have not connected yet.

3. **`layout.setLayout`** builds the tree: each panel leaf carries a `key`, with
   `viewIds` and `open` both empty. The result carries the key → panelId mapping.

4. **`view.open` one at a time in tab order**, `{ spec, panelId, focus: false }`.
   The order is the tab order (P6). `focus: false` leaves focus where step 3's
   `focusKey` put it; **there is no `activate` input**, and every open activates
   its own tab, which is why step 6 is necessary.

5. **A `view.update` to fill in**, sent only when needed. Two things are **on no
   `ViewOpenSpec`**, only on a `ViewPatch` (compare `commands.ts:164-213` with
   `ViewPatchSchema`):
   - `autoRefreshMs` — every refreshable view;
   - `selected` — tree views (the spec only has `expanded`).

6. **Activate**: each panel sends a `view.activate` for its active tab
   (`focusPanel: false`). The focused panel needs no command of its own — step 3's
   `layout.setLayout` carries `focusKey` directly.

7. **Once a connection is ready, wake the empty views hanging off it.** This is
   the only **new** mechanism in this change: after `effects.ts:69` sets a
   connection to `ready`, nothing today looks back at any view. The `autoFetch`
   (`bus/handlers/shared.ts:594`) triggered by `view.open` in step 4 was blocked
   by `canFetch` because the connection was still `connecting`, so the view sits
   at `idle` — normal behaviour, spelled out in `autoFetch`'s header comment, but
   nobody picks them back up when the connection becomes ready.

   New: once a connection's handshake settles, run `autoFetch` once for each
   refreshable view under that `connId` whose `status === 'idle'` and which has no
   `resultId`.

   **"The handshake settles" is not `status === 'ready'`, and this one was caught
   by a real machine during implementation.** A connection becomes `ready` in the
   workspace by two routes, and only one of them means what is wanted here:

   1. the driver host emits a `status` event of its own, which
      `wireConnectionEvents` transcribes straight into the store — status only, no
      capabilities (that stretch at index.ts:620 passes only `error` and `pid`);
   2. `conn.open`'s effect returns, and `effects.ts:69` writes it in together with
      the capability set the driver actually reported and a `readyAt`.

   **Route 1 arrives first.** In that window the connection reads as ready while
   ConnectionManager's own entry is still `capabilities: []` (manager.ts:270 is
   where it gets filled from connect's return value). Waking on status alone
   therefore drove a scan into that gap, and what came back was
   `UNSUPPORTED_CAPABILITY: Driver sqlite does not support collectionScan` — a
   driver that supports it, on a connection that is about to be fine.
   `verify-workspace-restore.mjs` reproduces it every run, because a restored
   SQLite connection is fast enough to land squarely in the gap.

   So the latch is **a change in `readyAt`**: only route 2 writes it, and "it
   changed" is precisely "a handshake completed and its answer is already in the
   store". It has to be "changed" rather than "not empty" because on a reconnect
   the old `readyAt` sticks around, and testing for non-empty would let route 1
   through again on the way back.

   **Query views are not among them.** `autoFetch` requires `runQuery === true`
   for a query, and restoring does not pass it — a restart should not execute the
   statement the user left in the editor. Table / vector / package fill their own
   data in; a query view keeps its text and waits for the user to press run.

   This step serves more than restoring: today, after a connection drops and
   reconnects, the views hanging off it are equally empty and equally in need of a
   manual refresh.

### 2.5 Chat views

Store `resumeSessionId = agentSessionId ?? resumeSessionId`; a view with neither
(an empty conversation that never sent a message) **is not stored**.

No transcript is stored, not a word of it. The line from
`2026-08-03-chat-history-ownership.md` and `2026-08-06-opening-a-stored-conversation.md`
§2.2 does not move: an ACP conversation belongs to Claude Code or Codex, and Peek
remembers only **what it drew**, a snapshot already stored by sessionId under
`~/.peek/chat/snapshots/`. A restored chat view carries a `resumeSessionId` and
takes exactly the existing path taken by opening a conversation from the session
bar — the snapshot goes up first, and is replaced by the real thing when
`session/load` returns, with the composer disabled on failure per §2.4 of that
record. The workspace file contributes one id here, and nothing else.

### 2.6 Package views and uninstalled packages

`buildViewState`'s package branch (`shared.ts:542`) does not check whether the
`packageKind` is registered, so restoring a view whose package has been
uninstalled does not fail the command; it opens, sits at idle, and the renderer
draws `view.packageMissing` — exactly the behaviour the comment at
`shared.ts:654` expects:

> A workspace persisted while a package was installed and restored after it was
> removed lands here too … failing the Command instead would make restoring a
> workspace fail as a whole.

One documentation/code divergence is fixed along the way:
`PackageViewSpecSchema`'s comment used to say that an unregistered kind means
"main answers BAD_REQUEST", and the implementation has no such check. Checked,
and **the implementation is kept and the comment changed** — tolerance is the
wanted behaviour here, and a package that was installed and then removed should
not make a whole workspace unrestorable.

### 2.7 The escape hatch

`PEEK_NO_RESTORE=1` starts from an empty workspace: no read, no delete, **and no
write**.

The reason it exists is one concrete failure: some restored view crashes the
window, so every launch crashes, and the user has no window left to click. An
environment variable that gets you in so you can close a few tabs by hand beats
nothing.

"And no write" is the other half of this, not an afterthought: a process running
with the escape hatch open, if it saved as usual, would overwrite the user's file
with an empty workspace at the first debounce — which is the very thing it was
opened to rescue. So on that run `createWorkspacePersister` does not start at all.

## 3. Trade-offs

**A. Extend `LayoutSpecPanel` with an `activeIndex` so restoring becomes one
command — not doing it.** `layout.setLayout`'s panel leaf already supports `open:
ViewOpenSpec[]`, so it looks as if one command could build the whole workspace.
But `activeViewId` can only name an id already in `viewIds`, as the schema itself
says — "A view opened by `open` cannot be named here — it has no id yet" — so
"open three tabs and activate the second" is inexpressible. Adding an
`activeIndex` would solve it, but that is **a capability increase for the AI**,
and persistence should not decide it in passing. Restoring happens before the
window appears, and the cost of a few more commands is a few immer produces and a
few patches broadcast to zero listeners; it is not a cost. If it is worth adding,
it is worth its own change.

**B. Serialise the whole `Workspace` and setState it on restore — not doing it.**
This is the shortest implementation and the most expensive: it introduces a second
write path that bypasses every Command check, and then **it has to invent an
allowlist of "which fields may be stored"** — and that allowlist is exactly the
blocker PLAN:660 names, which §2.1's approach does not need at all.

**C. Wait for connections to be ready before building the views — not doing it.**
Startup would be held hostage by the slowest handshake, and a database that
cannot be reached would make its whole layout disappear. Views first, connections
after, is the only order under which "you can see your desk even while the
database is down" holds.

**D. Do not reconnect automatically — leave the views hanging until the user
clicks — not doing it, but this is the one most likely to be overturned.** For
automatic reconnection: a database GUI reopens where you left off, and TablePlus
and DataGrip both do this; the failure path is already complete (the connection
goes to `error`, the sidebar can reconnect, the error centre has a record).
Against it, also valid: a workspace with five connections means five
utilityProcesses and five handshakes on launch, which may run into a VPN that is
not up, and may eat into the database's connection quota. If this is reversed, the
change lands in step 2 of §2.4 — replace `conn.open` with "put an idle connection
into the workspace and plan no connect intent", which would need a "present but
not connected" state that `ConnectionState` does not have today. That is not
cheap, so automatic reconnection it is for now.

**E. Result sets to disk — never.** README:575 already promised this, and it does
not waver here.

**F. Automatic protection against a crash loop (do not restore if the last exit
was not clean) — not in this version.** Getting it right means distinguishing "the
user force-killed it" from "the renderer crashed" from "main crashed", and then
deciding whether "do not restore" keeps the file or deletes it; half of it is
harder to explain than none of it. §2.7's environment variable first, and design
this to the shape of a real crash loop when one actually happens.

## 4. Verification

**Unit tests**

1. **Projection** (`ViewState[]` → file): assert the output contains no
   `cursorToken`, `resultId`, `status`, `error`, `autoRefreshStoppedBy`,
   `packageText` or `showingSnapshot`, that a `provisional` view does not appear,
   and that a chat with neither `agentSessionId` nor `resumeSessionId` does not
   appear.
2. **File round trip**: project → write → read → passes the schema, and equals the
   projection.
3. **Degrading**: corrupt JSON, an unrecognised version, an identity not in the
   connection book — each of the three yields either "empty workspace + one
   notify" or "skip those views + one notify", and none of them throws.
4. **Restoring**: project a file out of a real workspace, restore it on a
   different command bus, and project again — the two projections are equal. The
   assertion is on the result rather than on the command sequence: the sequence is
   the means, "the desk is the same" is the thing wanted. Unit tests also cover a
   forgotten connection (the views skipped as a group, explained in the report), a
   bad spec (costing one view only), and a query view **not executing** after
   restore.
5. **Waking on ready**: after the handshake settles, an idle table view under the
   same connId starts fetching and a query view does not; a view that already
   fetched is not re-run; **and nothing moves when status alone goes ready while
   the handshake has not settled** (the regression test for the race in §2.4).

These land in `apps/desktop/src/main/__tests__/workspace-persistence.test.ts`, 19
of them.

**Script** (`apps/desktop/scripts/verify-workspace-restore.mjs`)

Originally listed as optional, actually required: it is the automated version of
manual items 6–8 below, and it covers everything the unit tests **cannot reach** —
`main/index.ts`'s startup path, the flush on `before-quit`, a second process
reading what a first process wrote, a real driver against a real database, and the
wake after a handshake settles.

It runs Peek twice against the same `~/.peek`:

- **run 1** connects a temporary SQLite fixture, opens a table, opens a query view
  with a statement written but not run, splits into two columns, and then **lets
  the app quit by itself** (`PEEK_SMOKE_EXIT_MS` → `app.quit()` → `before-quit` →
  flush; a kill would skip the very path being verified);
- **in between**, check `workspace.json`: two views, the statement verbatim, the
  connection recorded once by identity, and not one of `cursorToken` / `resultId`
  / `status` / `rows`;
- **run 2** starts a fresh process and reads the workspace back through MCP: the
  layout, each pane's views, the connection reconnecting itself, **the table
  filling in its own data** (the one assertion that proves the wake works
  end-to-end), and the statement **still not executed**.

```
pnpm --filter @peek/desktop build
node apps/desktop/scripts/verify-workspace-restore.mjs [--verbose] [--keep]
```

The `readyAt` race in §2.4 is what it caught — in the unit tests the connection is
a stub, and the two ready routes never separate far enough to be observed.

**By hand** (the items the script does not cover)

6. **The chat half** (the script does not touch the agent): exchange a few
   messages, ⌘Q, reopen → the chat tab is back, showing the snapshot first, and
   replaced by the real thing when `session/load` returns; on failure the composer
   is disabled (`2026-08-06` §2.4).
7. Forget one of the connections and reopen → those views are gone, the error
   centre has an entry explaining it, and everything else is as before.
8. Stop the database and reopen Peek → the layout is there, the connection is in
   error; start the database and click reconnect → the table fills itself in.
9. Launch with `PEEK_NO_RESTORE=1` → an empty workspace, the file still there, and
   the next normal launch restores as usual.

## 5. Existing documents to change alongside

This change overturns several promises made in black and white, and they have to
change as the code lands, or the documentation is wrong immediately:

- the last sentence of the "Persistence" cell in `README.md:41`'s feature table;
- all of `README.md:573`, "Layout and open views still do not persist";
- the final clause of `README.md:579`'s cursorToken entry, "which matters if view
  state is ever persisted" — there is an answer now: it is not stored;
- `README.md:588`'s description of M7's scope;
- that sentence in `apps/desktop/src/main/config/index.ts:22`'s header comment;
- `apps/desktop/src/main/config/settings.ts:7`, "Layout, open views and query text
  stay in memory, as the README promises";
- `apps/desktop/src/main/config/paths.ts`'s file roster (one more:
  `workspace.json`);
- `docs/PLAN.md:660` moves from "still open" to "settled", and §9 M6's third item
  gets its persistence roster filled in.
