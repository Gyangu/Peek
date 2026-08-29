# Every kind of thing a package can contribute goes on one roster

> 2026-08-11. Following
> [`2026-08-07-database-packages-from-disk.md`](2026-08-07-database-packages-from-disk.md)
> §4duodevicies — that section fixed "`expand_node` is still in `tools/list` after
> uninstalling neo4j", and this document deals with **the shape of that gap**
> rather than that one instance of it.
>
> **No behaviour changes.** What the three tables filter out today is exactly what
> they filter out afterwards; what changes is *where the filtering is written*,
> and whether a fourth kind of contribution can get away with not writing it.

---

## 1. What this fixes

### 1.1 The same gap has opened twice already

Three tables under `apps/desktop/src/drivers/` filter by "installed packages":

| table | the compile-time half | where the gate is |
|---|---|---|
| `manifests.ts` | gone (decision 1 deleted `DRIVER_MANIFESTS` outright) | `driverManifests()` reads the registry directly |
| `viewKinds.ts` | `VIEW_KIND_CONTRACTS`, four functions needed by each of two processes | one `filter` inside `installedViewKindContracts()` |
| `mcpTools.ts` | `PACKAGE_TOOL_META` plus `mcpToolSpecs.ts`'s mapping, only inside the package host | `main/mcp/package-tools.ts` reads `installedTools()` |

All three files' header comments talk about "which half went to disk and which
half is still compiled in", and read as one mechanism. **But the gate is written
separately each time, and at three different layers**: one in the reading
function, one in a join function in the same directory, and one under
`main/mcp/`. Before §4duodevicies the third did not exist at all — and from
outside, the three tables look identical.

### 1.2 What gaps of this kind have in common

**Everything is right on install, and wrong on uninstall.**

Installing: did the new thing appear? Visible at a glance — is that database in
the connect dialog, is that tool in `tools/list`. Anybody glancing at it performs
a verification.

Uninstalling: did the old thing disappear? **Nothing is watching.** The
compile-time half is still in the process and still looks like an answer, so the
app goes on offering an option that connects to nothing. This is what
§4sedecies(b) measured: the package is out of `~/.peek/packages/`, the tombstone
is written, and `expand_node` is still there.

**Every test is written around installing**, so that direction has no witness.

### 1.3 Boundary: what this does not do

- **No behaviour changes.** `VIEW_KIND_CONTRACTS`'s contents are untouched, so is
  `PACKAGE_TOOL_META`, and so is main's line reading `installedTools()`.
- **No fourth contribution key on `PackageManifestSchema`.** Whether skills or
  context menus should be contributed by packages is a separate decision; this
  document only guarantees that when that decision is made, the gate cannot be
  missed.
- **`mcp-tool-halves.test.ts` and `view-kind-halves.test.ts` are untouched.** They
  ask a different question (do the declaration and the mapping match), and they
  keep asking it.

---

## 2. The plan

### 2.1 `contribution.ts` — the filter is written once, in the factory

```
PackageContributionGate      declaredIn / what / declaredKeys() / liveKeys()   — no type parameter
PackageContribution<Live>    extends Gate, adding live()
definePackageContribution(spec)
```

A `spec` supplies four things: `declaredIn` (which registry list it reads), `what`
(a singular noun, for assertion messages), `declaredKeys()` (which keys the disk
declared), `compiled()` (what this build compiled in), and `keyOf(entry)` (which
string joins the two halves).

**`live()` is computed by the factory**: `compiled()` minus anything no installed
package declares. There is exactly one implementation of the gate, so **there is
no unfiltered version for the next person to copy**.

Two types rather than one, so that the roster can be a `Record`:
`PackageContributionGate` takes no type parameter, so three descriptors with
different `Live` types can share one `Record` without variance problems. The
guards ask about keys only, so that half is enough.

`compiled` is **required**, and that is the design's enforcement point. Allowing
it to be omitted means defaulting to no filtering, which is the gap itself; making
it required means the question "what did this build compile in, for your kind"
has to be answered — even when the answer is "nothing beyond the registry
itself".

### 2.2 `contributions.ts` — the roster, in a file of its own

```ts
Readonly<Record<keyof InstalledPackages, PackageContributionGate>>
```

`Record<keyof InstalledPackages, …>` is the first layer: add a list to the
registry, and failing to add a line here turns typecheck red.

**It has to be a separate file from `contribution.ts`.** The roster imports
`mcpTools.ts`, while `contribution.ts` is imported by `viewKinds.ts`, which is
reached by `renderer/packages/register.ts`. Merging them drags
`@peek/db-neo4j/mcp-tool-meta` into the window's chunk, and acceptance criterion 22
is already deducting points for chunk growth (§4vicies(d)).

**The roster has no consumer in production code, deliberately.** Giving it one
would put all three descriptors' imports into whichever chunk that consumer lives
in. It is a declaration checked by types and tests, on nobody's call path.

The same file also holds `NOT_A_CONTRIBUTION = ['id','version','peek','entry']`,
which together with `Object.keys(PackageManifestSchema.shape)` implements
**refuse-by-default**: every key of the manifest either has a gate in the roster or
is on that exemption list, and anything in neither is reported as "an unclassified
contribution". Listing only the contributions could not do this — the way a fourth
contribution gets missed is precisely that nobody writes it down anywhere.

### 2.3 The three descriptors stay beside their own tables

Somebody reading `viewKinds.ts` should find the answer about view kinds in
`viewKinds.ts`, not a pointer somewhere else. What the roster adds is the sentence
none of the three tables can say for itself: **this list is complete**.

- `manifests.ts` → `driverContribution`: the gate is the **identity**. `compiled()`
  *is* `driverManifests()`, which is already a `.map` over the registry. Decision 1
  removed the compile-time half entirely, so there is nothing an uninstall can leave
  behind. **It still goes on the roster** — because "obviously there is nothing to
  filter" is an assertion about today's import graph, and a kind not on the roster
  is exactly a kind the guards cannot ask about.
- `viewKinds.ts` → `viewKindContribution`: the gate **really does remove things**,
  and this is the only one of the three whose compile-time half is still alive.
  `installedViewKindContracts()` becomes a thin shell over
  `viewKindContribution.live()`, keeping its name because the renderer and its
  comments use that name.
- `mcpTools.ts` → `toolContribution`: the gate is the identity, and **which list it
  is the identity on** is this descriptor's entire content. `compiled()` is
  `installedTools()`, **not** the `PACKAGE_TOOL_META` in the same file.

### 2.4 Why the tool descriptor does not use `PACKAGE_TOOL_META` as `compiled()`

It looks stricter and is in fact false.

Since §4duodevicies, a tool's full declaration is a key in `peek-package.json`,
`main/mcp/package-tools.ts` builds a stand-in from the registry, and
`PACKAGE_TOOL_META`'s only remaining consumer is `mcpToolSpecs.ts`, which runs
inside the **package host** (and the host never calls `installPackages`). Which is
to say that table **is not on the path by which a tool is offered**.

If `live()` filtered against it: a package peek never compiled anything for — the
only kind that will exist once §4ter(e) is paid off — would have main listing its
tools as usual while the descriptor filtered them out. **The descriptor would claim
peek offers fewer tools than it does.** A false strictness.

So the honest reading of this one is the same as `manifests.ts`'s: the declaration
**is** the live list, and nothing can be left behind by an uninstall. As for the
drift this file genuinely does have (declared but not compiled into the mapping),
that is a different question, owned by `mcp-tool-halves.test.ts`, which asks about
`driverToolNames()` — and that function therefore stays unfiltered.

### 2.5 The guard, `__tests__/package-contributions.test.ts`

A **generic loop** over the roster, asking each kind the same four questions:

| # | assertion | what it catches |
|---|---|---|
| — | `gate.declaredIn === the roster's key` | misfiling: the gate counted somebody else's list, and the other three questions are describing thin air |
| a | with `IN_REPO_PACKAGES` installed, `liveKeys()` == `declaredKeys()`, and non-empty | the gate is too tight: installed but not offered |
| b | with `{drivers:[],viewKinds:[],tools:[]}` installed, `liveKeys()` **is empty** | **the gate leaks**: the compile-time half survived the uninstall |
| c | `declaredKeys().length === installedPackages()[declaredIn].length` | the gate answers from elsewhere: without touching the registry it could pass a and b by being self-consistent |

Plus three about the roster's completeness: the manifest keys' remainder == the
roster's keys (refuse-by-default); the exemption list holds no key the manifest
does not recognise (so an exemption cannot go stale and later be reused by a real
contribution); and `Object.keys(installedPackages())` == the roster's keys.

That last one asks at **run time** what the types already asked, because
**`pnpm test` does not run typecheck**. It reads the cleared registry (`EMPTY` in
`installed.ts`, a constant written against the type) rather than the test fixture —
the question is "how many lists does the app think a registry has", not "how many
did the fixture remember to fill in".

**What happens when a fourth kind is added**:
`Record<keyof InstalledPackages, …>` turns `contributions.ts` red at typecheck;
adding the key to the manifest without adding it to the roster turns the
"remainder" case red; wiring the roster but hand-writing an unfiltered gate turns
(b) red.

---

## 3. Trade-offs

**Merging the three tables into one registry and filtering once was
considered.** Not possible — the three tables being separate *is* the chunk
boundary: `viewKinds.ts` goes to the window through the `/view` subpath and
`mcpTools.ts` goes only to the host through `/mcp-tool-meta`, and merging drags the
two together (`mcpToolSpecs.ts`'s header comment argues the same point). The
roster's approach is to **merge only the sentence about the gate, not the tables**.

**Having `declaredKeys(installed: InstalledPackages)` take a parameter** fed by the
guard was considered. Not possible — that would make `installed.ts`'s
`installedDrivers()` / `installedViewKinds()` / `installedTools()` dead exports,
and those are the entry points the production consumers read; the descriptor could
then answer from a snapshot nobody else looks at. A parameterless thunk forces it
to read through the same entry point the consumers do.

**Making the gate throw rather than skip silently was considered.** Wrong
direction: a package not being installed is the normal case, and the manifest is
the authority. What is worth reporting is the other direction — declared but not
compiled into an implementation — and that belongs to
`registerPackageViewKindNames` and `build-packages.mjs`, which already report it.

**Putting the roster and the exemption list in `__tests__/` was considered** and
abandoned — the roster is a statement about the app ("these are the kinds of thing
a package can contribute"), and it should live with what it describes and be
checked by `tsc`. Being read only by the guards does not make it test data.

**An accepted cost**: `driverContribution` and `toolContribution`'s `compiled()`
are tautologies as written (filtering the registry by the registry's own keys).
That is not a placeholder, it is those two kinds' actual state today, written out
in a comment in both places; the tautology is **the machine-checkable spelling** of
that statement.

---

## 4. Verification

`pnpm typecheck` all green; `pnpm test`'s `apps/desktop` all green (1,155 related
cases, 0 failures). The red in `packages/db-redis` is the pre-existing failure
recorded in §4vicies and unrelated to this document.

**Inverse checks (break it → watch it go red → restore)**:

1. **Add a fake fourth contribution and do not wire the gate.** Add
   `skills: z.array(z.string()).default([])` to `PackageManifestSchema`.
   → "every key of a manifest is a contribution with a gate" goes red, with the
   diff naming `+ 'skills'`. Then wire it into the roster, but hand-write an object
   literal with `liveKeys: () => ['redis-cheatsheet']` (bypassing the factory):
   → **(b) "is not offered when nothing is installed" goes red**, "is filed under
   the registry list it reads" goes red, and "every list an install carries has a
   gate" goes red; at the same place `pnpm --filter @peek/desktop typecheck` reports
   `TS2353: 'skills' does not exist in type Readonly<Record<keyof InstalledPackages, …>>`.
2. **Turn one gate into the identity.** Replace `live()` in the factory with
   `[...spec.compiled()]`.
   → view kind's (b) goes red, and the existing
   `view-kind-halves.test.ts` case "a kind whose package is not installed is not
   offered" goes red with it. The driver and MCP tool cases **stay green** — which
   reproduces exactly what §2.3 wrote down: those two are the identity to begin
   with, and view kinds are the only one with anything to filter.
3. **Delete an entry from the roster.** Remove `tools: toolContribution`.
   → the "remainder" case and "every list an install carries has a gate" both go
   red, and both diffs name `+ 'tools'`.

All three were restored byte-identically at the point of damage (verified with
`diff`), and everything re-ran green afterwards.
