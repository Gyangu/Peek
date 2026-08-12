#!/usr/bin/env node
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { isBuiltin, registerHooks } from 'node:module'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { build } from 'vite'
import { z } from 'zod'

/* ====================================================================
 * Build every database package into the four files a package *is* on disk.
 *
 *     out/packages/<id>/
 *       peek-package.json   the manifest, serialized — never hand-written
 *       driver.mjs          self-contained ESM, the database client inlined
 *       contrib.mjs         self-contained ESM, display + view kinds + tools
 *       ui/                 the self-drawn view's document root, when there is one
 *
 * That is design 2026-08-07 §2.2's layout, produced from the repository instead
 * of found in `~/.peek/packages/`. The four files run in four places (§2.1) and
 * this script is where that separation is first made real: until now a "package"
 * was five directories the app happened to import.
 *
 * ## One Vite build per package, and three per package at that
 *
 * The removed UI build script made this argument for the UI half and this
 * script absorbed it — the file is gone, its header lives on here, and its two
 * reasons have grown a third:
 *
 * - *Separate from the app's build*, because a single Rollup graph is allowed to
 *   hoist common code into a shared chunk, and a chunk shared between the host
 *   realm and a package realm is precisely what `peek-package://` exists to make
 *   impossible. Two graphs cannot share one.
 * - *Separate from each other*, for a sharper version of the same thing: two
 *   packages' UIs are cross-origin, so a chunk hoisted out of both would be
 *   fetched from exactly one of the two origins and fail the CSP of the other.
 *   The symptom would be one package working and the other silently blank,
 *   depending on build order.
 * - *And `driver.mjs` separate from `contrib.mjs`*, which is the new one and the
 *   strongest: they load in different processes, and only one of them may hold a
 *   database client (§2.4bis). A shared chunk between those two would put `pg` in
 *   the process that computes sidebar labels — the same failure
 *   `electron.vite.package-host.config.ts` was split out of the main build to
 *   avoid, one level down.
 *
 * So: no build here ever has two entries. `inlineDynamicImports` makes that
 * literal — one entry, one output file, nothing to share — and
 * `assertSelfContained` fails the build if a second chunk appears anyway.
 *
 * ## Why the manifest is serialized rather than written
 *
 * `peek-package.json` is produced from the same `DriverManifest` values the app
 * imports, and then parsed back with core's own `parsePackageManifest` before it
 * is allowed to reach disk. A second, hand-maintained copy is exactly the drift
 * the manifest refactor exists to delete: the file would agree with `manifest.ts`
 * on the day it was written and disagree quietly afterwards, and the symptom of
 * disagreement is a connect form asking for a field the driver ignores.
 *
 * The same holds for the other two things a package contributes, which §2.4bis(d)
 * splits between the manifest and `contrib.mjs`. Their data halves are read from
 * the declarations the package already makes — `src/manifest.ts` for view kinds,
 * `src/mcp-tool-meta.ts` for tools — and never restated here. What this script
 * adds is the check no single file can make: the built `contrib.mjs` is asked
 * which kinds and tools it *registers*, and a name on one side and not the other
 * fails the build. A tool the manifest lists and the host cannot run reaches a
 * model as a tool that errors; a kind the host registers and the manifest omits
 * is a view no connection is ever offered.
 *
 * The round trip is not ceremony. `PackageManifestSchema` refuses a redact rule
 * naming a field no form declares, an identity list that reads as empty, a mode
 * that draws no box — checks the in-repo declaration had no way to make. Running
 * them here means an in-repo package is held to the standard a third-party one
 * will be, at build time rather than at install time.
 *
 * ## What "self-contained" is checked against
 *
 * Three independent ways, because the interesting failure is a *bare* import
 * that survives into the artifact and only fails when a user opens a connection:
 *
 *   1. Rollup's own answer — one chunk, and every external it names is a node
 *      builtin (`assertSelfContained`);
 *   2. the emitted bytes — no `Could not resolve` throw, and no `import`/
 *      `require` of anything that is not a builtin (`auditArtifact`);
 *   3. loading it. A child `node` process imports the built file and reports
 *      which drivers it carries. A leftover bare specifier is an
 *      `ERR_MODULE_NOT_FOUND` there, decided by node's resolver rather than by a
 *      regex of ours, and the ids it reports are checked against the manifest.
 *
 * Design §1.2's three unresolvable optional specifiers are what (1) and (2) are
 * really for, and the table that answers them —
 * `scripts/optional-dep-alias.ts` — is shared with the app's build so that the
 * two cannot answer differently. Measured, one alias at a time: **only
 * `@node-rs/xxhash` is load-bearing here today**. Deleting it fails the redis
 * package's build; deleting `pg-native` or `@opentelemetry/api` does not,
 * because Rollup reaches neither branch from these entry points and drops the
 * specifier with the code around it. They stay in the shared table anyway — the
 * app's driver-host build does reach them, and a table that answered "not needed
 * here" would be a second opinion about pg rather than one fewer alias.
 *
 * `contrib.mjs` gets a fourth check of its own, and it runs during the build
 * rather than after: every module Rollup pulls into that graph must come from
 * `packages/`, so a client cannot arrive even transitively. See
 * `assertContribHoldsNoClient`.
 * ==================================================================== */

/* ------------------------------------------------------------------ */
/* TypeScript, from a plain node script                                */
/* ------------------------------------------------------------------ */

/**
 * Node strips types on its own; what it will not do is guess an extension.
 *
 * The repository writes extensionless relative imports (`moduleResolution:
 * bundler`), so importing a package's `manifest.ts` from here needs the same
 * probe `src/__tests__/register.mjs` installs for `node --test`. Copied rather
 * than imported because a build script reaching into a package's test helpers
 * would be the wrong dependency in the wrong direction.
 */
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !/\.[cm]?[jt]sx?$/.test(specifier) && context.parentURL) {
      const base = new URL(specifier, context.parentURL)
      for (const ext of ['.ts', '.mts', '.tsx', '/index.ts']) {
        const candidate = new URL(base.href + ext)
        if (existsSync(fileURLToPath(candidate))) return nextResolve(candidate.href, context)
      }
    }
    return nextResolve(specifier, context)
  },
})

const { PACKAGE_ID_PATTERN } = await import('@peek/core')
const { parsePackageManifest } = await import('@peek/core/package-manifest')
const { optionalDepAliasFrom } = await import('./optional-dep-alias.ts')

const scriptDir = dirname(fileURLToPath(import.meta.url))
const desktopDir = resolve(scriptDir, '..')
const repoRoot = resolve(desktopDir, '../..')
const packagesDir = join(repoRoot, 'packages')
const outRoot = join(desktopDir, 'out', 'packages')

const coreEntry = resolve(repoRoot, 'packages/core/src/index.ts')
const optionalDepAlias = optionalDepAliasFrom(desktopDir)

const execFileAsync = promisify(execFile)

/** The three names the built files take, and the values `entry` carries in the manifest. */
const DRIVER_FILE = 'driver.mjs'
const CONTRIB_FILE = 'contrib.mjs'
const UI_DIR = 'ui'

/**
 * Where a package declares each half of itself.
 *
 * A file in the package rather than a table here: which databases a package
 * opens, and what it contributes to its host, are the package's answers to give.
 * A build script that knew them would be the fourth copy of a list Phase C is
 * deleting three of.
 */
const DRIVER_ENTRY = join('src', 'entry', 'driver.ts')
const CONTRIB_ENTRY = join('src', 'entry', 'contrib.ts')
const MANIFEST_MODULE = join('src', 'manifest.ts')

/**
 * Where a package declares its tools, apart from the file that maps them.
 *
 * Two modules rather than two exports of one, and the separation is the
 * package's own (design §4ter(b)): a bundler assigns whole modules to chunks, so
 * a file exporting a name beside its handler puts the handler wherever the name
 * was wanted — which is main. This script only ever reads the declaring half,
 * for the same reason main does.
 *
 * View kinds need no second module: their data half is three plain fields, so it
 * lives in `src/manifest.ts` with everything else about the package that is data.
 */
const TOOL_META_MODULE = join('src', 'mcp-tool-meta.ts')

/* ------------------------------------------------------------------ */
/* Discovery                                                           */
/* ------------------------------------------------------------------ */

/**
 * The package id: the directory name minus `db-`.
 *
 * It is the host of this package's `peek-package://` URLs and the name of its
 * directory under `~/.peek/packages/`, so it has to satisfy the same pattern
 * `resolvePackageAsset` enforces on a URL host — an id that assembles into a URL
 * the handler then refuses would build cleanly and 404 at runtime, which is the
 * worst place to find out.
 *
 * `PACKAGE_ID_PATTERN` itself, imported from core, not a copy of it: the
 * removed UI build script kept its own `ID_PATTERN`, and
 * `main/packages/assets.ts` already says why that was one regex too many —
 * "three regexes that have to agree are two chances to widen one of them alone".
 */
function packageIdOf(directoryName) {
  const id = directoryName.replace(/^db-/, '')
  if (!PACKAGE_ID_PATTERN.test(id)) {
    throw new Error(
      `packages/${directoryName} would install as "${id}", which is not servable: a package id must ` +
        `match ${String(PACKAGE_ID_PATTERN)} (see PACKAGE_ID_PATTERN in core, and main/packages/assets.ts).`,
    )
  }
  return id
}

/**
 * Every database package in the workspace.
 *
 * Recognised by its manifest, the same way the loader will recognise an
 * installed directory by `peek-package.json`. A `db-*` directory without one
 * is a mistake worth failing on rather than skipping: the app aliases these by
 * name, so a package this script silently passed over would still be compiled
 * into the window and then be missing from disk.
 */
function discoverPackages() {
  if (!existsSync(packagesDir)) return []
  const found = []
  for (const entry of readdirSync(packagesDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || !entry.name.startsWith('db-')) continue
    const dir = join(packagesDir, entry.name)
    for (const required of [MANIFEST_MODULE, DRIVER_ENTRY]) {
      if (existsSync(join(dir, required))) continue
      throw new Error(
        `packages/${entry.name} has no ${required}. Every database package needs one: the manifest is ` +
          `what becomes peek-package.json, and src/entry/driver.ts is what becomes driver.mjs. See ` +
          `packages/db-postgres/src/entry/driver.ts for the shape.`,
      )
    }
    found.push({ name: entry.name, id: packageIdOf(entry.name), dir })
  }
  return found
}

/* ------------------------------------------------------------------ */
/* peek-package.json, serialized from the manifests the app imports    */
/* ------------------------------------------------------------------ */

/** Duck-typed rather than branded, because `DriverManifest` is an interface and interfaces leave no runtime trace. */
function looksLikeManifest(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof value.driverId === 'string' &&
    typeof value.displayName === 'string' &&
    Array.isArray(value.capabilities) &&
    typeof value.connectForm === 'object'
  )
}

/**
 * Every `DriverManifest` a package's `manifest.ts` exports, in export order.
 *
 * Arrays are flattened one level because `db-sql` exports `sqlManifests`
 * beside the two members it holds, and deduplication by `driverId` is what makes
 * that harmless. Reading the namespace rather than a designated export keeps the
 * package free to name its exports as it likes — the one thing that has to be
 * true is checked afterwards, when the built `contrib.mjs` is asked which
 * drivers it serves and the two lists have to match.
 */
function driverManifestsOf(namespace, packageName) {
  const byDriverId = new Map()
  for (const value of Object.values(namespace)) {
    for (const candidate of Array.isArray(value) ? value : [value]) {
      if (!looksLikeManifest(candidate)) continue
      if (!byDriverId.has(candidate.driverId)) byDriverId.set(candidate.driverId, candidate)
    }
  }
  if (byDriverId.size === 0) {
    throw new Error(
      `packages/${packageName}/${MANIFEST_MODULE} exports no DriverManifest, so the package describes no ` +
        `database. Declare one as a DriverManifest and export it.`,
    )
  }
  return [...byDriverId.values()]
}

/**
 * Duck-typed, and the duck is chosen to exclude the *other* half.
 *
 * A `ViewKindRegistration` carries the same `kind` and `driverIds` and a `title`
 * that is a **function** — the per-view one — so testing that `title` is an
 * object is what keeps the four functions in `contrib.mjs` from being mistaken
 * for the declaration and half-serialized into a JSON file.
 */
function looksLikeViewKind(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof value.kind === 'string' &&
    Array.isArray(value.driverIds) &&
    typeof value.title === 'object' &&
    value.title !== null
  )
}

/** Every view-kind declaration a package's `manifest.ts` exports, in export order. */
function viewKindsOf(namespace) {
  const byKind = new Map()
  for (const value of Object.values(namespace)) {
    for (const candidate of Array.isArray(value) ? value : [value]) {
      if (!looksLikeViewKind(candidate)) continue
      if (byKind.has(candidate.kind)) continue
      byKind.set(candidate.kind, { kind: candidate.kind, driverIds: [...candidate.driverIds], title: candidate.title })
    }
  }
  return [...byKind.values()]
}

/**
 * A `ToolMeta`, recognised by the fields that are data.
 *
 * `kind` joined the list in §4duodevicies, so this now also rejects the shape it
 * used to accept silently: a declaration written before the manifest carried a
 * kind would serialize without one and be refused at install, one layer past the
 * package author.
 */
function looksLikeToolMeta(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value.kind === 'read' || value.kind === 'command') &&
    typeof value.name === 'string' &&
    typeof value.description === 'string' &&
    typeof value.inputSchema === 'object' &&
    value.inputSchema !== null
  )
}

/**
 * One tool's declaration, with its zod schema turned into the JSON Schema the
 * wire carries.
 *
 * The conversion is the only thing this script *computes* about a package, and
 * it is not an invention: `tools/list` has always published JSON Schema, and the
 * zod object was only ever the spelling a TypeScript package writes it in. What
 * changes is who converts — the MCP SDK did it at registration time from a
 * schema main held, and main will now read the result off a file.
 *
 * A schema zod cannot express as JSON Schema (a transform, a custom refinement
 * with no JSON form) throws here rather than at install time, which is the
 * difference between a package author seeing it and a user seeing it.
 *
 * ## The four fields beyond MCP's `Tool`
 *
 * `kind`, `hasRenderer`, `title` and `annotations` are copied through since
 * §4duodevicies. They are not what a client is *shown* — `kind` and
 * `hasRenderer` are what main needs to pick a constructor and decide whether to
 * ask the package for a receipt — and they are here for the reason everything
 * else in this file is: the package already declares them in `defineToolMeta`,
 * so writing them out is transcription rather than a second source of truth.
 *
 * `hasRenderer` is written only on the command branch. On a read tool it has no
 * meaning, `PackageManifestSchema` refuses one that carries it anyway, and a
 * field with no meaning that is quietly accepted is how the next person comes to
 * believe it did something.
 */
function serializeTool(meta, packageName) {
  try {
    return {
      kind: meta.kind,
      ...(meta.kind === 'command' ? { hasRenderer: meta.hasRenderer === true } : {}),
      name: meta.name,
      description: meta.description,
      inputSchema: z.toJSONSchema(meta.inputSchema),
      ...(meta.title === undefined ? {} : { title: meta.title }),
      ...(meta.annotations === undefined ? {} : { annotations: meta.annotations }),
    }
  } catch (error) {
    throw new Error(
      `packages/${packageName} declares the tool '${meta.name}' with an input schema that has no JSON Schema ` +
        `form: ${error instanceof Error ? error.message : String(error)}\n\n  MCP publishes the schema as JSON, ` +
        `so a tool declared with one that cannot be serialized is a tool no client can call.`,
    )
  }
}

/** Every tool declaration a package makes, or none if it declares no tools at all. */
async function toolsOf(pkg) {
  const file = join(pkg.dir, TOOL_META_MODULE)
  if (!existsSync(file)) return []
  const namespace = await import(pathToFileURL(file).href)
  const byName = new Map()
  for (const value of Object.values(namespace)) {
    for (const candidate of Array.isArray(value) ? value : [value]) {
      if (!looksLikeToolMeta(candidate)) continue
      if (byName.has(candidate.name)) continue
      byName.set(candidate.name, serializeTool(candidate, pkg.name))
    }
  }
  return [...byName.values()]
}

/**
 * The one version a package has.
 *
 * `DriverManifest.version` is documented as the *package's* version rather than
 * the server's, and `peek-package.json` states it once for that reason. Two
 * drivers of one package disagreeing about it is not something the file can
 * express, so it is caught here rather than resolved by picking one — the whole
 * value of the field is that it answers "which build of this connector am I
 * running", and a picked answer is the one shape of that question that misleads.
 */
function packageVersionOf(manifests, packageName) {
  const versions = [...new Set(manifests.map((m) => m.version))]
  if (versions.length !== 1) {
    throw new Error(
      `packages/${packageName} ships drivers claiming ${String(versions.length)} different versions ` +
        `(${versions.join(', ')}). A package has one version — it is what tells two installs of the same ` +
        `connector apart — so the manifests have to agree.`,
    )
  }
  return versions[0]
}

/**
 * The app's version, which is the peek a bundled package was built against.
 *
 * Stated as a caret range because the field is a range (`PackageManifest.peek`),
 * and *carried, not interpreted*: what a range means is the loader's policy
 * (§2.5 compares the first three semver segments and orders no pre-release
 * tags). Writing an exact version here would be this script having a second
 * opinion about compatibility, in the one file that is supposed to only report
 * what the package is.
 */
function peekRange() {
  const pkg = JSON.parse(readFileSync(join(desktopDir, 'package.json'), 'utf8'))
  return `^${pkg.version}`
}

/**
 * A `DriverManifest` as `peek-package.json` spells it.
 *
 * Field for field, with two differences and no third:
 *
 * - `version` is dropped, because it moved up to the package (see above);
 * - optional keys are omitted rather than written as `null`, so the file says
 *   only what the package said.
 *
 * Field labels travel verbatim, which is only worth saying because they briefly
 * could not: they were `labelKey`s naming entries in the *renderer's* catalog,
 * and rewriting one into text here would have meant inventing user-facing
 * wording at build time out of a table that lives in the window. Decision 3
 * (§2.3c) moved the text into the packages, so there is nothing left to
 * translate on the way out.
 *
 * Nothing is computed and nothing is defaulted. A key this function invented
 * would be a fact about peek's build rather than about the package, and it would
 * survive into `~/.peek/packages/` looking exactly like something the author
 * wrote.
 */
function serializeDriver(manifest) {
  return {
    driverId: manifest.driverId,
    displayName: manifest.displayName,
    capabilities: [...manifest.capabilities],
    connectForm: manifest.connectForm,
    ...(manifest.sqlDialect === undefined ? {} : { sqlDialect: manifest.sqlDialect }),
    redact: manifest.redact,
    identity: [...manifest.identity],
    mcpConnectExample: manifest.mcpConnectExample,
    ...(manifest.skill === undefined ? {} : { skill: manifest.skill }),
  }
}

/**
 * Build the manifest, then read it back with the schema that will read it on
 * disk.
 *
 * The parse is the point rather than a formality: it is the only moment an
 * in-repo package is judged by the same rules a third-party one will be, and
 * several of those rules had no compile-time equivalent (a `redact` naming a
 * field no form declares; an `identity` that reads as empty on every connection;
 * a mode offered with no boxes in it). Failing here costs a build; failing at
 * install time costs a user a package that half-loads.
 *
 * The parsed value is thrown away and the *candidate* is what gets written:
 * `PackageManifestSchema` fills defaults (`fields.url: []`), and writing those
 * back would put keys in the file the package never wrote.
 */
function packageManifestFor(pkg, manifests, contributions, entry) {
  const candidate = {
    id: pkg.id,
    version: packageVersionOf(manifests, pkg.name),
    peek: peekRange(),
    drivers: manifests.map(serializeDriver),
    // Omitted rather than written empty, for the reason the whole function is
    // arranged around: a key this script invented would survive into
    // `~/.peek/packages/` looking exactly like something the author wrote.
    ...(contributions.viewKinds.length === 0 ? {} : { viewKinds: contributions.viewKinds }),
    ...(contributions.tools.length === 0 ? {} : { tools: contributions.tools }),
    entry,
  }
  const outcome = parsePackageManifest(candidate)
  if (!outcome.ok) {
    throw new Error(
      `packages/${pkg.name} serializes into a peek-package.json that peek would refuse:\n` +
        outcome.issues.map((line) => `    ${line}`).join('\n') +
        `\n\n  The manifest and the file are the same declaration, so this is a bug in ` +
        `packages/${pkg.name}/${MANIFEST_MODULE},\n  not in the serialization — fix it there and both ` +
        `halves move together.`,
    )
  }
  return candidate
}

/* ------------------------------------------------------------------ */
/* Build guards                                                        */
/* ------------------------------------------------------------------ */

/** `…/node_modules/@scope/name/lib/x.js` → `@scope/name`; a path with no `node_modules` → null. */
function nodeModulesPackageOf(id) {
  const marker = `${sep}node_modules${sep}`
  const at = id.lastIndexOf(marker)
  if (at === -1) return null
  const rest = id.slice(at + marker.length).split(sep)
  return rest[0]?.startsWith('@') ? `${rest[0]}/${rest[1]}` : (rest[0] ?? null)
}

/**
 * Non-workspace packages `contrib.mjs` is allowed to inline.
 *
 * The artifact-side twin of `ALLOWED_MODULES` in `subpath-purity.test.ts`, which
 * makes the same claim about the source text of the subpaths this entry reaches.
 * `@peek/core` is not listed because it is not resolved through `node_modules`
 * here — the alias points at `packages/core/src`, and everything under
 * `packages/` is allowed by construction.
 *
 * One entry, so the two lists are kept apart rather than shared; if a second one
 * ever appears they should become a module in `scripts/`, the way
 * `main-may-reach.ts` did when a second check started reading it.
 */
const CONTRIB_MAY_BUNDLE = ['zod']

/**
 * Fails the build when anything outside the workspace lands in `contrib.mjs`.
 *
 * A *module-identity* check, run while the graph is being built, and that is why
 * it is here rather than in the byte audit below: a grep answers "does this
 * string appear", which a minifier and a rename both defeat, while this answers
 * "which files went in" — the same question `assertMainHoldsNoPackageCode` asks
 * about main's chunks, for the same reason.
 *
 * It is deliberately stated as containment rather than as a list of clients.
 * "No `pg`" would pass for a client reached transitively through a helper
 * package; "nothing but the workspace and zod" cannot. The package host computes
 * strings and plans fetches — it opens no socket and needs nothing from npm to
 * do it — so the strict rule is also the accurate one.
 */
function assertContribHoldsNoClient(packageName) {
  const workspace = `${repoRoot}${sep}packages${sep}`
  return {
    name: 'peek:assert-contrib-holds-no-client',
    apply: 'build',
    moduleParsed(info) {
      // Virtual modules (rollup and vite both prefix them with a NUL) and query
      // suffixes are the rollup plugin pipeline talking to itself, not files.
      const id = info.id.split('?')[0]
      if (id.startsWith('\0') || !id.startsWith(sep)) return
      if (id.startsWith(workspace)) return
      const from = nodeModulesPackageOf(id)
      if (from !== null && CONTRIB_MAY_BUNDLE.includes(from)) return
      this.error(
        `contrib.mjs for ${packageName} would inline ${from === null ? id : from} (${id}).\n\n` +
          `  A package's contrib runs in that package's own host process, which computes display strings, ` +
          `plans a\n  view's fetch and maps a tool call — and opens nothing. Design 2026-08-07 §2.4bis: the ` +
          `database client\n  belongs in driver.mjs, in the driver host, one process per connection.\n\n` +
          `  Reach the client-free subpaths (./display, ./view, ./mcp-tools) from src/entry/contrib.ts and ` +
          `never\n  ./driver or the package index. If this really is a dependency a host may hold, add it to ` +
          `CONTRIB_MAY_BUNDLE\n  in scripts/build-packages.mjs and to ALLOWED_MODULES in ` +
          `subpath-purity.test.ts — both, or the two checks\n  start disagreeing about what a host is.\n`,
      )
    },
  }
}

/**
 * Gives the chunk the `require` its vendor code calls.
 *
 * Measured, not anticipated: the qdrant bundle carries five
 * `try { require('node:crypto') } catch {}` sites from undici and the redis one
 * carries a `require('node:diagnostics_channel')`. They are CommonJS calls that
 * Rollup's interop left as runtime lookups, and in an ES module `require` is a
 * free variable — so without this every one of them throws a `ReferenceError`
 * into its own `catch` and the client **silently takes the degraded branch**:
 * undici hashing without node's crypto, no HTTP/2, no diagnostics channel. No
 * error, no log, a slower client. `out/main/driver-host.js` has had the same
 * shim all along (electron-vite's `vite:esm-shim`, pre-empted by
 * `cjsShimAtTopPlugin`), so leaving it out here would have made a package's
 * driver quietly worse than the one compiled into the app.
 *
 * Emitted before minification on purpose. esbuild's `minifyIdentifiers` renames
 * the binding *and every reference to it* — the vendor calls included, since
 * once this declaration exists they resolve to it — so the pair stays consistent
 * under whatever name it ends up with.
 *
 * The predicate is electron-vite's own and is deliberately loose: it matches
 * `require(` inside string literals too, and mysql2 has one in an error message.
 * The cost of a false positive is five unused lines and one more `node:module`
 * import; the cost of a false negative is the silent degradation above.
 */
function cjsRequireShim() {
  const SHIM =
    "import { createRequire as __peekCreateRequire } from 'node:module';\n" +
    'const require = __peekCreateRequire(import.meta.url);\n'
  const CJS_SYNTAX_RE = /require\(|require\.resolve\(/
  return {
    name: 'peek:cjs-require-shim',
    apply: 'build',
    renderChunk(code, _chunk, { format }) {
      if (format !== 'es' || code.includes(SHIM) || !CJS_SYNTAX_RE.test(code)) return null
      // Prepending is safe ahead of the chunk's own imports: ESM hoists import
      // declarations, so the binding is initialized before any module body
      // statement runs — which is exactly what the `require()` callers need.
      return { code: SHIM + code, map: null }
    },
  }
}

/**
 * Fails the build when the output is not one file that imports only builtins.
 *
 * Rollup's own bookkeeping rather than a scan of the result: `chunk.imports`
 * holds the specifiers it decided not to inline, before minification has had a
 * chance to re-spell anything. The byte audit afterwards asks the same question
 * of the emitted text, which is the copy that ships — neither one subsumes the
 * other, and a bare import has to get past both.
 *
 * A second chunk is a failure on its own, and not only because a package's file
 * would then be incomplete: two chunks is what code-splitting looks like, and
 * two entries sharing one is the leak this whole script is arranged to prevent.
 */
function assertSelfContained(label) {
  return {
    name: 'peek:assert-self-contained',
    apply: 'build',
    generateBundle(_options, bundle) {
      const chunks = Object.values(bundle).filter((output) => output.type === 'chunk')
      if (chunks.length !== 1) {
        this.error(
          `${label} came out as ${String(chunks.length)} chunk(s): ${chunks.map((c) => c.fileName).join(', ')}. ` +
            `A package file is one self-contained ESM module — design §1.2 is that the clients bundle, so ` +
            `there is nothing to split out and nothing to fetch a second file with.`,
        )
        return
      }
      const chunk = chunks[0]
      const external = [...chunk.imports, ...chunk.dynamicImports].filter((id) => !isBuiltin(id))
      if (external.length === 0) return
      this.error(
        `${label} imports ${external.map((id) => `'${id}'`).join(', ')} from outside itself.\n\n` +
          `  It is loaded by \`import()\` from ~/.peek/packages/<id>/, where there is no node_modules and ` +
          `no resolver\n  that could find those — design §3.4 refused shipping a dependency tree per ` +
          `package, so bundling is the\n  contract. An optional dependency that is meant to be missing goes ` +
          `in scripts/optional-dep-alias.ts as a\n  stub (see pg-native-stub.ts); anything else has to be ` +
          `installed.`,
      )
    },
  }
}

/**
 * Fails the build when a chunk carries Vite's "Could not resolve" throw.
 *
 * The same guard `electron.vite.config.ts` installs, and for the same reason:
 * that throw is emitted at chunk top level, so it is never a recoverable
 * "optional dependency missing" — it is a process that dies on load. Restated
 * rather than imported because the config exports the whole main-process target
 * and not this vite plugin, and importing that config would drag React and Tailwind
 * into a script that builds neither.
 */
function assertNoUnresolvedImports(label) {
  const UNRESOLVED_RE = /Could not resolve ["']([^"']+)["']/g
  return {
    name: 'peek:assert-no-unresolved-imports',
    apply: 'build',
    generateBundle(_options, bundle) {
      for (const output of Object.values(bundle)) {
        if (output.type !== 'chunk') continue
        const specifiers = [...new Set([...output.code.matchAll(UNRESOLVED_RE)].map((m) => m[1]))]
        if (specifiers.length === 0) continue
        this.error(
          `${label} contains a top-level throw for unresolved import(s): ${specifiers.join(', ')}. ` +
            'The file will crash on load, not degrade. Add a stub to scripts/optional-dep-alias.ts ' +
            '(see pg-native-stub.ts), or install the dependency.',
        )
      }
    },
  }
}

/* ------------------------------------------------------------------ */
/* The three builds                                                    */
/* ------------------------------------------------------------------ */

/**
 * Settings every node-side package build shares.
 *
 * `ssr` is what makes it a *node* build: Vite resolves the `node` export
 * condition rather than the browser one, which decides whether `pg` comes out as
 * a socket client or as the browser shim it also ships. `noExternal: true` is
 * the inversion that matters — SSR builds externalize dependencies by default,
 * which is the opposite of the one property these files must have.
 *
 * `keepNames` for the same reason the main process gets it: these run in
 * utilityProcesses whose stderr main forwards, and a driver crash is read as a
 * stack. Measured on driver-host at under 2% of the minified size.
 */
function nodeTarget(pkg, entryFile, outFile, plugins) {
  return {
    configFile: false,
    logLevel: 'warn',
    root: pkg.dir,
    resolve: { alias: { '@peek/core': coreEntry, ...optionalDepAlias } },
    ssr: { noExternal: true, target: 'node' },
    esbuild: { keepNames: true },
    build: {
      ssr: entryFile,
      outDir: join(outRoot, pkg.id),
      // Emptied once per package by `resetPackageOut`, because three builds
      // write into this directory and each one would otherwise erase the last.
      emptyOutDir: false,
      minify: 'esbuild',
      target: 'node22',
      rollupOptions: {
        output: {
          format: 'es',
          entryFileNames: outFile,
          // One file, no code-splitting: see the header. Without this a dynamic
          // import anywhere in a client's graph silently produces a second file
          // that `import()` from ~/.peek/packages/ would look for beside the
          // first — which happens to work, and stops working the moment anything
          // copies the package by naming its files.
          inlineDynamicImports: true,
        },
      },
    },
    plugins,
  }
}

/**
 * The self-drawn view's document root.
 *
 * The removed UI build script verbatim, minus the discovery it used to do
 * itself, and now writing into the package's own directory (`<id>/ui/`) rather
 * than into a tree of its own — design §2.2: a package's UI ships inside the
 * package, so `resolvePackageAsset` serves it from wherever the package was
 * installed.
 */
function uiTarget(pkg) {
  return {
    root: join(pkg.dir, UI_DIR),
    // Relative, because the document is served from the root of its own origin
    // and has no idea what that origin is called. An absolute base would bake
    // `peek-package://<id>` into the HTML and make the bundle un-relocatable.
    base: './',
    configFile: false,
    logLevel: 'warn',
    resolve: {
      // Only ever reached by `import type`, which is erased before Rollup sees
      // it — the alias is here so that a *value* import of core fails loudly at
      // build time with a plain missing-file error, rather than resolving and
      // quietly putting zod inside a package's UI bundle.
      alias: { '@peek/core': coreEntry },
    },
    build: {
      outDir: join(outRoot, pkg.id, UI_DIR),
      emptyOutDir: false,
      minify: 'esbuild',
      // No preload/modulepreload injection: the document CSP has no
      // `connect-src`, and a `<link rel=modulepreload>` is a fetch. It works
      // today because Vite emits it as a link element rather than as a fetch,
      // but relying on that distinction inside a frame we deliberately gave no
      // network is a bet with no upside.
      modulePreload: false,
      rollupOptions: {
        input: join(pkg.dir, UI_DIR, 'index.html'),
        output: {
          // Flat and unhashed. The protocol handler serves with `no-store`, so a
          // content hash buys nothing, and a stable name is what makes the
          // built output readable when a package's frame misbehaves.
          entryFileNames: '[name].js',
          chunkFileNames: '[name].js',
          assetFileNames: '[name][extname]',
        },
      },
    },
  }
}

/* ------------------------------------------------------------------ */
/* Auditing what was written                                           */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* Reading the emitted text: specifiers, with strings stepped over     */
/* ------------------------------------------------------------------ */

/**
 * The token a module specifier follows.
 *
 * `import(` is spelled out beside `import` because a dynamic import ends in a
 * paren and would otherwise miss.
 */
const BEFORE_SPECIFIER = /(?:^|[^\w$])(?:from|import|import\(|require\()$/

/** Where a `/` starts a regex rather than a division: the code just before it. */
const REGEX_KEYWORDS = 'return|typeof|case|in|of|do|else|yield|await|new|delete|void|instanceof'
const BEFORE_REGEX = new RegExp(`(?:[([{,;:=!&|?+\\-*%<>~^]|\\b(?:${REGEX_KEYWORDS}))$`)

/** Index just past a quoted run that starts at `open`, honouring backslash escapes. */
function endOfQuoted(source, open, quote) {
  let i = open + 1
  while (i < source.length) {
    const c = source[i]
    if (c === '\\') i += 2
    else if (c === quote) return i + 1
    else i += 1
  }
  return source.length
}

/**
 * Every module specifier the emitted code actually names.
 *
 * A walk rather than a regex, and the walk is the whole point: a plain pattern
 * matches `require('bluebird')` **inside a string literal**, which is where
 * mysql2 keeps it — in the error text it prints when someone awaits a callback
 * query. Measured on this repository's own sql bundle, where a regex version of
 * this check reported `mysql2/promise` and `bluebird` as unbundled imports of a
 * file that imports neither.
 *
 * So strings, template literals, regex literals and comments are stepped over,
 * and a specifier is only recorded when the code just before the quote is an
 * `import` / `from` / `require(`. The machinery is
 * `scripts/audit-package-boundary.mjs`'s `literalsOf`, run for the opposite
 * purpose: that one collects the literals a module *says* and skips specifiers,
 * this one keeps only the specifiers.
 */
function emittedSpecifiers(code) {
  const found = new Set()
  let i = 0
  let prefix = ''
  while (i < code.length) {
    const c = code[i]
    const next = code[i + 1]
    if (c === '/' && next === '/') {
      while (i < code.length && code[i] !== '\n') i += 1
      continue
    }
    if (c === '/' && next === '*') {
      i += 2
      while (i < code.length && !(code[i] === '*' && code[i + 1] === '/')) i += 1
      i += 2
      continue
    }
    if (c === '/' && (prefix === '' || BEFORE_REGEX.test(prefix))) {
      i = endOfQuoted(code, i, '/')
      prefix = '/'
      continue
    }
    if (c === '`') {
      i = endOfQuoted(code, i, '`')
      prefix = '`'
      continue
    }
    if (c === "'" || c === '"') {
      const end = endOfQuoted(code, i, c)
      if (BEFORE_SPECIFIER.test(prefix)) found.add(code.slice(i + 1, end - 1))
      i = end
      prefix = c
      continue
    }
    if (!/\s/.test(c)) prefix = (prefix + c).slice(-16)
    i += 1
  }
  return found
}

/**
 * The last line of defence, and the only one that reads what ships.
 *
 * Both build guards above run *inside* a Rollup graph and can only report on the
 * build they are in. This reads the file off disk afterwards, which is the same
 * move `scripts/audit-package-boundary.mjs` makes for the main/host pair and for
 * the same reason: a rollup plugin sees the build it runs in, and the artifact is what
 * the app loads.
 */
function auditArtifact(label, file) {
  const code = readFileSync(file, 'utf8')
  const unresolved = [...new Set([...code.matchAll(/Could not resolve ["']([^"']+)["']/g)].map((m) => m[1]))]
  if (unresolved.length > 0) {
    throw new Error(
      `${label} carries a top-level throw for unresolved import(s): ${unresolved.join(', ')}. ` +
        `The file crashes on load rather than degrading.`,
    )
  }
  const bare = [...emittedSpecifiers(code)].filter((id) => !isBuiltin(id))
  if (bare.length > 0) {
    throw new Error(
      `${label} still names ${bare.map((id) => `'${id}'`).join(', ')} in its emitted text.\n\n` +
        `  Nothing resolves a bare specifier from ~/.peek/packages/<id>/ — there is no node_modules ` +
        `beside it (§3.4).\n  Either it must be bundled, or, if it is an optional dependency meant to be ` +
        `absent, stubbed in\n  scripts/optional-dep-alias.ts.`,
    )
  }
  return Buffer.byteLength(code)
}

/**
 * Load a built file in a child node process and report what it exports.
 *
 * A child rather than this process, for three reasons that all point the same
 * way: a `driver.mjs` carries a real database client and evaluating one here
 * would put five of them in the build; a package that misbehaves on import (the
 * timer design §3.6 warns about) takes down a disposable process instead of the
 * build; and the module graph stays clean, so `contrib.mjs` is judged in
 * isolation rather than beside whatever this script already loaded.
 *
 * What it proves is what no static check can: node's own resolver accepted every
 * specifier in the file. A leftover bare import is `ERR_MODULE_NOT_FOUND` here,
 * decided by the resolver that will decide it at runtime.
 */
async function probeExports(file) {
  // `drivers` answers with `meta.id` and `displays` with `driverId`, because a
  // `Driver` carries `DriverMeta` and a `PackageDisplayEntry` is a pairing. Read
  // where each one actually keeps it rather than probing for a common key: a
  // fallback would report an empty list for a shape that changed, and an empty
  // list is what the comparison below is trying to catch.
  const source =
    `const m = await import(process.argv[1]);` +
    `process.stdout.write(JSON.stringify({` +
    `  names: Object.keys(m),` +
    `  drivers: [...(m.drivers ?? [])].map((d) => d.meta.id),` +
    `  displays: [...(m.displays ?? [])].map((d) => d.driverId),` +
    `  viewKinds: [...(m.viewKinds ?? [])].map((v) => v.kind),` +
    `  tools: [...(m.tools ?? [])].map((t) => t.name),` +
    `}));`
  const { stdout } = await execFileAsync(
    process.execPath,
    ['--input-type=module', '--eval', source, pathToFileURL(file).href],
    { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 },
  )
  return JSON.parse(stdout)
}

/** Two lists of names — driver ids, view kinds, tools — compared as sets. */
function sameNames(a, b) {
  const left = [...new Set(a)].sort()
  const right = [...new Set(b)].sort()
  return left.length === right.length && left.every((id, at) => id === right[at])
}

/* ------------------------------------------------------------------ */
/* Run                                                                 */
/* ------------------------------------------------------------------ */

function resetPackageOut(pkg) {
  const dir = join(outRoot, pkg.id)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  return dir
}

const packages = discoverPackages()
if (packages.length === 0) {
  console.log('[peek/packages] no packages/db-* directory — nothing to build')
  process.exit(0)
}

for (const pkg of packages) {
  const outDir = resetPackageOut(pkg)
  const hasContrib = existsSync(join(pkg.dir, CONTRIB_ENTRY))
  const hasUi = existsSync(join(pkg.dir, UI_DIR, 'index.html'))

  /* 1. The manifest, from the same values the app imports. */
  const namespace = await import(pathToFileURL(join(pkg.dir, MANIFEST_MODULE)).href)
  const manifests = driverManifestsOf(namespace, pkg.name)
  const contributions = { viewKinds: viewKindsOf(namespace), tools: await toolsOf(pkg) }
  const manifest = packageManifestFor(pkg, manifests, contributions, {
    driver: DRIVER_FILE,
    ...(hasContrib ? { contrib: CONTRIB_FILE } : {}),
    ...(hasUi ? { ui: UI_DIR } : {}),
  })
  writeFileSync(join(outDir, 'peek-package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  const declaredIds = manifests.map((m) => m.driverId)

  /* 2. driver.mjs — the client inlined. */
  await build(
    nodeTarget(pkg, join(pkg.dir, DRIVER_ENTRY), DRIVER_FILE, [
      cjsRequireShim(),
      assertNoUnresolvedImports(`${pkg.id}/${DRIVER_FILE}`),
      assertSelfContained(`${pkg.id}/${DRIVER_FILE}`),
    ]),
  )
  const driverBytes = auditArtifact(`${pkg.id}/${DRIVER_FILE}`, join(outDir, DRIVER_FILE))
  const driverProbe = await probeExports(join(outDir, DRIVER_FILE))
  if (!sameNames(driverProbe.drivers, declaredIds)) {
    throw new Error(
      `${pkg.id}/${DRIVER_FILE} serves [${driverProbe.drivers.join(', ')}] but peek-package.json declares ` +
        `[${declaredIds.join(', ')}].\n\n  A driver the manifest advertises and the file does not carry is a ` +
        `connection that fails at connect time with\n  "driver not registered"; the other direction is a ` +
        `database nothing can reach. Both are declared in\n  packages/${pkg.name} — src/entry/driver.ts and ` +
        `${MANIFEST_MODULE} — and this is the only place they meet.`,
    )
  }

  /* 3. contrib.mjs — the same package, with nothing that opens a socket. */
  let contribBytes = 0
  let contribProbe = { viewKinds: [], tools: [] }
  if (hasContrib) {
    await build(
      nodeTarget(pkg, join(pkg.dir, CONTRIB_ENTRY), CONTRIB_FILE, [
        assertContribHoldsNoClient(pkg.id),
        cjsRequireShim(),
        assertNoUnresolvedImports(`${pkg.id}/${CONTRIB_FILE}`),
        assertSelfContained(`${pkg.id}/${CONTRIB_FILE}`),
      ]),
    )
    contribBytes = auditArtifact(`${pkg.id}/${CONTRIB_FILE}`, join(outDir, CONTRIB_FILE))
    contribProbe = await probeExports(join(outDir, CONTRIB_FILE))
    if (!sameNames(contribProbe.displays, declaredIds)) {
      throw new Error(
        `${pkg.id}/${CONTRIB_FILE} contributes displays for [${contribProbe.displays.join(', ')}] but ` +
          `peek-package.json declares [${declaredIds.join(', ')}].\n\n  A connection whose display is missing ` +
          `is named by a host answering NOT_FOUND, which reads as a broken package\n  rather than as a ` +
          `forgotten line in src/entry/contrib.ts.`,
      )
    }
  }

  /* The two halves of §2.4bis(d)'s table, made to agree. Outside the block
   * above on purpose: a package that declares a view kind or a tool and ships no
   * `contrib.mjs` at all is the same failure with nothing to compare against. */
  const declaredKinds = contributions.viewKinds.map((v) => v.kind)
  if (!sameNames(contribProbe.viewKinds, declaredKinds)) {
    throw new Error(
      `${pkg.id}/${CONTRIB_FILE} registers view kinds [${contribProbe.viewKinds.join(', ')}] but ` +
        `peek-package.json declares [${declaredKinds.join(', ')}].\n\n  Main offers a view from the manifest and ` +
        `asks this file to draw it (§2.4bis(d)), so a kind on one side only is\n  either a view offered and then ` +
        `unopenable, or one that works and is never offered. Both halves are in\n  packages/${pkg.name} — ` +
        `${MANIFEST_MODULE} and src/entry/contrib.ts.`,
    )
  }
  const declaredTools = contributions.tools.map((t) => t.name)
  if (!sameNames(contribProbe.tools, declaredTools)) {
    throw new Error(
      `${pkg.id}/${CONTRIB_FILE} maps tools [${contribProbe.tools.join(', ')}] but peek-package.json declares ` +
        `[${declaredTools.join(', ')}].\n\n  tools/list is answered from the manifest without forking this ` +
        `package (§2.4bis(d)), so a name only the manifest\n  has is a tool the model is offered and cannot ` +
        `call. Declare it in ${TOOL_META_MODULE} and map it in\n  src/entry/contrib.ts — toolFromMeta is where ` +
        `the two are joined.`,
    )
  }

  /* 4. ui/ — the document root, when the package draws its own view. */
  if (hasUi) await build(uiTarget(pkg))

  const parts = [`${DRIVER_FILE} ${String(driverBytes)} B`]
  if (hasContrib) parts.push(`${CONTRIB_FILE} ${String(contribBytes)} B`)
  for (const kind of contribProbe.viewKinds) parts.push(`view:${kind}`)
  for (const tool of contribProbe.tools) parts.push(`tool:${tool}`)
  if (hasUi) parts.push(`${UI_DIR}/`)
  console.log(
    `[peek/packages] ${pkg.id} → out/packages/${pkg.id}  ` +
      `(${declaredIds.join(', ')}; ${parts.join(', ')})`,
  )
}
