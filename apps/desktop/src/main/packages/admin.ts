import { peekError } from '@peek/core'
import type { PackageAdminService } from '../bus/deps'
import type { PackageCommandOptions } from './commands'
import { uninstallPackage } from './manage'

/* ==================================================================
 * The disk half of an uninstall, as the bus's effect phase reaches it.
 *
 * A module of its own rather than a closure in `main/index.ts` for the reason
 * `manage.ts` is one: the order below *is* the behaviour, and a file that
 * imports `electron` cannot be reached by `node --test`, so the assertions
 * would have had to be written against a copy of it — which is a test that
 * agrees with itself.
 * ================================================================== */

/**
 * Kill the host, take the directory away, then bring everyone level with it.
 *
 * The host is killed **before** the directory goes, and that order is the whole
 * of §2.4bis(f): a package host is a process, so killing it is what makes "the
 * package's code is no longer running" a fact about the operating system rather
 * than a claim about an ESM cache. Removing the files first would leave a
 * process holding an already-imported `contrib.mjs` and answering calls out of
 * a package that no longer exists.
 *
 * The install path takes the same rule from the other side — `installPackage`'s
 * `evict` is awaited before the directory is replaced — so "the package's code
 * is no longer running" is a fact about every path that moves those files, not
 * only about the one that deletes them.
 *
 * `disposeHost` arrives as an argument instead of this module reaching for the
 * `PackageHostRegistry` because that registry forks Electron utility processes,
 * and the ordering above is worth more than the one import it would save. Main
 * hands it `packageHosts.dispose`.
 */
export function createPackageAdmin(
  options: PackageCommandOptions,
  disposeHost: (packageId: string) => Promise<void>,
): PackageAdminService {
  return {
    async uninstall({ packageId, version }) {
      await disposeHost(packageId)
      const outcome = uninstallPackage({
        id: packageId,
        packagesRoot: options.packagesRoot,
        catalog: options.catalog,
        version,
      })
      // Thrown rather than reported: `runIntents` collapses it into the command's
      // failure, which is the only honest receipt for "the directory is still
      // there". The connections this command closed stay closed.
      if (!outcome.ok) throw peekError('INTERNAL', outcome.issue)

      options.adopt(options.scan())

      // After `adopt`, for the reason the install path in `commands.ts` gives:
      // a client that re-lists on hearing this must be answered from the
      // registry the uninstall left behind, not the one that still has it.
      options.toolsChanged()
    },
  }
}
