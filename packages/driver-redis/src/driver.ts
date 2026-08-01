import {
  DRIVER_CAPABILITIES,
  peekError,
  type Capability,
  type ConnectionConfig,
  type Driver,
  type DriverMeta,
  type DriverSession,
  type RedisConnectionConfig,
} from '@peek/core'
import { RedisSession } from './session'

/**
 * Redis driver factory.
 * `capabilities` has a single source of truth in DRIVER_CAPABILITIES.redis:
 * introspect + collectionScan + keyValue + valuePeek + cancel.
 */
export class RedisDriver implements Driver<RedisConnectionConfig> {
  readonly meta: DriverMeta = { id: 'redis', displayName: 'Redis' }
  readonly capabilities: ReadonlySet<Capability> = new Set(DRIVER_CAPABILITIES.redis)

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
