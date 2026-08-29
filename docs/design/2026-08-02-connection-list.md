# The sidebar's connection list: merging live and saved

## 1. What this fixes

### Where things stand

The sidebar draws two lists (`Sidebar.tsx`): the top half is the **live connections**
in the Workspace, the bottom half the **saved connections** in
`~/.peek/connections.json`.

And the connection book's write contract is (the comment at the top of
`connection-book.ts`):

> An entry is written as a side effect of a **successful** `conn.open`, and there is no
> second write path.

Which is to say `live ⊆ saved` holds always.

### The problems

1. **The same connection is drawn twice.** After connecting to redis, the top half has
   a live `redis://localhost:6379` row and the bottom half still has a disabled grey row
   marked `已打开`. The list is twice as long as the number of connections, and half of
   it is disabled shadows.

2. **Pairing is done on the label string.** `liveLabels` in `Sidebar.tsx` compares sets
   using `conn.label || defaultConnectionLabel(conn.config)`. Labels repeat: two
   same-named databases on two hosts impersonate each other, and one of them gets its
   Connect button wrongly disabled. The real identity is `connectionIdentity(config)`,
   but that is locked inside main and the renderer cannot reach it.

3. **One saved connection takes three lines and three permanently visible buttons**,
   about 150px. Five of them fill the whole sidebar and push out what it is actually
   there for — the live connections and the object tree. Whereas the live connection row
   (`ConnectionItem`) only expands its actions when selected; the two are inconsistent.

4. **The second line is noise.** `未保存密码` repeats on most rows, and a repeated
   negative state carries no information.

5. **Labels truncate from the tail, and everything that distinguishes them is in the
   tail.** `defaultConnectionLabel` returns the full path for sqlite, the whole URL for
   redis/qdrant, and degrades to the URL for postgres/mysql when `database` is missing.
   So the list shows `/private/tmp/claude-501/-Us…` (filename cut off) and
   `mysql://root@localhost:330…` (port and database name cut off).

### Boundary (not done this time)

- No connection grouping / folders / favourites.
- No search box. The list's ceiling is `MAX_BOOK_ENTRIES = 100`, but the usual scale is
  single digits.
- ~~No general popup-menu primitive. `context-actions/ContextMenu.tsx` is welded to
  `ContextTarget`, and extending it for the sidebar costs more than it returns; the
  actions stay in the action bar that expands on the selected row.~~
  **Void as of 2026-08-03**: the arithmetic at the time was "build a primitive for one
  sidebar", and it later became four points of use — a different denominator. `<Menu>`
  has been built, the action bar on the selected row has been deleted, and the actions
  are now given by a right-click menu. See
  [`2026-08-03-context-menu-primitive.md`](2026-08-03-context-menu-primitive.md).
  §2.1's "disconnect and remove never appear together" is kept exactly as written, and
  has been pinned by a test.
- No change to the connection book's on-disk format version (`version: 1`); this only
  writes one derived field less, and old files still read.

## 2. The plan

### 2.1 Overturning the old "do not merge" decision

The file header comment in `Sidebar.tsx` originally said:

> One is a driver process that exists right now, the other is a description of "how to
> make one"… merging them into a single list with a status dot would make "disconnect"
> and "delete" look like the same operation.

The worry is sound, the conclusion is void. A "connection" is a persistent thing in the
user's head, and "is there a driver process right now" is its **state**, not its
**kind** — which is also what TablePlus / DBeaver / DataGrip / Navicat all do. And the
distinction between "disconnect" and "delete" is not made by splitting the list; it is
made by **the two never appearing together**:

- the row has a live connection → the action bar offers Disconnect, not Remove;
- the row has no live connection → the action bar offers Remove, not Disconnect.

At any moment a connection can be acted on by only one of those two, and the ambiguity
disappears at the root. This document replaces that comment in `Sidebar.tsx`, and the
implementation changes it to match.

### 2.2 The row model

```
rows = every live connection ∪ every book entry with no live connection
```

- Live rows render by `ConnId`, book entry rows by entry id. That naturally accommodates
  two corner cases: **a live connection whose book write failed** (`remember` returns
  `null` on failure rather than throwing), and **the same config opened twice** (the UI
  gives no route to this, but MCP can).
- Pairing is by `connectionIdentity(config)`, not by label.
- Ordering: `lastUsedAt` descending, with rows that are live but not in the book first.
  Connecting successfully refreshes `lastUsedAt`, so that row jumps to the top —
  **accept the jump**, it has the same effect as today's "appears in the upper list",
  and is not worth storing a second, session-scoped ordering for.

Extracted as the pure function
`renderer/components/connectionRows.ts::buildConnectionRows(conns, saved)`, tested on its
own.

### 2.3 Identity moves down into core

`connectionIdentity` and `stripUrlPassword` move from `main/config/connection-book.ts`
to `packages/core/src/capability.ts`; the hashing step `identityId` (which depends on
`node:crypto`) stays in main. The renderer only needs equality comparison, for which the
identity string itself is enough.

One property that has to hold: **identity is unchanged by redaction**. The `conn.config`
the renderer receives has been through `redactConnectionConfig` (URL passwords become
`***`), and the config in the book has been through `stripSecrets` (URL passwords
removed). `connectionIdentity` puts every URL through `stripUrlPassword` first, and
`stripUrlPassword` gives the same output for `://user:***@host` and `://user@host`;
password / apiKey never take part in identity anyway. So the identity computed on either
side agrees. This property needs a test guarding it.

There is no security cost: identity is a concatenation of plain-text fields, contains no
credential, and the redacted config is already in the renderer.

### 2.4 Deriving the label

Rewrite `defaultConnectionLabel` so the primary title lands on **the part that
distinguishes**:

| driver | primary title |
|---|---|
| postgres / mysql | `database` → the database name parsed out of the URL path → `host:port` → driverId |
| sqlite | the filename (basename), not the full path |
| redis | `host:port` (plus `/db` when `db` is not 0); the URL is only used to parse those parts out |
| qdrant | `host:port` |

A user-typed `cfg.label` still wins in every case. **No branch returns the whole URL any
more**, so there is no longer any need to fall back on `redactUrlCredentials` (the
protection stays in the function as the last line of defence when parsing fails).

Alongside it, a new `connectionDetail(cfg)`: it returns the full identifying text
(sqlite's full path, everyone else's redacted URL or `user@host:port/db`), hung on the
row's `title`. Truncated information is not lost, only moved to hover.

### 2.5 The derived label stops being written to the file

`StoredEntry.label` today stores the result of `defaultConnectionLabel(stripped)` — a
derived value. Once on disk, that means changing the derivation rule has no effect on
old entries.

The fix: **drop the `label` field from `StoredEntry`**, and have `toSavedConnection`
compute `defaultConnectionLabel(entry.config)` on the spot. A user-typed name is already
in `entry.config.label` (which `stripSecrets` does not touch), so no information is
lost. The leftover `label` key in old files is ignored by `parseEntry`. Zero migration.

### 2.6 What a row looks like

One line, about 24px:

```
● shop              mysql  🔑
● peek.db           sqlite
○ localhost:6379    redis        ← hollow dot = not connected
● analytics       postgres
    Object tree   Query   Disconnect   Edit     ← only on the selected row
✕ staging         postgres
    password authentication failed              ← second line only when it has something to say
```

- **The status dot** only carries information once the lists are merged: hollow = not
  connected, green = connected, flashing yellow = connecting, red = failed. (Before
  merging, every dot in the saved section was grey — pure noise.)
- **The second line appears on demand**: it takes a line only for `connecting`
  (Connecting…) and `error` (the driver's verbatim error). A connected row's version
  number moves into the row's `title`.
- **🔑 appears only when `hasSecret` is true**. The `未保存密码` line is deleted — a
  repeated negative state does not deserve the space. When the keychain is unavailable
  altogether, the global notice at the bottom of the list (`sidebar.noKeychain`) stays.
- The driver id is still right-aligned, faint, 10px, moved out of an inline style into
  `.conn-driver`.
  > **The 10px has been overturned by `2026-08-02-ui-legibility-baseline.md` §2.1**: no
  > text goes below 11px, and `--fg-faint` is brightened to 4.5:1 at the same time.
  > Right-aligned and faint are unchanged.

### 2.7 Interaction

- **Single click = select and expand the action bar** (uniform across all rows, and the
  same as `ConnectionItem`'s behaviour today).
- **Double click = connect** (on a not-connected row). This is the generic gesture in DB
  clients, offered as an accelerator; Connect in the action bar is its discoverable
  entry point.
- Once single-click means the same thing everywhere, a not-connected row can also be
  selected, which is what gives Edit / Remove an entry point — the direct reason for
  choosing "click to select" over "click to connect".

The action bar is given by state (all ≤ 4 items, with `flex-wrap` as a backstop):

| row state | actions |
|---|---|
| no live connection | Connect, Edit, Remove |
| connecting | Object tree, Query (both disabled), Disconnect, Edit |
| ready | Object tree, Query (shows the text `No query language` when the capability is absent), Disconnect, Edit |
| error | Disconnect, Edit |

connecting and ready are given the same set of buttons and differ only in disabled
state, so that the action bar does not grow at the instant a connection succeeds and jolt
the layout; capability decisions reuse the existing division of labour between `connHas`
(draw it or not) and `connCanUse` (can it be clicked).

Remove keeps today's two-click confirmation (no modal), cancelled by losing focus.

> **Where the second click lands has been hardened by
> `2026-08-02-ui-legibility-baseline.md` §2.5**: the confirming state expands to
> `[Keep] [Remove for good]`, with Keep occupying the original button's position, so the
> second half of a double-click by reflex lands on the harmless one. All three of "two
> clicks, no modal, cancelled by losing focus" are unchanged.

A connection whose `conn.open` failed **never enters the book**, so an error row is
usually a row with only a live side and no book entry; its Edit assembles a
`SavedConnection` on the spot out of the live connection's config to seed the form.

### 2.8 Files involved

| file | change |
|---|---|
| `packages/core/src/capability.ts` | rewrite `defaultConnectionLabel`; add `connectionDetail`, `connectionIdentity`, `stripUrlPassword` |
| `packages/core/src/index.ts` | export the new symbols |
| `apps/desktop/src/main/config/connection-book.ts` | take the identity functions from core; drop `label` from `StoredEntry` |
| `apps/desktop/src/main/config/index.ts` | re-export pointing at core's implementation |
| `apps/desktop/src/renderer/components/connectionRows.ts` | new: the pure row model |
| `apps/desktop/src/renderer/components/Sidebar.tsx` | merge the lists; a single-line `ConnectionRow` replaces `ConnectionItem` + `SavedItem` |
| `apps/desktop/src/renderer/styles.css` | `.conn-*` density, hollow `.dot.idle`, `.conn-driver`, `.conn-key` |
| `renderer/i18n/messages/{en,zh-CN}/sidebar.ts` | `sidebar.saved.*` collapses into `sidebar.action.*` |

## 3. Trade-offs

**Why not keep the two sections and only tighten the density.** That gets the density
back, but leaves the structural duplication of drawing one connection twice, and leaves
the label-pairing bug. Density is only the symptom.

**Why not a `⋯` popup menu.** Visually cleaner, but it means either extending
`ContextTarget` (which was designed for data cells and agent attachments) or writing a
new overlay primitive. An action bar expanded on the selected row is a pattern the
repository already has, needs no new primitive, and matches `ConnectionItem`'s behaviour
today. `⋯` can come later.

**Why not "click to connect".** It saves a click on connecting, but then a
not-connected row can never be selected, Edit and Remove lose their entry point, and a
popup menu has to be added back anyway. "Click to select + double-click to connect"
solves both.

**Why identity moves down to core rather than having `ConnectionState` carry the book
entry id.** The latter keeps the identity logic entirely inside main, but requires
changing the Workspace state shape and the patch flow; the former just moves one pure
string function to a different file, and fixes the label-pairing bug on the way.

**Why the row jump is accepted.** Pinning the ordering within a session costs another
piece of state, and the benefit is only "the row you just clicked does not move".
Floating to the top on a successful connection is reasonable feedback in itself.

## 4. Verification

Automated (`pnpm test`):

1. `renderer/components/__tests__/connection-rows.test.ts` (new)
   - a live connection and its book entry merge into **one** row, not two;
   - an entry only in the book gets its own row;
   - a connection that is live but not in the book (a failed book write) still gets a
     row, and sorts first;
   - two `ConnId`s for the same config each get a row and do not swallow each other;
   - **identity is the same before and after redaction**:
     `connectionIdentity(redactConnectionConfig(c))`
     `=== connectionIdentity(stripSecrets(c))`, one case in URL mode and one in field
     mode;
   - two same-named connections on different hosts no longer impersonate each other.
2. `connection-label.test.ts` (new): label derivation for all five drivers, focusing on
   sqlite taking the basename, URL-mode postgres reaching the database name, and redis
   taking `host:port`.
3. `connection-book.test.ts` (changed): the "one bad line does not take the others down"
   case originally asserted `label === 'fine'` (the label handwritten in the file), and
   now asserts the derived result `a.db`; plus one more, "the file's `label` key is
   ignored and the name comes from config".
4. `pnpm typecheck` all green.

Manual:

1. Open 5 connections (covering all 5 drivers), then disconnect them all, and confirm
   the sidebar has 5 rows rather than 10, with a total height < 150px.
2. Connect one of them: that row's status dot turns green and it floats to the top, and
   **no** second row with the same name appears.
3. Select a connected row → Object tree / Query / Disconnect / Edit; after
   disconnecting, the same row turns hollow in place and the action bar becomes Connect /
   Edit / Remove.
4. The sqlite row shows the filename and hover shows the full path; a postgres URL
   connection shows the database name.
5. Deliberately mistype the password: the row's dot turns red, the second line shows the
   driver's verbatim text, and the action bar gives Edit / Disconnect.
6. Remove makes the entry disappear after two clicks; if that connection is still live,
   the action is not offered at all.
