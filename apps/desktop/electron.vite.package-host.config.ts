import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import { mainProcessTarget } from './electron.vite.config'

/* ====================================================================
 * Build the package host into `out/package-host/`.
 *
 * A pass of its own, run beside `electron-vite build` rather than inside it,
 * and that separation is the entire content of this file. Design 2026-08-07
 * §2.4bis(a) buys one thing — main can call `safeStorage.decryptString` on every
 * stored credential, so no package's code may be loaded there — and one Rollup
 * graph cannot deliver it.
 *
 * Not "cannot deliver it reliably": cannot at all. Rollup assigns whole
 * *modules* to chunks and groups them by which entries reach them, so a module
 * imported by both `src/main/index.ts` and `src/main/packages/entry.ts` lands in
 * a chunk both entries load, carrying the union of what either needed. There is
 * no knob that duplicates a module into two chunks instead — `manualChunks` can
 * only choose the grouping, and `preserveModules` still emits one file per
 * module for both entries to share. The only way for two entries not to share a
 * module is for them not to be in the same graph.
 *
 * That is not a hypothetical. §4quater(a) records it happening: the package
 * host's tool handlers rode into main inside a chunk both entries loaded, while
 * `grep` over `out/main/index.js` reported clean, because the entry file names
 * only the chunks and not what is in them.
 *
 * `scripts/build-packages.mjs` makes the same argument, for the renderer side
 * and now for the packages themselves — one Vite build per package file, because
 * a chunk hoisted out of two realms belongs to neither. This is that argument
 * applied to the process boundary instead of the origin boundary.
 *
 * ## What is shared, and what is not
 *
 * The *settings* come from `mainProcessTarget` in the main config: same aliases,
 * same externals, same minifier and `keepNames`, same CommonJS-shim and
 * unresolved-import guards. Two bundles built two different ways would be a
 * second problem on top of this one. What is not shared is the graph, which is
 * the only thing that ever needed separating.
 *
 * ## Why its own directory
 *
 * `out/package-host/` rather than a second write into `out/main/`, because Vite
 * empties a build's `outDir`. A second pass into `out/main` would have to run
 * with `emptyOutDir: false` and strictly after `electron-vite build` — an
 * ordering that holds for `pnpm build` and is impossible for `pnpm dev`, where
 * the main build never finishes. `PackageHostRegistry` resolves the directory
 * relative to its own bundle, so main and its host stay one relative path apart
 * in the tree and in the packaged .app alike.
 *
 * ## The cost, stated
 *
 * `pnpm dev` builds this once, up front, and does not watch it: editing a
 * package's display or tool code during a dev session needs `pnpm
 * build:package-host` and a fresh fork. The package UI has had the same shape
 * since it got its own pass, for the same reason — a separate graph is a
 * separate watcher, and neither is worth wiring into `electron-vite dev` to save
 * a command.
 * ==================================================================== */

export default defineConfig({
  main: mainProcessTarget(
    {
      // One utilityProcess per package, forked lazily by main the first time a
      // package has to compute something (§2.4bis c). `packages/registry.ts`
      // expects the output to be named `package-host.js`, i.e. this key.
      'package-host': resolve(__dirname, 'src/main/packages/entry.ts'),
    },
    'out/package-host',
  ),
})
