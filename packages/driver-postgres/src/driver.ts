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
 * PostgreSQL 驱动工厂。
 * capabilities 与 DRIVER_CAPABILITIES.postgres 同源：
 * introspect + tabularQuery + collectionScan + valuePeek + cancel。
 */
export class PostgresDriver implements Driver<PostgresConnectionConfig> {
  readonly meta: DriverMeta = { id: 'postgres', displayName: 'PostgreSQL' }
  readonly capabilities: ReadonlySet<Capability> = new Set(DRIVER_CAPABILITIES.postgres)

  connect(cfg: PostgresConnectionConfig, signal?: AbortSignal): Promise<DriverSession> {
    return PostgresSession.connect(cfg, signal)
  }
}

export const postgresDriver = new PostgresDriver()

/** 联合类型的 config 收窄成 postgres 分支；不是 postgres 就是调用方派错了驱动 */
export function requirePostgresConfig(cfg: ConnectionConfig): PostgresConnectionConfig {
  if (cfg.driverId !== 'postgres') {
    throw peekError(
      'BAD_REQUEST',
      `driver-postgres 收到了 driverId=${cfg.driverId} 的连接配置`,
    )
  }
  return cfg
}
