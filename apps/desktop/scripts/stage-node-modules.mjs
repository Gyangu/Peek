/**
 * Build the node_modules tree that the packaged app needs at runtime.
 *
 * electron-vite's `externalizeDepsPlugin` leaves this package's `dependencies`
 * out of the main bundle, so out/main is *not* self-contained: it still imports
 * a handful of packages by bare specifier. Under pnpm those live behind
 * symlinks into the content-addressed store, which is exactly what must not be
 * copied into an .app — the links would dangle the moment the bundle moves.
 *
 * So instead of copying the workspace's node_modules, this module rebuilds a
 * plain one from scratch:
 *
 *   1. read the built bundles and collect every bare specifier they import;
 *   2. resolve each package the way Node would (walk up node_modules, follow
 *      the symlink to its real location in the store);
 *   3. recurse through each package's own `dependencies`;
 *   4. copy the closure into the staging directory with symlinks dereferenced.
 *
 * The closure is the *declared* dependency graph, not the graph of modules
 * actually reached at runtime. That over-collects — the MCP SDK declares
 * express and hono although peek's transport touches neither — but the whole
 * closure is around 15 MB against a 280 MB Electron runtime, and paying that
 * buys module resolution inside the .app that behaves exactly like it does in
 * development. A minimal closure would mean re-implementing `exports`
 * resolution and guessing at conditional imports, which trades a rounding
 * error in size for a class of bug that only shows up in the packaged build.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { dirname, join, relative, sep } from 'node:path'

/** Bare specifiers that resolve to something other than a package on disk. */
const NOT_A_PACKAGE = new Set([...builtinModules, 'electron'])

/**
 * Every shape a bare specifier can take in the built output. The bundles are
 * rollup output, so specifiers are always plain string literals — no template
 * strings, no computed requires — which is what makes a regex scan sound here.
 */
const SPECIFIER_PATTERNS = [
  // import x from 'pkg' / export { x } from 'pkg'
  /(?:^|[\s;}])(?:import|export)[\s\S]{0,400}?\sfrom\s*["']([^"']+)["']/g,
  // import 'pkg'  (side effect only)
  /(?:^|[\s;}])import\s*["']([^"']+)["']/g,
  // await import('pkg')
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  // require('pkg') — the preload bundle is CJS
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
]

/** 'zod' -> 'zod', '@scope/sdk/server/mcp.js' -> '@scope/sdk' */
function packageNameOf(specifier) {
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

/** Collect every .js/.cjs/.mjs file under `dir`. */
function jsFilesUnder(dir) {
  const found = []
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue
    if (!/\.[cm]?js$/.test(entry.name)) continue
    found.push(join(entry.parentPath, entry.name))
  }
  return found
}

/** The package names the built bundles import but do not contain. */
export function collectExternalImports(buildDir) {
  const names = new Set()
  for (const file of jsFilesUnder(buildDir)) {
    const source = readFileSync(file, 'utf8')
    for (const pattern of SPECIFIER_PATTERNS) {
      pattern.lastIndex = 0
      let match
      while ((match = pattern.exec(source)) !== null) {
        const specifier = match[1]
        if (specifier.startsWith('.') || specifier.startsWith('/')) continue
        if (specifier.startsWith('node:')) continue
        const name = packageNameOf(specifier)
        if (NOT_A_PACKAGE.has(name)) continue
        names.add(name)
      }
    }
  }
  return [...names].sort()
}

/**
 * Node's own lookup: walk up from `fromDir` checking node_modules/<name>, and
 * return the real path so a pnpm symlink resolves to the store directory that
 * actually holds the files.
 */
function resolvePackageDir(name, fromDir) {
  let dir = fromDir
  for (;;) {
    const candidate = join(dir, 'node_modules', name, 'package.json')
    if (existsSync(candidate)) return realpathSync(dirname(candidate))
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/**
 * Walk the declared dependency graph and decide where each package lands in the
 * staged tree.
 *
 * Placement is flat wherever it can be, which is what npm and yarn produce and
 * what keeps the tree shallow. When two packages need different versions of the
 * same name, the second one is nested under the package that asked for it —
 * Node resolves by walking up, so a nested copy shadows the root one for that
 * subtree and nothing else. Returns a list of {from, to} copy instructions.
 */
function planClosure(rootNames, rootDir) {
  /** Staged relative path -> real source directory */
  const placements = new Map()
  /** Package name -> real source directory of the copy placed at the tree root */
  const atRoot = new Map()

  /** @param {string} name @param {string} fromDir @param {string} stagedParent */
  const visit = (name, fromDir, stagedParent) => {
    const sourceDir = resolvePackageDir(name, fromDir)
    if (sourceDir === null) {
      throw new Error(
        `Cannot resolve "${name}" from ${fromDir}. The build output imports it, `
          + 'so the workspace install is incomplete — run "pnpm install".',
      )
    }

    // Already satisfied by the copy at the root of the staged tree.
    if (atRoot.get(name) === sourceDir) return

    const nested = atRoot.has(name)
    const stagedPath = nested
      ? join(stagedParent, 'node_modules', name)
      : join('node_modules', name)

    if (placements.get(stagedPath) === sourceDir) return
    placements.set(stagedPath, sourceDir)
    if (!nested) atRoot.set(name, sourceDir)

    const manifest = JSON.parse(readFileSync(join(sourceDir, 'package.json'), 'utf8'))
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      visit(dependency, sourceDir, stagedPath)
    }
  }

  for (const name of rootNames) visit(name, rootDir, '')
  return [...placements].map(([to, from]) => ({ from, to }))
}

/**
 * Copy a package directory, dropping its own node_modules: nesting is decided
 * by planClosure, and in the pnpm layout that directory is a nest of symlinks
 * back into the store.
 */
function copyPackage(from, to) {
  mkdirSync(dirname(to), { recursive: true })
  cpSync(from, to, {
    recursive: true,
    dereference: true,
    filter: (src) => {
      const rel = relative(from, src)
      return rel === '' || !rel.split(sep).includes('node_modules')
    },
  })
}

/**
 * Materialize the runtime dependency closure of `buildDir` inside `stageDir`.
 * Returns the package names placed at the root of the staged tree, for logging
 * and for the post-package verification.
 */
export function stageNodeModules({ buildDir, resolveFrom, stageDir }) {
  const externals = collectExternalImports(buildDir)
  if (externals.length === 0) return []

  for (const { from, to } of planClosure(externals, resolveFrom)) {
    copyPackage(from, join(stageDir, to))
  }
  return externals
}
