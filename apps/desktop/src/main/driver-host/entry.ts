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
 * params. Adding a database is therefore one more entry in this array plus one
 * row in `connections/registry.ts` — the whole of "adding a database is a package
 * plus a line".
 *
 * Note that the drivers are *imported*, never started, by their own packages:
 * a package that self-attached to `parentPort` on import would put a second
 * runtime on the one channel and answer every request twice.
 */
import { startDriverHostProcess } from '@peek/core'
import { postgresDriver } from '@peek/driver-postgres'
import { qdrantDriver } from '@peek/driver-qdrant'
import { redisDriver } from '@peek/driver-redis'
import { sqlDrivers } from '@peek/driver-sql'

startDriverHostProcess({
  // `sqlDrivers` is spread rather than listed member by member: mysql and sqlite
  // are two dialects of one driver package, and which dialects it ships is that
  // package's business, not this file's.
  drivers: [postgresDriver, redisDriver, qdrantDriver, ...sqlDrivers],
})
