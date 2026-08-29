# Nailing the guards to what actually ships

## 1. What this fixes

A pre-delivery review caught two problems of the same shape: **when the test goes
red, nobody knows whether to care.**

### 1.1 Three compile-time tables have no production consumer left

After Phase C
(`2026-08-07-database-packages-from-disk.md` §4quaterdecies),
`main/packages/entry.ts` imports only `node:url` and `@peek/core`, and loads a
package's own `contrib.mjs` at run time via `PEEK_PACKAGE_ENTRY`. The three
compile-time aggregate tables it used to slice lost their reader with that
change:

| table | former reader | today |
| --- | --- | --- |
| `drivers/mcpToolSpecs.ts` (`ALL_TOOL_SPECS`) | sliced by `entry.ts` | no non-test importer |
| `drivers/packages.ts` (`PACKAGE_DRIVER_IDS`) | `entry.ts` looking up its own driver | no non-test importer |
| `DRIVER_DISPLAYS` in `drivers/manifests.ts` | `entry.ts` slicing displays per package | no non-test importer |

The consequence is concrete: **delete the neo4j line from `DRIVER_DISPLAYS`, or
delete `mcpToolSpecs.ts` outright, and what `pnpm build` produces is
byte-identical while five test files go red.** An assertion nailed to something
that does not ship is an assertion nobody knows whether to care about when it
goes red.

`DRIVER_DISPLAYS` carries a second cost: `drivers/manifests.ts` is imported by
both main and the renderer, and for the sake of that table it statically imports
five `@peek/db-*/display` modules, which only tree-shaking keeps out of both
bundles — a property of the current call graph, not a boundary. The `/display`
entry's comment in `subpath-purity.test.ts` says as much itself.

### 1.2 The hot-reload test reproduces production code, and copied one line short

`adoptPackageScan` in `main/packages/adopt.ts` turns one scan into two
registries:

```ts
installPackages(installed)              // the manifest, sent to the windows
installPackageLocations(report.loaded)  // absolute paths, which never leave main
```

`hot-reload.test.ts` has been changed to call `adoptPackageScan`, but **no
assertion reads the second half**: delete `installPackageLocations(report.loaded)`
and all 1,839 tests stay green while every `conn.open` dies with
`No installed package was found for driver 'x'`. Extracting the function only put
production code within the test's reach; something still has to reach for it.

Boundary: no run-time behaviour changes, the semantics of §2.4bis / §2.7 are
untouched, the smoke test is not involved, and no existing assertion is relaxed.

## 2. The plan

### 2.1 `mcpToolSpecs.ts` + `mcp-tool-halves.test.ts` — deleted

Dead code goes, and its guard goes with it. The same question (a name declared on
one side and mapped on the other) is now asked of the **build output** by
`scripts/build-packages.mjs`:

```js
if (!sameNames(contribProbe.tools, declaredTools)) throw new Error(…)
```

It compares the `tools` export of the built `contrib.mjs` against the `tools` key
of the `peek-package.json` written beside it, per package, at build time.
Deleting a mapping changes the bytes and fails `pnpm build` — which is exactly
what those two arrays could not do.

Along with it: the three exports in `mcpTools.ts` used only by `mcpToolSpecs.ts`
and that test (`PACKAGE_TOOL_META` / `driverToolNames` / `packageIdForTool`) go
too, and so does its import of `@peek/db-neo4j/mcp-tool-meta`. What remains in the
file is the one `toolContribution` descriptor — the third line of the
`contributions.ts` roster, read by `package-contributions.test.ts`.

### 2.2 `drivers/packages.ts` — deleted; `lazy-start.test.ts` — nailed to the registry

`PACKAGE_DRIVER_IDS`'s header comment says "It goes away with them" itself, and
*them* has gone.

`lazy-start.test.ts` enumerates from that hard-coded table, so N is permanently
5, **while acceptance criterion 31 talks about 20 packages**. It changes to
counting from `installedDrivers()` — the registry main itself answers questions
from:

```ts
const packageIds = new Set(installedDrivers().map((driver) => driver.packageId))
assert.ok(packageIds.size >= 5, 'the point of the count is that N is not 1')
```

Install a sixth package and this counts 6, with nobody having to remember to add
a line.

### 2.3 `DRIVER_DISPLAYS` — moved out of production source, the assertion kept and rephrased

It moves to `src/drivers/__tests__/in-repo-displays.ts`, beside
`in-repo-packages.ts` and `in-repo-registry.ts`, for the same reason: it already
**is** a fixture, it was just living in production source. Afterwards
`drivers/manifests.ts` has five fewer `/display` imports and neither bundle
depends on tree-shaking to keep anything out.

The assertion in `driver-registry.test.ts` is **neither deleted nor relaxed**;
what changes is what it says. Its error message used to read

> Every collected manifest needs a display, or its package host cannot name that driver

— which is now false, since the host gets the `displays` export from
`contrib.mjs`. What it really guards is whether `display-fallback` and
`connection-label` have quietly stopped covering a database, and the message says
so. What it used to claim to guard belongs to `build-packages.mjs`, and more
strongly, because that compares the build output:

```js
if (!sameNames(contribProbe.displays, declaredIds)) throw new Error(…)
```

A `sqlDisplays` that writes `mysql` where it means `postgres` (which passes type
checking, because it collides with a key declared elsewhere) fails there, per
package, at build time.

### 2.4 Hot reload: an assertion for the missing half

In `hot-reload.test.ts`:

- add `clearPackageLocations()` beside `clearInstalledPackages()` in the harness —
  `adoptPackageScan` fills both halves, and clearing only one leaves the previous
  test's temporary directory alive into the next;
- after a successful install, assert `packageEntryPaths('echo')?.driver` is the
  `driver.mjs` inside the package directory;
- assert it is present before an uninstall and `null` after.

The last `installPackages(installedFrom(report))` in the separate `packages.read`
assembly also becomes `adoptPackageScan`, so this file no longer contains a second
spelling of "one scan becomes two registries".

### 2.5 Inaccurate comments corrected along the way

The header comments of `drivers/packages.ts` and `drivers/mcpTools.ts` both name a
caller that does not exist. These have also stopped matching reality and are
corrected together: the `/display` and `/mcp-tool-meta` rationales in
`subpath-purity.test.ts`, `drivers/contributions.ts`, `drivers/installed.ts`,
`main/packages/display.ts`, `main/packages/view-answers.ts`,
`packages/core/src/package-host.ts`,
`packages/db-postgres/src/entry/driver.ts`, `scripts/main-may-reach.ts`, and two
places in `scripts/audit-package-boundary.mjs`.

## 3. Trade-offs

**Why `DRIVER_DISPLAYS` is not simply deleted.** Four tests
(`connection-label`, `display-fallback`, `connection-rows`, `connection-book`)
use it as the oracle for "a package's own three strings", and what they test is
the `@peek/db-*/display` that really ships. Deleting it would have each of those
four files import five display modules — the same table copied four times. Moving
it to `__tests__/` is the intersection of "delete dead code from production
source" and "keep four real tests".

**Why the fixture does not read each package's `entry/contrib.ts` directly.**
That is the layer that genuinely ships, but `contrib.ts` has no exports subpath,
and adding one means touching five `package.json` files, the alias table in
`electron.vite.config.ts` and the inventory in `subpath-purity.test.ts` — a
production API change, which deserves its own round of documentation.
`build-packages.mjs` already asks the same question of the build output, and this
round does not duplicate it.

**Why the two neo4j entries in `MAIN_MAY_REACH` stay.** The comment in
`main-may-reach.ts` says they "go the day `mcpToolSpecs.ts` becomes an
`import()`". That day has come, but deleting them is not a two-line deletion:
this table moonlights in `audit-package-boundary.mjs` as "exempt a module from
contributing a signature string", and measured, deleting them fails `limits.ts`
outright (it writes no greppable literal and needs an `UNSIGNABLE`, the way
`display.ts` does). That changes what the build-output audit claims, and belongs
to a round that can run a full `pnpm build`. The comment is rewritten to record
this measurement instead of pointing at a deleted file.

## 4. Verification

`pnpm test`: 1,839 passing / 0 failing (baseline 1,842; the missing three are
`mcp-tool-halves.test.ts`).

**Re-run before delivery, 2026-08-12: 1,842 passing / 0 failing.** The three that
came back are not this document's; they were added on the install path in a later
round (a bundled package colliding, a refused restore saying so, a failed restore
reporting itself), recorded in
[`2026-08-07-database-packages-from-disk.md`](2026-08-07-database-packages-from-disk.md)
§4sexvicies(f). The three deleted here are still deleted.

Inverse checks (break it → watch it go red → restore):

| how it was broken | what red looks like |
| --- | --- |
| delete `installPackageLocations(report.loaded)` from `adopt.ts` | `hot-reload.test.ts`, **2 cases**: `packageEntryPaths('echo')?.driver` comes back `undefined` (expected the temporary directory's `driver.mjs`); the uninstall case's precondition `assert.ok(packageEntryPaths('echo'))` gets `null` |
| delete `neo4j: neo4jDisplay` from `in-repo-displays.ts` | **9 cases**: `driver-registry`'s `every collected manifest has a display…`, `display-fallback`'s `neo4j names it instead of throwing`, and `connection-label`'s seven neo4j cases |
| remove `redisManifest` from `in-repo-packages.ts` | `lazy-start`'s `registers every package and forks none of them`: `the point of the count is that N is not 1` (the old spelling counted from the hard-coded table and would not have gone red) |
| set `displays` to `[]` in `db-neo4j/src/entry/contrib.ts` | `pnpm build:packages` exits 1: `neo4j/contrib.mjs contributes displays for [] but peek-package.json declares [neo4j].` |
| set `tools` to `[]` in `db-neo4j/src/entry/contrib.ts` | `pnpm build:packages` exits 1: `neo4j/contrib.mjs maps tools [] but peek-package.json declares [expand_node].` |

`node scripts/audit-package-boundary.mjs` also still passes (10 signatures, main
holding none of them).
