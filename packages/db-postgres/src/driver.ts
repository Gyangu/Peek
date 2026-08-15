import {
  isDriverConfig,
  peekError,
  type Capability,
  type ConnectionConfig,
  type Driver,
  type DriverMeta,
  type DriverSession,
  type PostgresConnectionConfig,
} from '@peek/core'
import { postgresManifest } from './manifest'
import { PostgresSession } from './session'

/**
 * PostgreSQL driver factory.
 *
 * `meta` and `capabilities` are read off this package's own manifest, which is
 * also what the connect dialog and the MCP tools consult before anything has
 * connected — so what is advertised and what is implemented are one array, not
 * two that agree today.
 */
export class PostgresDriver implements Driver<PostgresConnectionConfig> {
  readonly meta: DriverMeta = { id: 'postgres', displayName: postgresManifest.displayName }
  readonly capabilities: ReadonlySet<Capability> = new Set(postgresManifest.capabilities)

  connect(cfg: PostgresConnectionConfig, signal?: AbortSignal): Promise<DriverSession> {
    return PostgresSession.connect(cfg, signal)
  }
}

export const postgresDriver = new PostgresDriver()

/**
 * Narrow the ConnectionConfig union to its postgres branch. Anything else means
 * the caller routed the connection to the wrong driver — plain English literal,
 * since only a developer will ever read it.
 */
export function requirePostgresConfig(cfg: ConnectionConfig): PostgresConnectionConfig {
  if (!isDriverConfig<PostgresConnectionConfig>(cfg, 'postgres')) {
    throw peekError('BAD_REQUEST', `db-postgres received a connection config with driverId=${cfg.driverId}`)
  }
  return cfg
}
