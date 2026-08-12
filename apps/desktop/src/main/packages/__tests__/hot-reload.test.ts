import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import {
  PACKAGE_MANIFEST_FILE,
  asPanelId,
  createEmptyWorkspace,
  type CommandResultFor,
  type ConnId,
  type ConnectionConfig,
  type NotifyMessage,
} from '@peek/core'
import { clearInstalledPackages, installPackages, installedDriver } from '../../../drivers/installed'
import { CommandBus } from '../../bus/command-bus'
import type { CommandDeps } from '../../bus/deps'
import { coreHandlers } from '../../bus/handlers'
import { createSeqIdFactory } from '../../bus/ids'
import { WorkspaceStore } from '../../store/workspace-store'
import { TOMBSTONE_FILE, bundledCatalog, readTombstones } from '../bundled'
import { createPackageHandlers } from '../commands'
import { installedFrom } from '../installed'
import { loadPackages } from '../loader'
import { uninstallPackage } from '../manage'

/* ==================================================================
 * Installing and uninstalling a package while peek is running (design §2.7).
 *
 * Driven through a real `CommandBus`, not by calling the handlers: the two paths
 * are shaped differently on purpose — install is a `read`, uninstall is a
 * `reduce` whose disk work leaves as an intent — and it is precisely that
 * sequencing (state change, then effect, then `finalize` correcting the receipt)
 * that has to hold. A test that called the handler halves directly would agree
 * with itself about an order the bus does not run.
 *
 * The packages are written to a temporary directory rather than taken from the
 * repository, for one reason `third-party-package.test.ts` does not have to care
 * about: these tests *delete* what they install, and a fixture that is deleted is
 * a fixture the next run does not have.
 *
 * ## What is stubbed, and what is not
 *
 * The disk, the loader, the registry, the reducer and the effect phase are all
 * the real ones. Two things are counted rather than performed: the broadcast to
 * the windows (there is no window) and the MCP notification (there is no
 * endpoint). Both are one call from `main/index.ts`, and what these tests assert
 * about them is that they happen, once, after the registry has changed — which
 * is the ordering a client hearing `tools/list_changed` depends on.
 * ================================================================== */

const roots: string[] = []

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  clearInstalledPackages()
})

/** One driver declaration that parses, addressed by a single `url` field. */
function driverOf(driverId: string): Record<string, unknown> {
  return {
    driverId,
    displayName: driverId.toUpperCase(),
    capabilities: ['introspect'],
    connectForm: {
      modes: ['url'],
      fields: { url: [{ name: 'url', type: 'text', label: { en: 'URL' } }] },
    },
    redact: {},
    identity: ['url'],
    mcpConnectExample: `{"driverId":"${driverId}","url":"${driverId}://localhost"}`,
  }
}

/** A manifest that loads, so each case below differs in exactly one thing. */
function manifestOf(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    version: '1.0.0',
    peek: '^0.0.1',
    drivers: [driverOf(id)],
    entry: { driver: 'driver.mjs' },
    ...overrides,
  }
}

/** Write a package directory somewhere, and answer with its path. */
function writePackage(parent: string, name: string, manifest: unknown): string {
  const dir = join(parent, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'driver.mjs'), 'export default []\n')
  writeFileSync(join(dir, PACKAGE_MANIFEST_FILE), JSON.stringify(manifest))
  return dir
}

interface Harness {
  bus: CommandBus
  store: WorkspaceStore
  /** `<configDir>/packages` for this run. */
  packagesRoot: string
  /** The app bundle's packages for this run. */
  bundledRoot: string
  /** Somewhere to build a package that is *not* installed yet. */
  stagingRoot: string
  /** One entry per registry broadcast, holding the driver ids it carried. */
  broadcasts: string[][]
  /** One entry per `notifications/tools/list_changed`, holding the same. */
  toolNotifications: string[][]
  notices: NotifyMessage[]
  /** Package ids whose host process was asked to exit, in order. */
  disposed: string[]
}

/**
 * A running peek, with `seed` deciding what was already on disk when it started.
 *
 * The callback is not a convenience: `bundledCatalog` is read **once**, where
 * `main/index.ts` reads it, so a package written into the bundle after the
 * harness returns is one this build does not ship as far as every verb is
 * concerned. Anything a test wants peek to have found at launch — a bundled
 * copy, an installed copy, a tombstone — has to exist before that line runs, and
 * that is exactly what a launched app sees.
 */
function harness(seed: (dirs: { packagesRoot: string; bundledRoot: string }) => void = () => {}): Harness {
  const root = mkdtempSync(join(tmpdir(), 'peek-hot-reload-'))
  roots.push(root)
  const packagesRoot = join(root, 'packages')
  const bundledRoot = join(root, 'bundled')
  const stagingRoot = join(root, 'elsewhere')
  mkdirSync(packagesRoot, { recursive: true })
  mkdirSync(bundledRoot, { recursive: true })
  mkdirSync(stagingRoot, { recursive: true })
  seed({ packagesRoot, bundledRoot })

  const broadcasts: string[][] = []
  const toolNotifications: string[][] = []
  const notices: NotifyMessage[] = []
  const disposed: string[] = []

  clearInstalledPackages()

  const scan = (): ReturnType<typeof loadPackages> => loadPackages(packagesRoot)
  const adopt = (report: ReturnType<typeof loadPackages>): void => {
    const installed = installedFrom(report)
    installPackages(installed)
    broadcasts.push(installed.drivers.map((driver) => driver.manifest.driverId))
  }

  const options = {
    packagesRoot,
    bundledRoot,
    // Read once, exactly as `main/index.ts` does — see the field's note.
    catalog: bundledCatalog(bundledRoot),
    scan,
    adopt,
    toolsChanged: () => {
      toolNotifications.push(loadPackages(packagesRoot).loaded.flatMap((pkg) => pkg.manifest.drivers.map((d) => d.driverId)))
    },
    notify: (message: NotifyMessage) => notices.push(message),
  }

  const deps: CommandDeps = {
    connections: {
      async open() {
        return { capabilities: ['introspect'], pid: 1 }
      },
      async close() {},
    },
    results: {
      async runQuery() {},
      async scanCollection() {},
      async vectorSearch() {},
      async cancel() {
        return true
      },
    },
    // The same three steps `createPackageAdmin` performs in main, minus the
    // Electron process registry: the host is recorded rather than killed.
    packages: {
      async uninstall({ packageId, version }) {
        disposed.push(packageId)
        const outcome = uninstallPackage({
          id: packageId,
          packagesRoot,
          catalog: options.catalog,
          version,
        })
        if (!outcome.ok) throw new Error(outcome.issue)
        adopt(scan())
        options.toolsChanged()
      },
    },
  }

  const store = new WorkspaceStore(createEmptyWorkspace(asPanelId('panel_root')))
  const bus = new CommandBus({ store, deps, ids: createSeqIdFactory(), now: () => 1_000 })
  bus.registerAll(coreHandlers)
  bus.registerAll(createPackageHandlers(options))

  // The startup scan, so every test begins where a launched peek would.
  adopt(scan())
  broadcasts.length = 0

  return {
    bus,
    store,
    packagesRoot,
    bundledRoot,
    stagingRoot,
    broadcasts,
    toolNotifications,
    notices,
    disposed,
  }
}

/** The ids peek has been told not to lay back out, off the file the loader reads. */
function readStones(packagesRoot: string): string[] {
  return readTombstones(packagesRoot).map((stone) => stone.id)
}

function install(h: Harness, dir: string): Promise<CommandResultFor<'packages.install'>> {
  return h.bus.dispatch('packages.install', { dir }, 'ui')
}

/* ------------------------------------------------------------------ */

describe('packages.read', () => {
  test('reports what is installed, where it came from, and what would upgrade it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'peek-hot-reload-'))
    roots.push(root)
    const packagesRoot = join(root, 'packages')
    const bundledRoot = join(root, 'bundled')
    mkdirSync(packagesRoot, { recursive: true })
    mkdirSync(bundledRoot, { recursive: true })
    writePackage(bundledRoot, 'alpha', manifestOf('alpha'))
    writePackage(bundledRoot, 'gamma', manifestOf('gamma', { version: '2.0.0' }))
    writePackage(packagesRoot, 'alpha', manifestOf('alpha'))
    writePackage(packagesRoot, 'beta', manifestOf('beta'))
    writePackage(packagesRoot, 'gamma', manifestOf('gamma'))

    clearInstalledPackages()
    installPackages(installedFrom(loadPackages(packagesRoot)))
    const store = new WorkspaceStore(createEmptyWorkspace(asPanelId('panel_root')))
    const bus = new CommandBus({
      store,
      deps: {
        connections: { async open() { return { capabilities: [] } }, async close() {} },
        results: {
          async runQuery() {},
          async scanCollection() {},
          async vectorSearch() {},
          async cancel() { return true },
        },
      },
      ids: createSeqIdFactory(),
      now: () => 1_000,
    })
    bus.registerAll(coreHandlers)
    bus.registerAll(
      createPackageHandlers({
        packagesRoot,
        bundledRoot,
        catalog: bundledCatalog(bundledRoot),
        scan: () => loadPackages(packagesRoot),
        adopt: (report) => installPackages(installedFrom(report)),
        toolsChanged: () => {},
        notify: () => {},
      }),
    )

    const res = await bus.dispatch('packages.read', {}, 'ui')
    assert.equal(res.ok, true)
    if (!res.ok) throw new Error('unreachable')
    assert.deepEqual(
      res.data.packages.map((entry) => ({
        id: entry.id,
        source: entry.source,
        upgrade: entry.upgradeVersion ?? null,
      })),
      [
        // Shipped and current: bundled, nothing to offer.
        { id: 'alpha', source: 'bundled', upgrade: null },
        // Not shipped at all: the user's, and peek has nothing to compare with.
        { id: 'beta', source: 'user', upgrade: null },
        // Shipped newer than what is installed: reported, never taken (§2.5 rule 2).
        { id: 'gamma', source: 'bundled', upgrade: '2.0.0' },
      ],
    )
  })
})

describe('packages.install', () => {
  test('a package installed now is connectable now, and the windows and MCP are told', async () => {
    const h = harness()
    const source = writePackage(h.stagingRoot, 'echo-1.0.0', manifestOf('echo'))

    // Before: no such driver, and `conn.open` refuses it by name.
    assert.equal(installedDriver('echo'), null)

    const res = await install(h, source)
    assert.equal(res.ok, true)
    if (!res.ok) throw new Error('unreachable')
    assert.equal(res.data.id, 'echo')
    assert.equal(res.data.replaced, false)
    assert.deepEqual(
      res.data.packages.map((entry) => entry.id),
      ['echo'],
    )

    // The id is the manifest's, not the directory it was installed from.
    assert.ok(existsSync(join(h.packagesRoot, 'echo', PACKAGE_MANIFEST_FILE)))
    assert.equal(existsSync(join(h.packagesRoot, 'echo-1.0.0')), false)

    // The registry every process reads now has it — this is what makes the
    // connect dialog offer it and `conn.open` accept it.
    assert.equal(installedDriver('echo')?.packageId, 'echo')

    // Exactly one of each, and both after the registry moved: a client that asks
    // for the tool list on hearing the notification must be answered from the
    // registry that includes the package.
    assert.deepEqual(h.broadcasts, [['echo']])
    assert.deepEqual(h.toolNotifications, [['echo']])
  })

  test('an entry point that is not there is refused before anything is written', async () => {
    const h = harness()
    // The check that only exists on disk: the manifest is well-formed and names
    // a `driver.mjs` that is not in the directory. Installing it would produce a
    // package that looks fine until the first connect.
    const source = writePackage(
      h.stagingRoot,
      'broken',
      manifestOf('broken', { entry: { driver: 'nowhere.mjs' } }),
    )

    const res = await install(h, source)
    assert.equal(res.ok, false)
    if (res.ok) throw new Error('unreachable')
    assert.equal(res.error.code, 'BAD_REQUEST')
    assert.match(res.error.message, /entry\.driver.*nowhere\.mjs/)

    // Nothing landed, nothing was announced, and no staging directory survived.
    assert.equal(existsSync(join(h.packagesRoot, 'broken')), false)
    assert.deepEqual(h.broadcasts, [])
    assert.deepEqual(h.toolNotifications, [])
  })

  test('a manifest with several faults is refused with all of them', async () => {
    const h = harness()
    // One round of fixing, not four: `loader.ts` collects every issue precisely
    // so the person editing the file sees the whole list.
    const source = writePackage(
      h.stagingRoot,
      'broken',
      manifestOf('broken', { peek: '', version: 'not-a-version' }),
    )

    const res = await install(h, source)
    assert.equal(res.ok, false)
    if (res.ok) throw new Error('unreachable')
    assert.match(res.error.message, /peek:/)
    assert.match(res.error.message, /version:/)
  })

  test('a driver another package already provides is refused, and that package is untouched', async () => {
    const h = harness()
    writePackage(h.packagesRoot, 'echo', manifestOf('echo'))
    await install(h, writePackage(h.stagingRoot, 'first', manifestOf('other')))
    h.broadcasts.length = 0

    // `intruder` ships a driver called `echo`, which the installed `echo` owns.
    const source = writePackage(
      h.stagingRoot,
      'intruder',
      manifestOf('intruder', { drivers: [driverOf('echo')] }),
    )

    const res = await install(h, source)
    assert.equal(res.ok, false)
    if (res.ok) throw new Error('unreachable')
    assert.match(res.error.message, /already provided by the package 'echo'/)
    assert.equal(existsSync(join(h.packagesRoot, 'intruder')), false)
    assert.equal(installedDriver('echo')?.packageId, 'echo')
  })

  test('installing over an id replaces it, and does not collide with the copy it replaces', async () => {
    const h = harness()
    writePackage(h.packagesRoot, 'echo', manifestOf('echo'))
    // The harness scanned before this directory existed, so bring the registry
    // level with the disk the way a launch would.
    await install(h, writePackage(h.stagingRoot, 'unrelated', manifestOf('unrelated')))
    h.broadcasts.length = 0

    const source = writePackage(h.stagingRoot, 'echo-next', manifestOf('echo', { version: '2.5.0' }))
    const res = await install(h, source)
    assert.equal(res.ok, true)
    if (!res.ok) throw new Error('unreachable')
    // Measured against its own previous copy, every driver it ships would read as
    // taken — `inspectPackageDir` drops the id being replaced for exactly this.
    assert.equal(res.data.replaced, true)
    assert.equal(res.data.version, '2.5.0')
    assert.equal(
      res.data.packages.find((entry) => entry.id === 'echo')?.version,
      '2.5.0',
    )
  })

  test('a relative path is refused rather than resolved against whatever the cwd is', async () => {
    const h = harness()
    const res = await install(h, 'packages/echo')
    assert.equal(res.ok, false)
    if (res.ok) throw new Error('unreachable')
    assert.match(res.error.message, /is not an absolute path/)
  })

  test('a directory already inside the packages root is refused, not copied onto itself', async () => {
    const h = harness()
    const inside = writePackage(h.packagesRoot, 'echo', manifestOf('echo'))
    const res = await install(h, inside)
    assert.equal(res.ok, false)
    if (res.ok) throw new Error('unreachable')
    assert.match(res.error.message, /already inside the packages directory/)
    // The point of the refusal: the source is still there.
    assert.ok(existsSync(join(inside, PACKAGE_MANIFEST_FILE)))
  })

  test('a package that declares no redact block is installed, and warned about', async () => {
    const h = harness()
    const silent = driverOf('leaky')
    // Absent, not `{}` — the loader tells the two apart, and only the first earns
    // decision 5's warning.
    delete silent['redact']
    const res = await install(
      h,
      writePackage(h.stagingRoot, 'leaky', manifestOf('leaky', { drivers: [silent] })),
    )
    assert.equal(res.ok, true)
    // Decision 5's only observable consequence, and it must reach a person.
    assert.equal(h.notices.length, 1)
    assert.equal(h.notices[0]?.level, 'warn')
    assert.match(h.notices[0]?.message ?? '', /declares no redact block/)
  })
})

describe('packages.uninstall', () => {
  const configOf = (driverId: string): ConnectionConfig => ({
    driverId,
    url: `${driverId}://localhost`,
  })

  async function withEchoInstalled(): Promise<{ h: Harness; connId: ConnId }> {
    const h = harness()
    const res = await install(h, writePackage(h.stagingRoot, 'echo', manifestOf('echo')))
    assert.equal(res.ok, true)
    h.broadcasts.length = 0
    h.toolNotifications.length = 0

    const opened = await h.bus.dispatch('conn.open', { config: configOf('echo') }, 'ui')
    assert.equal(opened.ok, true)
    if (!opened.ok) throw new Error('unreachable')
    return { h, connId: opened.data.connId }
  }

  test('its connections close, its directory goes, and the receipt names both', async () => {
    const { h, connId } = await withEchoInstalled()
    const viewOpened = await h.bus.dispatch('view.open', { spec: { kind: 'tree', connId } }, 'ui')
    assert.equal(viewOpened.ok, true)

    const res = await h.bus.dispatch('packages.uninstall', { id: 'echo' }, 'ui')
    assert.equal(res.ok, true)
    if (!res.ok) throw new Error('unreachable')

    assert.deepEqual(res.data.closedConnIds, [connId])
    assert.equal(res.data.closedViewIds.length, 1)
    // Corrected by `finalize` against the registry the effect left behind — the
    // reducer could not answer it, the directory was still there.
    assert.deepEqual(res.data.packages, [])

    assert.deepEqual(Object.keys(h.store.getState().connections), [])
    assert.deepEqual(Object.keys(h.store.getState().views), [])
    assert.equal(existsSync(join(h.packagesRoot, 'echo')), false)
    assert.equal(installedDriver('echo'), null)
    // The host is killed before the files go: §2.4bis(f) is the difference
    // between "uninstalled" and "the code is gone".
    assert.deepEqual(h.disposed, ['echo'])
    assert.deepEqual(h.broadcasts, [[]])
    assert.deepEqual(h.toolNotifications, [[]])
  })

  test('a connection on another package survives', async () => {
    const { h, connId } = await withEchoInstalled()
    const other = await install(h, writePackage(h.stagingRoot, 'other', manifestOf('other')))
    assert.equal(other.ok, true)
    const kept = await h.bus.dispatch('conn.open', { config: configOf('other') }, 'ui')
    assert.equal(kept.ok, true)
    if (!kept.ok) throw new Error('unreachable')

    const res = await h.bus.dispatch('packages.uninstall', { id: 'echo' }, 'ui')
    assert.equal(res.ok, true)
    if (!res.ok) throw new Error('unreachable')
    assert.deepEqual(res.data.closedConnIds, [connId])
    assert.deepEqual(Object.keys(h.store.getState().connections), [kept.data.connId])
    // The receipt lists what is installed *after* the removal, which only
    // `finalize` can answer: when the reducer ran, the directory was still there
    // and the registry still held both.
    assert.deepEqual(
      res.data.packages.map((entry) => entry.id),
      ['other'],
    )
  })

  test('an id nobody installed is a structured NOT_FOUND, and nothing is disturbed', async () => {
    const { h } = await withEchoInstalled()
    const res = await h.bus.dispatch('packages.uninstall', { id: 'nothere' }, 'ui')
    assert.equal(res.ok, false)
    if (res.ok) throw new Error('unreachable')
    assert.equal(res.error.code, 'NOT_FOUND')
    assert.equal(installedDriver('echo')?.packageId, 'echo')
    assert.deepEqual(h.disposed, [])
  })

  test('a bundled id leaves a tombstone; a user package leaves none', async () => {
    const root = mkdtempSync(join(tmpdir(), 'peek-hot-reload-'))
    roots.push(root)
    const packagesRoot = join(root, 'packages')
    const bundledRoot = join(root, 'bundled')
    mkdirSync(packagesRoot, { recursive: true })
    writePackage(bundledRoot, 'alpha', manifestOf('alpha'))
    writePackage(packagesRoot, 'alpha', manifestOf('alpha'))
    writePackage(packagesRoot, 'beta', manifestOf('beta'))

    const catalog = bundledCatalog(bundledRoot)
    assert.deepEqual(uninstallPackage({ id: 'beta', packagesRoot, catalog, version: '1.0.0' }), {
      ok: true,
      tombstoned: false,
    })
    // Nothing ships `beta`, so nothing would lay it back out and there is nothing
    // to remember.
    assert.equal(existsSync(join(packagesRoot, TOMBSTONE_FILE)), false)

    assert.deepEqual(uninstallPackage({ id: 'alpha', packagesRoot, catalog, version: '1.0.0' }), {
      ok: true,
      tombstoned: true,
    })
    const stones: unknown = JSON.parse(readFileSync(join(packagesRoot, TOMBSTONE_FILE), 'utf8'))
    assert.deepEqual(
      (stones as { uninstalled: { id: string; version: string }[] }).uninstalled.map((stone) => ({
        id: stone.id,
        version: stone.version,
      })),
      // Without this, `layOutBundledPackages` puts `alpha` straight back on the
      // next launch and the uninstall button is theatre (§2.5 rule 3).
      [{ id: 'alpha', version: '1.0.0' }],
    )
    assert.equal(existsSync(join(packagesRoot, 'alpha')), false)
  })
})

describe('packages.install by bundled id', () => {
  test('installs this build’s own copy over the installed one — the upgrade button’s path', async () => {
    const h = harness(({ packagesRoot, bundledRoot }) => {
      writePackage(bundledRoot, 'alpha', manifestOf('alpha', { version: '2.0.0' }))
      writePackage(packagesRoot, 'alpha', manifestOf('alpha', { version: '1.0.0' }))
    })

    const before = await h.bus.dispatch('packages.read', {}, 'ui')
    assert.equal(before.ok, true)
    if (!before.ok) throw new Error('unreachable')
    // §2.5 rule 2: the newer shipped copy is *offered*, never taken.
    assert.equal(before.data.packages[0]?.upgradeVersion, '2.0.0')

    const res = await h.bus.dispatch('packages.install', { bundledId: 'alpha' }, 'ui')
    assert.equal(res.ok, true)
    if (!res.ok) throw new Error('unreachable')
    assert.equal(res.data.version, '2.0.0')
    // The whole point of there being no `packages.upgrade`: this is an install
    // over an id that was already there, and it says so.
    assert.equal(res.data.replaced, true)
    // Nothing left to offer, which is how the button disappears.
    assert.equal(res.data.packages[0]?.upgradeVersion, undefined)
    assert.equal(installedDriver('alpha')?.manifest.version, '2.0.0')
  })

  test('an id this build does not ship is refused, with the id in the message', async () => {
    const h = harness()
    const res = await h.bus.dispatch('packages.install', { bundledId: 'nothere' }, 'ui')
    assert.equal(res.ok, false)
    if (res.ok) throw new Error('unreachable')
    assert.equal(res.error.code, 'BAD_REQUEST')
    // The id, not just "not a directory": the caller named a package, so the
    // refusal has to be about the package rather than about a path it never saw.
    assert.match(res.error.message, /nothere/)
    assert.deepEqual(h.broadcasts, [])
  })
})

describe('packages.restore', () => {
  test('brings back an uninstalled bundled package, and tells the windows and MCP', async () => {
    const h = harness(({ packagesRoot, bundledRoot }) => {
      writePackage(bundledRoot, 'alpha', manifestOf('alpha'))
      writePackage(packagesRoot, 'alpha', manifestOf('alpha'))
    })

    const gone = await h.bus.dispatch('packages.uninstall', { id: 'alpha' }, 'ui')
    assert.equal(gone.ok, true)
    if (!gone.ok) throw new Error('unreachable')
    assert.equal(gone.data.tombstoned, true)
    assert.equal(installedDriver('alpha'), null)
    h.broadcasts.length = 0
    h.toolNotifications.length = 0

    const res = await h.bus.dispatch('packages.restore', {}, 'ui')
    assert.equal(res.ok, true)
    if (!res.ok) throw new Error('unreachable')
    assert.deepEqual(res.data.restored, ['alpha'])
    assert.deepEqual(res.data.failed, [])
    assert.deepEqual(
      res.data.packages.map((entry) => entry.id),
      ['alpha'],
    )

    // The tombstone is what suppressed it, so clearing it is the half that makes
    // the *next* start agree with this one — acceptance 14.
    assert.deepEqual(readStones(h.packagesRoot), [])
    assert.equal(installedDriver('alpha')?.packageId, 'alpha')
    // A window with the settings panel open has to redraw, and an MCP session
    // has to re-list: the package contributes tools again.
    assert.deepEqual(h.broadcasts, [['alpha']])
    assert.deepEqual(h.toolNotifications, [['alpha']])
  })

  test('nothing missing is an empty list, not a failure — and the tombstones still go', async () => {
    const h = harness(({ packagesRoot, bundledRoot }) => {
      writePackage(bundledRoot, 'alpha', manifestOf('alpha'))
      writePackage(packagesRoot, 'alpha', manifestOf('alpha'))
      // A tombstone for a package that is installed anyway: the shape left
      // behind by uninstalling a bundled id and then installing your own copy
      // under it.
      writeFileSync(
        join(packagesRoot, TOMBSTONE_FILE),
        JSON.stringify({ uninstalled: [{ id: 'alpha', version: '0.0.1', at: '2026-08-11T00:00:00.000Z' }] }),
      )
    })

    const res = await h.bus.dispatch('packages.restore', {}, 'ui')
    assert.equal(res.ok, true)
    if (!res.ok) throw new Error('unreachable')
    assert.deepEqual(res.data.restored, [])
    assert.deepEqual(res.data.failed, [])
    // Something did change, which is why the press is not a no-op and why the
    // windows are told unconditionally: without this the next start would
    // suppress a package the user has just asked to keep.
    assert.deepEqual(readStones(h.packagesRoot), [])
    assert.deepEqual(h.broadcasts, [['alpha']])
  })

  test('an installed copy is never replaced, however old it is (§2.5 rule 2)', async () => {
    const h = harness(({ packagesRoot, bundledRoot }) => {
      writePackage(bundledRoot, 'alpha', manifestOf('alpha', { version: '9.0.0' }))
      writePackage(packagesRoot, 'alpha', manifestOf('alpha', { version: '1.0.0' }))
    })

    const res = await h.bus.dispatch('packages.restore', {}, 'ui')
    assert.equal(res.ok, true)
    if (!res.ok) throw new Error('unreachable')
    // "Restore" restores what is *missing*. Taking the shipped copy here would
    // be the app upgrade stamping on the user's own build, fired from a button
    // that promises the opposite — and it is what the upgrade button is for.
    assert.deepEqual(res.data.restored, [])
    assert.equal(installedDriver('alpha')?.manifest.version, '1.0.0')
    assert.equal(res.data.packages[0]?.upgradeVersion, '9.0.0')
  })
})

describe('a bus with no packages root', () => {
  /** `coreHandlers` only: the stubs, before `main/index.ts` has overwritten them. */
  function unassembled(): CommandBus {
    const bus = new CommandBus({
      store: new WorkspaceStore(createEmptyWorkspace(asPanelId('panel_root'))),
      deps: {
        connections: { async open() { return { capabilities: [] } }, async close() {} },
        results: {
          async runQuery() {},
          async scanCollection() {},
          async vectorSearch() {},
          async cancel() { return true },
        },
      },
      ids: createSeqIdFactory(),
      now: () => 1_000,
    })
    bus.registerAll(coreHandlers)
    return bus
  }

  test('reads as empty, because that is also what a real peek with no packages says', async () => {
    const res = await unassembled().dispatch('packages.read', {}, 'ui')
    assert.equal(res.ok, true)
    if (!res.ok) throw new Error('unreachable')
    assert.deepEqual(res.data.packages, [])
  })

  test('every writing verb refuses rather than answering something plausible', async () => {
    const bus = unassembled()
    for (const [name, input] of [
      ['packages.install', { dir: '/tmp/whatever' }],
      ['packages.uninstall', { id: 'alpha' }],
      ['packages.restore', {}],
    ] as const) {
      const res = await bus.dispatch(name, input, 'ui')
      assert.equal(res.ok, false, `${name} answered instead of refusing`)
      if (res.ok) throw new Error('unreachable')
      assert.equal(res.error.code, 'INTERNAL')
    }
    // `packages.restore` is the one that could most easily have been written as
    // a harmless `{restored: []}` — which is byte-for-byte the reply a working
    // peek gives when nothing was missing, and means the opposite.
  })
})
