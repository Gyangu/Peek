import {
  DRIVER_CAPABILITIES,
  peekError,
  type Capability,
  type ConnectionConfig,
  type Driver,
  type DriverMeta,
  type DriverSession,
  type QdrantConnectionConfig,
} from '@peek/core'
import { QdrantSession } from './session'

/**
 * Qdrant driver factory.
 * `capabilities` has a single source of truth in DRIVER_CAPABILITIES.qdrant:
 * introspect + collectionScan + vectorSearch + valuePeek.
 */
export class QdrantDriver implements Driver<QdrantConnectionConfig> {
  readonly meta: DriverMeta = { id: 'qdrant', displayName: 'Qdrant' }
  readonly capabilities: ReadonlySet<Capability> = new Set(DRIVER_CAPABILITIES.qdrant)

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
  if (cfg.driverId !== 'qdrant') {
    throw peekError(
      'BAD_REQUEST',
      `driver-qdrant received a connection config with driverId=${cfg.driverId}`,
    )
  }
  return cfg
}
