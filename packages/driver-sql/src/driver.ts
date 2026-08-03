import {
  peekError,
  type Capability,
  type ConnectionConfig,
  type Driver,
  type DriverMeta,
  type DriverSession,
  type MysqlConnectionConfig,
  type SqliteConnectionConfig,
} from '@peek/core'
import { mysqlManifest, sqliteManifest } from './manifest'
import { mysqlBackend } from './mysql/backend'
import { MYSQL_DIALECT } from './mysql/dialect'
import { SqlSession } from './session'
import { sqliteBackend } from './sqlite/backend'
import { SQLITE_DIALECT } from './sqlite/dialect'

/**
 * Two drivers, one package.
 *
 * `DriverId` is `'mysql'` and `'sqlite'` — two separate ids, two separate
 * registry entries, two separate connection-config branches — but one
 * implementation behind both. That is the shape core's capability model was
 * betting on: the thing that varies between two SQL databases is a dialect, and a
 * dialect is data, not a package.
 */

export class MysqlDriver implements Driver<MysqlConnectionConfig> {
  readonly meta: DriverMeta = { id: 'mysql', displayName: mysqlManifest.displayName }
  readonly capabilities: ReadonlySet<Capability> = new Set(mysqlManifest.capabilities)

  async connect(cfg: MysqlConnectionConfig, signal?: AbortSignal): Promise<DriverSession> {
    const handle = await mysqlBackend.connect(cfg, signal)
    return new SqlSession({ dialect: MYSQL_DIALECT, handle })
  }
}

export class SqliteDriver implements Driver<SqliteConnectionConfig> {
  readonly meta: DriverMeta = { id: 'sqlite', displayName: sqliteManifest.displayName }
  readonly capabilities: ReadonlySet<Capability> = new Set(sqliteManifest.capabilities)

  async connect(cfg: SqliteConnectionConfig, signal?: AbortSignal): Promise<DriverSession> {
    const handle = await sqliteBackend.connect(cfg, signal)
    return new SqlSession({ dialect: SQLITE_DIALECT, handle })
  }
}

export const mysqlDriver = new MysqlDriver()
export const sqliteDriver = new SqliteDriver()

/** Both drivers of this package, in the order the host registry should list them */
export const sqlDrivers = [mysqlDriver, sqliteDriver] as const

/**
 * Narrow the ConnectionConfig union to its mysql branch. Anything else means the
 * caller routed the connection to the wrong driver — plain English literal, since
 * only a developer will ever read it.
 */
export function requireMysqlConfig(cfg: ConnectionConfig): MysqlConnectionConfig {
  if (cfg.driverId !== 'mysql') {
    throw peekError(
      'BAD_REQUEST',
      `driver-sql received a connection config with driverId=${cfg.driverId}, expected mysql`,
    )
  }
  return cfg
}

export function requireSqliteConfig(cfg: ConnectionConfig): SqliteConnectionConfig {
  if (cfg.driverId !== 'sqlite') {
    throw peekError(
      'BAD_REQUEST',
      `driver-sql received a connection config with driverId=${cfg.driverId}, expected sqlite`,
    )
  }
  return cfg
}
