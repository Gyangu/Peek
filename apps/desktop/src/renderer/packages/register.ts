import { createElement } from 'react'
import type { InstalledPackages, PackageViewState } from '@peek/core'
import { installPackages } from '../../drivers/installed'
import { installedViewKindContracts } from '../../drivers/viewKinds'
import { tryBridge } from '../bridge'
import { notify } from '../state/notifyStore'
import { packagesReplaced } from '../state/packagesStore'
import { PackageFrame } from './PackageFrame'
import { PACKAGE_UI } from './uiEntries'
import { lookupViewKind, registerViewKind, registeredViewKinds, unregisterViewKind } from './viewKinds'

/* ==================================================================
 * Attach the window's half to every view-kind contract the app carries.
 *
 * `drivers/viewKinds.ts` holds the half both processes can share — describe,
 * title, autoFetch, collectionRef, all pure. This file adds the two things that
 * are the window's alone: which message key names the kind, and what draws it.
 *
 * ## Compiled-in contracts, gated on what is installed
 *
 * The contracts are still an array in this build (that file's header says why
 * the window is one of the two processes that cannot yet take them off disk),
 * but *which packages are installed* is no longer a build-time fact. So a
 * contract is registered only when a manifest under `~/.peek/packages/` declares
 * its kind. Without that gate, uninstalling neo4j would leave `graph` in the
 * connection menu — an item that opens a view on a database peek can no longer
 * connect to, and nothing else in the window would notice.
 *
 * ## Why the contracts are iterated rather than listed again
 *
 * A second hand-written list is a second thing to forget. Iterating the shared
 * one means a package that contributes a contract and no UI entry is a **loud
 * refusal at startup** rather than a view kind that opens into a blank panel —
 * which is the same trade `registerViewKind` makes for a missing `autoFetch`,
 * and the compensation for the compile-time exhaustiveness a package kind cannot
 * have (`core/view-kinds.ts`).
 *
 * The table itself is `./uiEntries`, which is a separate module for one reason:
 * this one imports `PackageFrame.tsx`, and a module that reaches React cannot be
 * imported by `node:test`. The half worth asserting — does every contract have a
 * window-side entry — is therefore the half that had to stay reachable.
 * ================================================================== */

/**
 * Register every contract, and report the ones that could not be registered.
 *
 * Returns the refusals rather than throwing: one bad package must not stop the
 * others from loading, and the useful report is the whole list. The caller —
 * `main.tsx` — is what decides that a refusal is worth a toast.
 */
export function registerPackageViewKindNames(): string[] {
  const problems: string[] = []
  for (const contract of installedViewKindContracts()) {
    // Idempotent, because `syncPackageViewKindNames` calls this again after every
    // install and only the *new* package's kinds need registering. It costs no
    // loudness: `installedViewKindContracts` filters `VIEW_KIND_CONTRACTS`, which
    // is keyed by kind, so it cannot hand back two contracts under one name — the
    // "already registered by another package" refusal below has never been
    // reachable from here, and a kind already in the registry is therefore always
    // the identical contract from this same list.
    if (lookupViewKind(contract.kind) !== null) continue
    const ui = PACKAGE_UI[contract.kind]
    if (ui === undefined) {
      problems.push(`view kind "${contract.kind}" has a contract but no window-side entry`)
      continue
    }
    const outcome = registerViewKind({
      contract,
      titleKey: ui.titleKey,
      render: (view: PackageViewState) =>
        // `createElement` rather than JSX so this file stays `.ts`: it is
        // imported by nothing that renders, and a `.tsx` here would pull the
        // whole registry into the JSX transform for one call.
        createElement(PackageFrame, { view, packageId: ui.packageId, key: view.id }),
    })
    if (!outcome.ok && outcome.reason !== undefined) problems.push(outcome.reason)
  }
  return problems
}

/**
 * The startup call. Separate from the function above so that tests can register
 * into a clean registry without a toast reaching a store they do not have.
 *
 * It also subscribes to `IPC.PACKAGES_CHANGED`, and that subscription lives here
 * rather than beside the others in `state/sync.ts` for a mechanical reason:
 * adopting a new registry means reconciling the view kinds with it, which
 * reaches `PackageFrame.tsx` — React, which `node --test` cannot load, and
 * `sync.ts` is imported by tests that run there. Same split as `uiEntries.ts`,
 * one module over.
 */
export function startPackages(): void {
  report(registerPackageViewKindNames())

  // The registry this window was handed at load time is not final any more:
  // `packages.install` and `packages.uninstall` replace it while the window is
  // open (design §2.7). Without this the picker would keep offering a database
  // whose package main has already forgotten, and a view of an uninstalled kind
  // would keep drawing an iframe against a directory that is gone.
  tryBridge()?.onPackagesChanged(adoptInstalledPackages)
}

/**
 * Take on a registry main just pushed.
 *
 * The order is the reverse of what reads it, and it is load-bearing: the slot is
 * filled first, then the view kinds are reconciled against it, and the revision
 * moves last — so a component woken by the revision never sees a half-applied
 * change.
 *
 * Exported for the same reason `registerPackageViewKindNames` is: the startup call
 * above is the only production caller.
 */
export function adoptInstalledPackages(installed: InstalledPackages): void {
  installPackages(installed)
  report(syncPackageViewKindNames())
  packagesReplaced()
}

function report(problems: readonly string[]): void {
  for (const problem of problems) {
    // English, and to the error centre: this is a packaging fault in peek's own
    // build, not something a user can act on in their own language.
    notify('error', 'A package view kind could not be registered', problem)
  }
}

/**
 * Bring the registry back in step with what is installed *now*.
 *
 * The uninstall half of design §2.7 step 2, and the install half of step 5, in
 * one function because they are one question: which kinds does the current
 * registry justify. Called after `installPackages` has adopted a registry main
 * pushed over `IPC.PACKAGES_CHANGED` — never on its own, or it would reconcile
 * against a list that is one change behind.
 *
 * **Dropping a kind is what keeps acceptance 13 true.** A view of an
 * unregistered kind draws `view.packageMissing`, naming the kind — an explicit
 * panel a person can act on. Leaving the kind registered would be worse than a
 * blank one: the view would keep drawing an iframe against
 * `peek-package://<id>/`, a URL whose package directory has been deleted, so
 * every subresource 404s and the panel goes quietly white.
 *
 * Registering is delegated rather than repeated: `registerPackageViewKindNames`
 * already skips a kind it has (added for this caller), so a package that arrives
 * beside four that were there costs four lookups and one registration.
 */
export function syncPackageViewKindNames(): string[] {
  const declared = new Set(installedViewKindContracts().map((contract) => contract.kind))
  for (const kind of registeredViewKinds()) {
    if (!declared.has(kind)) unregisterViewKind(kind)
  }
  return registerPackageViewKindNames()
}
