import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { DRIVER_IDS, type DriverId } from '@peek/core'
import { DRIVER_MANIFESTS, lookupManifest, manifestDriverIds } from '../../../drivers/manifests'
import {
  DRIVER_REGISTRY,
  lookupDriver,
  registeredDriverIds,
} from '../../connections/registry'

/**
 * The wiring invariant behind "adding a database is a package plus a few lines".
 *
 * Three lists have to agree and nothing type-checks them into agreement:
 *
 *   `DRIVER_IDS`        core's closed union — the *type* of a driver id, and so
 *                       the list every switch in `capability.ts` is exhaustive
 *                       over;
 *   `DRIVER_MANIFESTS`  the driver packages the app actually collected;
 *   `DRIVER_REGISTRY`   the main-process spawn table.
 *
 * The registry is derived from the manifests now, so the second and third cannot
 * drift — but the *first* still can, in the one direction that matters: an id can
 * be added to core, compile everywhere, and have no package behind it. Nothing
 * would fail. The connection dialog would list a driver that opens a dialog with
 * no fields, because `DRIVER_REGISTRY` is a `Partial<Record<DriverId, …>>`
 * deliberately (see `PLAN.md` §10 — a driver may be built before it is exposed),
 * and that same partiality means TypeScript will never point out the gap.
 *
 * These tests are what does. They are cheap and they connect to nothing: every
 * list here is static metadata, read before any process is spawned.
 */
describe('driver registry', () => {
  test('every driver id core declares has a package behind it — a new id cannot be silently unreachable', () => {
    // The direction that catches a real mistake: `DRIVER_IDS` is edited in core
    // (it has to be, it is the type), and forgetting the package leaves a driver
    // the user can pick and cannot connect with.
    assert.deepEqual(
      manifestDriverIds().sort(),
      [...DRIVER_IDS].sort(),
      'Every id in DRIVER_IDS needs a manifest, or the connection dialog offers a driver with no form',
    )
  })

  test('every manifest reaches the spawn table', () => {
    assert.deepEqual(
      registeredDriverIds().sort(),
      manifestDriverIds().sort(),
      'A manifest with no registry row is a driver main cannot spawn a host for',
    )
  })

  test('quotes the manifest rather than restating it', () => {
    // A hand-written capability list would let the UI advertise a capability the
    // driver does not implement, and the divergence would surface as a control
    // that never works rather than as an error. Asserting *identity* rather than
    // contents is deliberate: a copy that happens to be correct today still
    // fails here, because being correct today is exactly what a copy is good at.
    for (const driverId of registeredDriverIds()) {
      const row = DRIVER_REGISTRY[driverId]
      const manifest = lookupManifest(driverId)
      assert.ok(row, `${driverId} must be present`)
      assert.ok(manifest, `${driverId} must have a manifest`)
      assert.equal(
        row.capabilities,
        manifest.capabilities,
        `${driverId} must reference its manifest's capabilities by identity, not copy them`,
      )
      assert.equal(
        row.displayName,
        manifest.displayName,
        `${driverId} must take its display name from the package that owns it`,
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

  test('a manifest describes itself: the id it is filed under is the id it claims', () => {
    // `DRIVER_MANIFESTS` is an array, so a package returning the wrong driverId
    // would be filed correctly by the map built from it and still be the wrong
    // driver — the connect form for one database assembling a config for another.
    for (const manifest of DRIVER_MANIFESTS) {
      assert.equal(lookupManifest(manifest.driverId)?.driverId, manifest.driverId)
      assert.ok(
        manifest.capabilities.length > 0,
        `${manifest.driverId} declares no capabilities, so no view could ever be opened on it`,
      )
    }
  })

  test('lookups return null for an unknown id instead of throwing', () => {
    // The id can arrive from a persisted connection written by a future version,
    // so the miss has to be an ordinary value the caller can turn into a
    // structured error.
    assert.equal(lookupDriver('nope' as DriverId), null)
    assert.equal(lookupManifest('nope' as DriverId), null)
    assert.equal(lookupDriver('postgres')?.driverId, 'postgres')
  })
})
