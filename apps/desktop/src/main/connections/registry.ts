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

/** M1 registers postgres only */
export const DRIVER_REGISTRY: Readonly<Partial<Record<DriverId, DriverRegistration>>> = {
  postgres: {
    driverId: 'postgres',
    displayName: 'PostgreSQL',
    entryFile: 'driver-host.js',
    capabilities: DRIVER_CAPABILITIES.postgres,
  },
  // M3: redis:  { driverId: 'redis',  displayName: 'Redis',  entryFile: 'driver-host.js', capabilities: DRIVER_CAPABILITIES.redis },
  // M4: qdrant: { driverId: 'qdrant', displayName: 'Qdrant', entryFile: 'driver-host.js', capabilities: DRIVER_CAPABILITIES.qdrant },
  // M5: mysql / sqlite follow the same pattern
}

export function lookupDriver(driverId: DriverId): DriverRegistration | null {
  return DRIVER_REGISTRY[driverId] ?? null
}

/** The registered driver ids, for the connection dialog's driver picker. */
export function registeredDriverIds(): DriverId[] {
  return Object.keys(DRIVER_REGISTRY) as DriverId[]
}
