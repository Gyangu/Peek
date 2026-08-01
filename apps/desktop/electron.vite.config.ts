import { readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'

const rootDir = __dirname
// Monorepo root, used to alias @peek/* straight at the sources (no build step first)
const repoRoot = resolve(rootDir, '../..')

// Every @peek/* package is aliased at its sources rather than at a built entry
// point: the workspace has no build step, so a missing alias here fails at
// runtime with an unresolved bare specifier rather than at build time. Adding a
// driver package means one line here and one in `PEEK_BUNDLED` below.
const peekAlias = {
  '@peek/core': resolve(repoRoot, 'packages/core/src/index.ts'),
  '@peek/driver-postgres': resolve(repoRoot, 'packages/driver-postgres/src/index.ts'),
  '@peek/driver-redis': resolve(repoRoot, 'packages/driver-redis/src/index.ts'),
  '@peek/driver-qdrant': resolve(repoRoot, 'packages/driver-qdrant/src/index.ts'),
  '@peek/driver-sql': resolve(repoRoot, 'packages/driver-sql/src/index.ts'),
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

/* ==================================================================== */
/* Workaround: electron-vite's ESM shim lands inside a function body      */
/* ==================================================================== */

/**
 * Chunks that need it get a CommonJS shim (`require` / `__filename` /
 * `__dirname`) from electron-vite's `vite:esm-shim`. That plugin appends the
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
 * legal. This plugin emits it at the very top of the chunk first. `vite:esm-shim`
 * bails out when the shim text is already present, so pre-empting it is the
 * whole fix.
 *
 * Ordering is the reason this plugin declares no `enforce`: normal-order
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
   * after this plugin and strips comments, so a marker-based check would read 0
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

export default defineConfig({
  // main: the Electron main process. Hosts the Command Bus, the Workspace source of
  // truth, and the MCP HTTP server.
  main: {
    plugins: [externalizeDepsPlugin({ exclude: PEEK_BUNDLED }), cjsShimAtTopPlugin()],
    resolve: { alias: peekAlias },
    esbuild: NODE_ESBUILD,
    build: {
      outDir: 'out/main',
      minify: MINIFY,
      rollupOptions: {
        input: {
          // Main-process entry point
          index: resolve(rootDir, 'src/main/index.ts'),
          // driver host: one utilityProcess per connection, forked by main
          'driver-host': resolve(rootDir, 'src/main/driver-host/entry.ts'),
        },
      },
    },
  },

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
    plugins: [react()],
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
