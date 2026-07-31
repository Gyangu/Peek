/**
 * The driver host process entry (an Electron utilityProcess entry, PLAN section 3).
 *
 * One connection = one utilityProcess = one data-plane MessagePort: a hung query
 * or a driver crash affects only that connection and leaves the main window
 * untouched, and killing the process is what a forced cancel means.
 *
 * This file deliberately does one thing — load a driver implementation into the
 * host runtime. The control-plane protocol (HostInbound / HostOutbound) and
 * data-plane framing both live in the driver package's host-runtime.ts, which
 * imports no Electron and can therefore be unit-tested without it.
 *
 * Adding a driver (M3 redis / M4 qdrant / M5 mysql·sqlite): there is a single
 * driver-host.js output (see main.rollupOptions.input in electron.vite.config.ts)
 * and the host runtime dispatches on the config.driverId in the `connect` params,
 * so it is enough to import one more driver package here plus one line in
 * connections/registry.ts on the main side.
 */
import { startDriverHost } from '@peek/driver-postgres'

// The driver package self-starts when it detects process.parentPort; calling it
// explicitly here is idempotent and keeps a future tree-shaking pass from
// dropping what would otherwise look like a side-effect-only import.
startDriverHost()
