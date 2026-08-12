import {
  isDriverConfig,
  peekError,
  type Capability,
  type ConnectionConfig,
  type Driver,
  type DriverMeta,
  type DriverSession,
  type QdrantConnectionConfig,
} from '@peek/core'
import { qdrantManifest } from './manifest'
import { QdrantSession } from './session'

/**
 * Qdrant driver factory.
 *
 * `meta` and `capabilities` are read off this package's own manifest, which is
 * also what the connect dialog and the MCP tools consult before anything has
 * connected — so what is advertised and what is implemented are one array, not
 * two that agree today.
 */
export class QdrantDriver implements Driver<QdrantConnectionConfig> {
  readonly meta: DriverMeta = { id: 'qdrant', displayName: qdrantManifest.displayName }
  readonly capabilities: ReadonlySet<Capability> = new Set(qdrantManifest.capabilities)

  connect(cfg: QdrantConnectionConfig, signal?: AbortSignal): Promise<DriverSession> {
    return QdrantSession.connect(cfg, signal)
  }
}

export const qdrantDriver = new QdrantDriver()

/**
 * Narrow the ConnectionConfig union to its qdrant branch. Anything else means the
 * caller routed the connection to the wrong driver — plain English literal, since
 * only a developer will ever read it.
 */
export function requireQdrantConfig(cfg: ConnectionConfig): QdrantConnectionConfig {
  if (!isDriverConfig<QdrantConnectionConfig>(cfg, 'qdrant')) {
    throw peekError(
      'BAD_REQUEST',
      `db-qdrant received a connection config with driverId=${cfg.driverId}`,
    )
  }
  return cfg
}
