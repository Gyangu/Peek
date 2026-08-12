import { readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { PACKAGE_ID_PATTERN, PACKAGE_MANIFEST_FILE, parsePackageManifest, type PackageManifest } from '@peek/core'
import { isKernelToolName } from '../mcp/kernel-tool-names'
import { PACKAGE_UI_DIR } from '../packages/assets'

/* ==================================================================
 * Reading `<configDir>/packages/` — which packages are installed, and what is
 * wrong with the ones that are not.
 *
 * ## The report is the product, not the list
 *
 * A directory under `~/.peek/packages/` is written by a user: by hand, by the
 * install button, or by peek laying out the packages it ships with. So the
 * ordinary case is not "all good" — it is "one of them is wrong", and the two
 * failure shapes that must not happen are the ones this whole module is shaped
 * against:
 *
 * 1. **A package that half-loads.** Design §2.7: every check runs before a
 *    package is accepted, and any one of them failing refuses the *whole*
 *    package. A manifest that parses but names a `driver.mjs` that is not there
 *    would otherwise install fine and fail at the first connect, which is the
 *    furthest possible point from the mistake.
 * 2. **A refusal nobody can act on.** Every issue is a `path: what is wrong`
 *    line naming the key or the file, and a package is reported with **all** of
 *    its issues rather than the first — a manifest with four things wrong with
 *    it should take one round of fixing.
 *
 * And one bad package does not cost the others (§4.2 item 10): the scan collects
 * a report and never throws. `registerPackageViewKindNames` in the renderer already
 * had exactly this semantic, and this is the same rule applied one process over.
 *
 * ## What is checked here rather than in core
 *
 * `parsePackageManifest` is a pure function of a parsed JSON value, deliberately
 * — so it can be driven without a filesystem. Everything that needs the disk is
 * therefore here: the directory name, the manifest file, whether the entry
 * points exist, and the things one manifest cannot see — whether another package
 * already claims a `driverId`, an MCP tool name or a view kind, and whether the
 * kernel itself already answers to that tool name. The split is the
 * same one `resolvePackageAsset` makes: the decision is a pure function, the I/O
 * is its caller's.
 *
 * ## What is deliberately *not* checked
 *
 * - **Anything resembling vetting.** Decision 6 (§2.9): peek does not validate
 *   packages. Every check below asks whether peek can *use* this package, never
 *   whether it should be trusted, and none of them protects anything from a
 *   package that decides to misbehave — `driver.mjs` runs with the user's
 *   privileges the moment a connection is opened.
 * - **`manifest.peek` against this build.** The schema carries the range and
 *   says compatibility is the loader's policy; that policy is not written yet
 *   (§2.5 fixes only how two *package* versions compare), and a rule invented
 *   here would be a second opinion about it in the wrong file. Until it exists,
 *   the field is recorded and not read.
 * - **The view-kind registrations.** §2.7 lists `validateViewKindRegistration`
 *   among the checks that run before a package is accepted, and that list was
 *   written before decision 7 (§2.4bis). A registration is four *functions*, and
 *   they live in `contrib.mjs`, which only a package host process may import —
 *   main holding them is exactly what decision 7 forbids, and forking a host per
 *   package at scan time is what its lazy start (§2.4bis(c), acceptance 31)
 *   forbids. What the manifest now carries is the *data* half (`kind` /
 *   `driverIds` / `title`), which `PackageManifestSchema` checks on the way
 *   through `parsePackageManifest` above; the function half is checked by that
 *   package's host the first time it is forked. So a kind whose four functions
 *   are incomplete is refused at first use rather than at install — which is
 *   §4octies(b)'s routes 1 and 3, the two that differ in how acceptance 6 is
 *   worded and not in what gets built.
 *
 * ## Who calls it, and what happens to the report
 *
 * `main/index.ts`, once, inside `app.whenReady()` — after the bundled packages
 * have been laid out (or a first start would find nothing) and before the window
 * exists (or the connect dialog would be drawn against an empty registry). The
 * `loaded` half becomes that registry through `installedFrom`; the `refused` and
 * `warnings` halves become error-centre lines through `packageLoadNotices`.
 * Neither of those two is optional: this module's whole shape is "the report is
 * the product", and a report nobody reads makes a refused package
 * indistinguishable from a database that was never there.
 * ================================================================== */

/**
 * One package peek can use, with its entry points resolved.
 *
 * `dir` and the three entries are absolute: every consumer of this is about to
 * hand a path to `import()`, `protocol.handle` or a forked process, and a
 * relative path there would resolve against whatever that consumer's cwd
 * happened to be.
 */
export interface LoadedPackage {
  /** The directory name, the manifest's `id`, and the host of its URLs — all one string. */
  readonly id: string
  /** Absolute path of the package directory. */
  readonly dir: string
  readonly manifest: PackageManifest
  readonly entry: LoadedEntry
}

/** Where the three halves of a package are, absolute. `null` for the ones it does not ship. */
export interface LoadedEntry {
  /** Loaded by a driver-host process, one per connection. Always present. */
  readonly driver: string
  /** Loaded by this package's own host process: MCP tools and view-kind code. */
  readonly contrib: string | null
  /** Document root served at `peek-package://<id>/`. */
  readonly ui: string | null
}

/** A package peek will not use, and every reason why. */
export interface RefusedPackage {
  /** The directory name. It is what the user has to go and look at, even when the manifest disagrees with it. */
  readonly id: string
  readonly dir: string
  /** `path: what is wrong` lines, in the order they were found. Never empty. */
  readonly issues: readonly string[]
}

/** Something worth saying about a package that loaded anyway. */
export interface PackageWarning {
  readonly id: string
  readonly message: string
}

export interface PackageLoadReport {
  readonly loaded: readonly LoadedPackage[]
  readonly refused: readonly RefusedPackage[]
  readonly warnings: readonly PackageWarning[]
}

/**
 * Scan a packages directory.
 *
 * Synchronous on purpose: this reads one small JSON file per package on the
 * startup path, and the async version would buy a few milliseconds at the price
 * of making the boot order — which is what §2.7's install flow has to interleave
 * with — depend on scheduling. `config/json-file.ts` reads the connection book
 * the same way and for the same reason.
 *
 * A missing or unreadable root is an empty report rather than an error: a fresh
 * install has no `packages/` directory, and "no packages" is the correct answer
 * to that, not a failure to report to anybody.
 */
export function loadPackages(packagesRoot: string): PackageLoadReport {
  const loaded: LoadedPackage[] = []
  const refused: RefusedPackage[] = []
  const warnings: PackageWarning[] = []

  // Sorted, because two packages claiming one driverId are resolved by which was
  // seen first (below) and `readdir` order is a property of the filesystem. An
  // arbitrary winner would make that refusal move between machines.
  for (const name of directoryNames(packagesRoot)) {
    const dir = join(packagesRoot, name)
    const outcome = readPackage(name, dir, loaded)
    if (outcome.ok) {
      loaded.push(outcome.pkg)
      warnings.push(...outcome.warnings)
    } else {
      refused.push({ id: name, dir, issues: outcome.issues })
    }
  }

  return { loaded, refused, warnings }
}

/**
 * Put **one** directory through the same scan, without it being installed yet.
 *
 * This is `packages.install`'s first step (design §2.7: read the manifest, check
 * everything, refuse the whole package and say what is missing). It exists so
 * that the check a package faces at install time and the check it faces at every
 * launch afterwards are literally the same code — an install that ran a laxer
 * check would put a directory on disk that the next start refuses, which is the
 * worst of both: the package is there, does nothing, and the explanation arrives
 * a restart later.
 *
 * `dir` is the package directory itself. Its **name is not the id**: a directory
 * a user is installing from was named by whatever produced it (an unpacked
 * archive, a checkout), while the id is the manifest's and is what the target
 * directory will be called. So the manifest is read first for its id and the
 * scan is then run as if the directory were already called that.
 *
 * `alongside` is what is already loaded, for the two checks one manifest cannot
 * make (a `driverId` or a tool name another package already claims). **A package
 * already installed under the same id is dropped from it**, because installing
 * over an id is how a package is upgraded or repaired — measured against its own
 * previous copy, every driver it ships would read as taken.
 */
export function inspectPackageDir(
  dir: string,
  alongside: readonly LoadedPackage[],
): PackageInspection {
  const resolved = resolve(dir)
  const source = readManifestFile(join(resolved, PACKAGE_MANIFEST_FILE))
  if (!source.ok) return { ok: false, id: basename(resolved), issues: [source.issue] }

  // Only the id is taken from this parse; `readPackage` parses again and reports
  // every issue. Reading it twice costs one small JSON file and keeps the refusal
  // wording in one place.
  const declared = declaredId(source.value)
  if (declared === null) {
    return {
      ok: false,
      id: basename(resolved),
      issues: [`${PACKAGE_MANIFEST_FILE}: no 'id', so peek cannot tell what to install this as`],
    }
  }

  const others = alongside.filter((pkg) => pkg.id !== declared)
  const outcome = readPackage(declared, resolved, others)
  if (!outcome.ok) return { ok: false, id: declared, issues: outcome.issues }
  return { ok: true, pkg: outcome.pkg, warnings: outcome.warnings }
}

export type PackageInspection =
  | { ok: true; pkg: LoadedPackage; warnings: readonly PackageWarning[] }
  | { ok: false; id: string; issues: readonly string[] }

function declaredId(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null
  const id: unknown = (value as Record<string, unknown>)['id']
  return typeof id === 'string' && id.length > 0 ? id : null
}

/* ------------------------------------------------------------------ */
/* One directory                                                       */
/* ------------------------------------------------------------------ */

type PackageOutcome =
  | { ok: true; pkg: LoadedPackage; warnings: readonly PackageWarning[] }
  | { ok: false; issues: readonly string[] }

function readPackage(name: string, dir: string, accepted: readonly LoadedPackage[]): PackageOutcome {
  const issues: string[] = []

  // The directory name is the URL host (`resolvePackageAsset` tests the same
  // pattern on the way in) and the key every registry in main is keyed by. It
  // used to be checked at build time — `build-packages.mjs` refuses to build an
  // id it could not serve — and a directory the user made is the case that check
  // never covered (§4.2 item 7).
  if (!PACKAGE_ID_PATTERN.test(name)) {
    issues.push(`id: directory name '${name}' cannot be served — ${PATTERN_ENGLISH}`)
  }

  const source = readManifestFile(join(dir, PACKAGE_MANIFEST_FILE))
  if (!source.ok) return { ok: false, issues: [...issues, source.issue] }

  const parsed = parsePackageManifest(source.value)
  if (!parsed.ok) return { ok: false, issues: [...issues, ...parsed.issues] }
  const manifest = parsed.manifest

  // The manifest's `id` is what the package calls itself; the directory name is
  // what peek finds it under and what a `peek-package://` URL names. Nothing
  // downstream carries both, so a disagreement means one of them is silently
  // ignored — and which one that is differs per consumer.
  if (manifest.id !== name) {
    issues.push(`id: the manifest says '${manifest.id}' but the directory is named '${name}'`)
  }

  const entry = manifest.entry
  const driver = resolve(join(dir, entry.driver))
  requireFile(driver, entry.driver, 'entry.driver', issues)

  let contrib: string | null = null
  if (entry.contrib !== undefined) {
    contrib = resolve(join(dir, entry.contrib))
    requireFile(contrib, entry.contrib, 'entry.contrib', issues)
  }

  let ui: string | null = null
  if (entry.ui !== undefined) {
    ui = resolve(join(dir, entry.ui))
    requireUiDir(dir, ui, entry.ui, issues)
  }

  for (const driverEntry of manifest.drivers) {
    const owner = accepted.find((pkg) => pkg.manifest.drivers.some((d) => d.driverId === driverEntry.driverId))
    if (owner === undefined) continue
    // Two packages offering one driverId is not a merge: a connection stores the
    // id and nothing else, so which package opens it would come down to which
    // registry answered. The one already accepted keeps it, and the second is
    // refused whole rather than half-registered.
    issues.push(
      `drivers: '${driverEntry.driverId}' is already provided by the package '${owner.id}'`,
    )
  }

  for (const tool of manifest.tools) {
    // The kernel's own thirteen come first, because they are the half no other
    // package can be blamed for and the half that fails worst. `collectTools`
    // throws on a duplicate name — deliberately, so nothing can shadow
    // `run_query` — and every assembly of the tool surface goes through it: the
    // MCP endpoint's `bind`, each new session, the chat host's wiring. A package
    // accepted here with a kernel name therefore does not break itself, it stops
    // the app from having an MCP endpoint or a chat panel at all, on the next
    // launch, with no line naming the package. Only the loader knows whom to
    // blame, so the refusal is here and `collectTools`' throw stays behind it as
    // an assertion that nothing reached the surface unscreened.
    if (isKernelToolName(tool.name)) {
      issues.push(`tools: '${tool.name}' is one of peek's own tools and cannot be redeclared`)
      continue
    }
    const owner = accepted.find((pkg) => pkg.manifest.tools.some((t) => t.name === tool.name))
    if (owner === undefined) continue
    // An MCP tool name is global: `tools/list` is one flat list across every
    // package and the kernel's own thirteen, and a model picks by name alone. So
    // two packages declaring `expand_node` is not a collision peek can resolve
    // by scoping — whichever the executor routed to would be a coin toss the
    // user never sees, on a call that acts on their database. Same shape as the
    // `driverId` rule above, and the schema makes the within-one-package half.
    issues.push(`tools: '${tool.name}' is already declared by the package '${owner.id}'`)
  }

  for (const viewKind of manifest.viewKinds) {
    const owner = accepted.find((pkg) => pkg.manifest.viewKinds.some((k) => k.kind === viewKind.kind))
    if (owner === undefined) continue
    // The third global name space, and it was the one with no rule. A window
    // keys `PACKAGE_UI` and `registerViewKind` by the kind alone, so a second
    // package declaring `graph` does not get a second entry — it gets the first
    // package's iframe origin, or nothing, depending on which registration ran
    // last. Neither is reported anywhere, and `open_view` on that kind then
    // renders one package's view against another package's data.
    issues.push(`viewKinds: '${viewKind.kind}' is already declared by the package '${owner.id}'`)
  }

  if (issues.length > 0) return { ok: false, issues }

  return {
    ok: true,
    pkg: { id: name, dir, manifest, entry: { driver, contrib, ui } },
    warnings: redactWarnings(manifest),
  }
}

/**
 * Decision 5's only safety net, and the reason it is a warning rather than a
 * refusal.
 *
 * A package that declares no `redact` block gets its connection config — the
 * whole of it, password field included — handed to MCP clients and to the
 * renderer verbatim, because `redactConnectionConfig` has no rule to apply.
 * That was a compile error while the config union was closed (§1.4); the union
 * had to open for packages to exist at all, and this line is what replaced it.
 *
 * It does not block the load, on purpose: a package that leaks its own
 * connection string is still a package the user chose to install and may need,
 * and refusing it would make the safe-by-default answer "peek does not run your
 * package" — which is a policy §2.9 explicitly does not take. What is not
 * optional is that the warning **reaches the user**; a silent one would leave
 * decision 5 with no observable behaviour at all, which is why the test pins it.
 *
 * An explicit `{}` is not warned about. It behaves identically at runtime and
 * means something different here: sqlite saying it holds no secret, rather than
 * a package that never considered the question.
 */
function redactWarnings(manifest: PackageManifest): PackageWarning[] {
  return manifest.drivers
    .filter((driver) => driver.redact === undefined)
    .map((driver) => ({
      id: manifest.id,
      message:
        `driver '${driver.driverId}' declares no redact block, so its whole connection config — ` +
        `passwords included — is shown to MCP clients and stored in the command log verbatim`,
    }))
}

/* ------------------------------------------------------------------ */
/* Disk                                                                */
/* ------------------------------------------------------------------ */

/** English for `PACKAGE_ID_PATTERN`, so a refusal says what to rename the directory to. */
const PATTERN_ENGLISH = 'lowercase letters, digits and hyphens, starting with a letter or a digit'

/**
 * The subdirectories of the packages root, sorted, or none.
 *
 * Files are skipped without comment: `.uninstalled.json` (§2.5's tombstone) sits
 * beside the packages, and so does whatever the user's file manager leaves
 * behind. A *directory* that is not a package, on the other hand, is reported —
 * someone who unpacked an archive one level too deep has to be told, and the
 * dot-prefixed names are excluded first so that peek's own bookkeeping never
 * turns into a refusal about itself.
 *
 * `statSync` rather than `Dirent.isDirectory()` so a symlinked package directory
 * is followed. Developing a package by symlinking a checkout into `packages/` is
 * the obvious workflow, and it would otherwise be silently skipped.
 */
function directoryNames(packagesRoot: string): string[] {
  let names: string[]
  try {
    names = readdirSync(packagesRoot)
  } catch {
    return []
  }
  return names
    .filter((name) => !name.startsWith('.'))
    .filter((name) => statSync(join(packagesRoot, name), { throwIfNoEntry: false })?.isDirectory() === true)
    .sort()
}

type ManifestSource = { ok: true; value: unknown } | { ok: false; issue: string }

function readManifestFile(path: string): ManifestSource {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    // Not found, unreadable, or a directory — one message, because the answer is
    // the same in all three: this directory is not a package peek can read.
    return { ok: false, issue: `${PACKAGE_MANIFEST_FILE}: not readable in this directory` }
  }
  try {
    return { ok: true, value: JSON.parse(raw) as unknown }
  } catch (error) {
    // The parser's own message, which names the offset — the one detail that
    // makes a syntax error in a hand-edited file findable.
    return { ok: false, issue: `${PACKAGE_MANIFEST_FILE}: ${error instanceof Error ? error.message : 'not valid JSON'}` }
  }
}

/**
 * An entry point that has to be a file, resolved.
 *
 * The manifest's paths are already proven to be relative and free of `..` by
 * `ContainedPathSchema`, so joining cannot leave the directory; what is left to
 * find out is whether anything is there. Which is the whole reason this check is
 * not in the schema: `import()` of a path that does not exist is a failure at
 * the first connection, hours after the mistake was made.
 */
function requireFile(path: string, relative: string, key: string, issues: string[]): void {
  if (statSync(path, { throwIfNoEntry: false })?.isFile() !== true) {
    issues.push(`${key}: '${relative}' is not a file in this package`)
  }
}

/**
 * The UI root, which has to be both a directory and *the* directory.
 *
 * `resolvePackageAsset` serves `<packages>/<id>/ui/` and nothing else — the
 * served root is a constant there because it runs once per subresource with no
 * manifest in reach. So a package declaring its UI anywhere else would install
 * cleanly and then 404 every asset, which is precisely the half-load this file
 * exists to refuse. Two spellings of one path, so the loader is where they are
 * made to agree.
 */
function requireUiDir(dir: string, path: string, relative: string, issues: string[]): void {
  if (statSync(path, { throwIfNoEntry: false })?.isDirectory() !== true) {
    issues.push(`entry.ui: '${relative}' is not a directory in this package`)
    return
  }
  if (path !== resolve(join(dir, PACKAGE_UI_DIR))) {
    issues.push(
      `entry.ui: '${relative}' is not where peek serves a package's interface from — ` +
        `it must be '${PACKAGE_UI_DIR}'`,
    )
  }
}
