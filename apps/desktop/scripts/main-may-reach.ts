/**
 * Package source files the **main** entry is allowed to reach, and why each one.
 *
 * Everything else under `packages/db-<id>/src/` is a package's own code, and
 * design 2026-08-07 §2.4bis(a) says main holds none of it: main can call
 * `safeStorage.decryptString` on every stored credential, so a neo4j package
 * loaded there can read every saved PostgreSQL password. The list is short and
 * hand-written because each entry is a claim about what a file *is*, and a
 * pattern broad enough to be maintenance-free would be broad enough to let the
 * next mapping through.
 *
 * It sits in a module of its own because two checks read it, from two different
 * angles and at two different times: `assertMainHoldsNoPackageCode` in
 * `electron.vite.config.ts` asks Rollup which modules went into main's chunks
 * while the build is still running, and `scripts/audit-package-boundary.mjs`
 * greps the bytes that ship, across both builds, once they exist. Two copies of
 * this list would let one check excuse a file the other still forbids, and the
 * pair would then be reporting a boundary that neither of them holds.
 *
 * Patterns are tested against absolute POSIX-ish paths, so they anchor on `/src/`
 * rather than on a package name unless the entry is genuinely about one package.
 */
export const MAIN_MAY_REACH: readonly { pattern: RegExp; why: string }[] = [
  { pattern: /\/src\/manifest\.ts$/, why: 'a manifest is data; the renderer reads the same one' },
  /*
   * The next two are a **debt, not a category**, and since §4duodevicies they no
   * longer describe main at all.
   *
   * Main loaded `mcp-tool-meta.ts` for as long as `tools/list` was answered from
   * a compiled-in constant. It now reads `installedTools()` off disk, and
   * `audit-package-boundary.mjs` asserts the declared tool names are *absent*
   * from main's bundle — a name in there is the second list that acceptance 13's
   * first sentence failed on. `drivers/mcpToolSpecs.ts`, the app's other reader,
   * is gone with Phase C: a host `import()`s its package's own `contrib.mjs`, so
   * nothing in `apps/` names either file.
   *
   * So the honest move is to delete both entries, and it is one measured step
   * rather than a deletion. This list does double duty in that script, where an
   * entry also excuses a module from contributing signature strings: dropping
   * these two makes `mcp-tool-meta.ts` a signature source (its tool names, which
   * main is separately asserted not to hold) and makes `limits.ts` fail outright
   * — it writes no literal a grep could recognise, so it needs an `UNSIGNABLE`
   * entry the way `display.ts` has one. That is a change to what the artifact
   * audit claims, and it belongs in a round that runs the audit against a fresh
   * build rather than in one tidying tests.
   */
  {
    pattern: /\/db-neo4j\/src\/mcp-tool-meta\.ts$/,
    why: 'tool declarations — main no longer loads them; the package host still compiles them in',
  },
  {
    pattern: /\/db-neo4j\/src\/limits\.ts$/,
    why: "the ceiling stated in that declaration's input schema, and reached only through it",
  },
  /*
   * `display.ts` used to be here, as a debt rather than a category (§4ter(e)):
   * `config/connection-book.ts` derived a label and a detail for every archived
   * entry synchronously at launch, before any package host exists. §2.3(b-2)
   * paid it — the book stores the pair now — and the line is gone, which is what
   * makes every remaining entry a claim about *data*.
   *
   * What paying it did **not** buy is recorded in §4sexies(d): the artifact
   * audit gained four more packages to look at and still cannot see them, because
   * a `display.ts` writes no string literal a grep could recognise. That is
   * `UNSIGNABLE` in `audit-package-boundary.mjs`, and deliberately not another
   * entry here — this list is about what main may *load*, and main may not.
   */
]
