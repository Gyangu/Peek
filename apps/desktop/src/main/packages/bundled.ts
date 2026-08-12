import { cpSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { PACKAGE_MANIFEST_FILE, parsePackageManifest } from '@peek/core/package-manifest'
import { z } from 'zod'
import { CONFIG_DIR_MODE, readJsonFile, writeJsonFile } from '../config/json-file'
import { inspectPackageDir, loadPackages, type LoadedPackage } from './loader'

/* ==================================================================
 * The packages peek ships with, and the one rule that makes them ordinary.
 *
 * Decision 1 (design 2026-08-07 §2.5): the five in-repo databases are **not**
 * privileged. They ride along inside the app bundle, get copied into
 * `~/.peek/packages/` the first time peek starts, and from that moment they are
 * indistinguishable from a package the user dropped in by hand — same loader,
 * same directory, same uninstall button.
 *
 *     peek.app/Contents/Resources/bundled-packages/<id>/   read-only, signed
 *     ~/.peek/packages/<id>/                               writable, loaded
 *
 * ## Three rules, and each one is a failure that would otherwise be silent
 *
 * 1. **Absent and not tombstoned → lay it out.** The ordinary first start, and
 *    the only case that writes anything.
 * 2. **Present → never overwrite; compare versions instead.** `install-mac.mjs`
 *    deletes the whole `.app` on every install but `~/.peek/` survives it, so an
 *    app upgrade meets whatever the user already has there — possibly a *newer*
 *    build they installed themselves. Pushing the shipped copy over it is the
 *    worst available failure: the person debugging by version number would rule
 *    out the build that is actually running. So a newer bundled copy is reported
 *    as upgradable and waits for a click (§2.8).
 * 3. **Uninstalled → a tombstone, or the button is a lie.** Nothing else
 *    distinguishes "the user removed PostgreSQL" from "PostgreSQL has not been
 *    laid out yet", so without `.uninstalled.json` the next start would put it
 *    straight back and the uninstall button would be theatre.
 *
 * ## What this module does not decide
 *
 * It does not load or register anything — `loader.ts` scans the directory
 * afterwards and judges what it finds, including the copies made here. A bundled
 * package is subjected to exactly the checks a third-party one is, which is
 * decision 1 restated as code: if peek's own package cannot pass the loader,
 * that is a bug in the package and not a reason for a bypass.
 *
 * It does run one of those checks *before* copying, through the loader's own
 * `inspectPackageDir` — the same call `installPackage` makes, for the same
 * reason. Rule 1 asks "is this id absent", and absent is not the same as free: a
 * package the user installed under a different name can already own the
 * `driverId` this one ships, and the scan that follows resolves that by
 * directory order. Copying first and finding out afterwards leaves a directory
 * that loads for nobody, reported as restored. Decision 1 says the shipped
 * copies are ordinary packages; being refused for the reason any other package
 * would be refused is what that means.
 * ================================================================== */

/** Where the tombstones live, beside the packages rather than inside one. */
export const TOMBSTONE_FILE = '.uninstalled.json'

/** The directory `package-mac.mjs` puts the shipped packages in, inside `Contents/Resources`. */
export const BUNDLED_PACKAGES_DIR_NAME = 'bundled-packages'

/**
 * Where this build keeps the packages it ships.
 *
 * Two answers because a packaged app and a checkout are laid out differently,
 * and one function because the alternative is two places that can disagree
 * about it — the symptom being an app that ships five packages and lays out
 * none, on the one build nobody runs from source.
 *
 * `resourcesPath` is `null` in development, where the shipped copies are simply
 * `build-packages.mjs`'s output beside the main bundle. That is the same
 * relative-sibling rule `PackageHostRegistry` uses to find `package-host.js`,
 * and for the same reason: `out/` is copied wholesale, so siblings stay
 * siblings. A packaged app is the exception — the packages are lifted out of
 * `out/` into `Contents/Resources/bundled-packages` so that the read-only
 * originals are not also sitting inside the app's own module tree, where the
 * next reader would have to work out which of the two copies is loaded.
 *
 * Electron is not imported for `app.isPackaged`; main passes it in, the way
 * `resolveHostDir` takes `allowOverride`. This module is run by `node --test`.
 */
export function bundledPackagesRoot(mainDir: string, resourcesPath: string | null): string {
  if (resourcesPath === null) return join(mainDir, '..', 'packages')
  return join(resourcesPath, BUNDLED_PACKAGES_DIR_NAME)
}

/**
 * The prefix a package wears while it is being copied in.
 *
 * A `cpSync` that dies halfway leaves a directory holding some of a package,
 * and the loader would report that as a broken install rather than as an
 * interrupted one. Dot-prefixed names are excluded from the scan before
 * anything else happens (`loader.ts`), so a crash mid-copy leaves litter and
 * nothing more; the rename that follows is what publishes the package, and it
 * is atomic within the directory.
 */
export const STAGING_PREFIX = '.installing-'

/* ------------------------------------------------------------------ */
/* The report                                                          */
/* ------------------------------------------------------------------ */

/**
 * What happened to one package peek ships.
 *
 * `upgradable` and `unreadable` are the two the settings panel acts on; the rest
 * are here so the report accounts for every bundled id rather than only the
 * interesting ones — a package that silently went missing from the app bundle
 * would otherwise be indistinguishable from one that was left alone.
 */
export type BundledOutcome =
  /** Rule 1: nothing was there, nothing forbade it, it is there now. */
  | 'laid-out'
  /** Rule 3: a tombstone says the user removed this one. */
  | 'suppressed'
  /** Rule 2, and the installed copy is at least as new. */
  | 'kept'
  /** Rule 2, and the shipped copy is newer. Settings offers it; peek does not take it. */
  | 'upgradable'
  /** Something is installed under this id whose manifest peek cannot read, so there was nothing to compare. */
  | 'unreadable'
  /**
   * The copy itself failed, the shipped package has no readable manifest, or it
   * could not have loaded beside what is already installed.
   */
  | 'failed'

export interface BundledPackageStatus {
  readonly id: string
  /** The version inside the app bundle. Null only when the shipped manifest could not be read. */
  readonly bundledVersion: string | null
  /** The version already in `~/.peek/packages/`, or null when nothing readable is installed. */
  readonly installedVersion: string | null
  readonly outcome: BundledOutcome
  /** English, present whenever a human should be told. */
  readonly detail: string | null
}

export interface BundledLayoutReport {
  readonly statuses: readonly BundledPackageStatus[]
  /**
   * Why not one package could be laid out, when the packages directory itself
   * was the thing that failed.
   *
   * Per-package failures are `failed` statuses; this is the case that has no
   * package to blame — `~/.peek/packages` is a regular file, or `~/.peek` is not
   * writable because peek was once started under `sudo`. Both are ordinary
   * accidents and both used to be an exception thrown out of the first statement
   * of `app.whenReady()`, which is not a place a throw is survivable: everything
   * after it — the scan, the protocol, the window, the `activate` handler — is in
   * the same callback, so the app kept running with no window and no way to quit
   * it but Force Quit. Reported rather than thrown, and null on every start where
   * the directory was fine.
   */
  readonly issue: string | null
}

/* ------------------------------------------------------------------ */
/* Tombstones                                                          */
/* ------------------------------------------------------------------ */

/**
 * One uninstalled bundled package.
 *
 * The version is recorded rather than inferred because it answers the question
 * a tombstone raises later: *which* PostgreSQL did the user throw away. Without
 * it, "restore bundled packages" cannot say whether it is putting back what was
 * removed or something newer.
 */
const TombstoneSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  /** ISO 8601, for a human reading the file. Nothing branches on it. */
  at: z.string().min(1),
})

const TombstoneFileSchema = z.object({ uninstalled: z.array(TombstoneSchema) })

export type Tombstone = z.infer<typeof TombstoneSchema>

/**
 * The bundled packages the user has removed.
 *
 * A file peek cannot parse reads as *no tombstones*, which restores every
 * bundled package on the next start. That is the safe direction of the two: the
 * cost is a package coming back that the user removed, once, visibly, with an
 * uninstall button still sitting next to it — against a corrupt byte silently
 * making PostgreSQL unavailable with no route back short of editing JSON.
 */
export function readTombstones(packagesRoot: string): readonly Tombstone[] {
  const parsed = TombstoneFileSchema.safeParse(readJsonFile(join(packagesRoot, TOMBSTONE_FILE)))
  return parsed.success ? parsed.data.uninstalled : []
}

/**
 * Record that a bundled package was uninstalled.
 *
 * Called by the uninstall path *before* the directory goes away, because the
 * version being buried can only be read while it is still there.
 *
 * Re-uninstalling an id replaces its entry instead of appending a second one:
 * two tombstones for one package differ only in which version was removed, and
 * the later removal is the one that describes what is missing now.
 */
export function writeTombstone(packagesRoot: string, id: string, version: string, at = new Date()): void {
  const kept = readTombstones(packagesRoot).filter((stone) => stone.id !== id)
  writeJsonFile(join(packagesRoot, TOMBSTONE_FILE), {
    uninstalled: [...kept, { id, version, at: at.toISOString() }],
  })
}

/**
 * Forget every uninstall — the "restore bundled packages" half of decision 1's
 * safety net (§2.5).
 *
 * It clears the file and stops there; laying the packages back out is
 * `layOutBundledPackages`, on the next call. Two steps rather than one because
 * that is the same path the first start takes, and a restore that reimplemented
 * the copy would be a second answer to "what does an installed package look
 * like".
 */
export function clearTombstones(packagesRoot: string): void {
  writeJsonFile(join(packagesRoot, TOMBSTONE_FILE), { uninstalled: [] })
}

/* ------------------------------------------------------------------ */
/* Laying them out                                                     */
/* ------------------------------------------------------------------ */

export interface LayOutOptions {
  /** `Contents/Resources/bundled-packages` in a packaged app, `out/packages` in development. */
  readonly bundledRoot: string
  /** `<configDir>/packages`. */
  readonly packagesRoot: string
}

/**
 * Bring `~/.peek/packages/` up to date with what this build ships.
 *
 * Synchronous, and on the startup path, for the reason `loadPackages` is: the
 * scan that follows has to see the finished state, and an ordering that depended
 * on scheduling would show up as a package that is present on some launches.
 * The work is a directory copy per *missing* package — on every start after the
 * first it is one `stat` and one small JSON read each.
 *
 * A missing `bundledRoot` is an empty report rather than an error: `pnpm dev`
 * without `pnpm build:packages` is exactly that, and it is the loader's refusal
 * (or the packaging check in `package-mac.mjs`) that has to be loud about it,
 * not a throw on the boot path.
 */
export function layOutBundledPackages(options: LayOutOptions): BundledLayoutReport {
  const { bundledRoot, packagesRoot } = options
  const ids = directoryNames(bundledRoot)
  if (ids.length === 0) return { statuses: [], issue: null }

  let suppressed: ReadonlySet<string>
  try {
    mkdirSync(packagesRoot, { recursive: true, mode: CONFIG_DIR_MODE })
    clearStagingLitter(packagesRoot)
    suppressed = new Set(readTombstones(packagesRoot).map((stone) => stone.id))
  } catch (error) {
    // The three statements that are about the directory rather than about any
    // one package. They are grouped because they fail together and for one
    // reason — the caller cannot use `~/.peek/packages/` at all — and because
    // the alternative is the throw that took the whole boot down with it.
    return {
      statuses: [],
      issue:
        `peek could not use its packages directory ${packagesRoot}: ${messageOf(error)} — no package ` +
        'was laid out, and none can be installed until that path is a writable directory',
    }
  }

  // Read on first use rather than up front, because the common start lays
  // nothing out: every bundled id is already installed, every `layOutOne`
  // returns before this is called, and a scan here would put a second full read
  // of the packages directory on the boot path for nothing.
  let scanned: readonly LoadedPackage[] | null = null
  const installed = (): readonly LoadedPackage[] => (scanned ??= loadPackages(packagesRoot).loaded)

  return {
    statuses: ids.map((id) =>
      layOutOne(id, join(bundledRoot, id), join(packagesRoot, id), suppressed.has(id), installed),
    ),
    issue: null,
  }
}

function layOutOne(
  id: string,
  source: string,
  target: string,
  tombstoned: boolean,
  installed: () => readonly LoadedPackage[],
): BundledPackageStatus {
  const bundledVersion = versionOf(source)
  if (bundledVersion === null) {
    return {
      id,
      bundledVersion: null,
      installedVersion: null,
      outcome: 'failed',
      detail:
        `the copy of '${id}' inside this build has no readable ${PACKAGE_MANIFEST_FILE}, so peek cannot ` +
        'tell what it would be installing',
    }
  }

  // Rule 3 is tested before rule 1 and *not* before rule 2: a tombstone says the
  // user removed the bundled copy, which says nothing about a package they later
  // installed themselves under the same id. Re-suppressing that one would delete
  // their install from the settings list on the strength of a decision about a
  // different package.
  if (!existsDir(target)) {
    if (tombstoned) {
      return {
        id,
        bundledVersion,
        installedVersion: null,
        outcome: 'suppressed',
        detail: `'${id}' was uninstalled; "restore bundled packages" in settings brings it back`,
      }
    }
    return copyIn(id, source, target, bundledVersion, installed())
  }

  const installedVersion = versionOf(target)
  if (installedVersion === null) {
    return {
      id,
      bundledVersion,
      installedVersion: null,
      outcome: 'unreadable',
      detail:
        `something is installed as '${id}' whose ${PACKAGE_MANIFEST_FILE} peek cannot read, so it was ` +
        'neither replaced nor compared — reinstalling the bundled copy is what repairs it',
    }
  }

  if (compareVersions(bundledVersion, installedVersion) > 0) {
    return {
      id,
      bundledVersion,
      installedVersion,
      outcome: 'upgradable',
      // Not taken automatically: see rule 2 in the header. The user may be
      // running an install of their own that this build happens to outrank.
      detail: `this build ships '${id}' ${bundledVersion}; ${installedVersion} is installed`,
    }
  }
  return { id, bundledVersion, installedVersion, outcome: 'kept', detail: null }
}

/**
 * Copy one package in, through a staging name.
 *
 * `renameSync` is what makes the package appear, and it either happens or does
 * not — so no scan can ever see half of one. The staging directory is inside
 * `packagesRoot` rather than in a temp directory so the rename stays on one
 * filesystem; across devices it degrades into a copy and stops being atomic,
 * which is the property being bought.
 *
 * It does not clear the staging path first: `clearStagingLitter` has already run
 * over the whole directory by the time any package is copied, and a second
 * removal here would be a guard no test can fail — the fragment it defends
 * against is gone before this is called.
 *
 * `alongside` is what the packages directory already holds, and the check
 * against it happens **before** the copy for the reason `installPackage` puts
 * its own first: a package that will be refused is one this function must not
 * write, or the report says `laid-out` about bytes nothing will ever load.
 */
function copyIn(
  id: string,
  source: string,
  target: string,
  bundledVersion: string,
  alongside: readonly LoadedPackage[],
): BundledPackageStatus {
  const inspected = inspectPackageDir(source, alongside)
  if (!inspected.ok) {
    return {
      id,
      bundledVersion,
      installedVersion: null,
      outcome: 'failed',
      // Every issue, indented, exactly as `packages.install` reports a refusal:
      // the reader of both is a person who has to go and change something, and
      // for a bundled id that something is usually the package they installed
      // over it.
      detail: `'${id}' was not laid out:\n${inspected.issues.map((issue) => `  ${issue}`).join('\n')}`,
    }
  }

  const staging = join(target, '..', `${STAGING_PREFIX}${id}`)
  try {
    cpSync(source, staging, { recursive: true })
    renameSync(staging, target)
    return { id, bundledVersion, installedVersion: bundledVersion, outcome: 'laid-out', detail: null }
  } catch (error) {
    discardStaging(staging)
    return {
      id,
      bundledVersion,
      installedVersion: null,
      outcome: 'failed',
      detail: `'${id}' could not be laid out: ${messageOf(error)}`,
    }
  }
}

/**
 * Throw away a half-written staging directory without letting the cleanup
 * become the failure that gets reported.
 *
 * `force: true` swallows ENOENT and nothing else, so on the exact filesystems
 * this cleanup exists for — a full disk, a directory an ACL made unwritable
 * mid-copy — the `rmSync` raises its own error on top of the one being handled.
 * In `layOutBundledPackages` that lands on the startup path, which is where a
 * throw costs the window; here it would replace a precise "could not be laid
 * out: ENOSPC" with an unrelated EACCES about a dot-directory the user has never
 * heard of. The litter left behind is swept by `clearStagingLitter` on the next
 * start, which is what that sweep is for.
 */
function discardStaging(staging: string): void {
  try {
    rmSync(staging, { recursive: true, force: true })
  } catch {
    // Deliberately silent: nothing here is worth a second line on top of the
    // failure the caller is already reporting.
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Remove what an interrupted copy left behind.
 *
 * Not cosmetic: `cpSync` into an existing directory *merges*, so a staging
 * directory from a killed run would contribute files to the next attempt and
 * the result would be a mix of two builds — a package that installed cleanly and
 * behaves like neither version.
 */
function clearStagingLitter(packagesRoot: string): void {
  for (const name of safeReaddir(packagesRoot)) {
    if (!name.startsWith(STAGING_PREFIX)) continue
    rmSync(join(packagesRoot, name), { recursive: true, force: true })
  }
}

/**
 * What this build ships, as id → version.
 *
 * The standing answer to the two questions `layOutBundledPackages` answers once
 * at startup and `packages.read` has to answer again after every install: is
 * this id one peek ships (which decides whether an uninstall leaves a
 * tombstone), and does the shipped copy outrank the installed one (which is the
 * "upgrade" the settings panel offers).
 *
 * Recomputed per call rather than cached: it is one small JSON read per bundled
 * package, it is read when a person clicks something, and a cache would be a
 * second copy of the app bundle's contents that nothing invalidates.
 *
 * An id whose shipped manifest cannot be parsed is left out entirely, which is
 * the same rule `versionOf` applies everywhere else in this file: a version peek
 * cannot read is not a version it may quote at a user.
 */
export function bundledCatalog(bundledRoot: string): ReadonlyMap<string, string> {
  const catalog = new Map<string, string>()
  for (const id of directoryNames(bundledRoot)) {
    const version = versionOf(join(bundledRoot, id))
    if (version !== null) catalog.set(id, version)
  }
  return catalog
}

/* ------------------------------------------------------------------ */
/* Versions                                                            */
/* ------------------------------------------------------------------ */

/**
 * The version a package directory claims, or null when there is no manifest peek
 * can read.
 *
 * The whole manifest is parsed rather than the one field picked out of the JSON,
 * so that "a version peek can read" means the same thing here as everywhere
 * else. The alternative — trusting `version` out of a file that fails the schema
 * — would let this module report an upgrade path for a directory the loader is
 * about to refuse, and the user would be told a version number for something
 * that never loads.
 */
function versionOf(dir: string): string | null {
  const parsed = parsePackageManifest(readJsonFile(join(dir, PACKAGE_MANIFEST_FILE)))
  return parsed.ok ? parsed.manifest.version : null
}

/**
 * Order two package versions by their first three segments, and nothing else.
 *
 * §2.5 fixes this deliberately: pre-release ordering is the bulk of a semver
 * implementation and no package uses it, so the comparison reads exactly what
 * `PACKAGE_VERSION_PATTERN` guarantees is there. `1.2.3-beta` and `1.2.3`
 * therefore compare equal — which, for the one decision this feeds (does the
 * shipped copy outrank the installed one), means peek does not offer to replace
 * a pre-release with the release it came from. That is the quiet direction; the
 * loud one would be silently downgrading someone's test build.
 */
export function compareVersions(a: string, b: string): number {
  const left = segmentsOf(a)
  const right = segmentsOf(b)
  for (let at = 0; at < 3; at += 1) {
    const diff = (left[at] ?? 0) - (right[at] ?? 0)
    if (diff !== 0) return diff > 0 ? 1 : -1
  }
  return 0
}

function segmentsOf(version: string): number[] {
  return version
    .split(/[-+]/, 1)[0]!
    .split('.')
    .slice(0, 3)
    .map((segment) => {
      const parsed = Number.parseInt(segment, 10)
      return Number.isNaN(parsed) ? 0 : parsed
    })
}

/* ------------------------------------------------------------------ */
/* Disk                                                                */
/* ------------------------------------------------------------------ */

function directoryNames(root: string): string[] {
  return safeReaddir(root)
    .filter((name) => !name.startsWith('.'))
    .filter((name) => existsDir(join(root, name)))
    .sort()
}

function safeReaddir(root: string): string[] {
  try {
    return readdirSync(root)
  } catch {
    return []
  }
}

function existsDir(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isDirectory() === true
}
