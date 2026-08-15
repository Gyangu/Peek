import type { DriverManifest, InstalledPackages, NotifyMessage, PackageDriverManifest } from '@peek/core'
import type { LoadedPackage, PackageLoadReport } from './loader'

/* ==================================================================
 * The loader's report, as the registry every process reads.
 *
 * Two layers, and the seam between them is the point: `loader.ts` decides which
 * directories under `~/.peek/packages/` are packages peek can use, and this
 * turns the ones that survived into the three flat lists core's
 * `InstalledPackages` declares. Neither knows the other's job — the loader never
 * learns what a `DriverManifest` is for, and this never opens a file.
 *
 * ## The one thing that is computed rather than carried
 *
 * `DriverManifest.version` is the **package's** version, and the manifest on
 * disk says so by not repeating it per driver: `peek-package.json` states one
 * `version` at the top and `build-packages.mjs` drops the per-driver copy on the
 * way out. So it is put back here, from the package the driver was found in.
 * That is the same claim written once instead of once per driver, which is what
 * makes "two drivers of one package at different versions" unrepresentable
 * rather than merely unlikely.
 *
 * `redact` is the other, and it goes the opposite way: absent and `{}` are two
 * different statements in the manifest — decision 5's only warning depends on
 * telling them apart (`loader.ts`) — and exactly one behaviour at runtime, which
 * is that the config travels verbatim. The loader has already warned by the time
 * this runs, so collapsing them here loses nothing.
 * ================================================================== */

/**
 * Turn a scan into what the registry installs.
 *
 * Refusals are not consulted: a refused package contributes nothing at all,
 * which is design §2.7's whole-package rule. They still have to reach a human,
 * and that is `main/index.ts`'s job — this function has no way to tell an error
 * centre from a test.
 */
export function installedFrom(report: PackageLoadReport): InstalledPackages {
  return {
    drivers: report.loaded.flatMap((pkg) =>
      pkg.manifest.drivers.map((driver) => ({
        packageId: pkg.id,
        manifest: driverManifestOf(pkg, driver),
      })),
    ),
    viewKinds: report.loaded.flatMap((pkg) =>
      pkg.manifest.viewKinds.map((viewKind) => ({ ...viewKind, packageId: pkg.id })),
    ),
    tools: report.loaded.flatMap((pkg) => pkg.manifest.tools.map((tool) => ({ ...tool, packageId: pkg.id }))),
  }
}

function driverManifestOf(pkg: LoadedPackage, driver: PackageDriverManifest): DriverManifest {
  return {
    driverId: driver.driverId,
    displayName: driver.displayName,
    version: pkg.manifest.version,
    capabilities: driver.capabilities,
    connectForm: driver.connectForm,
    ...(driver.sqlDialect === undefined ? {} : { sqlDialect: driver.sqlDialect }),
    redact: driver.redact ?? {},
    identity: driver.identity,
    mcpConnectExample: driver.mcpConnectExample,
    ...(driver.skill === undefined ? {} : { skill: driver.skill }),
  }
}

/* ------------------------------------------------------------------ */
/* What a person has to be told about the scan                         */
/* ------------------------------------------------------------------ */

/**
 * Everything in a report that somebody should see, as messages.
 *
 * A function of the report rather than a loop in `main/index.ts` because a
 * refusal is the ordinary case (`loader.ts`: a package directory is written by a
 * user) and the *wording* of one is what decides whether they can act on it. It
 * is here, next to the transformation, so both can be driven without an Electron
 * app — main's own job is to hand each of these to the error centre.
 *
 * Three things are said and nothing else:
 *
 * 1. **Every refusal, with all of its issues.** A package that did not load is a
 *    database that is simply absent, and absent without a line is
 *    indistinguishable from a bug in peek — the user opens the connect dialog
 *    and PostgreSQL is not in it. All of the issues rather than the first,
 *    because the loader collected them precisely so that a manifest with four
 *    things wrong takes one round of fixing.
 * 2. **Every `redact` warning.** Decision 5 made that warning the only
 *    observable consequence of a package that never said which of its fields are
 *    secret; a warning nobody sees would leave it with none at all.
 * 3. **An empty scan.** Not one of the loader's own outcomes, and it is right
 *    that it is not: it cannot tell an empty directory from one it could not
 *    read, and a fresh install legitimately has neither. By the time this runs
 *    the bundled packages have been laid out, so nothing loaded means nothing
 *    works — which is worth saying in those words rather than leaving the user
 *    to infer it from an empty dialog.
 *
 * Nothing is said about the packages that loaded. That is the app working, and
 * it is already visible as the databases the connect dialog offers.
 */
export function packageLoadNotices(report: PackageLoadReport, packagesRoot: string): NotifyMessage[] {
  const notices: NotifyMessage[] = report.refused.map((refused) => ({
    level: 'error',
    message: `Package '${refused.id}' was not loaded, so the databases it provides are unavailable`,
    detail: `${refused.dir}\n${refused.issues.map((issue) => `  ${issue}`).join('\n')}`,
  }))

  for (const warning of report.warnings) {
    notices.push({ level: 'warn', message: `Package '${warning.id}': ${warning.message}` })
  }

  if (report.loaded.length === 0) {
    notices.push({
      level: 'error',
      message: 'No database packages are installed, so no connection can be opened',
      detail: packagesRoot,
    })
  }
  return notices
}
