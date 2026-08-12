import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, test } from 'node:test'
import type { DriverManifest } from '@peek/core'
import { neo4jManifest } from '@peek/db-neo4j/manifest'
import { postgresManifest } from '@peek/db-postgres/manifest'
import { qdrantManifest } from '@peek/db-qdrant/manifest'
import { redisManifest } from '@peek/db-redis/manifest'
import { sqlManifests } from '@peek/db-sql/manifest'
import '../../../drivers/__tests__/in-repo-registry'
import { driverManifests } from '../../../drivers/manifests'

/* ==================================================================
 * `DriverManifest.version` says what it claims to say.
 *
 * The version is a literal in each manifest rather than something read at
 * runtime — `manifest.ts` has to load in the renderer chunk, which has no `fs`,
 * and reaching for the app's own version would make every package claim a number
 * that stops being its own the moment one is published separately. So it is
 * stated twice, and this is what makes the two copies unable to disagree.
 *
 * That matters more than it looks. The number is shown in Settings under
 * "which connectors are installed", and a *wrong* version there is worse than no
 * version at all: someone chasing a driver bug would rule out the build that is
 * actually running.
 *
 * ## Why the packages are named here rather than derived
 *
 * A manifest carries a `driverId`, not a package name, and the two are not one
 * to one — `@peek/db-sql` ships **both** MySQL and SQLite. Deriving the
 * directory from the id would therefore have to guess, and would guess wrong for
 * exactly the package that has more than one. The list below is the mapping,
 * written out; `covers every manifest` is what stops it from going stale.
 * ================================================================== */

const repoRoot = resolve(import.meta.dirname, '../../../../../..')

interface PackageUnderTest {
  dir: string
  manifests: readonly DriverManifest[]
}

const PACKAGES: readonly PackageUnderTest[] = [
  { dir: 'db-postgres', manifests: [postgresManifest] },
  { dir: 'db-redis', manifests: [redisManifest] },
  { dir: 'db-qdrant', manifests: [qdrantManifest] },
  { dir: 'db-neo4j', manifests: [neo4jManifest] },
  { dir: 'db-sql', manifests: sqlManifests },
]

function packageVersion(dir: string): string {
  const file = join(repoRoot, 'packages', dir, 'package.json')
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as { version?: unknown }
  assert.equal(typeof parsed.version, 'string', `packages/${dir}/package.json has no version`)
  return parsed.version as string
}

describe('driver manifest versions', () => {
  for (const pkg of PACKAGES) {
    test(`${pkg.dir} declares its own package.json version`, () => {
      const expected = packageVersion(pkg.dir)
      for (const manifest of pkg.manifests) {
        assert.equal(
          manifest.version,
          expected,
          `${manifest.driverId} reports version ${manifest.version}, but packages/${pkg.dir} is at ${expected}`,
        )
      }
    })
  }

  test('covers every manifest the app collects', () => {
    // Without this, adding a seventh database would add a manifest whose version
    // nobody checks — and it would be the newest one, i.e. the one most likely
    // to be wrong.
    const covered = new Set(PACKAGES.flatMap((p) => p.manifests).map((m) => m.driverId))
    for (const manifest of driverManifests()) {
      assert.ok(
        covered.has(manifest.driverId),
        `${manifest.driverId} is collected by the app but no package in this test claims it`,
      )
    }
  })

  test('every version is a plausible semver, not a placeholder', () => {
    // Not a full semver grammar — the point is to reject the two ways this field
    // goes wrong in practice: left empty, or filled with a name.
    for (const manifest of driverManifests()) {
      assert.match(
        manifest.version,
        /^\d+\.\d+\.\d+(?:[-+].+)?$/,
        `${manifest.driverId} has a version that is not a version: ${JSON.stringify(manifest.version)}`,
      )
    }
  })
})
