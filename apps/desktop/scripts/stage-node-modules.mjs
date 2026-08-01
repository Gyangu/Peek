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
 *
 * What the regexes cannot see is whether the match is *code*. A `require(...)`
 * quoted inside a string literal reads identically, and at least one bundled
 * dependency ships exactly that: mysql2 raises
 *
 *     "…pass userland Promise implementation as parameter,
 *      for example: { Promise: require('bluebird') }"
 *
 * so a scan alone concludes the app depends on bluebird. {@link isInstalled}
 * settles it — see there for why that test is the right one.
 */
const SPECIFIER_PATTERNS = [
  // import x from 'pkg' / export { x } from 'pkg'
  //
  // `\bfrom`, not `\sfrom`: the output is minified, so the clause before the
  // keyword usually ends in a brace with no space — `…isDraft as Vr}from"immer"`.
  // Requiring whitespace here missed every named import in the main bundle, which
  // is how a package the app genuinely needs went unstaged while a name quoted
  // inside an error message got staged in its place.
  //
  // The gap is `[^'"]` rather than `[\s\S]` so a match cannot start in one import
  // clause and take its specifier from a later string.
  /(?:^|[\s;}])(?:import|export)\b[^'"]{0,400}?\bfrom\s*["']([^"']+)["']/g,
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

/**
 * Is this package anywhere in the workspace install?
 *
 * pnpm materialises every package it installs — direct, transitive, optional —
 * as a directory in the virtual store. So the test is decisive in both
 * directions, which is what makes it safe to act on:
 *
 * - **Present in the store, unresolvable from the importer.** A real problem:
 *   the package exists but the importer cannot reach it. Staging must fail
 *   rather than ship a bundle that throws on first use.
 * - **Absent from the store.** Then `require` of it could never have succeeded
 *   at runtime either, in this workspace or in the packaged app. A name that
 *   cannot resolve and was never installed is not a dependency the build lost —
 *   it is text that looked like code to a regex.
 *
 * Reading the store rather than the lockfile keeps this honest about what is
 * actually on disk, which is what the staged tree is copied from.
 */
function isInstalled(name, rootDir) {
  let dir = rootDir
  for (;;) {
    const store = join(dir, 'node_modules', '.pnpm')
    if (existsSync(store)) {
      // Store entries are `name@version` with `/` escaped as `+`.
      const prefix = `${name.replace(/\//g, '+')}@`
      if (readdirSync(store).some((e) => e.startsWith(prefix))) return true
    }
    // Non-pnpm layouts, and the workspace packages themselves.
    if (existsSync(join(dir, 'node_modules', name, 'package.json'))) return true
    const parent = dirname(dir)
    if (parent === dir) return false
    dir = parent
  }
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
 * Resolve from the first of several starting points that can see the package.
 *
 * Only the top level needs this. The bundles inline the workspace packages, so
 * an external left in `driver-host.js` may belong to any of them — mysql2 is
 * `@peek/driver-sql`'s dependency, and under pnpm's strict layout `apps/desktop`
 * cannot see it. Resolving from the app alone would call a correctly installed
 * dependency missing.
 *
 * Below the top level the starting point is the requiring package's own
 * directory, which is the only correct one: that is what Node will do at
 * runtime, and it is what makes a nested version shadow the root copy.
 */
function resolveFromAny(name, fromDirs) {
  for (const dir of fromDirs) {
    const found = resolvePackageDir(name, dir)
    if (found !== null) return found
  }
  return null
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
  /** Names the scan produced that are not real dependencies — see isInstalled. */
  const skipped = new Set()

  /** @param {string} name @param {string} fromDir @param {string} stagedParent */
  const visit = (name, fromDir, stagedParent) => {
    const fromDirs = Array.isArray(fromDir) ? fromDir : [fromDir]
    const sourceDir = resolveFromAny(name, fromDirs)
    if (sourceDir === null) {
      if (!isInstalled(name, fromDirs[0])) {
        // Never installed, so nothing could ever have required it successfully.
        // The scan read a package name out of a string literal — see the note on
        // SPECIFIER_PATTERNS. Say so and carry on; failing here would block every
        // build over a dependency the app does not have.
        console.warn(`[stage] ignoring "${name}": matched in the bundle text but not installed anywhere`)
        skipped.add(name)
        return
      }
      throw new Error(
        `Cannot resolve "${name}" from ${fromDirs.join(', ')}, though it is installed in the workspace. `
          + 'The staged tree would ship a bundle that throws on first use — run "pnpm install".',
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
  return { copies: [...placements].map(([to, from]) => ({ from, to })), skipped }
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
export function stageNodeModules({ buildDir, resolveFrom, stageDir, alsoInclude = [] }) {
  const externals = [...new Set([...collectExternalImports(buildDir), ...alsoInclude])].sort()
  if (externals.length === 0) return []

  const { copies, skipped } = planClosure(externals, resolveFrom)
  for (const { from, to } of copies) {
    copyPackage(from, join(stageDir, to))
  }
  // Report what is actually on disk. A name the scan invented is not something
  // the caller should then assert the presence of.
  return externals.filter((name) => !skipped.has(name))
}
