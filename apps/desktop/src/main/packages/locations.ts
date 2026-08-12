/* ==================================================================
 * Where each installed package's loadable halves are, on disk.
 *
 * The other half of `drivers/installed.ts`, and split from it on one line: that
 * registry is the **IPC payload** — every field of it is `JSON.parse` output
 * that survives `structuredClone`, because the window reads it — and an absolute
 * path into the user's home directory is neither something the window needs nor
 * something it should be handed. So the manifests go there and the paths stay
 * here, in a module main alone imports.
 *
 * ## Why paths at all, rather than `join(packagesRoot, id, 'driver.mjs')`
 *
 * `entry.driver` and `entry.contrib` are *declared* by the manifest — a package
 * may name them anything — and `loader.ts` has already resolved both against the
 * package directory and checked that the files exist. Re-deriving them at fork
 * time would be a second opinion about a question that was answered during the
 * scan, and it would be wrong for the first package that names its entry
 * something other than `driver.mjs`.
 *
 * ## Installed once, read at every fork
 *
 * The same slot shape as `installPackages`, for the same reason: the two
 * consumers (`connections/manager.ts` picking the driver entry for a connection,
 * `packages/registry.ts` picking the contrib entry for a package host) are
 * constructed at module load, long before anything has read the disk. Empty
 * until the scan runs, and empty means "no package by that id" — which both
 * callers turn into a named error rather than a fork of nothing.
 * ================================================================== */

/** The two files of a package a host process may load. `contrib` is null for a package that ships none. */
export interface PackageEntryPaths {
  readonly driver: string
  readonly contrib: string | null
}

/** One installed package, as this registry stores it. `LoadedPackage` satisfies it structurally. */
export interface PackageLocation {
  readonly id: string
  readonly entry: PackageEntryPaths
}

const EMPTY: ReadonlyMap<string, PackageEntryPaths> = new Map()

let current: ReadonlyMap<string, PackageEntryPaths> = EMPTY

/**
 * Record where the packages that survived the scan keep their code.
 *
 * Takes the pairs rather than a `PackageLoadReport` so that this module imports
 * nothing: the loader's report is *one* thing that can produce them, and a test
 * that only needs two paths should not have to build a manifest to say so.
 */
export function installPackageLocations(locations: Iterable<PackageLocation>): void {
  current = new Map([...locations].map((location) => [location.id, location.entry]))
}

export function packageEntryPaths(packageId: string): PackageEntryPaths | null {
  return current.get(packageId) ?? null
}

/** Forget every location — for the tests that install a scan of their own. */
export function clearPackageLocations(): void {
  current = EMPTY
}
