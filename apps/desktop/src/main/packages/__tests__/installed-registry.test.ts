import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { PACKAGE_MANIFEST_FILE } from '@peek/core/package-manifest'
import { installedFrom, packageLoadNotices } from '../installed'
import { loadPackages } from '../loader'

/* ==================================================================
 * The two steps between `loadPackages` and a usable peek.
 *
 * `loader.ts` answers "which of these directories can peek use", and that is
 * covered next door. This is what `main/index.ts` does with the answer, and both
 * halves are here because both are failures nobody would see:
 *
 *   - `installedFrom` puts a package's `version` onto each of its drivers, which
 *     is the one field `peek-package.json` does not repeat per driver. Getting it
 *     wrong leaves the settings panel unable to tell two installs apart, and
 *     nothing throws.
 *   - `packageLoadNotices` is the *only* observable consequence of a package
 *     that was refused, or of one that never declared which of its fields are
 *     secret (decision 5). A silent scan is a database that is quietly missing.
 *
 * Written against real directories rather than a hand-built `PackageLoadReport`:
 * a literal report would let this file agree with itself about a shape the
 * loader does not produce, which is the drift `third-party-package.test.ts`
 * makes the same argument about.
 * ================================================================== */

const roots: string[] = []

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

/** A packages root with the named packages written into it. */
function packagesRoot(packages: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), 'peek-installed-'))
  roots.push(root)
  for (const [id, manifest] of Object.entries(packages)) {
    const dir = join(root, id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'driver.mjs'), 'export default {}\n')
    writeFileSync(join(dir, PACKAGE_MANIFEST_FILE), JSON.stringify(manifest))
  }
  return root
}

/** A manifest that loads, so that each case below differs in exactly one thing. */
function manifestOf(id: string, driver: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    version: '2.3.4',
    peek: '^0.0.1',
    drivers: [
      {
        driverId: id,
        displayName: id.toUpperCase(),
        capabilities: ['introspect'],
        connectForm: {
          modes: ['fields'],
          fields: {
            fields: [{ name: 'url', type: 'text', label: { en: 'Server' }, always: true }],
          },
        },
        redact: {},
        identity: ['url'],
        mcpConnectExample: `{"driverId":"${id}"}`,
        ...driver,
      },
    ],
    entry: { driver: 'driver.mjs' },
  }
}

describe('the loader’s report, as a registry', () => {
  test('every driver carries the version its package states once', () => {
    const installed = installedFrom(loadPackages(packagesRoot({ alpha: manifestOf('alpha') })))

    assert.deepEqual(
      installed.drivers.map((driver) => [
        driver.packageId,
        driver.manifest.driverId,
        driver.manifest.version,
      ]),
      [['alpha', 'alpha', '2.3.4']],
    )
  })

  test('a driver that declares no redact block gets one, because the runtime has no third state', () => {
    // Absent and `{}` are two statements in the manifest — the loader warns
    // about the first and not the second — and exactly one behaviour once
    // installed: `redactConnectionConfig` has no rule to apply either way.
    const root = packagesRoot({ bare: manifestOf('bare', { redact: undefined }) })
    const installed = installedFrom(loadPackages(root))

    assert.deepEqual(installed.drivers[0]?.manifest.redact, {})
  })

  test('the whole registry survives the trip to the window', () => {
    const withExtras = manifestOf('crosser')
    Object.assign(withExtras, {
      viewKinds: [{ kind: 'graph', driverIds: ['crosser'], title: { en: 'Graph' } }],
      tools: [
        {
          kind: 'command',
          hasRenderer: false,
          name: 'do_it',
          description: 'do',
          inputSchema: { type: 'object' },
        },
      ],
    })
    const installed = installedFrom(loadPackages(packagesRoot({ crosser: withExtras })))

    // `IPC.PACKAGES_READ` sends this value to the renderer, so what does not
    // survive `structuredClone` does not reach the connect dialog. Every field
    // is a `JSON.parse` product today and this is what keeps it that way: a
    // helper method added to any of these shapes would be dropped in the window
    // and nowhere else, which is a difference between the two processes that
    // nothing else would report.
    assert.deepEqual(structuredClone(installed), installed)
  })

  test('a package is tagged onto every contribution it makes', () => {
    const withExtras = manifestOf('graphy')
    Object.assign(withExtras, {
      viewKinds: [{ kind: 'graph', driverIds: ['graphy'], title: { en: 'Graph' } }],
      tools: [
        {
          kind: 'command',
          hasRenderer: true,
          name: 'expand_it',
          description: 'expand something',
          inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
        },
      ],
    })
    const installed = installedFrom(loadPackages(packagesRoot({ graphy: withExtras })))

    // The tag is what routes a call to the process that can answer it — a view
    // kind and a tool both name a package and neither declaration says which.
    assert.deepEqual(
      installed.viewKinds.map((kind) => [kind.packageId, kind.kind]),
      [['graphy', 'graph']],
    )
    assert.deepEqual(
      installed.tools.map((tool) => [tool.packageId, tool.name]),
      [['graphy', 'expand_it']],
    )
  })
})

describe('what the scan says out loud', () => {
  test('a refused package is reported with its directory and every issue', () => {
    const root = packagesRoot({ broken: { id: 'broken' } })
    const report = loadPackages(root)
    const notices = packageLoadNotices(report, root)

    const refusal = notices.find((notice) => notice.message.includes("'broken'"))
    assert.ok(refusal, 'a package that did not load must not be silent — the database is simply gone')
    assert.equal(refusal.level, 'error')
    assert.ok(refusal.detail?.startsWith(join(root, 'broken')), 'the user has to be told which directory')
    // Every issue, not the first: the loader collects them so that a manifest
    // with several things wrong takes one round of fixing.
    assert.ok((refusal.detail?.match(/\n {2}/g) ?? []).length >= report.refused[0]!.issues.length)
  })

  test('a package with no redact block warns, and one with an empty block does not', () => {
    const silent = packageLoadNotices(loadPackages(packagesRoot({ quiet: manifestOf('quiet') })), 'ignored')
    assert.deepEqual(
      silent.filter((notice) => notice.level === 'warn'),
      [],
    )

    const root = packagesRoot({ leaky: manifestOf('leaky', { redact: undefined }) })
    const warned = packageLoadNotices(loadPackages(root), root)
    const warning = warned.find((notice) => notice.level === 'warn')
    assert.ok(warning, 'decision 5 has no other observable consequence than this line')
    assert.ok(warning.message.includes("'leaky'"), 'a warning that names no package cannot be acted on')
  })

  test('an empty scan says so, because nothing loaded means nothing works', () => {
    const root = packagesRoot({})
    const notices = packageLoadNotices(loadPackages(root), root)

    const empty = notices.find((notice) => notice.message.includes('No database packages'))
    assert.ok(empty, 'an empty connect dialog with no explanation reads as a bug in peek')
    assert.equal(empty.level, 'error')
    assert.equal(empty.detail, root)
  })

  test('a scan that found something says nothing about the packages that worked', () => {
    const root = packagesRoot({ alpha: manifestOf('alpha') })
    assert.deepEqual(packageLoadNotices(loadPackages(root), root), [])
  })
})
