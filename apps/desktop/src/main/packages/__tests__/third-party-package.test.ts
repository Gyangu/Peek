import assert from 'node:assert/strict'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { clearInstalledPackages, installPackages, packageIdForDriver } from '../../../drivers/installed'
import { connectFormOf, lookupManifest, parseConnectionConfig } from '../../../drivers/manifests'
import { lookupDriver, registeredDriverIds } from '../../connections/registry'
import { PACKAGE_SCHEME, resolvePackageAsset } from '../../packages/assets'
import { installedFrom } from '../installed'
import { loadPackages } from '../loader'

/* ==================================================================
 * The one package in this repository that peek does not build.
 *
 * `fixtures/packages/echo/` is a package tree written by hand: a manifest, a
 * `driver.mjs` that imports nothing, a `contrib.mjs`, and a `ui/`. It is the
 * fixture for acceptance item 11 — a package that came from outside the
 * workspace is dropped into `<configDir>/packages/` and peek uses it without
 * being rebuilt — and it stays in the repository because that check has to be
 * repeatable, not a thing someone did once by hand.
 *
 * ## Why it is not written by `writePackage`
 *
 * `loader.test.ts` synthesizes its fixtures from a manifest literal, which is
 * the right shape for the twelve refusal cases it covers: each one edits one key
 * of a known-good value. What that cannot say is whether a package **someone
 * else wrote** is accepted, because the known-good value is written by the same
 * test that asserts on it — the two drift together. This file's subject is a
 * directory on disk with no generator behind it.
 *
 * ## Why `echo` connects to nothing
 *
 * A fixture that opened a socket would fail for reasons that have nothing to do
 * with the loading path. `driver.mjs` answers two constant rows, and the design's
 * decision 6 (§2.9) is why that is enough: peek does not vet a package, so the
 * only question the loader asks is whether it can *use* one.
 *
 * ## Read *and* used, which is the half that was missing
 *
 * The first two tests below are about the loader alone, and until the startup
 * path called it that was as far as this file could go: `connect` answered
 * `BAD_REQUEST Driver echo is not registered`, because main and the window still
 * built every registry from a compile-time list (§4undecies(b)). The last three
 * are that gap closed — the same report, put through `installedFrom` and
 * `installPackages` exactly as `main/index.ts` does, and then asked the three
 * questions a connection actually asks: is there a manifest, is there a spawn
 * table row, does a config for it parse.
 *
 * They stand in for the app rather than reproducing it: what `main/index.ts`
 * adds around these two calls is a directory to scan and an error centre to
 * report to, neither of which changes what lands in the registry.
 * ================================================================== */

/** The packages root of a peek that has exactly this one third-party package installed. */
const FIXTURE_ROOT = join(import.meta.dirname, '..', '..', '..', '..', 'fixtures', 'packages')
const ECHO_DIR = join(FIXTURE_ROOT, 'echo')

describe('a package written outside this workspace', () => {
  test('loads out of a packages directory, with all three entry points resolved', () => {
    const report = loadPackages(FIXTURE_ROOT)

    assert.deepEqual(report.refused, [])
    assert.deepEqual(
      report.loaded.map((pkg) => pkg.id),
      ['echo'],
    )
    const pkg = report.loaded[0]
    assert.ok(pkg)
    assert.deepEqual(pkg.entry, {
      driver: join(ECHO_DIR, 'driver.mjs'),
      contrib: join(ECHO_DIR, 'contrib.mjs'),
      ui: join(ECHO_DIR, 'ui'),
    })
    assert.deepEqual(
      pkg.manifest.drivers.map((driver) => driver.driverId),
      ['echo'],
    )
    // It declares a `redact` block, so decision 5 has nothing to say about it.
    // A fixture that warned would make the warning tests elsewhere read as noise.
    assert.deepEqual(report.warnings, [])
  })

  test('its interface is served from the directory its manifest names', () => {
    const report = loadPackages(FIXTURE_ROOT)
    const ui = report.loaded[0]?.entry.ui
    assert.ok(ui)

    // Two spellings of one path meeting: the manifest's `entry.ui`, and the root
    // the scheme handler computes from an id alone. The loader refuses a package
    // whose `entry.ui` is anywhere else precisely so that this holds — and a
    // package's interface is the half of it that a user *sees* fail, as a blank
    // frame with nothing in the host's console.
    const asset = resolvePackageAsset(`${PACKAGE_SCHEME}://echo/index.html`, FIXTURE_ROOT)
    assert.deepEqual(asset, { file: join(ui, 'index.html'), mediaType: 'text/html; charset=utf-8' })
  })
})

describe('a third-party package, installed', () => {
  /*
   * `clearInstalledPackages` first, and then a real install: the registry is
   * module state, and a test that measured whatever a previous file had left in
   * it would pass for the wrong reason. `node --test` runs each file in its own
   * process, so the clean slate is cheap and the isolation is real.
   */
  function install(): void {
    clearInstalledPackages()
    installPackages(installedFrom(loadPackages(FIXTURE_ROOT)))
  }

  test('its driver has a manifest, carrying the package’s version rather than none', () => {
    install()
    const manifest = lookupManifest('echo')
    assert.ok(manifest, 'a driver read off disk must be indistinguishable from one peek ships')
    assert.equal(manifest.displayName, 'Echo')
    // `peek-package.json` states one version for the package and none per
    // driver; `installedFrom` is what puts it back, and a driver with no version
    // is one the settings panel cannot tell two installs of apart.
    assert.equal(manifest.version, '0.1.0')
    assert.equal(packageIdForDriver('echo'), 'echo')
  })

  test('it reaches the spawn table, which is what `connect` refused it for', () => {
    install()
    assert.deepEqual(registeredDriverIds(), ['echo'])
    assert.equal(lookupDriver('echo')?.driverId, 'echo')
    // By identity, the same rule `driver-registry.test.ts` holds the in-repo
    // packages to: a row that copied the capabilities could advertise one the
    // package never declared.
    assert.equal(lookupDriver('echo')?.capabilities, lookupManifest('echo')?.capabilities)
  })

  test('a config for it parses against the form its manifest declares', () => {
    install()
    const form = connectFormOf('echo')
    assert.ok(form, 'the connect dialog draws this, and there is no second description of it')
    assert.deepEqual(form.modes, ['fields'])

    // The whole point of acceptance 11 in one assertion: a driverId this build
    // has never heard of is accepted, because the manifest that describes it was
    // read at startup rather than compiled in.
    const config = parseConnectionConfig({ driverId: 'echo', url: 'echo://localhost' }, 'drop')
    assert.deepEqual(config, { driverId: 'echo', url: 'echo://localhost' })

    // And still refused when it does not fit: opening the union did not stop the
    // form being the schema.
    assert.equal(parseConnectionConfig({ driverId: 'echo' }, 'drop'), null)
  })
})
