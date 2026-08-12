import type { Driver } from '@peek/core'
import { sqlDrivers } from '../driver'

/**
 * `entry.driver` — two databases, one implementation.
 *
 * `sqlDrivers` is spread by name rather than listed member by member for the
 * same reason `driver-host/entry.ts` spreads it: which dialects this package
 * ships is this package's business, and naming them here would be a second
 * place to forget one.
 */
export const drivers: readonly Driver[] = sqlDrivers
