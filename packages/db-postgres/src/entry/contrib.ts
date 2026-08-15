import type { PackageDisplayEntry } from '@peek/core'
import { postgresDisplay } from '../display'

/**
 * `entry.contrib` — what this package's own host process loads.
 *
 * The three optional fields of `PackageHostRuntimeOptions`, as named exports, so
 * that the module namespace *is* the options object the runtime takes (design
 * 2026-08-07 §2.4). PostgreSQL contributes one display and nothing else, so
 * `viewKinds` and `tools` are absent rather than empty — the runtime reads a
 * missing key and an empty array identically, and absent is the honest spelling
 * of "this package has none".
 *
 * ## The one rule this file has to keep
 *
 * **No database client may be reachable from here.** The package host is not a
 * driver host: it computes strings and plans fetches, and `pg` arriving in it
 * would be a socket-opening client in a process that never connects to anything.
 * That is why the import is `../display` — a client-free module by construction,
 * guarded at the source by `subpath-purity.test.ts` — and never `../driver` or
 * the package index. `scripts/build-packages.mjs` checks the built artifact for
 * the same property, which is the half that survives someone editing this line.
 *
 * The annotation is what widens `DriverDisplay<PostgresConnectionConfig>` to
 * `DriverDisplay`; it is safe for exactly the reason `PackageHostRuntime`'s
 * `display` case gives — the lookup is keyed by `driverId`, so a display is only
 * ever handed a config carrying its own.
 */
export const displays: readonly PackageDisplayEntry[] = [{ driverId: 'postgres', display: postgresDisplay }]
