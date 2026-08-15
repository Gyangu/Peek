import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, relative, resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin, type MainViteConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
// Rollup's own types through vite rather than from `rollup` directly: rollup is
// a transitive dependency here, so importing it by name typechecks only as long
// as the package manager happens to hoist it.
import type { Plugin, Rollup } from 'vite'
// The one list of package files main may hold. It lives outside this config
// because `scripts/audit-package-boundary.mjs` checks the same claim against the
// shipped bytes, and two lists would let the two checks excuse different things.
import { MAIN_MAY_REACH } from './scripts/main-may-reach'
// Likewise shared rather than restated: `scripts/build-packages.mjs` bundles the
// same database clients into each package's `driver.mjs`, so both builds have to
// swap the same optional dependencies for the same stubs.
import { optionalDepAliasFrom } from './scripts/optional-dep-alias'

const rootDir = __dirname
// Monorepo root, used to alias @peek/* straight at the sources (no build step first)
const repoRoot = resolve(rootDir, '../..')

/**
 * Every @peek/* package is aliased at its sources rather than at a built entry
 * point: the workspace has no build step, so a missing alias here fails at
 * runtime with an unresolved bare specifier rather than at build time. Adding a
 * driver package means three lines here (the package, its manifest and its
 * display) and it is carried into `PEEK_BUNDLED` below automatically.
 *
 * **The `/manifest` entries must stay above the bare package names.** Vite's
 * bundled `@rollup/plugin-alias` matches by prefix, not by equality:
 *
 *     // vite/dist/node/chunks/config.js
 *     if (importee === pattern) return true;
 *     return importee.startsWith(pattern + "/");
 *
 * so `'@peek/db-postgres'` happily claims
 * `@peek/db-postgres/manifest` and rewrites it to
 * `…/packages/db-postgres/src/index.ts/manifest` — a path that does not
 * exist, and whose failure mode is a top-level `throw` inside the chunk rather
 * than a build error. The rollup plugin takes the **first** matching entry and
 * `getEntries` preserves this object's key order, so listing the specific
 * patterns first is the whole fix. `assertNoUnresolvedImports` below is the net
 * if anyone reorders them.
 *
 * Aliasing the manifest subpath is not merely a convenience: it is what keeps
 * `pg` / `redis` / `mysql2` out of the renderer chunk, since the manifest entry
 * point deliberately never reaches `index.ts`. See
 * `src/drivers/manifests.ts`.
 */
const peekAlias = {
  '@peek/db-postgres/manifest': resolve(repoRoot, 'packages/db-postgres/src/manifest.ts'),
  '@peek/db-redis/manifest': resolve(repoRoot, 'packages/db-redis/src/manifest.ts'),
  '@peek/db-qdrant/manifest': resolve(repoRoot, 'packages/db-qdrant/src/manifest.ts'),
  '@peek/db-sql/manifest': resolve(repoRoot, 'packages/db-sql/src/manifest.ts'),
  '@peek/db-neo4j/manifest': resolve(repoRoot, 'packages/db-neo4j/src/manifest.ts'),
  // The manifest's other half: the three strings that name a connection. Same
  // rule, same reason — `src/drivers/manifests.ts` collects these next to the
  // manifests, so a missing entry here would rewrite to `index.ts/display` and
  // pull a database client into whichever chunk imported it.
  '@peek/db-postgres/display': resolve(repoRoot, 'packages/db-postgres/src/display.ts'),
  '@peek/db-redis/display': resolve(repoRoot, 'packages/db-redis/src/display.ts'),
  '@peek/db-qdrant/display': resolve(repoRoot, 'packages/db-qdrant/src/display.ts'),
  '@peek/db-sql/display': resolve(repoRoot, 'packages/db-sql/src/display.ts'),
  '@peek/db-neo4j/display': resolve(repoRoot, 'packages/db-neo4j/src/display.ts'),
  // A second client-free subpath, for the same reason as `/manifest`: main plans
  // a package view's `autoFetch` while a Command is reducing, and this is the
  // module that answers it. Reaching it through `index.ts` would put a Bolt
  // client in the main-process chunk.
  '@peek/db-neo4j/view': resolve(repoRoot, 'packages/db-neo4j/src/view.ts'),
  // Two more, same rule, split by which process loads them: main registers the
  // package's tools from `/mcp-tool-meta` (declarations only, so listing a tool
  // wakes nothing), and the package host runs them from `/mcp-tools`. Both must
  // be reachable without `index.ts`.
  '@peek/db-neo4j/mcp-tool-meta': resolve(repoRoot, 'packages/db-neo4j/src/mcp-tool-meta.ts'),
  '@peek/db-neo4j/mcp-tools': resolve(repoRoot, 'packages/db-neo4j/src/mcp-tools.ts'),
  // The kernel has a subpath of its own now, and it is the same rule pointing
  // the other way: `@peek/core/package-manifest` is what *only main* may reach,
  // because reading a `peek-package.json` means `z.fromJSONSchema`. The barrel
  // re-exports its types with `export type *` so the window keeps the
  // vocabulary and none of the schemas — see `packages/core/src/index.ts` and
  // `assertWindowHoldsNoMainOnlyCore` below. The ordering rule above applies
  // unchanged: `'@peek/core'` would claim this specifier and rewrite it to
  // `…/src/index.ts/package-manifest`.
  '@peek/core/package-manifest': resolve(repoRoot, 'packages/core/src/package-manifest.ts'),
  '@peek/core': resolve(repoRoot, 'packages/core/src/index.ts'),
  '@peek/db-postgres': resolve(repoRoot, 'packages/db-postgres/src/index.ts'),
  '@peek/db-redis': resolve(repoRoot, 'packages/db-redis/src/index.ts'),
  '@peek/db-qdrant': resolve(repoRoot, 'packages/db-qdrant/src/index.ts'),
  '@peek/db-sql': resolve(repoRoot, 'packages/db-sql/src/index.ts'),
  '@peek/db-neo4j': resolve(repoRoot, 'packages/db-neo4j/src/index.ts'),
}

/**
 * Workspace packages that must be bundled instead of externalized.
 *
 * `externalizeDepsPlugin` externalizes everything listed in package.json
 * `dependencies`, which is right for real npm packages but wrong for
 * `workspace:*` entries — there is no publishable build output to require at
 * runtime, only TypeScript sources reached through `peekAlias`.
 */
const PEEK_BUNDLED = Object.keys(peekAlias)

/**
 * Optional dependencies of the bundled database clients, swapped for stubs.
 *
 * The table and the reasoning are in `scripts/optional-dep-alias.ts`, because
 * `scripts/build-packages.mjs` inlines the same clients into each package's
 * `driver.mjs` from a Rollup graph of its own and has to answer the same
 * question the same way. `assertNoUnresolvedImports` below is what turns the
 * next unstubbed one into a build failure instead of a runtime crash.
 */
const optionalDepAlias = optionalDepAliasFrom(rootDir)

/**
 * Fails the build when a chunk carries Vite's "Could not resolve" throw.
 *
 * That throw is emitted at chunk top level, so it is never a recoverable
 * "optional dependency missing" — it is a process that dies on load. Catching
 * it here names the specifier and points at `optionalDepAlias`, instead of
 * leaving it to be discovered as a crashed driver process at connection time.
 */
function assertNoUnresolvedImports(): Plugin {
  const UNRESOLVED_RE = /Could not resolve ["']([^"']+)["']/g
  return {
    name: 'peek:assert-no-unresolved-imports',
    apply: 'build',
    generateBundle(_options, bundle) {
      for (const [fileName, output] of Object.entries(bundle)) {
        if (output.type !== 'chunk') continue
        const specifiers = [...output.code.matchAll(UNRESOLVED_RE)].map((m) => m[1])
        if (specifiers.length === 0) continue
        this.error(
          `${fileName} contains a top-level throw for unresolved import(s): ${[...new Set(specifiers)].join(', ')}. ` +
            'The chunk will crash on load, not degrade. Add a stub to `optionalDepAlias` in ' +
            'electron.vite.config.ts (see pg-native-stub.ts), or install the dependency.',
        )
      }
    },
  }
}

/**
 * The `index` entry chunk of a bundle, or `undefined` if this build has none.
 *
 * The two checks below share it because they share a gate: both are claims about
 * the *main-process* build, and both must stay silent in the preload, renderer
 * and package-host builds, which have their own entries and their own boundaries
 * (`manifest-purity.test.ts` guards the window; package code in the package host
 * is the point).
 */
function mainEntryOf(bundle: Rollup.OutputBundle): Rollup.OutputChunk | undefined {
  for (const output of Object.values(bundle)) {
    if (output.type === 'chunk' && output.isEntry && output.name === 'index') return output
  }
  return undefined
}

/**
 * Fails the build when the package host is built in main's Rollup graph.
 *
 * This is a claim about build *topology*, not about content, and it needs to be
 * separate from `assertMainHoldsNoPackageCode` below because a re-merge does not
 * show up there. Measured, after the split landed: putting the package-host
 * entry back into `main.rollupOptions.input` builds green. Rollup gives the
 * package's implementation a chunk only `package-host.js` imports, main reaches
 * none of it, and the content check has nothing to report — correctly.
 *
 * What the merge restores is not a leak but the *conditions* for one. The moment
 * any module is imported by both entries — one convenience helper, one shared
 * constant — Rollup hoists it into a chunk both load, carrying the union of what
 * either needed, and §4quater(a) happens again. Between the merge and that
 * import the build is quiet, so the merge itself has to be the thing that fails:
 * it is the last moment where the cause is still legible.
 *
 * Keyed on the module rather than on the entry name, so renaming the input key
 * does not slip past.
 */
function assertPackageHostBuiltApart(): Plugin {
  const PACKAGE_HOST_ENTRY = resolve(rootDir, 'src/main/packages/entry.ts')
  return {
    name: 'peek:assert-package-host-built-apart',
    apply: 'build',
    generateBundle(_options, bundle) {
      if (mainEntryOf(bundle) === undefined) return

      // Every chunk, not just the ones main can reach: a sibling entry nobody
      // imports is exactly the state this exists to catch.
      for (const [fileName, output] of Object.entries(bundle)) {
        if (output.type !== 'chunk') continue
        const carries = Object.keys(output.modules).some(
          (moduleId) => (moduleId.split(' ').pop() ?? moduleId) === PACKAGE_HOST_ENTRY,
        )
        if (!carries) continue
        this.error(
          `${fileName} contains src/main/packages/entry.ts, so the package host is being built in ` +
            "main's Rollup graph. Two entries in one graph share chunks, and design 2026-08-07 " +
            '§2.4bis(a) is that they must not: main can decrypt every stored credential. The build ' +
            'is green right now only because no module happens to be imported by both entries yet — ' +
            'the next one that is would put package code in main silently. Remove the entry from ' +
            '`main.rollupOptions.input`; `electron.vite.package-host.config.ts` builds it.',
        )
      }
    },
  }
}

/**
 * Fails the build when a driver package's code is reachable from `index.js`.
 *
 * The artifact is the truth here, the same way it is for the shipped stylesheet
 * (`scripts/audit-shipped-css.mjs`), and for a sharper reason than usual: every
 * source-level guard in this repo answers "what does this file import", and the
 * leak this catches is invisible to all of them. Rollup assigns whole *modules*
 * to chunks and tree-shakes across the whole build, so one module imported by
 * both `index.ts` and `packages/entry.ts` lands in a chunk both entries load,
 * carrying the union of what either needed. Main then holds a package's mapping
 * without a single line of main's source naming it, `grep` over the entry file
 * reports nothing, and the process boundary §2.4bis bought is gone.
 *
 * So the check walks the emitted chunk graph from the main entry and looks at
 * which *modules* went into the chunks it can reach — not at strings, which
 * survive renaming badly, and not at the entry file, which is where the last
 * regression looked clean.
 *
 * Since the package host moved to a graph of its own
 * (`electron.vite.package-host.config.ts`) this is no longer the thing keeping
 * main clean — a separate build cannot hoist into main's chunks at all. What it
 * still guards is the *content* of main's own graph: today that is `display.ts`,
 * the one entry in `MAIN_MAY_REACH` (`scripts/main-may-reach.ts`) that is a debt
 * rather than a category, and
 * tomorrow it is whatever main's source starts importing. It does **not** guard
 * the split itself; `assertPackageHostBuiltApart` does, and the comment there
 * explains why that had to be a second check rather than this one.
 *
 * Nor does it guard the *pair* of builds, and it cannot: a vite plugin sees the build
 * it runs in. `scripts/audit-package-boundary.mjs` reads both bundles off disk
 * afterwards, which is the only place the two halves can be checked against each
 * other — that package code did leave main *and* arrive in the host, rather than
 * leaving main by evaporating.
 */
function assertMainHoldsNoPackageCode(): Plugin {
  const PACKAGE_SRC = /\/packages\/driver-[^/]+\/src\//
  return {
    name: 'peek:assert-main-holds-no-package-code',
    apply: 'build',
    generateBundle(_options, bundle) {
      const entry = mainEntryOf(bundle)
      if (entry === undefined) return

      const reached = new Set<string>()
      const queue = [entry.fileName]
      while (queue.length > 0) {
        const fileName = queue.shift()
        if (fileName === undefined || reached.has(fileName)) continue
        reached.add(fileName)
        const chunk = bundle[fileName]
        if (chunk === undefined || chunk.type !== 'chunk') continue
        queue.push(...chunk.imports, ...chunk.dynamicImports)
      }

      const offenders = new Map<string, string>()
      for (const fileName of reached) {
        const chunk = bundle[fileName]
        if (chunk === undefined || chunk.type !== 'chunk') continue
        for (const moduleId of Object.keys(chunk.modules)) {
          const path = moduleId.split(' ').pop() ?? moduleId
          if (!PACKAGE_SRC.test(path)) continue
          if (MAIN_MAY_REACH.some((allowed) => allowed.pattern.test(path))) continue
          offenders.set(relative(repoRoot, path), fileName)
        }
      }
      if (offenders.size === 0) return

      this.error(
        'The main process can reach driver package code:\n' +
          [...offenders].map(([path, chunk]) => `  ${path}  (in ${chunk})`).join('\n') +
          '\nDesign 2026-08-07 §2.4bis(a): a package runs in its own host process, because main ' +
          'decrypts every stored credential. Split the module so that main imports only the ' +
          'declarative half — `drivers/mcpTools.ts` is the worked example — or, if main genuinely ' +
          'must hold this, add it to `MAIN_MAY_REACH` in scripts/main-may-reach.ts with the reason.',
      )
    },
  }
}

/**
 * Fails the renderer build when a main-only module of `@peek/core` ships in it.
 *
 * The mirror of `assertMainHoldsNoPackageCode`, and it exists because the same
 * leak has the opposite shape on this side. Main's danger is a *value* import
 * of something it must not run. The window's is a **barrel**: `@peek/core` is
 * one `export *` list, so a module added to it joins every graph that imports
 * the kernel at all, and Rollup then keeps it whether or not the window names
 * anything in it — zod's constructors carry no pure annotation, so a file of
 * top-level `z.object(…)` is a side effect by Rollup's rules and correctly
 * survives tree-shaking.
 *
 * That already happened once, and the bill is the reason this is a build
 * failure rather than a review note: `package-manifest.ts` rode into the window
 * with `z.fromJSONSchema` behind it — measured at ~36.7 KB of a 671,927 B chunk
 * (design 2026-08-07 §4tervicies(c)) for a parse only the package loader can
 * reach. Nothing failed. The window simply got bigger, which is the one
 * regression this repo has no other alarm for.
 *
 * Keyed on module paths rather than on strings for the reason its sibling
 * gives: the chunk is minified, and `keepNames` preserves function names but
 * nothing about a `const` holding a schema. `export type *` is what keeps the
 * types available without the bytes; this is what notices when someone spells
 * it `export *` again, or reaches the module through a fresh import.
 */
function assertWindowHoldsNoMainOnlyCore(): Plugin {
  /*
   * Each entry is a module the window may not carry, with the sentence that
   * explains it. Hand-written for the same reason `SUBPATHS` in
   * `subpath-purity.test.ts` is: the claim is about these modules, and deriving
   * the list from the barrel would let the next one in unguarded.
   */
  const MAIN_ONLY_CORE: readonly { path: string; why: string }[] = [
    {
      path: resolve(repoRoot, 'packages/core/src/package-manifest.ts'),
      why: "reading a `peek-package.json` is the loader's job, and `z.fromJSONSchema` is how it turns a package's declared tool arguments into a validator",
    },
  ]
  return {
    name: 'peek:assert-window-holds-no-main-only-core',
    apply: 'build',
    generateBundle(_options, bundle) {
      // A path that names nothing matches nothing, and this check would report
      // the leak it was written for as absent, forever. The list is compared
      // against Rollup's ids, which are real files, so a renamed module has to
      // fail here rather than pass everywhere.
      for (const entry of MAIN_ONLY_CORE) {
        if (existsSync(entry.path)) continue
        this.error(
          `${relative(repoRoot, entry.path)} does not exist, so this check is now vacuous. ` +
            'Either the module moved — fix `MAIN_ONLY_CORE` in electron.vite.config.ts — or the ' +
            'kernel subpath is broken.',
        )
      }

      const offenders = new Map<string, { chunk: string; why: string }>()
      for (const [fileName, output] of Object.entries(bundle)) {
        if (output.type !== 'chunk') continue
        for (const moduleId of Object.keys(output.modules)) {
          // A Rollup id can arrive prefixed ("\0commonjs-proxy:/abs/path"), so
          // the path is the last space-separated field, as above.
          const path = moduleId.split(' ').pop() ?? moduleId
          const banned = MAIN_ONLY_CORE.find((entry) => entry.path === path)
          if (banned === undefined) continue
          offenders.set(relative(repoRoot, path), { chunk: fileName, why: banned.why })
        }
      }
      if (offenders.size === 0) return

      this.error(
        'The window carries a main-only module of @peek/core:\n' +
          [...offenders].map(([path, { chunk, why }]) => `  ${path}  (in ${chunk}) — ${why}`).join('\n') +
          '\nThe kernel barrel re-exports these with `export type *` so the renderer keeps the ' +
          'vocabulary and none of the schemas (packages/core/src/index.ts). Import the values from ' +
          '`@peek/core/package-manifest` in main, and the types from `@peek/core` anywhere.',
      )
    },
  }
}

/* ==================================================================== */
/* Workaround: electron-vite's ESM shim lands inside a function body      */
/* ==================================================================== */

/**
 * Chunks that need it get a CommonJS shim (`require` / `__filename` /
 * `__dirname`) from electron-vite's `vite:esm-shim`. That vite plugin appends the
 * shim after the **last static import**, which it locates with a regex over the
 * raw chunk text — a scan that cannot tell code from comments.
 *
 * The driver-host bundle inlines the redis client, whose `@redis/json` source
 * carries a commented-out `// import RESP from './RESP';` and whose JSDoc has
 * `@example` blocks full of import statements. The regex matches the last of
 * those, ~80k lines in and nested inside a factory function, so the shim's
 * `import __cjs_mod__ from 'node:module'` is emitted mid-function and the build
 * dies in `vite:esbuild-transpile` with `Unexpected "__cjs_mod__"`.
 *
 * The shim itself is legitimate — the bundle really does contain runtime
 * `require('node:crypto')` / `require('stream')` calls from undici and
 * iconv-lite — so it cannot simply be suppressed; it only has to go somewhere
 * legal. This vite plugin emits it at the very top of the chunk first. `vite:esm-shim`
 * bails out when the shim text is already present, so pre-empting it is the
 * whole fix.
 *
 * Ordering is the reason this vite plugin declares no `enforce`: normal-order
 * `renderChunk` hooks run before every `post` one, and `vite:esm-shim` is `post`.
 */
function cjsShimAtTopPlugin(): Plugin {
  // Kept byte-identical to electron-vite's own constants (dist/chunks/lib-*.js,
  // `CJSShim_node_20_11` / `CJSShim_normal`) — its skip check is a substring
  // match, so any drift means both copies land and the duplicate `const
  // __filename` fails the build. `assertSingleShim` below turns that into a
  // legible message instead of a rollup parse error.
  const CJS_SHIM_MODERN = `
// -- CommonJS Shims --
import __cjs_mod__ from 'node:module';
const __filename = import.meta.filename;
const __dirname = import.meta.dirname;
const require = __cjs_mod__.createRequire(import.meta.url);
`
  const CJS_SHIM_LEGACY = `
// -- CommonJS Shims --
import __cjs_url__ from 'node:url';
import __cjs_path__ from 'node:path';
import __cjs_mod__ from 'node:module';
const __filename = __cjs_url__.fileURLToPath(import.meta.url);
const __dirname = __cjs_path__.dirname(__filename);
const require = __cjs_mod__.createRequire(import.meta.url);
`
  // Same predicate electron-vite uses to decide a chunk needs the shim.
  const CJS_SYNTAX_RE = /__filename|__dirname|require\(|require\.resolve\(/
  /**
   * Counts emitted shims in the *final* chunk.
   *
   * Not the `// -- CommonJS Shims --` comment: `vite:esbuild-transpile` runs
   * after this vite plugin and strips comments, so a marker-based check would read 0
   * every time and quietly never fire.
   *
   * Nor the `__cjs_mod__` identifier, which is what this used to match: with
   * `build.minify` on, esbuild's `minifyIdentifiers` renames every top-level
   * binding of an ES chunk, so the shim's import becomes `import x from
   * "node:module"` and an identifier-based pattern silently reads 0 forever —
   * the exact "quietly never fires" failure the comment above warns about.
   * A *default import of `node:module`* is the one part of the shim that no
   * transform can rewrite away, and it is emitted exactly once per shim.
   */
  const SHIM_IMPORT_RE = /import\s+[A-Za-z_$][\w$]*\s+from\s*["']node:module["']/g

  // electron-vite picks the variant by Electron major (>= 30 has
  // import.meta.filename / .dirname). Mirroring the rule rather than hardcoding
  // one keeps this correct if the app is ever pinned back to an older Electron.
  const electronMajor = Number.parseInt(
    (createRequire(import.meta.url)('electron/package.json') as { version: string }).version,
    10,
  )
  const shim = electronMajor >= 30 ? CJS_SHIM_MODERN : CJS_SHIM_LEGACY

  return {
    name: 'peek:cjs-shim-at-top',
    apply: 'build',
    /**
     * Drift detection, checked against the source of truth rather than inferred
     * from the output.
     *
     * `generateBundle` below can only notice drift *after* it has already broken
     * the build, and only when the breakage survives that far: with
     * `build.minify` on, `vite:esbuild-transpile` runs first and reports the
     * duplicate `__cjs_mod__` as a raw esbuild error, which says nothing about
     * where the two copies came from. Reading electron-vite's own dist and
     * asserting our copy is still a substring of it catches the same drift one
     * step earlier, with the message that actually names the fix.
     */
    buildStart() {
      const req = createRequire(import.meta.url)
      let dist: string
      try {
        dist = dirname(req.resolve('electron-vite'))
      } catch {
        return // not resolvable from here; the generateBundle net still applies
      }
      const chunkDir = resolve(dist, 'chunks')
      let found = false
      try {
        found = readdirSync(chunkDir)
          .filter((f) => f.endsWith('.js'))
          .some((f) => readFileSync(resolve(chunkDir, f), 'utf8').includes(shim.trimEnd()))
      } catch {
        // The dist layout moved. That is itself drift worth reporting, and
        // falling through to this.error() below says so in the same words —
        // an ENOENT stack would not.
      }
      if (!found) {
        this.error(
          "electron-vite's CommonJS shim text no longer matches the copy in cjsShimAtTopPlugin " +
            '(electron.vite.config.ts). Its skip check is a substring match, so both copies will land ' +
            'and the duplicate `const __filename` will fail the build. Re-copy the constant from ' +
            `electron-vite ${resolve(dist, 'chunks')}/lib-*.js.`,
        )
      }
    },
    renderChunk(code, _chunk, { format }) {
      if (format !== 'es') return null
      if (code.includes(shim) || !CJS_SYNTAX_RE.test(code)) return null
      // Prepending is safe ahead of the chunk's own imports: ESM hoists import
      // declarations, so the shim's bindings are initialized before any module
      // body statement runs — which is exactly what the `require()` callers need.
      return { code: shim + code, map: null }
    },
    generateBundle(_options, bundle) {
      for (const [fileName, output] of Object.entries(bundle)) {
        if (output.type !== 'chunk') continue
        const hits = output.code.match(SHIM_IMPORT_RE)?.length ?? 0
        if (hits > 1) {
          this.error(
            `${fileName}: ${String(hits)} CommonJS shims were emitted. electron-vite's shim text no longer ` +
              'matches the copy in cjsShimAtTopPlugin (electron.vite.config.ts), so its skip check missed. ' +
              'Re-copy the constant from electron-vite dist/chunks/lib-*.js.',
          )
        }
      }
    },
  }
}

/* ==================================================================== */
/* Minification                                                          */
/* ==================================================================== */

/**
 * electron-vite forces `build.minify: false` on all three targets (see its
 * `dist/chunks/lib-*.js` default configs), on the reasonable assumption that a
 * desktop bundle is read off local disk. It still costs real bytes and real
 * parse time — measured on this app, unminified → esbuild-minified:
 *
 *   renderer index      1,264,081 → 563,734 B  (-55%)
 *   renderer SqlEditor    882,005 → 433,995 B  (-51%)
 *   renderer CSS           57,917 →  32,550 B  (-44%)
 *   main index            327,010 → 175,091 B  (-46%)
 *   main driver-host    3,886,332 → 2,192,870 B (-44%)
 *
 * Those are the M6 figures, kept as they were measured: what they are here to
 * argue is that minifying is worth switching on, and a ratio does not go stale
 * the way a size does. Current sizes live in PLAN §8.2, which has a re-measured
 * column beside them. One ratio there did move and it is worth knowing about:
 * the renderer CSS now compresses by -31% rather than -44%, because Tailwind's
 * output is utility rules with almost no whitespace or repetition left in it.
 *
 * `esbuild` (not `terser`) because it is already in the dependency tree and the
 * marginal gain from terser does not pay for a second minifier.
 */
const MINIFY = 'esbuild' as const

/**
 * Main-process esbuild options.
 *
 * `keepNames` is the whole point: `minifyIdentifiers` otherwise rewrites every
 * function and class name in the chunk, and the main process is where stack
 * traces are actually read — every uncaught rejection, every driver-host crash,
 * every `PeekError` surfaced to MCP goes through one. The cost is a handful of
 * `__name()` calls; measured on driver-host it is under 2% of the minified size,
 * which is a bargain next to an unreadable trace.
 *
 * Not applied to the renderer: nothing reads a renderer stack in anger, React's
 * component names come from its own displayName machinery, and the bytes are on
 * the cold-start path.
 *
 * **Never applied to the preload** — see the comment on that target below.
 */
const NODE_ESBUILD = { keepNames: true } as const

/**
 * Everything an Electron-main-process bundle in this app is built with, minus
 * the entry points and the directory to write them to.
 *
 * Exported because there is more than one such build, and because the *reason*
 * there is more than one is that they must not be one:
 * `electron.vite.package-host.config.ts` gives the package host a Rollup graph
 * of its own (§4quater(d)). Sharing settings is the whole point — same aliases,
 * same externals, same minifier, so the two bundles cannot drift in how they
 * were made; sharing a *graph* is the thing that leaked. Keeping the settings in
 * one function is what stops "two builds" from turning into "two answers to what
 * an optional dependency stub is".
 */
export function mainProcessTarget(input: Record<string, string>, outDir: string): MainViteConfig {
  return {
    plugins: [
      externalizeDepsPlugin({ exclude: PEEK_BUNDLED }),
      cjsShimAtTopPlugin(),
      assertNoUnresolvedImports(),
      assertPackageHostBuiltApart(),
      assertMainHoldsNoPackageCode(),
    ],
    resolve: { alias: { ...peekAlias, ...optionalDepAlias } },
    esbuild: NODE_ESBUILD,
    build: { outDir, minify: MINIFY, rollupOptions: { input } },
  }
}

export default defineConfig({
  /*
   * main: the Electron main process. Hosts the Command Bus, the Workspace source
   * of truth, and the MCP HTTP server.
   *
   * Two entries, and the package host is deliberately not a third — it is built
   * by `electron.vite.package-host.config.ts` instead, in a graph of its own.
   * Adding it back here fails the build in `assertPackageHostBuiltApart`, which
   * is the only place that failure can still be traced to its cause.
   */
  main: mainProcessTarget(
    {
      // Main-process entry point
      index: resolve(rootDir, 'src/main/index.ts'),
      // driver host: one utilityProcess per connection, forked by main
      'driver-host': resolve(rootDir, 'src/main/driver-host/entry.ts'),
    },
    'out/main',
  ),

  /**
   * preload: exposes one narrow bridge and nothing else (invoke / onPatch /
   * onResultPort).
   *
   * **Deliberately not minified**, and this is not an oversight.
   *
   * `src/preload/index.ts` hands `bootstrapMainWorld` to
   * `contextBridge.executeInMainWorld({ func })`. Electron implements that by
   * taking the function's *source text* and evaluating it in the main world, so
   * the function must be completely self-contained — it can reach nothing from
   * the module around it, because none of that module exists over there.
   *
   * Minification breaks that rule the moment it hoists anything. Turning
   * `keepNames` on here (harmless everywhere else) made esbuild emit
   * `var a = (r, o) => Object.defineProperty(r, "name", …)` at module scope and
   * rewrite the nested functions inside `bootstrapMainWorld` as `a(…)` — so the
   * main world got `ReferenceError: a is not defined`, the bootstrap fell into
   * its degraded branch, and **the data plane went away silently**: the window
   * still opened, commands still worked, and result MessagePorts simply never
   * arrived. Measured, not hypothesised.
   *
   * Plain `minify: 'esbuild'` without `keepNames` happens to leave the function
   * self-contained today, but that is a property of the current minifier and of
   * the current source, not a guarantee — a TypeScript downlevel helper or a
   * future esbuild pass reintroduces the same silent failure. The entire prize
   * is 4.6 kB on a file parsed once per window, against a failure mode that
   * looks exactly like a working app. Not worth it.
   */
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: ['@peek/core'] })],
    resolve: { alias: peekAlias },
    build: {
      outDir: 'out/preload',
      minify: false,
      rollupOptions: {
        input: { index: resolve(rootDir, 'src/preload/index.ts') },
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },

  // renderer: the React UI. root points at the app package root, where index.html lives.
  renderer: {
    root: rootDir,
    /*
     * `tailwindcss()` is on this target and only this target. It is a CSS
     * pipeline, and the other two produce no CSS at all — main and preload are
     * Node bundles, and handing them a vite plugin that scans source files for class
     * names would cost build time to emit nothing. The renderer is also the only
     * place the theme exists: `src/renderer/styles.css` holds the `@theme` block
     * (it was `theme.css` until the eight sheets were merged back into one —
     * migration record §11.1), and the tailwind plugin's job is to turn it into custom
     * properties plus the handful of utilities the TSX actually names.
     *
     * "Into custom properties" is load-bearing rather than descriptive, and it
     * is the reason there is no `tailwind.config.js` beside this file. A JS
     * config is honoured here — `@config` resolves and its theme compiles real
     * utilities — but the compatibility layer registers those values inline: the
     * utility carries the literal and **no custom property is emitted**. The 74
     * declarations in `styles.css` that read the theme through `var()` have
     * nothing left to read once the block moves: the measured result is a build
     * that exits 0 while shipping 86 dangling references. Measured on the real
     * tree rather than reasoned about; the numbers are over the `@theme` block.
     *
     * Deliberately *not* extended to the package UI: `packages/db-neo4j/ui/`
     * is built by `scripts/build-packages.mjs` into an iframe with its own CSP,
     * and it keeps its own stylesheet. See
     * docs/design/2026-08-04-tailwind-migration.md §4.4.
     */
    plugins: [react(), tailwindcss(), assertWindowHoldsNoMainOnlyCore()],
    resolve: { alias: peekAlias },
    build: {
      outDir: 'out/renderer',
      minify: MINIFY,
      // Renderer only: CSS minification is a separate switch from `build.minify`
      // in Vite (it defaults to the same value, but electron-vite pins
      // `build.minify` to false *after* that default is resolved, so it has to
      // be stated).
      cssMinify: MINIFY,
      rollupOptions: {
        input: { index: resolve(rootDir, 'index.html') },
      },
    },
    server: {
      // Cold-start budget is under 1.5s, so pre-bundle the heavy dependencies
      warmup: { clientFiles: ['./src/renderer/main.tsx'] },
    },
  },
})
