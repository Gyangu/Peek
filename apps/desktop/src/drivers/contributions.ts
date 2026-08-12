import type { InstalledPackages } from '@peek/core'
import type { PackageContributionGate } from './contribution'
import { driverContribution } from './manifests'
import { toolContribution } from './mcpTools'
import { viewKindContribution } from './viewKinds'

/* ==================================================================
 * Every kind of thing a package can contribute, in one list.
 *
 * The three descriptors live beside the tables they gate — a reader who opens
 * `viewKinds.ts` should find the answer for view kinds there, not a pointer to
 * here. What this file adds is the property none of those files can state about
 * itself: **that the list is complete**. `Record<keyof InstalledPackages, …>`
 * means a fourth contribution kind cannot be added to the registry without
 * adding a row here, and `package-contributions.test.ts` walks the rows and
 * makes each one prove its gate — so the fourth kind arrives already asked the
 * question the first three had to be asked one at a time.
 *
 * Which matters because of the direction these fail in. Installing is checked by
 * everything: the new database shows up in the dialog or it does not. The
 * uninstall side has no such witness — the compiled-in half simply stays, and
 * the app keeps offering something that cannot connect to anything. That is the
 * shape acceptance 13 was false in for two rounds.
 *
 * ## Nothing in the app imports this, on purpose
 *
 * Only the guard reads the roster. Wiring a consumer through it would put every
 * descriptor's imports into whichever chunk that consumer lives in — this module
 * reaches `viewKinds.ts` and so `@peek/db-neo4j/view`, which only the two
 * processes that *run* a view kind may hold. The roster is
 * a claim about the app that is checked at build and test time, not a lookup on
 * anyone's path; `contribution.ts` holds the part the descriptors do import, and
 * imports nothing but a type.
 * ================================================================== */

/**
 * The contribution kinds, keyed by the registry list each is declared in.
 *
 * `PackageContributionGate` rather than `PackageContribution<…>` because the
 * values have different `Live` types and a `Record` needs one — see
 * `contribution.ts` for why the untyped half exists at all. Everything the guard
 * asks is about keys, so nothing is lost here.
 */
export const PACKAGE_CONTRIBUTIONS: Readonly<Record<keyof InstalledPackages, PackageContributionGate>> = {
  drivers: driverContribution,
  viewKinds: viewKindContribution,
  tools: toolContribution,
}

/**
 * The `peek-package.json` keys that are *not* a contribution.
 *
 * The roster's completeness is checked against the manifest schema — every key
 * of `PackageManifestSchema` is either a contribution with a row above or is
 * named here — which makes the default **deny**: a key that is neither reports
 * as an unclassified contribution rather than passing as one of the exceptions.
 * An enumeration of contributions alone could not do that, because the way a
 * fourth kind goes missing is by nobody writing it down anywhere.
 *
 * All four are the package describing *itself* rather than describing something
 * it adds to peek: who it is, what it was built against, and where its code
 * starts. None of them can be offered, so none of them can outlive an uninstall.
 */
export const NOT_A_CONTRIBUTION: readonly string[] = ['id', 'version', 'peek', 'entry']
