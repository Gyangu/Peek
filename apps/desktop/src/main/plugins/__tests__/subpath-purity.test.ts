import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { describe, test } from 'node:test'

import { blankNonCode } from '../../../renderer/__tests__/sourceScan'

/* ==================================================================
 * The *other* client-free subpaths, and why `/manifest` having a guard was not
 * enough.
 *
 * `manifest-purity.test.ts` protects `@peek/driver-x/manifest` because the
 * renderer loads it and a leak there puts `pg` in the window. Two more subpaths
 * have appeared since, and they are loaded by **main**:
 *
 *   `/view`        `autoFetch` is planned while a Command is reducing
 *   `/mcp-tools`   registered on the MCP server at startup
 *
 * Neither had a guard. The consequence is smaller than the renderer's — main is
 * allowed to reach a database client, in the sense that nothing breaks — but it
 * is the same mistake: the driver host exists so that `neo4j-driver` loads in a
 * *utility process*, one per connection, and dragging it into main puts a Bolt
 * client in the process that holds every decrypted credential and can never be
 * restarted. No error, no test, just a heavier main and a boundary that stopped
 * meaning anything.
 *
 * ## Why this one follows relative imports and the manifest one does not
 *
 * `manifest-purity.test.ts` bans relative imports outright, as a proxy: it reads
 * one file and cannot see what `./x` pulls in, and in those packages the
 * neighbours are exactly the wrong ones. That rule is right for a manifest,
 * which is a self-contained description.
 *
 * It is too strict here. `view.ts` composes Cypher through `./graph`, and
 * `mcp-tools.ts` needs the same ceilings; forcing that shared code into
 * `@peek/core` would put Neo4j's query composition inside the frozen contract to
 * satisfy a test. So this scan **follows** the relative imports instead and
 * applies the rule to everything reachable — which is a stronger statement than
 * the manifest's, not a weaker one. The ban was always standing in for this.
 * ================================================================== */

/** `…/apps/desktop/src/main/plugins/__tests__` → the workspace root. */
const REPO_ROOT = resolve(import.meta.dirname, '../../../../../..')

/**
 * Every entry point main resolves that is not `index.ts`, and what each is for.
 *
 * Hand-written rather than globbed: the property is "these subpaths are clean",
 * and a glob would let a subpath be added with no guard and still show green.
 */
const SUBPATHS: readonly { pkg: string; subpath: string; file: string; why: string }[] = [
  {
    pkg: 'driver-neo4j',
    subpath: './view',
    file: 'src/view.ts',
    why: "main plans a plugin view's autoFetch from inside a Command reduction",
  },
  {
    pkg: 'driver-neo4j',
    subpath: './mcp-tools',
    file: 'src/mcp-tools.ts',
    why: "the package's MCP tools are registered on the server that runs in main",
  },
]

/**
 * What a module on one of these paths, or anything it reaches, may name.
 *
 * `@peek/core` is the contract; `zod` is what validates a tool's input and is
 * already in every process. A database client is not on this list, and neither
 * is anything from `apps/` — a package importing the app would be the cycle the
 * whole boundary exists to prevent.
 */
const ALLOWED_MODULES: readonly string[] = ['@peek/core', 'zod']

const RE_FROM = /^\s*(?:import|export)\s[\w${},*\s]*?\bfrom\s*['"]([^'"]+)['"]/gm
const RE_BARE = /^\s*import\s*['"]([^'"]+)['"]/gm
const RE_DYNAMIC = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g

/** Module specifiers named by this file's code — comments and string bodies blanked first. */
function importedModules(path: string): string[] {
  const source = readFileSync(path, 'utf8')
  const code = blankNonCode(source)
  const found: string[] = []
  for (const pattern of [RE_FROM, RE_BARE, RE_DYNAMIC]) {
    for (const match of code.matchAll(pattern)) {
      // Sliced back out of the **original** text, not the blanked copy: blanking
      // preserves length so the offsets still index it, and reading the specifier
      // off the blanked copy would report a run of spaces as a module name.
      const statement = source.slice(match.index, match.index + match[0].length)
      const specifier = /['"]([^'"]*)['"][^'"]*$/.exec(statement)
      assert.ok(specifier, `no module specifier in a matched import statement in ${path}`)
      found.push(specifier[1] as string)
    }
  }
  return found
}

/** A relative specifier → the `.ts` file it resolves to, the way the bundler will. */
function resolveRelative(fromFile: string, specifier: string): string {
  const base = resolve(dirname(fromFile), specifier)
  for (const candidate of [`${base}.ts`, join(base, 'index.ts')]) {
    if (existsSync(candidate)) return candidate
  }
  assert.fail(`${relative(REPO_ROOT, fromFile)} imports '${specifier}', which resolves to no .ts file`)
}

/**
 * Everything the entry point reaches, entry point included.
 *
 * Depth-first with a visited set — a cycle between two package modules is legal
 * TypeScript and would otherwise hang the test rather than fail it.
 */
function reachableFiles(entry: string): string[] {
  const seen = new Set<string>()
  const stack = [entry]
  while (stack.length > 0) {
    const file = stack.pop() as string
    if (seen.has(file)) continue
    seen.add(file)
    for (const specifier of importedModules(file)) {
      if (specifier.startsWith('.')) stack.push(resolveRelative(file, specifier))
    }
  }
  return [...seen]
}

function subpathEntry(pkg: string, subpath: string): { types?: string; default?: string } {
  const path = join(REPO_ROOT, 'packages', pkg, 'package.json')
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  const map = (parsed as { exports?: Record<string, unknown> }).exports
  assert.ok(map !== undefined, `packages/${pkg}/package.json declares no "exports" map`)
  const entry = map[subpath]
  assert.ok(
    typeof entry === 'object' && entry !== null,
    `packages/${pkg}/package.json must declare a "${subpath}" export. Without it node fails to ` +
      `resolve it while the vite build — which goes through its own alias table — stays green.`,
  )
  return entry as { types?: string; default?: string }
}

describe('client-free subpaths loaded by main', () => {
  test('each one is declared in its package exports map, pointing at the file scanned here', () => {
    for (const { pkg, subpath, file } of SUBPATHS) {
      const entry = subpathEntry(pkg, subpath)
      assert.equal(entry.types, `./${file}`, `${pkg} ${subpath} "types" must point at ./${file}`)
      assert.equal(entry.default, `./${file}`, `${pkg} ${subpath} "default" must point at ./${file}`)
    }
  })

  test('each one is aliased in the vite config, or the build resolves it into index.ts', () => {
    // The failure this catches is nasty and silent: without a specific alias
    // entry, `@peek/driver-neo4j/mcp-tools` matches the bare `@peek/driver-neo4j`
    // prefix and resolves to `…/src/index.ts/mcp-tools`. That is not a build
    // error — the config header records that it fails as a top-level throw
    // inside the chunk.
    const config = readFileSync(join(REPO_ROOT, 'apps', 'desktop', 'electron.vite.config.ts'), 'utf8')
    for (const { pkg, subpath } of SUBPATHS) {
      const specifier = `@peek/${pkg}${subpath.slice(1)}`
      assert.ok(
        config.includes(`'${specifier}'`),
        `${specifier} has no alias entry in electron.vite.config.ts, so the build will resolve it ` +
          `through the bare package prefix and reach index.ts — and the database client with it.`,
      )
    }
  })

  test('the scan reaches past the entry point, so it is not judging one file and calling it a graph', () => {
    for (const { pkg, file } of SUBPATHS) {
      const entry = join(REPO_ROOT, 'packages', pkg, file)
      const reached = reachableFiles(entry)
      assert.ok(reached.length > 0, `nothing was scanned for ${pkg}/${file}`)
      for (const path of reached) {
        assert.ok(
          importedModules(path).length > 0 || reached.length > 1,
          `no imports were parsed out of ${relative(REPO_ROOT, path)}; the scan is broken, not the source`,
        )
      }
    }
  })

  test('nothing reachable from them names a database client, or the app', () => {
    for (const { pkg, file, why } of SUBPATHS) {
      const entry = join(REPO_ROOT, 'packages', pkg, file)
      for (const path of reachableFiles(entry)) {
        for (const module of importedModules(path)) {
          if (module.startsWith('.')) continue
          assert.ok(
            ALLOWED_MODULES.includes(module),
            `${relative(REPO_ROOT, path)} imports '${module}', and it is reachable from ` +
              `@peek/${pkg}${file.replace('src', '').replace('.ts', '')} — which loads in main because ${why}. ` +
              `Only ${ALLOWED_MODULES.join(' and ')} are allowed on this path.`,
          )
        }
      }
    }
  })

  test('and none of them reaches the package index, which is where the client lives', () => {
    for (const { pkg, file } of SUBPATHS) {
      const entry = join(REPO_ROOT, 'packages', pkg, file)
      const index = join(REPO_ROOT, 'packages', pkg, 'src', 'index.ts')
      assert.ok(
        !reachableFiles(entry).includes(index),
        `@peek/${pkg} ${file} reaches src/index.ts. That is the module the whole subpath exists to ` +
          `bypass: it imports ./driver, which imports the client.`,
      )
    }
  })
})
