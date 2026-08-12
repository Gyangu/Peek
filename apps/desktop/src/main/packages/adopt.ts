import { installPackages } from '../../drivers/installed'
import type { InstalledPackages } from '@peek/core'
import { installedFrom } from './installed'
import type { PackageLoadReport } from './loader'
import { installPackageLocations } from './locations'

/* ==================================================================
 * One scan becoming the two registries this process reads from.
 *
 * A three-line function in a file of its own, because the three lines are a
 * *pair* that must not come apart and they used to live inside `main/index.ts`,
 * where nothing under `node --test` can reach them. `hot-reload.test.ts` — the
 * file that drives install, uninstall and restore against a real directory —
 * therefore had to re-implement them, and its copy only ever had the first half.
 * Both halves were green for a year with `installPackageLocations` deleted:
 *
 *   `installPackages`          the manifests, which the window also holds
 *                              (`drivers/installed.ts`) — this is what the
 *                              connect dialog draws and what `tools/list` lists
 *   `installPackageLocations`  the absolute paths, which never leave main
 *                              (`packages/locations.ts`) — this is what a
 *                              driver-host fork and a package-host fork resolve
 *
 * Drop the second and every listed database is still listed, still offered in
 * the dialog, still in the tool surface — and every `conn.open` fails with "It
 * is in the registry, so the scan accepted it and its directory has gone away
 * since", about a directory that is sitting right there. So the pair is the
 * unit, and the unit is importable.
 *
 * The broadcast to the windows is deliberately *not* here: it needs
 * `BrowserWindow`, and putting it here would put Electron back on the path this
 * module exists to keep clear of it. `main/index.ts` adds that third line.
 * ================================================================== */

/** Install both halves of a scan, and return what the window half will carry. */
export function adoptPackageScan(report: PackageLoadReport): InstalledPackages {
  const installed = installedFrom(report)
  installPackages(installed)
  // The main-only half of the same report: the manifests above travel to the
  // window, the paths below never leave this process. Both are filled from one
  // scan so that a driver in the registry and the `driver.mjs` a connect forks
  // cannot come from two different readings of the disk.
  installPackageLocations(report.loaded)
  return installed
}
