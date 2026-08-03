import {
  peekError,
  type Capability,
  type ConnectionConfig,
  type Driver,
  type DriverMeta,
  type DriverSession,
  type RedisConnectionConfig,
} from '@peek/core'
import { redisManifest } from './manifest'
import { RedisSession } from './session'

/**
 * Redis driver factory.
 *
 * `meta` and `capabilities` are read off this package's own manifest, which is
 * also what the connect dialog and the MCP tools consult before anything has
 * connected — so what is advertised and what is implemented are one array, not
 * two that agree today.
 */
export class RedisDriver implements Driver<RedisConnectionConfig> {
  readonly meta: DriverMeta = { id: 'redis', displayName: redisManifest.displayName }
  readonly capabilities: ReadonlySet<Capability> = new Set(redisManifest.capabilities)

  connect(cfg: RedisConnectionConfig, signal?: AbortSignal): Promise<DriverSession> {
    return RedisSession.connect(cfg, signal)
  }
}

export const redisDriver = new RedisDriver()

/**
 * Narrow the ConnectionConfig union to its redis branch. Anything else means the
 * caller routed the connection to the wrong driver — plain English literal, since
 * only a developer will ever read it.
 */
export function requireRedisConfig(cfg: ConnectionConfig): RedisConnectionConfig {
  if (cfg.driverId !== 'redis') {
    throw peekError(
      'BAD_REQUEST',
      `driver-redis received a connection config with driverId=${cfg.driverId}`,
    )
  }
  return cfg
}
