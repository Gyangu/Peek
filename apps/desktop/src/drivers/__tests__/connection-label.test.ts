import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { REDACTED, type ConnectionConfig, type DriverDisplay } from '@peek/core'
import { DRIVER_DISPLAYS } from './in-repo-displays'

/* ==================================================================
 * What a connection is called — all three strings of `DriverDisplay`.
 *
 * `label` goes into a 240px sidebar row that truncates at the end, so it has to
 * carry the part that tells two connections apart — the database, the file name,
 * the host and port — and not the whole connection string, whose discriminating
 * tail is exactly what gets cut. `detail` is the long form the row's tooltip
 * shows. `endpoint` is the one line of address an MCP reader gets.
 *
 * ## Why this file lives here and not in core
 *
 * It used to sit next to `defaultConnectionLabel` / `connectionDetail` in
 * `packages/core`, where both were a `switch` over the six databases peek
 * happened to compile in. Naming a connection is the package's job now
 * (`DriverDisplay`, one implementation per package, chosen by the config's own
 * `driverId`), so there is no single module in core left to assert against — and
 * core may not import a driver package back, which would close the dependency
 * graph into a cycle. `drivers/manifests.ts` is where the six are collected, so
 * this file sits next to them.
 *
 * Every expected value below was computed from the **old** implementation, read
 * out of `git show HEAD:packages/core/src/capability.ts` (`label` / `detail`)
 * and `git show HEAD:packages/driver-<db>/src/manifest.ts` (`endpointSummary`,
 * which each package owned before it became `endpoint`). That is the point and
 * the reason it is worth saying out loud: the displays were moved verbatim, this
 * is the evidence (`docs/design/2026-08-07-database-packages-from-disk.md`
 * §4.1), and an expectation transcribed from the *new* code would assert that
 * the code equals itself.
 *
 * The one part of the old `defaultConnectionLabel` that is **not** here is its
 * opening `config.label ||`: that step is the kernel's rule rather than a
 * package's derivation, and it did not move into the packages. It is asserted
 * where it actually runs — `main/packages/__tests__/connection-display-service.test.ts`
 * (§4nonies). The three functions this file used to call carried a second copy
 * of it and were the copy under test, which is exactly why they are gone.
 * ================================================================== */

/**
 * The display the package host would be handed for this config.
 *
 * `DRIVER_DISPLAYS` directly, and not through a dispatcher in the app: these
 * are the objects each package's `contrib.ts` exports, which is what its host
 * `import()`s, so what is under test is the shipped implementation with nothing
 * in between. The keys are open (`DriverId` is a string), hence the assertion —
 * a typo'd id would otherwise read as `undefined.label is not a function`.
 */
function displayOf(config: ConnectionConfig): DriverDisplay {
  const display: DriverDisplay | undefined = DRIVER_DISPLAYS[config.driverId]
  assert.ok(display, `no display is collected for driverId=${config.driverId}`)
  return display
}

const label = (config: ConnectionConfig): string => displayOf(config).label(config)
const detail = (config: ConnectionConfig): string => displayOf(config).detail(config)
const endpoint = (config: ConnectionConfig): string => displayOf(config).endpoint(config)

describe('label', () => {
  test('sqlite is the file name, not the path', () => {
    assert.equal(label({ driverId: 'sqlite', file: '/private/tmp/claude-501/peek.db' }), 'peek.db')
    assert.equal(label({ driverId: 'sqlite', file: 'peek.db' }), 'peek.db')
    assert.equal(label({ driverId: 'sqlite', file: ':memory:' }), ':memory:')
  })

  test('postgres and mysql prefer the database', () => {
    assert.equal(label({ driverId: 'postgres', host: 'db.internal', database: 'shop' }), 'shop')
    assert.equal(label({ driverId: 'mysql', host: 'db.internal', database: 'shop' }), 'shop')
  })

  test('a URL is read for its database rather than shown whole', () => {
    // The screenshot that started this: `mysql://root@localhost:330…`, with the
    // port and the database — the only distinguishing parts — cut off.
    assert.equal(label({ driverId: 'mysql', url: 'mysql://root@localhost:3306/shop' }), 'shop')
    assert.equal(
      label({ driverId: 'postgres', url: 'postgresql://app:pw@localhost:5432/analytics' }),
      'analytics',
    )
  })

  test('with no database anywhere, the server', () => {
    assert.equal(label({ driverId: 'postgres', url: 'postgresql://app@localhost:5432/' }), 'localhost:5432')
    assert.equal(label({ driverId: 'postgres', host: 'db.internal' }), 'db.internal')
    assert.equal(label({ driverId: 'postgres' }), 'postgres')
  })

  test('redis is the server, and the database index only when it is not 0', () => {
    assert.equal(label({ driverId: 'redis', url: 'redis://localhost:6379' }), 'localhost:6379')
    assert.equal(label({ driverId: 'redis', url: 'redis://localhost:6379/2' }), 'localhost:6379/2')
    assert.equal(label({ driverId: 'redis', host: 'cache', port: 6380, db: 3 }), 'cache:6380/3')
    assert.equal(label({ driverId: 'redis' }), 'localhost:6379')
  })

  test('qdrant is the server', () => {
    assert.equal(label({ driverId: 'qdrant', url: 'http://localhost:6333' }), 'localhost:6333')
  })

  test('neo4j prefers the database, then the server', () => {
    assert.equal(
      label({ driverId: 'neo4j', database: 'movies', host: 'graph.internal', port: 7687 }),
      'movies',
    )
    assert.equal(label({ driverId: 'neo4j', host: 'graph.internal', port: 7687 }), 'graph.internal:7687')
    assert.equal(label({ driverId: 'neo4j', host: 'graph.internal' }), 'graph.internal')
    assert.equal(label({ driverId: 'neo4j' }), 'neo4j')
  })

  test('neo4j reads a URL for its address and never for its database', () => {
    // The asymmetry with postgres is in the old switch and is kept: that branch
    // falls back to `parts?.database`, this one does not. A `/movies` path here
    // is Bolt routing context, not the database the session opens, so a URL with
    // one still names the server.
    assert.equal(label({ driverId: 'neo4j', url: 'bolt://graph.internal:7687' }), 'graph.internal:7687')
    assert.equal(
      label({ driverId: 'neo4j', url: 'bolt://graph.internal:7687/movies' }),
      'graph.internal:7687',
    )
  })

  test('no branch returns a password', () => {
    // The label is broadcast to the renderer and to MCP. Nothing derived from a
    // URL may carry what was in its credentials.
    const configs: ConnectionConfig[] = [
      { driverId: 'postgres', url: 'postgresql://app:hunter2@localhost:5432/shop' },
      { driverId: 'redis', url: 'redis://user:hunter2@localhost:6379' },
      { driverId: 'qdrant', url: 'http://user:hunter2@localhost:6333' },
      // A URL the parser refuses, so the fallback path is the one under test.
      { driverId: 'qdrant', url: 'not a url://x:hunter2@y' },
      { driverId: 'neo4j', url: 'neo4j+s://app:hunter2@graph.example:7687' },
    ]
    for (const cfg of configs) {
      assert.ok(!label(cfg).includes('hunter2'), `${cfg.driverId} leaked its password`)
      assert.ok(!detail(cfg).includes('hunter2'), `${cfg.driverId} detail leaked its password`)
    }
  })
})

describe('detail', () => {
  test('carries what the label had to drop', () => {
    assert.equal(detail({ driverId: 'sqlite', file: '/private/tmp/peek.db' }), '/private/tmp/peek.db')
    assert.equal(
      detail({ driverId: 'postgres', host: 'db.internal', port: 5432, database: 'shop', user: 'app' }),
      'postgres://app@db.internal:5432/shop',
    )
    assert.equal(detail({ driverId: 'redis', host: 'cache', port: 6380, db: 3 }), 'redis://cache:6380/3')
  })

  test('a URL comes back masked, not stripped', () => {
    // This one is for display, so `***` is right — unlike the copy in the book,
    // which has the field removed because it will be sent to a driver.
    assert.equal(
      detail({ driverId: 'postgres', url: 'postgresql://app:hunter2@localhost/shop' }),
      `postgresql://app:${REDACTED}@localhost/shop`,
    )
    assert.equal(
      detail({ driverId: 'neo4j', url: 'neo4j+s://app:hunter2@graph.example:7687' }),
      `neo4j+s://app:${REDACTED}@graph.example:7687`,
    )
  })

  test('neo4j spells bolt:// and its defaults, because no URL was typed', () => {
    // `bolt://` and not `neo4j://`: with no URL there is no routing to speak of,
    // so the tooltip names the single server the host and port point at.
    assert.equal(detail({ driverId: 'neo4j' }), 'bolt://localhost:7687')
    assert.equal(
      detail({ driverId: 'neo4j', host: 'graph.internal', port: 7688, user: 'neo4j', database: 'movies' }),
      'bolt://neo4j@graph.internal:7688/movies',
    )
  })

  test('an empty host drops the address rather than defaulting it', () => {
    // `host: ''` does not reach `?? 'localhost'` — `??` answers null and
    // undefined only — and `hostPort` refuses an empty host, so the whole
    // address fragment vanishes. That is the old behaviour, and it is what the
    // `?? ''` in the display is for: without it the tooltip reads `bolt://undefined`.
    assert.equal(detail({ driverId: 'neo4j', host: '' }), 'bolt://')
  })
})

/* ==================================================================
 * `endpointSummary` — the third string, and the one with no test at all until
 * now.
 *
 * It goes into an MCP receipt rather than onto the screen, which is why the
 * defaults are spelled out where `label` omits them: a model being told where
 * peek connected cannot be expected to know libpq's port. It is also the one of
 * the three that does **not** scrub, because `DriverDisplay.endpoint` is
 * documented as taking an already-redacted config — so the last test here pins
 * "verbatim" rather than "clean", and reading it as a leak would be reading it
 * backwards.
 * ================================================================== */
describe('endpoint', () => {
  test('postgres and mysql spell out the port and database the driver will use', () => {
    assert.equal(endpoint({ driverId: 'postgres' }), 'localhost:5432/')
    assert.equal(
      endpoint({ driverId: 'postgres', host: 'db.internal', port: 5433, database: 'shop' }),
      'db.internal:5433/shop',
    )
    assert.equal(endpoint({ driverId: 'mysql' }), 'localhost:3306/')
    assert.equal(
      endpoint({ driverId: 'mysql', host: 'db.internal', port: 3307, database: 'shop' }),
      'db.internal:3307/shop',
    )
  })

  test('a URL is the address, and an empty one is not a URL', () => {
    // `if (config.url)` and not `config.url !== undefined`, which is what the old
    // `endpointSummary` wrote — and the difference is visible: an empty string
    // falls through to the fields instead of being answered as the address.
    // Redis below takes the opposite branch on the same input, so neither can be
    // "tidied" into the other without a test going red.
    assert.equal(
      endpoint({ driverId: 'postgres', url: 'postgresql://app@db.internal:5432/shop' }),
      'postgresql://app@db.internal:5432/shop',
    )
    assert.equal(
      endpoint({ driverId: 'mysql', url: 'mysql://root@localhost:3306/shop' }),
      'mysql://root@localhost:3306/shop',
    )
    assert.equal(
      endpoint({ driverId: 'postgres', url: '', host: 'db.internal', database: 'shop' }),
      'db.internal:5432/shop',
    )
  })

  test('sqlite is the path, whole', () => {
    // Not the base name: `label` is the one that shortens, and a receipt naming
    // `peek.db` would not say which one.
    assert.equal(endpoint({ driverId: 'sqlite', file: '/private/tmp/peek.db' }), '/private/tmp/peek.db')
    assert.equal(endpoint({ driverId: 'sqlite', file: ':memory:' }), ':memory:')
  })

  test('redis carries the database index even when it is the default one', () => {
    // Unlike `label`, which drops db 0 because every connection is on it. A
    // receipt is read without the other rows for context, so 0 is information.
    assert.equal(endpoint({ driverId: 'redis' }), 'localhost:6379/0')
    assert.equal(endpoint({ driverId: 'redis', host: 'cache', port: 6380, db: 3 }), 'cache:6380/3')
    assert.equal(endpoint({ driverId: 'redis', url: 'redis://localhost:6379/2' }), 'redis://localhost:6379/2')
    // `??`, where postgres uses truthiness — the empty URL wins here.
    assert.equal(endpoint({ driverId: 'redis', url: '', host: 'cache' }), '')
  })

  test('qdrant is the URL and nothing else', () => {
    assert.equal(endpoint({ driverId: 'qdrant', url: 'http://localhost:6333' }), 'http://localhost:6333')
    assert.equal(
      endpoint({ driverId: 'qdrant', url: 'https://vector.example:6333' }),
      'https://vector.example:6333',
    )
  })

  test('neo4j appends the database to whichever address it found', () => {
    assert.equal(endpoint({ driverId: 'neo4j' }), 'bolt://localhost:7687')
    assert.equal(
      endpoint({ driverId: 'neo4j', host: 'graph.internal', port: 7688 }),
      'bolt://graph.internal:7688',
    )
    assert.equal(endpoint({ driverId: 'neo4j', database: 'movies' }), 'bolt://localhost:7687/movies')
    assert.equal(
      endpoint({ driverId: 'neo4j', url: 'neo4j+s://graph.example:7687', database: 'movies' }),
      'neo4j+s://graph.example:7687/movies',
    )
  })

  test('the config arrives redacted, so the URL is repeated as given', () => {
    // The contract, not an oversight: `endpoint` is handed the output of
    // `redactConnectionConfig`, so a `***` in the string is what a correct
    // caller produced. Scrubbing again here would be harmless; *stripping* the
    // userinfo would change the address a model is told peek connected to.
    assert.equal(
      endpoint({ driverId: 'qdrant', url: `https://app:${REDACTED}@vector.example:6333` }),
      `https://app:${REDACTED}@vector.example:6333`,
    )
    assert.equal(
      endpoint({ driverId: 'redis', url: `redis://user:${REDACTED}@cache:6379/2` }),
      `redis://user:${REDACTED}@cache:6379/2`,
    )
  })
})
