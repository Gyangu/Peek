import type { PackageViewKindName, ViewKindLookup, ViewKindRegistration } from '@peek/core'
import { graphViewKind } from '@peek/db-neo4j/view'
import { definePackageContribution, type PackageContribution } from './contribution'
import { installedViewKinds } from './installed'

/* ==================================================================
 * Every package-contributed view kind the app knows about, described without
 * loading a database client.
 *
 * The sibling of `manifests.ts`, and here for the same three reasons — read that
 * file's header first, all of it applies verbatim. The one thing worth repeating
 * is why the subpath matters: `@peek/db-neo4j` reaches `neo4j-driver`;
 * `@peek/db-neo4j/view` reaches `@peek/core` and stops. Main calls
 * `autoFetch` from inside a Command reduction (`bus/handlers/shared.ts`), so
 * reaching these through `index.ts` would put a Bolt client in the main-process
 * chunk — and, through the renderer's own registration, in the window chunk too.
 *
 * ## Why this is only half of a view kind
 *
 * A registration here answers what the *kernel* needs: describe, title,
 * autoFetch, collectionRef. It cannot carry the component that draws the view,
 * because that is React and this module is imported by main. The window keeps
 * the other half in `renderer/packages/`, keyed by the same `kind` string, and a
 * kind present in one and missing from the other is a load-time refusal rather
 * than a blank panel (`registerViewKind`).
 *
 * ## Where the two halves are now
 *
 * The **data half** — `kind` / `driverIds` / `title` — is off disk. It is a key
 * of `peek-package.json`, `PackageManifestSchema` checks it as it parses, and
 * `installedViewKinds()` in `drivers/installed.ts` is what a caller reads when
 * the question is "which views can this connection open": answerable from the
 * manifest alone, which is what makes twenty installed packages twenty processes
 * *not* started (§2.4bis(d), acceptance 31). `title` there is the kind's own
 * `LocalizedText` rather than the `titleKey` the registration below declares,
 * because a message key names an entry in the renderer's catalog that a package
 * peek did not build has no way to add to.
 *
 * The **function half** is this array, and it is still compiled in. That is not
 * an oversight and it is not the same debt as the manifests', which have gone:
 * a `ViewKindRegistration` is four functions, and the two processes that read
 * one cannot both be given it from disk in the same step.
 *
 *   - `main/packages/entry.ts` — the *package host*, which is where §2.4bis(d)
 *     says these belong. It slices this array by package id today and
 *     `import()`s `contrib.mjs` in the step marked `PHASE C` there.
 *   - `renderer/packages/register.ts` — the *window*, which may never run a
 *     package's code at all (§1.3) and today does, because `describe(view)` and
 *     `collectionRef(view)` are read synchronously while drawing. Both have to
 *     become data before this import can go, and `PackageViewState.packageText`
 *     is half of that answer already. That is its own step.
 *
 * So the two lists coexist on purpose: the manifest's data half is what anything
 * *asking about* a view kind reads, and this is what the two processes that
 * *run* one still hold.
 * ================================================================== */

/**
 * Order is not meaningful. Unlike `DRIVER_MANIFESTS` — whose order an MCP client
 * sees in the `list_connections` receipt — nothing serializes this list; every
 * reader goes through `lookupViewKindContract`.
 */
export const VIEW_KIND_CONTRACTS: readonly ViewKindRegistration[] = [graphViewKind]

const BY_KIND: ReadonlyMap<PackageViewKindName, ViewKindRegistration> = new Map(
  VIEW_KIND_CONTRACTS.map((entry) => [entry.kind, entry]),
)

/**
 * The registration for a package view kind, or null.
 *
 * Null rather than a throw, and every caller has to say what it does with the
 * miss. That is not defensive habit — it is the normal case: a workspace
 * persisted while a package was installed can be restored after it was removed,
 * so a `PackageViewState` naming a kind nobody registers is ordinary state.
 * Core's `unregisteredPackageView()` is what that turns into for MCP, and
 * `view.packageMissing` is what it turns into on screen.
 */
export function lookupViewKindContract(kind: PackageViewKindName): ViewKindRegistration | null {
  return BY_KIND.get(kind) ?? null
}

/**
 * The core-shaped lookup, for `describeView` / `viewTitle` in the main process.
 *
 * Core takes this as an argument rather than holding a registry of its own —
 * `core/view-kinds.ts` records why (a cycle, and a module-level mutable registry
 * inside the frozen contract). The renderer has its own identically-shaped
 * export over its own registry; they agree because they are keyed by the same
 * strings and `package-view-kinds.test.ts` checks that they do.
 */
export const viewKindLookup: ViewKindLookup = (kind) => lookupViewKindContract(kind)

/**
 * The contracts an installed package declares — what the window may register.
 *
 * The join between the two halves of a view kind: `VIEW_KIND_CONTRACTS` is what
 * this build can *run*, the manifest is what is *installed*, and only a kind on
 * both lists may be offered. A contract with no manifest behind it is what
 * uninstalling neo4j leaves — the package is gone, `graph` cannot connect to
 * anything, and without this filter the connection menu would still offer it.
 *
 * Here rather than in `renderer/packages/register.ts` because that module reaches
 * React and cannot be loaded by `node --test`; the decision is what is worth
 * asserting, so it lives where it can be.
 *
 * The filter itself is not here: it is `definePackageContribution`'s, written
 * once for every kind of thing a package contributes so that the next kind
 * cannot be the one that forgot it (`contribution.ts`). View kinds are the
 * contribution whose compiled-in half is still real — two processes hold four
 * functions each that no manifest can carry — so this is the descriptor where
 * the gate removes something, and the one worth reading first.
 */
export const viewKindContribution: PackageContribution<ViewKindRegistration> = definePackageContribution({
  declaredIn: 'viewKinds',
  what: 'view kind',
  declaredKeys: () => installedViewKinds().map((kind) => kind.kind),
  compiled: () => VIEW_KIND_CONTRACTS,
  keyOf: (contract) => contract.kind,
})

/**
 * The contracts the window may register, as the callers have always asked for
 * them.
 *
 * Kept as a named function rather than folding `viewKindContribution.live()`
 * into its three call sites: the name is what the renderer and its tests read,
 * and the refusals in `register.ts` are commented against it.
 */
export function installedViewKindContracts(): ViewKindRegistration[] {
  return viewKindContribution.live()
}
