import type { Capability, DriverId } from '@peek/core'
import { DRIVER_MANIFESTS } from '../../drivers/manifests'

/**
 * The driver registry.
 *
 * What a database *is* — its name, what it can do, how it is addressed — is
 * declared by the driver package itself (`@peek/driver-x/manifest`) and reaches
 * every process through `src/drivers/manifests.ts`. What is left here is the one
 * thing only the **main process** cares about: which build output to spawn when
 * a connection opens.
 *
 * There is only **one** driver-host bundle (the `driver-host` entry in
 * electron.vite.config.ts), and that entry dispatches to a concrete Driver by
 * the `config.driverId` in its `connect` params, which is why every entryFile
 * points at the same bundle. If some future driver needs a process entry of its
 * own (a native extension, say), this is the file that grows a branch.
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

/** Every driver ships in the one shared host bundle; see the note above. */
const DRIVER_HOST_ENTRY = 'driver-host.js'

/**
 * Every driver the app can open a connection to.
 *
 * Derived from the manifests rather than hand-written, which is what makes the
 * rows uniform by construction instead of by review — this table used to be five
 * near-identical literals, and the fifth was a copy of the fourth.
 *
 * `displayName` and `capabilities` are carried over **by identity**, not
 * restated: a hand-written capability list here could promise the UI something
 * the driver does not implement, and the divergence would surface as a missing
 * button rather than as an error. `driver-registry.test.ts` asserts the identity
 * rather than the contents, so a copy would fail even if it happened to be
 * correct on the day it was written.
 *
 * Still a `Partial<Record>`: a package may exist before it is exposed to users,
 * and TypeScript will therefore never point out a driver nobody registered —
 * `driver-registry.test.ts` is what does. `PLAN.md` §10 records why that
 * partiality is deliberate rather than an oversight.
 */
export const DRIVER_REGISTRY: Readonly<Partial<Record<DriverId, DriverRegistration>>> =
  Object.fromEntries(
    DRIVER_MANIFESTS.map((m) => [
      m.driverId,
      {
        driverId: m.driverId,
        displayName: m.displayName,
        entryFile: DRIVER_HOST_ENTRY,
        capabilities: m.capabilities,
      } satisfies DriverRegistration,
    ]),
  )

export function lookupDriver(driverId: DriverId): DriverRegistration | null {
  return DRIVER_REGISTRY[driverId] ?? null
}

/** The registered driver ids, for the connection dialog's driver picker. */
export function registeredDriverIds(): DriverId[] {
  return Object.keys(DRIVER_REGISTRY) as DriverId[]
}
