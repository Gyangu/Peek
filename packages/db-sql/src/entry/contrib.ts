import type { PackageDisplayEntry } from '@peek/core'
import { sqlDisplays } from '../display'

/**
 * `entry.contrib` — two displays, no view kinds, no tools.
 *
 * Derived from `sqlDisplays` rather than written out, because that table is
 * already keyed by `DriverId`: restating `'mysql'` and `'sqlite'` here would be
 * a third copy of which databases this package ships, and the one that drifts
 * silently — a wrong key produces a display the host answers `NOT_FOUND` for,
 * which reads as a broken package rather than as a typo.
 *
 * `../display` and never `../driver`: see the header of
 * `db-postgres/src/entry/contrib.ts` for the rule and for what checks it.
 */
export const displays: readonly PackageDisplayEntry[] = Object.entries(sqlDisplays).map(
  ([driverId, display]) => ({ driverId, display }),
)
