import type {
  DriverId,
  InstalledDriver,
  InstalledPackages,
  InstalledTool,
  InstalledViewKind,
} from '@peek/core'

/* ==================================================================
 * What is installed, as data, in whichever process is asking.
 *
 * The successor to the three static arrays that used to sit beside this file.
 * `DRIVER_MANIFESTS`, `VIEW_KIND_CONTRACTS` and `PACKAGE_TOOL_META` were module
 * constants assembled from compile-time imports, which is what Phase B was: a
 * package was a workspace directory the app happened to `import`. A package is
 * now a directory under `~/.peek/packages/`, so the list cannot be a constant —
 * it is not known until something has read the disk.
 *
 * ## Installed once, read synchronously afterwards
 *
 * Every consumer of the old arrays read them synchronously, most of them during
 * a render or inside a Command reduction, and none of them had anywhere to put
 * an `await`. So the shape here is a slot **filled before anything reads it**
 * rather than a promise:
 *
 *   - **main** fills it from `loadPackages()` before `bootstrap()` creates the
 *     window (`main/index.ts`);
 *   - **the window** fills it from the same value, which preload fetched
 *     synchronously over `IPC.PACKAGES_READ`, before React's first render
 *     (`renderer/main.tsx`).
 *
 * The window's copy is *data* and only data — that is design §1.3's hard rule
 * ("the renderer may never execute a package's JS") reduced to a mechanism
 * rather than a habit. A `DriverManifest` has been a JSON value since decision 3
 * turned its last two functions into declarations, so it survives
 * `structuredClone` intact and there is nothing left for a package to smuggle
 * across.
 *
 * ## Empty is a legal state, and it is the loud one
 *
 * Before the install — and in any process that never installs, such as a package
 * host — every lookup here answers "nothing". That is not a fallback: there is
 * no compiled-in list left to fall back *to*, so a build that forgot to install
 * shows an empty connect dialog rather than a plausible one that is a build
 * behind. The loader's report is what says *why* it is empty, and
 * `main/index.ts` puts that on the error centre.
 * ================================================================== */

export type { InstalledDriver, InstalledPackages, InstalledTool, InstalledViewKind }

/**
 * The one index every consumer would otherwise rebuild.
 *
 * Built at install rather than per call: `redactRulesFor` is on the path of
 * every outbound copy of a config and `lookupManifest` is on every render of a
 * connection row. Both used to read a module-level `Map` built at import, and
 * this keeps that cost where it was.
 */
interface Indexed {
  readonly installed: InstalledPackages
  readonly byDriverId: ReadonlyMap<DriverId, InstalledDriver>
}

const EMPTY: Indexed = {
  installed: { drivers: [], viewKinds: [], tools: [] },
  byDriverId: new Map(),
}

let current: Indexed = EMPTY

/**
 * Replace what this process believes is installed.
 *
 * A replacement rather than an accumulation: the loader's report is the whole
 * truth about `~/.peek/packages/` at the moment it ran, and merging it into a
 * previous one would keep a package alive across its own uninstall.
 *
 * Two packages claiming one `driverId` cannot arrive here — `loader.ts` refuses
 * the second, because it is the layer that knows which directory to name. If one
 * ever did, the first wins the index, which is that same rule and not a second
 * opinion about it.
 */
export function installPackages(installed: InstalledPackages): void {
  const byDriverId = new Map<DriverId, InstalledDriver>()
  for (const driver of installed.drivers) {
    if (!byDriverId.has(driver.manifest.driverId)) byDriverId.set(driver.manifest.driverId, driver)
  }
  current = { installed, byDriverId }
}

/** Forget everything installed — for the tests that install a registry of their own. */
export function clearInstalledPackages(): void {
  current = EMPTY
}

/**
 * The whole registry, for the one caller that has to hand it on rather than read
 * it: main's `IPC.PACKAGES_READ` reply.
 *
 * It is the value that was installed, unmodified — the window and main are
 * looking at the same three lists, so a driver the dialog offers is one main can
 * open. Copying or filtering here is what would make them differ.
 */
export function installedPackages(): InstalledPackages {
  return current.installed
}

/** Every installed driver, in the order the loader reported them. */
export function installedDrivers(): readonly InstalledDriver[] {
  return current.installed.drivers
}

/** One driver and its package, or null when nothing installed ships that id. */
export function installedDriver(driverId: DriverId): InstalledDriver | null {
  return current.byDriverId.get(driverId) ?? null
}

/** Every installed view kind's data half. */
export function installedViewKinds(): readonly InstalledViewKind[] {
  return current.installed.viewKinds
}

/** Every installed tool's data half. */
export function installedTools(): readonly InstalledTool[] {
  return current.installed.tools
}

/**
 * The package that ships a driver, or null.
 *
 * Null is an ordinary answer for the same reason `lookupManifest` gives one: a
 * connection persisted while a package was installed can be restored after it
 * was removed, and the caller degrades rather than throwing on the sidebar's
 * behalf.
 *
 * Ownership is "the directory the driver was found in". `drivers/packages.ts`
 * used to state it a second time, compiled in, for the half of the question main
 * asks; Phase C answered both halves off the manifest and deleted it, so there
 * is no longer a table for this to disagree with.
 */
export function packageIdForDriver(driverId: DriverId): string | null {
  return current.byDriverId.get(driverId)?.packageId ?? null
}
