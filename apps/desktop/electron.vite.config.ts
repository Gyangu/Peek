import { createRequire } from 'node:module'
import { resolve } from 'node:path'
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
   * every time and quietly never fire. `__cjs_mod__` is an identifier, unique to
   * electron-vite's shim, and survives transpile — esbuild only ever suffixes it
   * (`__cjs_mod__2`) when deduplicating, which this pattern still counts.
   */
  const SHIM_IMPORT_RE = /__cjs_mod__\d*\s+from\s*["']node:module["']/g

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

export default defineConfig({
  // main: the Electron main process. Hosts the Command Bus, the Workspace source of
  // truth, and the MCP HTTP server.
  main: {
    plugins: [externalizeDepsPlugin({ exclude: PEEK_BUNDLED }), cjsShimAtTopPlugin()],
    resolve: { alias: peekAlias },
    build: {
      outDir: 'out/main',
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

  // preload: exposes one narrow bridge and nothing else (invoke / onPatch / onResultPort)
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: ['@peek/core'] })],
    resolve: { alias: peekAlias },
    build: {
      outDir: 'out/preload',
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
