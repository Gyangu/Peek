import { cpSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { DriverId, InstalledPackages, PackageListing } from '@peek/core'
import { CONFIG_DIR_MODE } from '../config/json-file'
import {
  STAGING_PREFIX,
  clearTombstones,
  compareVersions,
  layOutBundledPackages,
  writeTombstone,
} from './bundled'
import { inspectPackageDir, type LoadedPackage } from './loader'

/* ==================================================================
 * Adding a directory to `~/.peek/packages/`, and taking one away.
 *
 * The disk half of design §2.7. It is a separate module from the commands that
 * drive it (`commands.ts`) for the reason `installed.ts` is separate from
 * `main/index.ts`: what a package install *is* — validate first, copy through a
 * staging name, replace atomically — is answerable without a Command Bus, a
 * window or an Electron app, and it is the half worth asserting on.
 *
 * ## Validate before writing, never after
 *
 * Both paths here run the loader's own checks *before* touching the packages
 * directory. That ordering is the whole of §2.7's "any one failing rejects the
 * whole package": a package that failed a laxer install check would sit on disk
 * contributing nothing, and the explanation would arrive at the next launch,
 * from the loader, about a directory the user thought had installed.
 *
 * ## What this module deliberately does not do
 *
 * - **Download.** §1.5 puts it outside this design; `PackagesInstallInputSchema`
 *   carries the argument.
 * - **Vet.** Decision 6 (§2.9): every check here asks whether peek can *use* the
 *   directory, never whether it should be trusted. `driver.mjs` runs with the
 *   user's privileges the moment a connection opens, and nothing below changes
 *   that or pretends to.
 * - **Register.** Installing a package means the *next scan* finds it. Nothing
 *   here touches a registry, forks a host, or notifies anybody — that is the
 *   caller's sequence, and keeping it out of here is what lets these two
 *   functions be driven against a temporary directory.
 * ================================================================== */

/* ------------------------------------------------------------------ */
/* Listing                                                             */
/* ------------------------------------------------------------------ */

/**
 * The installed registry, grouped back into packages, with where each came from.
 *
 * `InstalledPackages` is three flat lists because that is how everything else
 * reads it (§4terdecies b). This is the one consumer that asks the opposite
 * question — what is installed, one row per package — so the grouping happens
 * here rather than being carried around by everybody who does not need it.
 *
 * The version comes off a driver rather than being carried separately: a package
 * states one `version` and `installedFrom` puts that same string on each of its
 * drivers, and `PackageManifestSchema` requires at least one driver per package.
 * So "the first driver's version" is the package's version, not an approximation
 * of it.
 */
export function packageListing(
  installed: InstalledPackages,
  catalog: ReadonlyMap<string, string>,
): PackageListing[] {
  const rows = new Map<string, PackageListing>()

  for (const driver of installed.drivers) {
    const existing = rows.get(driver.packageId)
    if (existing) {
      existing.driverIds.push(driver.manifest.driverId)
      continue
    }
    const shipped = catalog.get(driver.packageId)
    const version = driver.manifest.version
    rows.set(driver.packageId, {
      id: driver.packageId,
      version,
      source: shipped === undefined ? 'user' : 'bundled',
      ...(shipped !== undefined && compareVersions(shipped, version) > 0 ? { upgradeVersion: shipped } : {}),
      driverIds: [driver.manifest.driverId],
      viewKinds: [],
      toolNames: [],
    })
  }

  // The other two lists are attached rather than driving the grouping: a package
  // may contribute no view kind and no tool, and one that contributed only those
  // could not be installed at all (`drivers` has a `min(1)`).
  for (const viewKind of installed.viewKinds) rows.get(viewKind.packageId)?.viewKinds.push(viewKind.kind)
  for (const tool of installed.tools) rows.get(tool.packageId)?.toolNames.push(tool.name)

  return [...rows.values()].sort((a, b) => a.id.localeCompare(b.id))
}

/* ------------------------------------------------------------------ */
/* Installing                                                          */
/* ------------------------------------------------------------------ */

export interface InstallRequest {
  /** The directory the user picked — the one holding `peek-package.json`. */
  readonly sourceDir: string
  /** `<configDir>/packages`. */
  readonly packagesRoot: string
  /** What is loaded right now, for the collision checks one manifest cannot make. */
  readonly loaded: readonly LoadedPackage[]
  /**
   * Stop whatever is already running under this package's id.
   *
   * Awaited **after every check has passed and before the first byte moves**,
   * which is `admin.ts`'s kill-then-remove ordering seen from the other side. A
   * package host has the old `contrib.mjs` in memory, and replacing files under
   * a live one does not replace what it answers with: `packages.read`, the
   * settings panel and `tools/list` all move to the new version while every
   * call — every tool, every package view — is still computed by the old code,
   * until the app restarts or the package is uninstalled, with nothing said.
   * Killing after the copy would narrow that window rather than close it, and
   * would leave the old process serving calls out of a directory that is
   * already the new one.
   *
   * A callback rather than a `PackageHostRegistry` for the reason `admin.ts`
   * gives: that registry forks Electron utility processes, and this module has
   * to stay reachable by `node --test`.
   */
  readonly evict: (id: string) => Promise<void>
}

export type InstallOutcome =
  | { readonly ok: true; readonly id: string; readonly version: string; readonly replaced: boolean }
  | { readonly ok: false; readonly id: string; readonly issues: readonly string[] }

/**
 * Copy a package directory in, replacing whatever was there under its id.
 *
 * Replacing rather than refusing, because that is what an upgrade and a repair
 * both are: §2.8 offers "upgrade" for a bundled package whose shipped copy is
 * newer, and `layOutBundledPackages` reports `unreadable` for an installed
 * directory whose manifest is broken and says reinstalling is what fixes it.
 * Neither has anywhere to go if installing over an id is an error.
 *
 * ## The copy is staged, and the window where nothing exists is one rename wide
 *
 * `cpSync` into the live directory would merge two builds — the failure
 * `clearStagingLitter` exists for, one directory over. So the new copy lands
 * under `.installing-<id>`, the old directory is removed, and the rename makes
 * the package appear. Between the removal and the rename the id is momentarily
 * absent; a scan that ran exactly there would report the package missing, which
 * is recoverable and observably true, whereas a merged directory is a package
 * that behaves like neither version and looks fine.
 *
 * Staging lives inside `packagesRoot` so the rename stays on one filesystem —
 * across devices `renameSync` degrades to a copy and stops being atomic, which
 * is the property being bought. Same reasoning as `copyIn` in `bundled.ts`, and
 * the same `STAGING_PREFIX`, so the litter sweep there covers a crash here.
 *
 * ## What is being replaced stops running before it is replaced
 *
 * Hence `async`: `evict` is awaited between the last check that can refuse and
 * the first statement that writes, and an install that skipped it would move the
 * files and change nothing anybody can observe through the package (see the
 * field). It is the only await here, and it is deliberately on the side of the
 * disk work where nothing has happened yet.
 */
export async function installPackage(request: InstallRequest): Promise<InstallOutcome> {
  const { packagesRoot } = request

  if (!isAbsolute(request.sourceDir)) {
    return {
      ok: false,
      id: request.sourceDir,
      // Not resolved against the cwd on the caller's behalf: main's cwd is
      // wherever peek was launched from — `/` for a double-clicked bundle — so a
      // resolved relative path would mean something different per launch.
      issues: [`dir: '${request.sourceDir}' is not an absolute path`],
    }
  }

  const source = resolve(request.sourceDir)
  if (statSync(source, { throwIfNoEntry: false })?.isDirectory() !== true) {
    return { ok: false, id: source, issues: [`dir: '${source}' is not a directory`] }
  }

  // Installing out of the packages directory would have this function delete its
  // own source between the copy and the rename. It is also never what somebody
  // means: a directory already under `packages/` is already installed.
  const inside = relative(resolve(packagesRoot), source)
  if (inside === '' || (!inside.startsWith('..') && !isAbsolute(inside))) {
    return {
      ok: false,
      id: source,
      issues: [`dir: '${source}' is already inside the packages directory`],
    }
  }

  const inspected = inspectPackageDir(source, request.loaded)
  if (!inspected.ok) return inspected

  const id = inspected.pkg.id
  const target = join(packagesRoot, id)
  const staging = join(packagesRoot, `${STAGING_PREFIX}${id}`)
  const replaced = statSync(target, { throwIfNoEntry: false })?.isDirectory() === true

  // Here and nowhere else: after the last check that can refuse, before the
  // first statement that writes. See `evict` for what the other two orders cost.
  // Unconditional rather than `if (replaced)`, because a host can outlive the
  // directory it was forked from — a hand-deleted package, an earlier install
  // that died at the rename — and re-forking one that was not running costs a
  // process nobody was using.
  await request.evict(id)

  try {
    mkdirSync(packagesRoot, { recursive: true, mode: CONFIG_DIR_MODE })
    rmSync(staging, { recursive: true, force: true })
    cpSync(source, staging, { recursive: true })
    rmSync(target, { recursive: true, force: true })
    renameSync(staging, target)
  } catch (error) {
    // The cleanup is not allowed to become the reported failure: `force: true`
    // only swallows ENOENT, so on the filesystems this path fails on at all —
    // full, read-only, ACL'd — the removal raises its own error and the user is
    // told about `.installing-<id>` instead of about their install. Same rule as
    // `discardStaging` in `bundled.ts`; the litter sweep collects it later.
    try {
      rmSync(staging, { recursive: true, force: true })
    } catch {
      // See above.
    }
    return {
      ok: false,
      id,
      issues: [`dir: '${id}' could not be installed: ${messageOf(error)}`],
    }
  }

  return { ok: true, id, version: inspected.pkg.manifest.version, replaced }
}

/* ------------------------------------------------------------------ */
/* Uninstalling                                                        */
/* ------------------------------------------------------------------ */

export interface UninstallRequest {
  readonly id: string
  readonly packagesRoot: string
  /** `bundledCatalog(...)`, to decide whether this id needs a tombstone. */
  readonly catalog: ReadonlyMap<string, string>
  /** The installed version, for the tombstone to record. */
  readonly version: string
}

export type UninstallOutcome =
  { readonly ok: true; readonly tombstoned: boolean } | { readonly ok: false; readonly issue: string }

/**
 * Delete a package's directory, and remember it if peek ships one under that id.
 *
 * **The tombstone is written first**, before the directory goes. The two orders
 * fail differently and only one of them fails safely: a tombstone with the
 * directory still there is a package that disappears at the next launch (the
 * user's intent, applied late), while a deleted directory with no tombstone is
 * `layOutBundledPackages` laying the package straight back out — an uninstall
 * button that undoes itself, which is rule 3 in `bundled.ts` restated as a
 * failure mode.
 *
 * `rmSync(force: true)` on a directory that is not there is a success, and that
 * is the honest answer: the caller asked for the package to be gone.
 */
export function uninstallPackage(request: UninstallRequest): UninstallOutcome {
  const { id, packagesRoot } = request
  const tombstoned = request.catalog.has(id)

  // The two steps report separately, because "could not be removed" was a lie in
  // the first one's mouth: a tombstone that fails to write names a `.tmp` file
  // inside the packages directory and the package's own directory has not been
  // touched yet, so the user was told peek could not delete something it had not
  // tried to delete.
  if (tombstoned) {
    try {
      writeTombstone(packagesRoot, id, request.version)
    } catch (error) {
      return {
        ok: false,
        issue:
          `'${id}' is a package peek ships, and the note that it was uninstalled could not be written ` +
          `to ${packagesRoot} — ${messageOf(error)}. The package is still installed: removing it ` +
          'without that note would only bring it back on the next start.',
      }
    }
  }

  try {
    rmSync(join(packagesRoot, id), { recursive: true, force: true })
  } catch (error) {
    return { ok: false, issue: `'${id}' could not be removed: ${messageOf(error)}` }
  }
  return { ok: true, tombstoned }
}

/* ------------------------------------------------------------------ */
/* Restoring what this build ships                                     */
/* ------------------------------------------------------------------ */

export interface RestoreRequest {
  readonly packagesRoot: string
  /** `Contents/Resources/bundled-packages` packaged, `out/packages` in development. */
  readonly bundledRoot: string
}

export type RestoreOutcome =
  | {
      readonly ok: true
      /** Ids that were absent and are now installed, in lay-out order. */
      readonly restored: readonly string[]
      readonly failed: readonly { readonly id: string; readonly detail: string | null }[]
    }
  /** Nothing was restored, and the reason is about the packages directory rather than any one package. */
  | { readonly ok: false; readonly issue: string }

/**
 * Forget every uninstall of a bundled package, then lay the missing ones back out.
 *
 * Decision 1's safety net (§2.5): a user who removed PostgreSQL gets it back
 * with one click rather than by reinstalling the app. The two steps are the two
 * halves `clearTombstones` was deliberately split from — the second one is
 * literally the call a first start makes, so a restored package and a
 * first-start package are the same directory produced by the same code.
 *
 * ## What it does not do
 *
 * It never removes or replaces anything. A package already installed under a
 * bundled id — the user's own newer PostgreSQL, or a broken directory — is left
 * exactly where it is, because rule 2 outranks this button: overwriting an
 * install to satisfy "restore" would be the app upgrade stamping on a user's
 * build (§2.5), triggered from a control that promises the opposite.
 *
 * So "restore" restores what is *missing*, and `restored` is the honest report
 * of that: on the common press it is empty, and that is not a failure.
 *
 * ## Both steps can fail before any package is reached
 *
 * `clearTombstones` writes a file and `layOutBundledPackages` needs the
 * directory that file lives in, so on a read-only `~/.peek` this function used
 * to throw a raw `EACCES` out of `writeFileSync` — which the command bus turned
 * into an INTERNAL carrying an `fs` stack trace and the name of a `.tmp` file,
 * with the words "restore bundled packages" nowhere in it. The failure is
 * reported instead, in one sentence about the directory, because that is the
 * only actionable thing there is to say: no id is at fault.
 */
export function restoreBundledPackages(request: RestoreRequest): RestoreOutcome {
  try {
    clearTombstones(request.packagesRoot)
  } catch (error) {
    return {
      ok: false,
      issue:
        `the bundled packages could not be restored: peek could not clear the record of uninstalled ` +
        `packages in ${request.packagesRoot} — ${messageOf(error)}`,
    }
  }

  const report = layOutBundledPackages(request)
  // The tombstones are gone by now, so a failure here still leaves the *next*
  // start restoring them. That is the same asymmetry `uninstallPackage` documents
  // for the other direction, and it fails in the direction the user asked for.
  if (report.issue !== null) return { ok: false, issue: report.issue }

  const restored: string[] = []
  const failed: { id: string; detail: string | null }[] = []
  for (const status of report.statuses) {
    if (status.outcome === 'laid-out') restored.push(status.id)
    else if (status.outcome === 'failed') failed.push({ id: status.id, detail: status.detail })
  }
  return { ok: true, restored, failed }
}

/** Every driver id a package provides, out of the registry rather than off the disk. */
export function driverIdsOfPackage(installed: InstalledPackages, packageId: string): DriverId[] {
  return installed.drivers
    .filter((driver) => driver.packageId === packageId)
    .map((driver) => driver.manifest.driverId)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
