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
 * directory. That ordering is the whole of §2.7's "任一项不过则拒绝整个包": a
 * package that failed a laxer install check would sit on disk contributing
 * nothing, and the explanation would arrive at the next launch, from the loader,
 * about a directory the user thought had installed.
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
      ...(shipped !== undefined && compareVersions(shipped, version) > 0
        ? { upgradeVersion: shipped }
        : {}),
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
 */
export function installPackage(request: InstallRequest): InstallOutcome {
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

  mkdirSync(packagesRoot, { recursive: true, mode: CONFIG_DIR_MODE })
  try {
    rmSync(staging, { recursive: true, force: true })
    cpSync(source, staging, { recursive: true })
    rmSync(target, { recursive: true, force: true })
    renameSync(staging, target)
  } catch (error) {
    rmSync(staging, { recursive: true, force: true })
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
  | { readonly ok: true; readonly tombstoned: boolean }
  | { readonly ok: false; readonly issue: string }

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

  try {
    if (tombstoned) writeTombstone(packagesRoot, id, request.version)
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

export interface RestoreOutcome {
  /** Ids that were absent and are now installed, in lay-out order. */
  readonly restored: readonly string[]
  readonly failed: readonly { readonly id: string; readonly detail: string | null }[]
}

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
 */
export function restoreBundledPackages(request: RestoreRequest): RestoreOutcome {
  clearTombstones(request.packagesRoot)
  const report = layOutBundledPackages(request)

  const restored: string[] = []
  const failed: { id: string; detail: string | null }[] = []
  for (const status of report.statuses) {
    if (status.outcome === 'laid-out') restored.push(status.id)
    else if (status.outcome === 'failed') failed.push({ id: status.id, detail: status.detail })
  }
  return { restored, failed }
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
