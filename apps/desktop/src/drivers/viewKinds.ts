import type { PluginViewKind, ViewKindLookup, ViewKindRegistration } from '@peek/core'
import { graphViewKind } from '@peek/driver-neo4j/view'

/* ==================================================================
 * Every plugin-contributed view kind the app knows about, described without
 * loading a database client.
 *
 * The sibling of `manifests.ts`, and here for the same three reasons — read that
 * file's header first, all of it applies verbatim. The one thing worth repeating
 * is why the subpath matters: `@peek/driver-neo4j` reaches `neo4j-driver`;
 * `@peek/driver-neo4j/view` reaches `@peek/core` and stops. Main calls
 * `autoFetch` from inside a Command reduction (`bus/handlers/shared.ts`), so
 * reaching these through `index.ts` would put a Bolt client in the main-process
 * chunk — and, through the renderer's own registration, in the window chunk too.
 *
 * ## Why this is only half of a view kind
 *
 * A registration here answers what the *kernel* needs: describe, title,
 * autoFetch, collectionRef. It cannot carry the component that draws the view,
 * because that is React and this module is imported by main. The window keeps
 * the other half in `renderer/plugins/`, keyed by the same `kind` string, and a
 * kind present in one and missing from the other is a load-time refusal rather
 * than a blank panel (`registerViewKind`).
 *
 * ## Phase B, and what changes in Phase C
 *
 * This list is static and compiled in, which is exactly what Phase B is for: the
 * five existing databases plus neo4j become "plugins" while still being ordinary
 * imports, so the seam gets exercised before anything is loaded at runtime.
 * Phase C replaces this array with a scan of `~/.peek/plugins/` and changes
 * nothing else — the lookup below is already the only way anyone reaches a
 * registration. See `docs/design/2026-08-03-plugin-architecture.md` §2.1.
 * ================================================================== */

/**
 * Order is not meaningful. Unlike `DRIVER_MANIFESTS` — whose order an MCP client
 * sees in the `list_connections` receipt — nothing serializes this list; every
 * reader goes through `lookupViewKindContract`.
 */
export const VIEW_KIND_CONTRACTS: readonly ViewKindRegistration[] = [graphViewKind]

const BY_KIND: ReadonlyMap<PluginViewKind, ViewKindRegistration> = new Map(
  VIEW_KIND_CONTRACTS.map((entry) => [entry.kind, entry]),
)

/**
 * The registration for a plugin view kind, or null.
 *
 * Null rather than a throw, and every caller has to say what it does with the
 * miss. That is not defensive habit — it is the normal case: a workspace
 * persisted while a plugin was installed can be restored after it was removed,
 * so a `PluginViewState` naming a kind nobody registers is ordinary state.
 * Core's `unregisteredPluginView()` is what that turns into for MCP, and
 * `view.pluginMissing` is what it turns into on screen.
 */
export function lookupViewKindContract(kind: PluginViewKind): ViewKindRegistration | null {
  return BY_KIND.get(kind) ?? null
}

/**
 * The core-shaped lookup, for `describeView` / `viewTitle` in the main process.
 *
 * Core takes this as an argument rather than holding a registry of its own —
 * `core/view-kinds.ts` records why (a cycle, and a module-level mutable registry
 * inside the frozen contract). The renderer has its own identically-shaped
 * export over its own registry; they agree because they are keyed by the same
 * strings and `plugin-view-kinds.test.ts` checks that they do.
 */
export const viewKindLookup: ViewKindLookup = (kind) => lookupViewKindContract(kind)

/** The registered kinds, for diagnostics and for the tests that assert this list is reachable. */
export function registeredViewKindNames(): PluginViewKind[] {
  return VIEW_KIND_CONTRACTS.map((entry) => entry.kind)
}
