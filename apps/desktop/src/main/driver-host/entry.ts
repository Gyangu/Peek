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
 * Note that the drivers are *imported*, never started, by their own packages:
 * a package that self-attached to `parentPort` on import would put a second
 * runtime on the one channel and answer every request twice.
 */
import { startDriverHostProcess } from '@peek/core'
import { neo4jDriver } from '@peek/driver-neo4j'
import { postgresDriver } from '@peek/driver-postgres'
import { qdrantDriver } from '@peek/driver-qdrant'
import { redisDriver } from '@peek/driver-redis'
import { sqlDrivers } from '@peek/driver-sql'

startDriverHostProcess({
  // `sqlDrivers` is spread rather than listed member by member: mysql and sqlite
  // are two dialects of one driver package, and which dialects it ships is that
  // package's business, not this file's.
  drivers: [postgresDriver, redisDriver, qdrantDriver, neo4jDriver, ...sqlDrivers],
})
