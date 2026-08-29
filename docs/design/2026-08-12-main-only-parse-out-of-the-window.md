# Taking the validation only main runs out of the window's build output

> 2026-08-12. Acceptance criterion 22 of
> `2026-08-07-database-packages-from-disk.md` has recorded the same sentence for
> four rounds running: **"attribution confirmed, still not changing it"**. What was
> confirmed is that 36,670 B of zod in the window's chunk is dragged in by
> `z.fromJSONSchema`, which the window cannot reach a single line of; the reason
> for not changing it was "the fix touches the resolution path of 109 imports,
> which is worth its own document".
>
> This is that document. The conclusion: **7 imports, not 109** — because what has
> to move is the **values**, and the overwhelming majority of those 109 imports
> want **types**, which occupy no bytes.

---

## 1. What this fixes

### 1.1 Where things stand: a parser only main can run, installed in every process

`packages/core/src/package-manifest.ts` holds `peek-package.json`'s schema and its
parsing. Its four runtime exports:

| export | who calls it |
|---|---|
| `PACKAGE_MANIFEST_FILE` | `main/packages/{loader,bundled}.ts` |
| `parsePackageManifest` | the same, plus `scripts/build-packages.mjs` |
| `PackageManifestSchema` | no production call site (one test reads its `.shape`) |
| `packageToolInputSchema` | `main/mcp/package-tools.ts` |

All four are main-only (or build-script-only). What the window receives is an
already-parsed `InstalledPackages`; it never reads the disk and never validates
tool arguments.

But `packages/core/src/index.ts` is an `export *` inventory with
`package-manifest.ts` in it. The window imports `@peek/core`, so the whole module
enters the window's chunk.

### 1.2 The bill: 40,594 B, of which 36,670 B is zod

Acceptance criterion 22 nailed the attribution to the line (`e3c36d7` → the
post-packaging tree, subtracted per source):

```
   36670 73169 → 109839     dep:zod
    4403     0 → 4403       packages/core/src/package-manifest.ts
```

Breaking that 36,670 B of zod down one more layer:

```
    8975 12671 → 21646      zod/v4/classic/schemas.js
    8892 23440 → 32332      zod/v4/core/schemas.js
    7914     0 → 7914       zod/v4/classic/from-json-schema.js   ← from nothing
    2956  5042 → 7998       zod/v4/core/api.js
    2791  5354 → 8145       zod/v4/core/json-schema-processors.js
    2346  2658 → 5004       zod/v4/core/regexes.js
    2280  6198 → 8478       zod/v4/core/checks.js
```

**Why tree shaking cannot remove it — two layers, neither of them a bug**:

1. Every schema in `package-manifest.ts` is a top-level `z.object(…)` call, and
   zod's constructors carry no purity annotation. By Rollup's rules a top-level
   call is a side effect, so a referenced module stays whole — that is the 4,403 B,
   and Rollup is right.
2. `from-json-schema.js` opens with
   `const z = { ..._schemas, ..._checks, iso: _iso }` — **spreading a namespace
   import**. The moment a namespace is spread, every export of
   `classic/schemas.js` and `classic/checks.js` is pinned, and tree shaking
   degrades from "the narrow slice" to "the whole of classic". Of the seven lines
   above, everything except `from-json-schema.js`'s own 7,914 B is a consequence of
   this.

So the cost of "one function nobody uses" far exceeds its own size.

### 1.3 Boundary (explicitly not done)

- **The barrel is not split up.** The other 20 entries in
  `packages/core/src/index.ts`'s `export *` inventory are untouched; §3.1 says why.
- **`sideEffects: false` is not added to core.** §3.2.
- **Not a line of `package-manifest.ts` itself changes.** What moves is who can
  reach it, not its contents.
- **`driver-host.ts` / `package-host.ts` / `mcp-tools.ts` are untouched**, even
  though they too are used only by main and the host process. Measured, they are
  not in the window's chunk (no zod calls at the top level, and a class declaration
  plus pure functions are shakeable), and moving things that carry no bill would
  loosen the sentence "the test is measured".

---

## 2. The plan: one subpath export, plus one `export type *`

### 2.1 The shape is copied from `@peek/db-*/manifest`

`packages/core/package.json`:

```jsonc
"exports": {
  ".":                  { "types": "./src/index.ts",            "default": "./src/index.ts" },
  "./package-manifest": { "types": "./src/package-manifest.ts", "default": "./src/package-manifest.ts" }
}
```

`tsconfig.base.json` needs no change: `"@peek/core/*": ["./packages/core/src/*"]`
has been there all along.

`electron.vite.config.ts`'s `peekAlias` gains one entry, **ahead of the bare
package name** — `2026-08-03-driver-package-boundary.md` §2.3 argued the
prefix-matching trap: `'@peek/core'` would claim
`@peek/core/package-manifest` and rewrite it to `…/src/index.ts/package-manifest`,
whose failure mode is a throw at the top of a chunk rather than a build error.

### 2.2 Types stay in the barrel, values do not — `export type *`

This is where this round parts company with acceptance criterion 22's estimate of
"109 imports".

Of those 109, the overwhelming majority of what `package-manifest.ts` contributes
is **types**: `InstalledPackages` / `InstalledDriver` / `InstalledTool` /
`InstalledViewKind` / `PackageViewKind` / `PackageManifest`… The window uses them
everywhere, all five files under `src/drivers/*` are `import type`, and so is
`packages/db-neo4j/src/manifest.ts`. Types are erased at compile time and occupy
not one byte.

So that line in the barrel goes from

```ts
export * from './package-manifest'
```

to

```ts
export type * from './package-manifest'
```

esbuild deletes the whole statement before Rollup ever sees the graph (verified
against both installed versions, 0.25.12 and 0.28.1), so **the vocabulary stays
exactly where it was and not one schema comes in**. The only entry point for the
values is `@peek/core/package-manifest`.

`export type *` rather than listing type names one by one, because it has force
over future spellings: `package-manifest.ts` may add whatever exports it likes, and
values will never get out through that door. Importing `PackageManifestSchema` from
the barrel and using it as a value fails to compile outright — TS1362
`cannot be used as a value because it was exported using 'export type'`.

### 2.3 The change list

```
packages/core/package.json                      changed  exports gains ./package-manifest
packages/core/src/index.ts                      changed  export * → export type *, with the argument
packages/core/src/__tests__/package-manifest.test.ts  changed  parsePackageManifest comes from ../package-manifest
apps/desktop/electron.vite.config.ts            changed  one alias (ahead of '@peek/core')
                                                    + assertWindowHoldsNoMainOnlyCore (§2.4)
apps/desktop/scripts/build-packages.mjs         changed  await import('@peek/core/package-manifest')
apps/desktop/src/main/packages/loader.ts        changed  three values move to the subpath; PACKAGE_ID_PATTERN stays in the barrel
apps/desktop/src/main/packages/bundled.ts       changed  as above
apps/desktop/src/main/mcp/package-tools.ts      changed  packageToolInputSchema moves to the subpath
apps/desktop/src/main/packages/__tests__/hot-reload.test.ts          changed
apps/desktop/src/main/packages/__tests__/installed-registry.test.ts  changed
apps/desktop/src/drivers/__tests__/package-contributions.test.ts     changed
```

**Seven non-test files, three of which are build configuration.** Production code
moved four import lines.

### 2.4 The guard: `assertWindowHoldsNoMainOnlyCore`

A mirror of `assertMainHoldsNoPackageCode`, registered in the renderer's vite plugin
list. It walks every chunk's `modules` in the renderer's output and calls
`this.error` the moment `packages/core/src/package-manifest.ts` appears.

It judges by **module path** rather than by string, for the same reason as its
sibling: the output is minified, and `keepNames` preserves function names but not a
`const` holding a schema.

The guard carries an **anti-vacuity** clause: the paths in `MAIN_ONLY_CORE` must
actually exist, or it reports "this check is now vacuous". A renamed module has to
go red here rather than green everywhere — the same technique as
`manifest-purity.test.ts`'s "the scan is reading the real manifest sources".

Why a vite plugin rather than a test: `export *` and `export type *` differ
by one word, both compile, both leave the tests green, and the only difference is
the size of the output. This is the class of regression for which this repository
has no other alarm.

---

## 3. Trade-offs

### 3.1 Split the barrel — rejected

One of the fixes acceptance criterion 22 recorded. Of the 21 `export *` lines in
`packages/core/src/index.ts`, only `package-manifest.ts` carries a bill: the rest
either are genuinely used by the window (`workspace.ts` / `commands.ts` /
`ipc.ts` / `capability.ts` all run every frame in the window) or are shakeable
(`driver-host.ts` / `package-host.ts`, measured as absent from the window's chunk).

Splitting the barrel into 21 subpaths buys 0 bytes for several hundred rewritten
imports, plus turning "which symbol is behind which entry point" from something you
never think about into something you look up every time. Barrel exports do have a
cost, and that cost is **this one module**, not the form.

### 3.2 Mark `@peek/core` `sideEffects: false` — rejected

The other fix acceptance criterion 22 recorded. It would let Rollup believe the
top-level `z.object(…)` calls can go, shaking `package-manifest.ts` out. But that
statement is made **about the whole package**, and core does contain things that
depend on top-level execution (zod's discriminated-union registration, constant
tables like `ERROR_MESSAGES` frozen by `Object.freeze` and the like). A package-wide
assertion traded for one module's bytes is a bad ratio of stake to payoff, and
losing the bet looks like a schema becoming `undefined` at run time — with no
compile-time signal.

`export type *` buys the same byte count for the cost of one word, and it cannot be
wrong: a type cannot have a side effect.

### 3.3 Have the window `import type` from the subpath — rejected

That is, delete the barrel's line entirely and change `src/drivers/*` and
`packages/db-neo4j/src/manifest.ts` to
`import type { … } from '@peek/core/package-manifest'`. Identical byte count.

Two reasons against. First, `manifest-purity.test.ts`'s `ALLOWED_MODULES` permits a
driver package's manifest to mention only `@peek/core` and `zod`, and this route
would need it loosened — loosening an assertion guarding "no database client in the
window" for the sake of a type is not a fair trade. Second, core's barrel header
comment says "Every cross-module type is imported from here", and giving the
vocabulary two doors turns that one sentence into two.

**The test is "will the window use it"**, and the window genuinely does use those
types — it just does not use their bytes. `export type *` separates exactly those
two things.

### 3.4 Why `driver-host.ts` / `package-host.ts` are not moved along the way

They too run only in main and the host process. But measured, their signature
strings cannot be found in the window's chunk (`unhandledRejection` and
`driver_host_crash`, 0 hits each) — the top level holds only type declarations, one
class and pure functions, all shakeable by Rollup. Moving them buys 0 B.

Moving things that carry no bill would degrade "main-only" from a **measured**
conclusion into an intuition about what **looks like** one, and there would be no
way to judge the next case. If they ever grow a top-level side effect, one more line
in `MAIN_ONLY_CORE` is the answer.

---

## 4. Verification — measured

### 4.1 The test: the window's build output

| artefact | before | after | difference |
|---|---|---|---|
| `out/renderer/assets/index-*.js` | **671,927** | **631,333** | **−40,594** |
| `out/renderer/assets/SqlEditor-*.js` | 434,951 | 434,951 | 0 |
| `out/renderer/assets/index-*.css` | 37,862 | 37,862 | 0 |

Both from a complete `pnpm build`. The "before" cell is **byte-identical** to the
671,927 B acceptance criterion 22 recorded.

**The attribution lines up**: criterion 22 measured zod's 36,670 B plus
`package-manifest.ts`'s own 4,403 B = 41,073 B, and the measured saving is
40,594 B, a difference of **479 B**. Criterion 22 wrote down the reason for that
gap itself — the attribution script prints only buckets of ≥300 B, and that diff's
total came to 714 B less than the file itself. So those 479 B fall inside "the part
never attributed to a specific source", not something quietly growing back.

**Signature strings** (in the post-change `index-s2fQCmmf.js`):

| string | before | after |
|---|---|---|
| `dependentSchemas and dependentRequired are not supported` | 1 | **0** |
| `unevaluatedItems is not supported` | 1 | **0** |
| `fromJSONSchema` | 1 | **0** |
| `prefixItems` | 4 | **0** |
| `a package with no driver contributes no database` | 1 | **0** |
| `must be a version like 1.2.3` | 1 | **0** |
| `exclusiveMinimum` | 10 | 2 |

The last line is the **positive control**: the remaining 2 come from
`core/to-json-schema.js`, which is 5,919 B on both sides and was in the window
already (the window turns Command schemas into JSON Schema). It did not change,
which shows that what moved out was the `from-` half rather than everything
JSON-Schema-related in one sweep.

### 4.2 The main side: moving bytes elsewhere does not count as winning

| artefact | before | after | difference |
|---|---|---|---|
| `out/main/index.js` | 280.29 kB | 285.40 kB | +5.11 kB |
| `out/main/chunks/package-host-*.js` | 43.83 kB | 38.82 kB | −5.01 kB |
| **what main actually loads** (as the audit reports) | 324,123 B | 324,222 B | **+99 B** |
| the package host bundle (as the audit reports) | 25,974 B | 21,094 B | **−4,880 B** |

`package-manifest.ts` moved from a shared chunk into main's own graph, with the
total essentially unchanged (+99 B). The package host's −4,880 B is free money: it
too was carrying this parser because of the barrel export, and it too does not parse
`peek-package.json`.

### 4.3 The existing guards

| check | result |
|---|---|
| `pnpm typecheck` | all seven projects green |
| `pnpm -r test` | **2,301 all green** (core 151 / neo4j 83 / redis 41 / qdrant 38 / postgres 60 / sql 83 / desktop 1845), 0 failures |
| `scripts/audit-package-boundary.mjs` | green, with the figures in §4.2 |
| `scripts/audit-shipped-css.mjs` | green, 448 rules / 37,862 B, byte-identical to before |
| `probe:render` | `all checks passed` |

**No assertion was relaxed**, and not one test's assertion content changed — the
four test files changed only where their imports come from.

### 4.4 Inverse checks

Four, all actually run.

**(a) The size really is this path** (the one the task asked for). Change the barrel
back to `export *`, genuinely reference `PACKAGE_MANIFEST_FILE` on the window side
in `src/renderer/packages/register.ts` (a `console.log`), and take the guard out
temporarily:

```
631,333 → 672,447 B
```

Back again, +41,114 B. A further step was measured in between, **changing only the
barrel with no reference from the window**: **672,374 B** — showing the bytes come
in without the window referencing anything at all, with `export *` alone being
enough, which is direct evidence for §1.2's first point (a top-level `z.object(…)`
is a side effect).
(Those two steps were run with a bare `npx electron-vite build`, 447 B above the
`pnpm build` baseline; the two steps are comparable to each other under the same
command, and the absolute figures come from §4.1's table.)

**(b) The type wall is not decorative.** Keep the window's reference, change the
barrel back to `export type *`, and run `tsc`:

```
src/renderer/packages/register.ts(2,10): error TS1485: 'PACKAGE_MANIFEST_FILE' resolves to a
  type-only declaration and must be imported using a type-only import when 'verbatimModuleSyntax'
  is enabled.
src/renderer/packages/register.ts(115,15): error TS1362: 'PACKAGE_MANIFEST_FILE' cannot be used
  as a value because it was exported using 'export type'.
```

**(c) The guard goes red.** Change the barrel back to `export *`, put the guard
back, and run `electron-vite build`:

```
✗ Build failed in 1.11s
[peek:assert-window-holds-no-main-only-core] The window carries a main-only module of @peek/core:
  packages/core/src/package-manifest.ts  (in assets/index-CimzSghT.js) — reading a
  `peek-package.json` is the loader's job, and `z.fromJSONSchema` is how it turns a package's
  declared tool arguments into a validator
```

It names the module, names the chunk, and gives the fix.

**(d) The guard's anti-vacuity clause goes red.** Change the path in
`MAIN_ONLY_CORE` to `package-manifest-RENAMED.ts` (simulating a rename):

```
[peek:assert-window-holds-no-main-only-core] packages/core/src/package-manifest-RENAMED.ts does
not exist, so this check is now vacuous. Either the module moved — fix `MAIN_ONLY_CORE` in
electron.vite.config.ts — or the kernel subpath is broken.
```

All four were restored one by one, and a complete `pnpm build` on the final tree
produced an output filename and hash (`index-s2fQCmmf.js`, 631,333 B)
**byte-identical** to §4.1's cell.

### 4.5 By hand (not yet performed)

1. Start the app, install and uninstall a package, and confirm `PackagesSection`'s
   list and error copy are unchanged — `parsePackageManifest`'s failure strings are
   for the user to read, and it now runs only in main.
2. With a broken `peek-package.json` (a `version` of `1.2`, say), confirm the
   settings panel still shows the `must be a version like 1.2.3` line. Only the main
   process can say that sentence now.

### 4.6 Documents

Acceptance criterion 22's line in
`2026-08-07-database-packages-from-disk.md` changes from "still not changing it" to
a pointer at this document.
