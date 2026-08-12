import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import '../../../drivers/__tests__/in-repo-registry'
import {
  redactConnectionConfig,
  type ConnId,
  type ConnectionConfig,
  type ConnectionState,
  type SavedConnection,
} from '@peek/core'
import { connectionIdentityOf, redactRulesFor } from '../../../drivers/manifests'
import { DRIVER_DISPLAYS } from '../../../drivers/__tests__/in-repo-displays'
import { buildConnectionRows } from '../connectionRows'

/* ==================================================================
 * The sidebar's row model.
 *
 * One connection is one row, whether it is open right now, only in the
 * connection book, or both. Before this the sidebar drew two lists and every
 * open connection appeared twice — see
 * docs/design/2026-08-02-connection-list.md.
 *
 * Everything here is pure: no DOM, no driver process, no file.
 * ================================================================== */

let seq = 0

/**
 * The tooltip string, derived the way the owning package's host derives it.
 *
 * Straight off `DRIVER_DISPLAYS` — the same objects the owning package compiles
 * into its `contrib.mjs` — because there is no app-side spelling of it left to
 * borrow (§4nonies).
 * Unlike `label`, `detail` carries no kernel rule on top, so this one call *is*
 * the whole answer.
 */
function detailOf(config: ConnectionConfig): string {
  const display = DRIVER_DISPLAYS[config.driverId]
  assert.ok(display, `no display is collected for driverId=${config.driverId}`)
  return display.detail(config)
}

function live(config: ConnectionConfig, over: Partial<ConnectionState> = {}): ConnectionState {
  seq += 1
  // The renderer never sees a cleartext config; everything crossing out of main
  // is redacted, and the row model has to work on that.
  const shown = redactConnectionConfig(config, redactRulesFor(config.driverId))
  return {
    id: `c${seq}` as ConnId,
    driverId: config.driverId,
    // Spelled the way `conn.open` spells it — identity off the config as it
    // arrived, detail off the redacted copy — because the point of these two
    // being fields at all is that the window reads main's answer instead of
    // deriving its own. A fixture that derived them differently would test a
    // sidebar nobody ships.
    identity: connectionIdentityOf(config),
    label: '',
    detail: detailOf(shown),
    // Never read by a row; present because `ConnectionState` requires it.
    endpoint: '',
    status: 'ready',
    capabilities: [],
    config: shown,
    ...over,
  }
}

/** What the book hands back: credentials removed rather than masked. */
function saved(config: ConnectionConfig, over: Partial<SavedConnection> = {}): SavedConnection {
  const stripped = stripSecrets(config)
  return {
    id: `id:${connectionIdentityOf(stripped)}`,
    driverId: config.driverId,
    // Derived from the book's own stripped copy, as `toSavedConnection` does.
    // The live side above starts from the raw config, so the pairing tests only
    // pass while the two spellings agree — which is what keeps them from being
    // a comparison of one string with itself, and what the suite below pins.
    identity: connectionIdentityOf(stripped),
    label: 'entry',
    detail: detailOf(stripped),
    config: stripped,
    hasSecret: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    lastUsedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  }
}

/** main's `stripSecrets`, reproduced here so the test does not import from main. */
function stripSecrets(config: ConnectionConfig): ConnectionConfig {
  const draft = { ...config } as Record<string, unknown>
  delete draft['password']
  delete draft['apiKey']
  if (typeof draft['url'] === 'string') {
    draft['url'] = draft['url'].replace(/(:\/\/[^:/@]*):[^@]*@/, '$1@')
  }
  return draft as ConnectionConfig
}

const PG: ConnectionConfig = {
  driverId: 'postgres',
  host: 'localhost',
  port: 5432,
  database: 'shop',
  user: 'app',
  password: 'hunter2',
}
const PG_URL: ConnectionConfig = { driverId: 'postgres', url: 'postgresql://app:hunter2@localhost:5432/shop' }
const REDIS: ConnectionConfig = { driverId: 'redis', host: 'localhost', port: 6379 }

describe('identity survives redaction', () => {
  // The whole merge rests on this. It used to rest on it in this file: the
  // renderer computed an identity from a redacted config (`://user:***@host`)
  // and it had to equal the one main computed from a stripped one
  // (`://user@host`). The window no longer computes either — both sides arrive
  // carrying main's answer — but that only moved the requirement, it did not
  // remove it: `conn.open` keys a live connection off the config as it arrived
  // and the book keys its entry off a stripped copy, so a redaction that
  // disturbed the identity would break the pairing in main instead, one layer
  // further from anything that would notice.
  for (const [name, config] of [
    ['fields', PG],
    ['url', PG_URL],
    ['qdrant api key', { driverId: 'qdrant', url: 'http://localhost:6333', apiKey: 'k' } as ConnectionConfig],
  ] as const) {
    test(name, () => {
      assert.equal(
        connectionIdentityOf(redactConnectionConfig(config, redactRulesFor(config.driverId))),
        connectionIdentityOf(stripSecrets(config)),
      )
    })
  }
})

describe('buildConnectionRows', () => {
  test('a live connection and its entry are one row, not two', () => {
    const rows = buildConnectionRows([live(PG)], [saved(PG)])
    assert.equal(rows.length, 1)
    assert.ok(rows[0]?.conn, 'the row keeps the live side')
    assert.ok(rows[0]?.entry, 'and the saved side')
  })

  test('the same connection spelled as a URL still pairs up', () => {
    const rows = buildConnectionRows([live(PG_URL)], [saved(PG_URL)])
    assert.equal(rows.length, 1)
    assert.ok(rows[0]?.entry)
  })

  test('an entry with nothing open is a row of its own', () => {
    const rows = buildConnectionRows([], [saved(PG), saved(REDIS)])
    assert.equal(rows.length, 2)
    assert.ok(rows.every((row) => row.conn === undefined))
  })

  test('a live connection the book never recorded still gets a row, first', () => {
    // `remember` returns null rather than throwing, and a failed open is never
    // remembered at all — an error row is normally exactly this case.
    const rows = buildConnectionRows([live(REDIS)], [saved(PG)])
    assert.equal(rows.length, 2)
    assert.ok(rows[0]?.conn, 'the unrecorded live connection sorts above the book')
    assert.equal(rows[0]?.entry, undefined)
  })

  test('two connections on one config keep two rows', () => {
    // The UI does not offer this; MCP can. One row standing for two live
    // connections would put a disconnect on screen that closes an arbitrary one.
    const rows = buildConnectionRows([live(PG), live(PG)], [saved(PG)])
    assert.equal(rows.length, 2)
    assert.equal(new Set(rows.map((row) => row.key)).size, 2, 'keys stay unique')
  })

  test('same name on different hosts does not pair up', () => {
    // The bug this replaces: pairing on the label made one host's row believe
    // the other host was already open.
    const here: ConnectionConfig = { driverId: 'postgres', host: 'a.internal', database: 'shop' }
    const there: ConnectionConfig = { driverId: 'postgres', host: 'b.internal', database: 'shop' }
    const rows = buildConnectionRows([live(here)], [saved(there)])
    assert.equal(rows.length, 2)
    assert.equal(rows.find((row) => row.conn)?.entry, undefined, 'the live row claimed the wrong entry')
  })

  test('newest use first', () => {
    const old = saved(PG, { lastUsedAt: '2026-01-01T00:00:00.000Z' })
    const recent = saved(REDIS, { lastUsedAt: '2026-06-01T00:00:00.000Z' })
    const rows = buildConnectionRows([], [old, recent])
    assert.deepEqual(
      rows.map((row) => row.entry?.driverId),
      ['redis', 'postgres'],
    )
  })

  test('nothing at all is no rows', () => {
    assert.deepEqual(buildConnectionRows([], []), [])
  })

  test('the live label wins over the entry label', () => {
    const rows = buildConnectionRows([live(PG, { label: 'from workspace' })], [saved(PG)])
    assert.equal(rows[0]?.label, 'from workspace')
  })
})
