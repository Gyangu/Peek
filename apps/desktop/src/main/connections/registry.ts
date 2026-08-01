import { DRIVER_CAPABILITIES, type Capability, type DriverId } from '@peek/core'

/**
 * The driver registry.
 *
 * Adding a driver (redis / qdrant / mysql / sqlite) is one line here. There is
 * only **one** driver-host bundle (the `driver-host` entry in
 * electron.vite.config.ts), and that entry dispatches to a concrete Driver by
 * the `config.driverId` in its `connect` params, which is why every entryFile
 * currently points at the same bundle. If some future driver needs its own
 * process entry (a native extension, say), change that one row's entryFile.
 */
export interface DriverRegistration {
  driverId: DriverId
  displayName: string
  /**
   * The driver host entry file name, relative to main's build output directory
   * (out/main). See electron.vite.config.ts:
   * `'driver-host': src/main/driver-host/entry.ts`.
   */
  entryFile: string
  /** Predicted capabilities **before** connecting; once connected, DriverSession.capabilities is authoritative */
  capabilities: readonly Capability[]
}

/**
 * Every driver the app can open a connection to.
 *
 * `capabilities` is quoted from `DRIVER_CAPABILITIES` rather than restated: core
 * asserts the same table against the live driver object when `connect` runs, so a
 * hand-written list here could promise the UI a capability the driver does not
 * implement and only fail at connect time.
 *
 * The rows are deliberately uniform. All five share one `entryFile` because there
 * is a single driver-host bundle that dispatches on `config.driverId`; if some
 * future driver needs a process of its own (a native extension, say), only that
 * row's `entryFile` changes.
 */
export const DRIVER_REGISTRY: Readonly<Partial<Record<DriverId, DriverRegistration>>> = {
  postgres: {
    driverId: 'postgres',
    displayName: 'PostgreSQL',
    entryFile: 'driver-host.js',
    capabilities: DRIVER_CAPABILITIES.postgres,
  },
  redis: {
    driverId: 'redis',
    displayName: 'Redis',
    entryFile: 'driver-host.js',
    capabilities: DRIVER_CAPABILITIES.redis,
  },
  qdrant: {
    driverId: 'qdrant',
    displayName: 'Qdrant',
    entryFile: 'driver-host.js',
    capabilities: DRIVER_CAPABILITIES.qdrant,
  },
  mysql: {
    driverId: 'mysql',
    displayName: 'MySQL',
    entryFile: 'driver-host.js',
    capabilities: DRIVER_CAPABILITIES.mysql,
  },
  sqlite: {
    driverId: 'sqlite',
    displayName: 'SQLite',
    entryFile: 'driver-host.js',
    capabilities: DRIVER_CAPABILITIES.sqlite,
  },
}

export function lookupDriver(driverId: DriverId): DriverRegistration | null {
  return DRIVER_REGISTRY[driverId] ?? null
}

/** The registered driver ids, for the connection dialog's driver picker. */
export function registeredDriverIds(): DriverId[] {
  return Object.keys(DRIVER_REGISTRY) as DriverId[]
}
