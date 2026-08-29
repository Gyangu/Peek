# Lifting `createPackageAdmin` out of `main/index.ts`

## 1. What this fixes

`2026-08-07-database-packages-from-disk.md` §(d) recorded a hole in itself:

> **A hole measured along the way**: those four `packages.uninstall` cases are
> **all green** — nobody asserts the uninstall path's notification at the unit
> level, and only the smoke test guards it.

The hole is slightly larger than that note says. The harness in
`hot-reload.test.ts` contains:

```ts
packages: {
  async uninstall({ packageId, version }) { … adopt(scan()); options.toolsChanged() },
},
```

The comment above that line reads "The same three steps `createPackageAdmin`
performs in main" — which is a confession: the assertions watch the three steps
the harness has just written down for itself, not the three steps production
takes. The real `createPackageAdmin` lives in `main/index.ts`, that file imports
`electron`, `node --test` cannot reach it, and so a copy was the only option.
Deleting `toolsChanged` from the real one would not turn anything red, because
red or green depends on the harness's copy, and the copy always agrees with the
assertions.

The second hole is quieter: the harness's `toolsChanged` callback records driver
ids by **reading the disk**. By the time the effect reaches the notification
step the disk has already changed, so what gets recorded is the same whether
`toolsChanged` runs before or after `adopt` — "the notification must come after
`adopt`" has no corresponding assertion in the tests at all, even though the
install path in `commands.ts` carries a comment written specifically for it.

Boundary: no behaviour changes, the semantics of §2.4/§2.7 are untouched, and
the smoke test is not involved. One function moves, and two existing assertions
become assertions that actually hold something down.

## 2. The plan

### 2.1 A new file, `apps/desktop/src/main/packages/admin.ts`

```ts
export function createPackageAdmin(
  options: PackageCommandOptions,
  disposeHost: (packageId: string) => Promise<void>,
): PackageAdminService
```

The body comes across from `main/index.ts` verbatim, with one change:
`packageHosts.dispose(packageId)` becomes the parameter
`disposeHost(packageId)`. Two parameters rather than folding it into
`PackageCommandOptions`: `options` is the assembly the four kernel verbs share,
and killing a process is something only the uninstall path needs. Mixing it in
would hand `packages.read` a callback it will never call.

`disposeHost` has to be a parameter rather than this module importing
`PackageHostRegistry` itself: that registry forks an Electron utility process,
so importing it would drag `electron` straight back in and the move would have
bought nothing.

- `main/index.ts`: the function is deleted and becomes
  `createPackageAdmin(packageOptions, (packageId) => packageHosts.dispose(packageId))`.
  Wrapped rather than passing `packageHosts.dispose` directly, because the
  latter is a class method and passing it bare loses `this` (`dispose` reads
  `this.entries`) — and TypeScript will not catch it.
  Two now-unused imports go with it: `uninstallPackage` and `peekError`.
- `hot-reload.test.ts`: the harness's `packages` swaps the hand-copied object for
  `createPackageAdmin(options, async (id) => { … })`, with the callback doing
  only bookkeeping.

### 2.2 Making "the notification comes after `adopt`" a real assertion

The harness's `toolsChanged` reads from the **registry** instead of from disk:

```ts
toolNotifications.push(installedDrivers().map((driver) => driver.manifest.driverId))
```

Not one recorded value changes (`['echo']` after an install, `[]` after an
uninstall, `['alpha']` after a restore), so the three existing assertions need
no edits — what changes is that they are now **order-sensitive**: run
`toolsChanged` ahead of `adopt` and what it records is the previous registry.
Which is exactly what a client that re-lists on hearing `tools/list_changed`
would see.

### 2.3 Closing §2.4bis(f) along the way

"Kill the process, then remove the directory" was guarded only by
`assert.deepEqual(h.disposed, ['echo'])` — which says the kill happened, not
when. The harness's dispose callback records one more thing: whether the
package's directory still existed at the moment the process was asked to exit.

```ts
killedWhileOnDisk.push(existsSync(join(packagesRoot, packageId)))
```

`assert.deepEqual(h.killedWhileOnDisk, [true])`. The reverse order would leave a
process alive holding a `contrib.mjs` already imported into memory, still
answering calls out of a package that no longer exists on disk.

## 3. Trade-offs

**Why not just add an `export` in `main/index.ts` and be done**: loading
`main/index.ts` under `node --test` imports `electron` and blows up immediately.
Whether the function is exported is beside the point. Either it moves, or the
copying continues.

**Why not give the harness an electron stub** (`__tests__/stub-electron.ts`
already has one): a stub can fool the import, but not the long assembly at the
top level of `main/index.ts` — loading that file builds a store, a
ConnectionManager, and reads the config directory. Standing the whole of main up
for the sake of a twenty-line function costs more, and risks more, than moving
it.

**Why not have `toolNotifications` record both the registry and the disk**: the
extra disk read holds nothing down (§2.1 has already shown it is not
order-sensitive) and would only make the failure output harder to read.

## 4. Verification

`pnpm --filter @peek/desktop typecheck` is clean, and
`pnpm --filter @peek/desktop test` gives 1822 pass / 0 fail.

Five inverse checks, each broken on its own, run, and restored (the restored file
is byte-identical to the backup under `diff`):

| guard | how it was broken | what red looks like |
|---|---|---|
| uninstall emits `list_changed` | delete `options.toolsChanged()` in `admin.ts` | `✖ its connections close, its directory goes, and the receipt names both` — `actual: []` / `expected: [ [] ]` |
| the uninstall notification follows `adopt` | move `toolsChanged()` ahead of `adopt` in `admin.ts` | the same case — `actual: [ [ 'echo' ] ]` / `expected: [ [] ]` (the notification carries a registry that is not yet clean) |
| kill first, remove second (§2.4bis(f)) | move `disposeHost` after `uninstallPackage` in `admin.ts` | the same case — `actual: [ false ]` / `expected: [ true ]` |
| the install notification follows `adopt` | swap the two lines on the install path in `commands.ts` | `✖ a package installed now is connectable now, and the windows and MCP are told` — `actual: [ [] ]` / `expected: [ [ 'echo' ] ]` |
| the restore notification follows `adopt` | swap the two lines on the restore path in `commands.ts` | `✖ brings back an uninstalled bundled package, and tells the windows and MCP` — `actual: [ [] ]` / `expected: [ [ 'alpha' ] ]` |

The last two were **falsely green** before this change: the same swap turned
nothing red under the old harness. That is what this change actually buys — for
the first time, something at the unit level holds down the notification order
across all three verbs.
