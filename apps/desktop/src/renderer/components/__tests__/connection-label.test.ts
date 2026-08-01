import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { connectionDetail, defaultConnectionLabel, REDACTED, type ConnectionConfig } from '@peek/core'

/* ==================================================================
 * What a connection is called in a 240px sidebar row.
 *
 * The row truncates at the end, so the name has to carry the part that tells
 * two connections apart — the database, the file name, the host and port — and
 * not the whole connection string, whose discriminating tail is exactly what
 * gets cut. The long form moves to `connectionDetail` and the tooltip.
 * ================================================================== */

describe('defaultConnectionLabel', () => {
  test('a name the user typed always wins', () => {
    const cfg: ConnectionConfig = { driverId: 'sqlite', file: '/tmp/a.db', label: 'scratch' }
    assert.equal(defaultConnectionLabel(cfg), 'scratch')
  })

  test('sqlite is the file name, not the path', () => {
    assert.equal(defaultConnectionLabel({ driverId: 'sqlite', file: '/private/tmp/claude-501/peek.db' }), 'peek.db')
    assert.equal(defaultConnectionLabel({ driverId: 'sqlite', file: 'peek.db' }), 'peek.db')
    assert.equal(defaultConnectionLabel({ driverId: 'sqlite', file: ':memory:' }), ':memory:')
  })

  test('postgres and mysql prefer the database', () => {
    assert.equal(defaultConnectionLabel({ driverId: 'postgres', host: 'db.internal', database: 'shop' }), 'shop')
    assert.equal(defaultConnectionLabel({ driverId: 'mysql', host: 'db.internal', database: 'shop' }), 'shop')
  })

  test('a URL is read for its database rather than shown whole', () => {
    // The screenshot that started this: `mysql://root@localhost:330…`, with the
    // port and the database — the only distinguishing parts — cut off.
    assert.equal(defaultConnectionLabel({ driverId: 'mysql', url: 'mysql://root@localhost:3306/shop' }), 'shop')
    assert.equal(
      defaultConnectionLabel({ driverId: 'postgres', url: 'postgresql://app:pw@localhost:5432/analytics' }),
      'analytics',
    )
  })

  test('with no database anywhere, the server', () => {
    assert.equal(defaultConnectionLabel({ driverId: 'postgres', url: 'postgresql://app@localhost:5432/' }), 'localhost:5432')
    assert.equal(defaultConnectionLabel({ driverId: 'postgres', host: 'db.internal' }), 'db.internal')
    assert.equal(defaultConnectionLabel({ driverId: 'postgres' }), 'postgres')
  })

  test('redis is the server, and the database index only when it is not 0', () => {
    assert.equal(defaultConnectionLabel({ driverId: 'redis', url: 'redis://localhost:6379' }), 'localhost:6379')
    assert.equal(defaultConnectionLabel({ driverId: 'redis', url: 'redis://localhost:6379/2' }), 'localhost:6379/2')
    assert.equal(defaultConnectionLabel({ driverId: 'redis', host: 'cache', port: 6380, db: 3 }), 'cache:6380/3')
    assert.equal(defaultConnectionLabel({ driverId: 'redis' }), 'localhost:6379')
  })

  test('qdrant is the server', () => {
    assert.equal(defaultConnectionLabel({ driverId: 'qdrant', url: 'http://localhost:6333' }), 'localhost:6333')
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
    ]
    for (const cfg of configs) {
      assert.ok(!defaultConnectionLabel(cfg).includes('hunter2'), `${cfg.driverId} leaked its password`)
      assert.ok(!connectionDetail(cfg).includes('hunter2'), `${cfg.driverId} detail leaked its password`)
    }
  })
})

describe('connectionDetail', () => {
  test('carries what the label had to drop', () => {
    assert.equal(connectionDetail({ driverId: 'sqlite', file: '/private/tmp/peek.db' }), '/private/tmp/peek.db')
    assert.equal(
      connectionDetail({ driverId: 'postgres', host: 'db.internal', port: 5432, database: 'shop', user: 'app' }),
      'postgres://app@db.internal:5432/shop',
    )
    assert.equal(connectionDetail({ driverId: 'redis', host: 'cache', port: 6380, db: 3 }), 'redis://cache:6380/3')
  })

  test('a URL comes back masked, not stripped', () => {
    // This one is for display, so `***` is right — unlike the copy in the book,
    // which has the field removed because it will be sent to a driver.
    assert.equal(
      connectionDetail({ driverId: 'postgres', url: 'postgresql://app:hunter2@localhost/shop' }),
      `postgresql://app:${REDACTED}@localhost/shop`,
    )
  })
})
