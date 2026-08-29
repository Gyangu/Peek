# Giving `packages/core` a test script, and moving its own tests back into it

> 2026-08-02. The entry in the technical-debt ledger (`PLAN.md` §11.2) reading
> "`packages/core` has no test script". After the PG fixture was fixed last
> round, `pnpm -r test` ran to completion for the first time — and so made one
> thing visible for the first time: **`packages/core` is not in the list at
> all.**

---

## 1. What this fixes

### 1.1 A frozen shared contract that runs none of its own tests

`pnpm -r test` currently reports five packages:

```
packages/db-redis    37
packages/db-qdrant   38
packages/db-postgres 53
packages/db-sql      83
apps/desktop           1292
```

`packages/core` is missing because its `package.json` has only `typecheck`. Yet
core is the "frozen shared contract" of `PLAN.md` §2 — command schemas,
Workspace state, the capability interface, the chunk protocol, cursor encoding,
the canonical representation of values — and all five other packages depend on
it.

The consequence is not that core is untested (desktop's 1292 tests cover it
heavily but indirectly); it is that **someone changing core gets no signal that
belongs to core**. The command `pnpm --filter @peek/core test` does not exist, so
someone who has only touched `core/cursor.ts` either runs the whole desktop suite
or runs nothing.

### 1.2 Core contract tests that already exist, lodged in the app

The ledger records this as "pure core cross-driver contract tests are lodged in
`mcp/__tests__/` for now". Going to fetch them showed **a wider scope than that,
landing in more than one directory**. Filtering by "static imports are only
`@peek/core` and node built-ins", five files in the repository test nothing but
core's own exports:

| file | which part of core it tests | cases |
|---|---|---|
| `main/mcp/__tests__/scan-cursor.test.ts` | `cursor.ts`'s cursor envelope | 4 |
| `main/mcp/__tests__/logical-values.test.ts` | `values.ts`'s canonical JS representation | 7 |
| `main/bus/__tests__/browse-style-normalization.test.ts` | `capability.ts`'s browse determination | 4 |
| `renderer/components/__tests__/connection-label.test.ts` | `capability.ts`'s connection naming | 10 |
| `renderer/components/__tests__/drop-zone.test.ts` | all of `layout-dnd.ts` | 31 |

The last is the clearest case: `layout-dnd.ts` is **entirely** in core with no
counterpart on the renderer side, and yet its tests sit in
`renderer/components/__tests__/`. Nobody changing core's drag-and-drop geometry
would think to look there.

### 1.3 One has to stay, and the reason should be written down

`main/mcp/__tests__/driver-errors.test.ts` imports all four driver packages. It
**cannot** move into core — core is the layer the four drivers depend on, and
having it depend on them inverts the dependency graph. The ledger's phrase "the
only directory that depends on all four drivers and is covered by the test glob"
is about exactly this file; it was simply being used to explain several other
files that need no drivers at all.

### 1.4 Boundary (explicitly not done)

- **No new tests.** This round only moves what already exists and adds an entry
  point that runs.
- **No changes to code under test.** Not a line of core changes.
- **Tests that merely import a core type do not move.** The test is "does the
  subject under test live in core", not "what does it import" —
  `resultCache.test.ts` statically imports only `@peek/core` but tests the
  renderer's cache, and stays where it is.

---

## 2. The plan

### 2.1 The entry point

`packages/core/package.json` gains one line, shaped like the other four
packages':

```json
"test": "node --import ./src/__tests__/register.mjs --test src/__tests__/*.test.ts"
```

`register.mjs` is the same resolution hook `db-postgres` carries: the repository
uses `moduleResolution: bundler` throughout, relative imports omit the
extension, node cannot resolve those itself, and the hook probes for `.ts` and
`index.ts`. Type stripping is node's job; the hook only finds files.

`devDependencies` needs `@types/node` — core currently has only `typescript`, and
`import assert from 'node:assert/strict'` will not pass `pnpm typecheck` without
it. `tsconfig.json`'s `include` is already `src/**/*.ts`, so the test files enter
type checking automatically and nothing there changes.

### 2.2 The move

Five files move to `packages/core/src/__tests__/`, with their imports changing
from `@peek/core` to `../index`.

`../index` rather than the specific module, to preserve what these tests are for:
they test **the contract as published**. `@peek/core` resolves to `src/index.ts`,
so this is the same thing spelled differently, not a different subject under
test.

Afterwards desktop has 56 fewer cases and core has 56 more, with the total
unchanged — that is the **only** change in counts this should produce, and it is
part of the acceptance.

### 2.3 Files involved

```
packages/core/package.json                  test script + @types/node
packages/core/src/__tests__/register.mjs    new (same source as db-postgres's)
packages/core/src/__tests__/*.test.ts       five files move in
apps/desktop/src/main/mcp/__tests__/        two move out
apps/desktop/src/main/bus/__tests__/        one moves out
apps/desktop/src/renderer/components/__tests__/  two move out
```

---

## 3. Trade-offs

**Why `driver-errors.test.ts` does not move too** — see §1.3; it would invert the
dependency graph. Leaving it in desktop is the **correct** location, not a
compromise, and the ledger's sentence should be corrected to say so.

**Why the filter is "where does the subject live" rather than "what does it
import"** — the latter catches innocents: a file testing a renderer module may
perfectly well import only core's types (`resultCache.test.ts` does), and moving
it would make core depend on the renderer. The test has to be where the subject
belongs.

**Why `register.mjs` is copied rather than factored into a shared package** — it
is twelve lines, and each package's `--import` path has to be relative to that
package. Building a workspace package for twelve lines costs every package an
extra dependency and an extra resolution. The four driver packages already each
carry a copy; a fifth does not change that judgement.

**Why no new tests are written along the way** — see §1.4. This round's goal is
that the entry point exists and the existing tests sit in the right place. Where
coverage is thin is the next question, and mixing the two makes it impossible to
verify that the move was equivalent.

---

## 4. Verification

```bash
pnpm --filter @peek/core test        # before: the script did not exist
pnpm -r test                         # core appears in the list
pnpm typecheck
```

Acceptance:

1. `packages/core test:` appears in `pnpm -r test`'s output;
2. core's case count is 56 and desktop falls from 1292 to 1236, with **the total
   unchanged**;
3. all six packages typecheck (core's test files are in scope once `@types/node`
   is added).
