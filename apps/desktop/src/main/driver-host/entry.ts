/**
 * The driver host process entry (an Electron utilityProcess entry, PLAN section 3).
 *
 * One connection = one utilityProcess = one data-plane MessagePort: a hung query
 * or a driver crash affects only that connection and leaves the main window
 * untouched, and killing the process is what a forced cancel means.
 *
 * This file deliberately does one thing — hand the driver implementations to the
 * host runtime. The control-plane protocol (HostInbound / HostOutbound) and the
 * data-plane framing both live in core's `driver-host.ts`, which imports no
 * Electron and can therefore be unit-tested without it. Everything
 * Electron-specific stops at `process.parentPort`, a MessagePortMain that happens
 * to satisfy core's `HostChannel` structurally.
 *
 * There is a single `driver-host.js` output (see `main.rollupOptions.input` in
 * electron.vite.config.ts) shared by every connection, because the runtime picks
 * a driver out of the list below by the `driverId` carried in the `connect`
 * params.
 *
 * **What adding a database actually costs**, since this comment used to claim it
 * was "a package plus a line" and it was not — it was fifteen edits across three
 * packages, seven of them in the frozen contract. After
 * `docs/design/2026-08-03-driver-package-boundary.md` it is seven, all one-liners:
 * the package (with its `manifest.ts`), `DRIVER_IDS` and a config-schema branch
 * in core, four display switches in `core/capability.ts` that the compiler forces
 * because `DriverId` is a closed union, the row `connections/registry.ts` now
 * derives from the manifest, this array, and two alias lines in
 * electron.vite.config.ts. `connections/registry.ts` is no longer among them:
 * it builds itself from `src/drivers/manifests.ts`.
 *
 * **Six of those seven have since gone** (design 2026-08-07 §2.6, §4quaterdecies):
 * the four display switches left with `DriverDisplay`; `DRIVER_IDS` plus the
 * config-schema branch stopped being edits a new database needs, because
 * `DriverId` is a string with a shape and a driver's config schema is the connect
 * form its own manifest declares; and **this array is gone too** — the drivers
 * are `import()`ed out of `~/.peek/packages/` instead of compiled in, which is
 * Phase C. What is left is the package itself.
 *
 * ## Where the code comes from, and why this file does not decide
 *
 * `PEEK_PACKAGE_ENTRY` is an absolute path to the package's own `driver.mjs`,
 * set by the fork in `connections/host-process.ts` from what `loadPackages`
 * resolved and checked. This process does not derive it, does not search for it,
 * and does not fall back when it is missing — a host that could pick its own code
 * would make the allowlist in `spawn-policy.ts` decorative, and a fallback would
 * turn "the package is gone" into "some other package answered".
 *
 * Note that the drivers are *imported*, never started, by their own packages:
 * a package that self-attached to `parentPort` on import would put a second
 * runtime on the one channel and answer every request twice.
 */
import { pathToFileURL } from 'node:url'
import { startDriverHostProcess, type Driver } from '@peek/core'

/**
 * The one export a `driver.mjs` must have.
 *
 * Checked as a shape and no further: what a `Driver` promises beyond being an
 * object is enforced by core at connect time — `assertSessionHonoursCapabilities`
 * is a better place to catch a driver that lies than a structural check here,
 * because it can say which capability was not implemented. This is only what
 * stops a module with no `drivers` export at all from becoming
 * "`undefined` is not iterable" several frames later.
 */
function driversOf(mod: unknown, entry: string): readonly Driver[] {
  if (typeof mod !== 'object' || mod === null || !('drivers' in mod)) {
    throw new Error(`${entry} does not export 'drivers'`)
  }
  const drivers: unknown = mod.drivers
  if (!Array.isArray(drivers)) throw new Error(`${entry} exports 'drivers', but it is not an array`)
  for (const driver of drivers) {
    if (typeof driver !== 'object' || driver === null) {
      throw new Error(`${entry} exports a 'drivers' entry that is not an object`)
    }
  }
  return drivers
}

async function main(): Promise<void> {
  const entry = process.env['PEEK_PACKAGE_ENTRY']
  if (entry === undefined || entry === '') {
    throw new Error('PEEK_PACKAGE_ENTRY is not set; a driver host must be told which package to load')
  }
  // `pathToFileURL`, not the bare path: an absolute Windows path is not a valid
  // ESM specifier, and a relative-looking one would resolve against this bundle.
  const mod: unknown = await import(pathToFileURL(entry).href)
  startDriverHostProcess({ drivers: driversOf(mod, entry) })
}

main().catch((err: unknown) => {
  // The same answer `packages/entry.ts` gives, and for the same reason: a host
  // that came up with no drivers would answer every connect with "driver not
  // registered", which points at the registry — the one place that is right.
  // Exiting makes it a spawn failure main can name instead. stderr is forwarded
  // by the wrapper.
  console.error(
    `[peek/error] The driver host could not load its package: ${err instanceof Error ? err.message : String(err)}`,
  )
  process.exit(1)
})
