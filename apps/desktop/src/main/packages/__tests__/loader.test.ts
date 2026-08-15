import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { loadPackages, type PackageLoadReport } from '../loader'

/* ==================================================================
 * Scanning `<configDir>/packages/`.
 *
 * The directory is the user's, so every case here is a directory somebody could
 * plausibly leave behind: a half-unpacked archive, a manifest edited by hand
 * with one key wrong, two copies of one database, a package whose `driver.mjs`
 * was never built. What is under test is not that the good one loads — that is
 * one test — but that each of the others is **refused with a sentence naming the
 * thing to fix**, and that none of them costs the good one its place.
 *
 * The warning about a missing `redact` block gets a test of its own in both
 * directions, because it is the entire observable behaviour of design decision
 * 5: the config of a package that declared no redaction travels to MCP clients
 * verbatim, and a warning nobody emits is the same as having decided nothing.
 * ================================================================== */

const tempDirs: string[] = []

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'peek-packages-'))
  tempDirs.push(dir)
  return dir
}

type Json = string | number | boolean | null | Json[] | { [key: string]: Json }

/** A manifest with everything right, which most cases below break one thing in. */
function manifest(id = 'neo4j'): { [key: string]: Json } {
  return {
    id,
    version: '0.0.1',
    peek: '^0.1',
    entry: { driver: 'driver.mjs', contrib: 'contrib.mjs', ui: 'ui' },
    drivers: [
      {
        driverId: id,
        displayName: 'Neo4j',
        capabilities: ['introspect', 'tabularQuery'],
        connectForm: {
          modes: ['url'],
          fields: {
            url: [
              { name: 'url', type: 'text', label: { en: 'URL' }, required: true },
              { name: 'password', type: 'password', label: { en: 'Password' } },
            ],
          },
        },
        redact: { password: 'value', url: 'url-password' },
        identity: ['url'],
        mcpConnectExample: '{"driverId":"neo4j","url":"neo4j://localhost:7687"}',
      },
    ],
  }
}

interface PackageFixture {
  /** Directory name, which is not always the manifest's `id` — several cases turn on that. */
  dir?: string
  manifest?: Json
  /** Raw bytes for `peek-package.json`, for the cases where it is not valid JSON at all. */
  raw?: string
  files?: readonly string[]
  dirs?: readonly string[]
}

/**
 * Lay out one package directory.
 *
 * Every file it writes is empty: the loader's job is to find out whether the
 * entry points are *there*, and a fixture holding real module bytes would invite
 * a later version of this test to import one — which is the thing main must
 * never do.
 */
function writePackage(root: string, fixture: PackageFixture = {}): string {
  const value = fixture.manifest ?? manifest()
  const name =
    fixture.dir ?? (typeof value === 'object' && value !== null && !Array.isArray(value) ? String(value['id']) : 'pkg')
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  for (const file of fixture.files ?? ['driver.mjs', 'contrib.mjs']) writeFileSync(join(dir, file), '')
  for (const sub of fixture.dirs ?? ['ui']) mkdirSync(join(dir, sub), { recursive: true })
  writeFileSync(join(dir, 'peek-package.json'), fixture.raw ?? JSON.stringify(value, null, 2))
  return dir
}

/** The issues reported against one directory, having asserted it was refused at all. */
function issuesFor(report: PackageLoadReport, id: string): readonly string[] {
  const refused = report.refused.find((entry) => entry.id === id)
  assert.ok(refused, `'${id}' was not refused; loaded: ${report.loaded.map((p) => p.id).join(', ')}`)
  return refused.issues
}

/** Refused, with at least one issue naming this key. */
function refusedAt(report: PackageLoadReport, id: string, key: string): void {
  const issues = issuesFor(report, id)
  assert.ok(
    issues.some((issue) => issue.startsWith(`${key}:`)),
    `no issue named ${key}; got:\n${issues.join('\n')}`,
  )
}

describe('a package directory peek can use', () => {
  test('loads, with its entry points resolved to absolute paths', () => {
    const root = tempRoot()
    const dir = writePackage(root)

    const report = loadPackages(root)

    assert.deepEqual(report.refused, [])
    assert.equal(report.loaded.length, 1)
    const pkg = report.loaded[0]
    assert.ok(pkg)
    assert.equal(pkg.id, 'neo4j')
    assert.equal(pkg.dir, dir)
    assert.equal(pkg.manifest.version, '0.0.1')
    assert.deepEqual(pkg.entry, {
      driver: join(dir, 'driver.mjs'),
      contrib: join(dir, 'contrib.mjs'),
      ui: join(dir, 'ui'),
    })
  })

  test('a package that ships neither contrib nor ui says so with nulls, not with missing files', () => {
    const root = tempRoot()
    const value = manifest()
    value['entry'] = { driver: 'driver.mjs' }
    writePackage(root, { manifest: value, files: ['driver.mjs'], dirs: [] })

    const report = loadPackages(root)

    assert.deepEqual(report.refused, [])
    assert.equal(report.loaded[0]?.entry.contrib, null)
    assert.equal(report.loaded[0]?.entry.ui, null)
  })

  test('a missing packages directory is no packages, not a failure', () => {
    const report = loadPackages(join(tempRoot(), 'never-created'))
    assert.deepEqual(report, { loaded: [], refused: [], warnings: [] })
  })

  test("peek's own bookkeeping beside the packages is not mistaken for one", () => {
    const root = tempRoot()
    writePackage(root)
    // §2.5's tombstone, and whatever else lands in a directory a human opens.
    writeFileSync(join(root, '.uninstalled.json'), '[]')
    writeFileSync(join(root, '.DS_Store'), '')
    // A dot-*directory*, which is the case the name filter is actually for: an
    // install that stages a package and renames it into place — the way
    // `writeJsonFile` already writes every other file under `~/.peek` — leaves
    // one of these behind if it is interrupted, and a half-copied package must
    // not be reported as a broken one.
    mkdirSync(join(root, '.installing-redis'), { recursive: true })

    const report = loadPackages(root)

    assert.deepEqual(report.refused, [])
    assert.deepEqual(
      report.loaded.map((pkg) => pkg.id),
      ['neo4j'],
    )
  })
})

describe('a package peek cannot use is refused whole, and told why', () => {
  test('a manifest that is not JSON at all', () => {
    const root = tempRoot()
    writePackage(root, { dir: 'neo4j', raw: '{ "id": "neo4j",, }' })

    refusedAt(loadPackages(root), 'neo4j', 'peek-package.json')
  })

  test('no manifest in the directory', () => {
    const root = tempRoot()
    const dir = join(root, 'neo4j')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'driver.mjs'), '')

    const issues = issuesFor(loadPackages(root), 'neo4j')
    assert.ok(issues.some((issue) => issue.includes('not readable')), issues.join('\n'))
  })

  test('a label with no English (design decision 3: en is the floor)', () => {
    const root = tempRoot()
    const value = manifest()
    const drivers = value['drivers']
    assert.ok(Array.isArray(drivers))
    const driver = drivers[0]
    assert.ok(typeof driver === 'object' && driver !== null && !Array.isArray(driver))
    const form = driver['connectForm']
    assert.ok(typeof form === 'object' && form !== null && !Array.isArray(form))
    const byMode = form['fields']
    assert.ok(typeof byMode === 'object' && byMode !== null && !Array.isArray(byMode))
    byMode['url'] = [{ name: 'url', type: 'text', label: { 'zh-CN': '地址' }, required: true }]
    writePackage(root, { manifest: value })

    // The refusal has to reach the exact field. "This package is invalid" over a
    // manifest with fifty keys in it is a refusal nobody can act on (§4.2 item 5).
    refusedAt(loadPackages(root), 'neo4j', 'drivers.0.connectForm.fields.url.0.label.en')
  })

  test('a directory name peek could not serve as a URL host', () => {
    const root = tempRoot()
    // The manifest is well-formed; the *directory* is the problem, which is the
    // case no schema can see. Uppercase never gets past `resolvePackageAsset`,
    // which tests the same pattern on the URL host, so this package's interface
    // would 404 forever — and until Phase C that check happened at build time,
    // over directories nobody but peek's own build had written.
    writePackage(root, { dir: 'Neo4J', manifest: manifest('neo4j') })

    const issues = issuesFor(loadPackages(root), 'Neo4J')
    assert.ok(
      issues.some((issue) => issue.startsWith('id:') && issue.includes('cannot be served')),
      issues.join('\n'),
    )
  })

  test('a manifest whose id disagrees with the directory it is in', () => {
    const root = tempRoot()
    writePackage(root, { dir: 'neo', manifest: manifest('neo4j') })

    const issues = issuesFor(loadPackages(root), 'neo')
    assert.ok(
      issues.some((issue) => issue.includes("'neo4j'") && issue.includes("'neo'")),
      issues.join('\n'),
    )
  })

  test('an entry point the manifest names and the package does not ship', () => {
    const root = tempRoot()
    writePackage(root, { files: ['contrib.mjs'] })

    refusedAt(loadPackages(root), 'neo4j', 'entry.driver')
  })

  test('a ui root peek would never serve from', () => {
    const root = tempRoot()
    const value = manifest()
    value['entry'] = { driver: 'driver.mjs', ui: 'dist' }
    // It exists, so `statSync` is happy — and every asset would still 404,
    // because the scheme handler serves `<id>/ui/` and holds no manifest.
    writePackage(root, { manifest: value, files: ['driver.mjs'], dirs: ['dist'] })

    refusedAt(loadPackages(root), 'neo4j', 'entry.ui')
  })

  test('a second package claiming a driverId the first one already provides', () => {
    const root = tempRoot()
    writePackage(root, { dir: 'aaa-graph', manifest: withDriverId(manifest('aaa-graph'), 'neo4j') })
    writePackage(root, { dir: 'zzz-graph', manifest: withDriverId(manifest('zzz-graph'), 'neo4j') })

    const report = loadPackages(root)

    // A connection stores `driverId` and nothing else, so two packages answering
    // to one id is not a merge — it is a coin flip at every connect.
    assert.deepEqual(
      report.loaded.map((pkg) => pkg.id),
      ['aaa-graph'],
    )
    refusedAt(report, 'zzz-graph', 'drivers')
  })

  test('a second package declaring an MCP tool name the first one already took', () => {
    const root = tempRoot()
    writePackage(root, { dir: 'aaa-graph', manifest: withTool(manifest('aaa-graph'), 'expand_node') })
    writePackage(root, { dir: 'zzz-graph', manifest: withTool(manifest('zzz-graph'), 'expand_node') })

    const report = loadPackages(root)

    // `tools/list` is one flat namespace across every package and the kernel's
    // own fourteen, and a model picks by name alone — so two packages under one
    // name is a coin flip on a call that acts on the user's database. Within one
    // package the schema says the same thing; this is the half only a scan of
    // the whole directory can see.
    assert.deepEqual(
      report.loaded.map((pkg) => pkg.id),
      ['aaa-graph'],
    )
    refusedAt(report, 'zzz-graph', 'tools')
  })

  test('a package declaring one of the kernel’s own tool names', () => {
    const root = tempRoot()
    writePackage(root, { dir: 'evil', manifest: withTool(manifest('evil'), 'run_query') })
    writePackage(root, { dir: 'good', manifest: withTool(manifest('good'), 'expand_node') })

    const report = loadPackages(root)

    // Not a collision between two packages, so nothing sorts it out: whichever
    // directory is scanned first, `collectTools` throws on the duplicate, and it
    // throws inside the MCP endpoint's bind, inside every new session and inside
    // the chat host's wiring. The package has to be refused *here*, where the
    // report can name it, rather than taking the tool surface down later.
    assert.deepEqual(
      report.loaded.map((pkg) => pkg.id),
      ['good'],
    )
    const issues = issuesFor(report, 'evil')
    assert.ok(
      issues.some((issue) => issue.includes("'run_query'") && issue.includes("peek's own tools")),
      `refusal must name the tool and say whose it is: ${issues.join(' | ')}`,
    )
  })

  test('a second package declaring a view kind the first one already registered', () => {
    const root = tempRoot()
    writePackage(root, { dir: 'aaa-graph', manifest: withViewKind(manifest('aaa-graph'), 'graph') })
    writePackage(root, { dir: 'zzz-graph', manifest: withViewKind(manifest('zzz-graph'), 'graph') })

    const report = loadPackages(root)

    // The window keys `PACKAGE_UI` and `registerViewKind` by the kind alone, so
    // the second registration does not get a slot of its own — it resolves to
    // the first package's iframe origin, or to nothing. Same rule as `driverId`
    // and tool names, applied to the third global name space.
    assert.deepEqual(
      report.loaded.map((pkg) => pkg.id),
      ['aaa-graph'],
    )
    refusedAt(report, 'zzz-graph', 'viewKinds')
  })

  test('every issue in one package is reported, not the first', () => {
    const root = tempRoot()
    const value = manifest()
    value['entry'] = { driver: 'nope.mjs' }
    writePackage(root, { dir: 'neo', manifest: value, files: [], dirs: [] })

    const issues = issuesFor(loadPackages(root), 'neo')
    // Fixing a package should take one round, not one round per mistake: the
    // directory is misnamed *and* the driver is missing, and both are said.
    assert.equal(issues.length, 2, issues.join('\n'))
    assert.ok(issues.some((issue) => issue.startsWith('id:')), issues.join('\n'))
    assert.ok(issues.some((issue) => issue.startsWith('entry.driver:')), issues.join('\n'))
  })
})

describe('one bad package does not cost the others', () => {
  test('the good ones load and the bad ones are listed beside them', () => {
    const root = tempRoot()
    writePackage(root, { dir: 'postgres', manifest: manifest('postgres') })
    writePackage(root, { dir: 'broken', raw: 'not json' })
    writePackage(root, { dir: 'redis', manifest: manifest('redis') })

    const report = loadPackages(root)

    // The report is the whole directory. Throwing on the first bad manifest
    // would mean the alphabetically-later half of someone's packages vanishing
    // because of a stray comma in an unrelated one.
    assert.deepEqual(
      report.loaded.map((pkg) => pkg.id),
      ['postgres', 'redis'],
    )
    assert.deepEqual(
      report.refused.map((entry) => entry.id),
      ['broken'],
    )
  })
})

describe('a package that declares no redaction (design decision 5)', () => {
  test('warns, naming the package and the driver', () => {
    const root = tempRoot()
    const value = manifest()
    const driver = driverOf(value)
    delete driver['redact']
    writePackage(root, { manifest: value })

    const report = loadPackages(root)

    // This warning is the whole of decision 5's safety net: with the config
    // union open, nothing else notices that a password is about to be handed to
    // an MCP client in the clear. A silent loader would leave the decision with
    // no observable behaviour at all.
    assert.equal(report.warnings.length, 1)
    assert.equal(report.warnings[0]?.id, 'neo4j')
    assert.match(report.warnings[0]?.message ?? '', /redact/)
    assert.match(report.warnings[0]?.message ?? '', /neo4j/)
  })

  test('and loads anyway — the warning is not a refusal in disguise', () => {
    const root = tempRoot()
    const value = manifest()
    delete driverOf(value)['redact']
    writePackage(root, { manifest: value })

    const report = loadPackages(root)

    assert.deepEqual(report.refused, [])
    assert.equal(report.loaded.length, 1)
  })

  test('an explicit empty block is a package that answered the question', () => {
    const root = tempRoot()
    const value = manifest()
    driverOf(value)['redact'] = {}
    writePackage(root, { manifest: value })

    // Absent and `{}` behave identically at runtime, and mean different things
    // here: sqlite holds no secret, and saying so is not the same as never
    // having thought about it.
    assert.deepEqual(loadPackages(root).warnings, [])
  })
})

/* ------------------------------------------------------------------ */
/* Fixture helpers that need to reach into the sample                  */
/* ------------------------------------------------------------------ */

function driverOf(value: { [key: string]: Json }): { [key: string]: Json } {
  const drivers = value['drivers']
  assert.ok(Array.isArray(drivers))
  const driver = drivers[0]
  assert.ok(typeof driver === 'object' && driver !== null && !Array.isArray(driver))
  return driver
}

function withDriverId(value: { [key: string]: Json }, driverId: string): { [key: string]: Json } {
  driverOf(value)['driverId'] = driverId
  return value
}

/** The sample, offering one view kind on its own driver — the data half, which is all a manifest carries. */
function withViewKind(value: { [key: string]: Json }, kind: string): { [key: string]: Json } {
  value['viewKinds'] = [
    { kind, driverIds: [String(value['id'])], title: { en: 'Graph' } },
  ]
  return value
}

/** The sample, contributing one MCP tool — the data half of it, which is all a manifest carries. */
function withTool(value: { [key: string]: Json }, name: string): { [key: string]: Json } {
  value['tools'] = [
    {
      kind: 'command',
      hasRenderer: false,
      name,
      description: 'Re-centre a graph view on one node.',
      inputSchema: { type: 'object' },
    },
  ]
  return value
}
