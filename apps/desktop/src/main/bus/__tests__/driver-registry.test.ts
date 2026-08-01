import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { DRIVER_CAPABILITIES, type DriverId } from '@peek/core'
import {
  DRIVER_REGISTRY,
  lookupDriver,
  registeredDriverIds,
} from '../../connections/registry'

/**
 * The wiring invariant behind "adding a database is one package plus one line".
 *
 * The registry is the main-process half of that line (the other half is the
 * `drivers` array in driver-host/entry.ts). Nothing else in the app type-checks
 * it into existence: `DRIVER_REGISTRY` is a `Partial<Record<DriverId, …>>`,
 * deliberately, so that a driver can be built before it is exposed to users — and
 * that same partiality means TypeScript will never point out a driver someone
 * forgot to register. These tests are what does.
 *
 * They are cheap and they connect to nothing: the registry is a table of static
 * metadata, consulted before any process is spawned.
 */
describe('driver registry', () => {
  test('registers every driver id core knows about — a new driver cannot be silently unreachable', () => {
    const declared = Object.keys(DRIVER_CAPABILITIES).sort()
    const registered = registeredDriverIds().sort()
    assert.deepEqual(
      registered,
      declared,
      'Every driver in DRIVER_CAPABILITIES must have a row here, or the connection dialog cannot offer it',
    )
  })

  test('quotes core capabilities rather than restating them', () => {
    // A hand-written capability list would let the UI advertise a capability the
    // driver does not implement; core asserts the real driver object against this
    // same table at connect time, so a divergence here surfaces as a connect-time
    // INTERNAL error rather than as a missing button.
    for (const driverId of registeredDriverIds()) {
      const row = DRIVER_REGISTRY[driverId]
      assert.ok(row, `${driverId} must be present`)
      assert.equal(
        row.capabilities,
        DRIVER_CAPABILITIES[driverId],
        `${driverId} must reference DRIVER_CAPABILITIES.${driverId} by identity, not copy it`,
      )
    }
  })

  test('every row is self-consistent: the key is the driverId and the entry file is named', () => {
    for (const [key, row] of Object.entries(DRIVER_REGISTRY)) {
      assert.ok(row)
      assert.equal(row.driverId, key, 'a row filed under the wrong key would spawn the wrong host')
      assert.ok(row.displayName.length > 0, `${key} needs a display name for the driver picker`)
      assert.ok(row.entryFile.endsWith('.js'), `${key} entryFile must name a build output`)
    }
  })

  test('all drivers share the one driver-host bundle', () => {
    // Not an aesthetic preference: the single bundle is why the host runtime
    // dispatches on config.driverId at connect time. If this ever stops holding,
    // the spawn path needs to learn about per-driver entry points.
    const entryFiles = new Set(registeredDriverIds().map((id) => DRIVER_REGISTRY[id]?.entryFile))
    assert.deepEqual([...entryFiles], ['driver-host.js'])
  })

  test('lookupDriver returns null for an unknown id instead of throwing', () => {
    // The id can arrive from a persisted connection written by a future version,
    // so the miss has to be an ordinary value the caller can turn into a
    // structured error.
    assert.equal(lookupDriver('nope' as DriverId), null)
    assert.equal(lookupDriver('postgres')?.driverId, 'postgres')
  })
})
