import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, test } from 'node:test'

import { blankNonCode } from '../../__tests__/sourceScan'

/* ==================================================================
 * The manifest subpath is a wall. This is what holds it up.
 *
 * What it guards is a number: the size of the renderer chunk. The measured
 * baseline is recorded in `apps/desktop/electron.vite.config.ts` — renderer
 * index **563,734 B minified** (1,264,081 B before esbuild) — and that is the
 * figure a leak here would move. The clients are not small: `pg`, `redis` (plus
 * the `@opentelemetry/api` and `@node-rs/xxhash` stubs it drags along), `mysql2`
 * and `@qdrant/js-client-rest` are hundreds of kilobytes each, parsed on every
 * cold start, inside a process that is not allowed to open a socket to a
 * database in the first place.
 *
 * `@peek/driver-x/manifest` exists precisely so the window can *describe* a
 * database without carrying one. The subpath bypasses `index.ts` — and so
 * `./driver`, and so the client — but only for as long as `manifest.ts` imports
 * nothing that reaches back. Nothing in the type system says that. The build
 * stays green either way and simply gets bigger, which is the failure mode
 * nobody notices: no error, no test, just a slower window.
 *
 * ## Why a source scan rather than importing the module
 *
 * The obvious version of this test imports each manifest and inspects what came
 * with it. It proves nothing, because the question is what a **bundler** emits
 * and this process is not the bundler:
 *
 *   - a type-only import has already vanished by the time anything here could
 *     observe it, so a runtime probe reports "clean" for source a reader would
 *     call dirty;
 *   - a value import whose symbols are all unused does *not* vanish. Under
 *     `verbatimModuleSyntax`, `import { type Pool } from 'pg'` keeps the
 *     statement and loads `pg` for its side effects, while
 *     `import type { Pool } from 'pg'` is erased whole. Two spellings one word
 *     apart, opposite consequences for the chunk — and an import-and-inspect
 *     test cannot tell them apart after the fact;
 *   - the resolvers disagree anyway. The vite build rewrites `@peek/*` through
 *     its alias table and swaps optional native deps for stubs; node here does
 *     neither. A module graph observed in this process is not the graph that
 *     ships.
 *
 * The one artifact every resolver agrees on is the source text and the module
 * specifiers written in it. So the scan reads the text and judges the
 * specifier. It can only err in one direction — being too strict about what a
 * manifest may name — and being too strict here is the intended posture.
 *
 * Comments and string bodies are blanked before the scan (`blankNonCode`):
 * every one of these files explains in prose which imports it is allowed, and
 * `mcpConnectExample` is a code sample held in a string. Text that mentions the
 * thing must not count as the thing.
 * ================================================================== */

/** `…/apps/desktop/src/renderer/components/__tests__` → the workspace root. */
const REPO_ROOT = resolve(import.meta.dirname, '../../../../../..')

/** The four packages that expose a client-free `/manifest` subpath. */
const MANIFEST_PACKAGES = [
  'driver-postgres',
  'driver-redis',
  'driver-qdrant',
  'driver-sql',
] as const

/** Where the subpath must point, in every table that resolves it. */
const MANIFEST_ENTRY = './src/manifest.ts'

/**
 * The only two modules a manifest may name.
 *
 * `@peek/core` is types and a handful of pure functions; `zod` is what turns an
 * assembled draft into a validated config. The renderer carries both already,
 * with or without the manifests, so neither moves the number in the header. A
 * database client would.
 */
const ALLOWED_MODULES: readonly string[] = ['@peek/core', 'zod']

/**
 * `import … from 'x'` and `export … from 'x'`, multi-line forms included.
 *
 * What may appear between the keyword and `from` is restricted to the
 * characters an import clause actually contains — identifiers, braces, commas,
 * `*`, `type`, whitespace. Notably *not* a quote: that is what stops a lazy
 * match from running off the end of one statement and reporting the next
 * statement's specifier as this one's.
 */
const RE_FROM = /^\s*(?:import|export)\s[\w${},*\s]*?\bfrom\s*['"]([^'"]+)['"]/gm

/**
 * `import 'x'` with no clause at all.
 *
 * Rarer than the form above and worse: a side-effect import binds no symbols,
 * so nothing in the rest of the file looks like it depends on anything, and it
 * is exactly how a client's register-yourself module or a polyfill arrives.
 * Matching only `from` would leave this hole open.
 */
const RE_BARE = /^\s*import\s*['"]([^'"]+)['"]/gm

/**
 * `import('x')` with a literal specifier — the only dynamic form a bundler can
 * follow, and therefore the only one worth matching.
 *
 * Being code-split out of the index chunk is not an escape hatch. The client
 * would still be built into the renderer output and would still execute inside
 * the window the first time the promise is awaited; the cost would merely move
 * from cold start to first use.
 */
const RE_DYNAMIC = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g

/**
 * The specifier itself, read back out of a matched statement.
 *
 * It is the last quoted literal in all three shapes — `… from 'x'`,
 * `import 'x'`, `import('x')` — which is why one pattern serves all of them.
 */
const RE_SPECIFIER = /['"]([^'"]*)['"][^'"]*$/

function manifestPath(pkg: string): string {
  return join(REPO_ROOT, 'packages', pkg, 'src', 'manifest.ts')
}

function manifestSource(pkg: string): string {
  const path = manifestPath(pkg)
  assert.ok(
    existsSync(path),
    `${path} does not exist. Either the manifest moved — in which case fix MANIFEST_PACKAGES here, ` +
      `because this rule has just gone vacuous — or the subpath is broken.`,
  )
  return readFileSync(path, 'utf8')
}

/**
 * Every module specifier the source names, read from code and only from code.
 *
 * The search runs over a copy with comments and string bodies blanked, which is
 * what stops a line inside a template literal that happens to begin with
 * `import` from being counted as one — a real false positive, caught while
 * writing this, and one that would have accused a manifest of importing a
 * client it merely quoted. Blanking preserves length, so the match offsets
 * still index the original and the specifier is sliced back out of the real
 * text. That round trip is the pattern `sourceScan` exists to support.
 */
function importedModules(source: string): string[] {
  const code = blankNonCode(source)
  const found: string[] = []
  for (const pattern of [RE_FROM, RE_BARE, RE_DYNAMIC]) {
    for (const match of code.matchAll(pattern)) {
      const statement = source.slice(match.index, match.index + match[0].length)
      const specifier = RE_SPECIFIER.exec(statement)
      assert.ok(specifier, `no module specifier in a matched import statement: ${statement.trim()}`)
      found.push(specifier[1])
    }
  }
  return found
}

interface SubpathExport {
  types?: string
  default?: string
}

/** The `./manifest` entry of a driver package's exports map. */
function manifestExport(pkg: string): SubpathExport {
  const path = join(REPO_ROOT, 'packages', pkg, 'package.json')
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  assert.ok(typeof parsed === 'object' && parsed !== null, `${path} did not parse to an object`)

  const map = (parsed as { exports?: unknown }).exports
  assert.ok(
    typeof map === 'object' && map !== null,
    `packages/${pkg}/package.json declares no "exports" map, so node cannot resolve ` +
      `@peek/${pkg}/manifest at all.`,
  )

  const entry = (map as Record<string, unknown>)['./manifest']
  assert.ok(
    typeof entry === 'object' && entry !== null,
    `packages/${pkg}/package.json must declare an "./manifest" export pointing at ` +
      `"${MANIFEST_ENTRY}". Without it, node resolves @peek/${pkg}/manifest as a bare subpath and ` +
      `fails, while the vite build — which goes through its own alias table — stays green.`,
  )
  return entry as SubpathExport
}

describe('manifest purity', () => {
  test('the scan is reading the real manifest sources, so a file that moved cannot turn this green', () => {
    // The failure this prevents is not a leak but a rule quietly matching
    // nothing: a renamed file, a regex that stopped matching the house import
    // style, and every assertion below passes over an empty list forever.
    for (const pkg of MANIFEST_PACKAGES) {
      const modules = importedModules(manifestSource(pkg))
      assert.ok(
        modules.length > 0,
        `no imports were parsed out of ${manifestPath(pkg)}. The scan is broken, not the manifest.`,
      )
      assert.ok(
        modules.includes('@peek/core'),
        `${manifestPath(pkg)} must import @peek/core — every manifest is built with defineManifest. ` +
          `Not finding it means the specifier patterns no longer match how imports are written here.`,
      )
    }
  })

  test('a manifest imports only @peek/core or zod, because whatever it names is what the window loads', () => {
    for (const pkg of MANIFEST_PACKAGES) {
      for (const module of importedModules(manifestSource(pkg))) {
        if (module.startsWith('.')) {
          // Relative paths are rejected on principle rather than on content.
          // This scan reads one file; it cannot see what `./x` imports, and in
          // these packages the neighbours are exactly the wrong ones —
          // `./driver` reaches the client, and `./index` reaches `./driver`. A
          // manifest that needs shared code should get it from @peek/core,
          // where the same rule already applies.
          assert.fail(
            `packages/${pkg}/src/manifest.ts imports '${module}'. A relative import can transitively ` +
              `reach a database client (./driver imports pg / redis / mysql2 / @qdrant/js-client-rest) ` +
              `and this scan cannot see through it. Inline what you need, or move the shared piece into ` +
              `@peek/core.`,
          )
        }
        assert.ok(
          ALLOWED_MODULES.includes(module),
          `packages/${pkg}/src/manifest.ts imports '${module}', which is not one of ` +
            `${ALLOWED_MODULES.join(' / ')}. The renderer imports this file through ` +
            `apps/desktop/src/drivers/manifests.ts, so '${module}' and everything it pulls now ship in ` +
            `the window's chunk — the 563,734 B baseline in electron.vite.config.ts moves and nothing ` +
            `else complains. If '${module}' genuinely belongs in a manifest, prove it cannot reach a ` +
            `database client and add it to ALLOWED_MODULES with a note saying why.`,
        )
      }
    }
  })

  test('every driver package declares the ./manifest subpath, or node stops resolving it', () => {
    // Three tables resolve this subpath and all three have to agree: the alias
    // map in electron.vite.config.ts (the vite build), `paths` in
    // tsconfig.base.json (tsc), and this exports map (node's own resolver,
    // which is what `pnpm test` runs on). They fail independently — drop this
    // entry and the build and the typecheck stay green while the test run
    // cannot load the module — so each one needs its own assertion.
    for (const pkg of MANIFEST_PACKAGES) {
      const entry = manifestExport(pkg)
      assert.equal(
        entry.default,
        MANIFEST_ENTRY,
        `packages/${pkg}/package.json exports["./manifest"].default must be "${MANIFEST_ENTRY}" — ` +
          `pointing it at the built index or at "." would hand every importer the client-bearing entry.`,
      )
      assert.equal(
        entry.types,
        MANIFEST_ENTRY,
        `packages/${pkg}/package.json exports["./manifest"].types must be "${MANIFEST_ENTRY}", or a ` +
          `consumer resolving by exports rather than by tsconfig paths gets no types for the manifest.`,
      )
    }
  })
})
