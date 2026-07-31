import { DRIVER_CAPABILITIES, type Capability, type DriverId } from '@peek/core'

/**
 * 驱动注册表。
 *
 * 加一个新驱动（redis / qdrant / mysql / sqlite）在这里加一行即可：
 * driver host 的**打包产物只有一个**（electron.vite.config.ts 里的 `driver-host` 入口），
 * 该入口按 `connect` 参数里的 `config.driverId` 自行分发到具体 Driver 实现，
 * 所以 entryFile 目前全部指向同一个 bundle。
 * 将来某个驱动需要独立进程入口（比如带原生扩展），改它自己那行的 entryFile 即可。
 */
export interface DriverRegistration {
  driverId: DriverId
  displayName: string
  /**
   * driver host 入口文件名，相对于 main 的构建输出目录（out/main）。
   * 见 electron.vite.config.ts：`'driver-host': src/main/driver-host/entry.ts`。
   */
  entryFile: string
  /** 连接**之前**的能力预判；连上之后一律以 DriverSession.capabilities 为准 */
  capabilities: readonly Capability[]
}

/** M1 只注册 postgres */
export const DRIVER_REGISTRY: Readonly<Partial<Record<DriverId, DriverRegistration>>> = {
  postgres: {
    driverId: 'postgres',
    displayName: 'PostgreSQL',
    entryFile: 'driver-host.js',
    capabilities: DRIVER_CAPABILITIES.postgres,
  },
  // M3: redis:  { driverId: 'redis',  displayName: 'Redis',  entryFile: 'driver-host.js', capabilities: DRIVER_CAPABILITIES.redis },
  // M4: qdrant: { driverId: 'qdrant', displayName: 'Qdrant', entryFile: 'driver-host.js', capabilities: DRIVER_CAPABILITIES.qdrant },
  // M5: mysql / sqlite 同理
}

export function lookupDriver(driverId: DriverId): DriverRegistration | null {
  return DRIVER_REGISTRY[driverId] ?? null
}

/** 已注册的驱动 id 列表，供 UI 的连接配置界面列选项 */
export function registeredDriverIds(): DriverId[] {
  return Object.keys(DRIVER_REGISTRY) as DriverId[]
}
