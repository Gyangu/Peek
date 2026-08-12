import type { DriverId, PackageViewState, ViewKindLookup, ViewKindRegistration } from '@peek/core'
import { validateViewKindRegistration } from '@peek/core'
import type { ReactElement } from 'react'
import type { PlainMessageKey } from '../i18n'

/* ==================================================================
 * The renderer's half of the view-kind registry.
 *
 * Core holds the *contract* half — `describe`, `title`, `autoFetch`,
 * `collectionRef`, all pure and all English (see `core/view-kinds.ts`). This
 * module holds the half core cannot: the React component that draws the view,
 * and the message key its name is looked up under.
 *
 * The split is the same one `DriverManifest` uses, for the same reason: core has
 * neither React nor a message catalog, and a driver package that imported either
 * would stop being loadable in the driver-host process.
 *
 * ## One entry today, and the other five databases are the control group
 *
 * `graph` (neo4j, Tier C) is the only kind registered. The five databases that
 * came before it register nothing and must keep working exactly as they did —
 * that is what makes this a seam rather than a rewrite. Every call site that
 * used to be a six-way `switch` now has a seventh branch which asks *here*, and
 * an empty registry has to be as correct as a full one.
 * ================================================================== */

/**
 * A view kind, as the window needs it: the kernel contract plus a component.
 *
 * `render` is separate from the core registration rather than folded into it
 * because the two halves arrive from different files in one package (a
 * client-free `manifest.mjs` and a renderer-only `ui.mjs`), and only the second
 * may touch React.
 */
export interface RendererViewKind {
  contract: ViewKindRegistration
  /**
   * The message key for this kind's display name.
   *
   * `PlainMessageKey`, not `string`: `t()` needs a params argument exactly when
   * the message has placeholders, and this key arrives as data. Typing it to the
   * parameterless subset is what lets `panelTitle` call `t(entry.titleKey)` with
   * one argument without a cast — and it means a package naming a key the catalog
   * does not have fails here rather than painting the raw key into the tab strip.
   */
  titleKey: PlainMessageKey
  render(view: PackageViewState): ReactElement
}

const REGISTRY = new Map<string, RendererViewKind>()

export interface RegisterViewKindOutcome {
  ok: boolean
  /** Why it was refused, in English — this goes to the error centre, not to a user's locale. */
  reason?: string
}

/**
 * Register one package view kind, or refuse it and say why.
 *
 * **Refusing is the design.** A package kind cannot have the compile-time
 * exhaustiveness a built-in has, so the check moves to registration time and has
 * to be total: a registration missing `autoFetch` used to become a view that
 * opened and silently never fetched (`handlers/shared.ts`'s old
 * `default: return undefined`), and one missing `titleKey` used to paint the raw
 * message key into the tab strip (`panelTitle.ts`'s template-literal key).
 * Both are now load-time refusals that name the missing field.
 *
 * Returns an outcome rather than throwing: a loader registering several kinds
 * from several packages wants to report all the bad ones, not die on the first.
 */
export function registerViewKind(entry: RendererViewKind): RegisterViewKindOutcome {
  const problem = validateViewKindRegistration(entry.contract)
  if (problem) {
    return { ok: false, reason: `view kind "${problem.kind}" is missing: ${problem.missing.join(', ')}` }
  }
  if (typeof entry.render !== 'function') {
    return { ok: false, reason: `view kind "${entry.contract.kind}" has no render function` }
  }
  const kind = entry.contract.kind
  if (REGISTRY.has(kind)) {
    // Two packages claiming one kind is not resolvable by policy — whichever won
    // would draw the other's data. Refusing the second keeps the first working.
    return { ok: false, reason: `view kind "${kind}" is already registered by another package` }
  }
  REGISTRY.set(kind, entry)
  return { ok: true }
}

/** Drop a kind, e.g. when its package is uninstalled. Views of that kind then render as unavailable. */
export function unregisterViewKind(kind: string): void {
  REGISTRY.delete(kind)
}

export function lookupViewKind(kind: string): RendererViewKind | null {
  return REGISTRY.get(kind) ?? null
}

/**
 * The core-shaped lookup, for `describeView` / `viewTitle`.
 *
 * A function rather than the Map itself, so core keeps depending on a shape it
 * declared rather than on this module.
 */
export const viewKindLookup: ViewKindLookup = (packageKind) => lookupViewKind(packageKind)?.contract ?? null

/** Registered kinds, for diagnostics and for the tests that assert the registry is reachable. */
export function registeredViewKinds(): string[] {
  return [...REGISTRY.keys()]
}

/**
 * The kinds a given driver contributes — what the connection menu offers.
 *
 * Filtered on the registration's declared `driverIds` rather than on
 * capabilities: `graph` needs `tabularQuery` and so does every SQL database, so
 * a capability filter would offer a Neo4j view on a PostgreSQL connection. The
 * capability check still happens, one layer down, where it belongs — `autoFetch`
 * in main refuses to plan a fetch the connection cannot serve.
 *
 * Sorted by kind so the menu does not reorder itself between loads for reasons
 * nobody can see.
 */
export function viewKindsForDriver(driverId: DriverId): RendererViewKind[] {
  return [...REGISTRY.values()]
    .filter((entry) => entry.contract.driverIds.includes(driverId))
    .sort((a, b) => a.contract.kind.localeCompare(b.contract.kind))
}
