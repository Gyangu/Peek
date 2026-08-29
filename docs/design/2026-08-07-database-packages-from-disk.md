# Phase C: database packages load from disk, the bundled ones no exception

> 2026-08-07. The user's request: **that read-only "which databases are installed"
> table in settings becomes something the user can install and uninstall for
> themselves.**
>
> This is the **Phase C** planned in
> [`2026-08-03-plugin-architecture.md`](2026-08-03-plugin-architecture.md) §2.1,
> not a new direction. That document settled the directory layout, the trust model
> and the acceptance criteria; what this one does is finish the parts it left
> unwritten — three of which only became visible after Phase B was implemented,
> and one of which **overturns the shape `DriverManifest` has today**.
>
> The previous document's wording was "C only changes when things load, it does not
> change the seams". **That sentence is now only half right**; §1.4 says why.
>
> **This document also renames the whole batch** (§0.1): they are no longer called
> plugins, they are **database packages**. The old-to-new word table is in §0.1 —
> the previous document is not renamed, it is a historical record.

---

## 0. Decision ledger

Five, decided by the user after seeing each one's cost. **Two of them run against
this document's author's recommendation; they are implemented as the user decided,
and the consequences are recorded here faithfully.**

| # | decision | what was recommended | recorded where |
|---|---|---|---|
| 1 | **Replace, do not layer.** The six built-in packages move into `~/.peek/packages/` too, exactly on par with third-party packages | recommended "built-ins compiled in, third-party layered on top" | §2.5 / §3.1 |
| 2 | **Bundled packages ship with the app**, laid out on first run, but uninstallable and replaceable | — | §2.5 |
| 3 | **Packages carry their own multilingual strings**, falling back to en | — | §2.3c |
| 4 | **Hot reload, no restart** | recommended "require an app restart" | §2.7 |
| 5 | **Rename: plugin → database package (package)** | — | §0.1 |
| 6 | **No signature / hash verification** (**restated** on 2026-08-10 after going through Electron security practices item by item) | — | §2.9 |
| 7 | **Package code does not enter the main process**, it goes into a dedicated package host utilityProcess | — | §2.4bis |
| 8 | **Electron hardening lands together with Phase C**, not in stages | recommended "hardening lands on its own first, moving processes is another round" | §2.10 |

**The nature of decision 6 needs stating**: 08-03's decision 1 was made without a
checklist to compare against; on 2026-08-10 the user went through a complete list of
Electron security practices item by item and chose the same answer. **That is an
informed restatement, not the original choice** — the difference is that it now
rules out "we did not think of it" as an explanation.

**Decision 6 determines decision 7 directly**: with no verification, nothing stops a
malicious package from being installed, so "what it can touch once it is in" is the
only place left to tighten. And every **convention-shaped** measure (statically
scanning `main.mjs` to forbid importing `electron` / `node:fs`) can be routed around
with `globalThis.process.mainModule.require('fs')` — **a scan stops accidents and
laziness, it does not stop an attack**. A process boundary is enforced by the
operating system and cannot be routed around, so it is the only effective one.

**The consequence of decision 8**: this document's implementation scope is one notch
larger than planned. Staging was recommended (finish Phase C first, hardening in its
own round), on the grounds plugin-architecture §3.1 argued: verify one thing at a
time. The user asked for it all at once, and it is implemented that way — at the cost
of §4's acceptance criteria growing from 27 to 40, with a batch of them (the hardening
ones) having nothing to do with database packages while sharing one change, so that
when something breaks it takes an extra step to tell which half broke.

**The consequence of decision 1**: that compile-time check on
`connectForm.ts:60`, `DriverManifest<PlainMessageKey>[]`, **disappears entirely**.
The boundary doc §4.1 spent a whole section verifying it in reverse (rename redis's
`connect.field.host` to `hostname`, and desktop typecheck names it in the error).
Decision 3 removes its subject at the same time — packages no longer reference the
kernel's catalogue — so the two decisions are self-consistent on this point, but **the
guarantee really did get downgraded**: from "tsc names it in the error" to "load-time
validation rejects it". §4 requires that new validation to have an inverse check.

**The second consequence of decision 1, to be said out loud**: the user can uninstall
PostgreSQL. After that peek cannot connect to PostgreSQL until it is installed again.
This is not a defect, it is exactly what "exactly on par" means — VSCode's built-in
extensions can only be disabled, not uninstalled; peek goes further than that.
§2.5 provides the way back.

**The consequence of decision 4**: uninstalling achieves "no longer used", not "the
code leaves process memory". The ESM module cache cannot be cleared; once `main.mjs`
is `import`ed it stays in the main process until exit. §2.7 gives this one's exact
boundary, and why the driver half is clean by comparison.

### 0.1 The rename: why, and the old-to-new word table

**Why**: `plugin` promises a general extension point — the VSCode extension,
JetBrains plugin kind of thing that can add themes, add commands, add language
support. This set can add exactly one thing: **support for one database** (driver +
view + MCP tool + skill). The name is bigger than the thing.

And the repo is already contradicting itself, with four words for the same batch: the
UI says `数据库`, `连接器版本`, `由包提供的视图种类`; the i18n key is
`settings.packages.*`; the component is `PackagesSection`; the code layer is
`packages/driver-*` / `DriverManifest`; and the mechanism layer has **548 occurrences**
of `plugin`. plugin-architecture §2.2 once proposed a fifth candidate,
`@peek/db-<name>`, which the implementation did not adopt.

**Unified as "database package"**, with the UI keeping the two words `数据库` and
`连接器版本` untouched — they are already in use, already accurate, and they name the
two sides of a package (what it can open / which build of the implementation opens it).

| old | new | cost |
|---|---|---|
| `~/.peek/plugins/` | `~/.peek/packages/` | zero (does not exist yet) |
| `peek-plugin.json` | `peek-package.json` | zero (does not exist yet) |
| `peek-plugin://` | `peek-package://` | medium (protocol registration, the host CSP's `frame-src`, `resolvePluginAsset`, build scripts) |
| `ViewState`'s `kind: 'plugin'` | `kind: 'package'` | **high — this is an external contract** |
| `pluginKind` | `packageKind` | same, the model sees it in `read_workspace`'s receipt |
| `PluginFrame` / `PLUGIN_UI` / `PLUGIN_ID` / `PLUGIN_CSP` / `PLUGIN_MAX_ROWS` | `Package*` | low (mechanical) |
| `packages/driver-<name>` | `packages/db-<name>` | low but numerous (alias, package.json, imports) |

**The `kind: 'plugin'` line needs its own note**: it is a literal in `ViewState`'s
discriminated union, and it goes out over MCP — `read_workspace` today returns
`kind: "plugin"` plus `pluginKind`. Changing it means changing an external API once.
The reason for accepting that cost is timing: Phase C is the **first** time there are
packages from outside the repo, which makes it the **last** time a rename affects no
published package. One step later and compatibility has to be considered.

The rename happens in two batches; the second can wait and does not affect behaviour:

- **Batch one (must land before Phase C)**: the externally visible ones — the
  directory, the protocol, the manifest filename, the MCP fields. Once a user has
  installed a package these become compatibility problems.
- **Batch two (purely mechanical, can be its own commit)**: `packages/driver-*` →
  `db-*`, internal identifiers, wording in comments.

**The previous document is not renamed.** It records the decision made on 2026-08-03,
and editing it would be falsifying the record. This section's table is the bridge
between the two.

---

## 1. What this fixes

### 1.1 Today: three static arrays, and the compile-time guarantee each one keeps

At the end of Phase B, a "package" is three static aggregates plus one UI build:

| file | contents | consumers |
|---|---|---|
| `apps/desktop/src/drivers/manifests.ts` | six `DriverManifest`s | renderer (connect form), main (connection book, MCP receipts) |
| `apps/desktop/src/drivers/viewKinds.ts` | `ViewKindRegistration[]` | main (`autoFetch` planning a fetch), renderer (via `register.ts`) |
| `apps/desktop/src/drivers/mcpTools.ts` | `ToolSpec[]` | main (`collectTools`) |
| `packages/*/ui/index.html` | Tier C self-drawn UI | a separate UI build script → its own `out/` subtree (now folded into `build-packages.mjs`, see §4octies) |

All three files' header comments carry the same sentence: **Phase C replaces this
array with a directory scan and changes nothing else.** That was the expectation when
Phase B was written, and this document corrects it (§1.4).

What genuinely is in place already, with not a line to change in Phase C, is these
four:

- `resolvePackageAsset(rawUrl, root)` (`main/packages/assets.ts:106`) **already takes
  root as a parameter**; swapping in `~/.peek/packages/<id>/ui/` is swapping one
  argument. The escape check is a prefix comparison on the path after resolution,
  which holds just as well for a user-writable directory.
- The package id regex's comment (`assets.ts:60`) already says "in Phase C this is a
  scan of a directory the user can write to".
- `validateViewKindRegistration` (`core/view-kinds.ts:261`) already returns which
  fields are missing rather than throwing, which is exactly the shape the loader wants.
- The document CSP and the separate origin already have a working sample in neo4j.

### 1.2 How the database clients are bundled is good news

Checked and confirmed: `pg` / `mysql2` / `redis` / `@qdrant/js-client-rest` /
`neo4j-driver` are today **inlined into** `driver-host.js` (2.0MB, minified), not
externalized and required by bare name. What `stage-node-modules.mjs` handles is the
handful of bare dependencies left in the main bundle; the driver clients are not among
them.

And **there is no native module today**: `pg-native`, `@node-rs/xxhash` and
`@opentelemetry/api` are all three stubbed out in `optionalDepAlias`
(`electron.vite.config.ts:89`).

The two together: **a package's `driver.mjs` can be one self-contained ESM file** with
the client inlined into it, one build per package — corresponding word for word to what
the then-separate UI build script did for the UI (the two are one script now, §4octies).
No cross-platform binaries, no `node_modules` tree to lay out, no `exports` resolution
to reimplement. This is the technical precondition that lets decision 1 stand.

### 1.3 Hard constraint: the renderer may never execute a package's JS

The iron rule has not changed (plugin-architecture §2.6): **the main window's
`script-src 'self'` is never relaxed, and no package's JS enters the host realm.**

And `DriverManifest` has **two functions** in it:

```
assembleConfig(mode, values, label)   // form values → config draft
endpointSummary(config)               // one-line address, for MCP receipts
```

`assembleConfig` **is called by the renderer** — when Connect is pressed in the connect
dialog. That is fine today, because the manifest is an ordinary module compiled into
the window chunk. After Phase C it comes from disk, and **the window cannot execute
it**.

This is not something that can be traded off, which makes it this document's heaviest
change:

> **`DriverManifest` is demoted to pure data for packages loaded from disk. The two
> functions become declarations.**

§2.3 gives the declarative vocabulary that replaces them, and what it cannot express.

### 1.4 So "C only changes when things load, not the seams" is only half right

The half that is right: the package view branch of `view.open` / `view.update`,
`ViewKindLookup`, `collectTools`'s opaque array, the separate-origin iframe,
`package-view-channel.ts`'s bounded snapshot — none of these seams change by a line,
and Phase B's verification still counts.

The half that is wrong: **the `DriverManifest` seam itself has to change**, because it
was designed for "compiled into the same chunk", and the two function fields are that
premise's offspring. Phase B had no way to discover this — a module compiled in can of
course carry functions.

Three more things change along with it, all of them the "closed union" that Phase B
depends on:

- `DRIVER_IDS` (`core/capability.ts:30`) is a `z.enum` and rejects out-of-repo
  driverIds **at run time**;
- `ConnectionConfigSchema` is a `z.discriminatedUnion` with six branches hard-coded;
- `redactConnectionConfig` / `defaultConnectionLabel` / `connectionDetail` /
  `connectionIdentity`, four exhaustive switches.

The boundary doc §3.3 recorded the cost of opening it up, and it holds word for word:
"**an unrecognised driver will broadcast the password verbatim to MCP**".
plugin-architecture §2.5's decision 5 already chose the fallback behaviour (broadcast
verbatim + one loud warning); this document implements it.

### 1.5 Boundary (what this document explicitly does not do)

- **No package marketplace, no remote distribution, no kill switch.** Installing a
  package is still "put a directory into `~/.peek/packages/`" or "pick a local
  directory in settings".
- **No signature verification, no sandbox, no permission declarations.** Decision 1
  (plugin-architecture §2.7) stands unchanged, and §2.9 restates its exact meaning now
  that there is an install button.
- **No Tier A declarative views.** The only package view today is Tier C (neo4j's
  `graph`), and `PACKAGE_UI`'s comment already holds a place for Tier A. This document
  makes Tier C loadable from disk; Tier A is another round.
- **No real-device probe of the SDK's `skills`.** plugin-architecture §1.3 filed it
  under Phase C, but it and "install packages from disk" are two different things, and
  mixing them means neither gets verified cleanly.
- **No Windows / Linux install shape.**
- **No change to `PACKAGE_MAX_ROWS = 2000`** (plugin-architecture §2.6bis explicitly
  asks that it not be tuned as a way around acceptance criterion 9).

---

## 2. The plan

### 2.1 A package is four pieces running in four places — and the separation is enforced

The overall shape first. The sections that follow are this table's details.

| file | runs where | can touch what | role |
|---|---|---|---|
| `driver.mjs` | the driver-host process (**one per connection**) | the database client, the network, plaintext passwords | back end |
| `contrib.mjs` | the **package host process** (one per package) | pure computation only: assembling statements, describing views, declaring tools | back end |
| `ui/` | an iframe at `peek-package://<id>` | **one MessagePort and nothing else, no network** | front end |
| `peek-package.json` | everybody reads it, nobody executes it | — | interface declaration |

**`main.mjs` is renamed `contrib.mjs` (decision 7)**: the old name implies it runs in
the main process, and after decision 7 that is exactly where it does not run. The new
name comes from the word this document has been using all along — a package
**contributes** tools and view kinds (`settings.packages.viewKinds` reads, in Chinese,
`由包提供的视图种类`).

**From here on there is not one line of package code in the main process.** §2.5
explains how that is achieved, and why it is the only tightening still available after
decision 6.

**This is not a style convention, it is physical isolation.** Front-end/back-end
separation in an ordinary project is "technically possible, just a bad idea"; here it
is not possible:

- `ui/`'s document CSP is `connect-src 'none'` — no fetch, no XHR, no WebSocket, no
  EventSource. The front end has exactly one way to get data: ask the host, and the
  host decides whether to give it.
- `ui/` and the window are **two origins**; the iframe cannot reach the preload, and
  `window.peek` simply does not exist in that realm.
- Even **the build outputs may not be shared**: `build-packages.mjs` is a separate Vite
  build, once per package and once per file. The reason is in its header comment — one
  Rollup graph would hoist common code into a shared chunk, and two realms on different
  origins cannot fetch the same chunk, with the symptom "one package works, another is
  blank, depending on build order". §4octies records this argument's third form, on a
  process boundary: between `driver.mjs` and `contrib.mjs`.

#### The front end does not even assemble the command

Three interface paths:

1. **front end → back end**: the iframe sends a patch over the port, it lands in
   `view.update`, and what it changes is **view state**;
2. **back end → front end**: `autoFetch` translates the new state into a statement,
   goes through the kernel's existing fetch path, and the result is packed into a
   **one-shot bounded snapshot** (≤ `PACKAGE_MAX_ROWS` rows + a `truncated` flag) and
   sent over;
3. **model → back end**: the MCP tools declared by `main.mjs`, which go into the same
   registry as the kernel's 13.

Path 1 needs to be stated precisely, because it is stricter than "the front end
forwards a command to the back end":

```
front end forwards a command:  the iframe says "run MATCH (n) WHERE elementId(n)='4:abc' RETURN n"
                               → the back end runs it → the front end assembled the statement

what peek actually does:       the iframe says "set the focus in my state to '4:abc'"
                               → the back end's autoFetch reads the state and assembles the Cypher itself
                               → the back end assembled the statement; the front end never saw one
```

The difference is substantive: under the first model a compromised front end can send
any statement; under the second it can only change one field's value, **it cannot
assemble a statement, and there is no channel to send one out**.

**This is the reason `autoFetch` has to live in `main.mjs` and cannot go into the
manifest** — in the manifest it becomes template string-building, and this guardrail
comes down on the spot. `core/view-kinds.ts:196` has already written this sentence
down; this section only puts it somewhere it can be seen.

One more in the same direction: what the front end gets is a snapshot, not a cursor;
there is no `fetchMore`, and no message to ask for more with.

**The host window itself works the same way**, and this is not package-specific: every
operation in peek's renderer is dispatched to main over the Command Bus, and there is
no database client in the window at all (in the boundary doc §2.2's table the renderer
column reads **never**, and `manifest-purity.test.ts` plus a grep over the build output
guard it). A package just runs the same rule once more, in a smaller realm.

### 2.2 Disk layout

```
~/.peek/
  settings.json          existing, 0600
  connections.json       existing, 0600
  mcp.json               existing, 0600
  chat/                  existing, 0700
  packages/              new, 0700
    .uninstalled.json    new, 0600 — tombstones for bundled packages, see §2.5
    neo4j/
      peek-package.json  the manifest, pure data
      driver.mjs         dynamically imported by the driver-host process
      contrib.mjs        dynamically imported by the package host process (MCP tools +
                         the function half of view kinds) — after decision 7 it does
                         **not** run in the main process, §2.1 already renamed it
      ui/                Tier C self-drawn UI, the document root of peek-package://neo4j
        index.html
        assets/…
```

`config/paths.ts`'s header comment says "the three files it is **allowed** to write".
That sentence stops holding once the packages directory exists and has to be rewritten
— it describes a closed set of files, and `packages/` is a subtree that both the user
and peek write to.

`resolvePackageAsset`'s root changes from the old UI output tree's root resolver (a
subtree under `out/`) to `<configDir>/packages`, with a `ui/` level added when joining.
**The function itself does not change** — the escape check it keeps now keeps a
user-writable directory, which is exactly why it was written as "prefix-compare after
resolving" rather than "scan for `..`".

### 2.3 `DriverManifest` demoted to data: four declarative replacements

The methodology is the one plugin-architecture §2.6 set for itself: **migrate first,
settle the shape after; do not design the vocabulary first.** Each vocabulary below is
derived backwards from the five built-in manifests, and whether it can express them is
its acceptance criterion.

#### (a) `assembleConfig` → a convention, not configuration

Reading all five `assembleConfig`s, they do the same thing: **every form field goes
into the config under the key of its own name, empty values are omitted, and the type
follows from the field type.** postgres's is eight lines of field-by-field
`definedField('host', text('host'))`, with not one line renaming or computing anything.

So the replacement is not a new syntax, it is a **convention**:

> A form field's `name` is the config key; `text` gives a string, `number` gives a
> number (`NaN` when unparseable, so the schema fails loudly), `checkbox` appears only
> when ticked; an empty string counts as unfilled and the whole key is omitted; only
> the fields the current mode draws are read.

The implementation of that convention is today's `formReaders`
(`core/manifest.ts:273`) — that function already implements the rule most easily got
wrong, "only read the current mode's fields", including why (a host filled in under
fields mode must not be sent as an override after switching to url mode, or it connects
somewhere else).

**The verification is the migration itself**: after the five built-in packages'
`assembleConfig`s are deleted, `connect-form.test.ts` must pass in full with not a line
changed. Having to change it means the convention was drawn too small — the same
technique as the `VectorView` falsification test.

#### (b) The three display strings → **code, computed once, stored in the snapshot** (changed 2026-08-10; the original plan was templates)

> This section overturns the passage below it. The original plan was "the three
> display functions become interpolation templates"; the implementation followed it and
> ran into its own red line while **deriving the fifth rule of syntax backwards**. The
> old plan is kept below, because where it went wrong is the most valuable passage in
> this design.

**How it ran into it**: translating the six packages' `endpointSummary` /
`defaultConnectionLabel` / `connectionDetail` into templates one by one, the syntax had
to grow one rule at a time — defaults `{port:5432}`, fallback chains `{host|url.host}`
(use the host parsed out of the URL when the config has none), derived values
`{url.host}` / `{file.base}`, omit when equal to the default `{/db?0}`, omit a fragment
whole `{user@}`. Five rules in, `connectionDetail` still could not be expressed:
`hostPort(host, port)` outputs **neither host nor port** when host is missing, which
needs a sixth rule for grouping.

The original plan wrote it itself: "it is the vocabulary's **last** rule: one more
built-in package it cannot express and the correct response is to admit templates are
not enough, not to keep adding syntax." — done.

**Why the original plan was looking in the wrong direction from the start**: it assumed
these three functions had to become data, on the grounds that the renderer calls them
(`connectionRows.ts` calls label and identity, `Sidebar.tsx` calls detail) and the
window cannot execute a package's JS. The first clause is true; **the second does not
follow** — what the window needs is those **strings**, not the code that produces them.

**And a config is immutable.** Once a connection's config is stored in the connection
book it never changes, so these three strings **are computed once and never
recomputed**:

```
conn.open arrives
  → ask the package: what are this config's label / detail?
  → the two strings are stored into the Workspace along with the connection
  → the snapshot broadcasts them; the renderer reads the fields and no longer calls functions
```

Three implementation details differ from the picture above, noted on 2026-08-10 — **the
code is right, the picture was once too tidy**:

- **Two are stored, not three.** (**Void as of 2026-08-11, see §4ter(a)**: after step 4
  it is three.) `endpoint` is not stored, it is computed fresh for every receipt
  (`mcp/summary.ts`'s `connTarget`). The reason is that its readers differ from the
  other two: `label` / `detail` cross a process boundary to be drawn by the window,
  while `endpoint` only assembles one line of an MCP receipt inside main. Adding a
  snapshot field for a string that never leaves main is one more place that can fall out
  of sync with the config.
- **The picture's "the snapshot broadcasts them" is imprecise; `WorkspaceSnapshot`
  carries only `label`.** What the window reads is not the snapshot but the complete
  `Workspace` coming out of `store/sanitize.ts`'s `redactWorkspace` — that is the path
  `detail` takes. `WorkspaceSnapshot`'s readers are all inside main (MCP's
  `briefConnection`, the agent's context document), and that address line in an MCP
  receipt is already `endpoint`: it is assembled for the model (defaults filled in, no
  synthesised URL), while `detail` is the same address written for a human, and two such
  lines side by side only add a decision for the reader who has to act on them. So
  `ConnectionSummary` **does not carry** `detail` (added once on 2026-08-10, had no
  reader at all, deleted the same day). `identity` is likewise not on the snapshot:
  pairing a live connection with a connection-book entry happens in the window, and it is
  also the key used as an admission credential.
- **This step runs inside the synchronous reducer** (`bus/handlers/conn.ts`), not
  asynchronously. During Phase B the packages were still compiled into the same process,
  so it could be called directly. **Step 4, which moves it into the package host, must
  split this call site**: the reducer fills in an empty string first, and the effect
  patches the answer back once it has it — the reducer cannot `await`, which is the other
  side of the invariant in §2.4bis(e). Written here so nobody later tries to make the
  reducer async.

Connecting is itself a several-hundred-millisecond asynchronous operation, so one more
process round trip is imperceptible — and it is cheaper than the view case in
§2.4bis(e): view state changes, a connection config does not.

So these three **stay as code** (in `contrib.mjs`, running in the package host), their
expressiveness is unconstrained, and the six built-in packages' behaviour can be
**preserved word for word** — which also turns §4.1's fourth criterion, the word-for-word
comparison, from "are the templates enough" into "did the migration get anything wrong",
a far weaker requirement.

**The three switches in core are therefore deleted, not rewritten.** `capability.ts`
keeps only `redactConnectionConfig` (next section, it has to be data) and the small
helpers used for joining strings.

##### `connectionIdentity` is not among them, and must not be

It is data (a list of field names), and **this one is a security requirement, not an
expressiveness one**: identity decides which connection a saved credential belongs to
(`config/connection-book.ts`). Letting the package compute it means letting the package
decide "is my connection the same as yours" — a malicious package only has to make two
configs return the same identity to read out another connection's password. **The
kernel must compute it itself.**

Fortunately all six packages' identities are exactly field lists, without exception:

```jsonc
"identity": ["url", "host", "port", "database", "user"]   // postgres / mysql / neo4j
"identity": ["url", "host", "port", "db", "username"]     // redis
"identity": ["url"]                                       // qdrant
"identity": ["file"]                                      // sqlite
```

`driverId` is prepended by the kernel and URLs always go through `stripUrlPassword`
first — both are kernel behaviours, not package declarations.

##### (b-2) The connection book stores those two strings too — decided 2026-08-11

Implementing §2.4bis left a debt behind, and that comment line in the build guard's
allowlist has been pinned to it ever since: `config/connection-book.ts`'s
`toSavedConnection` calls `connectionLabel` / `connectionDetail` synchronously **for
every archived entry**, so main has to be able to reach the package's `display.ts`.
Today it is only "main's graph has five more modules in it", tolerable during Phase B.

**Step 5 turns it into a blocker**: once the packages move to `~/.peek/packages/`,
`display.ts` is not in the app's build graph at all, and main **cannot call it**. And
`book.list()` has to answer with every archived entry's name before any connection is
established (the sidebar has to draw the moment it opens) — at which point not one
package host has started, and forking six of them to draw a row of labels is not
something to do.

**Decision: the connection book stores `label` and `detail`, the same as the
Workspace.** This is a disk format change.

Three rules:

1. **Written at `remember()` time.** At that moment the connection has just been
   established and the two strings are already computed on the Workspace, so they go
   straight to disk with nobody to ask.
2. **An old archive missing the two fields → leave them empty, backfill on the next
   connection.** No migration script, no batch recomputation at startup (that is
   precisely "fork six processes to draw labels"). An old record that has never been
   connected to shows as its own `label` field or its driverId, which is the behaviour
   from before `defaultConnectionLabel` existed, not a new regression.
3. **The config changed → recompute** (editing a connection, changing a port), through
   the same `remember()`.

The landing is recorded in §4sexies — on disk it is a nested `display` (the top-level
name `label` was taken by an older version), an empty string as the "never computed"
sentinel, and one prediction that measurement overturned.

This and §2.3(b) are the same argument extended: **a config is immutable, so the strings
are computed once**. The configs in the connection book are equally immutable, so they
are equally computed once. There is only one genuinely new element — a connection book
record **outlives every process**, so what it stores is the strings rather than the
ability to recompute them.

##### The split table (this document's actual conclusion)

| | form | who computes | why |
|---|---|---|---|
| `connectForm` / field schema | data | kernel | the window has to draw it |
| `assembleConfig` | **convention**, nothing declared | kernel | see (a) |
| `redact` | data (field → rule) | kernel | security-critical, and it has to be synchronous (§2.3d) |
| `identity` | data (field list) | **kernel, and it must be** | previous section |
| `label` / `detail` / `endpoint` | **code** | package host, **computed once** when the connection is established | this section |
| `autoFetch` / `describe` / `title` / `collectionRef` | code | package host, prefetched before reducing (§2.4bis(e)) | the state changes |
| tool handlers | code | package host | asynchronous to begin with |

One rule running through it all, worth stating on its own: **whatever decides "who is
who" or "what has to be wiped" is computed by the kernel; whatever decides "what it
looks like" is computed by the package.** Getting the former wrong is a security
incident; getting the latter wrong is ugly.

---

<details>
<summary>The original plan (interpolation templates) — rejected, kept because where it went wrong has value</summary>

#### (b-old) Three display templates → one interpolation vocabulary

`endpointSummary` / `defaultConnectionLabel` / `connectionDetail` all three "assemble a
human-readable string out of a config"; they are written differently but they have the
same shape. Unify them into one template:

```jsonc
"endpoint": ["{url}", "{host:localhost}:{port:5432}/{database}"],
"label":    ["{database}", "{url.database}", "{host}:{port}"],
"detail":   ["{url}", "postgres://{user@}{host}:{port}{/database}"]
```

Four rules, each one forced out by some built-in package:

1. **An array = candidates, and the first one that fills completely wins.** postgres's
   `endpointSummary` is `if (config.url) return config.url; else …`;
   `defaultConnectionLabel` is a four-level `??` chain. Both are this shape.
2. **`{key:default}`** — redis's detail hard-codes `host ?? 'localhost'` and
   `port ?? 6379`.
3. **`{url.host}` / `{url.port}` / `{url.database}`** are derived values parsed out of
   the connection string. qdrant's label rests entirely on it (url is its only field);
   today they come from `urlParts` in core, and that function is kept as is and made
   visible to template evaluation.
4. **`{prefixkey}` / `{keysuffix}`** — omit a fragment whole. postgres's detail has
   `user === undefined ? '' : \`${user}@\``, which is this rule; `{/database}` likewise.

**There is one thing this vocabulary cannot express, recorded faithfully**: redis's
`defaultConnectionLabel` has a special case where the logical database index is not
shown when it equals 0 (the comment on that branch in `capability.ts` explains it: it is
part of the name only when it is not the default database everybody is already in).
Templates have no conditional comparison.

**Decision: add the `{/db?0}` rule (omit the fragment whole when the value equals it),
because it is not a shape unique to redis** — "do not say it when it equals the default"
is an omission rule shared by ports, schemas and logical databases. But it is the
vocabulary's **last** rule: one more built-in package it cannot express and the correct
response is to admit templates are not enough and go back to the road §3.2 rejected, not
to keep adding syntax.

The template evaluator lives in core (`packages/core/src/manifest-template.ts`, new),
because both the renderer and main need it, and because it has to run on the same side
as `redactConnectionConfig` — a template evaluates an **already redacted** config, and
that cannot depend on the caller remembering.

</details>

**Do not implement the folded section above.** It is the plan (b) overturned;
`manifest-template.ts` does not exist and should not. It is kept because "inventing a
language for a display string" is a detour worth the next person seeing — and because of
how it was dissolved by the single sentence "what the window wants is the string, not
the code that produces the string".

#### (c) i18n: the package carries its own strings (decision 3)

`ConnectField.labelKey` points into the renderer's shared catalogue. A third-party
package's field names (`keyspace`, `bucket`, `clusterUrl`) are simply not in that
catalogue, so this does not hold for it.

The boundary doc §2.4 set the "i18n does not go into packages" rule on the grounds that
dragging the i18n runtime and two language catalogues into every driver package for the
sake of two driver-specific keys is not worth it. **That reason holds for built-in
packages and does not hold for third-party ones** — the trade-off did not change, its
scope never covered them.

Fields carry their text directly in the manifest:

```jsonc
{ "name": "host", "type": "text", "label": { "en": "Host", "zh-CN": "主机" },
  "default": "localhost", "required": true, "mono": true }
```

Three rules:

- **`en` is required**, other languages are optional, and a missing one falls back to
  `en`. This is the same existing rule as `describe` / `skill` / `ResultMeta.summary`
  (model-facing text is always English), only with a human-facing translation layer added
  on top.
- **No i18n runtime, just a lookup table.** What the package gives is a literal, not a
  message template with interpolation parameters — `PlainMessageKey` was narrowed to "the
  subset of keys without interpolation parameters" precisely to make `t(field.label)`,
  a call the compiler cannot see, safe; now there is no call at all, only a lookup.
- **The six built-in manifests change to carrying their own strings too** (decision 1
  requires being exactly on par). That batch of `connect.field.*` keys is deleted from the
  renderer's catalogue.

**The cost, written where it can be seen**: after this change, the same "Host" label is
written six times over, once per package. Today it is in one place.
`manifest-labels.test.ts` has to be rewritten to assert **every label in every manifest
has an en**, rather than asserting the key exists in every language's catalogue — the
latter has no subject any more. Wording consistency now rests on people, not on types.

#### (d) `redact` / `identity` → field lists

```jsonc
"redact": { "password": "value", "apiKey": "value", "url": "url-password" },
"identity": ["host", "port", "database"]
```

`redact`'s two values correspond to the two things `redactConnectionConfig` does today:
replace the whole value with `***`, or wipe only the password out of the URL's userinfo
(`redactUrlCredentials`).

**A package with no `redact` block has its config broadcast verbatim** — that is
plugin-architecture's decision 5, not a choice made here. The warning that goes with it
is implemented here: loading a package with no `redact` block records a warning in the
error centre (a warning, not an error; it does not block loading), saying that this
connection's config will go into MCP receipts and the renderer verbatim. **That warning
is decision 5's only backstop, so §4 requires it to have an inverse check.**

##### (d-1) Declaring them traded away a compile-time check, and the replacement is a test, not a type (added 2026-08-10)

Before the split, `redact` and `identity` were exhaustive `switch`es over a
discriminated union, and a misspelled field name failed compilation on the spot. Now
they are `Readonly<Record<string, RedactRule>>` and `readonly string[]`, and an index
signature admits any key — this is not a leak, it is **a check with no replacement**.
Both ways of misspelling are silent: `redactConnectionConfig` skips fields the config
does not have (`{ passwrd: 'value' }` wipes nothing, and the plaintext goes into the MCP
receipt, the renderer broadcast and the command log on disk, none of the three having a
by-field-name backstop), and `connectionIdentity` reads a missing field as an empty slot
(one misspelled entry means that entry does not take part in discrimination, and two
connections differing only in it share one keychain entry).

Narrowing back to `keyof ConnectionConfig` only works while "the six branches are
written in core" holds, and a disk package carries its own field table, so the
replacement is a test:
`apps/desktop/src/drivers/__tests__/manifest-declarations.test.ts` asserts, for every
manifest, that every entry of `Object.keys(redact)` and of `identity` is among that
branch's shape keys in `ConnectionConfigSchema`. The same kind of replacement as
`manifest-versions.test.ts`.

A third assertion on top of that: **a config with a `url` field must declare a rule for
it.** `url` is the one field the kernel judges by name (`connectionIdentity` calls
`stripUrlPassword` first, and the connection book never writes it to disk verbatim),
because userinfo in a connection string is a password wherever it appears.

##### (d-2) qdrant's `url` is a behaviour fix, not part of the migration (added 2026-08-10)

§4.1 requires the migration to **preserve word for word** the six packages' behaviour
today. qdrant's `redact` is the **exception** to that, written out here: the old switch
listed only apiKey, so the `s3cr3t` in
`{ driverId:'qdrant', url:'http://admin:s3cr3t@qdrant.internal:6333' }` goes into MCP
receipts verbatim. **This is an old hole, not a regression introduced here**, and a
faithful migration would carry it across.

The reason for changing it is that two other tables in the same repo already treat it as
a secret: `config/connection-book.ts`'s `stripSecrets` runs `stripUrlPassword` on it,
and `store/sanitize.ts`'s `SECRET_FIELDS` contains `url`. Once "what is a secret" is
lifted into a declaration, this is the one place where the declaration disagrees with
those two tables — hence `redact: { apiKey: 'value', url: 'url-password' }`.
`connection-label.test.ts`'s qdrant assertions are unaffected: those three display
functions receive the raw config, and redaction happens at the caller.

##### (d-3) Every redaction path becomes rules-driven, with one exception left (added 2026-08-10)

The premise "packages come from disk" requires every redaction path to read `redact`, or
else a disk package declaring `redact: { token: 'value' }` gets correctly wiped by
`redactConnectionConfig` and written out verbatim by some path with hard-coded field
names.

`config/connection-book.ts`'s `stripSecrets` therefore changes to iterating that
config's `redact` (`'value'` deletes the field, `'url-password'` goes through
`stripUrlPassword`). The six built-in packages' behaviour is unchanged word for word —
the three names it used to hard-code are exactly the three the six packages declare.
In reverse: write postgres's `redact` as `{ passwrd: 'value' }` and
`connection-book.test.ts`'s "the password does not go into the file" goes red on the
spot.

**One exception, `store/sanitize.ts`'s `SECRET_FIELDS`.** It cannot do this: a patch has
only a path and a value, and there is no `driverId` to look up in
`['connections', id, 'config', field]`. Looking one up would mean threading the
post-change workspace from `ipc-main.ts` all the way into `redactPatches`. Today it is
unreachable — a config is only ever written whole (`conn.open` swaps out the entire
`ConnectionState`), `store/mutations.ts` does not touch `config` at all, immer cannot
generate a patch that deep, and anything that does arrive is caught by the layer above
by the rules-driven `redactMaybeConfig`. **It stays, but with it written in the code
that it is now decoupled from `redact` and what would break it** (the first mutation that
assigns a single field) — nothing that looks rules-driven while not being it is left
around.

### 2.4 Who loads what — not one line of package code in the main process

| process | loads what | how | on uninstall |
|---|---|---|---|
| **main** | **nothing at all** | — | — |
| **renderer** | manifest data only | over IPC from main, **never imports a package's files** | deregister the registration, redraw |
| **package host** | `contrib.mjs` | its own utilityProcess, dynamic `import()` | **the process exits, the code really is gone** |
| **driver-host** | `driver.mjs` | its own utilityProcess (one per connection), dynamic `import()` | **the process exits, the code really is gone** |
| **iframe** | `ui/` | `peek-package://<id>/` | the view closes, the realm is destroyed |

`contrib.mjs` exports two things, both of them types Phase B already settled:

```ts
export const tools: readonly ToolSpec[]                  // the contract in core/mcp-tools.ts
export const viewKinds: readonly ViewKindRegistration[]  // the contract in core/view-kinds.ts
```

Why the function half of a view kind is in `contrib.mjs` rather than in the manifest —
§2.1 already said it, that is the whole security story of a self-drawn view.

`driver.mjs` exports an array of `Driver`, which is exactly the shape
`startDriverHostProcess` takes today (`driver-host/entry.ts:43`). entry.ts changes from a
static import table to "find the package directory by the driverId in `connect`'s params
and dynamically import its `driver.mjs`".

**How the renderer gets the manifests**: today a static import, after Phase C over IPC.
The shape copies `mcp.read` / `settings.read`: a `packages.read` command returns the
manifest data for every loaded package, plus a patch broadcast whenever the package set
changes. The connect dialog therefore goes from "synchronously reading a module constant"
to "reading a piece of state that arrives asynchronously" — this is the only real change
on the renderer side, with `ConnectDialog` and `connectForm.ts` following along.

`COMMAND_NAMES` gains four. **These four are kernel verbs and belong to no database** —
the same reason as plugin-architecture §2.3bis(c)'s conclusion about those 32 command
names:

```
'packages.read'        list the loaded packages (manifest data + origin: bundled / user-installed)
'packages.install'     install from a local directory
'packages.uninstall'   uninstall; for a bundled package, also write a tombstone
'packages.restore'     clear the tombstones and lay the bundled packages out again
```

**`packages.restore` is the fourth, added 2026-08-11**; this section originally said
three. It is not a new requirement: §2.5's rule 3 and §2.8 have called for this entry
point since the first version, and acceptance criterion 14's second clause (click
"restore bundled packages" → it comes back) has been in the acceptance table all along;
what was owed was only a verb. §4quaterdecies(i), landing the three verbs, filed it as a
matter for "§2.4's command table and §2.8's settings panel"; this is that debt.

**Why it cannot be `packages.install`.** The reason there is no `packages.upgrade` is
that upgrading is installing onto the same id again, and one more verb only means one
more validate-then-replace. Restore is not that shape:

- its input is not a directory the user picked but `bundled-packages/` inside the app
  bundle, and the caller should not even know the path — that is `bundledPackagesRoot()`'s
  answer, not the command's parameter;
- it has to **clear the tombstones** first, and tombstones are something
  `packages.install` does not touch at all (installing your own postgres should not
  incidentally revoke the decision "I do not want the bundled one");
- it is **batched**: one call may bring back four packages, or none at all (when nobody
  has uninstalled anything), whereas `PackagesInstallResult`'s `id` / `version` /
  `replaced` are all singular.

So it is a fourth verb rather than a flag on `install`. What it reuses is the
**execution path**, not the command: after clearing the tombstones it calls the same
`layOutBundledPackages` that startup calls, with not a line changed — see
`clearTombstones`'s comment, where "two steps rather than one" was left for it from the
beginning.

**`packages.install` does not download.** Its parameter is a local path. "Install from a
URL" means peek fetching executable code from an arbitrary URL, which is a distribution
problem rather than a loading one, and §1.5 puts it outside the boundary.

**`packages.install`'s parameter is one of two: `{dir}` or `{bundledId}`** (the second
branch added 2026-08-11). The second branch exists so §2.5's rule 2 "upgrade" button can
be clicked in the window. Three sentences derive it: rule 2 says peek does not accept a
bundled package's upgrade automatically, **the user clicks**; §2.4 says there is no
`packages.upgrade`, because upgrading is installing onto the same id again; and
`PackageListing` per §1.4 **carries no filesystem path whatsoever** (the window should
not be handed a path inside the app bundle in exchange for a value it does not need).
The three together mean the window must be able to name a directory by "the id this build
ships with" — which is `bundledId`, resolved by main into `<bundledRoot>/<id>`.

**What changes is only who assembles that path, not what installing means**: after
resolution it goes through the same `installPackage`, the same full validation, the same
staged copy, the same atomic rename, the same receipt. So it is not a fifth verb.

### 2.4bis The package host: why not one line of package code may be in the main process (decision 7)

#### (a) The chain of reasoning

Decision 6 says no signature / hash verification. So **nothing stops a malicious package
from being installed**, and the only thing left to tighten is "what it can touch once it
is in".

The middle road considered and rejected: statically scan `contrib.mjs` and forbid it
from importing `electron` / `node:fs` / `node:child_process`. The repo's
`subpath-purity.test.ts` already does this kind of scanning, at nearly zero cost.
**Not enough** — a malicious package writes
`globalThis.process.mainModule.require('fs')` and it is routed around, because a static
scan cannot see through a runtime lookup. **A scan stops accidents and laziness, it does
not stop an attack.**

A process boundary is enforced by the operating system and cannot be routed around. So
it is the only effective one after decision 6.

#### (b) What the main process is worth

plugin-architecture §1.2d quantified it. The most important line:

> **`safeStorage.decryptString` can decrypt every saved credential.**

Not the ones for its own database — **all of them**. Today a neo4j package can read out
every PostgreSQL password the user has, and that has nothing whatever to do with its
function. On top of that: rewriting `mcp.json`, leaking or re-signing bearer tokens, and
dispatching any command **as any `CommandSource`** (`executor.ts:44`'s `source` is just an
ordinary parameter) — the last of which punches straight through the whole attribution
design in PLAN §10, "record the initiator on the thing being created".

#### (c) Shape: lazily started, one per package

One `utilityProcess`, `serviceName: peek-package-<id>`, **forked only when computation is
genuinely needed for the first time**. Zero processes on the startup path — this is the
precondition for acceptance criterion 20 (installing 20 packages does not affect cold
start) passing; forking 20 processes at startup for 20 packages is guaranteed to blow it.

`env` is given per §2.10's allowlist, the same rule as driver-host.

One per package rather than one shared: sharing means two packages in the same JS realm,
able to modify each other's prototypes and read each other's closures — which hands
"packages do not trust each other" back to convention.

#### (d) The split: the manifest holds metadata, `contrib.mjs` holds computation

This is why (c)'s lazy start can work. Two things are each split in half:

| | manifest (pure data, read at startup) | `contrib.mjs` (has to compute, the process starts when used) |
|---|---|---|
| tools | `name` / `description` / `inputSchema` / `kind` / `hasRenderer` / `title` / `annotations` | handler |
| view kinds | `kind` / `driverIds` / `titleKey` | `autoFetch` / `describe` / `title` / `collectionRef` |

(The last four fields on the tools row were added on 2026-08-11 by §4duodevicies: the first
three are enough to **list** a tool, not enough to **construct** a callable one, and
construction happens in main, before any fork.)

So MCP's `tools/list` can be answered from the manifest alone (listing tools requires
executing no package code), and the connect dialog's "which views can this connection
open" likewise reads only the manifest. **Only actually calling a tool, or actually
opening a package view, forks that package's host process.**

#### (e) `autoFetch` is synchronous — prefetch before reducing

`autoFetch` is called **synchronously** inside immer's `Draft<Workspace>` reduce
(`bus/handlers/shared.ts:441`), and its return value is used on the spot to start the
fetch. A cross-process call is asynchronous, so this is not simply "add a layer of RPC":
the synchronicity of Command reduction is one of this codebase's core invariants, and
changing it costs far more than what this document is buying.

**The solution is to move the asynchrony ahead of the reduce, not to make the reduce
asynchronous.** *Handling* a Command is asynchronous to begin with; only the *reduce
itself* is synchronous:

```
today:  view.update arrives → synchronous reduce (the reduce calls the package's autoFetch)

after:  view.update arrives
        → ask the package host asynchronously: under the new state, what do you want to
          fetch, what is it called, how do you describe it?
        → get back a PackageContribAnswer (fetch plan + title + describe)
        → synchronous reduce (use that answer to start the fetch and write it into the view
          state; the reduce no longer calls any package code)
```

The reduce is still synchronous and atomic, and the semantics are word for word the same
for the user (state changed, so the fetch started).

**One round trip fetching three answers, because the latter two are on the hot path.**
`title` and `describe` are called by `snapshotWorkspace`, and a snapshot happens on every
patch broadcast and every MCP `read_workspace` — making them cross a process boundary
would turn a pure synchronous function into IPC on the hot path. So they are computed
before the reduce along with the fetch plan, and **the results are stored into
`ViewState`**, so a snapshot just reads a string.

The cost: one extra process round trip (milliseconds) on `view.open` / `view.update`'s
handling path. These two commands are triggered by a person clicking or a model calling,
not per frame; it is invisible.

#### (f) A by-product: uninstall semantics get clean

The original plan (`contrib.mjs` dynamically imported in the main process) had one thing
it could not do: the ESM module cache cannot be cleared, so after uninstalling the
package's code is still in the main process's memory, and the honest thing to say is
"uninstalled", not "completely removed".

**Decision 7 makes this go away.** The package host is its own process, killed on
uninstall, and the code really does leave memory — exactly like driver-host. So §2.8's
three "cannot do" items are now down to two.

#### (f-bis) The protocol: copy driver-host, do not invent a second one

peek already has a "main ↔ utilityProcess" RPC that runs the whole of driver-host
(`core/driver-host.ts`'s `HostInbound` / `HostOutbound`, `connections/host-process.ts`'s
process wrapper). Its shape is: `{kind:'req', rid, method, params}` /
`{kind:'res', rid, ok, result|error}` / `{kind:'evt', type, …}`, correlated by rid,
timeouts owned by main, and every in-flight request collapsing to `DRIVER_CRASHED` when
the process dies.

**The package host uses the same one**, with four methods:

| method | when it is called | returns |
|---|---|---|
| `display` | when the connection is established, once | `{label, detail, endpoint}`, three strings |
| `viewAnswer` | **before** the `view.open` / `view.update` reduce | `{fetch: PackageAutoFetch\|null, title, describe}` |
| `callTool` | when an MCP tool is called | see below (**changed 2026-08-11**, originally read "the tool's `ToolOutput`", §4ter(b)) |
| `collectRef` | when a view's `CollectionRef` is needed | `CollectionRef \| null` |

Three rules carried over rather than decided again:

1. **Timeouts belong to main.** Same as driver-host, `timeouts.ts`'s deadline logic is
   used as is — a package with an infinite loop in its `autoFetch` must not make a Command
   never reduce.
2. **A dead process = a structured error, not a hang.** Reuse `connections/classify.ts`'s
   attribution, or a crashed package host presents as "the view stopped moving", which is
   exactly the cost recorded in §2.4bis(g).
3. **`serviceName: peek-package-<id>`**, aligned with `peek-driver-<driverId>`, so it is
   recognisable in Activity Monitor.

**The only new thing is `viewAnswer` packing three answers into one round trip**, for the
reason in (e): `title` and `describe` are on `snapshotWorkspace`'s hot path, and asking
three times turns a pure synchronous function into three IPCs.

#### (g) The costs, stated plainly

- **The implementation scope grows.** One more process type, one RPC, one change to
  reduce ordering.
- **`ViewKindRegistration`'s call convention changes**: from "main calls the function
  directly" to "ask the host for an answer". The types do not change (the signatures of
  those functions in `contrib.mjs` do not change by a word); what changes is who calls
  them.
- **A package's host crashing means its views cannot fetch.** It needs the same failure
  attribution as driver-host (`connections/classify.ts`'s), or it presents as "the view is
  stuck".

### 2.5 Bundled packages: shipped with the app, laid out on first run, uninstallable (decisions 1 + 2)

```
peek.app/Contents/Resources/bundled-packages/<id>/…   read-only, inside the signature
~/.peek/packages/<id>/…                               writable, where things are actually loaded from
```

`install-mac.mjs` `rmSync`s the whole `.app` before every install
(plugin-architecture §1.2c), but `~/.peek/` is not inside the `.app`, so what was laid
out survives upgrades. That brings three rules that have to be settled:

1. **Target does not exist and there is no tombstone → lay it out.**
2. **Target already exists → do not overwrite automatically, compare versions.** The
   user may have manually installed a newer version, and pushing it back to the old one
   during an app upgrade is the worst failure shape (someone debugging by version number
   would rule out the build that is actually running — `manifest.ts` has already written
   this sentence). A bundled package with a higher version shows in settings as
   upgradeable, and the user clicks.
3. **Uninstalling a bundled package → write a tombstone.**
   `~/.peek/packages/.uninstalled.json` records `{id, version, at}`. Without the
   tombstone, PostgreSQL comes back on the next start after being uninstalled, and the
   uninstall button is a lie.

The settings panel gets a **`恢复自带包`** entry point: clear the tombstones and lay them
out again. This is decision 1's safety net — after a user uninstalls PostgreSQL, the way
back to it has to be one click, not reinstalling the app.

**Version comparison uses semver's first three segments**, without a full ordering for
prerelease tags. Package versions are all `0.0.1` today, and a complete semver
implementation would be the one piece of code in this document with no consumer.

### 2.6 Opening up `DriverId`

`DRIVER_IDS` goes from six literals to "a set registered at run time". Four exhaustive
switches and one discriminated union follow:

| today | Phase C |
|---|---|
| `DriverIdSchema = z.enum(DRIVER_IDS)` | `z.string().regex(PACKAGE_ID)`, with actual existence decided by the loader's registry |
| `ConnectionConfigSchema`, six-branch discriminated union | `z.object({driverId, label, …})` + **a second validation against the field schema the manifest declares** |
| `redactConnectionConfig`, five-branch switch | look up the manifest's `redact`; with none, return verbatim + a warning (decision 5) |
| `defaultConnectionLabel` / `connectionDetail` | **both functions are deleted** (§2.3b). Replaced by the package's `DriverDisplay.label` / `.detail`, computed once when the connection is established; **throw if no implementation is found** |
| `connectionIdentity` | look up the manifest's `identity` field list; **throw if not found, with no fallback of any kind** |

> These two rows were changed on 2026-08-10, because they originally described the
> template plan that §2.3(b) overturned, **and because the second one taught a fallback
> that would cause a security incident**. "No identity, so fall back to comparing all
> fields" sounds like a mild degradation; what it actually is: every connection of an
> unknown driver may match somebody else's keychain entry. The `connectionIdentityOf`
> comment in `drivers/manifests.ts` already rejects this explicitly — "an empty field
> list, or all fields — differ by whether every such connection collapses into one
> identity. That is a keychain read for the wrong server, so it throws instead".
> **The code was right, the document was wrong.** Recorded here rather than quietly
> fixed, because "not found, so use a permissive default" is an intuition that keeps
> coming back, and on identity it happens to be the single most dangerous answer.

**The declaration form for field schemas** reuses the connect form's existing type
vocabulary (`text` / `password` / `number` / `checkbox`) rather than introducing a second
one. The reason is the one the boundary doc §3.4 verified: hand-writing a mirror table is
both bigger than reusing the existing one and prone to drift — the connect form already
states every field's name and type once, and a config schema stating it again is that
mistake. **The field list is the schema**, plus two modifiers only the schema cares about
(`min` / `max`, which ports need).

After this change `ConnectionConfig` goes from a discriminated union to an open record,
and **the two call sites inside core (`workspace.ts:938`'s `snapshotWorkspace`) have to be
able to look up manifests**. The boundary doc §2.5 originally refused to move these four
switches into packages, on the grounds that "core would need to look up a manifest, and
driver packages depend on core, so the dependency graph would invert". **In Phase C that
reason disappears** — the manifest is no longer a module exported by a package, it is data
read from disk, and core taking a `ManifestLookup` parameter constitutes no dependency
inversion. The `ManifestLookup` type already exists at `core/manifest.ts:327`.

### 2.7 Hot reload: what it can do and what it cannot (decision 4)

**Installing a package**, with no restart anywhere:

1. read the manifest → full validation (every field in §2.3,
   `validateViewKindRegistration`, the id being serviceable) → any one failing rejects the
   whole package and reports what is missing;
2. register the manifest → broadcast to the renderer;
3. `import()` `main.mjs` → register tools and view kinds;
4. MCP sends one `notifications/tools/list_changed`;
5. it can be picked in the connect dialog immediately.

`driver.mjs` **is not loaded at this point** — it is `import()`ed on the first connection
by that connection's own driver-host process. This comes free from peek's process model:
**one utilityProcess per connection**.

**Uninstalling a package**:

1. disconnect every connection on that package's driverIds (each connection's
   utilityProcess exits);
2. close every view the package contributes, **degrading to an explicit error panel
   rather than a blank screen** (acceptance criterion 13);
3. deregister the view kinds, tools and manifest;
4. MCP sends another `list_changed`;
5. delete the directory; for a bundled package, write a tombstone.

**The two things it cannot do, with their exact boundaries.** (There were three — the
first, "`main.mjs`'s code stays in the main process's ESM cache", was eliminated by
decision 7, see §2.4bis(f): a package's code now lives in its own process, and killing it
really does make it go. **Those three words "kill it" are just as necessary on the
install path as on the uninstall path**, and writing them into a sentence that only
covers uninstall is one of the defects §4sexvicies fixed: swapping the files without
swapping the process means the version number moved while the code that does the
arithmetic did not. The "installing a package" table above is therefore one step short —
between steps 1 and 2 the package host for that id has to be killed, see
§4sexvicies(a).)

1. **`MCP_INSTRUCTIONS` is fixed at `initialize` time** (`server.ts:243`), so a package's
   skill does not take effect for an **already established** MCP session; only a new
   session reads it. This is at the MCP protocol level, not an implementation choice —
   `tools/list_changed` has a corresponding notification, instructions do not.
   It incidentally fixes half of the known cost recorded at `manifest.ts:132`: a package
   that is installed but never connected to still contributes its skill, but **an
   uninstalled package no longer contributes**, whereas in Phase B it was compiled in and
   there forever.
2. **`capabilities.tools.listChanged` has to change from `false` to `true`.**
   plugin-architecture §2.4's item 2 filed this under "Phase B chooses new-session-only,
   re-evaluate in Phase C". The evaluation is done: decision 4 requires hot reload, so it
   must declare `true` and actually send the notification — declaring `false` while
   changing the tool list is lying to the protocol, which is worse than restarting.

**The driver half is clean by comparison, and deserves its own note**: on uninstall those
utilityProcesses really do exit, and `driver.mjs` leaves memory along with the database
client inlined into it. "One process per connection", a design made for fault isolation
(PLAN §3), hands complete code-unload semantics over here for free.

### 2.8 The settings panel

`PackagesSection` goes from a read-only table to:

- every row gains a **`来源`** (bundled / user-installed) and an **`卸载`** button;
- when a bundled package's version is lower than the one the app carries, show
  **`升级`**;
- an **`安装…`** (pick a local directory) at the top, **`恢复自带包`** (clear the
  tombstones and lay them out again) at the bottom;
- the sentence `这些包是编译进这份 peek 的，暂时没有可安装或卸载的东西` is deleted.

The three existing comments (capability names are not translated; the version number is
the package's, not the server's; view kinds are listed separately rather than made a
column of the table) all continue to hold, with not a word to change. The UI keeps the
two words `数据库` and `连接器版本` (§0.1).

#### (a) A row is a package, but every database still takes a row (settled 2026-08-11)

That sentence above, "every row gains an uninstall button", has a question the first
version did not answer: **a row of the table is a driver today, and the unit of
uninstalling is a package.** The one `db-sql` package provides two databases, `mysql` and
`sqlite`, and doing it literally would draw two uninstall buttons, either of which takes
both databases away.

Switching to "one row per package" is not an option either: `capabilities` are declared
per driver, and merging a package's two drivers' capabilities into one cell becomes a lie
the day they differ (`mysql` and `sqlite` sharing `SQL_CAPABILITIES` today is a
coincidence, not a constraint).

So: **the `数据库` / `连接器版本` / capability columns still hold one driver per row, and
the origin and action columns `rowSpan` across all the rows of the same package.** This is
not a layout trick, it is the shape of the fact — an uninstall button spanning two rows
says on the spot "this takes both of these databases away", while two buttons side by side
say the opposite. The existing comment about "three values compared down one column"
therefore continues to hold: the three compared columns are still one driver per row.

#### (b) Where the data comes from: `packages.read`'s list + the manifests in the registry

`PackageListing` has only `id` / `version` / `source` / `upgradeVersion` / `driverIds` /
`viewKinds` / `toolNames` — no `displayName`, and no `capabilities`. Those two are in
`driverManifests()`, which is synchronous. So the panel reads two places: **the set of
rows and their origin come from `packages.read`, and each row's display name and
capabilities come from the registry**, joined by `driverIds`.

The two are briefly out of sync: `PACKAGES_CHANGED` arrives, the registry is swapped
immediately, and the resent `packages.read` is still in flight. In that frame a driver id
may have no manifest to look up — draw the id itself, do not draw an empty row and do not
throw (`lookupManifest` returning null is a normal value on this path, not an exception).
The reverse holds too: the package is already gone from the list, the registry emptied
first, that row's capability cell is empty, and the whole row disappears on the next
frame.

#### (c) How `安装…` gets a directory: a new R→M channel

`packages.install` wants an absolute path, and the window has no local paths.
`<input type="file">` in Electron cannot give a directory's absolute path (that needs a
main-world API like `webUtils.getPathForFile`), so it is a new `IPC.PACKAGES_PICK_DIR`:
main opens `dialog.showOpenDialog` and returns a path or `null`.

**It is not a command**, for the same reason as `MENU_ACTION`: what crosses over is not a
modification of the truth but one interaction with the window's shell. A user pressing
Cancel in a system dialog should not leave a failed record in the command log. The actual
modification is the `packages.install` that follows, and that goes into the log as usual.

#### (d) Wording: no word that hints anything was checked (§2.9 corollary 1, acceptance criterion 40)

This section is the only place acceptance criterion 40 has UI to scan, so the criteria are
pinned down here:

- the install flow contains no wording like `已验证`, `安全`, `可信`, `signed`,
  `verified`, `trusted`, and no fake progress bar that "checks but always passes";
- when installing finishes it says `已装上 <id> <version>` — **what happened**, not
  **what it is**;
- when uninstalling finishes it says `已卸载`, **not `已完全移除`**: the package's
  directory is gone and the process has been killed, but peek does not know what this
  package wrote elsewhere, and "completely removed" is guaranteeing on its behalf;
- the only sentence about trust is the one that says it straight: what you install is
  what runs, with your own privileges. It is a statement, not a warning — a warning that
  can always be clicked past teaches users to ignore warnings (the DataGrip
  counter-example in §2.9).

### 2.9 The trust model: no checking (decision 1, restated 2026-08-10 as decision 6)

Unchanged: whatever is in `~/.peek/packages/` runs. No signature verification, no hash
verification, no permission declarations, no sandbox, no install-time confirmation.

**This was asked again on 2026-08-10**, in the form of going through a complete list of
Electron security practices item by item against peek's state — and within that list,
"sign and hash every package, verifying at install and at every load" is its **backstop
assumption**: every isolation measure it gives (separate origin, utilityProcess,
MessagePort capability credentials) protects against "a package I trust that may have
bugs", and once verification is removed, what is being faced is "a malicious package".

The user saw that difference and chose the same answer. So its exact meaning has to be
written out:

> **peek's boundary is not a technical boundary, it is a trust boundary.** "What the
> user installs is what the user trusts" — the same tier as VSCode extensions and Claude
> Code's MCP servers, and consistent with peek today (`PEEK_DRIVER_HOST_DIR` already has
> exactly these semantics).

Two things follow, neither optional:

1. **The UI must not imply security.** The install flow contains no wording like
   `已验证` or `安全`, and no "checks but always passes" fake progress. DataGrip's
   "Ignore and Continue" soft dialog is the counter-example — a warning that can always be
   clicked past teaches users to ignore warnings.
2. **Where tightening is possible, tighten all the way** (decision 7 / §2.10). Since the
   entrance has no checkpoint, every structural boundary past the entrance has to be real.

**With an install button, this one's exact meaning has to be restated**, because the
button lowers the threshold from "manually put files into a directory" to "one click". At
the moment it is clicked, what the package gets is (as plugin-architecture §1.2d
quantified):

- **driver-host**: unredacted plaintext passwords, the whole `process.env`, a MessagePort
  into the window's result cache;
- **main**: full node, `safeStorage.decryptString` (**for every saved credential**),
  rewriting `mcp.json`, dispatching any command as any `CommandSource`;
- **iframe**: only that port, `connect-src 'none'` — this layer really is shut.

peek has neither the centralised distribution nor the remote kill switch DataGrip falls
back on. That is a reasonable trade-off for a local development tool, but it has to be
said out loud — so the README's security section is updated in step (plugin-architecture
decision 5's requirement, landed here as well: the feature descriptions at `README.md:31`
and `README.zh-CN.md:26` describe a redaction path backed by an exhaustive switch, and
after packaging that does not hold).

**`PEEK_DRIVER_HOST_DIR` needs validation** (acceptance criterion 12). Not checking
packages is one thing; an undocumented environment variable quietly replacing the process
entry point that handles plaintext passwords is another — the latter is the accident
surface, not the trust surface.

### 2.10 Electron hardening: six items, done together with database packages (decision 8)

The source is the item-by-item review done on 2026-08-10 against a list of Electron
security practices. **This section has nothing to do with database packages** — every item
should be done today, they were just turned up by this review. The user asked for it all
at once, so they go into the same change (the cost is recorded under decision 8).

First, two places already done right that must not be loosened to match the list, because
what they do today is stricter than the common advice:

- **`peek-package://`'s privileges are `supportFetchAPI: false, corsEnabled: false,
  allowServiceWorkers: false`**, where the common advice is to turn the first two `true`.
  peek cannot: the document CSP already has `connect-src 'none'`, and the privileges are a
  second independent declaration of the same rule — "two mechanisms rather than one,
  because they fail differently — a header can be written wrong in this one file, a
  privilege cannot be written wrong from inside the frame" (`packages/protocol.ts:27`).
- **What the iframe gets is a one-shot bounded snapshot, not a two-way query channel.**
  The "package sends a query, host returns a result" MessagePort usage in the common
  advice is not adopted by peek — the front end does not even assemble the statement
  (§2.1).

The six items to add:

| # | add what | today | why |
|---|---|---|---|
| 1 | **`env` allowlist** | `sanitizeEnv` only filters `undefined`, `process.env` is **inherited verbatim** (`host-process.ts:396`) | today a package's driver process can read `AWS_*`, `GITHUB_TOKEN`, proxy configuration. Change it to explicitly listing the handful peek itself needs (`PEEK_CONN_ID` / `PEEK_DRIVER_ID` / `PATH` / platform essentials) and passing nothing else |
| 2 | **`PEEK_DRIVER_HOST_DIR` validation** | zero validation (`manager.ts:128`) | an undocumented environment variable can replace the process entry point that handles plaintext passwords. And once item 1 is fixed it is no longer inherited downward either |
| 3 | **Fuses** | **not one of them** | `RunAsNode` is not off, which means a signed peek binary can be used as a general-purpose Node interpreter, bypassing code signing. **Note `asar: false`** (`package-mac.mjs:215`, on the grounds that forking a utilityProcess at an entry point inside an asar is unreliable), so `OnlyLoadAppFromAsar` / `EnableEmbeddedAsarIntegrityValidation` are **unusable** — what can be turned on is `RunAsNode: false`, `EnableNodeOptionsEnvironmentVariable: false`, `EnableNodeCliInspectArguments: false` |
| 4 | **`will-navigate` interception** | none (only `setWindowOpenHandler`, `index.ts:505`) | the window itself should not navigate anywhere. The iframe even less so — `frame-src` governs whether something can be loaded, not where it goes after loading |
| 5 | **`setPermissionRequestHandler` denying everything** | none | camera, microphone, notifications, clipboard, geolocation — web code inside a package frame needs none of them. **No handler means the default policy**, and the default is not "deny everything". (Added 2026-08-15: peek itself **does** notify the user now, but that is an Electron `Notification` in the main process, it does not go through the permission handler, and it is orthogonal to this item; a package wanting to notify the user has to call `app.notify`, and so shows up in the command log with its name on it. See `2026-08-15-notifications.md` §4.3) |
| ~~6~~ | ~~one separate partition per package frame~~ | **not applicable, see below** | — |

**Why item 6 is struck** (found only on reaching it while working through the list;
recorded so it is not raised again next round):

`partition` in Electron is only a property of `webPreferences` (`BrowserWindow` /
`WebContentsView`) and of the `<webview>` tag. **An ordinary `<iframe>` does not have
it** — it inherits the parent webContents' session, and an ordinary iframe is exactly what
Tier C uses (`PackageFrame.tsx:309`; `<webview>` is officially discouraged and comes with
a batch of its own problems, and is not worth switching to for this).

And it is **not needed**: the list treats partition as a supplement to origin isolation,
but storage isolation is already per origin (`localStorage` / `IndexedDB` / Cache Storage
all are, which is standard browser behaviour, not an extra Electron mechanism). Every
package already has its own origin (`peek-package://<id>`), so "two packages cannot read
each other's cache" already holds.

**What has to be verified did not change, the reason did** — §4.8's item 38 changes from
"verify the partitions are paired up" to "verify origin isolation actually takes effect".
A check that **tests the wrong mechanism** says nothing about the property wanted, even
when it passes.

Item 3 has a **limitation that must be stated**: `asar: false` means peek has nowhere to
put application integrity verification. What fuses turn off is "use peek's binary as
Node"; they cannot turn off "edit `out/main/index.js` and run it". Plugging the latter
means first resolving the conflict between asar and utilityProcess, which is another
round's subject — but under decision 6 its priority is low anyway: **an attacker who can
edit the app's files can also just drop a package into `~/.peek/packages/`.**

Two honest disclosures from the list, with their actual form in peek recorded:

- **`utilityProcess` is not a sandbox.** It is a separate process, it can be killed on
  its own, and its crash does not take the main process down, but it is still full Node
  and can read and write the entire user directory. Real privilege reduction takes an
  operating-system layer (macOS App Sandbox entitlements, Linux bubblewrap/seccomp,
  Windows AppContainer), which is heavy to do across platforms and **is not done here**.
  Item 1 (the `env` allowlist) stops "picking up credentials in passing"; it does not stop
  "going after `~/.ssh/id_rsa` deliberately".
- **Native modules (`.node`) have no answer.** Once loaded they are arbitrary machine
  code, and every restriction at the JS layer stops applying. **peek has no native modules
  today** — `pg-native` / `@node-rs/xxhash` / `@opentelemetry/api` are all three stubbed
  out (`electron.vite.config.ts:89`), which is lucky rather than designed. §3.4 requires a
  package to be a self-contained bundle, and a package carrying a `.node` has no load path
  in Phase C, so this is **incidentally** plugged too; the day it is opened up, it has to
  be decided separately and distinguished from pure-JS packages in the UI.

---

## 3. Trade-offs

### 3.1 Stacking (built-ins compiled in + third parties loaded at run time) — vetoed by the user

This was proposed, on the grounds that it keeps three things: `connectForm.ts:60`'s
compile-time `PlainMessageKey` check, `defineManifest`'s literal fidelity, and six packages
not having to redo their bundling.

The user chose replacement. The cost, on the record: **built-in and third-party have to be
equal in capability, so built-ins lose the compile-time check too** (§0's ledger). What that
buys is the absence of two parallel loading paths — and two paths are exactly the breeding
ground for the class of bug this repo has fixed over and over (boundary doc §1.4's "the
capability declaration points the wrong way" is one loop closing in the wrong direction).
With only one path, every problem a third-party package hits a built-in hits too, and there
can be no invisible gear where "built-ins work and third parties do not" — the DataGrip
warning (§1.6d: the introspector is the gear JetBrains kept for itself) is structurally
impossible under this choice.

### 3.2 Give packages a restricted JS evaluator (in place of §2.3b's templates) — not taken

The template vocabulary has an expressive ceiling (redis's `db === 0` has already forced one
piece of syntax out of it). The apparently more general move is to let the manifest carry a
small expression and have the host run it through a restricted evaluator.

Not taken, for two reasons:

1. **Whether the renderer runs an evaluator or the package's own code makes no difference to
   security.** An evaluator that can read fields, branch, and concatenate strings is a
   language; it runs in the window realm, and the iron rule (§1.3) blocks `script-src`, not
   "an interpreter we wrote ourselves". Going this way means swapping the CSP lock for a
   home-made one.
2. **What it treats is display strings.** All three templates are there to draw labels and
   receipts. Introducing a language for the sake of a connection label puts cost and benefit
   two orders of magnitude apart — and when the template cannot express something, falling
   back to `driverId` is a perfectly acceptable degradation (boundary doc §2.5's own words
   about those three switches are "opening it is only a display degradation").

### 3.3 Require a restart — vetoed by the user

This was proposed. The reason is that the undo path for uninstalling cannot be made clean
(§2.7's three cases), and a restart really would satisfy acceptance criterion 13.

The user chose hot reload. **Acceptance criterion 13 therefore has to be rewritten**: from
"after uninstalling, every tool, view and skill it contributed is gone" to "after
uninstalling, **no entry point can reach it**, and views already open have a defined
degradation". The difference is substantive — the first talks about process memory, the
second about reachability — so it is a rewrite, not a rewording.

### 3.4 Packages carrying their own `node_modules` — not taken

Letting `driver.mjs` keep bare imports, with a `node_modules` tree in the package directory,
was considered. Not taken: §1.2 established that the client is inlined into `driver-host.js`
today, so a self-contained ESM is **a continuation of the status quo** rather than a new
constraint; and laying out a tree means reimplementing `exports` resolution and guessing at
conditional imports (`stage-node-modules.mjs`'s header comment spends a whole paragraph
arguing why it would rather copy 15MB too much than guess).

The cost is that package authors have to bundle. That is in line with VSCode extension
practice, and peek will supply a build script — that standalone UI build script was already
this shape at the time, and one more `build-package-driver.mjs` is the same thing again.

> No extra script appeared when this landed: that UI build script was absorbed into
> `build-packages.mjs`, because a package's four files have to be produced together in order
> to check each other. Reasoning in §4octies(a).

### 3.5 The three renaming candidates (§0.1) — why not connector or plugin

- **connector / `连接器`**: already in use in the interface, and DataGrip uses it too. But its
  meaning leans on the "connect" layer, while a package also carries interface, MCP tools and
  skills — calling it a connector makes the last three look incidental. So it stays where it
  is, still naming that one column of versions (**`连接器版本` = which version of the
  implementation opens this database**), and is not promoted to the name of the whole bundle.
- **plugin**: §0.1 already said it — the name is bigger than the thing.
- **Keep the status quo**: four words in mixed use would carry on forever, and Phase C is the
  last moment at which renaming affects no already-published package.

### 3.6 Static scanning in place of process isolation — not taken (written down so the next round does not relitigate it)

`subpath-purity.test.ts` already scans subpaths for import purity; adding `contrib.mjs` and
banning `electron` / `node:fs` / `node:child_process` costs almost nothing.

Not taken: `globalThis.process.mainModule.require('fs')` gets around it in one line, and a
static scan cannot see through a run-time lookup. Under decision 6 (no validation of any
kind), the threat model is a **malicious package**, not a **careless** one, and scanning does
nothing about the former.

**But the scan still gets done, for a different reason**: it catches accidents and
shortcuts, and it is insurance that we can "move things later" — a module that starts a timer
or stashes global state at import time will break in the hardest-to-find way the moment the
process model changes. So it is hygiene, not security, and **both the docs and the test
comments have to say so**, or the next person will take it for a security boundary.

### 3.7 Phasing the hardening (finish Phase C first, hardening in its own round) — vetoed by the user

This was proposed, on plugin-architecture §3.1's grounds: verify one thing at a time, because
when errors from both sides mix, the first verification sample may itself have a bug. §2.10's
six items have no causal relationship to database packages at all, and are naturally a round
that can be verified on its own.

The user asked for it all in one go. The cost is on decision 8's record: acceptance criteria
grow from 27 to 40, a batch of them unrelated to database packages, and **when something
breaks it takes one extra step to tell which half broke**. The mitigation is that §4 lists
the two classes separately (§4.1–§4.6 are packages, §4.7 is hardening) and requires each
class to be runnable on its own.

---

## 4. Verification

**Every check that "must be loud" needs an inverse check** — this is the repo's standing
requirement for Phase B (plugin-architecture §4, items 2 and 4), and it matters more after
packaging, because the compiler no longer catches anything.

40 criteria, in **two classes**, because decision 8 put two causally unrelated things into one
change (§3.7 records that cost):

- **§4.1–§4.6 (1–27) + §4.7 (28–31): database packages**
- **§4.8 (32–40): Electron hardening** — unrelated to database packages, and **must be runnable
  on its own**. When something breaks, this dividing line is the only thing that quickly
  answers "which half broke".

The numbers are identifiers, not a reading order.

### 4.1 Correctness of the migration: no existing test may be edited

1. **`pnpm typecheck` / `pnpm test` all green, with `connect-form.test.ts` unchanged, line for
   line.** If §2.3a's "convention" was drawn too small, this test fails on the spot — the five
   built-in packages' connect-form behaviour being verbatim unchanged is the only evidence this
   migration wants.
2. **All five real-server suites (pg / mysql / sqlite / redis / qdrant) plus neo4j run as
   before**, against the `driver.mjs` loaded from `~/.peek/packages/`, not a source import.
3. **`smoke-drivers.mjs` all green**, since it runs the build output. The neo4j line still opens
   two views (table + `graph`), and `expand_node` is still callable — proving the whole Tier C
   seam is unchanged under disk loading.
4. **Display strings compared one by one**: for a range of config samples per built-in driver,
   assert that the template evaluation's result is **verbatim equal** to what the four switches
   output today. This is the only criterion for whether §2.3b's vocabulary is sufficient,
   including redis's `db === 0`.

   The carrier is `apps/desktop/src/drivers/__tests__/connection-label.test.ts`, with all three
   methods (`label` / `detail` / `endpoint`) covering six drivers each. Expected values are
   computed exclusively from the old implementations in
   `git show HEAD:packages/core/src/capability.ts` and
   `git show HEAD:packages/db-<db>/src/manifest.ts` — writing expectations by reading the new
   code amounts to asserting "the code equals itself", which would make this criterion worthless.

   Two compile-time guarantees go in alongside, because "verbatim equal" only means something
   when **every driver has an implementation**: `DRIVER_DISPLAYS` tightens from
   `Partial<Record<DriverId, …>>` to a total `Record` (miss one and it is a compile error), and
   `driver-registry.test.ts` additionally deepEquals its keys against `DRIVER_IDS` (catching the
   in-package spread that spells a key wrong, which the types cannot see).
   Missing one does not cost you that one connection: `connection-book.ts` computes label/detail
   for **every** stored entry, so a single row in the connection book is enough to make
   `book.list()` throw wholesale and leave the sidebar empty.

   The `/display` subpath's purity is guarded by
   `main/packages/__tests__/subpath-purity.test.ts` (one case per package, five in all), not by
   `manifest-purity.test.ts` — the process that grows a client along this path is **main**. The
   renderer is clean today only because tree-shaking dropped the `DRIVER_DISPLAYS` nobody calls,
   which is a property of the current call graph, not a boundary.

### 4.2 The loader: failure must be loud

Every one of these needs an inverse check — construct a broken package and assert that it is
rejected **and that it reports what exactly is missing**:

5. Manifest missing the `en` copy → refuse to load, naming the field.
6. A view kind missing `autoFetch` → refuse to load and name it (Phase B's
   `package-view-kinds.test.ts` field-by-field deletion suite is reused verbatim, only the
   loading source changes).
7. A package id that does not satisfy `PACKAGE_ID` → rejected (today that is a build-time
   throw; it now has to become a load-time rejection).
8. **No `redact` block → a warning appears in the error centre, and the package still loads.**
   Decision 5's only backstop, and both directions have to be verified: there is a warning, and
   the warning does not block loading.
9. A path outside the `ui/` directory → `resolvePackageAsset` returns null. The test exists;
   re-run it against the new root.
10. **One broken package does not affect the loading of the others** — the report is the whole
    list, not the first exception (which is `registerPackageViewKindNames`'s semantics today).

### 4.3 Install / uninstall / bundled packages

11. **Installing a package from outside the repo connects to a new database without rebundling
    the app** (plugin-architecture acceptance 11). This one needs a real third-party sample —
    MongoDB is suggested, because plugin-architecture §1.6b used it to argue "without a
    pressure-relief valve the pressure sprays out somewhere else", and it is also Tier C's
    second sample.
12. **`PEEK_DRIVER_HOST_DIR` is validated** (acceptance 12).
13. **After uninstalling, no entry point can reach it** (acceptance 13 as rewritten in §3.3):
    its tools are not in MCP `tools/list`, its driver is not in the connect dialog, an already
    open view of that kind shows a definite error rather than a blank screen, and `connect`ing
    that driverId again returns a structured error.
14. **Uninstall a bundled package → restart the app → it has not come back** (the tombstone
    works); **click "restore bundled packages" → it comes back**.
15. **A manually installed higher version of a bundled package → upgrade the app → it is not
    pushed back to the old version** (§2.5 rule 2).
16. **`tools/list_changed` is really sent**: a connected MCP client receives one after an
    install and one after an uninstall. Inverse check: remove the send and this test must fail.

### 4.4 The front/back boundary (§2.1's, written head-on for the first time here, so guarded for the first time)

17. **No database client anywhere in the window chunk.** The existing grep for twelve client
    signature strings (boundary doc §4.3) keeps running, plus one more: **the window chunk
    contains no bytes originating in `~/.peek/packages/`**, because manifests now travel over
    IPC, and statically importing a package is exactly the regression this catches.
18. **The iframe cannot make network requests**: put a `fetch()` inside the Tier C sample and
    assert that CSP stops it (the console records the block, the request never goes out). Today
    `PACKAGE_CSP`'s `connect-src 'none'` has no corresponding inverse check, and it is the most
    important line in the whole front-end boundary.
19. **The iframe cannot assemble statements**: assert that the message schema on the port only
    accepts state patches, and that a message carrying a `text` / `query` field is rejected.

### 4.5 Performance, against PLAN §8.1's measured baselines

20. **`bench-startup.mjs` with 0 packages installed vs 20.** A median ready-to-show move of
    > 20ms counts as a signal (baseline 518ms / min 481 / p95 566). Phase B already listed this
    (acceptance 7) but had no object for it — now it does, because startup has to scan a
    directory, read 20 manifests and dynamically import 20 `main.mjs` files.
    **If `main.mjs`'s import is synchronous cost on the startup path, this is what blows up
    first**; the fix when it does blow up is deferring to first use, not raising the threshold.
21. **`bench-scroll.mjs` does not regress**: dropped frames > 0, p95 frame work > 0.30ms, or the
    `.grid-surface` element count falling outside 279–369 — any one of these falsifies it. Not a
    word of the data path changed (`package-view-channel.ts`'s bounded snapshot), so zero change
    is the expectation here, and this criterion exists to **prove** the zero.

    **The original text also named a `bench-package-frame.mjs`; that script does not exist, and
    2026-08-12 deletes it** (§4septemvicies(a)).
    It was copied over from plugin-architecture's acceptance 8, and the name came across while
    the criterion did not: the three criteria above (the wheel handler on `.grid-wrap`, the
    element count of `.grid-surface`) all measure **the host's DataGrid**, whereas a package
    frame is another DOM tree on another origin, with no `.grid-surface` in it at all.
    plugin-architecture's own criterion there was "p95 inside the iframe > 0.30ms falsifies it",
    and it was lost in the copying, leaving this half-criterion as nothing but a script name
    with no criterion attached.

    **Writing the missing script is not available this round, and the reason is not effort**:
    `bench-scroll.mjs` carries its own generated SQLite fixture, and "depends on no database
    service, measures the same thing on every machine" is what it stands on. Today's only Tier C
    view is neo4j's `graph` (`PACKAGE_UI` is one line), opening it takes a live neo4j, and how
    many nodes get drawn is decided by **however much data happens to be** on that machine when
    `autoFetch`'s Cypher hits it — a benchmark whose fixture size is not fixed does not even
    agree with itself twice, let alone with PLAN §8.1's baseline.
    So **there is no talking about this script until there is a Tier C fixture of fixed size**.

    Growing the `echo` fixture into a Tier C one was the other line considered, and **not taken**.
    **2026-08-12 correction: the conclusion is right, the reason was wrong, and the thing
    actually in the way was not seen at the time.**

    The original wording was "that would mean adding a line to `PACKAGE_UI` in
    `renderer/packages/uiEntries.ts`, and that is shipped code going into the window chunk,
    exactly what acceptance 17 guards with grep". **Measured false**:
    acceptance 17 guards twelve **database client signature strings** (`pg-native` / `ioredis` /
    `caching_sha2_password` …) and "the window contains no bytes from `~/.peek/packages/`".
    The window chunk currently shipping **already carries** a `graph` record of exactly the same
    shape (both `neo4j` and `view.kind.graph` are in it), and acceptance 17 is green.
    The original wording conflated **a hand-written literal** with **statically importing a
    package** — the former is a constant of a few dozen bytes, and only the latter is what that
    grep is there to stop.

    **What is actually in the way is `drivers/__tests__/view-kind-halves.test.ts`'s
    `deepEqual` of `installedViewKindContracts()` against `VIEW_KIND_CONTRACTS`**:
    every contract compiled in must belong to a package this build really ships. echo is not a
    bundled package, so adding it goes red on the spot (measured: `actual: ['graph']` /
    `expected: ['graph','echo']`).
    There are only two ways back to green, and **both of them relax an existing assertion** —
    stuffing echo into `IN_REPO_PACKAGES` (that stand-in says of itself "Not production code, and
    not a fallback", and the moment you fill it with a package that does not ship, it starts
    lying), or loosening that `deepEqual`.

    **And this scenario is precisely why that assertion exists**: the compiled-in list must not
    contain dead entries, or "the filter is broken" and "the filter is working" look exactly
    alike.

    **The path taken is a fourth one, and it was not on the table at the time**:
    `scripts/probe-hardening.mjs` already does almost the same thing with **zero production
    code** — it writes a package into a temp directory and puts a bare
    `<iframe src="peek-package://…">` on the host page, going through the **production**
    `installPackageProtocol` / `resolvePackageAsset`, so the frame lands on the real production
    origin, and none of it needs a view kind, `PACKAGE_UI`, or an i18n key.
    `scripts/bench-package-frame.mjs` is written along that path; see
    [`2026-08-12-package-open-cost-benchmark.md`](2026-08-12-package-open-cost-benchmark.md).
    **0 shipped bytes, 0 production code, 0 existing assertions touched.**

    This item stays here rather than being edited away, because it is an example of **a wrong
    reason with a right conclusion**: reasoning forward from that wrong reason gets you to
    "acceptance 17 is too strict, loosen it" — while the assertion that actually had to be held
    was never in view at all.

    **What this half covers and what it does not, spelled out**:
    - The steady state (how much extra work the host does per frame while a frame is attached) is
      **bounded by construction** and does not lean on a benchmark: the frame gets a one-shot
      bounded snapshot, does not subscribe to `result-stream`, and has its viewport hard-wired to
      `[0, PACKAGE_MAX_ROWS - 1]` with `atBottom: false`. `PACKAGE_MAX_ROWS === 2000` is nailed
      down by `package-view-channel.test.ts:215`.
    - Loading (how many bytes opening a Tier C view reads, and from where) **really did change
      this round** — the UI root moved from the build output tree to
      `<configDir>/packages/<id>/ui/` (§2.2). It is a one-off cost, it happens on the frame's own
      origin, and it does not enter the host's per-frame budget; but **nothing measures it
      today**, and that is recorded here rather than pretended away.
22. **renderer chunk size**: six manifests **disappear** from the window chunk (they now come
    over IPC), so the expectation this time is **smaller**. Baseline 597,160 B. Bigger means
    something got statically imported in — which is exactly what this catches.

### 4.6 Documentation

23. The redaction description at `README.md:31` / `README.zh-CN.md:26` is rewritten per §2.9.
    **This is not tidying-up work** — it is a debt decision 5 has owed since 2026-08-03, and once
    there is an install button, documentation lying about a question of passwords is worse than
    the behaviour itself.
24. `config/paths.ts`'s "the three files we are allowed to write" header comment is rewritten per
    §2.2.
25. The "Phase C only swaps the scan source, nothing else changes" line in all three of
    `drivers/{manifests,viewKinds,mcpTools}.ts` is rewritten per §1.4 — that sentence is now only
    half true, and it is the first sentence the next person reads.
26. PLAN.md §4 and §11.2 brought into sync: the capability axis is unchanged, but the number
    "adding a database means editing 7 places" is 0 places after Phase C.
27. **No half-finished rename** (§0.1): every remaining hit of a repo-wide `grep -i plugin` must
    point either at `docs/design/2026-08-03-plugin-architecture.md` (a historical record, not
    renamed) or at this document's §0.1 comparison table. Any residue in code or interface means
    this one is unfinished.
    This is guarded by `scripts/check-package-vocabulary.mjs`: it scans the whole repo itself and
    reports every hit outside those two places as an error. Third-party build tooling's own use
    of the word (vite / rollup / esbuild / babel / tailwind) is the only third exemption class,
    listed item by item in the script as "file + permitted literal" — a list short enough to read
    to the end, rather than a vague rule.

### 4.7 package host: zero package code in the main process (decision 7)

28. **Scanning the build output**, landing in two places, neither of which is optional: **inside**
    the build, looking at module attribution (`electron.vite.config.ts`'s
    `assertMainHoldsNoPackageCode`), and **after** the build, looking at output bytes
    (`apps/desktop/scripts/audit-package-boundary.mjs`, wired into `pnpm build`).
    Why both are needed is in §4quinquies(a): a vite plugin can only see the build it is part of,
    and after §4quater(d) there are two; whether the two halves really line up can only be asked
    once the bytes are on disk.

    The output check starts from `out/main/index.js` and `out/package-host/package-host.js`
    separately, walks the closure **recursively** following chunk imports (**"recursively" is the
    whole point here**: grepping only the entry file once made this check false, §4quater(a)),
    and asserts three things:

    1. main's closure **contains none** of any package implementation's signature strings;
    2. the package host's closure **must contain all** of them. Without this, "main is clean"
       would pass just as happily when the signature strings have gone stale, when the build step
       was skipped, and when the host output is empty — a check that only asserts "absent" reports
       its own blind spot as success, and this repo has been burnt by that twice (§2.10's
       partition, §4quater(a)'s grep).
       This item is at the same time **a self-check on the derivation rule**: if it can no longer
       derive real strings, it can no longer report main as clean either.
    3. every **tool name a package declares must be in `out/packages/<id>/peek-package.json`, and
       must not be in main's closure**.

       **2026-08-11 turned this one inside out via §4duodevicies; the original wording is kept
       here for comparison**: it used to read "the tool name must **be** in main's closure
       (`tools/list` must not wake a process, so `expand_node` appearing in `out/main/index.js` is
       the design working, not a leak, §4quater(c)), and doubles as the positive control that we
       really did read the build output". That was true while `PACKAGE_TOOL_META` was a
       compile-time constant — the name had to be compiled into main for `tools/list` to answer.
       After §4duodevicies the names come from the manifest on disk, so a name appearing in main
       means **the opposite**: there is still a compile-time roster that was not fully taken out,
       which is exactly the shape in which acceptance 13's first clause fails.

       The positive control changed object along with it: from "the tool name is findable in main"
       to "the tool name is findable in the manifest that was built". Both prove that the build
       output was really read, and the latter proves that **the right place** was read.

    The signature strings are **derived**, not hard-coded (rules in §4quinquies(b)), and use
    **string literals rather than symbol names**: the output is minified, `keepNames` only keeps
    function and class names, and these modules export const objects throughout — grepping
    `neo4jDisplay` out of a bundle that contains it comes back CLEAN.

    **Inverse checks** (three of them, all measured; output in §4quinquies(c)): remove one entry
    from the allowlist and the build guard must fail (§4quater(c)); have
    `main/mcp/package-tools.ts` deliberately import the full spec table once, and the build guard
    and the output check must each fail **independently**; have the package host's entry import no
    contrib at all, and the output check's second assertion must fail.
28bis. **The package host is not in main's Rollup graph**: `src/main/packages/entry.ts` appears in
    **no** chunk of main's build (not merely the ones reachable from index). Landed as
    `assertPackageHostBuiltApart`, kept separate from item 28 because **item 28 cannot catch a
    merged graph** — measured: put the package host's entry back into `main.rollupOptions.input`
    and the build is green.
    A merged graph does not leak by itself; it merely reinstalls the conditions for leaking
    (§4quater(d)).
    **Inverse check**: put that entry back and the build must fail.
29. **`safeStorage` is out of reach**: `require('electron')` inside the package host process
    cannot get `safeStorage` (utilityProcess's electron surface is narrow to begin with), and
    assert that the host's env carries no credential-related variable at all. This guards
    §2.4bis(b)'s sentence "a neo4j package can read out every postgres password" no longer
    holding.
30. **Reduction is still synchronous**: no `await` on the reduction path of `view.open` /
    `view.update`. §2.4bis(e)'s entire design exists for this one, and when it degrades it does
    not raise an error — it just stops Commands being atomic — so there has to be a test that
    directly asserts the reducer does not return a Promise.
31. **Lazy start**: install 20 packages, use none of them, and the package host process count in
    `ps` is **0**; open a view from one of them and only that one is forked. This is a
    precondition for acceptance 20 (cold start) passing, and is verified separately because the
    two fail for different reasons.

### 4.8 Electron hardening (decision 8, unrelated to database packages, runnable on its own)

32. **The `env` allowlist works**: in both the driver-host and the package host process,
    `process.env` holds only what is on the allowlist. **Inverse check**: set `PEEK_TEST_LEAK=1`
    in main before starting the process, and assert the child cannot read it.
33. **`PEEK_DRIVER_HOST_DIR` is validated** (acceptance 12, owed since 08-03): pointing it at an
    illegal path refuses to start and gives a structured error, rather than loading silently.
34. **The fuses really are written into the binary**: after packaging, use `@electron/fuses`'s
    read interface to verify that `RunAsNode` /
    `EnableNodeOptionsEnvironmentVariable` /
    `EnableNodeCliInspectArguments` are all false.
    **Inverse check**: `ELECTRON_RUN_AS_NODE=1 ./peek` must not enter Node mode.
35. **The limits of `asar: false` are written into a comment**: §2.10's paragraph on "fuses cannot
    stop file edits" goes into `package-mac.mjs`'s header comment, or the next person will think
    integrity is taken care of.
36. **`will-navigate` interception**: navigate to `https://example.com` once from the window and
    once from a package frame; both must be blocked.
37. **Permissions all denied**: request notifications / clipboard / geolocation inside a package
    frame; all three are denied.
38. **Origin isolation works** (not partitions — reasoning in §2.10): have two packages each write
    once to `localStorage` and to Cache Storage, and neither can read the other's; and neither can
    read the host window's. This verifies that `standard: true` really gave each package its own
    origin — when the privilege is set wrong it degrades into an opaque origin, and that **raises
    no error**.
39. **Two places that are "already stricter" must not be loosened**: assert that
    `peek-package://`'s privileges have `supportFetchAPI` / `corsEnabled` / `allowServiceWorkers`
    all false, and that the document CSP contains `connect-src 'none'`. This is a regression
    guard — changing the config to match the commonly given advice is a very natural move, and
    here it is wrong (§2.10).
40. **The UI must not imply security** (§2.9 corollary 1): scan all copy in the install flow and
    the settings panel; words like `已验证`, `安全`, `可信` must not appear. There is no automated
    criterion for this, so it is a **review item** rather than a test — it is written here so that
    it has a place, rather than pretending it can be asserted.

---

## 4bis. Implementation record — after steps 1 and 2

> Added 2026-08-10. Three things worth keeping: a design overturned by the implementation
> (folded into §2.3b), a verification method proved effective, and **one migration that took out
> four compile-time guarantees with every test staying green**.

### (a) Running old against new is the only credible evidence of "preserved verbatim"

§4.1's item 4 asks for "verbatim equal to the old implementation's output". The way it landed is
not a human reading code: the old implementation is copied verbatim out of `git show HEAD:` into a
temporary script, and run against the new one over **a large generated set of configs** with
`deepEqual`:

| object | sample size | result |
|---|---|---|
| `label` / `detail` / `endpoint` | 26,689 configs | **1 difference** (one fallback branch in qdrant, see (c)) |
| `redact` / `identity` | 105,444 configs | **0 differences**, down to identical identity collision counts (103,171 = 103,171) |

"Identical identity collision counts" is a stronger statement than "identical output": it says the
old and new implementations **group** connections in exactly the same way, and that grouping is
the criterion for credential attribution.

**This technique is worth reusing**, on the condition that it copies the old implementation out of
`git show HEAD:` rather than writing expectations by reading the new code — the latter tests "the
code equals itself".

### (b) Four compile-time guarantees were taken out, and everything was green

This is the item most worth remembering from this round. After the split, `pnpm typecheck` was
clean and all 1626 tests passed, while the following four things disappeared at once, **not one of
which turns any check red**:

| guarantee lost | what used to hold it | consequence of one typo |
|---|---|---|
| field names in `redact` / `identity` | an exhaustive `switch` over a discriminated union | plaintext password into an MCP receipt / connection strings crossed so you read someone else's credentials |
| import purity of `display.ts` | nothing (a new file is on no scan list) | a database client in the **main process** |
| completeness of `DRIVER_DISPLAYS` | `Record<DriverId, …>` | miss one → **the whole sidebar** throws (not just that row) |
| the behaviour of eight functions | nothing (zero test coverage) | silent drift |

The shape they share: **replace an exhaustive union with an open table, and the compiler stops
counting for you.** A replacement went in for each of them
(`manifest-declarations.test.ts` / extending `subpath-purity` to `/display` / dropping `Partial<>`
plus the deepEqual in `driver-registry` / 12 new display tests), but the process of writing them
demonstrated one thing: **guarantees of this kind produce no signal when they vanish, so the very
change that dismantles the union has to write the replacement at the same time, and cannot leave it
to the next round.**

The `display.ts` one is measured: add `import { QdrantClient } from '@qdrant/js-client-rest'` to it
and every check still passes. The renderer being unpolluted today is purely a side effect of
tree-shaking — the day the window calls `connectionLabel` again, the same hole hits both processes
at once.

### (c) Three temptations to "fix it while you are in there", all nailed down

The easiest thing to get wrong in a migration is not missing a line, it is **understanding it and
then deciding it was written wrong**:

- postgres/mysql's `if (config.url)` is a **truthiness** test; redis's `config.url ??` is a
  **nullish** test. The same `url: ''` input takes opposite branches on the two sides. It looks
  like one of them is a mistake; **neither may be touched**.
- qdrant's `label` is missing a layer of fallback (`safeUrlLabel(undefined)` returns `undefined`,
  so the old version could fall back to `'qdrant'`), and after the move it throws a `TypeError`
  instead. It cannot be reached today (both entry points have zod guaranteeing `url` exists), but
  the other five drivers all merely degrade on an unvalidated config. This asymmetry was
  **introduced unintentionally** by the migration; it is not design.
- postgres's `endpoint` outputs `host:port/` (**with a trailing slash**) when the database is
  missing. Details of the "the empty value still has to appear in the output" kind are the easiest
  to lose in a rewrite.

### (d) Found along the way: a batch of tests that had never run

`apps/desktop/package.json`'s test script is an **explicit list of directories**, not a glob.
Create a new test directory and forget to edit the script, and those tests never run, `pnpm test`
exits 0, and there is no warning of any kind.

The inverse check is blunt: put a guaranteed-to-fail tripwire in `src/drivers/__tests__/` and run
with the old glob → **exit 0, and the string "tripwire" does not even appear in the output**.

This was not introduced by this change, but this change ran into it twice (once in
`src/main/__tests__/` and once in `src/drivers/__tests__/`). **The glob is fixed, but the shape is
unchanged** — the next new directory will still go missing silently.

---

## 4ter. Implementation record — step 4 (display strings and tool calls move to the host)

> Added 2026-08-11. Two designs overturned by the implementation, one of which this document
> predicted itself and one of which it did not.

### (a) Three display strings, not two

§2.3(b)'s 2026-08-10 note said "two are stored, not three", on the grounds that `endpoint`'s reader
(`mcp/summary.ts`'s `connTarget`) is in main, and main could still reach the package's
`DriverDisplay` at that point. **Step 4 removed that reach**, and the reason went with it:
`connTarget` is synchronous and on the receipt path, with no room for an await. All three are
computed together and stored together.

This is not a new decision; it is the sentence already written in `drivers/manifests.ts`'s comment
on `endpointSummary` ("when main stops running package code too, this one has to join the pair
being stored — and it is the last one"). The cost is one more required field on each of
`ConnectionState` and `ConnectionSummary`, with 8 test fixtures called out by the compiler and
filled in — which is exactly what making it required rather than optional bought.

`ConnectionSummary` still has **no** `detail` (2026-08-10's conclusion is unchanged): the
snapshot's readers are all in main, all of them want the one line of address that the model reads,
and two lines side by side only cost a reader who is about to act one more judgement call.

### (b) `callTool` is three phases, not one "run this tool"

§2.4bis(f-bis)'s table originally said `callTool` returns "the tool's `ToolOutput`". **It cannot be
built that way**, and the reason it cannot is the paragraph in `core/mcp-tools.ts` itself:

> A package declares a `ToolSpec`; **only the app's executor ever constructs a `PeekTool`**.

Returning a finished `ToolOutput` means `defineCommandTool` runs inside the package's process, and
then the three things that sentence says a tool gets for free — a second validation before the
command reaches the bus, the `uiEffects` the executor attaches unconditionally, and one tool's
exception not taking down the server — are all absent on the package's side. That is exactly the
second execution path this document exists to eliminate.

So what crosses the boundary is **the mapping**, not the execution:

| phase | when | arguments | returns |
|---|---|---|---|
| `commands` | before dispatch | args that passed `inputSchema` + the snapshot | `Command[]` |
| `render` | after every Command has settled | args + snapshot + `CommandOutcome[]` | `ToolOutput \| null` |
| `read` | read-only tools, one step | args + snapshot | `ToolOutput` |

A command tool takes two round trips, because its two halves stand on either side of dispatch:
`render` reads the workspace **after** its own commands have changed it (neo4j's `expand_node`
cites the view's own `describe` right there in the receipt). `null` means "this tool has no receipt
renderer of its own", and main falls back to the default rendering — the same path a kernel tool
with no `render` takes.

Three things settled along the way:

1. **The snapshot is sent over, not fetched back.** The package's mapping wants a `ToolContext`,
   and most of that is main's live functions, which cannot be moved; what those mappings actually
   read is only `getSnapshot()`, which is pure data. In the `ToolContext` reconstituted on the host
   side, **`dispatch` throws** — a thin shell tool ought to "return commands for main to send"
   anyway, and the only thing that would reach for it is a package wanting to pick its own
   `CommandSource`, which is precisely the overreach §2.4bis(b) names.
2. **Everything coming back is validated.** On the way out main is the only sender and validation
   is unnecessary; on the way back it is the package's code talking. Of these, `uiEffects` is
   **dropped** rather than rejected: the executor's `withUiEffects` expands the tool's output first
   and only overwrites that field when the diff is non-empty, so a package's own `uiEffects` would
   survive intact on exactly those calls that changed nothing — the class most likely to fool
   someone.
3. **`tools/list` still wakes no process** (§2.4bis(d) unchanged). In a build with no host wired
   up, the tools are listed as usual and only the *call* fails, with the reason. Pretending the
   package is not installed is the worse lie.

### (c) Attribution needs a table, and there may only be one

Attribution for displays and view kinds is **derived** (`DRIVER_DISPLAYS` is indexed by `DriverId`,
`ViewKindRegistration` carries its own `driverIds`); attribution for tools **cannot be derived** —
nothing in a `ToolSpec` says which package it belongs to. Hence two tables: `drivers/packages.ts`
(package → driverIds) and `drivers/mcpTools.ts` (package → ToolSpec[]).

(**Changed 2026-08-11**, see §4quater(b): the second table now stores `PackageToolMeta[]`, and
`ToolSpec[]` moved into `drivers/mcpToolSpecs.ts`, which only the package host loads; attribution is
still in exactly one place.)

The key point is that main and the package host **read the same one**: main uses it to route a call
to a process, and the host entry uses it to look its own id back up into "which questions can I
answer". Two tables mean two chances to disagree, and disagreement does not show up as an error —
it shows up as main asking a package for a display it does not have and getting back a NOT_FOUND
that looks like "this package is broken". Both tables disappear in Phase C: attribution becomes
"which directory it was found in".

### (d) Reduction is still synchronous — the landed shape on the connection side

The split §2.3(b) predicted was done as written: `conn.open`'s reducer no longer computes the three
strings, and instead **fills a placeholder and calls `ctx.plan({type:'describeConnection'})`**, with
the effect's answer coming back as one `setConnectionDisplay` patch. All three entry points (new,
reconnect, reopen from that row in the connection book) land on the same reducer, so the intent is
planned unconditionally — "skip the ones that already have a name" is the only way the label ends up
stuck at an old value.

Two details worth recording:

- **The placeholder is `existing?.label ?? ''`, not a constant empty string.** Reopening is the
  normal case (that row in the sidebar, and every reconnect, carries the same connId), and blanking
  a name that is about to be recomputed to the same string is a flicker on every reconnect. The
  backfill always overwrites, so a stale placeholder lives for exactly one round trip.
- **`soft: true`.** A connection whose name did not get computed is still a usable connection;
  failing `conn.open` for it amounts to reporting the database broken because one package's host
  was slow.

### (e) The one piece of package code still left in main

> **Paid off 2026-08-11, see §4sexies.** The paragraph below is the state at the time, kept because
> the direction it points ("the right shape is probably storing the strings into the book at
> remember time") was later proved right.

`config/connection-book.ts`'s `toSavedConnection` still calls `connectionLabel` /
`connectionDetail` synchronously — **every stored entry** in the connection book needs a pair of
strings, `book.list()` is synchronous and on the startup path, and at that point not a single host
has started. Making it async means the sidebar's stored list waits on N process round trips (up to
100 entries).

The right shape is probably "store all three strings into the book at `remember()` time" — the
answer is already in hand there — but that changes the on-disk format and is a design of its own.
**Until then, `§2.4bis(a)`'s sentence "not one line of package code in main" does not hold**, and it
is written down here so nobody takes it for done.

§4quater(c) turned this from a paragraph into one allowlist line in the build: it now has a name and
a reason, and the day it is paid off is the day a line is deleted, rather than a day someone has to
remember to come back and read this paragraph.

---

## 4quater. Implementation record — step 4's rework (the package implementations really did leave main)

> Added again 2026-08-11. Measurement after §4ter was written: `§2.4bis(a)` still was not achieved,
> and **the way it was being verified was itself wrong**.

### (a) A clean grep of the entry file ≠ no package code in main

Item 28 was verified like this at the time: `grep expand_node out/main/index.js` → 0 hits, pass.
But `index.js` is only the entry; it does `import ... from "./chunks/…"`, and the package
implementations are in those chunks:

```
grep -oE 'from"\./chunks/[^"]+"' out/main/index.js   → manifest-*.js / packages-*.js
grep -l expand_node out/main/chunks/*.js              → packages-*.js   ← hit
```

The root cause is that a bundler's **chunking granularity is the module, not the export**. rollup
groups by "which entries can reach this module", and tree-shaking then takes a global union: a
module imported by both `index.ts` and `packages/entry.ts` lands in the chunk both entries load,
and lands there carrying **the union of what both sides need**. Which makes the "main imports only
the metadata, the host imports the handler" style of two exports in one file **completely useless** —
main's source never mentions the handler, and the chunk has it anyway.

The header comment on that UI build script under `apps/desktop/scripts/` had already finished this
argument at the time; it was just talking about the renderer side. (That header comment now lives in
`build-packages.mjs`, §4octies.)

### (b) The split lands on file boundaries, not export boundaries

§2.4bis(d)'s table (the manifest owns metadata, `contrib.mjs` owns computation) was implemented as
written, in this shape:

| | module | who loads it |
|---|---|---|
| declaration | `@peek/db-neo4j/mcp-tool-meta` → `drivers/mcpTools.ts` | main |
| mapping | `@peek/db-neo4j/mcp-tools` → `drivers/mcpToolSpecs.ts` | package host |

Four things settled along with it:

1. **`ToolMeta` / `PackageToolMeta` go into core** (`mcp-tools.ts`). It is exactly the shape of
   Phase C's `peek-package.json`: `name` / `title` / `description` / `inputSchema` /
   `annotations` / `kind`, plus `hasRenderer`.
2. **`hasRenderer` is part of the declaration, not part of the behaviour.** §4ter(b) already said
   so; main has to know before it asks, because `defineCommandTool` reads "no `render`" as "use the
   default receipt", and a thin shell cannot derive that from an answer it has not received yet.
3. **Both halves are derived from the same declaration, and `toolFromMeta` is the only seam.** The
   declaration is written once in `mcp-tool-meta.ts`, and the mapping side writes
   `toolFromMeta(expandNodeMeta, {toCommands, render})`. A declaration that says there is a
   renderer while the mapping has none throws at module load — two hand-written declarations drift,
   and drift shows up as "the model sees a broken package", with neither side making a sound.
4. **`MAX_DEPTH` moves into `limits.ts`.** It is simultaneously `graph.ts`'s clamp and the ceiling
   in `expand_node`'s input schema; leaving it in `graph.ts` means dragging Cypher assembly into
   main for the sake of writing one number in a schema.

Attribution is still one table (§4ter(c) unchanged): `PACKAGE_TOOL_META` says who owns which tool
name, and `toolSpecsOfPackage` looks up by name, so `mcpToolSpecs.ts` holds **no second attribution
declaration**. `drivers/__tests__/mcp-tool-halves.test.ts` guarantees the two halves list the same
set of names.

### (c) Acceptance changed to reading the build output, and reading it recursively

The new criterion: starting from `out/main/index.js`, walk chunk imports **recursively**, and no
reachable module may be a package implementation under `packages/db-<id>/src/`.
Landed as `electron.vite.config.ts`'s `assertMainHoldsNoPackageCode` — inside `generateBundle` it
walks the chunk graph and looks at which **modules** each chunk holds, rather than grepping strings
(minification renames things, and strings cannot hold that up).

The allowlist `MAIN_MAY_REACH` has four entries, each one an assertion about "what this file is":
`manifest.ts` (data), `mcp-tool-meta.ts` (declaration; §2.4bis(d) requires `tools/list` not to wake
a process), `limits.ts` (the ceiling inside that declaration), and **`display.ts` — §4ter(e)'s
debt**. The last is the only package implementation still left in main, and it now has a name in the
build script.

Two things that will still show up in main but are not package implementations, written down so they
are not treated as another miss next time:

- **The name `expand_node` itself.** §2.4bis(d) requires `tools/list` to answer from the manifest
  alone, so tool names, descriptions and schemas have to be in main. Grepping by name hits them, and
  that is **correct**.
- **The prose in the neo4j manifest describing the `graph` view**, which mentions `expand_node`. The
  manifest is data, and the renderer reads the same copy.

The cost: one more subpath on `@peek/db-neo4j` (and one more case in `subpath-purity.test.ts`), and
one more module under `drivers/`. What that buys is "no package code in main" going from a sentence
to an assertion that fails the build.

### (d) Treating the cause: the package host has its own Rollup graph

(b) treated that one leak and **did not treat the cause**. As long as main and the package host are
two entries in one graph, the next module both sides import — a utility function, a constant — gets
hoisted into a shared chunk again, and the grep of the entry file still comes back with 0 hits. Not
a word of (a)'s root cause changed; the trigger is merely absent for the moment.

So the package host comes out of `main.rollupOptions.input` and gets an **independent build** through
`electron.vite.package-host.config.ts`, output to `out/package-host/`.

**Why not "force no sharing inside one graph".** The directions tried were `manualChunks` /
`preserveModules`, but rollup has **no** operation for "duplicate a module into two copies":
`manualChunks` only decides how modules are **grouped**, and `preserveModules` is one file per
module, with two entries still importing the same file. A module is instantiated once per graph;
that is rollup's semantics, not a config option. The only way two entries share no modules is for
them not to be in the same graph.
That UI build script wrote the same argument for the renderer side (one independent build per
package), and this is moving it from an origin boundary to a process boundary. (That script is now
called `build-packages.mjs`, and it puts the same argument to work a third time at the package layer
— §4octies(a).)

One benefit along the way: in Phase C `contrib.mjs` is a file on disk and takes no part in the app's
build graph to begin with. An independent build is arriving early at that end state, rather than
drawing an artificial isolation line inside one graph.

**What is shared and what is not.** The build **settings** are still one set (`mainProcessTarget`):
the same aliases, the same externals, the same minify + `keepNames`, the same CJS shim and
unresolved-import guard. Building two bundles with two sets of settings would be a second problem
stacked on the first. The only thing not shared is the graph.

**Why a separate directory.** Vite empties a build's `outDir`. Writing back into `out/main` would
require `emptyOutDir: false` and strict ordering after `electron-vite build` — an order that holds
in `pnpm build` and cannot possibly hold in `pnpm dev` (main's build never finishes).
`PackageHostRegistry` therefore changes to finding `../package-host` relative to its own bundle, so
the dev tree and the packaged .app (where all of `out/` is copied) resolve it the same way.

#### New criterion 28bis, and why it cannot be folded into item 28

Item 28 cannot catch a merged graph. **Measured**: put the package host's entry back into
`main.rollupOptions.input` and `pnpm build` is **green** — rollup put the package implementations in
a chunk only `package-host.js` imports, main cannot reach a byte of it, and item 28 truthfully
reports "no problem".

What a merged graph restores is not the leak, it is **the conditions for the leak**. Between the
merged graph and an actual leak the build stays silent throughout, so the merge itself has to be the
failure: that is the last moment at which the causality can still be read.
`assertPackageHostBuiltApart` therefore scans **every chunk in the whole bundle** rather than the
ones reachable from index (a sibling entry nobody imports is exactly the state it is looking for),
and decides by **module path** rather than by entry name, so that renaming a key does not walk
around it.

Two guards, each guarding one thing, written down so they are not merged into one next time:

| | guards what | when it goes off |
|---|---|---|
| `assertPackageHostBuiltApart` | the graph's **topology** | the entry gets put back into main's graph |
| `assertMainHoldsNoPackageCode` | the **contents** of main's own graph | main's source starts importing a package implementation (today only `display.ts` is left, §4ter(e)) |

The cost: one more config file, one more npm script (`build:package-host`, which both `dev` and
`build` have to go through), and one more line in `package-mac.mjs`'s required-files table — for the
same reason as the package UI: an independent step is a step that can be skipped, and skipping it
shows up as a packaged app that fails the first time a package is used.

---

## 4quinquies. Implementation record — item 28 itself (the output check)

> Added again 2026-08-11. §4quater treated the leak, and **the criterion was still a sentence rather
> than a check**: "grepping the package host's output must hit" — who runs it, and on what, was
> written nowhere.

### (a) Two things the build guard cannot see

`assertMainHoldsNoPackageCode` asks the sharper question — rollup's own bookkeeping of which module
went into which chunk, and module identity survives renaming while strings do not. But it has two
structural blind spots, and neither is fixable by writing it a bit better:

1. **It can only see the build it is part of.** After §4quater(d) there are two builds, and whether
   the two bundles are correct **as a pair** — the package's code left main, *and* arrived at the
   host — cannot be asked from inside either build.
2. **"Leaving main" has two ways of happening**: moving to the host, and simply ceasing to exist.
   The first is the goal, the second is forking a process that can answer nothing, and from main's
   side the two look exactly alike.

So there is a post-build check that reads output bytes: `scripts/audit-package-boundary.mjs`.
It and `audit-shipped-css.mjs` are two applications of the same reason — **the output is the fact** —
only that one reads stylesheets and this one reads "which process can load which code".

### (b) How the signature strings are derived, and why at each step

Hard-coding a list of strings amounts to "the packages we happened to remember", leaving the next
package unattended. So they are derived from source:

1. The starting point is **the few subpaths a package contributes to the host** (`display.ts` /
   `mcp-tools.ts` / `view.ts`, the three things `packages/entry.ts` hands to the runtime). After
   Phase C this list is `contrib.mjs`'s business.
2. Follow **in-package relative imports** to a closure — which brings `graph.ts` in automatically,
   and the Cypher is in there.
3. Use `MAIN_MAY_REACH` to cut the closure into a "declaration half" and a "host-only half".
4. A signature string = a string literal that the host-only half says and that **nothing legally
   able to reach main says**: not the declaration half, and not the kernel's own source
   (`packages/core/src`, `src/main`, `src/drivers`). A string both sides say cannot tell the two
   sides apart; dropping it loses one signature string and can never conjure a false positive.

Three details that came out of measurement, all of the "a source reader would assume it does not
matter" kind:

- **Symbol names cannot be used.** See item 28: `neo4jDisplay` is the ready-made counterexample.
- **Comments have to be skipped first.** Without skipping them, the prose in `graph.ts`'s header
  comment explaining what the query does becomes that query's "signature string".
  `audit-shipped-css.mjs` learnt the same lesson six times from the opposite direction (Tailwind
  **minting** the very class it is warning about out of prose).
- **An import specifier is not a signature string.** It is a name in the build graph, and the
  bundler resolves it away. This one **the check caught itself** the first time it ran:
  `'./mcp-tool-meta'` was taken for a signature string, so the second assertion's direction (the host
  must hit) went red — the positive control caught a bug in the derivation, rather than waiting for
  it to report main as clean later on.

### (c) The measured output of the three inverse checks

1. **Remove `display.ts`'s entry from `MAIN_MAY_REACH`** → the build guard fails, listing five
   `display.ts` files (recorded in §4quater(c); not repeated this time).
2. **Have `main/mcp/package-tools.ts` deliberately `import { toolSpecsOfPackage }` and call it
   once**:

   ```
   [peek:assert-main-holds-no-package-code] The main process can reach driver package code:
     packages/db-neo4j/src/view.ts       (in index.js)
     packages/db-neo4j/src/mcp-tools.ts  (in index.js)
   ```

   The build guard goes off first, and the output check never gets a turn. So the guard was
   **commented out temporarily** and the run repeated, to confirm that the output check catches it
   **independently**:

   ```
   the main process can load package implementation code:
       main/index.js
         "expand_node only acts on a Neo4j graph view; open one with "
         from packages/db-neo4j/src/mcp-tools.ts
       …(3 in all, all landing in main/index.js)
   ```

   Three of the ten signature strings hit — tree-shaking kept only the half actually referenced this
   time, which is exactly why "one string is enough, they need not all hit". Both edits were
   reverted.
3. **The package host's entry imports no contrib** (delete the three imports, `contribFor` returns
   empty): output 20.16 kB (was 35.89 kB), and the check fails on the second assertion's direction,
   listing **all ten signature strings** as missing. Reverted; output back to 35.89 kB.

   One intermediate state worth recording along the way: the first attempt, which only emptied the
   function bodies and `void`ed those imports, produced 32.91 kB, **all ten strings still present**,
   and the check passed as usual — which is correct, because the modules are still in the graph.
   "Not importing" and "not using" are two different things to a bundler, and §2.4bis(a) has always
   wanted the former.

### (d) Today this check covers only one package, because of §4ter(e)'s debt

> **The last sentence is wrong, overturned by measurement on 2026-08-11, see §4sexies(d).** Once the
> debt is paid, what this check gets is not "the other four packages", it is four modules it is
> **structurally unable to see by byte grep**: the five `display.ts` files output nothing but
> template strings and core's helper functions, and no signature string can be derived from them.
> The first half of the paragraph below (exempting `display.ts` amounts to exempting those four
> packages' entire contribution) still holds.

The measured result of running the derivation: **only neo4j has host-only modules** (`mcp-tools.ts` /
`view.ts` / `graph.ts`, 10 signature strings). The other four packages' only contribution today is
`display.ts`, and the whole of it is on `MAIN_MAY_REACH` — **exempting `display.ts` amounts to
exempting those four packages' entire contribution**.

That is the second cost of that debt, never written out before: it is not only "one piece of package
code is still left in main", it also leaves this output check with **nothing to say** about four of
the five packages. Pay it off and the check gains the other four.

### (e) `MAIN_MAY_REACH` moves into `scripts/main-may-reach.ts`

Both checks read the same table: the in-build `assertMainHoldsNoPackageCode` decides by module id,
and the post-build `audit-package-boundary.mjs` uses it to cut the closure.
Two copies would produce a file exempted in one place and still forbidden in the other, and at that
point this pair of checks is reporting a boundary **neither of them holds**.
The table carries one extra self-check: **a pattern matching no package source file must be an
error** — an exemption that exempts nothing is an empty sentence sitting in the middle of the
boundary, and the next person will write another one modelled on the line above it.

Decision 8 asks for it all in one go, but that is about **scope**, not **method**. The order still
follows plugin-architecture §2.1's principle: **lay the new road first, then move what is on the old
road across, and only then run on the new road what the old one could not run.** `pnpm typecheck` /
`pnpm test` must be all green at the end of every step.

| step | what it does | verified off at the end |
|---|---|---|
| **1** | §2.10's six hardening items | §4.8 (32–40) |
| **2** | manifests demoted to data; the six built-in packages changed in place, still statically imported | §4.1 (1–4) |
| **4** | package host process + prefetch before reduction; **packages are still compiled in** | §4.7 (28–31) |
| **5** | open up `DriverId` + manifest format + loader + build script + bundled packages rolled out; the six packages move into `~/.peek/packages/` | §4.2 (5–10), §4.5 (20–22) |
| **6** | install/uninstall UI + hot reload + finishing the rename | §4.3 (11–16), §4.4 (17–19), §4.6 (23–27) |

**The original step 3 (opening up `DriverId`) has been folded into step 5**, changed 2026-08-10. It
was a step of its own on the grounds of "verify one thing at a time" — but in practice it **has
nothing to verify**: the point of opening up `DriverId` is to let a driverId from outside the repo be
accepted, and before the loader exists there is not a single driverId from outside the repo.
Doing it alone would only produce a temporary fake registry, thrown away in step 5.

Step 2 already did half of its work along the way: two of the four display switches were deleted, and
the other two (`redact` / `identity`) changed to reading declarations. What is left — `DRIVER_IDS`'s
`z.enum` and `ConnectionConfigSchema`'s discriminated union — is the same question as "who decides
whether this driverId exists", and that answer is the loader.

Three reasons for the ordering:

- **Step 1 comes first**, because it is causally unrelated to the other five and is the only batch
  that can be **verified off entirely on its own** (§3.7's recorded cost, mitigated by this order).
  Every package-related piece of work afterwards runs on a hardened baseline.
- **Step 4 comes before step 5**, and this is the most important line in the whole ordering: get the
  process model working against the six packages **known to be correct** first (they have tests and
  real-server verification), and only then swap the loading source. The other way round, the first
  verification sample is "a newly written package plus a new process model", with errors from both
  sides mixed together — the same reason plugin-architecture §3.1 argues Phase B is worth existing
  on its own.
- **Finishing the rename comes last**, because it is a mechanical repo-wide replacement, and doing it
  early would fight with every edit in the preceding five steps. §0.1's first batch (the externally
  visible ones) has to be fixed by the time step 5 lands; step 6 collects the second batch.

---

## 4sexies. Implementation record — §2.3(b-2): the connection book stores label / detail

> 2026-08-11. The debt §4ter(e) left is paid: `config/connection-book.ts` no longer calls package
> code for every stored entry, `display.ts`'s line in `MAIN_MAY_REACH` is deleted, and both the build
> guard and the output check are green. The landed shape matches §2.3(b-2)'s three rules; four
> details are worth writing down.

### (a) On disk it is a nested `display`, not two top-level keys

```jsonc
{ "id": "…", "config": { … }, "display": { "label": "orders", "detail": "postgres://app@localhost:5432/orders" }, "secret": "…" }
```

**The top-level name `label` cannot be used**, because it is already taken: from day one `parseEntry`
has **ignored** a `label` key an older version might have written on the row, on the grounds that it
is a frozen derived value. Two tests nail this down
(`one unusable row does not cost the others` / `a name is only the user's when it is in
the config`). Reusing that name would make "an old row's stale copy" and "the new row's authoritative
answer" look identical, while the correct handling of the two is exactly opposite. Nesting one level
also says something along the way: these two strings are **one answer**, computed by the same package
at the same moment, not two fields of the entry.

### (b) The empty string means "nobody computed it", not "the name is empty"

Not one of the six packages returns an empty label for a config it recognises, so the empty string can
safely serve as a sentinel. Two rules follow from it:

- **Writing**: `pickDisplay` **keeps the stored pair** when the new pair is empty, in the same shape as
  `pickSecret` next to it. `describeConnection` is a soft intent — the host being slow, or crashing
  once, still opens the connection and just leaves it unnamed; writing that empty string down turns one
  display flicker into a **permanently** degraded stored row. The book outlives the process, which is
  what "storing the strings" buys, and also its one new risk.
- **Reading**: `entry.display?.label || config.label || driverId`, with no backfill and no batch
  computation at startup — that is rule 2. Backfilling means asking the packages, asking the packages
  means starting hosts, and starting six processes in order to draw the sidebar is exactly what this
  change is dodging.

### (c) "describe before connect" goes from a convention to a contract

`remember` is called inside the `connect` effect (`main/index.ts`'s `connections.open`), and the two
strings are read back off the source of truth. They are there only because the reducer `plan`s
`describeConnection` before it `plan`s `connect`, and intents run **in order**.

Before this, that order only mattered for "the row has a name while it still says connecting" — getting
it wrong just meant one beat late. Now getting it wrong means **every connection is stored unnamed**,
while the sidebar looks entirely normal (the live row picks up its name a moment later).
So a test was added to nail it down: `connection-display.test.ts`'s
`the name has landed before the connect effect runs`. Inverse check: swap the two `ctx.plan` calls in
`handlers/conn.ts` → only this one goes red (1 of 6 cases fails) and everything else stays green —
which says that before this, **nothing at all** was watching that order.

### (d) The prediction was wrong: what paying the debt gives the output check is four modules "grep cannot see"

§4quinquies(d) says "pay it off and the check gains the other four packages". **Measurement says
otherwise.** After taking `display.ts` off `MAIN_MAY_REACH`, the five `display.ts` files do become
host-only, but step 4 of `audit-package-boundary.mjs` derives not a single signature string, so its own
"every host-only module must say at least one recognisable string" assertion fails on the spot:

```
AssertionError: packages/db-neo4j/src/display.ts runs in a package host and says
nothing this audit can recognise in the shipped bundle.
```

The measured reason is this: the five `display.ts` files output nothing but **template strings +
numeric defaults + core's `hostPort` / `urlParts` / `redactUrlCredentials`**. Across all five files the
only string literal is `'localhost'`, and `src/main/mcp/server.ts` writes that word too, so by the rules
it gets subtracted; qdrant's copy **writes no string at all**. `bolt://` is 7 characters, short of the
minimum of 8, and a template's static segments are excluded anyway (the bundler may respell them).

So neither way out holds ("give the module a string only it would write", "loosen the derivation"): the
first invents a marker string for no purpose but being grepped, and the second does nothing for qdrant
whatever — a module that writes no strings is **structurally** invisible to a check that greps bytes.

**Decision: write this down, rather than leaving it red or letting it pass quietly.** The audit gains a
new `UNSIGNABLE` list, one pattern with one reason each, in the same manner as `MAIN_MAY_REACH`, plus
two self-checks:

1. **If a listed module starts talking, fail** — the day someone adds a distinctive literal to a
   `display.ts`, this exemption has to be deleted and grep takes over. The list can only ever cover
   modules about which it told the truth.
2. **A pattern matching no host-only module fails** — the same as `MAIN_MAY_REACH`'s.

It is **not** an entry in `MAIN_MAY_REACH`, and must not become one: that table says "main may load this
file", and main may not load this one. These five modules' guard is the in-build
`assertMainHoldsNoPackageCode` (deciding by module identity, sharper than grep), and the output check has
nothing to say about them — the summary line now **prints** that number:

```
… 10 string(s) derived from 8 host-only module(s) in 5 package(s)
  (2 module(s) excused by main-may-reach.ts, 5 unsignable) …
```

A check that stays silent about a file is precisely the failure shape item 28's rewrite is dodging;
printing it is what makes the silence itself visible.

Three inverse checks (all reverted):

1. Put `connectionLabel(entry.config)` back into `toSavedConnection` → the build guard goes red, with one
   call dragging **all five** `display.ts` files into `index.js`. That is the debt's actual size, and it
   also says the allowlist line that was deleted really was load-bearing.
2. Add a `'qdrant-endpoint-marker'` to `db-qdrant/src/display.ts` → the audit goes red, reporting
   "listed in UNSIGNABLE, but it now writes 1 string(s) only it would write".
3. Add a pattern matching no file to `UNSIGNABLE` → the audit goes red, reporting stale.
   (Merely mis-spelling `display.ts`'s pattern is **not enough** to verify this one: the earlier
   `mine > 0` assertion goes off first. Which incidentally proves that older assertion still goes off.)

### (e) `***` appears in the file for the first time, and this is correct

The `detail` that gets stored is the live connection's, computed from a **redacted** config, so the
tooltip on a URL connection is `postgresql://app:***@localhost:5432/orders`. Meanwhile the same entry's
`config.url` stores `postgresql://app@localhost:5432/orders` — the password is **deleted**, not masked.

The two spellings sitting side by side are not an oversight, they are two purposes: **the copy that will
be redialled has it deleted** (`***` is a password the driver would really send), **the copy that will be
read has it replaced**. `connection-book.test.ts`'s `a mask would be dialled as a password` case
therefore narrows from "the whole file contains no `***`" to "`config` contains no `***`", and
**asserts** the one in `display.detail` rather than tolerating it — the claim has not changed (the driver
dials `config`), what changed is the assertion's scope, and this is the one place scope narrowed in this
round.

---

## 4septies. Implementation record — §2.3's manifest format, and §2.6 opening up `DriverId`

Two things happened in this step: the fields that are already data were written out as a
zod schema for `peek-package.json` (`packages/core/src/package-manifest.ts`, new), and
`DriverId` went from a six-way enum to "a string with a format, and the registry decides".

### (a) "Not one word changed in the six bundled packages" cannot be done, and the reason is **downstream** of the discriminated union

The criterion this step set for itself was "all green with not one word changed in the six
bundled packages". **It cannot be done, and not because the implementation failed to find
the right road** — §2.6's table listed only the consumers in core and app, and missed the
packages' own side:

```
packages/db-*/src/driver.ts   requireXConfig(cfg: ConnectionConfig): XConnectionConfig {
                                    if (cfg.driverId !== 'postgres') throw …
                                    return cfg          // ← this line rides on the union's narrowing
                                  }
```

Once `ConnectionConfig` is an open record, `cfg.driverId !== 'postgres'` narrows to nothing
and `return cfg` fails to compile on the spot. All three retreats that were tried fail;
recorded so the next round does not retry them:

1. **Add an open branch to the union** (`the six | {driverId: string, …}`). Discriminant
   narrowing cannot remove that branch (`string` is not excluded by `!== 'postgres'`), and
   `return cfg` is still red.
2. **`DriverId = the six literals | (string & {})`**. `Extract` / `Record` exhaustiveness
   both survive, but `'postgres'` is assignable to `string & {}`, so that branch cannot be
   excluded either.
   (There is a second cost: it writes "only these six" back into the type, which is exactly
   what this round is deleting.)
3. **Keep the `ConnectionConfig` type closed and open up only the schema.** `z.infer` *is*
   the type; the two cannot be separated. Separating them takes an `as`, and that is writing
   a lie into the contract.

**Actual change: 8 places across the six packages**, all mechanical, and **run-time
behaviour is unchanged word for word**:

| file | what changed |
|---|---|
| `db-{postgres,redis,qdrant,neo4j}/src/driver.ts` | `if (cfg.driverId !== 'x')` → `if (!isDriverConfig<XConfig>(cfg, 'x'))` |
| `db-sql/src/driver.ts` | same ×2 (mysql / sqlite) |
| `db-sql/src/dialect.ts` | `SqlFlavor = Extract<DriverId, 'mysql'\|'sqlite'>` → the two literals written out directly. **Leaving this one alone fails silently**: `Extract<string, …>` is `never`, so the type is emptied rather than narrowed |
| `db-sql/src/display.ts` | one comment that had already drifted ("deleting one from `DRIVER_IDS` will error here" — no longer true) |

`isDriverConfig` is a new type predicate in core, one copy shared by the six packages.
**It asserts more than it checks**, exactly as the discriminated union did: the union's
guarantee came from `ConnectionConfigSchema` having validated the fields first, and that
validation is now `knownConfig` inside `conn.open` (next section). The predicate's comment
says so.

### (b) Where each of the three compile-time guarantees went

| was | is now | inverse check |
|---|---|---|
| `ConnectionConfigSchema`'s six-way union rejects an unknown driverId | `knownConfig` in `handlers/conn.ts`: look up the registry + validate fields against what the manifest declares, both failures `BAD_REQUEST` | remove the `knownConfig` call → 2 red in `command-bus.test.ts` |
| `DRIVER_DISPLAYS: Record<DriverId, …>` exhaustive (a missing one is a compile error) | `driver-registry.test.ts` reads the keys back and compares against the registry | delete `neo4j: neo4jDisplay` → **typecheck still green** (proof that the compile-time guarantee really is gone), that test red |
| a misspelling in `redact` / `identity` was compared in the test against `ConnectionConfigSchema.options` | compared against **the manifest's own `connectForm`** (the field table is the schema). The disk-package half of it is done at load time by `PackageDriverSchema`'s `superRefine` | postgres's `password` written `passwrd`, redis's `username` written `user` → one red each |

The third row **tightens** the assertion along the way: the old key set included keys with
no form field, such as `connectTimeoutMs` / `searchPath`, and neither of those is something
anybody should be using for identity or redaction.

### (c) Port range validation is lost for now, restored in Phase 3

`min` / `max` are the two "modifiers only the schema cares about" §2.6 asked for, added to
`ConnectField` (rather than starting a second vocabulary). **The six bundled packages do
not declare them today**, so:

```
today: postgres port = z.number().int().positive().max(65535)
after: postgres port = z.number()            ← the bundled packages declare no min/max
```

`port: 99999` goes from "the dialog reports port: Too big" to "accepted, and the driver
fails at connect time". This is the one measurable behaviour regression in this round,
**restored along with the manifest in Phase 3 when the six packages move to
`~/.peek/packages/`** (`"min": 1, "max": 65535`). `type: 'number'` has not been quietly
defined to mean integer — that would be guessing at a vocabulary from six samples, which is
exactly the shape of the detour in §2.3(b).

### (d) `label` and `labelKey` coexisting is **required by this step**, not laziness

Decision 3 requires a package to carry its own copy (`{en, "zh-CN"}`, `en` required). The
six bundled packages still use `labelKey` pointing into the renderer's catalog today, and
they do not move until Phase 3 — so the manifest schema parses both, **but refuses when
both appear at once**: which one wins decides what the user reads, and silently picking one
is the worst answer. The comment on `PackageConnectFieldSchema` in `package-manifest.ts`
nails this transitional state down, and `labelKey` is marked `@deprecated`.

### (e) Every path in main that reads a config now asks the registry

core's `ConnectionConfigSchema` is an open record now, so a `safeParse` against it alone can
**only** say "this is config-shaped" — it cannot say "this driver exists" or "the field
types are right". So the five places in main that relied on the union's strictness all
change to `parseConnectionConfig` from `drivers/manifests.ts` (look up the registry +
validate against `connectForm`):

`store/sanitize.ts` (if it does not parse, the whole row becomes `***`),
`bus/command-log.ts`, `agent/redact.ts`, and `config/connection-book.ts`'s `stripSecrets` /
`mergeSecret` / `parseEntry`.

The `parseEntry` one is **required**, not incidental: the next line is `identityId`, and
`connectionIdentityOf` throws for a driver with no manifest (§2.6's "no retreat to any
fallback"). Inverse check: remove the registry lookup from `parseConnectionConfig` →
`connection-book.test.ts`'s "one unusable row does not cost the others" goes red.

The two unknown-key policies, `'drop'` / `'keep'`: the dialog uses `drop` (a leftover value
from another mode must not survive), main reading from disk uses `keep` (keys with no form
field, such as `connectTimeoutMs`, were written deliberately by an MCP caller, and dropping
them on a read is quietly rewriting the user's connection).

### (f) A bug fixed along the way that only an open `DriverId` exposes

The driver-id segment of `CURSOR_TOKEN_RE` in `cursor.ts` is `[a-z][a-z0-9]*`, which has no
room for a hyphen. None of the six bundled ids has one, but `~/.peek/packages/my-db/` is
something a user can install — the symptom would be "scans for this driver never leave the
first page", identical to `neo4j` hitting `[a-z]+` back then. Changed to
`PACKAGE_ID_PATTERN`'s character class, and the test changes from "iterate `DRIVER_IDS`" to
"iterate samples that regex allows". Inverse check: put `[a-z][a-z0-9]*` back →
`scan-cursor.test.ts` goes red.

### (g) `DRIVER_IDS` is still there, but is no longer the authority on anything

It now means "the six packages compiled into this repo", and its consumers change one by one
to asking the registry (`manifestDriverIds()`): `ConnectDialog`'s driver dropdown,
`connect-form.test.ts`, `display-fallback.test.ts`, and `driver-registry.test.ts`'s second
assertion. `driver-registry.test.ts`'s first assertion **reverses direction** — it used to
be "core added an id with no package behind it", and is now "are the six packages in the
repo all still being collected", because a registry compared against itself proves nothing.
Once the six packages move into `~/.peek/packages/` the question no longer stands, and
`DRIVER_IDS` is deleted with it.

---

## 4octies. Implementation record — the loader (`main/packages/loader.ts`), not wired up

This step turns §2.2's disk layout into one scan: `loadPackages(packagesRoot)` reads every
subdirectory under `<configDir>/packages/` and returns a whole report,
`{loaded, refused, warnings}`. **It has no caller** — wiring it up moves the startup
sequence, and "is the loader itself correct" is a separate question that would mask it, so
they land separately (feed it a fixture directory and it is fully verified).

Two more sentences from §2.2 landed alongside: `config/paths.ts` gains `packagesDir()` and
its header comment is rewritten (acceptance criterion 24), and `resolvePackageAsset`'s root
moves from the build's own UI output tree to `<configDir>/packages`.

### (a) The checklist, and what each item blocks

| check | the failure it blocks |
|---|---|
| the directory name satisfies `PACKAGE_ID_PATTERN` | the UI 404s forever — `resolvePackageAsset` validates the URL host against that same regex (acceptance criterion 7) |
| `peek-package.json` is readable and is valid JSON | a hand-broken file; the error carries `JSON.parse`'s offset |
| `parsePackageManifest` | every field of §2.3 (acceptance criterion 5) |
| the manifest's `id` == the directory name | nothing downstream carries both, and which one gets ignored varies by consumer |
| `entry.driver` / `entry.contrib` are files | `import()` of a path that does not exist = it blows up on the first connection, as far from the fault as possible |
| `entry.ui` *is* `ui/` | see (c) |
| two packages may not declare the same `driverId` | a connection stores only the driverId, and two packages answering to one id is not a merge, it is a coin flip per connection |
| no `redact` block → warning, **still loads** | decision 5 (acceptance criterion 8) |

Three rules about shape, copied from semantics the repo already has:

1. **Any one check fails → refuse the whole package**, no half install (§2.7 step 1);
2. **report every issue at once**, not the first — a manifest wrong in four places should be
   fixed in one round rather than four;
3. **one bad package does not cost the others**: the report is the whole list, not the first
   exception (acceptance criterion 10; `registerPackageViewKindNames` has exactly this
   semantics today).

Names beginning with `.` are excluded before the scan: §2.5's tombstone
`.uninstalled.json` lives right there, and if installation follows `writeJsonFile`'s
"write a temporary, then rename" pattern, an interruption leaves behind a name of that shape
too — half a package must not be reported as a bad package.

### (b) `validateViewKindRegistration` has no footing in main — **undecided**

§2.7 step 1 lists it under "full validation when the manifest is read", and that passage was
written **before decision 7** (the third item of the same step also says the main process
`import()`s `main.mjs`, which §2.4bis has already overturned). It cannot land today:

- one registration is **four functions**, living in `contrib.mjs`; main holding them is
  precisely what decision 7 forbids;
- forking a host per package at scan time to ask is precisely what §2.4bis(c)'s lazy start
  forbids (acceptance criterion 31 counts processes directly);
- §2.4bis(d) says the manifest should carry the data half (`kind` / `driverIds` /
  `titleKey`), but `PackageManifestSchema` has none of those three fields today.

Three ways out; **please confirm which one**:

1. **Add the view kinds' data half to the manifest** and validate it at load time (a new
   function, not `validateViewKindRegistration` — that one requires all four functions to be
   present); the function half is validated by the package host on its first fork. Cost:
   acceptance criterion 6's "refuse to load" degrades to "it installs, and is refused the
   first time it is used".
2. **Hold acceptance criterion 6 to the letter**: the functions must be visible at scan time
   → conflicts with decision 7, which amounts to overturning decision 7.
3. **Accept 1's degradation and rewrite acceptance criterion 6**, changing "refuse to load"
   to "refuse the contribution and name it".

Until it is confirmed, `loader.ts`'s header comment states the situation plainly rather than
quietly picking one.

### (c) `entry.ui` and the `ui/` that is actually served are two spellings; the loader makes them agree

`resolvePackageAsset` runs once per subresource with no manifest in hand, so what it serves
is the constant path `<packages>/<id>/ui/`; whereas `PackageEntrySchema`'s `ui` is "a path
relative to the package directory", and writing `dist` is legal too. The consequence of
disagreement is **a clean install where every asset 404s** — exactly the half install the
loader exists to block.

The loader is the only place that can see both sides, so it does the refusing: `entry.ui`
resolved must equal `<dir>/ui`. **The side effect is that `entry.ui` has exactly one legal
value today** — so either the next step deletes it from the manifest (the layout is fixed,
nothing to declare), or the protocol handler gets each package's ui root from the loader.
Please settle this one along with the above.

### (d) The current cost of moving the root: nothing reads the old UI output tree any more

`installPackageProtocol(packagesRoot)` now takes a parameter, and `main/index.ts` passes
`packagesDir(resolveConfigDir())`. The old UI output tree's root-resolving function
therefore lost its consumer and was deleted with it.

**The cost is that between this step and Phase 3, neo4j's `graph` view has no UI to fetch**:
that UI build script still builds into `neo4j/` under its own `out/` subtree, and that is no
longer on the path being served; it comes back together only when the six packages move into
`~/.peek/packages/`. The two related pieces of copy (`PackageFrame`'s "the UI is not built"
notice, and the build command inside `view.packageUnbuilt`) change in Phase 3 along with it;
changing them now would point at a location that does not exist yet.

Acceptance criterion 9 (paths outside `ui/` return null) is `assets.test.ts` re-run after the
root change, with not one assertion relaxed: there is one more — "the package's own
`peek-package.json` cannot be fetched" — because the manifest, `driver.mjs` and `contrib.mjs`
now all sit **one level above** the served root.

### (e) Header comment: `packages/` ends "the three files it is allowed to write"

`config/paths.ts` used to open with "the three files it is allowed to write". With the
package directory that closed set no longer holds, and it is rewritten to: everything peek
writes lives under one directory a person can open, and **the package's own directory is the
boundary at which anything read out of it has to be checked**.

### (f) Inverse checks: nine, each measured

Break one thing, run once, restore (scripts in the scratchpad, not committed):

| broken | what goes red |
|---|---|
| drop the `PACKAGE_ID_PATTERN` check on the directory name | "a directory name peek could not serve" |
| drop "manifest id == directory name" | 2 cases |
| do not check whether `entry.driver` exists | 2 cases |
| drop "`entry.ui` must be the directory that is served" | 1 case |
| allow two packages to declare the same driverId | 1 case |
| drop the redact warning | 1 case |
| stop the scan at the first bad package | "one bad package does not cost the others" |
| stop excluding names beginning with `.` | 2 cases |
| report only the first issue | "every issue in one package is reported" |

The first two came back **green** on the first run; both times the test was written too
loosely, and both have been tightened: the directory-name case had the `id` inside the
manifest spelled wrong as well, so the schema reported first (getting in front of the check
itself); the `.` case had only put two **files** there, and files were already filtered out
by "must be a directory" — adding a `.installing-redis` directory is what actually nails it.

### (g) Two things explicitly not done

- **`manifest.peek` is not validated.** §2.5 only settled how two *package* versions compare,
  not what range of peek versions counts as compatible. Until that policy is written down,
  inventing one here is offering a second opinion in the wrong file.
- **There is nothing resembling "check whether this package is trustworthy"** (decision 6).
  Every check above asks "can peek use this package"; not one of them stops a package that
  has decided to do harm — once a connection is open, `driver.mjs` runs with the user's
  privileges.

---

## 4nonies. Implementation record — deleting the three synchronous display functions in `drivers/manifests.ts`

> 2026-08-11. After §4sexies paid off the last caller, `connectionLabel` /
> `connectionDetail` / `endpointSummary` **are called by no shipping process at all**; only
> tests still call them. This section records the reasoning for "delete" rather than "keep
> them and add a paragraph of explanation", plus a hole that only an inverse check exposed.

### (a) State of play: one kernel rule in two copies, with the assertion nailed to the copy that does not ship

Only two things are left inside those three functions:

- **one table lookup**: `DRIVER_DISPLAYS[config.driverId]`, plus a `displayFor` that throws
  on a miss.
- **one kernel rule**: the `config.label ||` at the top of `connectionLabel`.

The table lookup is already done twice on the shipping path, and neither is a "parallel
spelling": `main/packages/entry.ts` slices `DRIVER_DISPLAYS` per package and hands it to the
host, and the `display` branch of `PackageHostRuntime.dispatch` in `core/package-host.ts`
reads it back out of that slice by the same `driverId`. One table, one key, across a process
boundary.

The shipping implementation of `config.label ||` is `labelOf` in
`main/packages/display.ts`. Both places name the other, and both say "this is the kernel's
rule, and it did not move into the package along with the derivation" — so the duplication
itself is **on the record**, not something nobody noticed.

The real problem is not the duplication, it is that **the only case testing that rule is
nailed to the copy that does not ship**: `a name the user typed always wins` in
`drivers/__tests__/connection-label.test.ts` calls `connectionLabel`.

**Inverse check (the measurement that decided this section)**: take `config.label ||` out of
`labelOf`, leaving only `return requireString(derived, 'label', packageId)`, and the whole
desktop suite —

```
ℹ tests 1723
ℹ pass 1723
ℹ fail 0
```

— all green. Which is to say: delete that rule from the shipping path today and nothing
makes a sound. And what it guards is "a name the user chose is never quietly changed by a
package", which is precisely the half assigned to the kernel in §2.3(b)'s split table.

### (b) Decision: delete them, and pull the rule back to one place

Two roads:

- **(A) Delete the three and have the tests assert against `DRIVER_DISPLAYS` directly.**
  Cost: the `config.label ||` assertion needs somewhere else to land.
- **(B) Keep them, and add a paragraph on why an app-side dispatcher with no shipping caller
  is worth its weight.**

**(A) is taken**, and the reason is not tidiness:

1. `DRIVER_DISPLAYS` is **not** an alternate spelling of `connectionLabel`; it *is* the very
   value `entry.ts` hands the host. Asserting against it = asserting against the objects that
   ship; routing through `connectionLabel` is one extra hop that exists only for the
   assertion.
2. (B)'s paragraph cannot be written honestly. §4sexies(d) set the standard: for an
   exemption to stay, the other road has to be worse *and* the exemption has to check itself
   (the two `UNSIGNABLE` cases). Here the other road is strictly better, and no self-check
   catches the hole in (a) — the hole is caused by this very exemption.
3. After the deletion `config.label ||` exists in one place, and that place has a direct test
   for the first time.

**Deleted along with them**: `displayFor` (private, serving only those three) and
`lookupDisplay` (exported, and with those three gone it likewise has zero callers — keeping
it just moves the same problem one slot over). The display half of `manifests.ts` is left
with one table and a header comment, and not one function that "looks like the shipping
path".

### (c) The kernel rule's new home, and why it has to be exported

`labelOf` is exported from `main/packages/display.ts`, and its signature tightens from
`(config, derived: unknown, packageId)` to `(config, derive: () => string)`:

```ts
export function labelOf(config: ConnectionConfig, derive: () => string): string {
  return config.label || derive()
}
```

**The laziness is part of the semantics, not a side effect of `||`.** The original
`config.label || requireString(answer.label, …)` short-circuits, so the combination "the user
typed their own name + the package's `label` returned a non-string" **does not error**.
Computing first and judging after would fail the whole `describe` for that connection — and
`describeConnection` is soft intent: the connection still opens, all three strings are lost,
and the book stores nothing, all spent on a field that will not be used. The thunk states
this, and gives the second caller the same short-circuit behaviour.

The second caller is `named()` in `main/bus/__tests__/connection-book.test.ts`. It stands in
the package host's position, and the answer that side hands back is composed of two halves to
begin with: the string the package computed, plus main's `config.label ||`
(`StoredDisplay.label`'s comment says "this rule has already been applied", and the two
`remember(book, pg({ label: 'staging' }))` cases depend on it). It used to get that composed
result in one call through `connectionLabel`; now it composes explicitly — the package half
calls `DRIVER_DISPLAYS` directly (main itself may not do this; a test is not main's bundle,
§2.3(b-2)), and the kernel half calls `labelOf` itself. **More faithful than before**: it
used to call a copy of the kernel rule, and it would not have made a sound if the copy and
the original diverged.

### (d) Where each assertion moved

| where the three functions used to be called | now |
|---|---|
| `a name the user typed always wins` in `connection-label.test.ts` | moved to the new `main/packages/__tests__/connection-display-service.test.ts`, against `createConnectionDisplayService` and a real host stub |
| the remaining ~40 cases in `connection-label.test.ts` | stay put, routed through this file's own `label()` / `detail()` / `endpoint()` helpers, which read `DRIVER_DISPLAYS` |
| the three in `display-fallback.test.ts` | same |
| `named()` in `connection-book.test.ts` | `labelOf` + `DRIVER_DISPLAYS`, see (c) |
| `connectionDetail` in `connection-rows.test.ts` (the original list missed this one) | `DRIVER_DISPLAYS[…].detail` |

The new file also picks up cases for `requireString`. Like `labelOf` it grows on the side of
the boundary that cannot be trusted (the two kernel rules listed side by side in
`display.ts`'s header comment), and it had not had a single test either — `lazy-start.test.ts`
does construct `createConnectionDisplayService`, but it counts forks: the config it feeds in
carries no `label`, and the stub always answers with three legal strings.

### (e) One correction along the way

That assertion in `driver-registry.test.ts` had a failure message reading "otherwise
`connectionLabel` throws for every saved connection", and the comment block above it still
described `toSavedConnection` computing a label for each saved connection on the spot. Both
sentences expired the day §2.3(b-2) landed (the book stores strings; nothing is recomputed).
`display-fallback.test.ts`'s header comment was corrected at the time; this one was missed.
Because the message names a function that is about to not exist, it is changed at the same
time to the odds it actually carries today: a missing display means **connections on that
driver cannot be named**, not that the whole sidebar collapses.

### (f) Acceptance

Four green: `pnpm typecheck`, `pnpm --filter @peek/desktop test` (1723 → **1730**, 1 deleted,
8 added), `pnpm build` (including `assertMainHoldsNoPackageCode` and the output checks), and
`node apps/desktop/scripts/audit-package-boundary.mjs`.

The last two are the only ones needing extra confirmation this time, because the three
deleted functions were the only thing in a module main **may** load that touched
`DRIVER_DISPLAYS`. The audit summary is unchanged word for word, which says the deletion only
made tree-shaking more certain and dragged no package code into `index.js`:

```
main loads 2 file(s) / 320371 B and holds none of the 10 string(s) derived from
8 host-only module(s) in 5 package(s) (2 module(s) excused by main-may-reach.ts,
5 unsignable); the package host loads 1 file(s) / 39132 B and holds all 10
```

Three inverse checks, all run against the new file `connection-display-service.test.ts`
(baseline 8/8 green), all restored:

1. **Take `config.label ||` out of `labelOf`** → `pass 6 / fail 2`:
   `outranks what the package computed` and
   `costs nothing when the package botches the label it was going to lose anyway` go red
   together. Compare with (a): **the same change, before this file existed, left all 1723
   green.** This one check is the entire reason for this section.
2. **Change `||` to `??`** → `pass 7 / fail 1`:
   `is not the empty one — that is a label the user cleared, not one they chose` goes red.
3. **Hoist `requireString(answer.label, …)` out of the thunk so it is computed first** →
   `pass 7 / fail 1`:
   `costs nothing when the package botches the label it was going to lose anyway` goes red.
   What this nails is the short-circuit in (c): the change makes nothing "stricter", it makes
   a connection **the user named themselves** fail its whole describe because the package got
   a field wrong that was never going to be used.

The third also shows the thunk is not a stylistic preference — it is the only shape in which
this semantics can be asserted.

### (k) `pnpm dev` got 5 seconds more expensive, and today those 5 seconds have no consumer

The old UI build script built only neo4j's UI; `build:packages` measures **5.0s** cold
(11 Vite builds: 5 drivers + 5 contribs + 1 UI), and like the package UI it is not watched by
`electron-vite dev` — changing package code means running the command again.

Worth writing down more than that: **nothing reads `out/packages/` today**.
`installPackageProtocol`'s root is `<configDir>/packages`, drivers still come from the
compiled-in `out/main/driver-host.js`, and contrib is still the static table in
`main/packages/entry.ts`. This directory gets a consumer only once §2.5's first lay-out
(copying it into `~/.peek/packages/`) and the loader have landed.

It stays in `dev` and `build` regardless, for the same reason the package UI went in: a
separate pass is a pass that **can be skipped**, and the symptom of skipping it (a package
missing from the shipped app) shows up as far away as possible. `package-mac.mjs`'s
`REQUIRED_FILES` now names four neo4j files rather than one, precisely so that "it was
skipped" blows up at packaging time rather than on a user's machine.

---

## 4decies. Implementation record — laying out the bundled packages (§2.5), and packages carrying their own copy (decision 3)

> 2026-08-11. This round did §2.5's three rules and §2.3(c); it **did not do** "replace the
> three static aggregates with the loader's output" nor the two dynamic `import()`s. (f)
> explains why those are one job and where it is stuck.

### (a) Package ids are unified on the name that is served

Of the two answers left over from last round (called out in the briefing after §4octies),
only one remains:

| who | before | now |
|---|---|---|
| `PACKAGE_DRIVER_IDS`'s keys / `PEEK_PACKAGE_ID` / `serviceName: peek-package-<id>` | `db-neo4j` | `neo4j` |
| §2.2's disk layout / `peek-package://<host>` / `build-packages.mjs`'s `out/packages/<id>` | `neo4j` | unchanged |

The prefix-less side wins, and the reason is not brevity: it is simultaneously the host
`resolvePackageAsset` builds its URL from, the directory name under `~/.peek/packages/`, and
the directory name under `bundled-packages/`. The prefixed side has exactly one source — the
directory in the repo is called `packages/db-neo4j` — and that is a fact about the workspace,
not a fact about what is installed. The comment in `drivers/packages.ts` now says so.

### (b) Where bundled packages live, and why not inside `out/`

```
peek.app/Contents/Resources/bundled-packages/<id>/   read-only, inside the signature
peek.app/Contents/Resources/app/out/                 the app's own code, no packages
```

`package-mac.mjs` used to copy the whole of `out/` into `Resources/app`, which took
`out/packages` along with it. It now excludes it on copy and lays a separate copy down as an
`extraResource`. **Not to save 3 MB** — but because with two identical trees in one bundle,
the next person has no basis for deciding which one is the one being loaded, and the correct
answer is "neither": what is loaded is the copy in `~/.peek/packages/`.

There is no `Resources` in development, so `bundledPackagesRoot(mainDir, resourcesPath | null)`
gives both answers in one function: `null` takes `out/packages`, the sibling of `out/main`
(the same relative rule by which `PackageHostRegistry` finds `package-host.js`); non-`null`
takes `Resources/bundled-packages`. `app.isPackaged` is passed in by main, so this module
does not import electron — the same reasoning as `resolveHostDir` taking `allowOverride`.

The name `bundled-packages` is spelled in two places (`package-mac.mjs` and `bundled.ts`),
because the packaging script runs under plain node with no resolver hook, while `bundled.ts`
can reach `@peek/core`. **The symptom of the two disagreeing is "0 packages laid out", and
that looks exactly like a legitimate first launch**, so `bundled.test.ts` reads
`package-mac.mjs`'s source and nails them together.

### (c) The three rules, and why the third is ordered after "does the target exist"

`layOutBundledPackages({bundledRoot, packagesRoot})` is synchronous and returns one
`BundledPackageStatus` per bundled id. Six outcomes:

| outcome | when | does it write to disk |
|---|---|---|
| `laid-out` | rule 1: not present, no tombstone | yes |
| `suppressed` | rule 3: a tombstone is present | no |
| `kept` | rule 2, what is installed is not older than what is bundled | no |
| `upgradable` | rule 2, the bundled one is newer — settings offers a button, **nothing happens here** | no |
| `unreadable` | the directory is there, the manifest cannot be read, so there is nothing to compare | no |
| `failed` | the bundled manifest cannot be read, or the copy failed | no |

**The tombstone test goes inside "does the target exist", not outside**, and this was not
written casually: the tombstone records that the user threw away **the bundled copy**, and
says nothing at all about a package they later installed under the same id themselves.
Putting it outside would let a decision about one package erase the user's own installation
from the settings list. There is a dedicated case nailing it.

`unreadable` is a sixth outcome rather than being folded into `upgradable`: peek has no
version number in hand that could be "higher", and inventing one would mean labelling a
directory that is not even loaded with a version in settings.

Versions read only the first three segments (§2.5), and are read **only from a manifest that
passed `parsePackageManifest`**. Reading the `version` key straight out of the JSON would let
a file containing `{"version":"9.9.9"}` impersonate an installed package — that inverse check
came back green the first time; see (e).

### (d) The copy goes through a staging name beginning with `.`

`cpSync` to `<packages>/.installing-<id>`, then `renameSync` to `<id>`. Two properties, one
case guarding each:

1. **Half a package wears a name the scan cannot see** — `loadPackages` reports
   `.installing-neo4j` as neither loaded nor refused. This one asserts across two modules,
   because it *is* the contract between the two modules (the loader's `.`-prefix filter and
   this prefix are one decision).
2. **`cpSync` merges into an existing directory**, so debris left by a kill in a previous
   round has to be swept first, or two builds blend into a package that is neither version.
   The sweep runs once before the loop, covering the case where this round does not copy that
   id at all (already installed, blocked by a tombstone, or no longer shipped with the app).

`copyIn` also used to delete the staging directory before copying; that was **removed** — the
inverse check proved the debris it blocked no longer exists once `clearStagingLitter` has run,
making it a check that cannot fail.

**One thing not directly verified, stated plainly**: "killed halfway through the copy" cannot
be made into a deterministic case (`cpSync` silently skips FIFOs, and chmod 000 takes the
whole process down with a C++ exception). What landed is "a failed lay-out leaves nothing of
its own behind", which nails the cleanup on the failure path; atomic publication itself is
guarded indirectly by the naming contract in point 1 above.

### (e) Inverse checks: ten, each measured (scripts in the scratchpad, not committed)

| broken | what goes red |
|---|---|
| ignore the tombstone | 2 cases |
| overwrite whenever the bundled copy is newer | `a newer shipped copy is offered, not taken` |
| overwrite even when it exists | 5 cases |
| move the tombstone test before "does the target exist" | `it does not reach a package the user installed under the same id afterwards` |
| do not sweep staging debris | 2 cases |
| read the version straight from the JSON `version` key | `a version peek reads is one it read off a manifest…` |
| compare versions as strings | 2 cases |
| append to the tombstone instead of replacing it | `uninstalling the same id twice records the later removal, not both` |
| staging name without the `.` prefix | 2 cases |
| no cleanup on the failure path | `a lay-out that fails leaves none of itself behind` |

**Three of them came back green on the first run; all three times the test was written too
loosely, and all three are tightened**:

1. "do not sweep staging debris" — the case put the debris under **the id this round was
   going to copy**, and `copyIn` had its own delete as a backstop. Changed to put debris under
   an id that is **already installed and will not be copied this round**, and the redundant
   delete in `copyIn` was removed along the way (see (d)).
2. "read the version straight from the JSON key" — the case's bad manifest was
   `{ this is not json`, which does not even get through `JSON.parse`, so both readings give
   the same answer. Changed to `{"version":"9.9.9"}`: parseable, carries a version, is not a
   manifest.
3. "copy straight to the final name instead of staging" — **this one still has no case that
   can fail**; on the success path the two spellings have no observable difference. It was
   replaced by the tenth row above (cleanup on the failure path), and the half that cannot be
   done is written into (d) rather than pretended to be guarded.

### (f) The four not done, and why they are all stuck in the same place

Six items on the task list; this round landed 1, 2 and 6. Items 3, 4 and 5 were **not done**,
and not for lack of time:

- **Item 3 (replace the three static aggregates with the loader's output) is blocked on the
  undecided question in §4octies(b), and harder than that section said.**
  `PackageManifestSchema` has **neither** a `viewKinds` field nor a `tools` field — and
  §2.4bis(d) requires the manifest to carry the data half precisely so that `tools/list` and
  "which views can this connection open" need not wake any package process (acceptance
  criterion 31 counts processes directly). Which is to say: until the manifest carries those
  two, main has no second source to switch to.
  Of §4octies(b)'s three ways out, 1 and 3 are the same thing for the **implementation** (the
  manifest carries the data half, load time validates it, the function half is left to the
  host's first fork); only acceptance criterion 6's wording differs. Way out 2 amounts to
  overturning decision 7. **Please still confirm 1 or 3** — this round did not choose for you.
- **Items 4 and 5 (dynamic `import()` of `driver.mjs` / `contrib.mjs`)** technically do not
  need item 3 — the static `packageIdForDriver` table can already turn a driverId into a
  package directory name. What blocks them is something else: item 4 takes all five database
  clients out of `out/main/driver-host.js` (2.7 MB today, all inlined `pg` / `mysql2` /
  `redis` / …), and knocks on to the premises of `optionalDepAlias`,
  `stage-node-modules.mjs` and `audit-package-boundary.mjs`. That is an independent change
  needing its own round of inverse checks, and mixing it with "lay out the bundled packages"
  would make it impossible to tell which half broke when something goes wrong — the same kind
  of cost recorded in §3.7.

**After this round `~/.peek/packages/` has content for the first time, but still has no
consumer**: the protocol's root has pointed there since §4octies(d), so neo4j's `graph` view
**can fetch its UI again as of this step**; drivers still come from the compiled-in
`driver-host.js`, and contrib is still the static table in `main/packages/entry.ts`.

### (g) Decision 3: packages carry their own copy, and exactly where that compile-time check went

`ConnectField.labelKey: K` → `ConnectField.label: LocalizedText`. Knock-on effects:

- the type parameters on `DriverManifest<K>` / `ConnectFormSpec<K>` / `ConnectField<K>` are
  all deleted — they existed only for labelKey;
- **`defineManifest` is deleted** — it existed only to keep labelKey's literal type from
  widening; the five packages switch to a `: DriverManifest` annotation;
- `LocalizedTextSchema` / `localizedText` move from `package-manifest.ts` into `manifest.ts`
  (`ConnectField` now uses it, and importing the other way would cycle);
- `PackageConnectFieldSchema`'s transitional `labelKey` is deleted and `label` becomes
  required — §4septies(d) called it "a plank that will be pulled out", and this step pulls it
  out;
- 14 `connect.field.*` keys are deleted from the renderer's catalog, one copy each in en and
  zh-CN.

**What that compile-time check (`connectForm.ts:60`, named in decision 1's ledger) looks like
now**: it was not replaced, **its subject was taken away**. The annotation
`readonly DriverManifest<PlainMessageKey>[]` on that line used to make a package with a
misspelled key fail to compile on that line and name the key. Today the key does not exist,
and no compile-time check covers field labels. The replacement comes in two halves, both
written into that comment block in `connectForm.ts`:

| | what it guards | when it sounds |
|---|---|---|
| `PackageConnectFieldSchema`'s `label: LocalizedTextSchema` | every field has at least `en` | refused at load time (for packages outside the repo, this is the **only** possible moment) |
| `manifest-labels.test.ts` / `connect-form.test.ts` | the five bundled packages **write every language peek supports** | `pnpm test` |
| — | consistent wording (six packages each writing "Host") | **no guard**; §2.3(c) already states this one rides on people |

Both tests changed, one place each, and both are "ask the package rather than the window":
they used to assert `field.labelKey in CATALOGS[locale]`, and now assert that
`field.label[locale]` is a non-empty string.
**Acceptance criterion 1 says `connect-form.test.ts` does not change by one line, and that
was not met** — it tests labelKey, and labelKey is what decision 3 deletes; the ledger's
prediction about `connectForm.ts:60` ("decision 3 takes its subject away at the same time")
holds for this test just as much. Form **behaviour** is unchanged word for word: the rest of
`connect-form.test.ts`'s cases are untouched and all green.

`serializeDriver` in `build-packages.mjs` has one difference fewer (three before, two now):
labels are carried through verbatim, because there is no longer anything that needs
translating on the way to disk.

**Inverse checks (two, both measured)**:
- remove `zh-CN` from postgres's `host` → one red case in each of the two tests;
  `pnpm build:packages` stays green (the schema only requires `en`, which is correct: it
  installs, it just shows one English word in the Chinese UI).
- remove `en` from postgres's `host` → both tests red, **and the build fails before writing
  to disk**, naming `drivers.0.connectForm.fields.fields.0.label.en`.

### (h) Acceptance

`pnpm typecheck` 0 errors; `apps/desktop` **1756/1756** (baseline 1730, 26 added);
`packages/core` **97/97** (3 deleted, 2 added); `pnpm build` passes (including the render
probe); `audit-package-boundary`'s conclusion is unchanged (main 2 files / 323480 B / holds
none of the 10 signature strings, the package host holds all of them). The five driver
packages: postgres 60/0, qdrant 11/0, sql 44/0, neo4j 71/0, redis 36/**1** — the red one,
`builds a namespace tree from key prefixes, lazily`, **is still red** after a `git stash` back
to HEAD, and is unrelated to this round.

`writeTombstone` / `clearTombstones` are called **only by tests** today. This is deliberate:
rule 3 reads tombstones, and without the writing half that rule is dead code; but their
callers, `packages.uninstall` and "restore a bundled package", are §2.4's command table and
§2.8's settings panel, neither of which is among this round's six items.

---

## 4undecies. Acceptance record — acceptance criterion 11: a package from outside the repo

### (a) The fixture: `apps/desktop/fixtures/packages/echo/`

Acceptance criterion 11 says "build a package outside the repo, put it in
`~/.peek/packages/`, and confirm it loads, appears in the connect dialog, and that the app was
not repackaged". Doing that once has no value — the next person either redoes it or takes a
sentence on faith, so the fixture is **committed**:

```
fixtures/packages/echo/
  peek-package.json   one driver (`echo`), two fields, declares redact
  driver.mjs          imports nothing; connect hands back a session, scan gives two constant rows
  contrib.mjs         one display, no viewKinds / tools
  ui/index.html       self-contained, no external resources
```

**Hand-written rather than generated by the test**, and that is the division of labour between
it and `loader.test.ts`: over there the twelve refusal cases each change one key of the same
manifest literal — the assertion and the value being asserted are written by the same file, so
they drift together. Here the subject under test is a directory tree on disk with no generator
behind it. **`driver.mjs` has not one import line** for the same reason: a package outside the
repo cannot resolve this workspace, and a fixture that imports `@peek/core` proves only "a
package from the workspace was put in a different directory".

Two assertions in `src/main/packages/__tests__/third-party-package.test.ts` watch it: that the
whole package is accepted (all three entries resolve to absolute paths, zero warnings), and
that the directory `entry.ui` declares **is** the one `resolvePackageAsset` will serve
(§4octies(c)'s two spellings, made to agree by a real package for the first time). Inverse
checks: remove the label's `en` → both red, naming
`drivers.0.connectForm.fields.fields.0.label.en`; change `entry.ui` to `web` → both red,
naming `entry.ui`.

### (b) How far acceptance criterion 11 gets

**The loader half works, the connect-dialog half does not, and the blocker is exactly
§4octies(b) / step 3.**

Measured (`PEEK_CONFIG_DIR` pointed at a temporary directory, with no repackaging of the app
at any point):

1. launch the build output once → five bundled packages appear in `<configDir>/packages/`
   (§2.5 rule 1);
2. copy `echo` in, **without rebuilding**, and run `loadPackages` over that same directory →
   all six packages accepted, `refused` empty, `warnings` empty, and `echo`'s driver / contrib
   / ui entries all resolve;
3. launch again and ask MCP `connect` for `driverId: 'echo'` →
   **`BAD_REQUEST Driver echo is not registered`**; the `connect` tool's description also
   carries examples for only the six bundled drivers.

Step 3's answer is correct: `loadPackages` has **no production caller** today, and both main
and the window still build the registry from the compile-time list in `drivers/manifests.ts`.
So whether a package on disk can be *read* now has an answer; whether it can be *used* waits
on step 3 (add the `viewKinds` / `tools` data halves to the manifest, then replace the three
static aggregates with the loader's output). The fixture is already sitting there waiting for
that step.

### (c) Inverse checks: five, measured against this fixture

| broken | result |
|---|---|
| remove the label's `en` | refused, naming `drivers.0.connectForm.fields.fields.0.label.en` |
| directory named `Echo` | refused, two issues: unservable directory name + illegal manifest `id` |
| delete the `redact` block | **still loads**, with one warning naming `echo` (control: zero warnings with `redact` present) |
| put a bad package beside it plus a second package claiming `echo` | `echo` loads as usual, and the other two are each refused with a reason |
| a view kind missing `autoFetch` | `validateViewKindRegistration` answers `{kind, missing:['autoFetch']}` — **but nobody on the load path calls it**, see §4octies(b) |

The last is the only one of the five that has not landed: the manifest has no `viewKinds`,
registration is four functions inside `contrib.mjs`, and main may not hold them. This is not a
missing check, it is that undecided question still being undecided.

### (d) 0 packages installed vs 20 packages installed

A scratchpad copy of `bench-startup.mjs` (N copies of the fixture pre-laid into each run's
temporary config directory, each with its own id and driverId), warm ready-to-show medians:

| | round 1 | round 2 |
|---|---|---|
| 0 packages | 562ms | 558ms |
| 20 packages | 560ms | 571ms |

The two rounds point in opposite directions, -2ms / +13ms, both under the 20ms signal line and
both inside the same round's min→p95 spread (about 50ms). **What this number proves today is
"no unexpected overhead", not "scanning twenty packages is cheap"** — nothing on the startup
path scans `packages/`, and the twenty directories were not even read. This row needs
re-measuring after step 3 wires it up.

## 4duodecies. Implementation record — adding `viewKinds` / `tools` to the manifest (§4octies(b) decided)

### (a) Which way out was taken

Of §4octies(b)'s three ways out, **1 / 3** (the same thing for the implementation; only
acceptance criterion 6's wording differs): the manifest carries the **data half** of view
kinds and tools and load time validates it; the function half is left to the package host's
first fork. Way out 2 amounts to overturning decision 7, and is not taken.

`validateViewKindRegistration` **is not called on the load path** — the last row of
§4undecies(c)'s table confirmed by measurement that it has no footing in main (a registration
is four functions, living in `contrib.mjs`). Its footing now is the package host's first fork,
which is the next phase's business.

Before this step `PackageManifestSchema` had neither field, so §4decies(f)'s item 3 (replace
the three static aggregates with the loader's output) **had no second source to switch to at
all**. This step supplies that source.

### (b) The two blocks in the manifest; the fields are the left column of §2.4bis(d)'s table

| | manifest (`peek-package.json`, read at startup, pure data) | `contrib.mjs` (fork only when used) |
|---|---|---|
| view kinds | `kind` / `driverIds` / `title` | `autoFetch` / `describe` / `title` / `collectionRef` |
| tools | `name` / `description` / `inputSchema` | the handler (`toCommands` / `render`) |

Both blocks are **optional** (`.default([])`): a package may well contribute neither. Unlike
`redact` — there, "not written" and `{}` are two different statements, and merging them would
delete decision 5's only signal; here "not written" and an empty array are the same package,
and every consumer is a `for` loop. Nothing extra is written to disk:
`build-packages.mjs` writes the candidate, not the result of a parse.

**`titleKey` becomes `title: LocalizedText`.** Same thing as decision 3 replacing `labelKey`
with `label`, for a reason that is word for word the same: `view.kind.graph` is an entry in the
**renderer's** message catalog, and a package installed from outside the repo has no way to add
anything to that catalog — whatever key it declares is the key painted on the tab. Note this is
not the same as `title(view)` in the registration: that one names **one open view**
("Graph :Person"), while the one in the manifest names **this kind of view** ("Graph").

The tools' three fields are the whole of an MCP `Tool`, so `tools/list` can be answered from
the manifest alone — which is exactly what acceptance criterion 31 (20 packages installed and
0 processes while unused) requires. `kind` / `hasRenderer` / `annotations` did not go into the
manifest; see (f).

### (c) Validation splits into two layers, along "can one manifest see it"

**`PackageManifestSchema` (pure function, touches no disk):**

- view kinds: `kind` non-empty; `driverIds` non-empty and every one of them a driver this
  package itself declares; `title` is a `LocalizedText` (`en` required); two `kind`s of the
  same name in one package are refused.
  The `driverIds` rule is not fastidiousness: a package declaring a driver it does not have
  makes that view kind appear on **another package's** connections, and opening it forks
  **this** package's host to plan the fetch — one Cypher query fired at PostgreSQL.
- tools: `name` within `^[a-zA-Z0-9_-]{1,64}$`; `description` non-empty; `inputSchema` a JSON
  Schema with `type: "object"` and every value in `properties` a subschema; two tools of the
  same name in one package are refused.

**`loader.ts` (the half that only becomes visible once the whole directory is scanned):**

- two **packages** may not declare a tool of the same name. Tool names are one global flat
  table over MCP (shared with the kernel's 13, at that), and the model picks purely by name, so
  a collision is not a conflict that scoping can resolve — which one the executor routes to is
  a coin flip, and that call touches the user's database. Same shape as the cross-package
  `driverId` rule, same location.

**Two things explicitly not checked**, so they are not mistaken for oversights next time:

1. **Full validation of the JSON Schema.** peek forwards this value verbatim to the MCP SDK,
   which forwards it to the model provider; keeping a meta-schema here amounts to holding an
   opinion about a dialect peek does not interpret, and would refuse packages that would
   otherwise work. Only the dialect-independent part is checked: a tool is called with a
   **named-argument object**, so its schema is an object schema. `$ref` / `allOf` / boolean
   subschemas are all let through, and there is a case nailing that passage down.

   **Narrowed once on 2026-08-11, see §4duodevicies(c).** "No opinion held" still stands, but
   there is one more dialect-independent hard requirement: this schema must be convertible into
   a zod schema by `z.fromJSONSchema`, because executing a tool call uses it to validate the
   arguments. This is not peek preferring a dialect, it is what peek's execution path
   **needs** — a tool whose schema will not convert simply cannot be called, and refusing it by
   name at install time beats refusing it the first time a model calls it. All three passages
   above were measured and still pass.
2. **A package tool colliding with one of the kernel's 13.** The loader does not have the
   kernel's tool table in hand; this one waits for step 3 (replacing `PACKAGE_TOOL_META` with
   the loader's output), where it is done at the registry layer.
   **Still outstanding**: §4duodevicies replaced `PACKAGE_TOOL_META`, but the collision rule
   landed on that `throw` in `collectTools()` — which today is still a `throw` rather than "skip
   this package and report it"; see §4duodevicies(g) item 1.

### (d) Sources: what the package already declares, no second copy

- **view kinds** → `packages/db-neo4j/src/manifest.ts` gains a `graphViewKindMeta` export.
  It lives in `manifest.ts` rather than beside `./view` because the definition of this half is
  precisely "readable without running any code"; conversely `./view`'s registration takes its
  `kind` and `driverIds` from it (`GRAPH_VIEW_KIND` now reads it), so the two halves cannot
  contradict each other. Measured: rename the `kind` in the manifest and rename it in
  `contrib.mjs` to match, and the guard below **stays green** — which is exactly how a single
  source should behave.
- **tools** → `packages/db-neo4j/src/mcp-tool-meta.ts`, the very module main reads (§4ter(b)).
  `inputSchema` is turned into JSON Schema by `z.toJSONSchema` at build time: anything that
  will not convert (transforms, refinements with no JSON form) blows up at build time rather
  than in the face of whoever installs the package.
- **A new guard**: the built `contrib.mjs` is asked by `probeExports` which kinds it registers
  and which tools it maps, and compared **in both directions** against the manifest's lists. In
  the manifest but not in the host = the model sees a tool that must error; in the host but not
  in the manifest = a view that will never be offered. This comparison sits **outside** the
  `hasContrib` branch: declaring contributions while having no `contrib.mjs` at all is the
  extreme case of the same failure.

### (e) Inverse checks: fifteen, each measured (scripts in the scratchpad, not committed)

Break → red → restore; each names the case, or the sentence, that was expected to go red.

| broken | result |
|---|---|
| drop the cross-package check on a view kind's `driverIds` | red: the `viewKinds.0.driverIds` case |
| drop `.min(1)` on `driverIds` | red: "offered on no driver" |
| drop `.min(1)` on `kind` | red: "nameless kind" |
| change `title` to `z.unknown()` | red: "title without English" |
| drop the addIssue for two `kind`s of the same name | red: "two view kinds under one name" |
| drop the tool-name regex | red: "a name outside the class a model provider carries" |
| drop `.min(1)` on `description` | red: "no description" |
| make the `type === 'object'` refine always true | red: "not an object schema" |
| make the `properties` refine always true | red: "properties are not schemas" |
| drop the addIssue for two same-named tools in one package | red: "two tools of one package" |
| skip the loader's cross-package tool-name check | red: "a second package declaring an MCP tool name the first one already took" |
| declare one extra `chart` view kind in the manifest | red: the build — `registers view kinds [graph] but declares [chart, graph]` |
| hard-code `kind` as `graph-extra` inside `./view` | red: the build — `registers [graph-extra] but declares [graph]` |
| declare one extra `collapse_node` tool in the manifest | red: the build — `maps tools [expand_node] but declares [collapse_node, expand_node]` |
| hang a `.transform()` off `inputSchema` | red: the build — `Transforms cannot be represented in JSON Schema` |

### (f) The three not done, and where each is stuck

1. **`kind` / `hasRenderer` / `annotations` / `title` did not go into the manifest**, because
   the left column of §2.4bis(d)'s table has only three fields, and those three happen to be
   the whole of an MCP `Tool` — enough for `tools/list`. But **executing** a tool needs `kind`
   (read or command) and `hasRenderer` (`defineCommandTool` reads "no `render`" as "use the
   default receipt"). Step 3, when it replaces `PACKAGE_TOOL_META` with the loader's output,
   has to answer this: either add them to the manifest, or take them along with the function
   half on the host's first fork. Execution has to fork anyway.

   **Decided 2026-08-11: add them to the manifest (way out 1). The reasoning, and the cause of
   death of the rejected way out 2, are in §4duodevicies(a).**
2. **The manifest's `title` has no consumer yet.** The renderer still does `t(entry.titleKey)`,
   and the registration still declares `titleKey`. Their coexistence is deliberate: this step
   only makes it **possible** for the manifest to carry its own copy; switching the renderer
   from the message catalog to the manifest belongs to the wiring step.
3. **Acceptance criterion 6's wording is unchanged.** It still reads "refuse to load", while
   the actual behaviour is way out 1/3's "it installs, and the view kinds' function half is
   refused by name the first time it is used". When step 3 wires things up and the package host
   side's validation lands, that line gets changed along with §2.7 step 1.

## 4terdecies. Implementation record — wiring up `loadPackages` (the first half of §4decies(f) item 3)

### (a) What landed

The startup path calls `loadPackages` and turns the result into the registry;
`DRIVER_MANIFESTS` in `drivers/manifests.ts` is no longer a module constant. **This is the
other half of acceptance criterion 11**: §4undecies(b)'s measurement stopped at "readable, not
usable", blocked on main and the window both still building the registry from a compile-time
list.

The order (inside `main/index.ts`'s `whenReady`):

```
layOutBundledPackages(…)     lay out the bundled packages (or the first launch scans an empty directory)
installAndReportPackages(…)  loadPackages → installedFrom → installPackages → notify
ipcMain.on(PACKAGES_READ)    the window's only entry point; must be hooked up before the window is created
installPackageProtocol(…)
bootstrap()                  → createWindow()
```

### (b) The registry is one piece of data, installed once per process

A new file, `apps/desktop/src/drivers/installed.ts`: a slot installed once and read
synchronously thereafter. The shape `InstalledPackages` lives in **core**
(end of `package-manifest.ts`), not in app — it is an IPC payload, the same kind of thing as
`StateSnapshotMessage`.

| | who installs it | with what |
|---|---|---|
| main | `whenReady`, before `bootstrap()` | `installedFrom(loadPackages(packagesDir(configDir)))` |
| window | first line of `main.tsx`, before `initLocale()` | `tryBridge()?.installedPackages` |

`installedFrom` (`main/packages/installed.ts`) computes only two things and carries the rest
across verbatim:

- **restore `version` onto each driver.** A package writes `version` once on disk, and
  `build-packages.mjs` drops the per-driver copy; without restoring it, the settings panel
  cannot tell two installs apart.
- **synthesise `{}` for a missing `redact`.** In the manifest, "not written" and `{}` are two
  statements (decision 5's warning depends on the difference, and the loader has already warned
  by this point), while at run time there is only one behaviour.

### (c) Which IPC the renderer uses — **a new synchronous read command**, and why

The task offered three options (reuse the snapshot/config channel, add a minimal read command,
or decide for yourself). `IPC.PACKAGES_READ` was added, and it is a **`sendSync`**:

- **It cannot be folded into the snapshot channel.** `StateSnapshotMessage` is the Workspace;
  it carries the rev and patch continuity. What packages are installed neither changes with the
  rev nor participates in patch broadcasts, so mixing it in adds a permanently unchanging field
  to the source of truth, and has to be resent in full every time.
- **It has to be synchronous.** All three readers are in module initialisation or in render —
  the connect form's field table, the capability prediction that greys out the query button,
  and package registration before the first frame — and **not one of them has room for an
  `await`**. Asynchronous costs threading "packages not read yet" through those three paths, or
  painting an empty database picker first and filling it in later (and the registry is filled
  once; no re-render will come along to correct it).
- **The cost is one block, and a controlled one.** preload asks once, main answers from an
  object in memory (`event.returnValue`), and the answer was computed before the window was
  created. The handler hangs off `whenReady` rather than `bootstrap()` precisely because
  preload asks before the window's first line of script.

**It is not a general-purpose channel; do not let it grow into one.** "What is installed has
changed" (install / uninstall / upgrade) is a different question: it has to reach a window that
is already open, and answering it here would leave only polling.

One mechanical guarantee on a hard boundary: every field of `InstalledPackages` is the product
of a `JSON.parse`, so it survives `structuredClone` unchanged word for word — there is a case
nailing this. Package code could not hitch a ride if it tried.

The answer preload receives passes through a `hasThreeLists` predicate (the three keys present
and all arrays). That is not validation (the values were parsed by `PackageManifestSchema`
before leaving main, and preload judging again would be a second opinion about a schema it
cannot see) — it blocks "a `sendSync` nobody answered returns `undefined`", which without the
block shows up several modules later as a `.map` over nothing in the window, with no sign of
where it came from.

### (d) Where each of the three static aggregates went

| | result |
|---|---|
| `DRIVER_MANIFESTS` | **gone**. `driverManifests()` reads the registry; `lookupManifest` / `manifestFor` / `redactRulesFor` / `connectFormOf` / `driverCapabilities` / `parseConnectionConfig` all switch to reading it, with no signature changed. Five `@peek/db-*/manifest` imports disappear from this file (the five `/display` ones stay; `DRIVER_DISPLAYS` was left alone as required) |
| `DRIVER_REGISTRY` | becomes `driverRegistry()` / `lookupDriver()`. It is a projection of the manifest list, and once the list is a run-time thing the constant can only be empty |
| `PACKAGE_DRIVER_IDS` | half gone: `packageIdForDriver` now answers from `drivers/installed.ts`, out of "which directory the manifest was found in". The remaining half is used only by the **package host**'s `entry.ts` (all it has is `PEEK_PACKAGE_ID`, and no loader) |
| `VIEW_KIND_CONTRACTS` | the **data half** goes into the registry; the function half stays compile-time. A new `installedViewKindContracts()` joins the two — the window registers only kinds that are "declared by a manifest + implemented in this build" |
| `PACKAGE_TOOL_META` | **untouched**, see (g) |

### (e) Tool descriptions have to become lazy, or this step fails silently

`connect`'s description, `list_connections`'s empty state, and `MCP_INSTRUCTIONS` are all
module constants assembled from the manifests. And `collectBuiltinTools` is
`import.meta.glob({eager:true})` — `tools/*.ts` is evaluated **while main is still loading its
own imports**, several steps before `whenReady`. What gets assembled is the empty registry's
answer, and **it does not error**: `connect` works as usual, the model is simply told peek
cannot open a single database.

So `baseFields` in `executor.ts` takes `description` out, and the two `defineTool`s each
declare it with a getter (spread flattens a getter into a value, so it cannot ride in
`baseFields`). `MCP_INSTRUCTIONS` becomes `mcpInstructions()`, computed once per session.

### (f) Failure has to make a sound: `packageLoadNotices`

Extracted out of `main/index.ts` into a pure function in `main/packages/installed.ts`, because
refusal is **the normal case** (`loader.ts`: the package directory is written by the user), and
the wording decides whether the user can act. It says only three things:

1. each refused package + its directory + **every** issue;
2. each `redact` warning (decision 5's only observable consequence);
3. **nothing installed at all** — the loader cannot answer this one (it cannot tell an empty
   directory from an unreadable one), and by this point the bundled packages have already been
   laid out, so "empty" = nothing can be done.

Not a word about the packages that loaded: that is the app working normally, and they are
already visible in the connect dialog.

### (g) The three not done, and where each is stuck

1. **`PACKAGE_TOOL_META` is still compile-time.** The manifest has `tools`, the loader already
   parses it into `installedTools()`, and `tools/list` could always have been answered from the
   manifest alone. **Execution** cannot: `toPeekTool` needs `kind` (read and command are two
   different constructors), `hasRenderer` (`defineCommandTool` reads "no render" as the default
   receipt), and a **zod** schema rather than the JSON Schema on disk.
   §4duodecies(f) item 1 gave two ways out (add them to the manifest / take them along with the
   function half on the host's first fork); **this is a decision, not a refactor**, and this
   round did not make the call for the user.
   (Feasibility was measured: `z.fromJSONSchema` is available in zod 4.4.3, and
   `toJSONSchema → fromJSONSchema → toJSONSchema` is the identity on `expand_node`'s schema.
   Taking the "add them to the manifest" road means adding four: `kind` / `hasRenderer` /
   `title` / `annotations` — leave the last two out and the model loses hints such as
   `destructiveHint`.)

   **Paid off 2026-08-11, see §4duodevicies.** This item records "a newly installed package's
   tools cannot be listed"; §4sedecies(b) measured the other half of the same debt — an
   uninstalled package's tools **can** be listed.
2. **The window still imports `@peek/db-neo4j/view`.** Because `StatusBar` reads
   `contract.describe(view)` and context-actions reads `contract.collectionRef(view)`, both
   synchronously. The former already has a data version
   (`PackageViewState.packageText.describe`), the latter does not — either `PackageViewState`
   gains a stored ref, or it becomes asynchronous. This is the last stretch of §1.3's hard
   constraint, and is a step of its own.
3. **package host / driver host are still Phase B** ((h) is the measurement).

### (h) Measured: how far `echo` gets now

`PEEK_CONFIG_DIR` pointed at a temporary directory, one launch to lay out the five bundled
packages, `cp -R` `fixtures/packages/echo` in, **no rebuild**, launch again, drive it over MCP:

| | before (§4undecies(b)) | now |
|---|---|---|
| `initialize`'s instructions mention echo | no | **yes** |
| `connect`'s description mentions Echo | no | **yes** |
| `conn.open` gets through main's registry | no, `BAD_REQUEST Driver echo is not registered` out of `bus/handlers/conn.ts` | **yes**, the connection is built (the receipt carries `connection.opened` and a connId) |
| opening the connection | — | fails, `BAD_REQUEST Driver echo is not registered` **now out of `core/driver-host.ts:633`** |
| naming the connection | — | fails, `[echo] The package host could not load its contributions: No package is compiled in under the id echo` |

**The same sentence, said by a different process.** Both remaining blockers are two halves of
one debt, both on the `PHASE C` marker in `entry.ts`: the driver host's `drivers: [...]` array
has to become `import(<packagesRoot>/<id>/driver.mjs)`, and the package host's
`PHASE_B_CONTRIB` has to become `import(…/contrib.mjs)`. None of this round's four tasks
covered that step.

(`app.requestSingleInstanceLock()` did not stop a second instance, and MCP fell back to 7333 —
unrelated to this round, but worth remembering for the next measurement.)

### (i) Inverse checks: twelve, each measured

Break → red → restore. Scripts in the scratchpad, not committed.

| broken | result |
|---|---|
| turn `defineTool`'s `description` getter back into a value | red: `postgres is installed and its config example is missing from connect's description` |
| `installedFrom` no longer restores `version` | red: 2 cases, including `third-party-package`'s `2.3.4` one |
| a missing `redact` is no longer synthesised as `{}` | red: the `installed-registry` case |
| write the wrong packageId onto a view kind | red: `a package is tagged onto every contribution it makes` |
| refusals no longer notify | red: `a package that did not load must not be silent` |
| warnings no longer notify | red: `decision 5 has no other observable consequence than this line` |
| an empty scan no longer notifies | red: `an empty connect dialog with no explanation reads as a bug in peek` |
| the registry row **copies** the capabilities array instead of referencing it | red: `Values have same structure but are not reference-equal` |
| `packageIdForDriver` always answers null | red: `third-party-package`'s attribution case |
| `connectFormOf` always answers null | red: `the connect dialog draws this, and there is no second description of it` |
| `installPackages` installs nothing | red: 3 cases — the backstop for the whole wiring |
| `installedViewKindContracts` does not filter | red: `a kind whose package is not installed is not offered` |
| `installedFrom` drops each package's first driver | red: 5 cases |

### (j) How the tests get a registry — one stand-in, two modules

`pnpm test` is `node --test` over TS source, with no `out/packages/` and no `~/.peek/`. So
`src/drivers/__tests__/in-repo-packages.ts` declares an `InstalledPackages` for the five
bundled packages (the values being the very manifests `build-packages.mjs` uses to serialise
`peek-package.json`, not a second copy of the truth), and `in-repo-registry.ts` installs it
**when it is itself imported**.

Splitting them into two modules is necessary, not fastidious: several cases read the registry
during their own module evaluation (`const WITH_SKILL = driverManifests().filter(…)`), so
"import means install" is right for them; while `mcp/__tests__/tool-descriptions.test.ts` wants
exactly the opposite — it tests "installed only after the modules have loaded", and a module
that installs on import cannot pose that question at all.

21 test files gained a side-effect import line, and `render-probe/fixture.tsx` gained one too
(the connect dialog draws what is installed, and the probe page has no preload). **No assertion
was relaxed**: the changes are three renames — `DRIVER_MANIFESTS` → `driverManifests()`,
`DRIVER_REGISTRY` → `driverRegistry()`, `MCP_INSTRUCTIONS` → `mcpInstructions()` — plus that
import line.

New cases: `main/packages/__tests__/installed-registry.test.ts` (8, report → registry and
report → notices), `main/mcp/__tests__/tool-descriptions.test.ts` (3, the late-install
ordering), `drivers/__tests__/view-kind-halves.test.ts` (3, the join of the two halves), and 3
appended to `third-party-package.test.ts` — that file's whole "## What this file cannot check
yet" section was deleted, because what it described is this step.

`pnpm -r typecheck` all green; core 111 / neo4j 71 / qdrant 38 / postgres 60 / sql 83 /
desktop **1776** all passing; `pnpm build` (including `audit-package-boundary.mjs`,
`audit-shipped-css.mjs`, and the render probe) all passing. db-redis's failing
`builds a namespace tree from key prefixes` is a pre-existing integration case needing a live
redis, unrelated to this round.

## 4quaterdecies. Implementation record — the three kernel verbs + hot reload (§2.4 / §2.7)

### (a) Which line landed

`COMMAND_NAMES` goes from 32 to 35: `packages.read` / `packages.install` /
`packages.uninstall`. The install and uninstall paths are walked to the end per §2.7,
`capabilities.tools.listChanged` changes from `false` to `true`, and the notification
really is sent.

**Conflicts first** (CLAUDE.md step 1). One found, and it is an old debt internal to the
document, not this round's request fighting the document:

> §2.7's step 3 of installing says "`import()` `main.mjs` → register tools and view kinds".

That line was written before decision 7 (§2.4bis). After decision 7, main cannot hold a
single line of a package's code; `contrib.mjs` can only be loaded by that package's own host
process, and the host is started lazily (§2.4bis(c), acceptance criterion 31). §4octies's
"What is deliberately *not* checked" already booked this once. So this round's install path is:

```
read the manifest → full validation (the loader's same one) → swap directories → rescan → broadcast → list_changed
```

**Not one line of a package's code is loaded**: `driver.mjs` waits for the first connection,
`contrib.mjs` waits for the first tool call or view open. This is not laziness — it is what
decision 7 hands over for free: there is nothing to import, so there is nothing to forget
(§2.4bis(f)).

### (b) Install is a `read`, uninstall is a `reduce` — not style, but where the state lives

Installing does not change the Workspace (it changes the registry beside the Workspace), so it
is a `read` handler that does I/O, exactly the same kind of thing as `conn.book.forget` /
`settings.write`.

Uninstalling has to close the connections of every driverId that package provides, and that
**is** Workspace state, so it must be a reducer — and therefore it cannot do I/O itself. The
disk half leaves the reduction as a new intent `uninstallPackage`, queued after the
`disconnect` in the same batch (intents run in order) — meaning every driver-host is already
on its way down before the `driver.mjs` it loaded disappears from disk.

`CommandDeps` therefore gains an optional `packages?: PackageAdminService`. It is optional the
way `display` is, but **absence is handled the opposite way**: an absent `display` degrades
silently (the connection's name was not computed, the connection still works), while an absent
`uninstallPackage` throws `INTERNAL` outright. The reason is written in effects.ts — a silent
no-op would hand back a receipt saying "the package is gone" with the directory untouched, and
it would be back on the next start.

There is one ordering difference from §2.7's enumeration, and it is deliberate: the document
says "deregister the registry entry → delete the directory", the implementation is "delete the
directory → rescan (deregistration happens as a result)". Because the registry is a projection
of the disk, **the registry still holding that package when the rm fails is the correct
outcome** — at that moment the package really is still there.

### (c) What `packages.read`'s `source` is actually answering

Not "who put this copy here" — peek cannot answer that: §2.5 rule 2 lets a higher version the
user installed himself occupy a bundled package's id, and from then on the two are the same
directory.

`source` answers **"does this build have a package with the same id"**, and that happens to be
what the two consumers really ask: does an uninstall need to leave a tombstone (it does,
otherwise the next start lays it straight back down), and will "restore bundled packages" bring
it back. `upgradeVersion` comes from the same place: if the bundled one is newer than the
installed one it is reported, and **never fetched automatically** (§2.5 rule 2).

The bundled catalog (`bundledCatalog`) is read **once** at assembly time and held from then on.
The app bundle does not change while the process is alive; a different app is a different
process. Holding it is the reason "is this id bundled" can be answered inside the reducer —
reading the disk is not allowed there.

### (d) The thing only found after `listChanged: true`: the notification was very nearly empty

With `listChanged` and `sendToolListChanged` in place, smoke immediately turned an **existing**
assertion red:

```
FAIL echo  the connect tool's description offers no echo example, so an AI client
           cannot learn the config shape of a package that is installed
```

The cause is that §4terdecies(e) only got halfway. `PeekTool.description` really is a getter,
recomputed on each read; but `registerTool` reads it **when the session is built** and stores
the string in the SDK's tool table. So a session that was already open before the install
received `tools/list_changed`, re-listed, and got back the same "peek cannot connect to echo"
sentence. **Declaring listChanged and then sending a notification that changes nothing is a lie
in the same way declaring false is**, only harder to spot.

The fix is a new `refreshToolDescriptions` in `mcp/registry.ts`: `registerTools` now returns
`{tool, registered}` pairs, the session keeps that table, and `notifyToolsChanged` recomputes
each description in place before sending the notification. Assigning directly rather than going
through `RegisteredTool.update`, because the latter sends a `tools/list_changed` of its own —
14 tools would be 14 notifications.

**One thing still out of reach, written into the comment without dressing it up**:
`MCP_INSTRUCTIONS` is finalised at `initialize` (`server.ts`), and the protocol has a
notification for `tools/list_changed` but none for instructions. So an installed package's skill
only takes effect for sessions established **afterwards**. §2.7 listed this long ago as one of
the two things hot reload cannot do.

### (e) The window's side: the registry goes from a fill-once slot to a changing slot plus a counter

`drivers/installed.ts` is a synchronously read slot, and none of its three readers has anywhere
to put a subscription (the connect form's field table, the greyed-out buttons' capability
prediction, the package registration before the first frame). That shape was right when it was
filled once; it is not now.

- A new M→R channel `IPC.PACKAGES_CHANGED`, carrying the whole `InstalledPackages` (not a delta —
  the window only ever replaces the whole thing, and `installPackages` explicitly refuses to merge).
- `PeekBridge.onPackagesChanged` is a **required** member, for the reason copied from
  `onMenuAction`: one `ipcRenderer.on`, no main world involved, so the degraded path implements it too.
- `renderer/state/packagesStore.ts` holds only a `revision` counter. **It does not hold the
  registry** — that would become two copies of the same truth, and those three synchronous
  readers cannot be moved across.
- The subscription lives in `packages/register.ts` rather than `state/sync.ts`, for a mechanical
  reason: swapping the registry means reconciling view kinds along with it, and that path touches
  `PackageFrame.tsx` (React), while `sync.ts` is imported by cases run under `node --test`. This
  boundary existed a round ago (the `uiEntries.ts` split for the same reason); this round ran into it.

`adoptInstalledPackages`'s ordering is read off the side that reads it, and it is load-bearing:
fill the slot → reconcile view kinds → touch the revision last. A component woken by the
revision therefore never sees a half-installed registry.

**On uninstall, `unregisterViewKind` is the other half of acceptance criterion 13.** An
unregistered kind draws as `view.packageMissing` (an explicit panel naming the kind); keeping the
registry entry would be worse — the view would go on drawing an iframe at
`peek-package://<id>/` while that directory is deleted, every sub-resource 404s, and the panel
quietly goes white.

### (f) One incidental change, and why it is not a relaxed assertion

`registerPackageViewKindNames` gains a line `if (lookupViewKind(kind) !== null) continue`, so it
can be called a second time. This does **not** swallow `registerViewKind`'s "already registered by
another package" refusal: `installedViewKindContracts()` is a filter over `VIEW_KIND_CONTRACTS`,
which is a table indexed by kind, so it cannot possibly emit two contracts with the same name in
one call — that refusal was **never reachable** from this path, and a kind already in the registry
is necessarily the same contract out of the same table. That paragraph is in the comment.

### (g) Cases

**New**: `main/packages/__tests__/hot-reload.test.ts` (13 cases), going through the real
`CommandBus` rather than calling handlers directly: install and uninstall have different shapes to
begin with (one a `read`, one a `reduce` + intent + `finalize`), and that timing is exactly what
has to be nailed down. Disk, loader, registry, reducer and effect are all real; only two things are
counted rather than executed — the broadcast to windows (there is no window) and the MCP
notification (there is no endpoint).

**New**: 2 cases in `mcp/__tests__/mcp-endpoint.test.ts`: the notification goes to the **currently**
bound handle (a rebind swaps the handle, and capturing the old one means notifying the session that
was closed along with it), and nothing is sent and nothing thrown when nothing is bound. Two
`McpServerHandle` stand-ins gained `notifyToolsChanged` — a new required member on the interface,
with the stand-ins following, not a relaxed assertion.

**Changed**: `scripts/smoke-drivers.mjs`. The echo fixture is no longer copied into
`<configDir>/packages/` before start-up; it is copied to a directory beside it called `echo-1.0.0`
(which incidentally turns "the installed directory's name is the manifest's id, not the source
directory's name" into a property this run really exercises), and is then installed **through the
running app** with `window.peek.invoke('packages.install')`. Everything the old copy proved still
has to hold, and now has to hold without a restart. After every driver has run, `packages.uninstall`
— at which point echo still has a connection open, and closing it is exactly §2.7's step 1.

Through the window's bridge rather than MCP, because these three verbs have no MCP tools (they are
kernel verbs a person drives from the settings panel) and `window.peek.invoke` is the path that
panel takes; and because the assertions are therefore made against **a window that was told**, not
against main's own copy of the answer.

One crucial tightening: after the install, reading the picker **does not reopen the dialog**.
Clicking `＋` again pushes a new object into the sidebar's dialog state, which redraws the picker for
reasons that have nothing to do with packages — which is how the first inverse check went falsely
green (see below).

### (h) Inverse checks: nine, each one measured

| guard | how it was broken | what red looks like |
|---|---|---|
| the tombstone rule | `uninstallPackage`'s `catalog.has(id)` → `false` | `✖ a bundled id leaves a tombstone…` `+ tombstoned: false` |
| the uninstall's `finalize` | delete the `finalize` line | `✖ a connection on another package survives` |
| validate before writing | move `inspectPackageDir`'s decision to **after** the copy | `✖ an entry point that is not there is refused before anything is written` |
| exclude self when replacing an id | `inspectPackageDir` no longer filters the same id | `✖ installing over an id replaces it, and does not collide…` |
| cross-package driverId collision | `loaded: []` at install | `✖ a driver another package already provides is refused…` |
| install sends `list_changed` | delete `options.toolsChanged()` | `✖ a package installed now is connectable now, and the windows and MCP are told` |
| the redact warning | delete the warning forwarding after install | `✖ a package that declares no redact block is installed, and warned about` |
| the controller takes the current handle | capture the first handle and reuse it | `✖ it reaches the handle that is bound right now, not the one it replaced` |
| the window redraws (smoke) | make `packagesReplaced()` a no-op, rebuild | `smoke: aborted — the window's connect dialog offers [neo4j, postgres, …] — echo was just installed and the dialog was open the whole time` |
| rescan after uninstall (smoke) | delete `adopt` + `toolsChanged` from `createPackageAdmin.uninstall` | `FAIL echo-uninstall notifications/tools/list_changed after uninstall never arrived` |
| `refreshToolDescriptions` (smoke) | change the body to `void registered`, rebuild | `FAIL echo  the connect tool's description offers no echo example…` |

**The first attempt at "the window redraws" was falsely green**: smoke passed with the damage in
place. The cause is that `connectDialogDrivers` clicks `＋` again every time, `setDialog({})` is a
new object every time, and the picker was therefore redrawn — the assertion was testing reopening
the dialog, not the subscription. Once the post-install read was changed not to reopen
(`{ reopen: false }`), the same damage went red immediately. It is recorded here because it is the
standard shape of "a test passed but tested nothing".

All damage has been restored, with `diff` confirming each one byte-identical to the backup.

### (i) The two things not done, and what each is stuck behind

1. **The settings panel still has no install / uninstall / restore buttons** (§2.8). This round only
   lands the three verbs and their paths; the panel is the next step, and it will run straight into
   item 2.
2. **Uninstalling postgres crashes the whole window, and this round does not fix it.**
   `ConnectDialog.tsx`'s `seedFrom()` still hard-codes `driverId: 'postgres'`, and
   `packages.uninstall` merely made this path **reachable**: uninstall postgres, click `＋`, and
   `No driver manifest for postgres` fires immediately, with the ErrorBoundary tearing down the whole
   tree. The task card `task_5706c218` was opened a round ago. **Not fixed on my own initiative**,
   because "which driver is the default" and "what to draw when no package is installed" are design
   decisions, and per CLAUDE.md the document comes first; this round's smoke installs and uninstalls
   `echo`, which does not trigger it.

`pnpm -r typecheck` all green; core 111 / desktop **1791** all passing; `pnpm build` (including
`audit-package-boundary.mjs`, `audit-shipped-css.mjs`, the render probe) all passing;
`smoke-drivers.mjs` `1/1`. db-redis's `builds a namespace tree from key prefixes` is still red — a
pre-existing integration case that needs a live redis, already in modified state before this work
started, unrelated to this round.

---

## 4quindecies. Implementation record — the settings panel can install and uninstall (§2.8)

> 2026-08-11. The previous round landed the three verbs and their paths, leaving the panel for the
> next step (§4quaterdecies(i) item 1). This round builds the panel, and three things that were
> invisible until then came up along the way: **a fourth verb is required**, **the upgrade button
> cannot be clicked**, and **whether a row is a package or a database**.

### (a) Conflicts first: §2.4 says "add three", but the buttons §2.8 wants are four actions

Checking the documents per CLAUDE.md step 1 hit one conflict: §2.4's command table fixes three
verbs, and "restore bundled packages" at the bottom of §2.8 is none of them. This is not this
round's request fighting the document — §2.5 rule 3, §2.8 and acceptance criterion 14 have all
demanded that entry point since the first version, and §4quaterdecies(i) also says outright that it
belongs to "§2.4's command table and §2.8's settings panel". So it is an old debt internal to the
document, and per step 3 §2.4 was updated: **`COMMAND_NAMES` gains four**, the fourth being
`packages.restore`.

Why it cannot be folded into `packages.install` (otherwise the reasoning for "there is no
`packages.upgrade`" would apply to it equally) is written in §2.4, in three points: the input is not
a directory the user picked, it has to clear tombstones (install should not touch tombstones at
all), and it is a batch. What it reuses is the **execution path**: after clearing the tombstones it
calls the same `layOutBundledPackages` that start-up calls. The line in `clearTombstones`'s comment
about "two steps rather than one" was left there for this from the beginning, and this round is the
first time anybody calls it.

### (b) The upgrade button cannot be clicked — a hole only the implementation runs into

§2.5 rule 2 says "a bundled package at a higher version shows as upgradable in settings, **and the
user clicks it**", and §2.4 says "there is no `packages.upgrade`; `upgradeVersion` tells the caller
that running `packages.install` against the bundled copy moves it up a version".

Only at this point does it emerge that those three sentences do not add up inside the window: **the
window cannot construct the path to "the bundled copy"**. `PackageListing` deliberately carries no
filesystem path at all per §1.4 (its comment's own words: "a value the window can rebuild for itself
should not be sent over as a home directory path"), and a path inside the app bundle even less so.

Three options: give `PackageListing` a `bundledDir` (overturning §1.4), add a fifth verb
(overturning §2.4's "an upgrade is just installing again"), or **let the window name that directory
the only way it can honestly name it — by the package's id**. The third was chosen:
`PackagesInstallInputSchema` goes from one object to `{dir} | {bundledId}`, and main resolves the
latter to `<bundledRoot>/<id>`.

**What changed is who assembles the path, not what installing means** — after resolution it is the
same `installPackage`, the same full validation, the same staged copy, the same atomic rename, the
same receipt (`replaced: true`). So it did not become a fifth verb. §2.4 has been updated to match.

### (c) A row is a database, an uninstall button is a package

§2.8's original text says "add an uninstall button to each row". Done literally, `db-sql` — one
package providing `mysql` and `sqlite` — would draw two uninstall buttons, and either one would take
both databases away; the button would be saying the opposite of what it does.

Nor can it become "one row per package": `capabilities` is declared per driver, and merging one
package's two drivers' capabilities into a single cell becomes false the day they disagree (the two
sharing `SQL_CAPABILITIES` today is a coincidence).

The conclusion is written into §2.8(a): **the database / connector version / capabilities columns are
one row per driver, and the source and actions columns `rowSpan` across all the rows of the same
package.** An "Uninstall" spanning two rows says on the spot that "this one click takes both
databases". The existing comment about "three values compared down a column" therefore goes on
holding with not a word changed.

### (d) Where the data comes from: two places, joined by driverId

`packages.read` carries only id / version / source / upgradeVersion / driverIds / viewKinds /
toolNames — no `displayName`, no `capabilities`. Those two are in the registry, which is
synchronous. So **the set of rows comes from the command, and the display name and capabilities in
the cells come from the registry**.

The two can briefly disagree (the registry is swapped the moment `PACKAGES_CHANGED` arrives, while
the re-sent `packages.read` is still in flight), so when no manifest is found the driver id itself is
drawn — `lookupManifest` returning null is a normal value on this path, not a defect. Written into
§2.8(b).

### (e) How "Install…" gets a directory: a new R→M channel, not a command

`<input type="file" webkitdirectory>` cannot produce a directory's absolute path in Electron, hence
`IPC.PACKAGES_PICK_DIR`: main opens `dialog.showOpenDialog` and returns a path or `null`. **Not a
command**, for the same reason as `MENU_ACTION`: what crosses over is one interaction with the
window shell, not a modification of the truth. A user pressing cancel in a system dialog should not
leave a failure record in the command log; the `packages.install` that follows is the modification,
and it goes into the log as usual.

`pickPackageDir` is a **required** member on `PeekBridge`, for the reason copied from
`onMenuAction`: one `ipcRenderer.invoke`, no main world involved, so the degraded path implements it
too. An "Install…" that does nothing is hardest to diagnose on exactly the start-up that has already
gone wrong.

### (f) Copy: the automatable half of acceptance criterion 40

§2.9 corollary 1 says "the UI must not imply safety", and §4.8's item 40 records it as a **review
item**, on the grounds that "there is no automatable criterion". **Half of it is**: every word on the
panel goes through `t()`, so every word is in the catalog and can be scanned.
`i18n/__tests__/packages-copy.test.ts` scans every value under `settings.packages.*`, in both
languages, with a banned-word list including verified / validated / checked / scanned / signed /
safe / secure / trusted / completely / `已验证` / `校验通过` / `安全` / `可信` / `完全移除`.

**"trust" is not on the list, and that distinction is the whole point**: `trustNote` says
`装它，就是你决定信它` — it is about who is doing the trusting; "trusted" is about a property peek has
confirmed, and peek has confirmed nothing.

`PackagesSection.tsx`'s source is not scanned, and this deserves spelling out: that file's header
comment contains these very words (it is **explaining the ban**), so scanning the source would mean
teaching the scanner to skip comments — and **a scanner that exempts the file it guards is worth less
than an honest boundary**. The gap is "an English sentence hard-written into JSX", named in the
test's header.

The other three land as: an install says `已装上 <id> <version>` (what happened, not what it is); an
uninstall says `已卸载`, **not** `已完全移除` (the directory is gone and the processes were killed, but
peek does not know what this package wrote elsewhere); there is no fake progress bar and no
`检查中…`.

### (g) Inverse checks: 10, all measured

| what it guards | how it was broken | what red looks like |
|---|---|---|
| `bundledId` means the app bundle | resolve it to `join(packagesRoot, id)` | `✖ installs this build's own copy over the installed one — the upgrade button's path` |
| restore must clear tombstones | delete `clearTombstones(...)` | `✖ brings back an uninstalled bundled package…` plus `✖ nothing missing…`, two cases |
| broadcast even when nothing was missing | return early when `restored.length === 0` | `✖ nothing missing is an empty list, not a failure — and the tombstones still go` |
| restore does not overwrite what is installed | `cpSync` a copy for `upgradable` too | `✖ an installed copy is never replaced, however old it is (§2.5 rule 2)` |
| an unassembled bus must refuse | change the restore stub to `{restored: [], …}` | `✖ every writing verb refuses rather than answering something plausible` |
| an install receipt must not imply a check | change it to `Installed and verified {id}` | `✖ no banned word appears in any locale` |
| an uninstall receipt must not over-promise | change it to `Completely removed {id}` | same |
| a dead `builtinHint` must not linger | add the key back to both catalogs | `✖ the sentence about there being nothing to install is gone` |
| the panel subscribes to package-set changes (smoke) | drop `revision` from the `useEffect` deps, rebuild | `smoke: aborted — the settings table groups its rows as [neo4j, postgres, …] but the packages are [echo, neo4j, …]` |
| one package, one set of buttons (smoke) | drop `rowSpan`, draw source and buttons on every row | `smoke: aborted — … groups its rows as [neo4j, postgres, qdrant, redis, mysql, sqlite] but the packages are [… mysql+sqlite]` |

**The last one would have been falsely green as first written**, and is worth saying separately. The
original assertion was "each group's `span` equals its driver count, and there is at least one
button" — **self-consistent and testing nothing**: with `rowSpan` gone, `mysql` and `sqlite` each
become a group with span=1 and one button, and both conditions hold. The table looks internally
consistent while telling the user "uninstalling mysql does not affect sqlite", which is false.

The fix is to make the assertion ask about a fact **only the command knows**: `panelGroupsArePackages`
compares the DOM's grouping against `packages.read`'s `driverIds`, one by one. This is the same shape
as the previous round's "the window redraws" false green — **an assertion that only compares against
itself is always green**.

One tooling trap recorded along the way: the smoke test's close helper first used
`document.querySelector('[role="dialog"]')` to find the settings dialog, while the connect dialog was
open on screen at the same time, and `querySelector` gives the one earlier in the DOM — it closed the
wrong one. The failure was silent: the connect dialog remounts on the next `＋` and re-seeds from a
connection book **that has since grown a row**, so a different driver ended up selected. It cost an
hour. Changed to "the settings dialog is the one containing a tabpanel".

### (h) Acceptance

`pnpm -r typecheck` all green; core 111 / desktop **1808** (10 new this round: 2 for `bundledId`
installs, 3 for `packages.restore`, 2 for the unassembled bus, 3 for the copy guards);
`pnpm build` (including `audit-package-boundary.mjs`, `audit-shipped-css.mjs`, the render probe)
passes; all three package-related assertions in `smoke-drivers.mjs` pass, measured output:

```
smoke: installed 'echo' at runtime; picker offers echo/neo4j/postgres/qdrant/redis/mysql/sqlite;
       settings panel lists echo, neo4j, postgres, qdrant, redis, mysql+sqlite
smoke: uninstalled 'echo' at runtime; 1 connection(s) closed, picker offers neo4j/postgres/…
```

That `mysql+sqlite` cell is (c): one package, two databases, one set of buttons, measured.

### (i) Not done

1. **`packages.restore` has no MCP tool**, like the other three verbs — they are kernel verbs a
   person drives from the settings panel. This is not an omission, it is §2.4's conclusion.
2. **"Install…" does not download** (§1.5); the argument can only be a local directory.

---

## 4sedecies. Acceptance record — §4's 40 criteria, annotated one by one

> 2026-08-11. Every earlier section records "what this step did"; this one answers
> a different question: **where each of §4's 40 criteria stands today.** Recorded in
> three tiers, because writing "has a guard and ran green this round" and
> "reproduced by hand this round" as the same symbol turns this table into a column
> of ✅ carrying no information.
>
> - **✅ measured** —— run by hand this round, with output or numbers attached.
> - **🟢 has a carrier** —— an assertion guards it and it ran green with the suite
>   this round, but I did not re-derive its inverse check
>   (the rounds that did are recorded above, each in its own place).
> - **⚠️ rewritten / partial** —— the criterion and what shipped do not agree; the gap is written below.
> - **❌ does not hold** —— by the literal wording of the criterion it is false today.
> - **⬜ no carrier** —— nobody guards it and nobody has run it. **This tier may not be filled with "probably fine".**

### (a) One by one

| # | verdict | evidence |
|---|---|---|
| 1 | ⚠️ rewritten | `pnpm typecheck` / core 111 / db-neo4j 71 / db-qdrant 38 / db-postgres 60 / db-sql 83 / desktop 1808 all green. But **`connect-form.test.ts` is not "not one line changed"**: +147 / −32, and the picker's source moves from core's `DRIVER_IDS` to `manifestDriverIds()`. The criterion itself is what does not stand up — after packaging, that constant is no longer the picker's source, and copying the old assertion over means testing a roster that does not ship. Neither the structure nor the strength of the assertions was lowered (see (c)). **2026-08-11 full re-run (§4duovicies(a))**: `pnpm typecheck` 7/7 green, `apps/desktop` **1838 pass / 0 fail** (1808 → 1838 is guards added in the rounds in between, not new this round). **2026-08-11 re-run again (§4tervicies(a))**: `pnpm typecheck` 7/7 green, `apps/desktop` **1838 pass / 0 fail / 287 suites**, `core` 151/151, `db-neo4j` 71 pass + 12 skipped, `db-qdrant` 38/38, `db-postgres` 60/60, `db-sql` 83/83. **2026-08-12 re-run before delivery (§4septemvicies(b))**: `pnpm typecheck` 7/7 green, `apps/desktop` **1842 pass / 0 fail / 287 suites**, `core` 151/151, `db-neo4j` 71 pass + 12 skipped, `db-redis` **38/38** (the red on row 2 above is gone), `db-qdrant` 38/38, `db-postgres` 60/60, `db-sql` 83/83 —— **0 fail** across seven projects. |
| 2 | ⚠️ partial | The unit tests still import the driver packages from source —— "goes through the `driver.mjs` in `~/.peek/packages/`" is **smoke**'s job, and this round measured echo / redis / qdrant / neo4j, all four going through the `out/` build plus `<configDir>/packages/`. pg / mysql / sqlite had no live server to point at this round, skipped. `db-redis`'s `builds a namespace tree from key prefixes` is still red —— it needs a `peek:test:*` fixture on a live redis, and is unrelated to this document. **2026-08-11 review, corrected**: redis is live (8.8.0), and the reason for the red is not a missing fixture —— the fixture stuffs 3,000 `bulk:*` keys into one level, past `keyspace.ts:48`'s `PREFIX_SAMPLE_KEYS = 2_000`; SCAN stops at the ceiling and never reaches `tags`. Root cause and the two open questions are in §4vicies(e). **2026-08-11 re-run**: `db-redis` is still **36 pass / 1 fail**, the same one, untouched. **2026-08-11 re-run again**: still 36/1, still red at `redis.test.ts:236` (`undefined !== 'key'`). **2026-08-12 that red is gone**: `db-redis` **38 pass / 0 fail**. What was fixed is the fixture, not production code —— `BULK_KEYS` 3000 → 1500, so the whole fixture sits inside one namespace sample, plus a guard that counts the actual number of keys. See [`2026-08-12-redis-namespace-sample-fixture.md`](2026-08-12-redis-namespace-sample-fixture.md); **silently absent on truncation** is still undecided, left as it stands in that document's §4. |
| 3 | ✅ measured → **⚠️ red then green this round, and flaky** | `smoke-drivers.mjs` all green, 4/4. The neo4j line opens two views and calls `expand_node` as before: `PASS neo4j 5 node(s); scanned "PeekSmoke" → 3 row(s); graph view → 6 row(s); expand_node ok`. **2026-08-11 review**: only the echo line had an environment this round (no live servers for the rest). It first came back **exit code 1**, catching acceptance criterion 13's defect in the shipped path (§4vicies(a)); after the fix, `1/1` green. But four runs back to back gave **0 / 1 / 13 / 0** —— two pre-existing flakes **unrelated to this round's change**: (1) `packagesPanel(cdp)` reads before the settings panel has finished rendering, and groups comes back `[]`; (2) the last step, `checkDialogOutlivesItsDrivers`, occasionally hangs and Node reports `unsettled top-level await` (exit code 13). The tool-list lines were green every time the run reached them. These two need a fix of their own, or smoke is a blunt criterion. **2026-08-11 reproduced independently**: four runs this round gave **0 / 1 / 0 / 0** —— the first one (`packagesPanel` reading empty groups) reproduced word for word, the second did not appear. See §4duovicies(d), still unfixed. **2026-08-11 five more runs: 0/0/0/0/0, neither appeared**. ⚠️ **Not withdrawn** —— nobody has touched `packagesPanel`, it still reads once rather than `waitFor`; a timing race that five runs did not hit is not a race that has gone. See §4tervicies(d). **2026-08-12 fixed, ⚠️ withdrawn**: both are fixed —— `packagesPanel` now waits until the panel answers, and the CDP client rejects in-flight requests when the socket closes. Eight runs back to back, **0/0/0/0/0/0/0/0**, each one going the whole way. All four guards inverse-checked one by one. See §4quinvicies. **2026-08-12 eight more runs before delivery: 0/0/0/0/0/0/0/0**, with all four lines (`installed 'echo'` / `PASS echo` / `uninstalled 'echo'` / `the connect dialog outlived its own drivers`) present in every one of the eight. See §4septemvicies(b). |
| 4 | 🟢 has a carrier | `drivers/__tests__/connection-label.test.ts` (three methods × six drivers, expected values computed from the old implementation via `git show HEAD:`). |
| 5–10 | 🟢 has a carrier | `main/packages/__tests__/`: `loader.test.ts`, `third-party-package.test.ts`, `assets.test.ts`, `hot-reload.test.ts`. The inverse checks are recorded one by one in §4octies(f) / §4duodecies(e). |
| 11 | ✅ measured | `fixtures/packages/echo`, and this round smoke installed it **inside the running app** (§4quaterdecies), not by copying it in before launch. |
| 12 | 🟢 has a carrier | `main/__tests__/hardening.test.ts`'s five "`PEEK_DRIVER_HOST_DIR` is checked, and never silent" cases (ignored entirely in a packaged build, a relative path refused, a non-existent path refused, a legal path still reported, silent when unset). |
| 13 | ❌ first sentence → 🟢 fixed → ❌ still false in the shipped path → ✅ measured + inverse → **✅ independently re-verified** | **Three of the four sentences hold; the first does not.** See (b). **2026-08-11 §4duodevicies fixed the first sentence**, carriers in §4duodevicies(f); this row keeps its original verdict, because it is where that change started. **2026-08-11 review overturns "fixed"**: §4duodevicies changed a necessary condition, and the shipped path was still false —— main passed `tools:`, which switches off `server.ts`'s `rebuildTools()` exactly, freezing the tool list at the moment the process starts. `smoke-drivers.mjs` caught it with exit code 1. After the fix, same session / new session / restart all three measured pass, and the inverse check is smoke itself (1 before the fix, 0 after). See §4vicies(a)(b)(c). **2026-08-11 independent re-verification**: the table in §4vicies(b) was measured on a tree with a concurrent conflict in it, so this round **reuses no assertion from `smoke-drivers.mjs`**; a throwaway script re-ran the three checks against the current tree, plus the positive direction ("absent before install / present after") and the fourth sentence ("calling it is refused") —— 7 sentences all green. See §4duovicies(b). **2026-08-11 third independent re-verification**: another throwaway script, again reusing no assertion from `smoke-drivers.mjs`, again 7 sentences all green, three runs back to back, exit code 0. See §4tervicies(b). |
| 14 | ✅ measured | Uninstall neo4j → the tombstone wrote `{"id":"neo4j","version":"0.0.1","at":…}` and the directory is gone → **restart** (the same `PEEK_CONFIG_DIR`) → it is not in `packages.read` → `packages.restore` → it is back, the tombstone is cleared, and `expand_node` returned to `tools/list` **without a restart**. |
| 15 | 🟢 has a carrier | `hot-reload.test.ts`'s "an installed copy is never replaced, however old it is (§2.5 rule 2)". An actual `.app` upgrade install was not hand-tested. |
| 16 | ✅ measured + inverse | See (d). |
| 17 | ✅ spot-checked | In `out/renderer/assets/*.js`, `mysql2` / `ioredis` / `pg-protocol` / `neo4j-driver` / `@qdrant` / `better-sqlite3` / `bolt://` get 0 hits each. "Holds no bytes from `~/.peek/packages/`" is structural: the window side has no path that reads that directory at all. |
| 18 | ✅ measured + inverse | The carrier is `scripts/probe-hardening.mjs`'s `frame-network` (the original verdict, "it asserts on a string", holds, so it is kept below). A real package frame is started, and `fetch` / XHR / WebSocket / EventSource / `sendBeacon` all fire at **a local HTTP server the probe starts itself**: all 5 blocked by `connect-src`, 5 `securitypolicyviolation` events, 5 console lines (attributed to the frame's URL), and the server received **0** requests. The server's reachability is proved by main itself sending one `/control` —— otherwise "received nothing" and "the server never came up" are the same sentence. Inverse: `--plant=csp-connect`, and all 5 arrive at the server. **Something measured in passing, recorded here**: with CSP opened up the page side still reports "refused" (CORS refuses the **response**), so the page's own return value cannot be evidence —— which is exactly why that server exists. |
| 19 | 🟢 has a carrier + inverse | `packages/core/src/__tests__/package-view-channel.test.ts`, 33 cases. Messages carrying `text` / `query` come in two kinds, both nailed down: swap `t` (`query` / `run` / `execute` / `command` / `fetchMore` / `view.open`) → `null`; hung off a legal `patch` → zod strips it, and `deepEqual` asserts the returned object **does not have** those two keys. Three more things are nailed down: the four host→frame messages cannot be taken for client messages, the 2000 ceiling on `error.message`, and a non-object input not throwing (`PackageFrame` relies on `null` to take the drop branch). Inverse: add `query: z.string().optional()` to `PackagePatchMessageSchema` → `does not let a statement ride along on a patch` goes red (`+ query: 'MATCH (n) DETACH DELETE n'`); delete `PackageErrorMessageSchema` from the union → the other two go red. |
| 20 | ✅ measured | Re-measured this round (§4undecies(d)'s measurement was **before the wiring**, and wrote for itself that "this column is to be re-measured after step 3's wiring"). Same machine, same build, 7 rounds each, warm ready-to-show median: **bundled packages 621ms vs 20 more packages 612ms**, −9ms, below the 20ms signal line and inside the same round's min→p95 (about 70ms). Reading 25 manifests on the startup path has no measurable cost. |
| 21 | ⬜ not run → **✅ measured + inverse** | Original verdict: `bench-scroll.mjs` was not run this round; **the `bench-package-frame.mjs` named in the criterion does not exist** —— `scripts/` holds only `bench-scroll.mjs` and `bench-startup.mjs`. Either the script gets written or the criterion gets rewritten. **2026-08-12 settled**: rewriting the criterion was taken (§4septemvicies(a)), and `bench-scroll.mjs` was really run for numbers before delivery —— dropped frames **0 / 600**, frame work p95 **0.20ms** (criterion ≤ 0.30), `.grid-surface` **279–369** (criterion 279–369, word for word across both rounds), `run_query` end to end 2188 / 2102ms (baseline 2124). All three criteria green, PLAN §8.1 unchanged. See §4septemvicies(c). **2026-08-12 re-run before delivery, four rounds, the first one not clean**: round 1 was **1 / 600** dropped frames —— by this criterion's letter ("any dropped frame falsifies it") that is a hit, recorded here as it happened. Rounds 2 / 3 / 4 were all **0 / 600**, frame work p95 **0.20ms**, `.grid-surface` **279–369**, `run_query` 2125 / 2162 / 2116ms, word for word identical to the previous round. The evidence for that one frame in round 1 points at the machine rather than the code: frame interval max **16.70ms** (exactly twice the 8.30ms refresh period, i.e. one missed vsync), while the same round's frame work max was only **1.00ms** —— the threshold for calling a frame dropped is 12.45ms, the script itself took at most 1.00ms of that, and the remaining 15.7ms is not in this code's budget. **This criterion leaves no room whatsoever for that noise**; disposition in §4duodetricies(d), undecided. **2026-08-12 another re-run before delivery, three of ten attempts produced data**: all three rounds green —— dropped frames **0 / 600** (all three), frame work p95 **0.20ms** (criterion ≤ 0.30; max 0.50 / 1.00 / 0.30), `.grid-surface` **279–369** (word for word across all three), `run_query` end to end 2169 / 2101 / 2147ms (baseline 2124). **Not a word of the criterion was relaxed, and the previous round's 1 / 600 did not reproduce** —— but three rounds are not enough to say it is gone, only that these three did not see it. The other seven were not data: **five stopped at the occlusion guard** (`visibilityState: "hidden"`, exit code 1), **two hung silently** (not a word of output, Node reporting `unsettled top-level await at bench-scroll.mjs:710`). The latter is a hole in the script, not a hole in the criterion; root cause and undecided disposition in §4undetricies(c). **This row's other half, `bench-package-frame.mjs`, enters this table for the first time this round**: four rounds all green —— opening neo4j's `graph` once reads **3 files, 23,362 B** (the disk and shipped sources byte-identical, identical across all four rounds), with **837,247 B untouched** in the same package; `ready` median 10.2–12.3ms (ceiling 40), window main-thread median 2.3–2.7ms (ceiling 15); the `echo` fixture **8,352 B / 2 files**, `ready` median 12.0–16.7ms. The positive control separates in all four rounds: 81.5–85.7ms of difference (threshold 20), **1200** attribute writes per frame (threshold ≥ the element count, 600), element count unchanged at 600/600. **The time half cannot measure fine detail, recorded here as it is**: the same untouched code's median jumps between 10.2 and 16.7ms across four rounds, the same order as the 7.1–17.8ms the benchmark records for itself, so its resolution is roughly "2.5× or worse" and it cannot catch a 30% regression; the byte half has zero spread, and is the only quantity in this row that measures fine detail. See §4undetricies(d). **The criterion's own stated reason for "not adopting" is itself still undecided** (the conclusion stands up, the reason measures false), see §4undetricies(e) item 1. |
| 22 | ❌ it grew → ❌ still grew, but the attribution is established → **✅ fixed (2026-08-12)** | The expectation was that it would shrink; measured, `out/renderer/assets/index-*.js` = **634,145 B** against a baseline of 597,160 B, **+36,985 B**. See (b). **2026-08-11 review**: the baseline reproduces byte for byte on `6181bd2` (597,160 B); HEAD `e3c36d7` (**without** the packaging change) is already 632,834 B, i.e. +35,674 B is window code committed before packaging started; the current working tree is 671,496 B. Of packaging's own +38,662 B, **+36,670 B is zod** —— `packages/core`'s barrel export drags `z.fromJSONSchema` (which only main runs) into the window chunk. The "six manifests disappear" the criterion predicted **did happen** (−9,824 B), it was just drowned out. Not changing it this round, see §4vicies(d). **2026-08-11 attribution review**: the current tree is **671,927 B** (the +431 B is bytes the two documents in between landed in the window); re-running sourcemap attribution against the current build, zod is **109,839 B** (109,776 last round) and `classic/from-json-schema.js` is still 7,914 B —— the attribution matches to the byte. **Conclusion unchanged, still not changing it.** See §4duovicies(c). **2026-08-11 source-level comparison**: the previous two rounds measured "whose are these 671,927 B"; this round supplies the half it had always lacked —— rebuild and attribute both `6181bd2` and `e3c36d7`, and subtract source by source. All three cells, **597,160 / 632,834 / 671,927 B**, reproduce to the byte. Of packaging's own +39,093 B, **zod on its own is 36,670 B (94%)**, of which `zod/v4/classic/from-json-schema.js` is **the only one that grew from 0** (7,914 B), the other six lines being tree-shaking degrading once the barrel export is referenced whole; and the saving the criterion predicted **goes from a residual to five lines**: five driver manifests to zero, 1290+1759+1838+2203+2734 = **9,824 B**, exactly the number the previous round derived backwards. **Conclusion still unchanged, still not changing it.** See §4tervicies(c). **2026-08-12 re-measured before delivery**: `index-*.js` is still **671,927 B**, byte for byte identical to the previous round —— these rounds changed only the main side and tests, and the window chunk was never touched. **Conclusion still unchanged, still not changing it.** **2026-08-12 changed → ✅**: `docs/design/2026-08-12-main-only-parse-out-of-the-window.md`. The `package-manifest.ts` line in the `packages/core` barrel becomes `export type *`, and the values go through a new `@peek/core/package-manifest` subpath. `index-*.js` **671,927 → 631,333 B (−40,594)**, which is 479 B off this row's attribution of 36,670 (zod) + 4,403 (`package-manifest.ts` itself) = 41,073 —— inside the 714 B covered by this row's own "only printed at ≥300 B". The estimated "touch 109 imports" did not happen: the great majority of those 109 want the type, `export type *` leaves types where they were, and 7 non-test files actually changed. **2026-08-12 re-measured before delivery**: `index-s2fQCmmf.js` **631,333 B**, byte for byte identical to the round that landed it; `SqlEditor-BRRcUbDH.js` 434,951 B and `index-ClZgSLJk.css` 37,862 B likewise unchanged to the character. Against this criterion's baseline of 597,160 B the books still say **+34,173 B**; but between that baseline (`6181bd2`) and packaging sits `e3c36d7`, which was already 632,834 B **without** any packaging change in it. **For the cell that should really be asked of packaging, the answer is now negative**: 631,333 − 632,834 = **−1,501 B**, i.e. packaging together with this fix has net narrowed the window chunk, and the "six manifests disappear" the criterion predicted has finally surfaced. **This row is no longer this round's debt**, and the 35,674 B left inside that +34,173 belongs to the line before packaging started. See §4duodetricies(b).|
| 23 | ✅ this round | Both READMEs gained a `Packages and trust` / `包与信任` section, and the redaction and persistence rows in the feature table were rewritten. See (e). |
| 24 | 🟢 done | `config/paths.ts`'s header comment has been rewritten per §2.2 (the sentence about "the three files it may write" is ended by `packages/`, with the original wording kept in the comment for contrast). Reviewed this round. |
| 25 | 🟢 done | All three header comments of `drivers/{manifests,viewKinds,mcpTools}.ts` now say which half went to disk, which half is still compiled in here, and what it is stuck on. Reviewed this round. |
| 26 | ✅ this round | PLAN §4 gained a paragraph, "the capability axis is unchanged, the roster comes from disk"; §11.2's "7 places" is amended to **0 places**, naming view kinds as its counter-example. |
| 27 | 🟢 has a carrier → **⚠️ went red once, fixed** | `pnpm test`'s first step, `check:vocabulary`, was green this round. **2026-08-12**: this guard **really did go red** —— the build guard added last round, `assertWindowHoldsNoMainOnlyCore`, brought the old word back in its own comment (`electron.vite.config.ts:347`). Green after the comment was changed (not after an exemption was added), with the build byte-identical. This also exposed a **reporting-scope problem**: `check:vocabulary` **is not in `pnpm -r test`** — it hangs off the first line of the root `test` script, so the sentence "`pnpm -r test` all green" does not cover it. See §4duodetricies(d). |
| 28 / 28bis | ✅ measured | `pnpm build` green, and `audit-package-boundary.mjs` green run on its own: `main loads 2 file(s) / 321614 B and holds none of the 10 string(s) … the package host loads 1 file(s) / 25146 B and holds none of them either; all 10 are in the 10 built package file(s) it loads off disk; 1 declared tool name(s) present in main`. **2026-08-11 review**: `pnpm build` still green (including `audit-shipped-css.mjs` and `probe:render`), `audit-package-boundary.mjs` green on its own, with the numbers becoming `main loads 2 file(s) / 322277 B`, `the package host loads 1 file(s) / 25974 B`, `1 declared tool name(s) in 5 built manifest(s) and none in main`. **2026-08-11 review again**: `pnpm build` still green, `audit-package-boundary.mjs` green on its own, main's cell 322277 → **322338 B**, the rest unchanged. **2026-08-11 third review**: `pnpm build` still green, `audit-package-boundary.mjs` green on its own, main's cell 322338 → **322352 B**, the package host still 25974 B, the rest unchanged. **2026-08-12 fourth review before delivery**: `pnpm build` still green (including `audit-shipped-css.mjs` and `probe:render`), `audit-package-boundary.mjs` green on its own, main's cell 322352 → **324123 B** (the bytes these rounds' guards and comments landed in main), the package host still **25974 B** —— the cell for package code reaching main has not moved by a byte. |
| 29 | 🟢 has a carrier | `main/packages/__tests__/host-env.test.ts` (not one variable shaped like a credential, absent by default outside the allowlist, and the child process told only which package it is and where the code lives). |
| 30 | 🟢 has a carrier | `main/packages/__tests__/reduce-stays-sync.test.ts`. |
| 31 | 🟢 has a carrier | `main/packages/__tests__/lazy-start.test.ts`. |
| 32 | 🟢 has a carrier | `hardening.test.ts`'s five "the driver host inherits an allowlist, not the environment" cases, including edges like "an empty string is a value, not an absence" that only occur to somebody who has written it. |
| 33 | same as 12 | As above. |
| 34 | ⬜ not run → ✅ measured + inverse | Original verdict: `@electron/fuses` is configured in `package-mac.mjs`, but **nobody reads the packaged binary back** to prove the three fuses really are false, and the `ELECTRON_RUN_AS_NODE=1` inverse check was not done either. **2026-08-11 filled in**: `scripts/verify-fuses.mjs` (`pnpm verify:fuses`), reading back + behaviour + positive control + inverse, see §4undevicies(d)(e). **2026-08-12 re-run before delivery**: `pnpm package` first, to build a fresh one (the previous one was from 8-11); all three fuses read back as `DISABLE`, the packaged binary refuses `ELECTRON_RUN_AS_NODE=1`, and the un-fused electron in `node_modules` still runs (the positive control is there). Exit code 0. |
| 35 | 🟢 done | `package-mac.mjs`'s header comment states the relationship between `asar: false` and the two asar fuses. |
| 36 | ⚠️ implemented, unasserted → ✅ measured + inverse | Original verdict: `main/window-hardening.ts` has the `will-navigate` interception, and there is no test that navigating to `https://example.com` is blocked. **2026-08-11 filled in**: `scripts/probe-hardening.mjs`'s `frame-navigation` / `window-navigation`. Filling it in found **the implementation itself was wrong** —— it refused the package frame's first load as well, so Tier C views had been blank all along; and it measured that in Electron 43 `will-navigate` is the backup, not the primary. Both are in §4undevicies(a)(b). |
| 37 | ⚠️ implemented, unasserted → ✅ measured + inverse | Original verdict: as above —— `setPermissionRequestHandler` is in that file, with no assertion that the three permissions are refused. **2026-08-11 filled in**: the same probe's three `permission-*` checks, asked inside a real `peek-package://` frame and **transcribing the real handler's answer** rather than only looking at the page's result. The clipboard goes only through the check handler, see §4undevicies(c). |
| 38 | ✅ measured + inverse | The carrier is `scripts/probe-hardening.mjs`'s `origin-isolation`. Three origins —— the two package ids `probe-a` / `probe-b` and the host window (`file://`) —— each write `localStorage` + Cache Storage once (same names, same keys, different values, `b` writing last), and each of the three reads back its own; neither frame's key list holds the window's sentinel, and the window's list holds neither package's. Two inverse checks: `--plant=one-origin` (both frames pointed at the same id) → **`a` reads back `"b"`**, red at the storage layer rather than merely an origin string not matching; and hand-editing `PACKAGE_SCHEME_PRIVILEGES.standard = false` → all three frames **load as usual** (`frame-first-load` still green, which is the "it does not raise an error" the criterion talks about), but `origin` becomes `"null"`, `localStorage` throws `SecurityError`, and `caches` simply does not exist (`ReferenceError`), turning `origin-isolation` red. The latter was not made into a plant: it drags every check in the round red with it, which does not satisfy "only its own check goes red", and writing it as a plant would claim a precision it does not have. |
| 39 | 🟢 has a carrier | `hardening.test.ts`'s two "the package scheme stays as narrow as it was" cases: the three falses in privileges, and `connect-src 'none'` in the document CSP. |
| 40 | ✅ this round | Read through by hand plus `packages-copy.test.ts`. What was read is in (e). |

**2026-08-11, one sentence covering rows 18 / 36 / 37 / 38**: all four rows'
carrier is `scripts/probe-hardening.mjs`, and the whole thing re-ran **8/8 green**
this round (`frame-first-load`, `frame-network`, `origin-isolation`,
`permissions-request`, `permissions-check`, `permissions-observed`,
`frame-navigation`, `window-navigation`). **It is only a re-run; none of the four
inverse checks was re-derived** —— they are recorded in §4undevicies, so this
round's green is the green of the 🟢 tier and is not promoted. **2026-08-11 re-run
again: still 8/8, exit code 0**, again only a re-run, again not promoted
(§4tervicies(a)). **2026-08-12 third re-run before delivery: still 8/8, exit code
0**, again only a re-run, again not promoted (§4septemvicies(b)).

### (b) The two red ones

**Acceptance criterion 13's first sentence: after an uninstall, `tools/list`
**still** holds its tools.**

Measured (live neo4j, through a real MCP client): after uninstalling `neo4j`

- `tools/list` is still 14, and `expand_node` is still there;
- **open a new MCP session** and ask again — still 14, so this is not
  §4quaterdecies(d)'s "the strings were stored when the session was established"
  problem, and a fresh handshake does not help either;
- it is still there after **restarting the app** (that restart was acceptance
  criterion 14's; the package really did not come back, and the tool did);
- actually calling it returns a structured `[NOT_FOUND] The package 'neo4j' is not installed, or ships no
  contrib entry`.

The cause is not new: `main/mcp/package-tools.ts:74` maps `drivers/mcpTools.ts`'s
**compile-time constant** `PACKAGE_TOOL_META` rather than the loader's
`installedTools()`. §4terdecies(g) item 1 already recorded this debt, but what it
recorded was "**execution** is still not wired up" —— `toPeekTool` wants `kind` /
`hasRenderer` / a zod schema, and the manifest does not have them.
**What this round measured is that debt's other consequence, which had not been written down**:
not "a newly installed package's tools cannot be listed", but that
**an uninstalled package's tools can be**. What the model sees is a tool pointing
at a database it cannot even connect to.

Not fixed on my own initiative: turning `tools/list` into a read of the registry is
the substance of that decision in §2.4bis(d) (add it to the manifest, or fetch the
function half along with the host's first fork), and per CLAUDE.md the document
comes before the code.
**Until that decision is made, acceptance criterion 13's first sentence is false, and this table has to write it as false.**

**2026-08-11 addendum: the decision was made (add it to the manifest), implementation in §4duodevicies.**
This passage is left as it stands, because it is that change's only source of
requirements, and "measured but not fixed on my own initiative" is exactly the
shape it ought to have.

**Acceptance criterion 22: the renderer chunk should shrink, and measured it grew by 36,985 B.**

Baseline 597,160 B, now 634,145 B (plus the lazy `SqlEditor-*.js` at 434,951 B).
The criterion says that growth means something got statically imported in —— the
spot check for client signature strings is clean (acceptance criterion 17), so it
is more likely the window code that has grown in the meantime (the whole
install/uninstall block in the settings panel, the two empty states for when a
package is absent, the connect dialog's repaint). **This has not been established, so no conclusion is written here.**
The way to establish it is a chunk attribution comparison against that baseline
build, not changing the baseline.

### (c) Why acceptance criterion 1's "not one line changed" did not hold, and what replaced it

`connect-form.test.ts` used to loop over `DRIVER_IDS`. After packaging that constant
is not the picker's source (the picker reads `manifestDriverIds()`), and continuing
to loop over it means exhaustiveness **over a roster that does not ship** ——
a driver that is "installed but not on the roster" would go untested from end to
end, and that is precisely the failure shape that installing a package at run time
brings in. So what changed is **where the loop gets its data**, not the assertions:
every driver still goes through the same set of form assertions, and the count only
went up (the great majority of that +147 / −32 is new comments and new cases). This
is the only acceptance criterion in the whole document judged to have been
**written too small**.

### (d) Acceptance criterion 16's inverse check: two levels, both measured

The criterion asks that "with the send removed, this test must fail". There are two
sends, so it was done twice:

1. **At the unit level** —— comment out the two `options.toolsChanged()` calls in
   `main/packages/commands.ts`, and `hot-reload.test.ts` goes from `pass 20 / fail 0`
   to **`pass 18 / fail 2`**:
   `packages.install → a package installed now is connectable now, and the windows and MCP are told`,
   `packages.restore → brings back an uninstalled bundled package, and tells the windows and MCP`.
   **A hole measured in passing**: `packages.uninstall`'s four cases are **all green**
   —— nobody asserts the uninstall path's notification at the unit level, and it is
   guarded only by smoke.
   (This hole has since been filled by `2026-08-11-package-admin-out-of-main.md`:
   `createPackageAdmin` moved to `main/packages/admin.ts`, the harness drives
   production code directly, and both the uninstall path's notification and
   "the notification comes after `adopt`" now have assertions at the unit level.)
2. **At the end-to-end level** —— comment out
   `entry.server.sendToolListChanged()` in `main/mcp/server.ts`, `pnpm build` again
   (green, which says the build guards cannot see this), and `smoke-drivers.mjs`
   gives **`smoke: aborted — notifications/tools/list_changed after install never arrived`**,
   exit code 1.

Both were restored from backup files and confirmed byte-identical with `diff`, and
re-run after restoring: unit `pass 20 / fail 0`, and smoke green again after a
rebuild.

### (e) Acceptance criterion 40: what was read by hand

`packages-copy.test.ts` only scans every value of `settings.packages.*` in both
languages. This pass by hand covers **every sentence a person can read on the
install/uninstall path**, listed one by one, because "I looked at it" without
saying what amounts to not having done it:

1. `settings.packages.*`, 24 entries each in en and zh-CN —— the four column
   headers, `sourceBundled` / `sourceUser`, `sourceNote`, `trustNote`, the four
   buttons (Install… / Uninstall / Upgrade to x.y.z / Restore bundled package),
   `reading` / `empty`, the six receipts (installed / replaced / uninstalled /
   uninstalledClosed ×2 / restored / restoredNone / restoreFailed), and the two
   view-kind explanations.
2. **`connect.noPackages` / `connect.driverGone`** (`i18n/messages/{en,zh-CN}/sidebar.ts`)
   —— no package installed at all, and the driver of a connection in the connection
   book being gone. Both sentences are clean,
   but **they are outside `packages-copy.test.ts`'s scan** (that guard recognises
   only the `settings.packages.` prefix).
   This is the guard gap found this round, recorded in (f).
3. **The native directory picker** (`dialog.showOpenDialog({ properties: ['openDirectory'] })`
   in `main/index.ts`) —— peek gives it no title / message / buttonLabel, so that
   screen is entirely system copy: nowhere that could imply safety, and nowhere to
   write anything.
4. **The loader's warning** (`redactWarnings` in `loader.ts`), because it reaches the
   error centre where people read it:
   "declares no redact block, so its whole connection config — passwords included — is shown to
   MCP clients and stored in the command log verbatim". It states the consequence,
   not a security level.
5. There is no hard-coded English in `PackagesSection.tsx`'s JSX (grepped), so what
   item 1 covers is the whole panel.

Conclusion: **no wording of the `已验证` / `安全` / `可信` / `completely` kind appears.**
The one place any form of `信` (trust) appears is `trustNote`: `装它，就是你决定信它`
—— the subject is the user, and it says who is trusting, not that peek has confirmed
anything.

### (f) Still owed after this round

1. ~~**Acceptance criterion 13's first sentence** —— replace `PACKAGE_TOOL_META` with the loader's output. A decision, not a refactor ((b)).~~
   **2026-08-11 paid off: §4duodevicies.** —— **that sentence was written too early.** That change addressed a necessary condition;
   the shipped path did not really hold until §4vicies(c) (main passing `tools:` had switched the rebuild off).
   **2026-08-11 paid off after review: §4vicies(a)(b)(c).**
2. ~~**Acceptance criterion 22** —— why the renderer chunk grew, to be established with a chunk attribution comparison against the baseline.~~
   **2026-08-11 established: §4vicies(d).** Attributed to zod (`z.fromJSONSchema` reaching the window chunk through core's
   barrel export). **The attribution is established, the leak itself is not fixed** —— the fix means touching the resolution path
   of 109 imports, enough for a document of its own, see the last paragraph of §4vicies(d).
3. ~~**Acceptance criteria 18 / 19 / 38** —— all three are run-time evidence for "the front-end boundary", and today there is not one piece of it.
   38 especially: it does not raise an error when it degrades to an opaque origin.~~
   **Settled**: 18 / 38's carrier is `scripts/probe-hardening.mjs` (see §4undevicies,
   re-run 8/8 on 2026-08-11); 19's carrier is the 33 cases in
   `packages/core/src/__tests__/package-view-channel.test.ts`, with the inverse check recorded in the table's row 19.
4. ~~**Acceptance criterion 34** —— read the fuses back after packaging, and the `ELECTRON_RUN_AS_NODE=1` inverse check.~~
   **Settled, see §4undevicies(d)(e)** (`scripts/verify-fuses.mjs`).
5. ~~**Acceptance criteria 36 / 37** —— implemented, missing assertions.~~
   **Settled, see §4undevicies(a)(b)(c)**; filling them in found the implementation itself was wrong.
6. ~~**Acceptance criterion 21** —— `bench-package-frame.mjs` does not exist, and the criterion does not match `scripts/`.
   **2026-08-11 still owed**: `bench-scroll.mjs` was not run this round either.~~
   **Settled (2026-08-12), see §4septemvicies(a)(c)**: the road taken was "rewrite the criterion" ——
   delete that non-existent script name, with the reason and the gap it leaves written into the criterion; and `bench-scroll.mjs`
   produced numbers before delivery, all three criteria green.
7. ~~**The gap in the copy guard** —— `packages-copy.test.ts` recognises the `settings.packages.` prefix,
   which puts `connect.noPackages` / `connect.driverGone` outside the scan.~~
   **Settled (2026-08-11), see §4septdecies.**
8. **`view.packageMissing` is unreachable at run time, and has no assertion on the renderer side.**
   Measured: `packages.uninstall`'s receipt carries `closedViewIds`, and the views are **closed**,
   not left in place degraded —— so acceptance criterion 13's third sentence cannot be asked on today's path.
   The degradation itself is guarded only by core's `package-view-kinds.test.ts` (two `/no package loaded/i` cases),
   and the window half (`ViewHost`'s `view.packageMissing`) has not one assertion.
   It is still reachable: once the workspace is persisted, views opened while a package was installed will be
   restored after it is uninstalled.

## 4septdecies. Implementation record — filling the gap in the copy guard (§4sedecies(f) item 7)

> 2026-08-11. One test file changed, and not one line of copy.

### (a) What the gap is

`packages-copy.test.ts` recognises one prefix: `settings.packages.`. Two more
sentences on the install/uninstall path live elsewhere ——
`connect.noPackages` / `connect.driverGone` (`i18n/messages/{en,zh-CN}/sidebar.ts`),
no package installed at all, and the driver of a connection in the connection book
being gone. Both talk about "go install a package", both are package copy, and
both are outside the scan. §4sedecies(e) item 2 read them by hand and both are
clean; **what is clean is the copy, not the guard**.

### (b) The prefix becomes a table rather than `settings.packages.` becoming `connect.`

The change is `PACKAGE_KEY_PREFIXES = ['settings.packages.', 'connect.noPackages', 'connect.driverGone']`,
with `packageCopy()` becoming `some(startsWith)`. A table rather than yet another
regex, because which prefix the next sentence of package copy will fall under is
not known today —— a table has somewhere to add, a regex only has somewhere to
change.

The last two entries are whole keys rather than prefixes, and `startsWith` eats
them just the same. They are not promoted to a `connect.` prefix: that would sweep
in package-unrelated keys like `connect.mode` / `connect.mode.url`, and the
banned-word list is written against "has this package been checked or not" ——
scanning other form copy with it only manufactures false reds.

### (c) The one extra assertion: a prefix may not scan nothing

New: `every prefix still matches copy, so none of them scans nothing` —— every
prefix hits at least one key in every language. **This is the only part of this
change carrying information**: the prefix table itself will rot. Rename a key and
the scan above stays green, having simply read one sentence fewer, and saying so
nowhere —— that is exactly the difference between "no banned word was found" and
"there is no banned word there". It is the same shape as the last falsely green
test in §4quindecies(g).

### (d) Inverse checks: three, all measured

| what it guards | how it was broken | what red looks like |
|---|---|---|
| en's `connect.driverGone` is inside the scan | changed to `so this verified connection cannot be opened…` | `✖ no banned word appears in any locale` → `en / connect.driverGone: “verified” in …` |
| zh-CN's `connect.noPackages` is inside the scan | changed to `没有可以安全连接的东西` | the same case → `zh-CN / connect.noPackages: “安全” in …` |
| a prefix may not scan nothing | `connect.noPackages` renamed to `connect.nothingInstalled` in both catalogs | `✖ every prefix still matches copy…` → `en has no message under “connect.noPackages”` |

The third deserves saying on its own: **after the rename the first three assertions are all green**,
and only the newly added one goes red. That is exactly why it exists.

All three were changed back, and `diff` confirmed both catalogs byte-identical to
before the change.

### (e) Acceptance

`packages-copy.test.ts` 4 cases all green (the original 3 unchanged to the word,
with not one word deleted from the banned-word list);
`src/renderer/i18n/__tests__/*` 26 cases all green; `pnpm typecheck` all green.

The `describe`'s name changes from `the packages panel never claims…` to
`package copy never claims…` —— what it scans is no longer just that panel. The
three `it` names are untouched, because the table in §4quindecies(g) quotes the
`it`s.

### (f) This item is struck off the debt list

§4sedecies(f) item 7 settled. The remaining 1–6 and 8 are untouched.

---

## 4duodevicies. Decision + implementation — the tool's execution half goes into the manifest (§4duodecies(f) item 1 decided)

> 2026-08-11. This section answers what §4sedecies(b) measured: **after uninstalling `neo4j`,
> `expand_node` is still in `tools/list`** —— in the same session, in a newly opened MCP session,
> and **still there** after the whole app restarts, with the package gone from `~/.peek/packages/`
> and the tombstone written.
> Calling it returns a structured `[NOT_FOUND] The package 'neo4j' is not installed, or ships no
> contrib entry`, so it does not pretend to work; but what the model sees is still a tool pointing
> at a database it cannot even connect to.
>
> This is not a refactor, it is the decision laid out by §4duodecies(f) item 1 / §4terdecies(g) item 1.
> Two ways out: **(1) add `kind` / `hasRenderer` / `title` / `annotations` to
> `peek-package.json`**, or **(2) fetch the function half along with the package host's first fork**.

### (a) Option 1 is taken, and option 2 is killed by two acceptance criteria that already exist

**Take (1): into the manifest.**

Option 2 sounds cheaper —— "we have to fork for execution anyway" —— but that
sentence only holds for **execution**, not for **registration**. Registering a tool
on MCP means handing over four things at that moment: `name`, `description`,
`inputSchema`, `annotations`; and peek's side has to decide at the same moment
which constructor to use (`defineReadTool` or `defineCommandTool`) and whether to
attach `render`. **Registration happens before `tools/list`, which is to say before anybody calls anything.**
So option 2 has only two landings, and both hit a wall:

1. **List without `annotations`, and fill them in on the first call.** Then the model
   decides whether to call `expand_node` **without `destructiveHint`**. A hint's
   entire value is before the call, and supplying it after the call is supplying
   nothing. §4terdecies(g) item 1 already wrote this sentence itself ("leave the last
   two out and the model loses hints like `destructiveHint`").
2. **Fork once at install time (or at startup) to fetch the function half back.** This
   runs straight into **acceptance criterion 31** (install 20 packages, use none of
   them, and the package host process count in `ps` is 0) and **acceptance criterion 20**
   (cold start with 0 vs 20 packages installed, a ready-to-show median moving > 20ms
   counts as signal) —— the registry has to exist again after a restart, so "fetch
   once" is **20 forks on every startup**, not a one-off cost.

So option 2 either hides the hints from the model or stops lazy start being lazy.
**There is no third landing**, which is why, although this is a "decision", only one
answer can satisfy the acceptance criteria already written down.

Option 1's cost is real and is written in (c) and (g): four more fields on the
manifest, which package authors have to write; and `inputSchema` being JSON Schema
on disk while execution wants zod, hence one `fromJSONSchema` more.

### (b) The four extra fields on the manifest, and why exactly these four

What `toPeekTool` wants (the same `defineCommandTool` / `defineReadTool` the
kernel's 13 tools go through), minus the three the manifest already has, leaves
**exactly** these four:

| field | what happens without it |
|---|---|
| `kind` | `read` and `command` are two constructors; guess wrong on one half and a read-only tool gets wired to the Command Bus |
| `hasRenderer` | `defineCommandTool` reads "no `render`" as "use the default receipt", and there is no third answer |
| `title` | MCP `Tool.title`, which clients draw in the tool picker |
| `annotations` | `readOnlyHint` / `destructiveHint` / `idempotentHint` / `openWorldHint` |

`hasRenderer` is only meaningful when `kind: 'command'`, so these two blocks on the
manifest are a **discriminated union**, not one object with an optional field: a
tool with `kind: 'read'` that writes `hasRenderer` is refused, because that sentence
has no meaning, and a meaningless field being silently ignored is precisely how the
next person comes to think it took effect.

**The source is still the declaration the package already has** (§4duodecies(d)'s
rule is unchanged): `defineToolMeta({ kind, hasRenderer, title, annotations, … })`
already writes those four, and `build-packages.mjs`'s `serializeTool` serialises
them into `peek-package.json` along with the rest. There is no second source of
truth, and no extra line for package authors to write.

### (c) `inputSchema`: JSON Schema on disk, zod for execution

`ToolMeta.inputSchema` is a `z.ZodType`; on `peek-package.json` it is JSON Schema
(written by `build-packages.mjs` with `z.toJSONSchema`). So main has to
`z.fromJSONSchema` once after reading it back. §4terdecies(g) already measured that
this works, and this round re-measured it:
`toJSONSchema → fromJSONSchema → toJSONSchema` is the identity on `expand_node`'s
schema, and all four of `$ref` / `allOf` / boolean sub-schemas / `format` convert.

**What happens when it cannot convert: refuse at load time, naming which tool of which package.**
This lands in `PackageManifestSchema` (`packageToolInputSchema` is that
conversion's only entry point, exported by core, and the loader and main's
`packageTools()` use the same function). This **narrows** §4duodecies(c)'s
"explicitly not checked" item 1, and that item changed too —— with the reason for
the narrowing written there: "holding no opinion on dialect" still stands, but
"peek must be able to build an input validator for it" is a **need** of the
execution path, not a preference. A tool whose schema cannot be converted has no
way of being called at all, and refusing it by name at install time is better than
the model finding out on its first call.

**The schema published on MCP after one round trip is not word-for-word the original, and that has to be said plainly.**
The MCP SDK's `registerTool` only eats zod (or a raw shape) and converts it back to
JSON Schema itself, so what is published is
`toJSONSchema(fromJSONSchema(the copy on disk))`. For peek's own packages this is
the identity (nailed down by a case); for a third-party package written in a tricky
style, what is published may be semantically identical and literally different. That
is option 1's bill, recorded here rather than left for the next person to discover.

### (d) Beyond `tools/list`: the session is live, and so is the registry

Replacing `packageTools()` with a read of `installedTools()` is **not enough**, and
this is exactly the explanation for §4sedecies(b)'s "open a new MCP session and ask
again — still 14" line: `server.ts`'s
`const tools = options.tools ?? collectTools()` computes once when the **server is
built**, and every new session gets that same copy. So this step has two halves:

1. **The tool set becomes computed at each use** (`rebuildTools()`) —— a new session
   registers against the registry as of that moment;
2. **Live sessions have to reconcile** (`reconcileSessionTools`) —— `RegisteredTool.remove()`
   for names that are gone, `server.registerTool()` for ones newly appeared, and a
   refreshed description for the survivors (what `refreshToolDescriptions` used to
   do) —— **and then** the one `tools/list_changed` is sent.

Item 2 is the entire content of "what gets listed after the notification really is
different". Without it the notification goes out as usual and `tools/list` stays as
it was —— which is the second form of the "the notification was nearly empty"
recorded in §4quaterdecies(d): that time the description was stale, this time the
**tools themselves** are.

**One install or uninstall sends more than one notification, and that is SDK behaviour, not a bug:**
`registerTool` and `RegisteredTool.update()` (which is what `remove()` goes through)
each send one. We still send one explicitly after reconciling, because only that one
covers the case where the tool set did not move and a description did. A client
repeating `tools/list` is idempotent, and the cost is one redundant round trip.

### (e) Acceptance criterion 28's third clause is turned around

The original text says "every tool name a package declares **must be in** main's
closure". That was right while `PACKAGE_TOOL_META` was a compile-time constant (if
the name is not compiled into main, `tools/list` cannot answer with it). After this
round the names come from disk, so their appearing in main means **the opposite** —
that some compile-time roster has not been fully dismantled, which is exactly the
shape of acceptance criterion 13's first sentence failing. The new criterion:

- every tool name must appear in `out/packages/<id>/peek-package.json` (the positive
  control: this time the build really was read, and **read in the right place**);
- every tool name must **not** appear in main's closure.

The original wording is kept in §4's criterion for contrast, not deleted.

### (f) Carriers

| carrier | what it guards |
|---|---|
| `main/mcp/__tests__/package-tools-follow-registry.test.ts` (8 cases) | **Acceptance criterion 13's first sentence**: the tool table is a reading of the registry. All three states present —— present once installed, gone once uninstalled, empty when nothing is installed —— plus the four manifest fields really arriving on the registration |
| `main/mcp/__tests__/session-tool-reconcile.test.ts` (5 cases) | (d) item 2: a live session's reconciliation. Deleted, newly added, survived (no duplicate registration; the SDK throws on a duplicate name), description changed, and the same name backed by a new implementation |
| 7 new cases in `core/__tests__/package-manifest.test.ts` | Validation of the four manifest fields: `kind` required, `hasRenderer` required on a command, **refused rather than ignored** on a read, `title` / `annotations` optional and carried through verbatim, a schema that cannot become a validator refused, and the three "no opinion on dialect" spellings still let through **and** convertible |
| `smoke-drivers.mjs` | End to end: the `echo` fixture declares an `echo_ping`, and after installing it the **same session**'s `tools/list` gains it, calling it fails structurally, and after uninstalling, the **same session**'s `tools/list` has lost it |
| `scripts/audit-package-boundary.mjs` direction 3 | (e): a tool name must be in the built manifest, and **must not** be in main's closure |

`echo_ping` is deliberately "declared but not mapped" (the reason is in the header
comment of `fixtures/packages/echo/contrib.mjs`): it is simultaneously the only
shape in which "listing a tool forks no process" can be asked end to end.

### (g) Four things not done

1. **A name colliding across packages / with the kernel is still a throw inside `collectTools()`.**
   §4duodecies(c)'s "explicitly not checked" item 2 says this should be done at the
   registry layer as "skip this package and report it".
   The loader already blocks collisions between packages (`loader.ts`), and there is
   nothing blocking a collision **between a package and the kernel's 13**, which is
   now a run-time matter —— an installed package declaring `run_query` makes
   `collectTools()` throw, and that is on the session-building path. The shape of the
   fix is clear (skip + notify), but it is a change on the loader's side (only the
   loader knows which package to blame), and it is not done this round.
2. **The `mcp-tool-meta.ts` / `limits.ts` entries in `MAIN_MAY_REACH` were not deleted.**
   Main really does not load them any more, and deleting them would be the honest
   thing; but deleting them turns their literals into "signature strings", and the
   package host's build **really does** contain `expand_node` —— because
   `drivers/mcpToolSpecs.ts` still compiles neo4j's spec into the host (the Phase B
   debt in §4ter(e)). Deleting those two entries would turn acceptance criterion 28's
   direction 2b red on account of a debt this round is not paying. Both entries' `why`
   is rewritten into what is true today.
3. **There is no real sample of a package tool with `kind: 'read'`.** Only cases cover
   it; every package tool in the repository is a `command`.
4. **`server.ts`'s `rebuildTools()` has no unit carrier.** What it guards is "a newly
   opened session reads the registry as of now", and `createMcpServer` needs a port
   bound before it will run. Today it is covered only by smoke, and the unit level is
   empty.

### (h) Inverse checks: measured one by one

Break it → watch it go red → restore from backup and confirm byte-identical with
`diff` → re-run and watch it go green. The scripts are in the scratchpad, not in the
repository.

| what was broken | result |
|---|---|
| `packageTools()` put back to mapping `PACKAGE_TOOL_META` | red: **4 cases** (`pass 4 / fail 4`) —— `a registry without the package offers none of its tools`, `nothing installed means no package tools, not a compiled-in fallback`, `a tool arriving with a package is offered without a rebuild`, `` `kind` picks the constructor `` |
| reconciliation no longer calls `entry.registered.remove()` | red: `a package uninstalled while the session was open loses its tools` |
| reconciliation no longer registers newly appeared tools | red: `a package installed while the session was open gains its tools` |
| reconciliation no longer calls `refreshToolDescriptions` | red: 2 cases —— `a description that moved is written back, for the tools that stayed`, `a tool replaced under the same name is taken from the new set` |
| `hasRenderer` on the manifest changed to `.default(false)` | red: `a command tool that does not say whether it writes a receipt is refused` |
| the `z.never()` on the read branch removed | red: `hasRenderer on a read tool is refused rather than ignored` |
| the superRefine on `inputSchema` (refuse what cannot become a validator) removed | red: `a schema that cannot become a validator is refused, naming the tool` |
| `main/mcp/package-tools.ts` importing `PACKAGE_TOOL_META` once again | red: **`pnpm build`** —— `AssertionError: 1 declared tool name(s) are compiled into main`, exit code 1. **Only the build-output check catches this one**: with the same change, `pnpm test` and `pnpm typecheck` are all green |
| `build-packages.mjs`'s `serializeTool` no longer writing `kind` / `hasRenderer` | red: `pnpm build:packages` —— `packages/db-neo4j serializes into a peek-package.json that peek would refuse: tools.0.kind: Invalid discriminator value` |

**One that cannot be inverse-checked, written down so it does not look like an omission**:
`kind` being required is held by `z.discriminatedUnion` itself, and "breaking" it
means taking the discriminated union apart —— that is a different structure, not a
one-line loosening. Row 5 of the table above is the closest single cut the same
validation can make.

### (i) What this round ran

- `pnpm -r typecheck` all green.
- `pnpm test`: core **151** / db-neo4j 71 / db-qdrant 38 / db-postgres 60 / db-sql 83 /
  desktop **1822** (+13 this round) all pass. `db-redis`'s
  `builds a namespace tree from key prefixes, lazily` is still red —— it needs a
  `peek:test:*` fixture on a live redis, §4sedecies already recorded it, and it is
  unrelated to this round.
- `pnpm build` all green, including `audit-package-boundary.mjs` (the new direction 3
  reporting `1 declared tool name(s) in 5 built manifest(s) and none in main`),
  `audit-shipped-css.mjs`, and the render probe.
- **`smoke-drivers.mjs` was not run this round** —— it needs a packaged app, live
  databases and CDP.
  The smoke row in (f)'s table is **assertions written, not measured**; whoever runs
  smoke next round fills that cell in first.

---

## 4undevicies. Implementation record — the assertions for acceptance criteria 34 / 36 / 37, and a production defect they turned up

> 2026-08-11. §4sedecies recorded these three as ⬜ not run (34) and ⚠️ implemented, not
> asserted (36, 37) respectively. This round fills the assertions in. **Writing the
> assertions itself turned up a defect**: guard 36 has, since the day it landed, been
> refusing every package frame's first load as well — which means **the Tier C view is
> blank today**. That is precisely the price of the "implemented, not asserted" tier,
> which is why it comes first.

### (a) `will-frame-navigate` fires for a frame's own first load

`main/window-hardening.ts`'s original `refuseNavigation` let exactly one case through:
the target URL equals the window's current URL (for HMR's full-page reload). An iframe's
first load does not satisfy that, so it gets `preventDefault()`ed. Measured (Electron 43,
both spellings tried: an iframe with `src` in the HTML, and inserting an empty iframe and
then assigning `src` from JS):

```
[peek/error] refused an in-window navigation to peek-package://probe/index.html
frames: (anon)=(empty) | (anon)=about:blank
```

The product-level shape: `PackageFrame` never gets its `ready`, and after
READY_TIMEOUT_MS it shows the "the frame did not respond" fallback layer — not an error,
a view that never stops spinning.

**Why nobody ever noticed**: the comment on the neo4j line in `smoke-drivers.mjs` states
the reason itself — "a package whose UI is not built does not make this fail (the frame
is the renderer's business)". What smoke checks is the `open_view` plan path; it **has
never actually loaded a package frame in a hardened window**. The assertion acceptance
criterion 36 was missing is missing exactly the one path that would hit it.

**The fix follows §2.10 clause 4's own wording**: that clause says "`frame-src` governs
whether it can load, not where it navigates after loading". Which is to say this guard's
boundary was set at "after loading" from the start, and the implementation overstepped
it — doing `frame-src`'s job, and doing it wrong. So the pass condition is "this frame
has no document yet":

```ts
const from = event.frame?.url ?? ''
if (from === '' || from === 'about:blank') return
```

**The condition cannot be forged in the direction that matters**: a package frame that
has already loaded cannot get back to the "no document" state — going back is itself a
navigation, and that navigation is refused right here. Nor can a package create a frame
of its own: `PACKAGE_CSP`'s `frame-src 'none'` stands in front. The division of labour
between the two mechanisms has not changed; each is just back in its own place.

### (b) `will-navigate` is the spare in Electron 43, not the workhorse

A second measured finding, inconsistent with what `window-hardening.ts`'s header comment
says, so it is recorded:

**Electron fires `will-frame-navigate` first, and once that calls `preventDefault()`,
`will-navigate` does not fire at all.** All three ways of triggering it (`location.href=`,
`location.assign` with a user gesture, actually clicking a link) give the same result.
With only `will-navigate` attached, it fires normally and blocks.

So in a hardened window, **the main frame's interception is in fact done by
`will-frame-navigate`**, and `will-navigate` is the second line that only comes on once
the first is removed. Both listeners stay — but "who is doing the work" is not what the
comment says, and that kind of discrepancy is exactly what the next refactor will cite
when it removes "the useless one".

Acceptance criterion 36's assertion therefore **judges by property, not by listener
name**: record which event fired, whether `defaultPrevented` is true, and whether the
page is still where it was — all three together.

### (c) Acceptance criterion 37: three permissions, three different dialects of refusal

Measured inside a package frame (`peek-package://` origin, secure context):

| permission | which handler | what the page sees |
|---|---|---|
| notifications | request | `Notification.requestPermission()` → `'denied'` |
| geolocation | request | `getCurrentPosition` error callback, `code === 1` |
| clipboard-read | **check only** | `clipboard.readText()` rejects with `NotAllowedError` |

**The clipboard does not go through the request handler**, only through the check
handler. That is precisely the division of labour claimed by `window-hardening.ts`'s
comment — "one answers the prompt, the other answers the synchronous query some APIs make
before prompting" — and it is now measured rather than claimed. Both handlers must be
present; removing either drops a column.

The assertion works by **wrapping the session's two setters ahead of `hardenWindow`**,
transcribing every answer the real handlers give. Looking at the page's result alone is
not enough: Chromium refuses a share of these itself (a notification request from a
cross-origin iframe, a feature with no permissions-policy grant), and that kind of
"refused" proves nothing about peek refusing. The probe's fixture therefore **deliberately
dismantles peek's second layer**: the iframe gets the widest `allow` (in production it is
`allow=""`), and the host document carries no CSP. The only mechanism left standing is the
pair of handlers `hardenWindow` installs. This discipline is the trip-up §2.10 took over
partitions — test the wrong mechanism and passing says nothing about the property you
wanted.

### (d) Acceptance criterion 34: read-back plus inverse, both halves required

`scripts/verify-fuses.mjs`, in two halves:

1. **Production says they are off** — `getCurrentFuseWire` reads the packaged artefact and
   asserts that `RunAsNode` / `EnableNodeOptionsEnvironmentVariable` /
   `EnableNodeCliInspectArguments` are all `FuseState.DISABLE`. All nine fuses are printed,
   so that "the two asar fuses do not apply because of `asar: false`" is visible rather
   than inferred.
2. **The binary's behaviour is off too** — `ELECTRON_RUN_AS_NODE=1 <binary> -e …` must not
   execute the script.

**The second half carries a positive control, and it is not optional**: "the sentinel did
not appear" is also what a mistyped command, a wrong path, or a silent crash looks like.
So the same command also runs against the **unfused** Electron in `node_modules`, where
the sentinel **must** appear. One command, two binaries, opposite conclusions.

Measured (against `release/peek-darwin-arm64/peek.app`):

```
  * RunAsNode                              DISABLE
  * EnableNodeOptionsEnvironmentVariable   DISABLE
  * EnableNodeCliInspectArguments          DISABLE
  the packaged peek binary: did not run the script
  node_modules electron (unfused control): ran the script (…:v24.18.0)
```

Under `ELECTRON_RUN_AS_NODE=1` the packaged one **goes off and starts the real app**, so
the script hands it a temporary `PEEK_CONFIG_DIR` and a `PEEK_MCP_PORT` nobody uses, and
kills by process group — a verification script has no business incidentally binding peek's
real port or reading the real keychain.

### (e) Inverse checks

| what is broken | how | how it goes red |
|---|---|---|
| the first-load pass | `--plant=first-load`: attach another `will-frame-navigate` after `hardenWindow` that unconditionally calls `preventDefault` | `frame-first-load` red, the package frame stuck at `(empty)` / `about:blank` |
| sub-frame interception | `--plant=nav-frame`: remove `will-frame-navigate` | only `frame-navigation` red — `will-navigate` still covers the main frame, which is exactly (b)'s evidence |
| main-frame interception | `--plant=nav-window`: remove **both** listeners | `window-navigation` + `frame-navigation` go red together. **Removing only `will-navigate` is all green** — this row expected one when it was written and measured two; the reason is in (b), and what changed was the expectation, not the assertion |
| the permission request half | `--plant=permission-request`: replace with `callback(true)` | `permissions-request` + `permissions-observed` red; `permissions-check` not red (the clipboard does not take this route, see (c)) |
| the permission check half | `--plant=permission-check`: replace with `() => true` | `permissions-check` + `permissions-observed` red |
| Fuse | take **a copy** of the artefact and `flipFuses` `RunAsNode` back to `true` on the copy (which must carry `resetAdHocDarwinSignature: true`, or macOS refuses to execute it outright and the second half goes quiet for the wrong reason), then point `--bundle=` at it | both halves red together: `RunAsNode is ENABLE, not DISABLE` + `the packaged binary honoured ELECTRON_RUN_AS_NODE` |

The fuse row **is not modified in place**: `flipFuses` invalidates the signature, and
anything going wrong midway would leave the user's copy of the app unable to start. The
`--bundle=` switch exists for this inverse check, and the comment says so.

The probe judges a plant against an **exact set**, not "the named check is among the red
ones": a plant that incidentally reddens its neighbours, if counted as passing, trades an
inverse check for zero information about the check it named. The two rows above that "go
red twice" were both run first and then had their expectation changed to two — the
expectation changed, and not one assertion was loosened.

### (f) What rides along with `pnpm test`, and what needs its own command

§4.8 requires this batch of hardening to **be runnable on its own**. There are now three
entry points, divided by "does it need Electron / does it need the artefact":

| command | covers | rides with `pnpm test`? |
|---|---|---|
| `pnpm test:hardening` | 32 / 33 / 39, plus `isExternalLink`. Pure functions, `node --test` | **yes** — `src/main/__tests__/*.test.ts` is in the root glob |
| `pnpm --filter @peek/desktop probe:hardening` | 36 / 37. Needs a real window, a real Chromium | **no**, needs Electron |
| `pnpm --filter @peek/desktop verify:fuses` | 34. Needs `pnpm package`'s artefact | **no**, needs packaging first |

`probe:hardening` **needs no build first** — it imports the TS sources directly (Electron
43 ships Node 24, which strips the types itself), so what the probe runs is `hardenWindow`
itself rather than a compiled copy of it. `verify:fuses` is the reverse: the artefact is
exactly what it tests, and with no artefact it **exits with an error rather than
skipping**.

### (g) One still missing

Acceptance criterion 38 (origin isolation) was not filled in this round. The clause itself
says that when it degrades it **raises no error**, and the ⬜ §4sedecies gave it still
stands.

## 4vicies. Acceptance record — acceptance criterion 13 is still false in production, acceptance criterion 22's attribution confirmed, and the root cause of the db-redis red

This round is a **review round**: no new features, only taking the three cells the previous
round judged "fixed" and "not confirmed" and measuring them. Two of the three were
overturned.

### (a) Acceptance criterion 13: `§4duodevicies` fixed a necessary condition, not a sufficient one

`§4duodevicies` changed `packageTools()` from `PACKAGE_TOOL_META` to reading
`installedTools()`, and `§4duodevicies(d)` then added `rebuildTools()` and
`reconcileSessionTools` to `server.ts`. Both are right, both have unit tests running green.
**Production is still false.**

`scripts/smoke-drivers.mjs` **exits 1** this round:

```
smoke: aborted — echo declares [echo_ping] and tools/list still answers
[… 14 of them …] — the notification arrived and the list behind it did not move
```

The install direction and the uninstall direction have the same cause. Eliminating layer
by layer lands on two lines:

```ts
// main/index.ts, at the createMcpServer call site
tools: collectTools({ callPackageTool }),

// mcp/server.ts
let tools = options.tools ?? collectTools()
const rebuildTools = (): void => {
  if (options.tools === undefined) tools = collectTools()   // ← always a no-op in production
}
```

main **must** pass `tools`: `collectTools()`'s default path cannot reach
`callPackageTool`, and without it every package tool would be "listable but not callable".
But passing `tools` is precisely what switches `rebuildTools()` off — `options.tools`'s
docstring says "a test brings its own tool set", and main wandered into a door left open
for tests.

So production's shape is: `notifyToolsChanged()` sends its notification as usual,
`reconcileSessionTools` runs as usual, but it reconciles against **an array frozen at the
moment the process started** — and the result of that reconciliation can only be "nothing
changed".

**Three more common hypotheses eliminated during the investigation**, recorded here to
save the next person doing it again:

1. *The loader dropped the tool* — no. `loadPackages()` reports
   `loaded:['echo'] refused:[] tools:['echo_ping']` for `fixtures/packages/echo`.
2. *There are two registries in the bundle* — no. `installed:{drivers:[],viewKinds:[],tools:[]}`
   appears **1** time in `out/main/index.js` and 0 times in the package-host chunk.
3. *`remoteSpec` silently skipped the tool because the schema would not convert* — no.
   `packageToolInputSchema(echo_ping.inputSchema).ok === true`.

What actually closed the range is this: after installing, **the window side is right**
(`echo` in the picker, `echo` in the settings panel) and **the MCP side has not moved**.
The registry changed and the tool list did not, which leaves only the stretch between
`collectTools()` and `installedTools()` under suspicion — and that stretch is fine; the
problem is that it **is never called again at all**.

### (b) Acceptance criterion 13's three ways of checking, all measured (the three cells it has owed for two rounds)

Against the **packaged artefact** (`out/`), through a real MCP client, uninstalling
`neo4j`:

| | before the fix | after the fix |
|---|---|---|
| the same session | `expand_node` **still there** (14 tools) | gone |
| a new session (a fresh handshake) | `expand_node` **still there** (14) | gone |
| kill and restart the process, same `PEEK_CONFIG_DIR` | gone (13) | gone |

The third cell has always been green, and it is exactly what explains the first two: a
restart is the **only** moment that runs `collectTools()` again. A tool list that "only
takes effect after a restart" looks one manual restart away from "fixed", which is how it
got past the previous round's acceptance.

### (c) The change, and its inverse check

`options.tools` reverts to what its docstring says, and the package host's caller moves to
a field of its own:

- `mcp/server.ts`: adds `callPackageTool?: PackageToolCaller`; both `collectTools()` call
  sites (the first one and `rebuildTools()`) carry it.
- `main/index.ts`: `tools: collectTools({ callPackageTool })` → `callPackageTool,`.

The inverse check is **already there**, and it is the very one that found the defect:

| | `smoke-drivers.mjs` |
|---|---|
| before | exit code 1, `the notification arrived and the list behind it did not move` |
| after | exit code 0, `tools/list gained echo_ping` / `tools/list dropped echo_ping`, 1/1 |

**This one has no unit-test carrier, and will not have one soon.**
`collectBuiltinTools()` uses `import.meta.glob`, which is a Vite thing; under plain Node it
is `(intermediate value).glob is not a function` — so `createMcpServer()` **cannot be
constructed at all** in a unit test, and indeed no test in the repository has ever
constructed it. That is exactly why this defect could evade both
`package-tools-follow-registry.test.ts` and `session-tool-reconcile.test.ts`: both route
around the server, one testing `packageTools()` and the other testing reconciliation
against a **fake implementation** of `McpServer`, while the wire that was cut lies between
them. `smoke-drivers.mjs` is currently the only thing that can guard this stretch of main's
wiring, the way `probe:hardening` is for `hardenWindow`. **Do not move this criterion back
down to the unit-test layer because "a unit test would be tidier" — moved back, it becomes
invisible again.**

### (d) Acceptance criterion 22: the +37 kB is confirmed — it is zod, not window code

The previous round wrote "more likely the window code that grew in between … not
confirmed, so no conclusion is written here". The way to confirm it is what that sentence
said: a chunk attribution comparison against the baseline. Done — and the conclusion
**overturns that guess**.

Three builds, the same toolchain (`git worktree` + `pnpm install --frozen-lockfile` +
`electron-vite build`):

| build | `index-*.js` | vs. baseline |
|---|---|---|
| `6181bd2` (the baseline, the 597,160 in the clause) | **597,160 B** | — |
| `e3c36d7` (HEAD, **without** this round's packaging change) | 632,834 B | +35,674 |
| the current working tree (with the packaging change) | 671,496 B | +74,336 |

**The baseline reproduced to the byte**, so these three figures are comparable. The first
thing is therefore clear: **35,674 B of the +74 kB was already committed before work on the
packaging change began** — `9a023b4` (the settings panel + the sidebar) and `e3c36d7`
(Tailwind v4). The +36,985 measured last round was a cross-section taken partway through
the working tree, not a final figure.

The packaging change's own half (+38,662 B), attributed to modules by sourcemap (script
below) and folded by dependency, has only one large line:

```
dependency                    HEAD       CUR      DELTA
dep:zod                      73106    109776   +36670
```

One layer further in, the largest piece is **brand new**:

```
zod/v4/classic/from-json-schema.js       0     7914   +7914
zod/v4/classic/schemas.js            12671    21646   +8975
zod/v4/core/schemas.js               23381    32273   +8892
zod/v4/core/api.js                    5042     7998   +2956
zod/v4/core/json-schema-processors.js  5354     8145   +2791
zod/v4/core/regexes.js                2658     5004   +2346
zod/v4/core/checks.js                 6198     8478   +2280
```

`from-json-schema` is the JSON Schema → zod converter. Nothing in the window calls it. Its
route in has three segments, each harmless on its own:

1. `packages/core/src/package-manifest.ts:336` calls `z.fromJSONSchema(json)`
   (`packageToolInputSchema`, added by §4duodevicies, **run only by main**);
2. `packages/core/src/index.ts:39` is `export * from './package-manifest'`;
3. **109** files in the renderer say `from '@peek/core'`.

And `packages/core/package.json` **has no `"sideEffects": false`**, so rollup has no
grounds to decide those top-level `z.object(...)` calls can go — the whole converter rides
the barrel export into the window's chunk.

**The clause's other half is right**: the six manifests really did disappear from the
window's chunk — on the attribution table
`packages/driver-{sql,neo4j,postgres,redis,qdrant}/src/manifest.ts` all go to zero,
−9,824 B in total. They were simply drowned by zod's +36,670. So the clause's criterion
("getting bigger means something was statically imported in") **judged correctly**; it is
just that what was statically imported was not driver code but a JSON Schema converter.

**Not changing it this round.** This is a packaging-level leak of §1.3's "the renderer only
takes data", and the fix (splitting the barrel export, or marking core `sideEffects`)
touches the resolution path of 109 imports, which is worth its own document. All that
happens here is nailing the attribution down, so the next person does not guess again.

The attribution script is one-off and is not in the repository: it decodes the sourcemap's
mappings segment by segment as VLQ and books the generated bytes between one segment and
the next against that segment's source. The totals line up (HEAD attributes 620,287
against an actual 632,834; the current tree 658,433 against 671,496 — the difference being
the runtime preamble the sourcemap does not cover).

### (e) The db-redis red: the fixture itself hit the driver's sampling ceiling

`§4sedecies`'s second line only said "needs the `peek:test:*` fixture on a live redis,
unrelated to this document". This round had a live redis (8.8.0) and it was still red, so
the root cause was investigated: **it is not a missing fixture, it is an oversized one.**

`keyspace.ts:48`'s `PREFIX_SAMPLE_KEYS = 2_000` is `sampleLevel`'s scan ceiling (by
design: on a keyspace nobody dares walk in full, this is what makes it bounded). And
`redis.test.ts`'s `before` stuffs `BULK_KEYS = 3_000` `peek:test:bulk:*` keys under the
**same level** `peek:test:`. SCAN stops at 2000, and `peek:test:tags`, which sorts after
that, is never reached again.

Measured, same driver, only the fixture size changed:

```
BULK=0     nodes=4  names=["queue","user","blob","tags"]
BULK=1500  nodes=5  names=["bulk","queue","user","blob","tags"]
BULK=3000  nodes=3  names=["bulk","queue","blob"]        ← user and tags disappear together
```

The red line is `assert.equal(tags?.kind, 'key')`, `actual: undefined`.

SCAN returns in bucket order, not insertion order, so **which key falls out is
indeterminate** — running this package alone is reliably 1 red, while running it along with
`pnpm test` (in parallel, on a busier machine) has produced 2 reds. That is also why it
looks "intermittent": it is not intermittent, it is **certain truncation plus an
indeterminate victim**.

**There are two problems here; do not fix only the visible one:**

1. The fixture's 3000 keys (whose stated purpose in the comment is "make the scan take
   several round trips, so cancellation has time to land") contradict the assertion "every
   leaf key at this level is listable".
2. The driver itself is the more interesting one: on hitting the ceiling, `sampleLevel`
   carries a `partial` count only on the prefixes **it has seen**, while the keys it **has
   not seen** are **silently absent** — the list looks complete. The `#more-prefixes` /
   `#more-keys` collapse nodes do not appear either, because what they judge is
   `heads.length > MAX_PREFIX_NODES`, not "the scan was truncated".

**Not changing it this round**: changing the fixture moves the assertion out of the way,
changing the driver changes product behaviour (it ought to speak up on truncation), and
both have to be decided first. Per CLAUDE.md, that decision is not for a review round to
take on its own.

> **2026-08-12 addendum: point 1 is decided, point 2 remains undecided.**
> The fixture drops to `BULK_KEYS = 1_500`, with a guard added that pins it below the
> sampling ceiling — the reasoning, the three routes rejected, and the inverse check are in
> [`2026-08-12-redis-namespace-sample-fixture.md`](2026-08-12-redis-namespace-sample-fixture.md).
> Point 2 (keys never seen are silently absent on hitting the ceiling) **has not been
> touched** and is still waiting for alignment; that document's §4 restates it verbatim.

---

## 4unvicies. Follow-up — §4duodevicies's item is fixed; the **shape** of the gap gets its own document

> 2026-08-11. What §4duodevicies fixed is the item "`expand_node` is still in `tools/list`
> after uninstalling neo4j". What remains is the shape: the gate for each of the three
> tables is written once each, at three different layers, while the three files' header
> comments read like the same mechanism — the next person adding a fourth kind of
> contribution (a package's own skill text, a context menu…) will copy whichever table is
> nearest, and which one that is is random.
>
> The treatment is in [`2026-08-11-package-contribution-roster.md`](2026-08-11-package-contribution-roster.md):
> the filtering collects into one factory, every kind of thing a package can contribute
> goes into one `Record<keyof InstalledPackages, …>` roster, and the guard runs a generic
> loop over the roster. **No behaviour in this document changes**: the three tables filter
> out exactly the same things, no more and no fewer.

---

## 4duovicies. Acceptance record — a full re-run, an independent re-verification of acceptance criterion 13, an attribution re-check of acceptance criterion 22

> 2026-08-11. This round changes no production code; it does three things: run the
> full set of criteria against **this tree**, verify acceptance criterion 13's three
> checks **once more, independently of `smoke-drivers.mjs`**, and re-check acceptance
> criterion 22's attribution against the current output. Why an independent
> re-verification: §4vicies(b)'s table was measured on a tree with concurrent
> conflicts in it, and a conclusion of "it was fixed elsewhere" cannot be taken for
> "it holds here too".

### (a) The full set of criteria, on this tree

| criterion | result |
|---|---|
| `pnpm typecheck` | all 7 projects green |
| `pnpm test` (including `check:vocabulary`) | `apps/desktop` **1838 pass / 0 fail / 287 suites**; 6 packages green, `db-redis` **36 pass / 1 fail** |
| `pnpm -r test` | as above (`pnpm test` is this plus one `check:vocabulary` step, differing only by `--no-bail`) |
| `pnpm build` | green, including `audit-package-boundary.mjs`, `audit-shipped-css.mjs`, `probe:render` (`all checks passed`) |
| `audit-package-boundary.mjs` run on its own | green: `main loads 2 file(s) / 322338 B and holds none of the 10 string(s) … the package host loads 1 file(s) / 25974 B …; 1 declared tool name(s) in 5 built manifest(s) and none in main` |
| `smoke-drivers.mjs` | see (d) |
| `probe:hardening` | **8/8 green** (`frame-first-load` / `frame-network` / `origin-isolation` / `permissions-request` / `permissions-check` / `permissions-observed` / `frame-navigation` / `window-navigation`) |

That red on `db-redis` is the pre-existing failure §4vicies(e) has on record
(`builds a namespace tree from key prefixes, lazily` — the fixture packs 3000
`bulk:*` keys into one level, colliding with `keyspace.ts`'s
`PREFIX_SAMPLE_KEYS = 2_000`). Untouched this round.

**The difference between 1838 and the 1808 recorded on §4sedecies's first line** is
the guards added over the intervening rounds (§4septdecies, §4duodevicies,
§4undevicies, plus the package-contribution roster and `createPackageAdmin`
documents) — not anything added this round.

### (b) Acceptance criterion 13: an independent re-verification, all three checks run by hand

A one-off script (deleted after the run — it is a measurement, not a guard) that
**reuses none of `smoke-drivers.mjs`'s assertions**, only its way of starting up (the
same `out/` output, its own `PEEK_CONFIG_DIR` / `--user-data-dir` / MCP port).
Session A establishes its handshake **before** the install, so every later difference
in what it answers is "the same session answering differently" rather than a fresh
handshake.

```
PASS  before the install, session A has no echo_ping
PASS  after the install, session A has echo_ping
PASS  after the install, a fresh session has echo_ping
PASS  (1) same session: echo_ping is gone after the uninstall — 14 tools
PASS  (2) new session: echo_ping is gone after the uninstall — 14 tools
PASS  (2b) calling the removed tool is refused — {"isError":true,"…":"MCP error -32602: Tool echo_ping not found"}
PASS  (3) after a restart on the same config dir: echo_ping is gone — 14 tools
```

The "restart" in the third case really kills the process and starts a new Electron on
the same `PEEK_CONFIG_DIR`, waiting for the new `mcp.json` to be written (comparing
URLs, to keep from reading the old one) before the handshake.

**Both sides of this run are in the same block of output**: absent before the
install, present after it, absent all three ways after the uninstall. So it is not a
vacuously true script — a check that can only answer "absent" goes red on lines 2
and 3.

§4vicies(b)'s table holds **on this tree**.

### (c) Acceptance criterion 22: an attribution re-check on the +37 kB, plus something measured along the way

The current working tree's `out/renderer/assets/index-*.js` = **671,927 B**
(§4vicies(d) recorded 671,496 B; the +431 B is the handful of bytes two intervening
documents' changes landed in the window). The breakdown of the 597,160 B baseline (of
which 35,674 B was committed before packaging started) is unchanged, see §4vicies(d);
this round did not re-run those three `git worktree` builds.

What this round does is re-run the sourcemap attribution **against the current
output** (`electron-vite build --sourcemap`, decoding the mappings' VLQ segment by
segment, charging the generated bytes between one segment and the next to that
segment's source):

```
attributed 659010 B of 659179 B across 208 source(s)
  180904 dep:react-dom
  109839 dep:zod          ← §4vicies(d) measured 109776
   22319 dep:@tanstack/virtual-core
   12981 dep:immer
```

The largest blocks inside zod line up with §4vicies(d) to the character:
`classic/from-json-schema.js` is still **7,914 B**, and
`core/json-schema-processors.js` at 8,145 B and `core/to-json-schema.js` at 5,919 B
are both there too. **The conclusion does not change, the attribution does not
change, and this round still does not change it** — the fix (splitting up
`packages/core`'s barrel export, or marking it `sideEffects`) touches the resolution
path of 109 imports, which is worth its own document.

One thing measured along the way happens to be the first evidence for the
package-contribution roster document's decision to keep the files separate:

```
     402 src/drivers/manifests.ts
     354 src/drivers/installed.ts
     233 src/drivers/contribution.ts
     194 src/drivers/viewKinds.ts
```

`src/drivers/contributions.ts` (the roster) and `src/drivers/mcpTools.ts` are **both
absent from the window's chunk**. The roster imports `mcpTools.ts`, and merging the
two files would drag `@peek/db-neo4j/mcp-tool-meta` in via `viewKinds.ts` →
`register.ts` — that document wrote down this reason, and here is its measurement.
Also, of the six driver manifests only `db-neo4j/src/manifest.ts`'s **44 B** is left,
the other five at zero, consistent with the −9,824 B §4vicies(d) recorded.

### (d) `smoke-drivers.mjs`: four runs give **0 / 1 / 0 / 0**, and §4sedecies's third-line flake reproduced

Only the `echo` row has an environment this round (no live server for the rest). Four
consecutive runs, exit codes **0, 1, 0, 0** — three `1/1`, one `0/1`. Each of the
three green runs went the whole way:

```
smoke: installed 'echo' at runtime; … tools/list gained echo_ping
  PASS echo      1 node(s); scanned "rows" → 2 row(s) (done); …
smoke: uninstalled 'echo' at runtime; 1 connection(s) closed, …, tools/list dropped echo_ping
smoke: the connect dialog outlived its own drivers — opened on neo4j → postgres → qdrant → redis → mysql, …
```

The red one is the **first** of the flakes recorded on §4sedecies's third line, word
for word:

```
smoke: aborted — the settings table groups its rows as [] but the packages are
[neo4j, postgres, qdrant, redis, mysql+sqlite] — uninstall is per package, so a
row group that is not a package puts a button next to the wrong set of databases
```

`packagesPanel(cdp)` reads before the settings panel has finished rendering, and
groups reads as `[]`. It blew up before `echo` was installed, so that run never
reached the tool-list lines at all — **this is not a criterion about packages going
red, it is the harness's own timing**. The second flake
(`checkDialogOutlivesItsDrivers` hanging with `unsettled top-level await`, exit code
13) did not appear in this round's four runs.

**This flake is the cost of using smoke as a criterion at all**: it is what
§4vicies(c) called "the only thing currently guarding that stretch of wiring in
main", and a criterion that aborts on its own timing 25% of the time is the first
thing anyone puts a retry around in CI — after which it guards nothing at all. The
fix is to make `packagesPanel` wait until the panel has actually rendered (`waitFor`
rather than a single read), which is out of scope this round. §4sedecies's third-line
⚠️ stays, and this round upgrades it from "observed last round" to "independently
reproduced this round".

### (e) Still owing, untouched this round

1. ~~**Acceptance criterion 21** — the script `bench-package-frame.mjs` does not
   exist, and `bench-scroll.mjs` was not run this round either. ⬜ unchanged.~~
   **Settled (2026-08-12), see §4septemvicies(a)(c).**
2. **The fix for acceptance criterion 22** — the attribution is nailed down, the leak
   is not fixed. See (c).
3. **`db-redis`'s `PREFIX_SAMPLE_KEYS`** — ~~§4vicies(e)'s two open questions are
   undecided.~~
   **The red half is settled (2026-08-12)**, the second question is still undecided,
   see §4septemvicies(e) item 2.
4. **`smoke-drivers.mjs`'s `packagesPanel` timing** — see (d), reproduced this round
   (1 run in 4), not fixed. It is the criterion that is "the only thing guarding that
   stretch of wiring in main", so this item matters more than it looks.
5. **Acceptance criterion 15's "actually install a `.app` upgrade once"** — still only
   unit tests, no manual test.

## 4tervicies. Acceptance record — another full re-run, a third independent re-verification of acceptance criterion 13, acceptance criterion 22 done as a source-level comparison for the first time

> 2026-08-11. This round likewise changes no production code. Three things: run the
> full set of criteria against **this tree** again, run acceptance criterion 13's
> three checks independently for the **third** time (reusing none of
> `smoke-drivers.mjs`'s assertions), and move acceptance criterion 22 from "attribute
> the current output" to "**compare against the baseline at source level**" — the
> first two rounds measured "whose is this 671,927 B", and this round measures "whose
> is every unit of the growth from the baseline's 597,160 B to now".

### (a) The full set of criteria, on this tree

| criterion | result |
|---|---|
| `pnpm typecheck` | all 7 projects green |
| `pnpm test` (including `check:vocabulary`) | `apps/desktop` **1838 pass / 0 fail / 287 suites**; `core` 151/151, `db-neo4j` 71 pass + 12 skipped / 0 fail, `db-qdrant` 38/38, `db-postgres` 60/60, `db-sql` 83/83; `db-redis` **36 pass / 1 fail** |
| `pnpm -r test` | as above, `Summary: 1 fails, 6 passes` |
| `pnpm build` | green, including `audit-package-boundary.mjs`, `audit-shipped-css.mjs`, `probe:render` (`all checks passed`) |
| `audit-package-boundary.mjs` run on its own | green: `main loads 2 file(s) / 322352 B and holds none of the 10 string(s) …; the package host loads 1 file(s) / 25974 B …; 1 declared tool name(s) in 5 built manifest(s) and none in main` |
| `smoke-drivers.mjs` | **five runs all green**, see (d) |
| `probe:hardening` | **8/8 green**, exit code 0 |

The main cell goes 322338 → **322352 B** (+14 B), the renderer's `index-*.js` is
**byte-identical to the 671,927 B** §4duovicies recorded, and the rest is unchanged.
That red on `db-redis` is still the `redis.test.ts:236` §4vicies(e) has on record
(`undefined !== 'key'`, the fixture packs 3000 `bulk:*` keys into one level, colliding
with `keyspace.ts`'s `PREFIX_SAMPLE_KEYS = 2_000`). Untouched this round.

### (b) Acceptance criterion 13: a third independent re-verification, all 7 lines green

Again a one-off script (`scripts/tmp-acceptance-13.mjs`, deleted after the run — it is
a measurement, not a guard) that reuses only `smoke-drivers.mjs`'s way of starting up
(the same `out/` output, its own `PEEK_CONFIG_DIR` / `--user-data-dir` / MCP port),
and not one of its assertions. Session A establishes its handshake **before** the
install.

```
PASS  before the install, session A has no echo_ping — 14 tools
PASS  after the install, session A has echo_ping — 15 tools
PASS  after the install, a fresh session has echo_ping — 15 tools
PASS  (1) same session: echo_ping is gone after the uninstall — 14 tools
PASS  (2) new session: echo_ping is gone after the uninstall — 14 tools
PASS  (2b) calling the removed tool is refused — {"content":[{"type":"text","text":"MCP error -32602: Tool echo_ping not found"}],"isError":true}
PASS  (3) after a restart on the same config dir: echo_ping is gone — 14 tools
```

Three consecutive runs, exit code **0** on the last. The "restart" in the third case
really kills the process and starts a new Electron on the same `PEEK_CONFIG_DIR`,
waiting for the new `mcp.json` to be written (comparing URLs, to keep from reading the
old one) before the handshake. **Both sides are in the same block of output**: absent
before the install, present after it, absent all three ways after the uninstall — a
script that can only answer "absent" goes red on lines 2 and 3, so it is not
vacuously true.

### (c) Acceptance criterion 22: done as a source-level comparison for the first time — three builds, two diffs

The first two rounds did "one sourcemap attribution of the current output". What this
round adds is the half it has been missing all along: **attribute the baseline too,
then subtract source by source**. Three builds, all
`electron-vite build --sourcemap` (the `.js` is 43 B larger than without a sourcemap —
that is the `//# sourceMappingURL=` line):

| tree | `index-*.js` | difference from the cell above |
|---|---|---|
| `6181bd2` (baseline) | **597,160 B** | — |
| `e3c36d7` (HEAD, **without** the packaging changes) | **632,834 B** | +35,674 |
| the current working tree | **671,927 B** | +39,093 |

Both cells **reproduce byte for byte** the numbers §4vicies(d) recorded. The total
account is +74,767 B.

**The second diff (`e3c36d7` → the current tree) is packaging's own bill**, and it is
what this round newly obtains:

```
total delta over reported buckets: 38379 B
   36670 73169 → 109839     dep:zod
    4403     0 → 4403       packages/core/src/package-manifest.ts
    3073  2043 → 5116       src/renderer/components/settings/PackagesSection.tsx
    2423     0 → 2423       src/renderer/packages/PackageFrame.tsx
    1680   509 → 2189       packages/core/src/manifest.ts
    1354  6752 → 8106       src/renderer/i18n/messages/en/settings.ts
     975     0 → 975        packages/db-neo4j/src/graph.ts
     926  4362 → 5288       src/renderer/i18n/messages/zh-CN/settings.ts
     733  3877 → 4610       src/renderer/components/ConnectDialog.tsx
     635     0 → 635        src/renderer/packages/register.ts
     630     0 → 630        src/renderer/packages/viewKinds.ts
     446     0 → 446        packages/db-neo4j/src/view.ts
     402     0 → 402        src/drivers/manifests.ts
    -417   417 → 0          src/renderer/<old-name>/register.ts
    -449   449 → 0          packages/driver-neo4j/src/view.ts
    -601   601 → 0          src/renderer/<old-name>/viewKinds.ts
    -986   986 → 0          packages/driver-neo4j/src/graph.ts
   -1290  1290 → 0          packages/driver-qdrant/src/manifest.ts
   -1759  1759 → 0          packages/driver-redis/src/manifest.ts
   -1838  1838 → 0          packages/driver-postgres/src/manifest.ts
   -2203  2203 → 0          packages/driver-neo4j/src/manifest.ts
   -2392  5382 → 2990       packages/core/src/capability.ts
   -2412  2412 → 0          src/renderer/<old-name>/<old-name>Frame.tsx
   -2734  2734 → 0          packages/driver-sql/src/manifest.ts
```

The terms first: the attribution script prints only buckets of ≥300 B, so this diff
totals **38,379 B**, 714 B less than the file's own **+39,093 B** — the gap is a pile
of small buckets each under 300 B plus the 169 B with no segment in the sourcemap,
**not attributed to a specific source, and so not written into the conclusion**.

Three things read out of it:

1. **The saving the criterion's text predicted did happen, and now it has line
   numbers**: five driver manifests go to zero,
   1290 + 1759 + 1838 + 2203 + 2734 = **9,824 B**, exactly the −9,824 B §4vicies(d)
   worked backwards from the total — this round it is no longer a remainder arrived at
   by subtraction, it is five lines. `capability.ts` saves another 2,392 B. The three
   pairs of `src/renderer/<old-name>/*` → `src/renderer/packages/*` are a rename,
   netting ±0 either way — the old name is the word §0.1 retired, which is why it is
   written `<old-name>` here, and it is exactly what `check:vocabulary` guards
   (acceptance criterion 27).
2. **zod alone eats 36,670 B**, 94% of packaging's 39,093 B. It drowns the 9,824 B
   saved, and the net result is "the places that should have shrunk did shrink, and
   the total still grew".
3. The remaining ten-odd thousand bytes are the window code packaging **is entitled
   to**: `package-manifest.ts`'s schemas, the install/uninstall block of the settings
   panel, two lines of empty-state copy, `PackageFrame`. This part is not a leak.

Breaking zod's 36,670 B down one more layer nails exactly the file §4vicies(d) named:

```
    8975 12671 → 21646      zod/v4/classic/schemas.js
    8892 23440 → 32332      zod/v4/core/schemas.js
    7914     0 → 7914       zod/v4/classic/from-json-schema.js   ← from nothing
    2956  5042 → 7998       zod/v4/core/api.js
    2791  5354 → 8145       zod/v4/core/json-schema-processors.js
    2346  2658 → 5004       zod/v4/core/regexes.js
    2280  6198 → 8478       zod/v4/core/checks.js
```

`from-json-schema.js` is the **only one that grows from 0**: `z.fromJSONSchema`, which
only main runs, is dragged into the window's chunk by `packages/core`'s barrel export.
The other six lines are consequences of the same thing — once the barrel is referenced
whole, tree shaking degrades from "the narrow slice" to "the whole of classic", and
the two `schemas.js` files come to 17,867 B between them. `core/to-json-schema.js` is
5,919 B on both sides, **unchanged**, so it is not in this account (it was in the
window already).

**The conclusion changed on 2026-08-12: it was changed.** See
`2026-08-12-main-only-parse-out-of-the-window.md` — neither splitting the barrel nor
marking `sideEffects`, but a third route (`export type *` plus one subpath export), so
the cost estimated in the sentence below never came due. The original is kept:

> the fix (splitting up `packages/core`'s barrel export, or marking it `sideEffects`)
> touches the resolution path of 109 imports, which is worth its own document. This
> round moves it from "attribution confirmed" to "baseline comparison confirmed, and
> the 9,824 B saved has line numbers".

Re-checking §4duovicies(c)'s evidence for keeping the files separate along the way,
the current output is identical to the character:

```
     402 src/drivers/manifests.ts
     354 src/drivers/installed.ts
     233 src/drivers/contribution.ts
     194 src/drivers/viewKinds.ts
```

`src/drivers/contributions.ts` (the roster) and `src/drivers/mcpTools.ts` are still
**both absent from the window's chunk**.

### (d) `smoke-drivers.mjs`: five runs all green, and §4sedecies's third-line flake did not appear this round

Five consecutive runs, exit codes **0 / 0 / 0 / 0 / 0** (the fifth had its exit code
measured separately by redirecting to a file; the first four were read off the
`smoke: 1/1 driver(s) connected and introspected` line). Each went the whole way,
including the three tool-list lines:

```
smoke: 14 tools exposed — activate_view, …, expand_node
smoke: installed 'echo' at runtime; … tools/list gained echo_ping
smoke: uninstalled 'echo' at runtime; 1 connection(s) closed, …, tools/list dropped echo_ping
smoke: the connect dialog outlived its own drivers — opened on neo4j → postgres → qdrant → redis → mysql, window still standing
```

The one that went red once in four in §4duovicies(d) (`packagesPanel(cdp)` reading
before the settings panel has finished rendering, groups reading as `[]`) **did not
appear once in this round's five**. This is not it being fixed — nobody touched it,
and `packagesPanel` is still a single read rather than a `waitFor`. **§4sedecies's
third-line ⚠️ stays**: a timing race not hit in five runs only says this machine ran
fast this round, not that it is gone.

### (e) Still owing

**Decisions not made (we know what has to be decided, it is not decided)**

1. **The fix for acceptance criterion 22** — the attribution is now nailed to the
   line, the leak is not fixed. Split the barrel export or mark `sideEffects`:
   undecided. See (c).
2. **`db-redis`'s `PREFIX_SAMPLE_KEYS`** — ~~§4vicies(e)'s two open questions are
   still undecided, so that red on `redis.test.ts:236` is still there too.~~
   **The red half is settled (2026-08-12)**: the fixture was cut down to within one
   sampling, `db-redis` 38/38, see
   [`2026-08-12-redis-namespace-sample-fixture.md`](2026-08-12-redis-namespace-sample-fixture.md).
   **The second question (silently absent on truncation) is still undecided**, see
   §4septemvicies(e) item 2.
3. ~~**Acceptance criterion 21** — the `bench-package-frame.mjs` in the criterion's
   text does not exist. Add the script or change the text: undecided.~~
   **Decided (2026-08-12): change the text**, see §4septemvicies(a).

**Work not finished (the decision is already made, it just has not been done)**

4. ~~**`smoke-drivers.mjs`'s `packagesPanel` timing** — the fix was written down long
   ago (`waitFor` rather than a single read), not done. It did not reproduce in this
   round's five runs; (d) says why that does not count as it being well.~~
   **Settled (2026-08-12)**: both flakes were fixed together, see §4quinvicies.
5. ~~**Acceptance criterion 21's `bench-scroll.mjs`** — the script is there, it was not
   run this round.~~
   **Settled (2026-08-12)**: see §4septemvicies(c) — two rounds produced numbers, and
   the third hit an environmental condition that would otherwise have let it hang
   silently.
6. **Acceptance criterion 15's "actually install a `.app` upgrade once"** — still only
   unit tests, no manual test.

## 4quinvicies. Implementation record — smoke's two flaky spots are fixed (§4tervicies(e) item 4 settled)

§4duovicies(d) recorded two: `packagesPanel(cdp)` reads before the panel has answered
and groups comes back `[]`; and the last step occasionally hangs, with Node reporting an
unsettled top-level await and exit code 13. Neither is a criterion about packages going
red — it is the harness's own timing — and "a criterion that aborts because of its own
timing" is exactly the thing those two sections say over and over: someone adds a retry
to it and then it guards nothing at all. This round fixes both together.

Two files changed: `apps/desktop/scripts/smoke-drivers.mjs`, `apps/desktop/scripts/cdp.mjs`.
No production code was touched.

### (a) The first one's root cause: `<thead>` is synchronous, the rows are one IPC round-trip later

`PackagesSection`'s `packages` starts as `null`; the `<table>`, `<thead>` and all, is in
the DOM the moment the section mounts, and the rows only arrive once
`dispatch('packages.read')` comes back. The old `packagesPanel` read once, two frames
later: `document.querySelector('[role="tabpanel"] table')` hits (the table is there),
`table.tBodies[0].rows` is empty, so `groups` is `[]`, and `panelGroupsArePackages`
compares that against `packages.read` — red.

**The first run of this round reproduced it word for word** (working tree unmodified,
`out/` from the 8-11 build):

```
smoke: aborted — the settings table groups its rows as [] but the packages are
[neo4j, postgres, qdrant, redis, mysql+sqlite] — …
```

### (b) The first one's fix: read once → wait until it answers

`packagesPanel` splits into three pieces: `openPackagesPanel` (send `⌘,`, find the
section by who draws the table), `readPackagesPanel` (one read), and a `waitFor`-shaped
loop around them, `PANEL_TIMEOUT_MS` 10 seconds, one round every 100ms.
`waitForFirstPaint` is exactly this shape. Three things worth writing down:

1. **What is waited for is readiness, not an assertion.** The default `until` only asks
   whether the table has answered (there are rows); what it answered is still each
   site's own assertion. The one exception is item 2.
2. **The read after an install that does not reopen the panel is waiting on its own
   assertion.** What it proves is that the window re-asks `packages.read` once the
   registry has moved — and whether it re-asks is an eventually proposition: broadcast
   plus re-read is two hops, and the old code nailed it to the two frames after the
   install, which is asserting a schedule nobody ever promised. So that assertion
   changes from "true immediately" to "true within 10 seconds", and the timeout message
   carries both the original sentence and what the panel currently lists. **This is the
   only assertion rewritten this round**, and (d) has its inverse check.
3. **A wrong cell count is not retried.** React commits a row whole, so a cell count
   other than 5 or 3 is a verdict on the table rather than half a frame; it goes down a
   separate `malformed` channel and throws immediately.

### (c) The second one's root cause: the socket is gone and the in-flight `await` never lands

`Cdp.send` records the resolve/reject into `#pending`, and only a message event takes it
back out. The moment the socket closes, nothing ever touches that promise again. And
smoke fits the app with a 120-second deadman (`PEEK_SMOKE_EXIT_MS`): as soon as the
harness is stuck on some evaluate for 120 seconds, the app exits on its own, the socket
closes with it, the event loop drains, and Node prints an unsettled top-level await and
exit code 13 — without a word about where it was stuck. `checkDialogOutlivesItsDrivers`
runs last, so it is always the one that hits it.

One source of the hang was found too: the window does not set
`backgroundThrottling: false`, so when it is occluded or minimised
`requestAnimationFrame` is throttled or stopped outright — and every DOM read in the
harness starts with a two-frame `settle()`. Three fixes:

- `Cdp` rejects every in-flight request on the `close` event and remembers the reason;
  later `send`s reject straight away;
- `Cdp.send` gains a Node-side 150-second reply deadline (longer than
  `Runtime.evaluate`'s own 120 seconds, because it guards something else: that one
  covers "the script ran too long", this one covers "the reply never comes at all").
  The timer deliberately does not `unref` — unref'd, the process would exit before it
  fires, which is precisely the silence it exists to break;
- the page-side `settle()` is unified into `SETTLE_FN`: two frames `race`d against a
  200ms timer. A commit does not need a frame to happen, only a frame to be painted.

### (d) Inverse checks — four guards, each broken, watched go red, restored

| guard | how it was broken | result |
|---|---|---|
| the panel wait's timeout path | default `until` changed to `groups.length > 99` | exit code 1, `waited 10000ms for the settings panel to fill in its package table; it lists [neo4j, postgres, qdrant, redis, mysql+sqlite]`, red after 10 seconds |
| the rewritten assertion ((b) item 2) | **change production code**: `PackagesSection`'s `useEffect` dependency from `[revision]` to `[]` (the "only re-read on mount" defect), rebuild | exit code 1, `waited 10000ms for the open settings panel to list 'echo' — … so a row that never arrives is an uninstall button next to a stale list; it lists [neo4j, …]`. **The rewritten assertion still catches the very defect it was written for**, and its message says one thing more than the original did (what the panel currently lists). Change back, rebuild, green again |
| the `malformed` channel throws immediately | `cells.length === 5` in the read changed to `=== 4` | exit code 1, red within 2 seconds: `row for neo4j has 5 cells; expected 5 …` — not a full 10-second wait, proving it was not treated as "wait a moment and it will be fine" |
| reject in-flight requests when the socket closes | `APP_LIFETIME_MS` from 120_000 down to 900, so the app kills itself halfway through | **before the fix** (the copy with the close listener and the deadline both removed): exit code **13**, a single `^` in the output and not one word. **After the fix**: exit code 1, `FAIL echo-uninstall the CDP connection closed — the app most likely exited` / `FAIL dialog-outlives Runtime.evaluate: the CDP connection closed — …` |
| `send`'s reply deadline | deadline changed to 1ms | exit code 1, `Runtime.evaluate got no reply in 1ms` |
| `settle()`'s timer fallback | forward: replace the rAF half with a promise that never resolves (what an occluded window looks like) | exit code 0, all green — the timer carried every `settle()` on its own |
| same | inverse: remove the timer as well (`settle` never resolves), deadline temporarily set to 5 seconds | exit code 1, `Runtime.evaluate got no reply in 5000ms` — which is exactly why the fallback exists |

### (e) Eight runs back to back

`node scripts/smoke-drivers.mjs`, exit codes **0 0 0 0 0 0 0 0**, all eight going the
whole way (all four lines present: `installed 'echo'` / `PASS echo` / `uninstalled 'echo'` /
`the connect dialog outlived its own drivers`). About 2 seconds a run.

### (f) One thing to say clearly: after the fix, that race is no longer measurable on this machine

After the fix the old read-once shape was run 8 more times, **all 8 green** — that is,
since the red at the start of this round, this machine has not hit it again on its own.
Instrumented, the margin measures: on the reopen-the-panel path, from sending `⌘,` to
reading rows is 73–86ms; on the no-reopen path 16–17ms, `reads=1`, and eight fully
loaded spinning processes make no difference either way.

So **do not read "8 green runs" as "the race never existed"**: the margin is tens of
milliseconds, and a cold cache, another build running, or the window happening to be
occluded can each eat it — the red at the start of this round is one that did. What this
change bought is not a bigger margin, it is that **when the margin is gone it costs
100ms to read again instead of aborting the whole smoke run**.

## 4sexvicies. Implementation record — three on the install path: swapping files without swapping the process, a bundled-package restore colliding, and a failed restore nobody sees

Caught by the pre-delivery self-check, all of them on **the commands that write to
disk**, and all failing the same way: the receipt says it succeeded, it did not, and not
one word is said about it.

### (a) Swapping files without swapping the process — `packages.install` is missing a kill

§2.4bis(f)'s line "kill it and it is really gone" was originally written only under
uninstall (§2.7). It does not hold on the install path: the package host starts
**lazily**, forked at the first tool call or the first package view opened, and once it
has `import()`ed `contrib.mjs` it goes on answering from the copy in memory. So an
install that only swaps the directory moves the version number in **every place it is
reported** — the settings panel, `packages.read`, `tools/list` — and in **no place it is
computed**, until the app restarts or that package is uninstalled, without a word in
between.

The easiest one to hit is the `升级` button in settings (`packages.install {bundledId}`):
before pressing it you have most likely just looked at that package's view, so that host
is alive.

The fix is the other side of the same rule as uninstall, `manage.ts`'s
`InstallRequest.evict`:

- **the kill goes after the last check that can refuse and before the first write to
  disk**. Putting it after the copy only narrows the window instead of closing it, and
  it leaves the old process answering against a directory that has already been swapped;
  putting it before the checks means a refused install has killed a host that was in use
  for nothing.
- it uses **the id in the manifest**, not the source directory name: install
  `echo-1.0.0/` and what gets killed is `echo`.
- **kill unconditionally**, without looking at `replaced`: a host can outlive the
  directory it was forked from (a package deleted by hand, an install that died on the
  rename last time), and re-forking a process that was not running anyway costs nothing.

`disposeHost` is a second parameter rather than a field on `PackageCommandOptions`, for
the same reason the 2026-08-11 document gave for `createPackageAdmin`: `options` is the
assembly shared by all four verbs, and only two of them kill a process. main hands the
same wrapper to both sides.

### (b) "Restore bundled packages" can silently restore nothing

Two spots, both on the restore path, and together they make one complete false success:

1. `bundled.ts`'s `layOutOne` only asks whether it is there and whether there is a
   tombstone; **it never asks whether what it is about to lay out collides with what is
   already installed**. Rule 1 asks whether the *id* is free, and **free is not the same
   as unclaimed**: a user can install a package under a different directory name that
   declares the same `driverId`. The install path (`installPackage`) has always checked;
   this bundled path did not — and decision 1 says a bundled package is just an ordinary
   package, and "refused for the reasons an ordinary package would be refused" is exactly
   what that sentence means. The fix is to call the loader's own `inspectPackageDir`
   inside `copyIn`, **before the copy**, the same call `installPackage` makes. Finding
   out after the copy leaves behind a directory nobody can load, while the receipt counts
   it into `restored`.
2. `commands.ts`'s restore only calls `adopt(after)` and **not `packageLoadNotices`**, so
   `after.refused` is thrown away. (1) cannot fix this one: `layOutOne` compares against
   what was installed **at the start of this pass**, so two bundled packages laid out in
   the same pass colliding with each other is visible only to the scan afterwards —
   directory-name order decides who wins, the loser is refused, and the receipt writes
   both into `restored`. §4.2 item 10 does not allow it to be silent; the fix is for
   restore to go through `noticesFor` too (the install path has done so all along).

### (c) A third one found along the way: a failed restore does not even compile

`restoreBundledPackages`'s `RestoreOutcome` gained `{ok: false, issue}` last round
(`~/.peek/packages` is a regular file, or peek was started once under `sudo`),
`commands.ts` did not follow, and `pnpm -r typecheck` shows 4 TS2339s. The fix is to
read out the sentence that has already been written:
`if (!outcome.ok) fail('INTERNAL', outcome.issue)`, **before the re-scan** — not one
package was laid out, the registry cannot have moved, and the sentence
`restoreBundledPackages` wrote is all there is to say. It must not degrade into
`{restored: []}`: that is byte-identical to "nothing was missing in the first place", and
the two sentences mean opposite things — the comment on `unavailablePackageHandlers`
already nails this down.

### (d) Inverse checks — five guards, each broken, watched go red, restored

| what it guards | how it was broken | what red looks like |
|---|---|---|
| an install must kill the host | comment out `await request.evict(id)` in `manage.ts` | `✖ installs this build's own copy over the installed one — the upgrade button's path`, `h.disposed` actual `[]`, expected `['alpha']`; 6 red along with it |
| the kill comes after the checks | add `await request.evict(inspected.id)` on the branch where `inspectPackageDir` refuses | `✖ a driver another package already provides is refused, and that package is untouched`, `h.disposed` actual `['intruder']`, expected `[]` |
| a bundled package must be checked for collisions before it is laid out | `copyIn`'s `if (!inspected.ok)` changed to `if (false && …)` | `✖ a shipped copy whose driver an installed package already claims is refused, not copied` — `postgres: no detail`, actual `laid-out`, expected `failed` |
| a refusal during restore must be said out loud | comment out the `noticesFor(after, …)` line in restore | `✖ a package the re-scan then refused is said out loud…` — `nothing was said about 'beta'; got no notices` |
| a failed restore must report itself | `if (!outcome.ok) fail(…)` changed to `if (false && …)` | `✖ a packages directory peek cannot use fails the press…` — what comes back is `outcome.restored is not iterable`, not the sentence that names the directory |

Rows two and five deserve their own note. With row two broken, **every assertion about
disk is green** — `intruder`'s directory really is not written, `echo` really is still in
the registry — and the only red is `h.disposed`: half of "that package was untouched"
lives in the process, where disk cannot see it. With row five broken the command **still
fails**, it just fails as `outcome.restored is not iterable`; what this guard buys is not
whether it fails but whether the sentence it fails with carries the path the user can go
fix.

### (e) Test shape: the harness records it, but nobody reads it

`hot-reload.test.ts`'s harness has always had two recorders, `disposed` and
`killedWhileOnDisk`; the uninstall case asserts `h.disposed === ['echo']`, and **the two
install cases say not one word about it**. The four assertions added this round pin down
four different things, not the same sentence copied four times:

- a first install (the id was not there): `['echo']` + `killedWhileOnDisk === [false]` —
  **kill unconditionally**, and kill before the directory appears;
- installing onto the same id: `['echo']` + `[true]` — using the manifest's id (the
  source directory is called `echo-next`), and killing while the old directory is still
  there;
- a `{bundledId}` upgrade: `['alpha']` + `[true]` — that button in settings;
- a refused install: `[]` — no process pays for an install that never happened.

The harness gets one more shape correction: `disposeHost` is now **one function handed to
both sides** (`createPackageAdmin` and `createPackageHandlers`), the same as
`main/index.ts`. Two recorders would wire the install path to something the real wiring
never passes it, and the wiring is exactly what this file tests.

### (f) Acceptance

`pnpm -r typecheck` all green (at the start of this round desktop had 4 red, see (c));
`pnpm test` exit code 0, desktop **1842** cases all passing, of which
`src/main/packages/__tests__/` is 129 (+3 this round: 1 bundled-package collision, 1 for
a refusal during restore being said out loud, 1 for a failed restore reporting itself;
plus 4 assertions added into existing cases).

## 4septemvicies. Acceptance record — a full pre-delivery re-run, acceptance 21 with real numbers for the first time, and a section number that does not exist

> 2026-08-12, the last round before delivery. Three things: taking over four references
> that point at a **section that does not exist**; turning acceptance 21 from "not run"
> into numbers; and re-running against the current tree the whole set of §4 criteria that
> can be run.

### (a) §4quatervicies is a dangling reference, and this section takes it over

The body names §4quatervicies in four places — §4.5 clause 21 (twice), §4sedecies(f)
item 6, §4duovicies(e) item 1, §4tervicies(e) items 3 and 5 — while the sections
themselves jump straight from §4tervicies to §4quinvicies with nothing in between. This
document was edited concurrently by several sessions between 8-11 and 8-12 (§4quinvicies
and §4sexvicies each recorded the same thing: the file was changed by another process
while being edited), and the cheapest explanation is that the section's body was
overwritten by one of those concurrent writes.

**What was not overwritten is its product**: §4.5 clause 21 itself has already been
changed down the "change the clause" path — the name `bench-package-frame.mjs` is deleted
from the clause, and both the reason for deleting it (the criterion was lost while
copying the name) and the gap it leaves (no benchmark today measures a Tier C view's
one-time load cost) are written into the clause, standing on their own, readable, and not
depending on that section existing.

So this section **does not rebuild** that one, and **does not restate the three
`bench-scroll` rounds it claims to have run** — I do not have those three rounds' output,
and copying a number I did not measure myself into the acceptance table is precisely what
the opening of this whole table says must not be done. The disposition: **the decision
stays in the clause as written** (that is what carries the decision), **the numbers are
re-run against the current tree in (c) below**, and the four references are repointed at
this section. The number §4quatervicies stays empty from here on; an empty number is more
honest than one that points nowhere.

### (b) The full re-run — seven things, all green

The same tree, the same build output, in order:

| what was run | result |
|---|---|
| `pnpm typecheck` | 7 / 7 projects green. (The 4 `TS2339`s from §4sexvicies(c) were fixed last round, so this round was green from the start.) |
| `pnpm test` (including `check:vocabulary`, i.e. `pnpm -r test`) | exit code 0. `core` 151, `db-neo4j` 71 + 12 skipped, `db-redis` **38**, `db-qdrant` 38, `db-postgres` 60, `db-sql` 83, `apps/desktop` **1842 / 287 suites**. **0 fail across all seven projects** — `db-redis`'s long-standing red is gone this round, see (d). |
| `pnpm build` | green, including `audit-package-boundary.mjs`, `audit-shipped-css.mjs`, `probe:render` (`all checks passed`). `out/renderer/assets/index-*.js` **671,927 B**, byte-identical to last round. |
| `audit-package-boundary.mjs` on its own | green: `main loads 2 file(s) / 324123 B and holds none of the 10 string(s) …; the package host loads 1 file(s) / 25974 B …; 1 declared tool name(s) in 5 built manifest(s) and none in main`. |
| `smoke-drivers.mjs` **8 runs back to back** | **0 0 0 0 0 0 0 0**, all four lines present in every one of the eight. |
| `probe-hardening.mjs` | 8 / 8 green (`frame-first-load`, `frame-network`, `origin-isolation`, `permissions-request`, `permissions-check`, `permissions-observed`, `frame-navigation`, `window-navigation`). A re-run only — the four inverse checks were not re-derived, so the corresponding rows are not upgraded. |
| `verify-fuses.mjs` | green. A fresh `pnpm package` first (the one in `release/` was from 8-11); all three fuses read back `DISABLE`, the packaged binary refuses `ELECTRON_RUN_AS_NODE=1`, and the unfused electron in `node_modules` runs as usual — the positive control is there, so the ambiguity where "it did not start" is taken for "the fuse took effect" is closed. |

### (c) Acceptance 21 — three criteria with numbers for the first time

`node scripts/bench-scroll.mjs`, the default 1 million rows / 600 frames, three rounds:

| round | dropped frames (criterion = 0) | frame work p95 (criterion ≤ 0.30ms) | `.grid-surface` elements (criterion 279–369) | `run_query` end to end |
|---|---|---|---|---|
| 1 | **0 / 600** | **0.20ms** (median 0.10 / p99 0.20 / max 1.50) | **279 – 369** | 2188ms |
| 2 | **0 / 600** | **0.20ms** (median 0.10 / p99 0.20 / max 0.90) | **279 – 369** | 2102ms |
| 3 | not measured, see (d) — the window was occluded and the script exited with the error from the newly added guard | | | |

The refresh period is 8.30ms (120Hz) in both rounds, matching the machine in PLAN §8.1;
the element count's lower and upper bounds are **literally equal** to the 279–369 the
baseline writes, and `run_query` 2188 / 2102ms against a baseline of 2124ms. **All three
criteria green, and not one number in PLAN §8.1's baseline moved.**

Zero change is what the clause expects (not a word of the data path changed), and these
two rounds are the first time "expect zero change" was measured rather than asserted. As
for the half of the clause it does **not** cover — a Tier C view's one-time load cost —
still no benchmark measures it; it stays recorded in the clause as written, and these two
green rounds do not make it covered too.

### (d) One fixed along the way: with the window occluded, `bench-scroll.mjs` hangs silently

**Actually hit at the start of the round**: on the first two runs the script printed the
fixture line and then produced no further output, the process at 0% CPU, hung for over 4
minutes. Reading in over CDP, the window had `document.hidden === true`,
`visibilityState === 'hidden'`, and `requestAnimationFrame` did not call back within 2
seconds — while the query had in fact finished long before (the page read
`1,000,000 rows · 2.11 s`).

The cause: macOS marks a fully covered window occluded, Electron marks the renderer
process invisible on that basis, and rAF stops entirely — while every `await` in
`scrollPassExpression` hangs on rAF. `Runtime.evaluate`'s `timeout: 120_000` does not
catch it (that covers script execution time, not a promise that never resolves), so the
pass waits all the way to the app's own 600-second deadline, **without a word about where
it was stuck**. This is the same kind of thing §4quinvicies(c) fixed for smoke.

One change only, in `apps/desktop/scripts/bench-scroll.mjs`: **before** entering the
sampling loop, put a wait ceiling of `RAF_STALL_MS = 5_000` on **the first frame**, and
on timeout return a sentence you can act on, carrying `document.visibilityState`. **Only
at the entrance, not on every frame** — once the loop is running, a long frame is a
dropped frame, which is the very number this script reports, and a ceiling per frame
would turn a finding into an error. Five seconds against an 8.3ms frame is three orders
of magnitude of margin; it can only mean "rAF is not running at all", never "this machine
is slow today".

Inverse checks (break it → watch it go red → restore; the script has been verified back
to its original by `shasum`):

| how it was broken | what red looks like |
|---|---|
| replace `nextFrame` with `() => new Promise(() => {})` (equivalent to "rAF never calls back") | exit code **1**, after about 5 seconds: `bench-scroll: the scroll pass failed: requestAnimationFrame did not fire in 5000ms; document.visibilityState is "visible". …` — before the change, the same condition hung silently to 600 seconds |
| no code changed at all; round 3 hit occlusion on its own | exit code **1**, the same sentence, `document.visibilityState is "hidden"` — this is a **natural reproduction**, and the reason this guard exists |

There is a forward check too: the two rounds in (c) ran after that same change, exit code
0 and every number inside the criteria — the guard does not block a healthy run.

### (e) Still owed

1. ~~**The fix for acceptance 22** — attribution is nailed to the line (zod alone
   36,670 B / 94%), the leak is not fixed; breaking up the barrel export versus marking
   `sideEffects` is still undecided. Three re-measured rounds and not a digit moved.~~
   **Settled 2026-08-12**, down a third path nobody had thought of at the time:
   [`2026-08-12-main-only-parse-out-of-the-window.md`](2026-08-12-main-only-parse-out-of-the-window.md).
2. ~~**`db-redis` silently absent when truncated** — the long-standing red is gone
   ((b) and row 2), but §4vicies(e)'s second problem (when sampling hits the ceiling, the
   UI does not say this level is truncated) is still undecided and stays as written in
   [`2026-08-12-redis-namespace-sample-fixture.md`](2026-08-12-redis-namespace-sample-fixture.md) §4.~~
   **Settled 2026-08-12**: [`2026-08-12-redis-truncated-namespace-level.md`](2026-08-12-redis-truncated-namespace-level.md).
3. **Acceptance 15's "really install a `.app` upgrade once"** — still only unit tests, no
   manual test.
4. **Acceptance 21's half-clause gap** — how many bytes opening a Tier C view reads, and
   from where, has no benchmark measuring it today.
   **Half the premise changed on 2026-08-12**: a fixed-size fixture now exists
   (`fixtures/packages/echo/ui/index.html`, 300 nodes / 300 edges, fixed seed, no clock
   and no randomness), and the blocker moved from "there is no fixture" to "making it
   openable means adding something to the window chunk, and §4.5 clause 21 itself writes
   that **it will not**". See §4duodetricies(e), **the user decides, and no production
   code was touched this round**.
   **Settled 2026-08-12**: the user decided the measure would be "the cost of opening
   once" (bytes + one-time milliseconds), the script is `scripts/bench-package-frame.mjs`,
   and production code is still untouched — the benchmark builds the iframe itself.
   Fourteen measured rounds, an inverse check for every guard, see
   [`2026-08-12-package-open-cost-benchmark.md`](2026-08-12-package-open-cost-benchmark.md).
   One number corrected along the way: the "600 attributes rewritten per frame" recorded
   above measures **1200** (300 nodes ×2 + 300 edges ×2), and is now accumulated by the
   fixture itself and reported by the benchmark divided by frame count, rather than being
   a constant in the prose.

## 4duodetricies. Acceptance record — the full re-run after three things landed, and the first time criterion 21 was not clean

> 2026-08-12. Three more things landed after the previous section's delivery (the
> window chunk's resolver, redis's truncation notice, a Tier C fixture at a fixed
> size); this section re-runs the whole runnable set of §4's criteria against **the
> same tree**, and disposes of the one criterion hit that criterion 21 produced this
> round.

### (a) The full set of criteria, current tree

| what was run | result |
|---|---|
| `pnpm typecheck` | **7 / 7** projects green. |
| `pnpm -r test` | **0 fail**. `core` 151 / 28 suites, `db-neo4j` 83 (71 pass + 12 skipped), `db-redis` **41**, `db-qdrant` 38, `db-postgres` 60, `db-sql` 83, `apps/desktop` **1845 / 288 suites**. **2301** in all. Against the previous round: `db-redis` 38 → 41 (three new for the truncation notice), `desktop` 1842 → 1845 (three for localised copy). |
| `pnpm build` | Green, including `audit-package-boundary.mjs`, `audit-shipped-css.mjs`, `probe:render` (`all checks passed`). `out/renderer/assets/`: `index-s2fQCmmf.js` **631,333 B**, `SqlEditor-BRRcUbDH.js` 434,951 B, `index-ClZgSLJk.css` 37,862 B. `out/main/index.js` 285,403 B, `out/main/chunks/package-host-Ccqps28C.js` 38,819 B, `out/main/driver-host.js` 12,044 B. |
| `check:vocabulary` (criterion 27) | **red first, then green** — see (d). **It is not in `pnpm -r test`**: the root `test` script is `check:vocabulary && pnpm -r test`, and running only the second half skips this guard. After the fix, `pnpm test` (the complete one) is green. |
| `audit-package-boundary.mjs` on its own | green: `main loads 2 file(s) / 324222 B and holds none of the 10 string(s) derived from 8 host-only module(s) in 5 package(s) (3 module(s) excused by main-may-reach.ts, 5 unsignable); the package host loads 1 file(s) / 21094 B …; 1 declared tool name(s) in 5 built manifest(s) and none in main`. |
| `audit-shipped-css.mjs` on its own | green: `448 class rules in 1 stylesheet(s), 37862 B — all worn (0 exempt, 7 blocklisted and confirmed unused); 74 colour values`. Byte for byte identical to the previous round. |
| `smoke-drivers.mjs` **five times in a row** | **0 0 0 0 0**, and not one of the four lines missing in any of the five (install / PASS / uninstall / the dialog outliving its own driver). |
| `probe-hardening.mjs` | **8 / 8** green. A re-run only; the inverse checks for each line were not re-derived, so it is not promoted. |
| `bench-scroll.mjs` **four rounds** | See (c) — **1 / 600 dropped in round 1, 0 / 600 in rounds 2 / 3 / 4**. |

`verify-fuses.mjs` **was not run** this round: it needs `pnpm package` to rebuild a
`.app` first, and not one byte of this round's changes (the window chunk, db-redis,
the fixture) landed on the packaging path, so the three `DISABLE`s read back last
round do not change because of it. **This is a judgement, not "it was run"**,
written down here so the next round does not misread that line.

### (b) Criterion 22: the first re-measurement after the fix, and how that baseline should be read

`index-s2fQCmmf.js` **631,333 B**, **byte for byte identical** to the round it
landed — this round's redis changes (an optional field on `capability.ts`, one
branch in `TreeView.tsx`, two pieces of copy) grew nothing back into the window.

This line has always used `6181bd2`'s **597,160 B** as its baseline, and the nominal
difference today is **+34,173 B**, which reads easily as "34 KB still owed". **It is
not owed by packaging**: `e3c36d7` (the HEAD before packaging began, carrying no
packaging change at all) already rebuilds to 632,834 B. **The cell to ask packaging
about is 631,333 − 632,834 = −1,501 B** — packaging, together with this fix, has net
narrowed the window chunk. The clause's prediction that "six manifests disappear"
(−9,824 B) was right all along, it was just buried under zod's 36,670 B from
2026-08-10 until yesterday.

### (c) Criterion 21: four rounds, and round one hit the criterion

`node scripts/bench-scroll.mjs`, 1,000,000 rows / 600 frames by default, four rounds
in a row:

| round | dropped frames (criterion = 0) | frame work p95 (criterion ≤ 0.30ms) | frame work max | frame interval max | `.grid-surface` (criterion 279–369) | `run_query` |
|---|---|---|---|---|---|---|
| 1 | **1 / 600** ⚠️ | 0.30ms | 1.00ms | **16.70ms** | 279 – 369 | 2163ms |
| 2 | 0 / 600 | 0.20ms | 0.60ms | 9.20ms | 279 – 369 | 2125ms |
| 3 | 0 / 600 | 0.20ms | 0.60ms | 9.40ms | 279 – 369 | 2162ms |
| 4 | 0 / 600 | 0.20ms | 0.80ms | 9.30ms | 279 – 369 | 2116ms |

The refresh period was 8.30ms (120Hz) in all four rounds, and the element count was
in all four **word for word** equal to the baseline's 279–369.

**What that frame in round 1 was**: a frame interval max of 16.70ms ≈ 8.30 × 2, i.e.
one missed vsync; and frame work max in that same round was only **1.00ms**, against
a dropped-frame threshold of 12.45ms. Which is to say that of those 16.7ms this
project's script and layout took at most 1.0ms, and the remaining 15.7ms happened
outside this code's budget. **The evidence points at the machine, not at the code** —
but the clause says "dropped frames > 0 falsifies it" and leaves no room for this, so
**this round records it honestly as a hit** rather than ruling it noise on its own.
Disposition in (e), item 3.

### (d) Criterion 27 is red this round — the new guard's own comment brought the old word back

`node scripts/check-package-vocabulary.mjs` exit code **1**:

```
1 leftover mention of the old word:

  apps/desktop/electron.vite.config.ts:347  // Rollup prefixes ids from <旧词>s ("\0commonjs-proxy:/abs/path"), so
```

(The old word in this quotation is written `<旧词>`, by the convention this document
uses outside §0.1. **Not typographic fussiness** — the first version copied it word
for word, whereupon this design document itself became the line the guard reported;
see §4undetricies(b). The guard scans the whole repository, and the docs are in it.)

That line is **the previous round's new guard `assertWindowHoldsNoMainOnlyCore`'s own
comment** (from `electron.vite.config.ts:313`). The fix is to reword that
half-sentence so it does not need the old word — what it is explaining is that "a
Rollup id is not necessarily a bare path", which has nothing to do with the old word:

```
// A Rollup id can arrive prefixed ("\0commonjs-proxy:/abs/path"), so
// the path is the last space-separated field, as above.
```

**The other road was not taken (adding an exemption to `ALLOWED`)**:
`check-package-vocabulary.mjs`'s `ALLOWED` already lists two entries for this file,
`rollup <旧词>` / `vite <旧词>`, and a third would give this guard one more hole, while
the old word here is not a third-party tool's proper name at all — it can simply not
be written. **Fixing the comment tightens; adding an exemption loosens.**

The inverse check does not have to be built: **this one reproduced naturally** — the
guard was red before the change, and what red looked like is copied word for word
above; after the change `EXIT=0`,
`[peek/vocabulary] the old word survives only where the design says it may.`

Re-running `pnpm build` after the fix, the three filenames and byte counts of
`index-s2fQCmmf.js` / `SqlEditor-BRRcUbDH.js` / `index-ClZgSLJk.css` are **word for
word the same** (631,333 / 434,951 / 37,862 B), and so are the three in `out/main` —
only a comment moved, the artefacts did not.

**Why the previous round did not catch it**: that round reported "all 2,301 of
`pnpm -r test` green", which was true, but `check:vocabulary` is not in
`pnpm -r test`. From now on, reporting acceptance means running the root `pnpm test`,
or listing this cell separately (this section's (a) already lists it separately).

### (e) Still owed / still to be decided

1. **Criterion 15's "actually install a `.app` upgrade once"** — still unit tests
   only, no manual test. (Owed across rounds, untouched.)
2. **Half of criterion 21's gap, and half of its premise has changed** — "first there
   has to be a Tier C fixture at a fixed size" now exists:
   `fixtures/packages/echo/ui/index.html` draws 300 nodes / 300 edges, the node count
   is that file's own constant, the layout uses integer arithmetic off a fixed seed,
   no `Math.random` and no clock read, and two generations are word for word
   identical; `state.spin` is the positive control (rewriting 600 attributes per
   frame, element count unchanged), used to prove the measuring apparatus can see a
   signal. **But making it openable would touch three pieces of product code that
   enter the window chunk** (`viewKinds.ts`'s `VIEW_KIND_CONTRACTS`, `uiEntries.ts`'s
   `PACKAGE_UI`, two `panel.ts` strings), and §4.5's clause 21 itself says word for
   word that this is **not taken**. **This round stops here, with zero product-code
   changes**, waiting for the user to pick among three roads: add it outright (about
   5 lines, about 60 B more in the window) / gate it on `import.meta.env.DEV` (zero
   shipped bytes, but the benchmark runs the production build in `out/`, and once
   gated that kind does not exist in the benchmark, so a separate `define` is needed)
   / touch no product code and have the fixture impersonate the `neo4j` package id
   (which is built on top of §2.5's "an installed copy is never replaced" collision
   rule; not recommended).

   And one premise that affects the decision, corrected in passing:
   `PackageViewKindName = string` (`packages/core/src/view-kinds.ts:49`) is **not a
   compile-time union type**, so this is not a type change. What is being argued is
   "should bytes that exist only for a fixture enter the shipped chunk", not the
   amount of work.
3. **Whether criterion 21's clause should leave room for noise** — "dropped frames > 0
   falsifies it" was hit once in four rounds by machine noise (see (c)). Two roads:
   **leave it as it stands** (re-run whenever it is hit, and let a person judge), or
   **add a corroborating condition** (dropped frames > 0 **and** frame work max above
   some fraction of the threshold before it counts as falsified — writing "whose time
   it was" into the criterion, rather than looking only at total duration). The latter
   is more accurate, but what it loosens is an existing assertion, and **by §0's rule
   that is not decided unilaterally**.

## 4undetricies. Acceptance record — the full re-run before delivery, the open-cost benchmark's first appearance in the acceptance table, and two environmental facts about bench-scroll

> 2026-08-12. Another pass over §4's runnable criteria against **the same tree**.
> This section has three new things: criterion 27 went red again and went red on this
> document itself, `bench-package-frame.mjs` enters the acceptance table for the first
> time as something that "produced numbers", and only three of ten attempts at
> `bench-scroll.mjs` handed over numbers.

### (a) The full set of criteria, current tree

| what was run | result |
|---|---|
| `pnpm typecheck` | **7 / 7** projects green. |
| `pnpm test` (**the complete one**, including `check:vocabulary`) | **red first, then green** — red at `check:vocabulary`, see (b). Green throughout after the fix. |
| `pnpm -r test` | **0 fail / nothing changed apart from what is skipped**: `core` 151, `db-neo4j` 83 (71 pass + 12 skipped), `db-redis` 41, `db-qdrant` 38, `db-postgres` 60, `db-sql` 83, `apps/desktop` **1845 / 288 suites**. **2301** in all, line by line the same as the previous round. |
| `pnpm build` | Green, including `audit-package-boundary.mjs`, `audit-shipped-css.mjs`, `probe:render` (`all checks passed`). `index-s2fQCmmf.js` **631,333 B**, `SqlEditor-BRRcUbDH.js` **434,951 B**, `index-ClZgSLJk.css` **37,862 B**; `out/main/index.js` **285,403 B**, `chunks/package-host-Ccqps28C.js` **38,819 B**, `driver-host.js` **12,044 B**. **The six numbers are byte for byte identical to the previous round** — this round moved documents only. |
| `audit-package-boundary.mjs` on its own | green, word for word the same as the previous round: `main loads 2 file(s) / 324222 B …; the package host loads 1 file(s) / 21094 B …; 1 declared tool name(s) in 5 built manifest(s) and none in main`. |
| `smoke-drivers.mjs` **five times in a row** | **0 0 0 0 0**, and not one of the four lines missing in any of the five. |
| `probe-hardening.mjs` | **8 / 8** green. A re-run only; the inverse checks for each line were not re-derived. |
| `bench-scroll.mjs` | **ten attempts, three of them data**, see (c). |
| `bench-package-frame.mjs` | **four rounds, all green**, see (d). |

`verify-fuses.mjs` **was not run** this round, for the same reason as the previous
one: it needs `pnpm package` to rebuild a `.app` first, and not one byte of this
round's changes (documents only) landed on the packaging path — the six artefact
numbers above being byte for byte unchanged is the evidence for that sentence.
**This is a judgement, not "it was run".**

### (b) Criterion 27 went red again — this time it is this document that is red

The first statement of `pnpm test`, `check:vocabulary`, exit code **1**, reporting
`docs/design/2026-08-07-database-packages-from-disk.md:4666`.

That line is **guard output copied word for word** inside §4duodetricies(d) — last
round, to keep "what red looked like" as evidence, the comment containing the old
word was pasted into the document as it stood. The guard scans the whole repository,
`docs/` is not in `SKIP_DIRS`, and so **the text recording that red became the reason
for the next one**.

The fix is of a kind with the previous round's: write the old word in the quotation
as `<旧词>` (the second half of this document's §4duodetricies(d) already did exactly
that; only that one line inside the code block was missed), and say plainly next to
it why it is not word for word. **The road of "opening an exemption for docs in
`ALLOWED`" was not taken** — that would blind the guard to the whole of `docs/`,
while the old word here is not a third-party proper name and can simply not be
written. **Fixing the quotation tightens; adding an exemption loosens.**

The inverse check need not be built, **this one reproduced naturally again**: exit
code 1 before the change, with a file and line number reported; after it, `EXIT=0`,
`[peek/vocabulary] the old word survives only where the design says it may.`

**This is the second time this line has proved the same thing**: `check:vocabulary`
is not in `pnpm -r test`, and running only the second half skips it. Last round wrote
that sentence into criterion 27; had this round likewise run only the second half,
this red would have been missed just the same.

### (c) `bench-scroll.mjs`: ten attempts, three of them data

**Three clean rounds, every criterion green** (not one word of the criteria was
loosened):

| | dropped frames | frame work median / p95 / max | frame interval median / p95 | `.grid-surface` | `run_query` |
|---|---|---|---|---|---|
| round 1 | **0 / 600** | 0.10 / **0.20** / 0.50ms | 8.30 / 8.80ms | 279–369 | 2169ms |
| round 2 | **0 / 600** | 0.10 / **0.20** / 1.00ms | 8.30 / 9.20ms | 279–369 | 2101ms |
| round 3 | **0 / 600** | 0.10 / **0.20** / 0.30ms | 8.30 / 8.90ms | 279–369 | 2147ms |

The previous round's **1 / 600** did not recur this round. **But three rounds are not
enough to say it is gone** — it appeared once in four rounds last round and did not
appear in three rounds this round, and those two facts do not contradict each other.
§4duodetricies(e) item 3 (whether the criterion should leave room for noise) is
**still undecided, and this round did not dispose of it unilaterally**.

**The other seven were not data; they fall in two classes, and both have to be
recorded honestly**:

1. **Five stopped on the occlusion guard** — `requestAnimationFrame did not fire in
   5000ms; document.visibilityState is "hidden"`, exit code **1**. The guard works as
   designed: it turns a silent hang into one sentence you can act on. This is the
   environment, not the code: one run takes a minute, and during that minute macOS
   marks the window occluded. **`bench-package-frame.mjs` has already solved the same
   problem** (three flags added at launch, `--disable-backgrounding-occluded-windows`
   and friends, on the ground that "a user opening a view is looking at the window"),
   and `bench-scroll.mjs` does **not** have those three flags. Whether to add them
   there too is (e) item 2 — **not added this round**, because that would change the
   measurement conditions of a benchmark already in acceptance.

2. **Two silent hangs** — **not one character of output**, and Node's final word is
   `Warning: Detected unsettled top-level await at .../bench-scroll.mjs:710` (that
   line being `await main()`). This is worse than the first class: `catch` never ran,
   so **not even the app log's tail was printed**, and when run through a pipe what
   comes back is the pipe tail's exit code — **a caller that looks only at the exit
   code will read it as a pass**.

   The root cause is **a fact about the code, not a guess**: the `Cdp` class (from
   `scripts/bench-scroll.mjs:245`) hangs only three listeners at `#open` — `open` /
   `error` / `message` — and **no `close`**. Once the socket closes (the app process
   is gone, the renderer target has disappeared), every in-flight `send` in
   `#pending` will never settle and never reject; at the same time the child handle
   and the WebSocket handle are both gone, the event loop drains, and Node reports
   "a top-level await did not settle" and exits. Nor does `main()` ever **watch
   `child`'s `exit`** anywhere — there is none after the one in `waitForEndpoint`.

   **This is a hole in this script, not a hole in criterion 21's clause**, but it
   decides directly whether that criterion can be believed: on two of this round's ten
   runs, the criterion said nothing at all. The fix and what is undecided are in (e)
   item 3 — **not fixed this round**, because by §0's rule this is a new guard that
   has to go through the document first, and needs an inverse check to go with it.

### (d) `bench-package-frame.mjs`: four rounds, its first appearance in the acceptance table as something that "produced numbers"

The criteria, where the thresholds come from, and the inverse check for every guard
are all in
[`2026-08-12-package-open-cost-benchmark.md`](2026-08-12-package-open-cost-benchmark.md).
This section records only the numbers from these four rounds. **All four rounds exit 0.**

| quantity | round 1 | round 2 | round 3 | round 4 | criterion |
|---|---|---|---|---|---|
| neo4j `graph` bytes to open | **23,362 B / 3 files** | same | same | same | ≤ 65,536 B |
| the same, read back from the second source | **23,362 B** | same | same | same | the two sources must be equal |
| neo4j `ready` median | 12.3ms | 10.7ms | 10.2ms | 11.0ms | ≤ 40ms |
| neo4j window main thread median | 2.3ms | 2.7ms | 2.4ms | 2.4ms | ≤ 15ms |
| `echo` bytes to open (both sources) | **8,352 B / 2 files** | same | same | same | ≤ 65,536 B |
| `echo` `ready` median | 16.7ms | 13.5ms | 12.0ms | 14.1ms | ≤ 40ms |
| `echo` window main thread median | 5.3ms | 4.2ms | 4.0ms | 4.9ms | ≤ 15ms |
| the control's millisecond difference | 85.3ms | 81.5ms | 85.2ms | 85.7ms | ≥ 20ms |
| the control's ratio (reported, not judged) | 441× | 451× | 383× | 351× | — |
| attribute writes per frame | **1200** | 1200 | 1200 | 1200 | ≥ the element count, 600 |
| element count idle vs spin | 600 / 600 | same | same | same | must be equal |

**The result in one sentence**: one open of neo4j's `graph` view has the host read
**3 files, 23,362 B** (`index.html` + `index.js` + `index.css`), all under that
package's own `ui/`; **837,247 B in the same package go untouched by a single byte**
(most of it the 800 KB driver bundle). Hanging there without moving, the frame costs
0.2–0.6ms per second on its own thread, and **0.1ms per second on the host thread**.

**Two things that must be said honestly**:

1. **The time half cannot measure finely.** On the same untouched code, the four
   rounds' `ready` medians jump between **10.2–16.7ms**, the same order as the
   fourteen rounds of 7.1–17.8ms that benchmark records for itself — the spread comes
   from the machine. So the resolution of the time criteria is about "2.5× or worse":
   it catches "a package UI has started pulling in something enormous" and **cannot
   catch a 30% regression**. This is not a discovery of this round, it is what that
   benchmark says in its own file; this round's four rounds reproduce it.
2. **The byte half has zero spread.** Four rounds × two sources = eight counts, neo4j
   23,362 byte for byte and echo 8,352 every time. So 64 KB is a **budget**, not a
   threshold derived from noise, and this half is the one quantity in this benchmark
   that can measure finely.

### (e) Still owed

1. **§4.5's clause 21's stated reason for "not taken" is false by measurement, and
   still uncorrected.** The clause says "raising `echo` to Tier C means adding a line
   to `PACKAGE_UI`, and that is **precisely what criterion 17 guards with grep**".
   Criterion 17 guards two things: that the window chunk holds none of twelve
   database-client signature strings, and that the window chunk contains no bytes
   from `~/.peek/packages/`. Measured against the current artefacts: hand-written
   literals like `neo4j` and `view.kind.graph` **are in the window chunk today**
   (that line of `PACKAGE_UI`, `titleKey`, two `panel.ts` files), and criterion 17 is
   green — what it distinguishes is "the bytes of a package statically imported" from
   "a hand-written string", and that sentence of the clause runs the two together.
   **What actually blocks it is a different assertion**:
   `src/drivers/__tests__/view-kind-halves.test.ts:26`'s
   `deepEqual(installedViewKindContracts().map(kind), VIEW_KIND_CONTRACTS.map(kind))`
   — the contracts compiled in must every one belong to a package this build also
   ships, and `echo` is not a bundled package. Measured: adding a minimal `echo`
   registration goes red at once (`actual: ['graph'] / expected: ['graph','echo']`),
   and 3 pass once reverted. Both roads to making it green again **loosen an existing
   assertion**, which by §0's rule needs the user's separate nod. **The conclusion
   (not taken) stands; the reason has to be replaced.** This round did not change the
   clause unilaterally.
2. **Whether `bench-scroll.mjs` should get those three foreground flags too.** See
   (c)'s first class: five of ten stopped on the occlusion guard, while
   `bench-package-frame.mjs` solved the same problem long ago with three flags, on the
   argument that "the user is looking at the window, so 'treated as foreground' is the
   state that should be measured" — and the same sentence holds for "the user is
   scrolling a table". **Why it was not added unilaterally**: this changes the
   measurement conditions of a benchmark **already in acceptance**, and once changed,
   every `bench-scroll` number from before this round would no longer sit on the same
   conditions as the numbers after. The user has to call it. (The guard itself stays
   regardless — the flags do not cover minimised or a sleeping display.)
3. **Whether `bench-scroll.mjs`'s silent hang should be fixed.** See (c)'s second
   class; the root cause is pinned to `Cdp` having no `close` listener plus nobody
   watching `child`'s `exit` anywhere. The shape of the fix is off the shelf: hang a
   handler on the socket's `close` that rejects everything in `#pending`, and let
   `child`'s `exit` interrupt an in-flight wait inside `main()` — **the same species
   of thing** as §4septemvicies(d)'s entry-point ceiling on rAF and
   §4quinvicies(c)'s fix to smoke (turning a silent hang into one sentence). **Why it
   was not fixed unilaterally**: this is a new guard, and by §0 it goes through the
   document first and needs an inverse check to go with it (construct a run where the
   app is killed midway, and assert that it reports one sentence within seconds
   instead of draining the event loop). The user has to call whether this round does
   it.
4. **Criterion 15's "actually install a `.app` upgrade once"** — still unit tests
   only, no manual test. (Owed across rounds, untouched.)
5. **Whether criterion 21's clause should leave room for noise** — §4duodetricies(e)
   item 3, undecided as it stands. This round's three clean rounds did not reproduce
   that `1 / 600`, **but three rounds do not constitute evidence that it will not
   appear again**.
