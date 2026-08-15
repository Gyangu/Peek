import type { PackageDisplayEntry } from '@peek/core'
import { qdrantDisplay } from '../display'

/**
 * `entry.contrib` — one display, no view kinds, no tools.
 *
 * `../display` and never `../driver`: see the header of
 * `db-postgres/src/entry/contrib.ts` for the rule and for what checks it.
 */
export const displays: readonly PackageDisplayEntry[] = [{ driverId: 'qdrant', display: qdrantDisplay }]
