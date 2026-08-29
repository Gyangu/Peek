# The driver package's boundary: the connector moves in, the other three do not

> 2026-08-03. It started with a question: "is one database type one package? Can
> one package hold the connector, the interface renderer, the MCP controller, even
> the data editor?"
>
> The answer is half of it. This document first measures the actual shape of that
> half, then writes out the trade-offs between three routes, and lands on the one
> that was chosen. **It conflicts head-on with `PLAN.md` §4, and the conflict is
> written down in §1.3.**

---

## 1. What this fixes

### 1.1 Where things stand: the layering axis is capability, not database

| layer | where | cut by what |
|---|---|---|
| connector | `packages/db-*`, 4 packages / 5 drivers | **by database** |
| interface renderer | `apps/desktop/src/renderer/components/views/` | by `ViewState.kind` |
| MCP controller | `apps/desktop/src/main/mcp/tools/`, 13 generic tools | by Command |
| data editor | does not exist | — |

`ViewHost.tsx` dispatches on `view.kind` into six view components, and not one of
the six knows which database it is facing. The same holds for MCP's 13 tools —
they are thin shells over Commands, and the Command schema in `core/commands.ts`
does not recognise a driverId either. This is not an oversight; it is the settled
design in §1.3.

The data editor does not exist: `PLAN.md` §10 "still undecided" records "writes
(UPDATE/DELETE/SET): once the read-only path is stable, add a confirmation
mechanism and open it up", noting that "the conditions are close but not met".

### 1.2 "A package plus a line" is what the comment says; it is 15 places

The comment at `driver-host/entry.ts:19` says:

> Adding a database is therefore one more entry in this array plus one row in
> `connections/registry.ts` — the whole of "adding a database is a package plus a
> line".

Count them and it is not so. What adding a database has to change:

**`packages/core/src/capability.ts` — seven places, every one a switch or table
needing one more branch**

| line | symbol | shape |
|---|---|---|
| `:30` | `DRIVER_IDS` | a literal array, the source of the `DriverId` type |
| `:40` | `DRIVER_CAPABILITIES` | `Record<DriverId, Capability[]>` |
| `:116` | `ConnectionConfigSchema` | a zod discriminated union; one more branch schema |
| `:147` | `redactConnectionConfig` | a 5-branch switch |
| `:186` | `defaultConnectionLabel` | a 5-branch switch |
| `:222` | `connectionDetail` | a 5-branch switch |
| `:316` | `connectionIdentity` | a 5-branch switch |

Plus, possibly, a new `CollectionRef` kind and `BROWSE_STYLE:595` (only when the
new database's browsing semantics fall outside the three existing kinds).

**`apps/desktop/src/main` — three places**

`DRIVER_REGISTRY` in `connections/registry.ts`, the drivers array in
`driver-host/entry.ts`, and the endpoint-copy switch at `mcp/summary.ts:157`.

**`apps/desktop/src/renderer` — three places**

The `CONNECT_FORMS` table in `components/connectForm.ts` together with
`assemble:349`'s 5-branch switch, `dialectOf` at `components/SqlEditor.tsx:97`,
and `i18n/messages/{en,zh-CN}/sidebar.ts` (only when a new field name is
introduced).

**The build — two places**

One line of `electron.vite.config.ts`'s `peekAlias`, one dependency line in
`apps/desktop/package.json`.

**15 places in all, seven of them inside the frozen contract.** That is the
quantified form of "independently extensible and upgradable" not being true
today.

### 1.3 The conflict with PLAN §4 — this round's alignment

`PLAN.md` §4, verbatim:

> Peek does not flatten every database into a lowest common denominator. Each
> driver declares a capability set, and the UI and MCP tools adapt themselves by
> capability.

`capability.ts:519` even argues specifically why browsing semantics are keyed on
`CollectionRef['kind']` rather than declared by the driver:

> Two drivers browsing the same kind browse it the same way — that is what makes
> the kind worth having — so a per-driver answer would be the same answer written
> five times.

**"One package per database, holding the connector + the renderer + the MCP
controller + the editor" runs the other way**: the former divides by driver, the
latter by capability. Both cannot be the main axis at once.

The alignment's result: **keep §4's capability axis; do not overturn it**. The
reasoning is in §3.1. But §1.2's 15 places are a real problem, so what this round
changes is **something else** — moving "behaviour that belongs to a particular
database" out of the app and out of core and into the package, without touching
the "dispatch by capability" axis.

### 1.4 Noticed along the way: the capability declaration points the wrong way

`PLAN.md` §4 says "each driver declares a capability set". The code has it
backwards: `DRIVER_CAPABILITIES` at `core/capability.ts:40` declares every
driver's capabilities, and then **the five driver packages each import it back**
as their own single source of truth —

```
packages/db-postgres/src/driver.ts:20   new Set(DRIVER_CAPABILITIES.postgres)
packages/db-redis/src/driver.ts:20      new Set(DRIVER_CAPABILITIES.redis)
packages/db-qdrant/src/driver.ts:20     new Set(DRIVER_CAPABILITIES.qdrant)
packages/db-sql/src/driver.ts:30,40     new Set(DRIVER_CAPABILITIES.mysql / .sqlite)
```

The package cites core's description of it rather than describing itself. The
contract tests (each package's `contract.test.ts`) assert "the package equals
core's table", so the loop is self-consistent — but it closes in the wrong
direction. §2.5 deals with it.

### 1.5 Boundary (explicitly not done)

- **Do not touch the frozen zod unions of `ViewState` / `Command`.** View kinds
  and the command set are still defined by core, and a driver package cannot add a
  view kind or an MCP tool. The point is in §3.1.
- **Do not touch `ViewHost`'s dispatch by kind**, and do not split `TableView`
  across five packages.
- **Do not make `DriverId` an open string.** The reasoning is in §3.3.
- **Do not introduce runtime pluggability (third-party packages installed by the
  user).** This round is only the package boundary inside the repository: no
  loader, no version negotiation, no sandbox.
- **Do not implement the data editor this round**, only fix where its interface
  goes (§2.6).

---

## 2. The plan: a driver manifest — a subpath entry with zero runtime dependencies

### 2.1 The core idea

Every driver package gains a subpath entry `@peek/db-x/manifest`, exporting a
**`DriverManifest`**: a description made of pure data and pure functions that
**imports no database client**. Both the renderer and main can import it without
dragging `pg` / `redis` / `mysql2` into their chunks.

```ts
// packages/core/src/manifest.ts — the type in core, the instances in the driver packages
export interface DriverManifest<K extends string = string, C extends ConnectionConfig = ConnectionConfig> {
  driverId: DriverId
  /** The display name in the connect dialog and the sidebar: 'PostgreSQL' */
  displayName: string
  /** What this database declares it can do (direction corrected, see §1.4 / §2.5) */
  capabilities: readonly Capability[]
  /** The shape of the connect form (formerly that entry in CONNECT_FORMS) */
  connectForm: ConnectFormSpec<K>
  /** Form values → a config draft (formerly that branch of assemble) */
  assembleConfig(mode: ConnectMode, values: ConnectFormValues, label: string): Record<string, unknown>
  /** The dialect id the SQL editor highlights by — a plain enum, not a CodeMirror object */
  sqlDialect?: SqlDialectId
  /** The one-line endpoint text in the MCP summary (formerly that branch of summary.ts:157) */
  endpointSummary(config: C): string
  /** The one connection example in the MCP instructions */
  mcpConnectExample: string
}
```

The two type parameters each do a job: `K` is the message catalogue's key type
(§2.4), and `C` is the one config branch this driver recognises — the dispatching
functions look a manifest up by `config.driverId`, so a manifest never receives
another driver's config, and declaring `endpointSummary` with method syntax
(bivariant parameters) lets every package write its own branch without narrowing
the union again by hand.

**`configSchema` was dropped during implementation.** §3.4 originally meant to
hold a reference "pointing at that branch of the schema in core"; halfway through
writing it, it turned out to have no consumer: `validateConnectionConfig` parses
**the whole discriminated union**, `driverId` picks the branch by itself, and the
per-driver reference is never used once. Keeping it would only make trouble for
zod's type variance and buy no check at all. The reasoning is recorded in the
`validateConnectionConfig` comment in `connectForm.ts`.

### 2.2 Why it has to be a subpath entry rather than the main entry

Three processes, three dependency boundaries:

| process | chunk today | may it touch a database client |
|---|---|---|
| driver-host (utilityProcess) | `driver-host.js`, 2.2MB minified | yes, that is what it exists for |
| main | `index.js`, 175KB | it should not |
| renderer (sandboxed) | `index.js`, 564KB | **never** |

`@peek/db-postgres`'s main entry imports `./driver` → `pg`. Let the renderer so
much as touch the main entry and `pg`, along with its `pg-native` stub, is in the
window's chunk. So the manifest has to be **a separate file that does not go
through `src/index.ts`**: `packages/db-postgres/src/manifest.ts`, importing only
`@peek/core` and `zod`, both of which the renderer already has (see the measured
note at `connectForm.ts:295`).

`package.json` gains an exports subpath:

```jsonc
"exports": {
  ".":         { "types": "./src/index.ts",    "default": "./src/index.ts" },
  "./manifest":{ "types": "./src/manifest.ts", "default": "./src/manifest.ts" }
}
```

### 2.3 The build: the alias order matters (measured)

`electron.vite.config.ts`'s `peekAlias` is an exact path mapping
(`'@peek/db-postgres' → .../src/index.ts`). The matching rule of
`@rollup/plugin-alias@5.1.1`, which Vite inlines, is
(`vite/dist/node/chunks/config.js:8109`):

```js
function matches$1(pattern, importee) {
  if (pattern instanceof RegExp) return pattern.test(importee);
  if (importee.length < pattern.length) return false;
  if (importee === pattern) return true;
  return importee.startsWith(pattern + "/");   // ← prefix match
}
```

Which is to say the `'@peek/db-postgres'` alias **does match**
`@peek/db-postgres/manifest`, rewriting it to
`.../packages/db-postgres/src/index.ts/manifest` — a path that does not exist —
and its failure mode is the top-of-chunk throw of the
"`assertNoUnresolvedImports`" kind.

`getEntries` preserves order via `Object.entries`, and `@rollup/plugin-alias`
takes the **first** rule that matches. So **the subpath aliases must come before the bare
package name**:

```ts
const peekAlias = {
  '@peek/db-postgres/manifest': resolve(repoRoot, 'packages/db-postgres/src/manifest.ts'),
  // …the other four manifests…
  '@peek/core':            resolve(repoRoot, 'packages/core/src/index.ts'),
  '@peek/db-postgres': resolve(repoRoot, 'packages/db-postgres/src/index.ts'),
  // …
}
```

`PEEK_BUNDLED` takes `Object.keys(peekAlias)`, so the subpath entries come along
with no special handling.

### 2.4 i18n does not move into the packages — a real limitation, written down

`ConnectField.labelKey` is a `PlainMessageKey` today: the union of the catalogue's
keys that **carry no interpolation parameters** (`connectForm.ts:16`). That
narrowing is worth having — it makes `t(field.labelKey)`, a call the compiler
cannot see statically, type-safe.

And field labels are almost all **shared vocabulary**: `connect.field.host` /
`.port` / `.password` are common to all five databases, and only `.db` (redis's
logical database number) and `.qdrantUrl` belong to one. So:

- **The translation catalogue stays in the renderer** and does not move into the
  packages. Having a package carry its own translations means dragging the i18n
  runtime and two language catalogues into every driver package, for two keys.
- The `labelKey` in a manifest is **a reference into the shared catalogue**. The
  core-side type is widened to `string`, and the renderer narrows it back when it
  collects them.

#### `satisfies` does not hold the literal — measured, and the approach changed

What was written here originally was "the package uses `satisfies DriverManifest`
and the literals are kept". **That is wrong**, as measuring during implementation
showed:

```ts
interface Field<K extends string = string> { labelKey: K; type: 'text' | 'password' }
const m = { fields: [{ labelKey: 'a', type: 'text' }] } satisfies Spec
const ok: Spec<'a' | 'b'> = m
//    ^ error TS2322: Type 'string' is not assignable to type '"a" | "b"'
```

What `satisfies` supplies is a **contextual type**, and a string literal annotated
by a `string` context widens. The insidious part is that **its sibling fields in
the same object do not**: `type: 'text'`'s contextual type is
`'text' | 'password'` (a literal union), so it keeps its literal. The file reads
as perfectly normal, only `labelKey` has quietly become `string`, and the check
"passes" as usual — over the empty set.

Use a **`const` type parameter** instead (TS 5.0+; the repository is on 5.9):

```ts
// packages/core/src/manifest.ts
export function defineManifest<const K extends string, C extends ConnectionConfig>(
  manifest: DriverManifest<K, C>,
): DriverManifest<K, C> { return manifest }
```

```ts
// packages/db-redis/src/manifest.ts
export const redisManifest = defineManifest({ … })
```

```ts
// apps/desktop/src/renderer/components/connectForm.ts
// this line is the check itself
const MANIFESTS: readonly DriverManifest<PlainMessageKey>[] = DRIVER_MANIFESTS
```

A side benefit: `defineManifest` validates the whole object **at the point of
declaration**, so a package does not have to wait for the app to collect it to
find out it got something wrong.

`DRIVER_MANIFESTS` (§2.5's collecting array) therefore **must not carry a type
annotation** — an annotation widens just the same. That is the third way of
turning the check into a no-op, and all three compile, so `defineManifest`'s
comment lists them all.

**Measured, and it does bite**: change redis's `connect.field.host` to
`connect.field.hostname` and the package's own typecheck **passes** (core-side
`K = string`, so it should), while desktop's typecheck reports:

```
src/renderer/components/connectForm.ts(64,7): error TS2322:
  Type '"connect.field.hostname"' is not assignable to type 'PlainMessageKey'.
    Did you mean '"connect.field.host"'?
```

**The cost, stated plainly**: this only governs **en** — `PlainMessageKey` is
inferred from the English catalogue. A key that en has and zh-CN does not compiles
fine, and Chinese users see an English label. So §4's `manifest-labels.test.ts` is
not a supplement; it is the half this check cannot reach.

### 2.5 What moves out of core and what stays

**Moved into the packages** (one copy per driver, five in all):

- That row of `DRIVER_CAPABILITIES` → `manifest.capabilities`. This is the
  correction of §1.4's backwards loop: the package declares its own capabilities,
  and `driver.ts` reads from **its own manifest** rather than importing back from
  core. The contract test changes with it, to "`driver.capabilities` equals **this
  package's manifest**".
- That entry of `CONNECT_FORMS` plus that branch of `assemble` →
  `manifest.connectForm` / `assembleConfig`.
- That branch of `summary.ts:157` → `manifest.endpointSummary`.
- That branch of `SqlEditor.dialectOf` → `manifest.sqlDialect` (the id only;
  CodeMirror's `PostgreSQL` / `MySQL` / `SQLite` objects are still looked up by id
  in the renderer — that is the renderer's dependency and does not belong in a
  driver package).

**Staying in core, not moved** (this one is a revised plan, after checking):

The four switches `redactConnectionConfig` / `defaultConnectionLabel` /
`connectionDetail` / `connectionIdentity` **stay in `capability.ts`**. Not out of
convenience, but because of dependency direction:

```
packages/core/src/workspace.ts:938   const config = redactConnectionConfig(c.config)
packages/core/src/workspace.ts:942   label: c.label || defaultConnectionLabel(config)
```

`snapshotWorkspace` calls them **from inside core**. Moving them into the packages
means core has to be able to look a manifest up, while the driver packages depend
on core — the dependency graph would invert. The alternative is to give
`snapshotWorkspace` a redactor/labeler parameter that every call site brings along;
`snapshotWorkspace` is the shared entry point for MCP's `read_workspace` and for
the ACP context, so that turns a pure function into one that needs external
injection, in order to move four switches. Not worth it.

The `ConnectionConfigSchema` discriminated union stays in core for the same
reason: the `configSchema` field is a **reference** to that branch in core, not a
second definition (the same device as `registry.ts:29` referencing
`DRIVER_CAPABILITIES` rather than restating it — that comment is right, only its
reference direction is backwards).

`DRIVER_CAPABILITIES` is **deleted from core entirely**, rather than left as a
mirror (§2.7 originally recorded "annotate as a mirror or delete, see §4 for the
decision" — the decision is delete). Keeping it would still be §1.4's backwards
loop, with one more comment attached. That spot in `capability.ts` is now a note
explaining why the table is not there and where it went.

`connections/registry.ts` is no longer a hand-edited place either: it is now
**derived from the manifests** (`Object.fromEntries(DRIVER_MANIFESTS.map(…))`),
and the five nearly identical literals are gone.

**The result**: adding a database goes from 15 places to 7, and all seven are
one-liners:

| place | what |
|---|---|
| 1 | the new package plus its `manifest.ts` |
| 2 | one more literal in `core/capability.ts`'s `DRIVER_IDS` |
| 3 | one more config schema in `core/capability.ts`, into the union |
| 4 | one more branch in each of core's four switches — **compiler-enforced**, since `DriverId` is a closed union and a miss does not compile |
| 5 | one entry in `driver-host/entry.ts`'s drivers array |
| 6 | two alias lines in `electron.vite.config.ts` (the package plus the manifest) |
| 7 | one dependency line in `apps/desktop/package.json` |

Item 4 is still four switches, but they are **pure display logic**, and the
compiler forces each of them out one by one — a different thing from the old
"scattered across renderer and main, compiles fine when missed, discovered on
arrival". `registry.ts` is not in the table because it grows itself.

### 2.6 The data editor: a new capability, not a new layer

Where the editor sits within this boundary is clear; fix it now and implement it
in another round:

- `CAPABILITIES` gains `'mutate'`. Which databases have it is declared by their own
  manifests.
- **"How an edit becomes a write" goes into the driver package**: a relational
  database does `UPDATE … WHERE pk`, redis does `HSET` / `SET`, qdrant does a point
  upsert. Those three have no common factor, which is exactly the part the package
  should take.
- **The editor's interface does not go into the package**: cell editing lands in
  `TableView`, key-value editing in `InspectorView`, dispatched by
  `CollectionRef.kind` — the same axis as browsing. The reasoning is
  `capability.ts:519`'s: editing interactions within one kind are one set.
- Commands go through `data.mutate` (a new Command, defined in core), with
  confirmation and rollback semantics designed separately, under `PLAN.md` §10's
  pending item. **Not this round.**

### 2.7 The list of changes

The list as it actually landed (differences from the estimate marked †):

```
packages/core/src/manifest.ts                       new    DriverManifest / defineManifest / ConnectFormSpec /
                                                           ConnectField / ConnectMode / SqlDialectId /
                                                         † formReaders / readFormText / definedField / urlField
packages/core/src/index.ts                          change export manifest
packages/core/src/capability.ts                     change † delete DRIVER_CAPABILITIES, leave a note in its place
packages/db-{postgres,redis,qdrant}/src/manifest.ts   new
packages/db-sql/src/manifest.ts                 new    two of them: mysqlManifest / sqliteManifest + sqlManifests
packages/db-*/package.json                      change exports gains ./manifest
packages/db-*/src/driver.ts                     change meta.displayName + capabilities read from this package's manifest
packages/db-*/src/session.ts                    change † the same (under-estimated: a session holds a capability set of its own too)
packages/db-*/src/index.ts                      change † the header comment's "core is the single source of truth" is backwards; fixed
packages/db-*/src/__tests__/contract.test.ts    change the assertion now targets this package's manifest
apps/desktop/src/drivers/manifests.ts               new  † the five collected. **Not under renderer/** — main needs them too,
                                                           and putting them in renderer means the main process imports the renderer
apps/desktop/src/renderer/components/connectForm.ts change delete CONNECT_FORMS and assemble; PlainMessageKey narrows here
apps/desktop/src/renderer/components/SqlEditor.tsx  change dialectOf becomes a lookup by manifest.sqlDialect
apps/desktop/src/renderer/components/ConnectDialog.tsx change † the capability list goes through driverCapabilities()
apps/desktop/src/renderer/state/capabilities.ts     change static capabilities come from the manifests
apps/desktop/src/main/connections/registry.ts       change the whole table derived from the manifests
apps/desktop/src/main/mcp/summary.ts                change delete the switch, use endpointSummary
apps/desktop/src/main/mcp/instructions.ts           change the connection example becomes **one line per database**, from mcpConnectExample
apps/desktop/src/main/mcp/tools/list-connections.ts change † driverCapabilities becomes a function call
apps/desktop/src/main/bus/handlers/conn.ts          change † the predicted capabilities go through driverCapabilities()
apps/desktop/src/main/bus/__tests__/{driver-registry,deadline-escalation}.test.ts change †
apps/desktop/src/renderer/state/__tests__/capabilities.test.ts change †
apps/desktop/src/main/driver-host/entry.ts          change † the header comment's "a package plus a line" is false; replaced with the real number
apps/desktop/electron.vite.config.ts                change four subpath aliases, **ahead of the bare package names**
```

The † worth remembering most is where the collecting file went. The estimate said
`renderer/components/manifests.ts`, but main needs it too (the connection book's
display names, MCP's endpoint line), and the renderer importing `src/main/` is the
classic route by which Electron gets into the window. It belongs to neither main
nor renderer, so it lives outside both, in `src/drivers/`.

---

## 3. Trade-offs

### 3.1 Fully pluggable (one package per database, holding all four) — not chosen

To get "a package that can add views and MCP tools", `core/commands.ts`'s
`ViewState` and Command discriminated unions have to stop being **frozen zod
unions** and become **an extensible registry**. That drags along:

- patch broadcasting, `workspace.ts`'s state machine and `ipc.ts`'s validation all
  lose the static exhaustiveness a zod discriminated union gives — and that
  exhaustiveness is exactly what `capability.ts:527` means by
  "`Record<CollectionRef['kind'], …>` failing to compile is the point, not an edit
  someone can forget".
- one package would have to produce artifacts for three processes (three sets of
  externals: renderer/main/utilityProcess), turning the dependency boundary from
  "package vs package" into "subpath entry vs subpath entry inside one package",
  where importing `pg` by mistake once doubles the renderer chunk with no
  compile-time signal.
- the benefit is limited: only 3 places in the renderer branch on the driver today.
  Moving `TableView` into five packages means five copies.

Conclusion: **most of this route's cost is spent overturning §4, and what §4 buys
(exhaustiveness, UI reuse) is being cashed in right now.** What actually hurts is
§1.2's 15 places, and those 15 can be treated without overturning §4.

If **third-party drivers from outside the repository** (a package the user
installs) ever have to be supported, this route becomes necessary — and what would
then have to be solved is the loader, version negotiation and the sandbox, which
is a different question from this round's. The manifest is the first step down
that road rather than a substitute for it: when a pluggable architecture is
really built, `DriverManifest` is exactly the embryo of the package manifest.

### 3.2 Do nothing — not chosen

Seven of §1.2's 15 places are in the frozen contract, and among them four
switches (label/detail/identity/redact) and three tables on the UI side (the
connect form, the dialect, the endpoint copy) have **no compiler enforcement** —
`CONNECT_FORMS` is a `Record<DriverId, …>` and does enforce, but
`SqlEditor.dialectOf` has a `default:` fallback, and missing the `summary.ts`
branch merely degrades the copy. A new database silently shipping half its
functionality is possible.

### 3.3 Making `DriverId` an open `string` — not chosen

This is the necessary condition for "genuinely independent extension" (adding a
database without touching core), but the price is that every `switch (driverId)`
and `Record<DriverId, …>` above loses its exhaustiveness check,
`ConnectionConfigSchema` stops being a discriminated union, and
`redactConnectionConfig` degrades into "return an unrecognised driver's config as
it is" — **an unrecognised driver would broadcast the password verbatim to MCP**.

`PLAN.md` §10's "deliberately not done" already carries a related entry:
`DRIVER_REGISTRY` stays a `Partial<Record>` rather than a full `Record`, on the
grounds that it "sacrifices 'a driver may be finished before it is listed'". Same
direction: **a closed union is this codebase's safety net, and the manifest's
purpose is to reduce the number of places to fill in, not to cancel the
compiler's enforcement.**

### 3.4 A zod schema in the manifest, or plain data

A **reference**: `configSchema` points at the schema branch that already exists in
core, rather than defining it again inside the package. The measured note at
`connectForm.ts:280` explains why — a hand-written mirror table is larger
(+1,868 B) than using the schema directly, and it drifts. The manifest only writes
down "which branch is mine" inside the package.

---

## 4. Verification — measured results

### 4.1 Compile time

```bash
pnpm typecheck
```

**All 6 packages green.** Three assertions rest on the type system itself:

1. `connectForm.ts`'s `MANIFESTS: readonly DriverManifest<PlainMessageKey>[]` — any
   manifest using a key the catalogue does not have, or a key that takes
   interpolation parameters, fails to compile here.
2. If a package swaps `defineManifest(…)` for a `: DriverManifest` annotation or a
   `satisfies`, the literals widen and assertion 1 **silently stops working** (not
   fails — see §2.4; this is the most fragile part of the arrangement, which is why
   `defineManifest`'s comment lists all three spellings).
3. Adding an id to `DRIVER_IDS` without filling in the four switches →
   `capability.ts` fails to compile.

**Assertion 1 was measured** (verified in reverse, not reasoned about): change
redis's `connect.field.host` to `connect.field.hostname` —

| | result |
|---|---|
| `packages/db-redis` typecheck | **passes** (correct: `K = string` on the core side, and the package has no way to know the catalogue) |
| `apps/desktop` typecheck | **fails**, `connectForm.ts(64,7)`, naming `"connect.field.hostname"` and suggesting `Did you mean "connect.field.host"?` |

### 4.2 Tests

**All 1557 cases across 6 packages green** (core 56 / redis 37 / qdrant 38 /
postgres 53 / sql 83 / desktop 1290).

| test | what it asserts |
|---|---|
| `packages/db-*/src/__tests__/contract.test.ts` | rewritten: `driver.capabilities` equals **this package's manifest** (the direction corrected, §1.4) |
| `bus/__tests__/driver-registry.test.ts` | rewritten. It used to assert "the registry == `DRIVER_CAPABILITIES`'s keys", and that table is gone; it now asserts **every id in `DRIVER_IDS` has a package** (which is the direction that goes wrong: the id is added in core, the package is forgotten, and the whole repository compiles), plus that the registry takes its entries from the manifests **by reference** |
| `bus/__tests__/deadline-escalation.test.ts`, `state/__tests__/capabilities.test.ts` | switched to `driverCapabilities()` |
| `components/__tests__/connect-form.test.ts` | **not one line changed**, all passing — the form's behaviour is unchanged word for word, which is the piece of evidence this round wanted most |
| new `manifest-purity.test.ts` | scans the four `manifest.ts` sources: imports may only be `@peek/core` / `zod`, and relative paths are refused outright (a scan cannot see through `./driver`); and asserts the `./manifest` subpath exists in all four `package.json`s |
| new `manifest-labels.test.ts` | every `labelKey` exists in the catalogue of **every language**; field names are unique within one mode; every mode has at least one field; `mcpConnectExample` is valid JSON, self-consistent about its driverId, and carries no credentials (including inside a URL's userinfo) |

Both new guards were **verified in reverse**, to confirm they are not no-ops:

- adding `import type { Pool } from 'pg'` to `db-postgres/src/manifest.ts`
  → `manifest-purity` fails.
- deleting `connect.field.db` from the zh-CN catalogue → `manifest-labels` fails
  (while the en-side type check passes as usual — which is precisely why it
  exists).

### 4.3 The build

```bash
pnpm build
```

Passes, with no `assertNoUnresolvedImports` warning (§2.3's alias order is right).
Sizes:

| artifact | before | after | delta |
|---|---|---|---|
| renderer index | 563,734 | **571,660** | +7,926 (+1.4%) |
| renderer SqlEditor | 433,995 | 433,870 | −125 |
| main index | 175,091 | 209,410 | +34,319 |
| main chunks/manifest (new, shared with driver-host) | — | 47,010 | +47,010 |
| main driver-host | 2,192,870 | **2,039,230** | **−153,640** |

The renderer's 7.9 KB of growth is the five forms' data itself, landing inside
§4.3's estimate of "a few KB" rather than "a few hundred KB". driver-host is
smaller by 153 thousand bytes instead: core was hoisted into a shared chunk, and
the main-process side's total (209 + 47 + 2039 = 2295 KB) is smaller than before
(175 + 2193 = 2368 KB).

Size is indirect evidence, so **the chunks were inspected directly**. Grepping the
renderer index for twelve client-specific strings (`pg-native` / `pgpass` /
`SET application_name` / `@qdrant` / `mysql2` / `caching_sha2_password` /
`createClient` / `OBJECT ENCODING` / `MEMORY USAGE` / `reltuples` / `node:net` /
`node:tls`) gives **0 hits for all twelve**; meanwhile
`postgresql://user@localhost:5432/database`, `connect.field.qdrantUrl` and
`/absolute/path/to/db.sqlite` are all present — the manifest data arrived, and not
one byte of any client did.

### 4.4 By hand (not yet run)

Four things that still need a person to look at once it is running:

1. Switch through all five drivers in the connect dialog; fields, defaults and the
   mode selector match what they were before.
2. Edit a saved postgres connection (the `valuesFromConfig` path), change the port,
   and reconnect successfully.
3. Open a mysql query view and confirm the SQL highlighting is still the MySQL
   dialect and not StandardSQL.
4. MCP `list_connections`'s `driverCapabilities` content matches what it was before
   (key order included: `DRIVER_MANIFESTS` is ordered postgres / mysql / sqlite /
   redis / qdrant, the same as the old `DRIVER_CAPABILITIES`).

### 4.5 One **behaviour change**, not a pure refactor

The connection example in `MCP_INSTRUCTIONS` used to be one hardcoded postgres
line; it is now five lines generated from the five `mcpConnectExample`s. The old
one amounted to saying "postgres is the one you can connect to", leaving a client
that wanted redis or qdrant to guess the field names. The change is small, but it
does change the text the model sees, so it is recorded here rather than mistaken
for a side effect of a refactor.

### 4.6 Documentation

`PLAN.md` §4 and §11.2 are updated to match; the "a package plus a line" sentence
in `driver-host/entry.ts`'s header comment is rewritten with §2.5's real numbers.
