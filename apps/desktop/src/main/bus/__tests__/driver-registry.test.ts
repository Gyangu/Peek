import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { DRIVER_IDS } from '@peek/core'
import '../../../drivers/__tests__/in-repo-registry'
import { DRIVER_DISPLAYS } from '../../../drivers/__tests__/in-repo-displays'
import {
  driverManifests,
  lookupManifest,
  manifestDriverIds,
} from '../../../drivers/manifests'
import {
  driverRegistry,
  lookupDriver,
  registeredDriverIds,
} from '../../connections/registry'

/**
 * The wiring invariant behind "adding a database is a package plus a few lines".
 *
 * Four lists have to agree and nothing type-checks them into agreement:
 *
 *   `driverManifests()`  the driver packages the loader installed — the
 *                        registry, and the one the other three answer to;
 *   `driverRegistry()`   the main-process spawn table;
 *   `DRIVER_DISPLAYS`    the fixture standing in for what a package host is
 *                        handed, so the suite can ask a package for its own
 *                        three strings (`drivers/__tests__/in-repo-displays.ts`);
 *   `DRIVER_IDS`        the six packages that ship in this repository.
 *
 * **The direction of the first assertion turned around**, and that is the whole
 * change here. `DRIVER_IDS` was a `z.enum` and therefore the *type* of a driver
 * id, so the mistake worth catching was an id added to core with no package
 * behind it. `DriverId` is a string with a shape now (design 2026-08-07 §2.6)
 * and the manifests are the registry, so the question is the other one: does
 * this build still ship exactly the six packages the repository has, or did one
 * stop being collected? A registry compared against itself would answer yes to
 * anything.
 *
 * **The third of them is a fixture, and the second test below says so.** It was
 * production source until this round and the assertion read as a claim about
 * the app; what ships is each package's `contrib.mjs`, so that claim is now
 * `build-packages.mjs`'s. `DRIVER_REGISTRY` is not in that position: it is main's
 * own spawn table, and it was and stays a `Partial<Record<…>>` on purpose (see
 * `PLAN.md` §10 — a driver may be built before it is exposed), so the fourth
 * test below is the only thing that notices a manifest with no row.
 *
 * These tests are cheap and they connect to nothing: every list here is static
 * metadata, read before any process is spawned.
 */
describe('driver registry', () => {
  test('this build collects exactly the packages the repository ships', () => {
    // The one comparison in this file that reaches outside the registry. Both
    // failures it catches are silent: a package dropped from `manifests.ts` is a
    // database that quietly disappears from the picker, and one collected under
    // an id nothing else knows about is a database with no driver-host row.
    //
    // It stops being a useful question when the six move to
    // `~/.peek/packages/` — at that point "which packages exist" is a property
    // of a directory and `DRIVER_IDS` has nothing left to assert.
    assert.deepEqual(
      manifestDriverIds().sort(),
      [...DRIVER_IDS].sort(),
      'The collected manifests and the packages in this repository have drifted apart',
    )
  })

  test('every collected manifest has a display in the fixture the suite names it with', () => {
    // **What this is about changed, and the message with it.** It used to say
    // "or its package host cannot name that driver", and until Phase C that was
    // true: `main/packages/entry.ts` sliced the app's table per package and
    // handed it over. A host `import()`s its own `contrib.mjs` now, so a row
    // missing here costs a shipped connection nothing — the app is byte-for-byte
    // the same — and what it costs is `display-fallback` and `connection-label`
    // silently testing one database fewer than the build ships.
    //
    // The claim it used to make is `build-packages.mjs`'s, and stronger there:
    // it compares each built `contrib.mjs`'s `displays` export against the
    // driver ids in the `peek-package.json` beside it, per package, so a package
    // spreading its displays under the wrong key (`sqlDisplays` writing
    // `postgres` where it meant `mysql` still type-checks, because it collides
    // with a key something declares anyway) fails the build rather than a test.
    assert.deepEqual(
      Object.keys(DRIVER_DISPLAYS).sort(),
      manifestDriverIds().sort(),
      'in-repo-displays.ts and the collected manifests disagree, so some driver is named by no test',
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
      const row = driverRegistry()[driverId]
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
    for (const [key, row] of Object.entries(driverRegistry())) {
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
    const registry = driverRegistry()
    const entryFiles = new Set(registeredDriverIds().map((id) => registry[id]?.entryFile))
    assert.deepEqual([...entryFiles], ['driver-host.js'])
  })

  test('a manifest describes itself: the id it is filed under is the id it claims', () => {
    // `driverManifests()` is an array, so a package returning the wrong driverId
    // would be filed correctly by the map built from it and still be the wrong
    // driver — the connect form for one database assembling a config for another.
    for (const manifest of driverManifests()) {
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
    // No `as DriverId` any more: an id is a string, so an unknown one is
    // writable without asking the compiler to look away.
    assert.equal(lookupDriver('nope'), null)
    assert.equal(lookupManifest('nope'), null)
    assert.equal(lookupDriver('postgres')?.driverId, 'postgres')
  })
})
