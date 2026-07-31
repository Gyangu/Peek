import {
  DRIVER_CAPABILITIES,
  peekError,
  type Capability,
  type ConnectionConfig,
  type Driver,
  type DriverMeta,
  type DriverSession,
  type PostgresConnectionConfig,
} from '@peek/core'
import { PostgresSession } from './session'

/**
 * PostgreSQL driver factory.
 * `capabilities` has a single source of truth in DRIVER_CAPABILITIES.postgres:
 * introspect + tabularQuery + collectionScan + valuePeek + cancel.
 */
export class PostgresDriver implements Driver<PostgresConnectionConfig> {
  readonly meta: DriverMeta = { id: 'postgres', displayName: 'PostgreSQL' }
  readonly capabilities: ReadonlySet<Capability> = new Set(DRIVER_CAPABILITIES.postgres)

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
  if (cfg.driverId !== 'postgres') {
    throw peekError(
      'BAD_REQUEST',
      `driver-postgres received a connection config with driverId=${cfg.driverId}`,
    )
  }
  return cfg
}
