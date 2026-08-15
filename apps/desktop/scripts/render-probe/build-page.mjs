/**
 * Builds the page the render probe measures.
 *
 * Two inputs, both of which must be the **real** ones:
 *
 *  - the **shipped stylesheet**, read out of `out/renderer/assets/*.css` — the
 *    artifact `pnpm build` just produced, not `styles.css` and not a re-compile
 *    of it. Every number the probe reports is therefore a number about the thing
 *    that ships;
 *  - the **product's own components**, bundled from `fixture.tsx` with the same
 *    aliases the app is built with.
 *
 * Both end up **inlined into one HTML file**, and each inlining is a workaround
 * for a `file://` rule that has already cost this session an afternoon:
 *
 *  - a `<link>`ed stylesheet on `file://` is a *cross-origin* stylesheet in
 *    Chromium, so `sheet.cssRules` throws and "did the stylesheet load?" cannot
 *    be answered by counting rules. Inlined into a `<style>` it is same-origin
 *    and readable — which is what lets the probe assert the sheet is non-empty
 *    instead of hoping;
 *  - an *external* `<script type="module">` on `file://` is blocked outright by
 *    the module fetch's CORS check. An inline one runs, so the bundle is emitted
 *    with `inlineDynamicImports` and pasted in.
 *
 * Neither inlining changes what is painted: one stylesheet in, same order, same
 * `@layer` statements, same bytes.
 */

import { readFileSync, readdirSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import react from '@vitejs/plugin-react'
import { build } from 'vite'

const here = dirname(fileURLToPath(import.meta.url))
export const appDir = resolve(here, '../..')
const repoRoot = resolve(appDir, '../..')

/**
 * The same aliases `electron.vite.config.ts` gives the renderer, restated.
 *
 * Restated rather than imported: that file is TypeScript, uses `__dirname`, and
 * exports a config for three Electron targets — importing it here would mean
 * running the whole thing to read one object. The duplication is safe in the one
 * direction that matters: a missing entry is an **unresolved import**, and Vite
 * fails the build on it. It cannot silently resolve to something else.
 */
const peekAlias = {
  '@peek/db-postgres/manifest': resolve(repoRoot, 'packages/db-postgres/src/manifest.ts'),
  '@peek/db-redis/manifest': resolve(repoRoot, 'packages/db-redis/src/manifest.ts'),
  '@peek/db-qdrant/manifest': resolve(repoRoot, 'packages/db-qdrant/src/manifest.ts'),
  '@peek/db-sql/manifest': resolve(repoRoot, 'packages/db-sql/src/manifest.ts'),
  '@peek/db-neo4j/manifest': resolve(repoRoot, 'packages/db-neo4j/src/manifest.ts'),
  '@peek/db-postgres/display': resolve(repoRoot, 'packages/db-postgres/src/display.ts'),
  '@peek/db-redis/display': resolve(repoRoot, 'packages/db-redis/src/display.ts'),
  '@peek/db-qdrant/display': resolve(repoRoot, 'packages/db-qdrant/src/display.ts'),
  '@peek/db-sql/display': resolve(repoRoot, 'packages/db-sql/src/display.ts'),
  '@peek/db-neo4j/display': resolve(repoRoot, 'packages/db-neo4j/src/display.ts'),
  '@peek/db-neo4j/view': resolve(repoRoot, 'packages/db-neo4j/src/view.ts'),
  '@peek/db-neo4j/mcp-tools': resolve(repoRoot, 'packages/db-neo4j/src/mcp-tools.ts'),
  // The declarative half. Reached by `drivers/__tests__/in-repo-packages.ts`,
  // which the fixture below installs as its registry: since §4duodevicies the
  // tool list is part of a registry, and the probe fills the same slot the
  // window fills from `IPC.PACKAGES_READ`.
  '@peek/db-neo4j/mcp-tool-meta': resolve(repoRoot, 'packages/db-neo4j/src/mcp-tool-meta.ts'),
  '@peek/core': resolve(repoRoot, 'packages/core/src/index.ts'),
  '@peek/db-postgres': resolve(repoRoot, 'packages/db-postgres/src/index.ts'),
  '@peek/db-redis': resolve(repoRoot, 'packages/db-redis/src/index.ts'),
  '@peek/db-qdrant': resolve(repoRoot, 'packages/db-qdrant/src/index.ts'),
  '@peek/db-sql': resolve(repoRoot, 'packages/db-sql/src/index.ts'),
  '@peek/db-neo4j': resolve(repoRoot, 'packages/db-neo4j/src/index.ts'),
}

/**
 * A stylesheet this small cannot be the app's.
 *
 * The artifact has been between 39 kB and 58 kB all migration. The floor is here
 * because the failure this probe exists to prevent is *measuring an unstyled
 * page and reporting plausible numbers off it*, and the cheapest way in is a
 * stylesheet that resolved to something empty.
 */
const MIN_ARTIFACT_BYTES = 10_000

export class ProbeSetupError extends Error {}

/** The one shipped stylesheet, or a failure that names what was found instead. */
export function readShippedCss() {
  const assets = resolve(appDir, 'out/renderer/assets')
  let names
  try {
    names = readdirSync(assets).filter((n) => n.endsWith('.css'))
  } catch {
    throw new ProbeSetupError(
      `no built renderer at ${assets}. The render probe measures the shipped artifact, ` +
        'so it needs `pnpm build` to have run first.',
    )
  }
  if (names.length !== 1) {
    throw new ProbeSetupError(
      `expected exactly 1 stylesheet in ${assets}, found ${String(names.length)}: ${names.join(', ')}`,
    )
  }
  const path = resolve(assets, names[0])
  const text = readFileSync(path, 'utf8')
  if (text.length < MIN_ARTIFACT_BYTES) {
    throw new ProbeSetupError(
      `${path} is ${String(text.length)} B, under the ${String(MIN_ARTIFACT_BYTES)} B floor. ` +
        "A stylesheet that small is not this app's, and measuring against it would produce " +
        'plausible numbers off an unstyled page.',
    )
  }
  return { path, name: names[0], text }
}

/** Bundles `fixture.tsx` into one self-contained ES module. */
async function bundleFixture(outDir) {
  rmSync(outDir, { recursive: true, force: true })
  await build({
    root: here,
    configFile: false,
    logLevel: 'error',
    plugins: [react()],
    resolve: { alias: peekAlias },
    define: {
      'import.meta.env.DEV': 'false',
      // React reads `process.env.NODE_ENV` seventeen times in this bundle, and
      // a `file://` renderer with no node integration has no `process` — so
      // without this the module dies at its first line with
      // `ReferenceError: process is not defined`, nothing mounts, and the page
      // is blank. Vite's own production define does not reach a `configFile:
      // false` lib build; measured by watching it happen.
      'process.env.NODE_ENV': '"production"',
    },
    build: {
      outDir,
      emptyOutDir: true,
      minify: false,
      lib: { entry: resolve(here, 'fixture.tsx'), formats: ['es'], fileName: 'fixture' },
      rollupOptions: { output: { inlineDynamicImports: true } },
    },
  })
  const js = readFileSync(resolve(outDir, 'fixture.js'), 'utf8')
  if (js.length < 50_000) {
    throw new ProbeSetupError(
      `the fixture bundle is only ${String(js.length)} B; it cannot contain React and the ` +
        'product components. Something resolved to a stub.',
    )
  }
  return js
}

/**
 * Writes the page and returns its path.
 *
 * No CSP meta: the app's own page carries one, but a policy governs fetching,
 * not painting, and a `file://` page with `script-src 'self'` cannot run the
 * inline module this page is built around. Nothing the probe asserts is
 * downstream of CSP.
 */
export async function buildProbePage({ transformCss = null } = {}) {
  const css = readShippedCss()
  /*
   * `transformCss` is how a seeded defect is planted in the **stylesheet**, and
   * it is worth being precise about what it touches: `readShippedCss()` has
   * already returned a *string*. Everything downstream operates on that copy and
   * the page is written to `out/render-probe/page.html`. `styles.css` is another
   * agent's file and is never opened here; `out/renderer/assets/*.css` is opened
   * read-only and never written. Planting a defect therefore cannot survive the
   * process that planted it.
   */
  if (transformCss !== null) {
    const before = css.text
    css.text = transformCss(before)
    if (css.text === before) {
      throw new ProbeSetupError(
        'the planted stylesheet defect changed nothing. A plant that does not plant would let ' +
          'the run that is supposed to prove a check can go red pass for the wrong reason.',
      )
    }
  }
  const outDir = resolve(appDir, 'out/render-probe')
  const js = await bundleFixture(resolve(outDir, 'bundle'))
  const page = resolve(outDir, 'page.html')
  mkdirSync(dirname(page), { recursive: true })
  writeFileSync(
    page,
    [
      '<!doctype html>',
      '<html lang="en">',
      '<head><meta charset="UTF-8" />',
      `<title>peek render probe</title>`,
      // Exactly one <style>, so `document.styleSheets.length === 1` is a real
      // assertion about the artifact rather than about the harness.
      `<style>\n${css.text}\n</style>`,
      // Fail-closed, installed before the module so it is already listening when
      // the module is evaluated. `fixture.tsx` wraps its own `mount()` in a
      // try/catch, but a module that dies *before* its first statement — a
      // missing global, a bad import — never reaches that catch, and the probe
      // then sees a blank page with `__probeError` still null. That is exactly
      // the "read nothing, report plausible numbers" failure this whole probe
      // exists to make impossible, so the page reports it about itself.
      '<script>',
      'window.addEventListener("error", function (e) {',
      '  if (window.__probeError === undefined) {',
      '    window.__probeError = "uncaught in the page: " + String(e.message) + " @line " + String(e.lineno)',
      '  }',
      '})',
      'window.addEventListener("unhandledrejection", function (e) {',
      '  if (window.__probeError === undefined) {',
      '    window.__probeError = "unhandled rejection in the page: " + String(e.reason)',
      '  }',
      '})',
      '</script>',
      '</head>',
      '<body><div id="root"></div>',
      `<script type="module">\n${js}\n</script>`,
      '</body></html>',
    ].join('\n'),
    'utf8',
  )
  return { page, css }
}
