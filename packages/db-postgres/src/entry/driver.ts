import type { Driver } from '@peek/core'
import { postgresDriver } from '../driver'

/**
 * `entry.driver` — what a driver-host process loads for this package.
 *
 * One export, named for the option `startDriverHostProcess` already takes
 * (design 2026-08-07 §2.4). `scripts/build-packages.mjs` bundles this file into
 * a self-contained `driver.mjs` with `pg` inlined, and the host `import()`s it
 * by the path the manifest's `entry.driver` names.
 *
 * **A file rather than a stanza in the build script**, because the question it
 * answers — which databases does this package open — is the package's to answer.
 * A table in the app would be a third copy of it (`driver-host/entry.ts` and
 * `manifest.ts` are the other two), and the app's — `drivers/packages.ts` — is
 * what Phase C deleted.
 *
 * Imported relatively rather than through `@peek/db-postgres`: the index
 * also exports the introspector, the cursor and `startDriverHost`, and a host
 * that loads this file needs the driver.
 */
export const drivers: readonly Driver[] = [postgresDriver]
