import type { Driver } from '@peek/core'
import { neo4jDriver } from '../driver'

/** `entry.driver` — see `db-postgres/src/entry/driver.ts` for why this is a file. */
export const drivers: readonly Driver[] = [neo4jDriver]
