#!/usr/bin/env node
import { existsSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

/* ====================================================================
 * Build every plugin's self-drawn UI into `out/plugin-ui/<pluginId>/`.
 *
 * A pass of its own, run before `electron-vite build`, and **one Vite build per
 * plugin** rather than one build with several inputs. Both of those are
 * load-bearing rather than tidiness:
 *
 * - *Separate from the window's build*, because a single Rollup graph is allowed
 *   to hoist common code into a shared chunk, and a chunk shared between the
 *   host realm and a plugin realm is precisely what `peek-plugin://` exists to
 *   make impossible. Two graphs cannot share one.
 * - *Separate from each other*, for a sharper version of the same thing: two
 *   plugins are cross-origin, so a chunk hoisted out of both would be fetched
 *   from exactly one of the two origins and fail the CSP of the other. The
 *   symptom would be one plugin working and the other silently blank, depending
 *   on build order.
 *
 * See docs/design/2026-08-03-plugin-architecture.md §2.6.
 * ==================================================================== */

const scriptDir = dirname(fileURLToPath(import.meta.url))
const packageDir = resolve(scriptDir, '..')
const repoRoot = resolve(packageDir, '../..')
const packagesDir = join(repoRoot, 'packages')
const outRoot = join(packageDir, 'out', 'plugin-ui')

/**
 * A plugin contributes a UI by having `ui/index.html`; nothing registers it
 * anywhere else.
 *
 * The plugin id is the package's directory name minus the `driver-` prefix, so
 * `packages/driver-neo4j` serves at `peek-plugin://neo4j`. It has to satisfy the
 * same pattern `resolvePluginAsset` enforces on the URL host — an id that
 * assembles into a URL the handler then refuses would build cleanly and 404 at
 * runtime, which is the worst place to find out.
 */
const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/

function discoverPluginUis() {
  if (!existsSync(packagesDir)) return []
  const found = []
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const uiRoot = join(packagesDir, entry.name, 'ui')
    if (!existsSync(join(uiRoot, 'index.html'))) continue
    const id = entry.name.replace(/^driver-/, '')
    if (!ID_PATTERN.test(id)) {
      throw new Error(
        `packages/${entry.name} contributes a UI but its plugin id "${id}" is not servable: ` +
          `peek-plugin:// hosts must match ${String(ID_PATTERN)} (see main/plugins/protocol.ts).`,
      )
    }
    found.push({ id, uiRoot })
  }
  return found
}

const plugins = discoverPluginUis()
if (plugins.length === 0) {
  console.log('[peek/plugin-ui] no packages contribute a ui/ directory — nothing to build')
  process.exit(0)
}

for (const plugin of plugins) {
  await build({
    root: plugin.uiRoot,
    // Relative, because the document is served from the root of its own origin
    // and has no idea what that origin is called. An absolute base would bake
    // `peek-plugin://<id>` into the HTML and make the bundle un-relocatable.
    base: './',
    configFile: false,
    logLevel: 'warn',
    resolve: {
      // Only ever reached by `import type`, which is erased before Rollup sees
      // it — the alias is here so that a *value* import of core fails loudly at
      // build time with a plain missing-file error, rather than resolving and
      // quietly putting zod inside a plugin bundle.
      alias: { '@peek/core': resolve(repoRoot, 'packages/core/src/index.ts') },
    },
    build: {
      outDir: join(outRoot, plugin.id),
      emptyOutDir: true,
      minify: 'esbuild',
      // No preload/modulepreload injection: the document CSP has no
      // `connect-src`, and a `<link rel=modulepreload>` is a fetch. It works
      // today because Vite emits it as a link element rather than as a fetch,
      // but relying on that distinction inside a frame we deliberately gave no
      // network is a bet with no upside.
      modulePreload: false,
      rollupOptions: {
        input: join(plugin.uiRoot, 'index.html'),
        output: {
          // Flat and unhashed. The protocol handler serves with `no-store`, so a
          // content hash buys nothing, and a stable name is what makes the
          // built output readable when a plugin frame misbehaves.
          entryFileNames: '[name].js',
          chunkFileNames: '[name].js',
          assetFileNames: '[name][extname]',
        },
      },
    },
  })
  console.log(`[peek/plugin-ui] built ${plugin.id} → out/plugin-ui/${plugin.id}`)
}
