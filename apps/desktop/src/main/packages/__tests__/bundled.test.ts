import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { loadPackages } from '../loader'
import {
  BUNDLED_PACKAGES_DIR_NAME,
  bundledPackagesRoot,
  clearTombstones,
  compareVersions,
  layOutBundledPackages,
  readTombstones,
  writeTombstone,
  STAGING_PREFIX,
  type BundledOutcome,
  type BundledPackageStatus,
} from '../bundled'

/* ==================================================================
 * Acceptance items 14 and 15 (design 2026-08-07 §4.3), which are the two halves
 * of decision 1: a bundled package is a package.
 *
 * Both are about what happens on the *second* start, so neither shows up in
 * ordinary use and both fail silently:
 *
 *   - no tombstone, and uninstalling PostgreSQL undoes itself at the next
 *     launch. The button still animates.
 *   - overwrite-on-upgrade, and a user who installed a newer build themselves
 *     is pushed back to the shipped one. The version number in settings then
 *     names a build that is not running, which is the state §2.5 calls the worst
 *     available failure — it disqualifies the one clue.
 *
 * So the assertions below are mostly about what did **not** happen: bytes still
 * on disk, a directory still absent.
 * ================================================================== */

const tempDirs: string[] = []

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

function tempRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

/** A manifest the schema accepts, since anything less reads as "no version at all". */
function manifest(id: string, version: string, driverId: string = id): string {
  return JSON.stringify(
    {
      id,
      version,
      peek: '^0.1',
      entry: { driver: 'driver.mjs' },
      drivers: [
        {
          driverId,
          displayName: id,
          capabilities: ['introspect'],
          connectForm: {
            modes: ['url'],
            fields: { url: [{ name: 'url', type: 'text', label: { en: 'URL' }, required: true }] },
          },
          redact: { url: 'url-password' },
          identity: ['url'],
          mcpConnectExample: `{"driverId":"${id}"}`,
        },
      ],
    },
    null,
    2,
  )
}

interface Fixture {
  version?: string
  /** Extra files, path → contents. Used to prove a copy did or did not happen. */
  extra?: Readonly<Record<string, string>>
  /** Bytes for `peek-package.json`, when the point is that they are not a manifest. */
  raw?: string
  /** The driver it provides, when the point is that two packages claim one. Defaults to the id. */
  driverId?: string
}

function writePackage(root: string, id: string, fixture: Fixture = {}): string {
  const dir = join(root, id)
  mkdirSync(join(dir, 'ui'), { recursive: true })
  writeFileSync(join(dir, 'driver.mjs'), '')
  writeFileSync(join(dir, 'ui', 'index.html'), '')
  writeFileSync(
    join(dir, 'peek-package.json'),
    fixture.raw ?? manifest(id, fixture.version ?? '0.0.1', fixture.driverId),
  )
  for (const [name, body] of Object.entries(fixture.extra ?? {})) writeFileSync(join(dir, name), body)
  return dir
}

/** One package's status, having asserted it was accounted for at all. */
function statusOf(statuses: readonly BundledPackageStatus[], id: string): BundledPackageStatus {
  const status = statuses.find((entry) => entry.id === id)
  assert.ok(status, `'${id}' is missing from the report; got ${statuses.map((s) => s.id).join(', ')}`)
  return status
}

function assertOutcome(statuses: readonly BundledPackageStatus[], id: string, outcome: BundledOutcome): void {
  const status = statusOf(statuses, id)
  assert.equal(status.outcome, outcome, `${id}: ${status.detail ?? 'no detail'}`)
}

/* ------------------------------------------------------------------ */

describe('rule 1 — absent and not tombstoned', () => {
  test('is laid out, whole', () => {
    const bundled = tempRoot('peek-bundled-')
    const packages = tempRoot('peek-packages-')
    writePackage(bundled, 'neo4j', { extra: { 'contrib.mjs': 'contrib' } })

    const { statuses } = layOutBundledPackages({ bundledRoot: bundled, packagesRoot: packages })

    assertOutcome(statuses, 'neo4j', 'laid-out')
    // Every file, not just the manifest: a copy that stopped after
    // `peek-package.json` loads fine and fails at the first connection.
    for (const rel of ['peek-package.json', 'driver.mjs', 'contrib.mjs', join('ui', 'index.html')]) {
      assert.ok(existsSync(join(packages, 'neo4j', rel)), `${rel} did not arrive`)
    }
  })

  test('creates the packages directory when there is not one yet', () => {
    const bundled = tempRoot('peek-bundled-')
    const packages = join(tempRoot('peek-config-'), 'packages')
    writePackage(bundled, 'redis')

    layOutBundledPackages({ bundledRoot: bundled, packagesRoot: packages })

    assert.ok(existsSync(join(packages, 'redis', 'peek-package.json')))
  })

  test('leaves no staging directory behind', () => {
    const bundled = tempRoot('peek-bundled-')
    const packages = tempRoot('peek-packages-')
    writePackage(bundled, 'qdrant')

    layOutBundledPackages({ bundledRoot: bundled, packagesRoot: packages })

    // The staged name is what a killed copy leaves; a successful one renames it
    // away, and anything still wearing it would be scanned as litter forever.
    assert.deepEqual(
      readdirSync(packages).filter((name) => name.startsWith('.installing-')),
      [],
    )
  })
})

describe('rule 2 — something is already installed', () => {
  test('an older shipped copy is kept out, and reported as nothing to do', () => {
    const bundled = tempRoot('peek-bundled-')
    const packages = tempRoot('peek-packages-')
    writePackage(bundled, 'postgres', { version: '0.0.1' })
    writePackage(packages, 'postgres', { version: '0.9.0', extra: { 'mine.txt': 'the build I installed' } })

    const { statuses } = layOutBundledPackages({ bundledRoot: bundled, packagesRoot: packages })

    assertOutcome(statuses, 'postgres', 'kept')
    assert.equal(statusOf(statuses, 'postgres').installedVersion, '0.9.0')
    assert.equal(readFileSync(join(packages, 'postgres', 'mine.txt'), 'utf8'), 'the build I installed')
  })

  test('a newer shipped copy is offered, not taken', () => {
    const bundled = tempRoot('peek-bundled-')
    const packages = tempRoot('peek-packages-')
    writePackage(bundled, 'postgres', { version: '1.0.0' })
    writePackage(packages, 'postgres', { version: '0.9.0', extra: { 'mine.txt': 'still here' } })

    const { statuses } = layOutBundledPackages({ bundledRoot: bundled, packagesRoot: packages })

    // The upgrade is a click in settings (§2.8). Doing it here is the failure
    // this whole rule exists to prevent, so the bytes are the assertion.
    assertOutcome(statuses, 'postgres', 'upgradable')
    assert.equal(readFileSync(join(packages, 'postgres', 'mine.txt'), 'utf8'), 'still here')
    const status = statusOf(statuses, 'postgres')
    assert.equal(status.bundledVersion, '1.0.0')
    assert.equal(status.installedVersion, '0.9.0')
  })

  test('the same version is not an upgrade', () => {
    const bundled = tempRoot('peek-bundled-')
    const packages = tempRoot('peek-packages-')
    writePackage(bundled, 'sql', { version: '0.0.1' })
    writePackage(packages, 'sql', { version: '0.0.1' })

    assertOutcome(
      layOutBundledPackages({ bundledRoot: bundled, packagesRoot: packages }).statuses,
      'sql',
      'kept',
    )
  })

  test('an installed directory with no readable manifest is compared with nothing, and left alone', () => {
    const bundled = tempRoot('peek-bundled-')
    const packages = tempRoot('peek-packages-')
    writePackage(bundled, 'neo4j', { version: '1.0.0' })
    writePackage(packages, 'neo4j', { raw: '{ this is not json', extra: { 'mine.txt': 'untouched' } })

    const { statuses } = layOutBundledPackages({ bundledRoot: bundled, packagesRoot: packages })

    // Not `upgradable`: peek has no version to outrank, and saying it has one
    // would put a number in front of the user for a package that never loads.
    assertOutcome(statuses, 'neo4j', 'unreadable')
    assert.equal(statusOf(statuses, 'neo4j').installedVersion, null)
    assert.equal(readFileSync(join(packages, 'neo4j', 'mine.txt'), 'utf8'), 'untouched')
  })

  test('a version peek reads is one it read off a manifest, not off any JSON with that key', () => {
    const bundled = tempRoot('peek-bundled-')
    const packages = tempRoot('peek-packages-')
    writePackage(bundled, 'neo4j', { version: '1.0.0' })
    // Parses, carries a version, is not a manifest. Trusting the key would have
    // peek report `9.9.9` as installed for a directory the loader refuses — a
    // number in settings for something that never loads, and no upgrade offered
    // because the fiction outranks the shipped copy.
    writePackage(packages, 'neo4j', { raw: JSON.stringify({ version: '9.9.9' }) })

    const { statuses } = layOutBundledPackages({ bundledRoot: bundled, packagesRoot: packages })

    assertOutcome(statuses, 'neo4j', 'unreadable')
    assert.equal(statusOf(statuses, 'neo4j').installedVersion, null)
  })
})

describe('rule 3 — tombstones', () => {
  test('an uninstalled bundled package does not come back', () => {
    const bundled = tempRoot('peek-bundled-')
    const packages = tempRoot('peek-packages-')
    writePackage(bundled, 'postgres')
    writeTombstone(packages, 'postgres', '0.0.1')

    const { statuses } = layOutBundledPackages({ bundledRoot: bundled, packagesRoot: packages })

    assertOutcome(statuses, 'postgres', 'suppressed')
    assert.equal(existsSync(join(packages, 'postgres')), false, 'the uninstall would be theatre')
  })

  test('it suppresses nothing else', () => {
    const bundled = tempRoot('peek-bundled-')
    const packages = tempRoot('peek-packages-')
    writePackage(bundled, 'postgres')
    writePackage(bundled, 'redis')
    writeTombstone(packages, 'postgres', '0.0.1')

    const { statuses } = layOutBundledPackages({ bundledRoot: bundled, packagesRoot: packages })

    assertOutcome(statuses, 'redis', 'laid-out')
    assert.ok(existsSync(join(packages, 'redis')))
  })

  test('it does not reach a package the user installed under the same id afterwards', () => {
    const bundled = tempRoot('peek-bundled-')
    const packages = tempRoot('peek-packages-')
    writePackage(bundled, 'postgres', { version: '0.0.1' })
    writeTombstone(packages, 'postgres', '0.0.1')
    writePackage(packages, 'postgres', { version: '2.0.0', extra: { 'mine.txt': 'installed by hand' } })

    const { statuses } = layOutBundledPackages({ bundledRoot: bundled, packagesRoot: packages })

    // A tombstone records a decision about the *shipped* copy. Reading it as a
    // decision about the id would delete a package the user went and got.
    assertOutcome(statuses, 'postgres', 'kept')
    assert.equal(readFileSync(join(packages, 'postgres', 'mine.txt'), 'utf8'), 'installed by hand')
  })

  test('restoring clears them, and the next start lays the package out again', () => {
    const bundled = tempRoot('peek-bundled-')
    const packages = tempRoot('peek-packages-')
    writePackage(bundled, 'postgres')
    writeTombstone(packages, 'postgres', '0.0.1')
    layOutBundledPackages({ bundledRoot: bundled, packagesRoot: packages })

    clearTombstones(packages)
    const { statuses } = layOutBundledPackages({ bundledRoot: bundled, packagesRoot: packages })

    assert.deepEqual(readTombstones(packages), [])
    assertOutcome(statuses, 'postgres', 'laid-out')
    assert.ok(existsSync(join(packages, 'postgres', 'peek-package.json')))
  })

  test('uninstalling the same id twice records the later removal, not both', () => {
    const packages = tempRoot('peek-packages-')
    writeTombstone(packages, 'postgres', '0.0.1')
    writeTombstone(packages, 'redis', '0.0.1')
    writeTombstone(packages, 'postgres', '2.0.0')

    const stones = readTombstones(packages)
    assert.deepEqual(stones.map((stone) => `${stone.id}@${stone.version}`).sort(), [
      'postgres@2.0.0',
      'redis@0.0.1',
    ])
    assert.ok(
      stones.every((stone) => !Number.isNaN(Date.parse(stone.at))),
      'at has to be a timestamp',
    )
  })

  test('a tombstone file peek cannot parse restores everything rather than hiding it', () => {
    const bundled = tempRoot('peek-bundled-')
    const packages = tempRoot('peek-packages-')
    writePackage(bundled, 'postgres')
    mkdirSync(packages, { recursive: true })
    writeFileSync(join(packages, '.uninstalled.json'), '{ "uninstalled": "everything" }')

    const { statuses } = layOutBundledPackages({ bundledRoot: bundled, packagesRoot: packages })

    // The other direction would make one bad byte silently remove a database
    // with no route back that does not involve editing JSON.
    assertOutcome(statuses, 'postgres', 'laid-out')
  })
})

describe('what it refuses to guess', () => {
  test('a shipped package with no readable manifest fails loudly and installs nothing', () => {
    const bundled = tempRoot('peek-bundled-')
    const packages = tempRoot('peek-packages-')
    writePackage(bundled, 'broken', { raw: 'not json at all' })

    const { statuses } = layOutBundledPackages({ bundledRoot: bundled, packagesRoot: packages })

    assertOutcome(statuses, 'broken', 'failed')
    assert.equal(existsSync(join(packages, 'broken')), false)
  })

  test('one bad shipped package does not cost the others', () => {
    const bundled = tempRoot('peek-bundled-')
    const packages = tempRoot('peek-packages-')
    writePackage(bundled, 'broken', { raw: 'not json at all' })
    writePackage(bundled, 'redis')

    const { statuses } = layOutBundledPackages({ bundledRoot: bundled, packagesRoot: packages })

    assertOutcome(statuses, 'redis', 'laid-out')
    assert.equal(statuses.length, 2, 'every shipped id is accounted for')
  })

  test('a shipped copy whose driver an installed package already claims is refused, not copied', () => {
    const bundled = tempRoot('peek-bundled-')
    const packages = tempRoot('peek-packages-')
    writePackage(bundled, 'postgres')
    // The user's own package, under a name of its own, providing the driver the
    // shipped `postgres` provides. Rule 1 asks whether the *id* is absent, and
    // absent is not the same as free.
    writePackage(packages, 'my-postgres', { driverId: 'postgres' })

    const { statuses } = layOutBundledPackages({ bundledRoot: bundled, packagesRoot: packages })

    assertOutcome(statuses, 'postgres', 'failed')
    assert.match(statusOf(statuses, 'postgres').detail ?? '', /already provided by the package 'my-postgres'/)
    // The copy is what would make this silent: the directory would sit there,
    // be refused by every scan for the rest of the install's life, and — through
    // `packages.restore` — be reported as restored on the way in.
    assert.equal(existsSync(join(packages, 'postgres')), false)
    // And the package that was there first is still the one that answers.
    assert.deepEqual(
      loadPackages(packages).loaded.map((pkg) => pkg.id),
      ['my-postgres'],
    )
  })

  test('no bundled directory at all is an empty report, not a boot failure', () => {
    const packages = tempRoot('peek-packages-')
    const report = layOutBundledPackages({
      bundledRoot: join(tempRoot('peek-bundled-'), 'never-built'),
      packagesRoot: packages,
    })
    assert.deepEqual(report.statuses, [])
  })
})

describe('litter from an interrupted copy', () => {
  test('wears a name the scan does not see', () => {
    // The whole reason a copy goes through a staging name: what a killed run
    // leaves is *some of* a package, and reporting that as a broken install
    // would send the user looking at a directory they never made. Pinned across
    // both modules rather than inside either, because it is an agreement between
    // them — the loader's dot-prefix filter and this prefix are one decision.
    const packages = tempRoot('peek-packages-')
    mkdirSync(join(packages, `${STAGING_PREFIX}neo4j`), { recursive: true })
    writeFileSync(join(packages, `${STAGING_PREFIX}neo4j`, 'peek-package.json'), 'half a package')

    const report = loadPackages(packages)

    assert.deepEqual(report.loaded, [])
    assert.deepEqual(report.refused, [])
  })

  test('does not blend into the package it is a fragment of', () => {
    const bundled = tempRoot('peek-bundled-')
    const packages = tempRoot('peek-packages-')
    writePackage(bundled, 'neo4j')
    // `cpSync` *merges* into an existing directory, so a fragment left by a
    // killed run would contribute files to the next attempt and the result
    // would be two builds mixed into one that behaves like neither.
    mkdirSync(join(packages, `${STAGING_PREFIX}neo4j`), { recursive: true })
    writeFileSync(join(packages, `${STAGING_PREFIX}neo4j`, 'stale.mjs'), 'from a killed run')

    layOutBundledPackages({ bundledRoot: bundled, packagesRoot: packages })

    assert.equal(existsSync(join(packages, 'neo4j', 'stale.mjs')), false)
  })

  test('is swept even when this run has no reason to touch that package', () => {
    const bundled = tempRoot('peek-bundled-')
    const packages = tempRoot('peek-packages-')
    writePackage(bundled, 'neo4j')
    writePackage(packages, 'neo4j')
    // The id is already installed, so nothing copies it this run and the
    // fragment has no other route out. Left alone it stays in the packages
    // directory for the life of the install.
    mkdirSync(join(packages, `${STAGING_PREFIX}neo4j`), { recursive: true })

    layOutBundledPackages({ bundledRoot: bundled, packagesRoot: packages })

    assert.deepEqual(
      readdirSync(packages).filter((name) => name.startsWith(STAGING_PREFIX)),
      [],
    )
  })

  test('a lay-out that fails leaves none of itself behind', () => {
    const bundled = tempRoot('peek-bundled-')
    const packages = tempRoot('peek-packages-')
    writePackage(bundled, 'neo4j')
    // A *file* where the package directory would go. It is not a directory, so
    // this is the "nothing installed" branch, and the publish then fails —
    // which is the only way to reach the failure path without killing the
    // process mid-copy. What must not survive it is the staged copy: left
    // behind, it is a fragment that every later start sweeps and re-makes.
    writeFileSync(join(packages, 'neo4j'), 'not a package directory')

    const { statuses } = layOutBundledPackages({ bundledRoot: bundled, packagesRoot: packages })

    assertOutcome(statuses, 'neo4j', 'failed')
    assert.deepEqual(
      readdirSync(packages).filter((name) => name.startsWith(STAGING_PREFIX)),
      [],
    )
  })
})

describe('where the shipped copies are', () => {
  test('development reads them beside the main bundle', () => {
    // `out/main` and `out/packages` are siblings, and the whole `out/` tree is
    // copied as one, so the relative step is the same rule `PackageHostRegistry`
    // uses to find `package-host.js`.
    assert.equal(bundledPackagesRoot(join('/repo', 'out', 'main'), null), join('/repo', 'out', 'packages'))
  })

  test('a packaged app reads them out of Resources', () => {
    assert.equal(
      bundledPackagesRoot('/anywhere', join('/peek.app', 'Contents', 'Resources')),
      join('/peek.app', 'Contents', 'Resources', BUNDLED_PACKAGES_DIR_NAME),
    )
  })

  test('and the packaging script puts them under that exact name', () => {
    // Two spellings of one directory, in two files that cannot import each
    // other (`package-mac.mjs` runs under plain node; this module reaches
    // `@peek/core`). Renaming one alone ships an app whose bundled root is
    // empty — which looks exactly like a legitimate first run, so nothing else
    // would report it.
    const script = readFileSync(
      join(import.meta.dirname, '..', '..', '..', '..', 'scripts', 'package-mac.mjs'),
      'utf8',
    )
    assert.ok(
      script.includes(`const BUNDLED_PACKAGES_DIR_NAME = '${BUNDLED_PACKAGES_DIR_NAME}'`),
      `scripts/package-mac.mjs does not declare BUNDLED_PACKAGES_DIR_NAME = '${BUNDLED_PACKAGES_DIR_NAME}'`,
    )
  })
})

describe('comparing two package versions', () => {
  test('orders the first three segments', () => {
    assert.equal(compareVersions('1.0.0', '0.9.9'), 1)
    assert.equal(compareVersions('0.2.0', '0.10.0'), -1, 'segments are numbers, not text')
    assert.equal(compareVersions('0.0.2', '0.0.10'), -1)
    assert.equal(compareVersions('1.2.3', '1.2.3'), 0)
  })

  test('reads nothing after them', () => {
    // §2.5 fixes this: a full semver ordering would be the only code here with
    // no consumer. The consequence is stated rather than hidden — peek does not
    // offer to replace a pre-release with the release it came from.
    assert.equal(compareVersions('1.2.3-beta.1', '1.2.3'), 0)
    assert.equal(compareVersions('1.2.3+build9', '1.2.3'), 0)
  })
})
