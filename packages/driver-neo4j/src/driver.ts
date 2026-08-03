import {
  peekError,
  type Capability,
  type ConnectionConfig,
  type Driver,
  type DriverMeta,
  type DriverSession,
  type Neo4jConnectionConfig,
} from '@peek/core'
import { neo4jManifest } from './manifest'
import { Neo4jSession } from './session'

/**
 * Neo4j driver factory.
 *
 * `meta` and `capabilities` are read off this package's own manifest, which is
 * also what the connect dialog and the MCP tools consult before anything has
 * connected — so what is advertised and what is implemented are one array, not
 * two that agree today.
 */
export class Neo4jDriver implements Driver<Neo4jConnectionConfig> {
  readonly meta: DriverMeta = { id: 'neo4j', displayName: neo4jManifest.displayName }
  readonly capabilities: ReadonlySet<Capability> = new Set(neo4jManifest.capabilities)

  connect(cfg: Neo4jConnectionConfig, signal?: AbortSignal): Promise<DriverSession> {
    return Neo4jSession.connect(cfg, signal)
  }
}

export const neo4jDriver = new Neo4jDriver()

/**
 * Narrow the ConnectionConfig union to its neo4j branch. Anything else means the
 * caller routed the connection to the wrong driver — plain English literal, since
 * only a developer will ever read it.
 */
export function requireNeo4jConfig(cfg: ConnectionConfig): Neo4jConnectionConfig {
  if (cfg.driverId !== 'neo4j') {
    throw peekError(
      'BAD_REQUEST',
      `driver-neo4j received a connection config with driverId=${cfg.driverId}`,
    )
  }
  return cfg
}
