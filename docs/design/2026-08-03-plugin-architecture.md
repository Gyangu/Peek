# Plugins: one core, plus a package of its own for every database

> 2026-08-03. The user's requirement: **the base package handles connections,
> layout, that sort of thing; every kind of database is a package of its own,
> carrying its own MCP tools, its own skill, its own interface; and it can be
> installed and extended.**
>
> This road was explicitly recorded as "**not chosen**" in
> [`2026-08-03-driver-package-boundary.md`](2026-08-03-driver-package-boundary.md)
> §3.1. This document **overturns that decision**, and does not re-argue the
> direction — the user has confirmed it twice. What it does is spread out and
> quantify everything the previous round waved past as "the cost", because four
> of those items were not known at the time of the decision, and one of them is
> **directly incompatible** with the goal.
>
> Three things already confirmed:
> - **skill = an Agent Skill for the embedded agent** (plain text, executes no code)
> - **three phases: design the loader → split the in-repo packages out → switch to
>   loading at run time**
> - **a package may bring view kinds of its own** (`ViewState` goes from a frozen
>   union to an extensible registry)

---

## 0. The decision ledger

Five decisions, all settled by the user after reading §1.6 (the DataGrip
evidence). **Two of them go against this document's author's recommendation; the
user's decision is what gets implemented, and the consequences are recorded here
as they are.**

| # | decision | what was recommended | recorded in |
|---|---|---|---|
| 1 | **Trust model: check nothing.** Whatever is in `~/.peek/plugins/` is what runs | a manifest declaration plus a confirmation at install time | §2.7 |
| 2 | **`ViewKind` and `Command`, the two frozen unions, are opened together in Phase B** | — | §2.3 |
| 3 | **Phase B splits all five databases out at once**, with no pilot | — | §2.1 |
| 4 | **Tier C (an isolated iframe drawing itself) is done now**, with a graph database as the first sample | "leave the hole open and do not fill it yet" — the user dissolved the "there is no sample to validate against" objection by making the graph database that sample | §2.6 |
| 5 | **Redaction fallback: broadcast as-is.** When a plugin has not declared which fields are passwords, the config goes to the renderer and to MCP exactly as it stands | "the whole config never leaves". §2.5 of this document once marked this one "the single thing that cannot be compromised" | §2.5 |

**The consequence of decision 5 has to be written where it can be seen, not only
here.** The feature table at `README.md:31` and `README.zh-CN.md:26` today
describe a redaction path backed by an exhaustive switch; after plugins it does
not hold for plugin drivers. The README's security section has to change with
it, or the documentation will be lying about a question concerning passwords.

**The consequence of decision 1**: peek has no Marketplace, and therefore none of
the after-the-fact kill switch DataGrip falls back on (§1.6). So this is not "the
same as DataGrip", it is "DataGrip's floor, with its only fallback removed". That
is a reasonable trade for a local development tool, but it has to be said out
loud.

---

## 1. What this fixes

### 1.1 The three reasons recorded last round still hold, but are no longer grounds for refusal

The three reasons listed in `driver-package-boundary.md` §3.1 — (1) one package
has to span three processes, (2) view kinds and Command are frozen unions in
core, (3) UI reuse gets torn apart — are all true. They are demoted from "grounds
for refusal" to "an engineering checklist". §2 gives a plan for each one.

The last sentence of that section reads:

> This road only becomes necessary if **third-party drivers from outside the
> repository** are to be supported one day (the user installs a package
> themselves) — and what has to be solved then is the loader, version
> negotiation, the sandbox: a different question from this round's.

"One day" is now.

### 1.2 Four hard facts that were not known at decision time

#### (a) The security verification script's headline assertion is incompatible with the goal

What `apps/desktop/scripts/verify-chat-security.mjs:449` asserts is:

> **Every tool name that appears at run time must have a corresponding
> `name: '…'` declaration in some file under `src/main/mcp/tools/`.**

It is **derived** rather than a count (`:427`), and it is this script's headline
assertion. "Every database package brings its own MCP tools" **violates it by
definition**.

This is not a lint; touching it touches the script's premise. What §2.4 proposes
is to change the assertion from "comes from a directory in this repository" to
"comes from a **registered, enumerable** source" — the semantics get weaker, and
the document has to state exactly where.

#### (b) The renderer has two independent locks, and CSP is the hard one

- `index.html:9`: `default-src 'self'; script-src 'self'`, production goes through
  `loadFile` → a `file://` origin, with
  `contextIsolation: true, nodeIntegration: false, sandbox: true`.
  **The window cannot possibly execute any third-party JS today.**
- `ViewHost.tsx:25` is a static switch over a closed union of six members.

The second lock is ours and can be moved; **the first is the browser's**. For a
plugin to put code into the window there are only two roads: compiled into a
chunk at build time (workable in Phase B), or the CSP relaxed at run time (Phase
C has to answer this head on).

One self-confessed crack is worth recording as well: `preload/index.ts:51` admits
that `__peekPreloadInternal` is visible in the main world, "it exposes exactly the
same capabilities as window.peek". **There is no script-level isolation inside the
renderer at all** — any code running in that world gets the complete Command Bus.

#### (c) macOS code signing is fail-closed, so plugins cannot live inside the .app

`package-mac.mjs:26` states that on Apple Silicon macOS refuses outright to
execute an unsigned binary, "an unsigned build simply will not launch"; after
packaging comes `codesign --force --deep --sign -` and then
`--verify --deep --strict`, and `install-mac.mjs` verifies once more after
installing.

**Writing any file into the bundle = the application does not start.** And
`install-mac.mjs` begins every install with
`rmSync(installedApp, {recursive: true, force: true})` — even if something did get
stuffed in there, one upgrade takes it away.

Conclusion: plugins can only live under `~/.peek/`. That directory exists and its
permissions are designed (directories 0700 / files 0600 / atomic writes), but
`config/paths.ts:1` words it as "the three files it is **allowed** to write" —
**the design intent is a closed set of files, not a plugin directory**.
`~/.peek/plugins/` does not exist today.

#### (d) All three landing sites are fully privileged, and an unvalidated load switch already exists

This is the most important one. There is **no** signature check, manifest
validation, permission declaration or sandbox today, of any kind. What a plugin
can touch:

| process | what it gets |
|---|---|
| driver-host | `utilityProcess.fork` **passes no sandbox argument at all**, and `sanitizeEnv` **inherits the whole of `process.env` as it stands**; the `ConnectionConfig` it receives carries **unredacted plaintext passwords**; it holds the MessagePort to the renderer and can inject arbitrary chunk frames into the window's result cache; `~/.peek/mcp.json` at 0600 under the same uid offers it no resistance |
| main | worse: full node plus `safeStorage` — **it can call `decryptString` on every saved credential**; it can rewrite `mcp.json`, leak or re-sign the bearer token; it can dispatch any Command under **any `CommandSource`** (the `source` at `executor.ts:44` is just an ordinary parameter), punching straight through the whole attribution design of PLAN §10, "record the initiator on the thing that gets created" |
| renderer | cannot run today; the moment it can, it amounts to full control of the application, minus node |

And **`PEEK_DRIVER_HOST_DIR` (`manager.ts:128`) is, right now, an
environment-variable switch that "loads the highest-value process entry point
from an arbitrary path", with no validation whatsoever**. It is both a ready-made
loader prototype and an existing exposure.

**So this document's first engineering conclusion is: the loader is not a new
hole being opened, it is a door being fitted to the hole that is already open.**

#### (e) One dead comment found along the way

`mcp/server.ts:82` claims the agent token "lets that handle carry a different tool
set — the natural place to keep the embedded agent away from the chat tools it
would otherwise point at itself". **No code does this**: `server.ts:162` is
`options.tools ?? collectBuiltinTools()`, `main/index.ts` passes no `tools`, and
the two sets of credentials get the same set of tools, differing only in
`ToolContext.source`. If plugin tools are to be restricted by caller, that
**filter-by-source** mechanism has to be built first.

### 1.3 The "Agent Skill" choice has a mechanical problem

The embedded agent's sandbox is `settingSources: []` + `tools: []`
(`acp/session-config.ts:157`). The SDK's `skills` and `plugins` options **do get
through** the ACP layer (nothing re-asserts them), but there are two unresolved
conflicts:

1. **A skill is exercised through the `Skill` tool, and `tools: []` turns every
   built-in tool off.** The SDK documentation says `skills` is "the only switch
   that turns skills on; there is no need to add `Skill` to `allowedTools` as
   well" — but which of `tools: []` and `skills` wins **cannot be derived from the
   declarations, and needs a probe against the real thing**.
2. **Both mechanisms read a directory off disk**, so peek would have to land the
   package's skill files somewhere and then point at them — which invites back
   exactly the filesystem coupling `settingSources: []` was there to remove. The
   SDK is blunt about the level of guarantee it offers: "This is a context filter,
   not a sandbox… Do not store secrets in skill files".

**So Phase B's skills do not go through the SDK's skills option; they go through
widening `MCP_INSTRUCTIONS`** — and there is a precedent for that today:
`mcpConnectExample` is already "a driver package contributing a passage of prose
the model will read" (`instructions.ts:47` assembles `CONNECT_EXAMPLES` out of
`DRIVER_MANIFESTS`). Widening it adds no new pipe.

Two limits to state: `MCP_INSTRUCTIONS` is finalised at MCP `initialize`
(`server.ts:243`), so **installing a package mid-connection does not change it**;
and it is the **same text** external clients read (`instructions.ts:10` spends a
whole paragraph arguing that it has to be one text).

Phase C runs the probe against the real thing and decides whether to take up the
SDK's `skills`.

### 1.4 The layering axis needs correcting: it is not "one package per database"

The scan turned up evidence that goes straight through the original phrasing:

- **postgres and mysql/sqlite share the `relation` kind** — two packages, one
  browsing semantic.
- **what pgvector needs is `vectorCollection`, and pgvector belongs to postgres** —
  one database spanning two capabilities; and `vectorCollection` lives in the
  qdrant package today.

So the correct axis is "**one package = the implementation of a set of
capabilities**", not "one package = one database". Most of the time the two
coincide (the redis package implements keyValue), but pgvector makes the postgres
package implement `collectionScan(relation)` and `vectorSearch(vectorCollection)`
at once. The manifest format has to be able to express this, or the first real
extension request walks into a wall.

### 1.6 The DataGrip evidence — the one product that has been doing this for ten years

JetBrains DataGrip is the closest reference available off the shelf: a database
IDE in which DBMS support is itself plugin-shaped. Looking it up is more
trustworthy than reasoning it out, and two of the findings changed this
document's design directly.

#### (a) Trust: almost nothing is checked

- **No sandbox.** A plugin runs in the same JVM as the IDE, fully privileged.
  That is JetBrains' own documentation's phrasing, not an inference.
- **Signing is essentially a shell.** Step one of the signing flow in the SDK
  documentation reads "the author generates a key pair and uploads the public key
  to the Marketplace **(not available yet)**" — that *yet* is six years old, and a
  JetBrains employee confirmed on the forum on 2026-05-12 that "plugin signing is
  not supported on JetBrains Marketplace yet". What a signature actually proves is
  "distributed through the Marketplace, untampered in transit", **not** "from the
  author you think it is from".
- **It is verified once, at the moment of installation, and never at load.** Swap
  the jars in the plugin directory after installing and the IDE does not notice.
- **A local install verifies no signature at all.**
  `custom-repository.certificate.signature.check` defaults to `false` — the
  "Install Plugin from Disk" path executes not one line of signature-checking
  logic. This is precisely the scenario peek's `~/.peek/plugins/` corresponds to.
  And when it is checked and fails, what pops up is a soft dialog whose button
  says "Ignore and Continue".
- **Marketplace review does not look for malicious code.** The checklist is
  overwhelmingly logo dimensions, name length, EULA, privacy policy. In the
  post-mortem of a malicious AI plugin incident in 2026-06, JetBrains said as much
  themselves: the Plugin Verifier "is architecturally a compatibility and API-usage
  checker, **not a dataflow or anti-malware scanner**".
- **What actually catches things is centralised distribution plus a remote kill
  switch** — revocation after the fact, not prevention before it.

This is the basis for decision 1. What has to be remembered: **peek has no such
kill switch.**

#### (b) Non-relational databases: all crammed into the same grid, and that is where it hurts

- **Redis**: every type is hard-mapped onto a table — string → one column, one
  row; list/set → one column, N rows; zset → two columns (value, score); hash →
  two columns (field, value).
- **MongoDB**: compressed twice over — the query language included. You **write
  MongoDB in SQL**, and DataGrip translates it into an aggregation pipeline.
- **A plugin cannot add a view.** `GridPresentationMode` is a three-valued Java
  enum (`TABLE / TREE_TABLE / TEXT`), and `ResultViewFactory` is an exhaustive
  switch over it with hard-coded static factories. No extension point, no
  registry.

At first glance this is a perfect endorsement of "declarative views". **But the
second half runs the other way**: there is a third-party plugin whose only reason
to exist is making MongoDB results readable (a table view suits neither nested
fields nor arrays, and ⌘C copies the whole JSON rather than the selected leaf).
It **registers no database extension point at all** — because there is none to
register. It uses an action's `update()` as a polling hook, **downcasts the result
view's Swing component to an internal implementation class**, and the whole file
is marked `@file:Suppress("UnstableApiUsage")`.

**Without a relief valve the pressure does not disappear, it comes out somewhere
else.** This is the basis for decision 4, and the reason Tier C exists.

#### (c) The three things genuinely worth copying

1. **A driver is data, not code.** `driversConfig` points at an XML: a URL
   template plus a driver class name plus Maven coordinates. **Adding a driver by
   hand in the UI and having a plugin install one converge on the same declarative
   record**, so the two paths compose rather than compete. peek's `DriverManifest`
   is already this shape — count this one as already copied.
2. **Cell-level extension open, view-level closed.** Four `dynamic="true"`
   extension points: `valueEditorTab`, `cellViewerFactory`,
   `minimizedFormatDetector`, `customToolbarProvider`. JetBrains eats its own dog
   food — **showing an image inside a cell is an ordinary extension**. And
   `CellViewerFactory` is a **scored auction** (each factory reports a
   `Suitability` for a cell, the highest score wins), not first come first served.
   → This becomes this document's **Tier A½** (§2.6) directly.
3. **`extensionFallback`: DBMSs can inherit from one another.** The DuckDB plugin
   declares `fallbackDbms="POSTGRES"` and falls back to postgres's behaviour for
   whatever it has not implemented. For peek this reads as "a new SQL database
   inherits the whole `relation` set".

#### (d) One warning

**A third party can add a dialect, and cannot add an introspector.**
`com.intellij.database.introspector` is marked `@ApiStatus.Internal`; searching
third-party `plugin.xml` files across GitHub returns zero hits, while
`database.dialect` has six. "Full support" is the tier JetBrains keeps for itself,
and third-party DBMS plugins are structurally all "basic support plus a good
grammar".

If peek keeps an extension point for itself too, **say so**, rather than marking
it `@Internal` and watching other people force their way through it.

### 1.5 Boundary (what this document explicitly does not do)

- **This document changes no code.** What it produces is interfaces, a directory
  layout, a manifest format, a trust model and a phased plan.
- No installation shape for Windows / Linux (the code-signing item is
  macOS-specific; the other platforms are counted separately).
- No plugin marketplace, and no concrete protocol for version negotiation (Phase C
  settles that; this document only leaves the room).

---

## 2. The plan

### 2.1 Three phases, each complete in itself

| phase | what it does | what can be verified when it ends |
|---|---|---|
| **A (this document)** | interfaces, manifest format, directory layout, layering model | the document itself |
| **B** | split the packages inside the repository, compiled in at build time: the kernel plus five database packages, the `ViewKind` and `Command` registries, all three of Tier A / A½ / C implemented, the `peek-plugin://` protocol | all five existing databases come from packages, with zero functional regression; neo4j runs as the first Tier C sample |
| **C** | loading at run time: `~/.peek/plugins/`, the loader plus validation for `PEEK_DRIVER_HOST_DIR` | installing a package from outside the repository connects to a new database, without repackaging the app |

**B is how C gets verified, not merely a step on the way**: once the split is
done, the five existing databases are five "plugins", and whether the seam is
right is known on the spot. **C changes only when loading happens, not the seam.**

Per decisions 2/3/4, Phase B is much heavier than originally planned — both
frozen unions opened together, all five databases split at once, Tier C brought
up alongside. The right order inside it is:

1. **the two registries first** (`ViewKind` + `Command`), with the five databases
   still where they are, used as the live test
2. **the `peek-plugin://` protocol plus the Tier C skeleton**, at which point no
   plugin uses it yet
3. **the five databases split into packages**, all landing on Tier A / A½
4. **the neo4j package**, the first and only Tier C sample

The reason for the order: 1 and 2 are both "add a new road, leave the old one
alone", and can each be verified independently; 3 is "move what is on the old road
onto the new one", by which point the new road has been verified; 4 is the first
thing on the new road that the old road could not run. `pnpm test` has to be
fully green at the end of every step.

### 2.2 The kernel / plugin seam

**The kernel keeps** (`@peek/kernel`, which is today's `core` plus the parts of the
app that have nothing to do with databases):

- the Command Bus, the Workspace state machine, the layout tree, patch broadcast
- connection management (the connection book, credentials, driver-host lifecycle,
  timeouts and deadlines)
- the MCP server proper (HTTP, token, executor, the registry mechanism)
- the chat panel (it is kernel: `chat` is the only view kind that belongs to no
  connection)
- the chunk protocol, the canonical representation of values, the error model, the
  i18n runtime

**A plugin package carries** (`@peek/db-<name>`):

- the driver implementation (today's `packages/driver-*`)
- the `DriverManifest` (already there today)
- **MCP tools** (new)
- **skill text** (new; in Phase B it goes through widening instructions)
- **view kinds plus components** (new)

### 2.3bis Implementation record — two things better than this section predicted, and one that overturns decision 2's premise

> Added on 2026-08-03, after implementing step 1 of Phase B. The reasoning below
> this section — trading compile-time exhaustiveness for validation at startup —
> **was not all cashed in, because it did not need to be**.

#### (a) Exhaustiveness does not have to be traded away

`ViewState` is **not replaced by a registry**; it gains one more member:

```
ViewState = …the six built-ins… | PluginViewState
```

`PluginViewState.kind` is the **literal** `'plugin'`, and the plugin's own name
lives in `pluginKind`. The union is therefore still a closed discriminated union
of seven members, and every `switch (view.kind)` is still forced by the compiler —
**every call site has to say explicitly how it treats a plugin view**, rather than
being rescued at startup.

Evidence: opening the union and running typecheck reported exactly four places —
`ViewHost` / `StatusBar` / `descriptors` / `panelTitle` — no more, no fewer.

**One pit worth recording was fallen into on the way.** The first version made
`kind` a branded string (`string & {brand}`), so a plugin could use its own name
as the discriminant directly. It compiled, and then typecheck reported
`Property 'ref' does not exist on type 'ViewState'` — **reported inside
`case 'table':`**. The cause is that **a brand is still a `string`**, a
string-based discriminant is not a discriminant, and the whole union degrades into
a non-discriminated one. The error does not say "there is a problem with your
brand", it says "table has no ref", which is why it is written into the comment on
`PluginViewStateShape.kind`.

#### (b) The two silent degradations are plugged

The two `default:` branches this section names are more dangerous than the seven
exhaustive switches, and both are hard failures now:

- `autoFetch` becomes a **required** field of a registration; leave it out and
  loading is refused, with a report of what is missing;
- `titleKey` has the type `PlainMessageKey` (the subset of catalogue keys that
  take no interpolation parameters), so a plugin writing a key the catalogue does
  not have **fails to compile at the registration site**, instead of painting the
  key onto the tab.

`PlainMessageKey` moved back from `components/connectForm.ts` to
`i18n/catalog.ts` while we were there — with a second consumer, a type two
unrelated interfaces both depend on should not live inside one of them.

#### (c) **Decision 2's premise does not hold: `COMMAND_NAMES` does not need opening**

Decision 2 was "`ViewKind` and `Command`, the two frozen unions, are opened
together in Phase B". Doing it started by reading those 32 command names, and
**every one of them is general to the kernel** — connection, layout, chat,
settings; not one belongs to a particular database. What a plugin wants is not a
new verb, it is for the two verbs that already exist, `view.open` /
`view.update`, **to know its kind**.

So not one character of `COMMAND_NAMES` was touched, and every guarantee built on
top of it survives exactly as it was: `CommandInput<K>`, `CommandResultMap`, the
`_assertNoMissingResult` compile-time assertion,
`coreHandlers satisfies Required<CommandHandlerMap>`, the typed return of
`parseCommandInput<K>`, and the argument checking on several hundred
`dispatch('view.update', …)` calls in the renderer.

What actually opened is only the two zod unions that **dispatch payloads by
kind**: `ViewOpenSpecSchema` and `ViewPatchSchema`, each gaining a `'plugin'`
member — the same shape as `ViewState`.

A plugin's MCP tools therefore need no new Command either: like the 13 built-in
tools they are a thin shell over a Command, neo4j's `expand_node` lands on
`view.update`, and fetching goes through `autoFetch` into the kernel's existing
scan path.

**Three decisions had to be added** (none of them forced by the types, so each has
a test of its own): a patch is a **shallow merge** rather than a replacement
(consistent with every built-in patch; otherwise an MCP client changing one field
has to resend the whole state, and fights with the user changing another one);
`null` **deletes** a key (built-in patches already use `null` to express
clearing); and `affects` is true whenever the state really changed (the kernel
does not know which of a plugin's keys feed fetching, and the two errors are
asymmetric — fetching once too often is one redundant scan, fetching once too few
is a view showing stale rows with nothing on screen saying so).

### 2.3 `ViewKind` goes from a frozen union to a registry — and what compensates for it

This is the heaviest change. The scan produced the complete dependency list:
**7 exhaustive switches with no `default`** (`ViewHost.tsx:25`, `workspace.ts:869`
`describeView`, `workspace.ts:900` `viewTitle`, `StatusBar.tsx:214`,
`handlers/shared.ts:370` `buildViewState`, `handlers/view.ts:129`
`applyKindPatch`, `descriptors.ts:234` `collectionRefOf`), plus two that **have a
`default` and therefore degrade silently**:

- `handlers/shared.ts:426` `autoFetch` → `default: return undefined`:
  **a plugin view fetches nothing once opened, with no signal whatsoever**.
- `panelTitle.ts:20` `viewTitleOf` → `default: t(\`view.kind.${view.kind}\`)`:
  **a message key assembled out of a template literal**; a plugin kind has no such
  key at run time, and the title is displayed as the key.

The latter two are more dangerous than the former seven — the compiler stops the
seven, and does not stop the two.

**The compensation: trade "exhaustiveness at compile time" for "full validation at
registration, plus refusing to load an unknown kind".** A view kind's registration
has to supply, in one go, everything all 9 sites need (the render component,
`describeView`, `viewTitle`, `buildViewState`, `applyKindPatch`,
`collectionRefOf`, `autoFetch`, the i18n key, the `ViewSummary` metadata); one
missing and **this plugin is refused loading**, reported through the error centre.

The failure mode changes from "one branch silently missed" to "this plugin will
not install, and here is what it is missing". **These are not equivalent** — a
compile-time guarantee has been traded for a startup-time one — but it is
controllable, and the failure is loud.

### 2.4 MCP tools: registration is already open, all that is missing is collection

`registerTools(server, tools, ctx)` (`mcp/registry.ts:88`) is a for loop that
accepts any array. **Collection is the static half**: `collectBuiltinTools()` uses
`import.meta.glob('./tools/*.ts', {eager:true})`, and its comment says so itself —
"expanded statically at build time… no reliance on the filesystem at runtime".

So Phase B only has to merge "the tools a plugin package declares" into that
array. Three problems that have to be handled at the same time:

1. **The assertion at `verify-chat-security.mjs:449` has to change** (§1.2a). The
   new assertion: every tool name appearing at run time comes from **a registered
   source** (the kernel's `tools/` directory, or the manifest of a loaded plugin),
   and the manifest itself is enumerable. Where it is weaker has to be spelled
   out: the old assertion took "this repository" as the root of trust, the new one
   takes "the set of registered plugins" — the root of trust got bigger, and that
   is the essential cost of going plugin-based.
2. **`capabilities: { tools: { listChanged: false } }`** (`server.ts:242`) declares
   that the tool list does not change within one MCP session. Installing a plugin
   means either switching to `listChanged: true` + `sendToolListChanged()`, or
   having it take effect only for sessions created afterwards (a session idles for
   at most 30 minutes). **Phase B picks the latter** (simple, honest), and Phase C
   re-evaluates.
3. **The mechanism for restricting by source does not exist** (§1.2e). If plugin
   tools are to distinguish "an external client may call this" from "only the
   embedded agent may", it has to be built first. **Phase B does not do it**, and
   a plugin's tools treat both sets of credentials alike.

### 2.4bis Implementation record — step 3 is not a "move", and one sentence that will lead people astray

> Added on 2026-08-03, before implementing step 3 of Phase B. **One sentence in
> §2.6ter has to be corrected first**, or what gets built by following it is
> wrong.

#### (a) Not one of those 13 tools should move

What §2.6ter says is that "**MCP tools** all still live in
`apps/desktop/src/main/mcp/tools/`", which reads as though they ought to move into
the packages. After reading them one by one: **not one of them should move.**

`connect` / `introspect` / `open_view` / `run_query` / `cancel_query` /
`list_connections` / `read_workspace` / `activate_view` / `move_view` /
`set_layout` / `send_chat` / `read_chat` / `control_chat` — **all 13 are kernel
verbs**, and not one belongs to a particular database. Moving `set_layout` into
`driver-postgres` is not decoupling, it is asserting that layout is a property of
PostgreSQL.

This is the **same conclusion** §2.3bis(c) reached about `COMMAND_NAMES`, one
layer later: reading those 32 command names turned up that they are all general to
the kernel, and reading these 13 tool names turns up the same thing. And it
**corresponds word for word** to how view kinds are handled: the kernel keeps its
own six built-in kinds and a package contributes the seventh (`graph`). Tools are
the same — the kernel keeps its own 13, and a package contributes the 14th.

So the "new" marked against the **MCP tools** line in §2.2's list means exactly
what it means against the **view kinds** line: **"a package may contribute tools
from now on", not "the tools that already exist belong to a package".** That
sentence in §2.6ter is to be read the way this section reads it.

#### (b) So step 3 delivers three things

1. **The mechanism** — letting a package declare tools without importing app.
2. **The sample** — neo4j's `expand_node` (§2.3bis(c) already named it).
3. **Moving the little that genuinely belongs to a package back into the
   package** — this is the part that is "still in app", and **it is already
   lying**: the description in `tools/connect.ts` hand-writes what each of the
   five drivers accepts, and nobody changed it when neo4j arrived; the empty-state
   hint in `tools/list-connections.ts` likewise hand-writes postgres. Both change
   to being derived from `DRIVER_MANIFESTS`, the same road as `instructions.ts`'s
   `CONNECT_EXAMPLES` — a road that was built on 2026-08-02 for this very bug,
   with these two sites simply not wired into it at the time.

#### (c) The types go into core, `defineCommandTool` does not

A package cannot import app, so the tool contract's types have to live in core:
`ToolContext` / `ToolOutput` / `CommandToolSpec` / `ReadToolSpec` / `ToolSpec` /
`PeekTool` / `CommandOutcome` / `ToolAnnotationsLite` / `CommandDispatch` /
`IntrospectReader` / `ResultRowsReader` / `ResultRowsSlice` / `McpLogger`. All of
them pure types, and everything they reference is in core already. app's
`mcp/types.ts` becomes a re-export layer, and **not one import line moves across
the 13 tool files, the executor, the registry, the server and every test**.

One exception has to be handled separately: `ToolOutput.uiEffects`'s `UiEffect`
lives in app's `ui-effects.ts`. **Move the type only** (`UiEffectKind` +
`UiEffect`), leaving `diffUiEffects` / `renderUiEffects`, which derive it, in app.
The reason is that the two halves differ in nature: the record itself is **part of
the receipt**, handed through unchanged by ACP to the chat panel to be rendered as
a button — it is a contract; whereas "how to diff it out of two snapshots" is
policy.

**`defineCommandTool` does not go into core.** It needs `renderPanelBrief` /
`toJson` / `diffUiEffects` / `renderUiEffects`, and moving it over means moving
745 lines of receipt rendering into a "frozen contract" package. Instead: **a
package hands over a spec, and app's executor stays the only place that can
construct a `PeekTool`**. The 13 built-ins do not change by one character (they
call `defineCommandTool` themselves), and a package's spec goes through the
**same** `defineCommandTool`. One function, two entrances, no second execution
path — this is the crux, or a package's tools would be bypassing the second round
of argument validation, the forced attachment of `uiEffects`, and "an exception
never takes the server down".

#### (d) A registered source: where the assertion is weaker, and verifying it in reverse

The change §2.4 item 1 asks for lands as two scans rather than one:

- kernel: `apps/desktop/src/main/mcp/tools/*.ts`
- packages: `packages/*/src/mcp-tools.ts`

**Say clearly where it is weaker**: in Phase B both sources sit in the same
repository, so the assertion's actual strength **has not changed**. What changes
is Phase C — by then the second source is `~/.peek/plugins/`, and all the
assertion has left is "comes from a **registered** source", where "registered"
means "the user installed it". **The root of trust goes from "this repository" to
"this repository plus whatever the user installed", and that is the essential cost
of going plugin-based** — written into the script's comment, not hidden away in a
design document.

Verification in reverse (what §4 item 2 asks for by name): the script constructs a
tool name that is in no source at all, and asserts that it **does get reported**.
A check that cannot fail is the same thing as no check.

`tool-surface.test.ts` widens to two scans along with it — what it guards is
"certain commands can never be reached by the model", and a package's tool can
slip past it today.

#### (e) Two genuine defects on the MCP surface, found along the way

Neither was introduced by this change, but both stand in the way of this round's
sample tool, so both are fixed here:

1. **`displayViewKind` is dead code.** The comment on that function at
   `workspace.ts:390` gives its reason for existing as "`ViewSummary.kind` goes out
   over MCP, and telling the model that six kinds of plugin view are all called
   `plugin` makes them indistinguishable exactly where distinguishing them matters
   most" — while `snapshotWorkspace` fills in `kind: v.kind`, and **nothing calls
   it anywhere**. The consequence is exactly the one its comment describes: the
   graph view the model sees through `read_workspace` is `kind: "plugin"`, and it
   **has no way to find which view to expand**. The fix is a `pluginKind?` on
   `ViewSummary` (present precisely when `kind === 'plugin'`, the same shape as
   `browse` / `chat`), plus widening `displayViewKind`'s parameter to a structural
   type so that `ViewState` and `ViewSummary` share its one implementation.
2. **No tool reaches `view.update` at all.** Not one of the 13. Which means an MCP
   client today **cannot change any view's state** — cannot turn a table's page,
   cannot change a filter, cannot switch a vector query. `expand_node` will be the
   first tool to land on `view.update`. **This round does not fill that general
   gap** (`update_view` is a kernel verb and belongs to another change), but it is
   recorded: once it is filled, MCP will be able to change a graph view and not a
   table view, and that asymmetry is **known and written down**, not quietly
   created by this round.

#### (f) Skill text: a passage of prose, plus a length limit

Following the settled conclusion of §1.3 / §3.3 this goes through widening
`MCP_INSTRUCTIONS`, with `skill?: string` added to `DriverManifest`. Three
constraints, each with a test:

- **English** (model-facing text, the same tier as `describeView` /
  `ResultMeta.summary`);
- **no credentials** (the same rule as `mcpConnectExample`; widening that one test
  is enough);
- **a length limit**. This one is new, and the reason has to be said:
  `MCP_INSTRUCTIONS` is read once per **session** by every **model**, so package
  prose with no ceiling means a user who only uses postgres pays the tokens for
  the other five databases. The trade the ceiling forces is the right one — a
  skill earns the right to write down "what the model will get wrong without
  reading this", and not a database tutorial.

A known cost, recorded: instructions are finalised at MCP `initialize` (§1.3), so
**a database that is installed but has never once been connected still has its
skill in that text**. Phase B accepts that (the packages are compiled in and the
set is fixed); Phase C has to look again once install and uninstall happen at run
time.

### 2.5 The cost of opening `DriverId`, and the one thing that has to be kept

`DRIVER_IDS` is a **run-time** validation by `z.enum`, so a driverId from outside
the repository is refused at run time today, not merely rejected by the types.
Opening it opens four exhaustive switches in core along with it.

Three of them (`defaultConnectionLabel` / `connectionDetail` /
`connectionIdentity`) degrade only the display when opened.
**`redactConnectionConfig` does not**: the boundary doc §3.3 recorded its cost —
"**a driver it does not recognise broadcasts the password to MCP as it stands**".

**Decision 5: the fallback is to broadcast as-is, continuing today's behaviour.**

A plugin manifest **may** declare which fields are credentials
(`"redact": { "password": true, "uri": "uri-password" }`), and what it declares is
what gets wiped. **Undeclared is sent as-is** — the config goes into the renderer
and into MCP receipts exactly as it stands.

An earlier version of this document marked "refuse by default" as "the one thing
that cannot be compromised"; having seen the consequences, the user chose
broadcast-as-is. The user's decision is what gets implemented, and the
consequences are recorded here as they are:

- **A plugin that forgets to declare `redact` writes a plaintext database password
  into an MCP receipt.** An MCP receipt is something the model reads and may
  forward on.
- **The feature tables at `README.md:31` and `README.zh-CN.md:26` today describe a
  redaction path backed by an exhaustive switch. After plugins it does not hold
  for plugin drivers, and the README's security section has to change with it** —
  otherwise the documentation lies about a question concerning passwords, which is
  worse than the behaviour itself.
- This one needs a **loud** signal rather than silence: when a plugin with no
  `redact` block is loaded, record a warning in the error centre (a warning, not
  an error; it does not block loading) stating that this connection's config goes
  out as it stands. The cost is close to zero, and it separates "an accident" from
  "done knowingly".

The other three switches (`defaultConnectionLabel` / `connectionDetail` /
`connectionIdentity`) degrade only the display when opened, falling back to a
generic string assembled out of `driverId` when a plugin declares nothing.

### 2.6 Disk layout and the loader (Phase C)

```
~/.peek/
  settings.json          existing, 0600
  connections.json       existing, 0600
  mcp.json               existing, 0600
  chat/                  existing, 0700
  plugins/               new, 0700
    peek-db-mongodb/
      peek-plugin.json   manifest: id, version, capabilities, contributions, redaction rules, required kernel version
      driver.mjs         loaded by the driver-host process
      main.mjs           loaded by the main process (MCP tools)
      renderer.mjs       loaded by the renderer (view components) — see the CSP problem
      skill.md           skill text
```

The "three files it is allowed to write" in `config/paths.ts` has to be rewritten
accordingly — that sentence stops being true the moment a plugin directory
exists.

### 2.6 UI extension: three tiers, and CSP has a clean answer

This section replaces the blank in an earlier version of this document that read
"CSP has no clean answer and none of the three options is good". **The three
options shared one wrong premise**: that a plugin view = a plugin running a
component in the renderer. Reading the existing code shows it is not —
`TableView.tsx`'s real logic is 88 lines, `VectorView` / `QueryView` are the same,
and **all three are "a control strip plus a DataGrid"**: view state lives in
main's Workspace, every change goes through `view.update`, and all data goes
through `resultCache`.

**A view kind is in essence a declaration, not a piece of code.**

The iron rule: **the main window's `script-src 'self'` is never relaxed. No plugin
JS enters the host realm.** The single relaxation is `frame-src peek-plugin:`.

#### Tier A — declarative view kinds, zero plugin code in the renderer

A plugin hands in a view-kind registration record in its manifest, filling every
slot §2.3 requires in one go; the host renders with the **existing** `DataGrid` /
`TreeView` / `InspectorView`, and the control strip is declared as well.

```jsonc
"views": [{
  "kind": "documents",
  "state": { "collection": "string", "filter": "string?", "limit": "number=100" },
  "body": "grid",                       // grid | tree | inspector | keyvalue
  "controls": [
    { "id": "filter", "type": "text",   "labelKey": "…" },
    { "id": "limit",  "type": "select", "options": [100, 500, 1000] }
  ],
  "autoFetch": { "capability": "collectionScan", "requires": ["collection"] },
  "collectionRef": { "kind": "collection", "from": "collection" },
  "title": "{collection}",
  "i18n": { "en": {…}, "zh-CN": {…} }
}]
```

Any slot missing → the plugin will not install, and the error centre reports what
is missing (§2.3's "the failure is loud").

**The per-frame cost is byte-for-byte identical to the baseline** (0.20ms): the
same `DataGrid`, the same `vscroll`, the same `resultCache`; what a plugin
contributes is JSON read once at startup.

#### Tier A½ — cell-level / inspector-level extension, a scored auction

Copying the one layer of DataGrip that is genuinely open to third parties and that
JetBrains uses itself (§1.6c). A plugin does not own a whole view, it claims only
**one way of displaying a value**: how qdrant's vectors appear in the inspector,
how a BSON document previews inside a cell, how each of redis's six shapes
renders.

The contract copies `CellViewerFactory` verbatim: every candidate reports a
`Suitability` score for a value, and the highest score wins — not first come first
served, because first come first served lets two plugins' load order decide the
rendering.

Landing sites: `InspectorView`, `ValueModal`, and `DataGrid`'s cell rendering.

#### Tier C — the self-drawing escape hatch: an iframe on its own `peek-plugin://` origin

Only for data that is **not table/tree/inspector-shaped at all** (a graph
database's node-edge graph, a time-series database's line chart). Declared
explicitly in the manifest.

**Protocol registration** (has to happen before `app.whenReady`, in
`main/index.ts`):

```ts
protocol.registerSchemesAsPrivileged([{
  scheme: 'peek-plugin',
  privileges: { standard: true, secure: true, supportFetchAPI: false,
                corsEnabled: false, allowServiceWorkers: false },
}])
```

`standard: true` is the key — it gives every plugin a real origin
(`peek-plugin://<pluginId>`), and because it goes through `protocol.handle`, **we
can set response headers**, which `loadFile`'s `file://` cannot. This is the one
point in the whole plan that needs new infrastructure.

**The host CSP** (`index.html`): only `frame-src peek-plugin:; child-src 'none'`
is added, plus three zero-cost hardening lines while we are there:
`object-src 'none'; base-uri 'none'; form-action 'none'`.

**The plugin document's CSP** (response headers out of `protocol.handle`, tighter
than a VS Code webview's):

```
default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:; font-src 'self';
connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'
```

`connect-src 'none'` is mandatory: **a plugin's UI has no network whatsoever**,
and its only I/O is that one MessagePort.

An iframe gets no preload (`nodeIntegrationInSubFrames` defaults to false), so
neither `window.peek` nor `__peekPreloadInternal` exists. Stated honestly:
`sandbox="allow-scripts allow-same-origin"` with both flags present means the
sandbox attribute is not the boundary — **the boundary is that separate origin**
(the same as VS Code's).

**How data gets in (the most important trade in the whole document):** the host
**keeps** the connection's port and always acks it itself; what the plugin gets is
a **newly opened per-view channel**, into which a `ChunkFrame` is **teed at chunk
granularity** at `resultCache.onFrame`. The plugin runs a copy of
`@peek/view-runtime` identical to the host's inside its own realm (the storage
layer of `vscroll` + `resultCache`), and therefore gets a **synchronous,
zero-copy** `getCell` on its own heap.

Three guardrails that cannot be given up:

1. **The ack always belongs to the host** — a slow plugin never stalls the
   server-side cursor.
2. **Fan-out is bounded and lossy**: an eight-frame outbox per plugin, and an
   overflow terminates that plugin's stream outright with `{t:'lagged'}` and
   reports the error in the view. **Loss has to be loud**, never a silent hole.
3. **A frame budget, plus automatic disabling on repeated overruns.**

**SharedArrayBuffer is explicitly not used**: it requires `crossOriginIsolated`,
which means moving the whole app off `file://` and turning on
`COEP: require-corp` globally (recursively infecting every sub-resource), in
exchange for a capability none of the five existing databases need.

**The cost, stated plainly**: if a Tier C view subscribes to `result-stream`, the
fan-out costs one extra structured clone per `ChunkFrame`. A million rows is about
1000 chunks ⇒ `run_query` goes **2124ms → roughly 4000–8000ms, a 2–4×
regression**. Only a Tier C view that subscribed pays this bill. **This is the
weakest number in the document**; §4 gives the way to falsify it, and if the
measurement comes out above 5× then `result-stream` is cut and Tier C retreats to
a control surface only.

Memory is the same story: one more resident copy, and `resultCache`'s 200MB
accounting **cannot see it** — so a plugin port needs a byte budget of its own,
terminating the stream when it is exceeded.

#### Which tier the five existing databases land on

| package | tier |
|---|---|
| postgres / mysql / sqlite | A (`relation` → `body: "grid"`) |
| redis | A + A½ (`keyValue` → `body: "keyvalue"`, one A½ renderer for each of the six shapes) |
| qdrant | A + A½ (`body: "grid"` plus a control strip; vector display goes through A½) |
| **neo4j (new, Tier C's validation sample)** | **C** (a node-edge graph, which Tier A's vocabulary cannot express) |

**Not one of the five existing databases needs Tier C** — the strongest evidence
available that the seam is right. Which is why Tier C needs a new sample to press
on it, and that sample is the graph database from decision 4.

One crack that has to be admitted: **`VectorView`'s "named vector suggestion box"
is the one control Tier A cannot express** — its candidates come from
`namespaceStore` rather than from static options. So the control vocabulary has to
carry `{ type: "combo", source: "namespace-children" }`. **Tier A's own
falsification test is exactly that: migrate `VectorView` as it stands into the
declarative form, and if it will not migrate, Tier A was defined too small.
Migrate first and settle the shape afterwards; do not design the vocabulary
first.**

### 2.6bis Implementation record — Tier C's data path was swapped for a different one, and this section's original plan was not implemented

> Added on 2026-08-03 while implementing steps 2 and 4 of Phase B (neo4j).
> **This one changes the previous section's decision rather than annotating it**,
> so it gets a section of its own instead of editing that passage — that passage
> is the reasoning as it stood, and where it goes wrong has to stay legible.

The data path §2.6 lays out for Tier C is: **tee a `ChunkFrame` to the plugin at
chunk granularity at `resultCache.onFrame`**, with the plugin running a copy of
`@peek/view-runtime` in its own realm and thereby getting a synchronous `getCell`.
That road came with three guardrails (the host holds the ack, an eight-frame lossy
outbox per plugin, a frame-budget kill switch), and admitted of itself that "this
is the weakest number in the document", estimating a 2–4× regression.

**The implementation did not take that road. What landed is a one-shot bounded
snapshot** (`packages/core/src/plugin-channel.ts`):

- what the host gives a plugin is **one `data` message**, a plain row-major array,
  capped at `PLUGIN_MAX_ROWS = 2000`, plus a `truncated: boolean`.
- there is no `fetchMore`, no paging message, and a plugin cannot pull.
- a plugin does not subscribe to `result-stream`, so **the bill of one structured
  clone per `ChunkFrame` does not exist at all**.

**Why the original plan was wrong**: it treated "a self-drawn view" and "a large
result set" as the same thing. Writing the first Tier C sample shattered that
premise on the spot — **a force-directed graph is already not a graph but a ball
of wool at a few hundred nodes**. Neo4j Browser's own canvas limit is 300 nodes,
and `MAX_NODES = 500` in `graph.ts` is there for the same reason. Designing a path
with backpressure, acks and a lossy outbox for "how to stream a million rows to
it", for a view that **cannot draw a million rows at all**, is paying a bill for a
requirement that does not exist.

**This does not count as overturning §2.6, it counts as walking into the retreat
it wrote for itself**: §2.6's last sentence is "if the measurement comes out
above 5× then `result-stream` is cut and Tier C retreats to a control surface
only". A bounded snapshot hands over more data than that retreat, and one whole
streaming path less than the original plan. Item 9 of §4 (measuring the fan-out
clone cost) therefore **has nothing left to measure**, and is reclassified as not
applicable — see the revision to §4 below.

**The three guardrails that lapse with it, and what became of each:**

1. **"The ack always belongs to the host"** — still holds, and holds more
   thoroughly: the plugin is not on the stream at all, so the server-side cursor
   cannot possibly stall on it.
2. **"Fan-out is bounded and lossy, and loss has to be loud"** — the form of the
   bound goes from "an eight-frame outbox" to `PLUGIN_MAX_ROWS`; **not one
   character of "loud" was given up**, and it lands on `truncated`. A plugin that
   receives `truncated: true` and draws anyway is the only reason that field
   exists.
3. **A frame budget plus automatic disabling on repeated overruns** — still to be
   done, for the unchanged reason (§4 item 10 is unaffected): a plugin
   busy-looping inside an iframe can still drag the host's compositor down.

**What did not change** still goes as §2.6 says: the separate `peek-plugin://`
origin, `registerSchemesAsPrivileged({standard: true})`, the host CSP adding only
`frame-src`, the plugin document's CSP carrying `connect-src 'none'`, the iframe
getting no preload, no SharedArrayBuffer. **The boundary is still that separate
origin**, and that one has not moved from beginning to end.

**The cost, stated plainly**: Tier C from here on **cannot draw a large result
set**. A plugin that wants "a hundred-million-row time-series line" cannot build
it on this path — what it gets is the first 2000 rows and a `truncated`. That is
not an oversight, it is the chosen boundary: when a view like that is genuinely
needed, the right move is to go back to §2.6's streaming path and **measure item 9
first**, not to raise `PLUGIN_MAX_ROWS`.

### 2.6ter "Which databases are installed, and at what versions" — a read-only section in settings

> Raised by the user midway through the Phase B implementation on 2026-08-03: "it
> should be possible to see in settings which databases and connectors are
> installed, and their version numbers". This section is that requirement's design
> record.

**First, to answer the half of it that is a question**: the connectors'
implementations **have been in their own packages for a long time** —
`packages/driver-{postgres,redis,qdrant,sql,neo4j}/src/{driver,session}.ts` hold
every line of `Driver.connect` through `DriverSession`, the error mapping, the
cursors, the value conversion; none of it is in app. What is left in app is
**assembly, not implementation**: `connections/registry.ts` already derives from
the manifest, and `driver-host/entry.ts` is an import table.

**What genuinely has not gone into the packages is two other things** (Phase B
step 3): **MCP tools** — more precisely "the mechanism by which a package
contributes tools", not those 13 kernel tools themselves, **see §2.4bis(a): the
original wording of this sentence leads people astray** — and the **skill text**,
which does not exist yet. Both are marked "new" in §2.2's list, and it means the
same thing there as on the "view kinds" line: a package **may** contribute from
now on, not that something that exists already belongs to a package.

#### What to display, and why not more

A read-only section, with two blocks:

1. **The database table**: display name + `driverId` + **connector version** +
   capability list, all read out of `DRIVER_MANIFESTS` by **identity**, not
   restated.
2. **The view kinds packages contribute**: read from the renderer's registry,
   listed separately, **not joined to the table above**.

Why item 2 is not a column in that table: **the relation is not one to one**. A
package may contribute no view at all (all five existing databases contribute
none), or several; and a registration says "which **plugin** draws it", not "which
driverId owns it". That `pluginId === driverId` today is a coincidence (`neo4j`
happens to carry the same name on both sides), and writing a coincidence as a join
turns it into a fact that will be wrong later.

#### Where the version number comes from — a literal, plus one test

`DriverManifest` gains `version: string`, hard-written by each package in its own
manifest, and `manifest-versions.test.ts` asserts it equals that package's
`package.json` `version`.

Two approaches considered and refused:

- **Reading `package.json` at run time** — the manifest has to be loadable inside
  a renderer chunk, and there is no `fs` there. This one is not inconvenient, it
  is impossible.
- **Using app's own version** — after Phase C a package can be updated on its own,
  and app's version stops describing it at that point. And it would make "look at
  the version number" begin lying on **the very day it is needed most**.

Writing it twice while making disagreement impossible is a trade this repository
already makes (`DRIVER_REGISTRY` uses the same trick for `capabilities`:
`driver-registry.test.ts` asserts identity rather than content). **A wrong version
number is worse than no version number** — whoever debugs by it rules out the very
build that is running.

#### Explicitly not done

- **No install / uninstall button.** Phase B's packages are compiled in, and a
  button that does nothing when clicked, or pretends it can install, is worse than
  saying plainly that these are built in. That sentence is exactly what sits at
  the bottom of the section.
- **The server version is not displayed.** That is a property of a connection, not
  of a package; a postgres that is not connected has no version, and mixing it
  into the same column would make people think the connector version is also
  something you only learn once connected.

### 2.7 Trust model: no checks (decision 1)

§1.2d showed that all three landing sites are fully privileged. **The decision is
to make no check at all** — whatever is in `~/.peek/plugins/` is what runs,
equivalent to "what the user installed is what the user trusts", the same tier as
VSCode extensions and Claude Code's MCP servers, and consistent with peek as it
stands (`PEEK_DRIVER_HOST_DIR` already carries exactly this semantic today).

**Two things to remember:**

1. **This is DataGrip's floor with its only fallback removed.** DataGrip does not
   check either (§1.6a), but it has centralised distribution and a remote kill
   switch, and can revoke when something goes wrong. peek has neither.
2. **`PEEK_DRIVER_HOST_DIR` should still get validation.** Not checking plugins is
   one thing; an **undocumented environment variable** quietly replacing the
   process entry point that holds the plaintext passwords is another. The latter
   is accident surface, not trust surface.

Two refused approaches (recorded so the next round does not discuss them again): a
manifest declaration plus confirmation at install time; a real sandbox.

---

## 3. Trade-offs

### 3.1 Why Phase B is worth having on its own rather than going straight to C

Once the packages are split, the five existing databases are five plugins, and
they are **known to be right** (they have tests and verification against real
servers). A seam designed wrong is exposed on the spot. Go straight to C and the
first validation sample is a newly written plugin that may well have bugs of its
own, with errors from both sides mixed together.

And Phase B's output has value before C arrives: `VectorView` exists only for
qdrant and yet lives in app, and `vectorSearchMs` is a field only qdrant can use
and yet grows on the kernel's settings schema (`commands.ts:1104`) — these are
wrong today.

### 3.2 Why "compile-time exhaustiveness" is not kept with a hole punched only at the plugin

An approach that was tried: keep the six built-in kinds as a closed union and send
plugin kinds through a `'plugin'` escape branch. Not chosen, because that means
writing the logic twice at every switch (one set for built-ins, one for plugins),
and two sets drift — which is precisely the breeding ground for the class of bug
in §1.4, where the capability declaration points the wrong way. Changing to a
registry in one go puts every kind on the same road, and forks less rather than
more.

### 3.3 Why skills go through instructions first rather than the SDK's skills

§1.3. The conflict between `tools: []` and `skills` cannot be derived from the
declarations and needs a probe against the real thing, whereas the instructions
road is running today (`mcpConnectExample`) and adds no new pipe. Take the road
that is certain first, and probe in Phase C.

---

## 4. Verification

This document contains no implementation. Acceptance criteria per phase:

**Already run (2026-08-03, after steps 1, 2 and 4):**

- Item 1 ✅ **1738 cases, 0 failures** (desktop 1378 / core 69 / postgres 60 /
  redis 37 / qdrant 38 / mysql-sqlite 83 / neo4j 73), typecheck fully green.
  Existing tests changed in **exactly two places**, both of them named by the
  compiler: the switch in `connect-form.test.ts` gains a `neo4j` branch
  (`DRIVER_IDS` has one more member), and the handler in `context-menus.test.ts`
  gains `openPluginView`. Not one of them was relaxed to let an old assertion
  pass.
- Item 3 ✅ see above (+4.5%, no client leaked).
- Item 4 ✅ `plugin-view-kinds.test.ts` deletes one field at a time, and the report
  has to name **exactly that one**; an empty `driverIds` is treated the same as a
  missing field.
- **End to end (`smoke-drivers.mjs`, which runs the packaged output and not the
  source)** ✅ the neo4j line now opens **two** views: a table scan (3 rows) and a
  `graph` (6 rows). The latter proves the entire Tier C seam — `view.open` accepts
  a spec the kernel has no schema for, the main process finds the registration,
  the registration assembles the Cypher, and the result comes back through the
  same mechanism as the table's; and `driver-host.js` really does resolve
  `@peek/driver-neo4j`. The renderer console (`PEEK_FORWARD_CONSOLE=1`) shows
  **zero CSP blocks and zero load failures**, meaning the `peek-plugin://` iframe
  really did come up.
- **Live server** ✅ all 12 neo4j cases pass, including "the write is refused by
  the server, and a count afterwards confirms it really did not happen".

**Already run (2026-08-03, after step 3):**

- Item 1 ✅ **1813 cases, 0 failures** (desktop 1430 / core 82 / postgres 60 /
  redis 37 / qdrant 38 / mysql-sqlite 83 / neo4j 83, the last including 12 against
  a live server). **Not one existing test changed** — leaving `mcp/types.ts` as a
  re-export was for exactly this: a contract moving house shows up as a contract
  moving house, not as forty touched import lines.
- Item 2 ✅ `verify-chat-security.mjs` **passes 10/10**, and the headline assertion
  still passes after being rewritten to "comes from a registered source"; **the
  reverse verification is in there too**: the script constructs a tool name that is
  in no source at all and asserts it gets reported
  (`14 name(s) were parsed out of 14 source file(s)`). The rewrite caught a real
  hole: the glob `packages/*/src/mcp-tools.ts` was taking **core's own
  `mcp-tools.ts` (which is the contract, not tools)** for a source. It carries not
  one `name:` today, so nothing is wrong at run time, but the moment any line
  `name: 'x',` appears in the frozen contract, that name would be **taken as a
  declared tool name** — exactly what this assertion is there to stop. Tightened to
  `driver-*`, with an assertion added that core is outside the scan.
- **`tool-surface.test.ts` widened to two scans** ✅ what it guards is "certain
  commands can never be reached by the model", and a package's tool could have
  walked right past it. The source list is shared with the script
  (`scripts/tool-sources.mjs`), so the two cannot possibly disagree about what
  counts as a source.
- **New subpath purity** ✅ `/view` and `/mcp-tools` previously had **no guard at
  all** (`manifest-purity` only covers `/manifest`). The newly written
  `subpath-purity.test.ts` differs from it in one respect: **it follows relative
  imports recursively**, instead of banning relative imports outright the way
  manifest does. The ban was always a stand-in for this — `view.ts` needs
  `./graph`, and stuffing the Cypher assembly into core to pass a test has it
  backwards.
- **Packaged output** ✅ in the main chunk `grep neo4j-driver` = **0 hits**,
  `grep expand_node` = **1 hit**: the tool is compiled in, the Bolt client is not.
- **End to end** ✅ `PASS neo4j 5 node(s); scanned "PeekSmoke" → 3 row(s); graph
  view → 6 row(s); expand_node ok`. That last segment is this step's only real
  proof: **a tool declared inside a package went into the same registry as the
  kernel's 13, was called from the same endpoint, and landed on `view.update`**. A
  wrong collection seam reports an unknown tool, a wrong mapping errors the view,
  and both fail right here. (`elementId` is assigned by the server, so the script
  probes one out with `run_query` before calling — a fixture cannot supply that
  value.)

**Known costs of this step, recorded and not solved:**

- **Skill prose goes into the renderer chunk.** About 3.5 KB. The window imports
  the manifest for the sake of the connect form, and the skill grows on the
  manifest, so text only main will ever read comes into the window with it. Inside
  605 KB it is noise; on the day it does need managing, the move is to open one
  more `/skill` subpath — but that is a third "place that gets forgotten", and it
  is not worth it today.
- **The general `update_view` gap is not filled** (§2.4bis(e) item 2). Once it is,
  MCP will be able to change a graph view and not a table view. That asymmetry is
  written down, not created.

**Must hold when Phase B ends:**

1. `pnpm typecheck` / `pnpm test` fully green, with **not one existing test allowed
   to change** (a change means the seam changed behaviour rather than only
   position). The live-server suites (pg / mysql / sqlite / redis / qdrant) all run
   as before.
2. `verify-chat-security.mjs` still passes after the rewrite, and **the new
   assertion has a reverse verification**: fake a tool name that is in no
   registered source, and the script has to fail.
3. The renderer chunk size baseline (571,660 B, see boundary doc §4.3) shows no
   order-of-magnitude change.

   **Measured (2026-08-03, after Phase B steps 1, 2 and 4): 571,660 → 597,160 B,
   +25,500 (+4.5%).** The source is what was added on the window's side —
   `PluginFrame` (the iframe host plus the port handshake plus snapshot packing),
   the view-kind registry, the databases section in settings, neo4j's manifest and
   connect form. **No database client is included**: `grep neo4j-driver` is 0 hits
   in the chunk (`bolt://` appears twice, as the placeholder in the manifest and as
   `endpointSummary`'s template, not as a client). The plugin's own interface is
   **another chunk**, 15,484 B, served over `peek-plugin://`, with not one byte of
   it inside the window — which is exactly what §2.6's "two Rollup graphs cannot
   possibly share a chunk" was buying.
4. **Full validation at registration has a reverse verification**: register a view
   kind missing `autoFetch`, and it has to be refused at startup with a report of
   what is missing — rather than opening the view and silently fetching nothing.
5. Redaction under decision 5 is broadcast-as-is, so **what has to be verified is
   that the warning is loud**: load a plugin with no `redact` block, and the error
   centre has to show a record saying that this connection's config goes out as it
   stands. Silence is what is unacceptable; broadcasting as-is is the chosen
   behaviour.

**Performance, against the measured baseline (PLAN §8.1) rather than a feeling:**

6. **Run `bench-scroll.mjs` against a view declared through Tier A**, on the same
   million-row fixture. Dropped frames > 0, p95 frame work > 0.30ms, or the
   `.grid-surface` element count falling outside 279–369 — any one of them
   falsifies it.
7. **`bench-startup.mjs` with 0 versus 20 plugin manifests installed.** A median
   ready-to-show shift of > 20ms counts as a signal (baseline 518ms / min 481 / p95
   566; anything inside 20ms is noise).
8. **Write `bench-plugin-frame.mjs`**: reuse the "dispatch a wheel → read
   `surface.offsetHeight` to force a flush" passage from `bench-scroll.mjs`, driven
   into the iframe's interior over CDP. A p95 above 0.30ms inside the iframe
   falsifies it.
9. ~~**The clone cost of fan-out — the number in this document most likely to be
   wrong.**~~ **Not applicable (§2.6bis).** What this item was to measure is the
   cost of "one extra clone per `ChunkFrame` for the plugin", and the
   implementation changed to a one-shot bounded snapshot
   (`PLUGIN_MAX_ROWS = 2000`) in which the plugin does not subscribe to
   `result-stream`, so **that overhead never happens** and there is nothing left to
   measure. What replaces it as acceptance: with a Tier C view open, `run_query`'s
   wall clock is **equal within noise** to the same fixture with no plugin; and the
   `truncated: true` path has a reverse verification (the field has to be true when
   a result exceeds 2000 rows, and the plugin's interface has to carry a visible
   hint). Restoring the streaming path means measuring this item as originally
   written first — do not get around it by raising `PLUGIN_MAX_ROWS`.
10. **Kill-switch reverse verification**: a Tier C plugin busy-looping for 50ms
    inside rAF has to be disabled automatically, and the host's dropped-frame count
    has to still be 0.

**Must hold when Phase C ends:**

11. Installing a package from outside the repository connects to a new database,
    without repackaging the app.
12. `PEEK_DRIVER_HOST_DIR` has validation (§2.7).
13. After a plugin is uninstalled, the tools, views and skill it contributed all
    disappear, and an already-open view of that kind has a defined degradation
    (not a blank screen).

**Existing defects to fix along the way** (they depend on no decision, and the
sooner the better):

14. `asStreamMessage` at `resultCache.ts:662` **does not validate**
    `cols.length === schema.length`, nor that each column's length equals
    `rowCount`, while the contract at `chunk.ts:73` requires both. The consequence:
    a short column returns `undefined` at `:367` and is painted as NULL by
    `format.ts` — **a frame in breach of the contract is indistinguishable on
    screen from a genuine NULL cell**. There is one trusted producer today, so it
    gets away with it; with plugins it will certainly be hit. **This has to be
    filled in before a second producer of frames is introduced.**
