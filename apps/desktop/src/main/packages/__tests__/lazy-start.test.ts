import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, afterEach, describe, it } from 'node:test'
import '../../../drivers/__tests__/in-repo-registry'
import type { PostgresConnectionConfig } from '@peek/core'
import { installedDrivers } from '../../../drivers/installed'
import { packageTools } from '../../mcp/package-tools'
import './install-stubs'
import { stubElectron } from './stub-electron'

const { PackageHostRegistry } = await import('../registry')
const { createConnectionDisplayService } = await import('../display')

/* ==================================================================
 * Acceptance item 31: a package that nobody uses costs no process.
 *
 * The claim is about a *number*, and a number is the only thing that can hold
 * it: "we only fork in `hostFor`" is a property of today's call graph, and the
 * paths that must not fork — naming a connection, listing MCP tools, deciding
 * which views a connection can open — are spread across three modules that each
 * looked like a reasonable place to warm a host up. §2.4bis(c) is what item 20
 * (twenty packages do not move cold start) rests on, and neither shows up as a
 * test failure when it goes: the app works, it is just heavier every launch.
 *
 * So these count `utilityProcess.fork` calls, at the Electron boundary, with the
 * real registry and the real host wrapper in between.
 * ================================================================== */

const PG_CONFIG: PostgresConnectionConfig = {
  driverId: 'postgres',
  url: 'postgresql://postgres@localhost:5432/postgres',
}

/** The three strings a package answers `display` with. */
const DISPLAY = { label: 'localhost/postgres', detail: 'PostgreSQL', endpoint: 'localhost:5432' }

/**
 * `hostFor` refuses to fork an entry point that is not on disk, so the bundle it
 * looks for has to exist. Its contents never run — `utilityProcess` is the stub.
 */
const hostDir = mkdtempSync(join(tmpdir(), 'peek-package-host-'))
writeFileSync(join(hostDir, 'package-host.js'), '// never executed; utilityProcess is stubbed\n')

after(() => {
  rmSync(hostDir, { recursive: true, force: true })
})

afterEach(() => {
  stubElectron.reset()
})

function registry(): InstanceType<typeof PackageHostRegistry> {
  // Where a package keeps its `contrib.mjs`, as main answers it from the scan.
  // Never opened — `utilityProcess` is the stub — but a registry that cannot
  // answer it declines to fork, which is the whole of `resolveContrib`.
  return new PackageHostRegistry({
    hostDir,
    forwardStdio: false,
    resolveContrib: (packageId) => `/peek-packages/${packageId}/contrib.mjs`,
  })
}

describe('a package host starts on first use and not before', () => {
  it('registers every package and forks none of them', async () => {
    // Counted off the registry the scan filled, not a table in the app: item 20
    // is about *twenty* packages, and an enumeration compiled into peek could
    // only ever count the ones it was compiled with — it froze N at five and
    // would have gone on reporting five with fifteen more on disk.
    const packageIds = new Set(installedDrivers().map((driver) => driver.packageId))
    assert.ok(packageIds.size >= 5, 'the point of the count is that N is not 1')

    const hosts = registry()

    // Everything main assembles at startup over the full set of packages. Each
    // of these knows how to reach a host; none of them may wake one.
    createConnectionDisplayService(hosts)
    const tools = packageTools((packageId, call) => hosts.call(packageId, 'callTool', call, 1_000))

    assert.ok(tools.length > 0, 'the tools are listed from manifest data in main (§2.4bis d)')
    assert.equal(hosts.runningCount, 0)
    assert.deepEqual(hosts.runningPackageIds(), [])
    assert.equal(
      stubElectron.forks.length,
      0,
      `${String(packageIds.size)} packages registered, zero processes`,
    )
  })

  it('forks exactly the one package that was asked a question', async () => {
    stubElectron.answerWith(DISPLAY)
    const hosts = registry()
    const display = createConnectionDisplayService(hosts)

    const named = await display.describe({ config: PG_CONFIG })

    assert.equal(named.label, DISPLAY.label)
    assert.equal(hosts.runningCount, 1)
    assert.deepEqual(hosts.runningPackageIds(), ['postgres'])
    assert.equal(stubElectron.forks.length, 1)
    // The id is in the fork itself, not only in our map: this is what names the
    // row in Activity Monitor, and what `--package=` tells the child it is.
    assert.equal(stubElectron.forks[0]?.serviceName, 'peek-package-postgres')
    assert.deepEqual(stubElectron.forks[0]?.args, ['--package=postgres'])

    await hosts.disposeAll()
  })

  it('reuses the one process across calls, and forks once even when two arrive together', async () => {
    stubElectron.answerWith(DISPLAY)
    const hosts = registry()
    const display = createConnectionDisplayService(hosts)

    // Both dispatched before either resolves: the second must join the in-flight
    // spawn rather than start a second one and leak it.
    await Promise.all([display.describe({ config: PG_CONFIG }), display.describe({ config: PG_CONFIG })])
    await display.describe({ config: PG_CONFIG })

    assert.equal(stubElectron.forks.length, 1)
    assert.equal(hosts.runningCount, 1)

    await hosts.disposeAll()
    assert.equal(hosts.runningCount, 0, 'quit leaves nothing behind')
  })
})
