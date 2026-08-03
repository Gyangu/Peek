/**
 * The connection book, and the two commands that read it.
 *
 * What is actually at stake here is a promise the README made and this feature
 * breaks on purpose: peek now keeps something on disk. So most of these tests are
 * about the *shape of the breakage* rather than about saving and loading —
 *
 *   - a password never reaches the file in the clear, on any path, including the
 *     one where it was hidden inside a connection URL;
 *   - a saved credential is only ever replayed at the server it was saved for;
 *   - a typed password beats a stored one;
 *   - and when the OS keychain is unavailable, the connection is still saved and
 *     the password is simply not — the one failure mode that must never
 *     degrade into "write it in the clear".
 *
 * The rest pins the file being hand-editable: it is under `~/.peek` precisely so
 * a human can read it, which means a human can also break it, and one bad row
 * must not cost the other ninety-nine.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { connectionIdentity, createEmptyWorkspace, type ConnectionConfig } from '@peek/core'
import { WorkspaceStore } from '../../store/workspace-store'
import { createConnectionBook, MAX_BOOK_ENTRIES } from '../../config/connection-book'
import { createConfigHandlers } from '../../config/handlers'
import { createMcpController } from '../../config/mcp-controller'
import { createSettingsStore } from '../../config/settings'
import { CONNECTIONS_FILE_NAME } from '../../config/paths'
import type { SecretVault } from '../../config/secrets'
import { CommandBus } from '../command-bus'
import type { CommandDeps } from '../deps'
import { coreHandlers } from '../handlers'

/* ------------------------------------------------------------------ */
/* Harness                                                             */
/* ------------------------------------------------------------------ */

const tempDirs: string[] = []

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

function tempConfigDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'peek-book-'))
  tempDirs.push(dir)
  return dir
}

/**
 * A vault that is reversible but not readable.
 *
 * The marker prefix is what lets a test assert "the password is not in the
 * file" and mean it: a plain base64 round trip would leave the secret
 * recoverable by eye, which is exactly the property under test.
 */
function fakeVault(available = true): SecretVault {
  return {
    available,
    seal: (plaintext) => (available ? `sealed:${Buffer.from(plaintext, 'utf8').toString('base64')}` : null),
    open: (sealed) =>
      available && sealed.startsWith('sealed:')
        ? Buffer.from(sealed.slice('sealed:'.length), 'base64').toString('utf8')
        : null,
  }
}

function bookAt(dir: string, vault: SecretVault = fakeVault()): ReturnType<typeof createConnectionBook> {
  return createConnectionBook({ configDir: dir, vault })
}

function fileText(dir: string): string {
  return readFileSync(join(dir, CONNECTIONS_FILE_NAME), 'utf8')
}

const pg = (overrides: Partial<Record<string, unknown>> = {}): ConnectionConfig =>
  ({
    driverId: 'postgres',
    host: 'localhost',
    port: 5432,
    database: 'orders',
    user: 'app',
    password: 'hunter2',
    ...overrides,
  }) as ConnectionConfig

/* ------------------------------------------------------------------ */

describe('what reaches the disk', () => {
  test('a saved connection keeps its shape but loses its password', () => {
    const dir = tempConfigDir()
    const book = bookAt(dir)
    book.remember(pg())

    const text = fileText(dir)
    assert.equal(text.includes('hunter2'), false, 'the password reached the file in the clear')
    assert.ok(text.includes('orders'), 'the database name should be readable — the file exists to be read')

    const [entry] = book.list()
    assert.ok(entry)
    assert.equal(entry.driverId, 'postgres')
    assert.equal(entry.hasSecret, true)
    assert.equal('password' in entry.config, false, 'the listed config must not carry a password field at all')
  })

  test('a password hidden inside a URL is stripped, and the user part survives', () => {
    // The failure this prevents: `redactConnectionConfig` masks a URL password
    // as `***`, which is fine to *show* and fatal to *store* — the stored config
    // is sent back as a config to open, and `***` is a password a driver sends.
    const dir = tempConfigDir()
    const book = bookAt(dir)
    book.remember({ driverId: 'postgres', url: 'postgresql://app:hunter2@localhost:5432/orders' })

    const text = fileText(dir)
    assert.equal(text.includes('hunter2'), false)
    assert.equal(text.includes('***'), false, 'a mask would be dialled as a password')
    assert.ok(text.includes('postgresql://app@localhost:5432/orders'))
  })

  test('the file is 0600 inside a 0700 directory', () => {
    const dir = tempConfigDir()
    bookAt(dir).remember(pg())
    assert.equal(statSync(join(dir, CONNECTIONS_FILE_NAME)).mode & 0o777, 0o600)
  })

  test('qdrant stores its API key the same way a password is stored', () => {
    const dir = tempConfigDir()
    const book = bookAt(dir)
    book.remember({ driverId: 'qdrant', url: 'http://localhost:6333', apiKey: 'peek-test-key' })
    assert.equal(fileText(dir).includes('peek-test-key'), false)
    assert.equal(book.list()[0]?.hasSecret, true)
  })

  test('a connection with nothing to hide is stored without a secret', () => {
    const dir = tempConfigDir()
    const book = bookAt(dir)
    book.remember({ driverId: 'sqlite', file: '/tmp/peek.sqlite', readOnly: true })
    assert.equal(book.list()[0]?.hasSecret, false)
  })
})

describe('putting the credential back', () => {
  test('a config that arrives without a password gets the saved one', () => {
    const dir = tempConfigDir()
    const book = bookAt(dir)
    book.remember(pg())

    const fromBook = book.list()[0]?.config
    assert.ok(fromBook)
    const hydrated = book.hydrate(fromBook) as Record<string, unknown>
    assert.equal(hydrated['password'], 'hunter2')
  })

  test('a URL connection is dialable again after a round trip through the file', () => {
    const dir = tempConfigDir()
    const book = bookAt(dir)
    book.remember({ driverId: 'postgres', url: 'postgresql://app:hunter2@localhost:5432/orders' })

    const reloaded = bookAt(dir)
    const fromBook = reloaded.list()[0]?.config
    assert.ok(fromBook)
    const hydrated = reloaded.hydrate(fromBook) as Record<string, unknown>
    assert.equal(hydrated['url'], 'postgresql://app:hunter2@localhost:5432/orders')
  })

  test('a typed password wins over the stored one', () => {
    const dir = tempConfigDir()
    const book = bookAt(dir)
    book.remember(pg())
    const hydrated = book.hydrate(pg({ password: 'typed-instead' })) as Record<string, unknown>
    assert.equal(hydrated['password'], 'typed-instead')
  })

  test('a stored password is never sent to a server it was not stored for', () => {
    // Identity is (driver, host, port, database, user). Change any of them and
    // the credential stays behind — which is the whole reason the book is keyed
    // by identity rather than by a row number.
    const dir = tempConfigDir()
    const book = bookAt(dir)
    book.remember(pg())

    for (const elsewhere of [
      pg({ password: undefined, host: 'db.example.com' }),
      pg({ password: undefined, port: 5433 }),
      pg({ password: undefined, user: 'someone-else' }),
      pg({ password: undefined, database: 'other' }),
    ]) {
      const hydrated = book.hydrate(elsewhere) as Record<string, unknown>
      assert.equal(hydrated['password'], undefined, `${connectionIdentity(elsewhere)} was handed a saved password`)
    }
  })

  test('settings that are not identity update the entry instead of duplicating it', () => {
    // Ticking TLS is editing a saved connection, not describing a new one.
    const dir = tempConfigDir()
    const book = bookAt(dir)
    book.remember(pg())
    book.remember(pg({ ssl: true, label: 'prod' }))

    assert.equal(book.list().length, 1)
    const [entry] = book.list()
    assert.equal(entry?.label, 'prod')
    assert.equal((entry?.config as Record<string, unknown>)['ssl'], true)
  })

  test('re-opening from the book does not erase the password it made reusable', () => {
    // The config coming back out has no password by construction, so a naive
    // "overwrite the secret on every save" would empty the vault on first reuse.
    const dir = tempConfigDir()
    const book = bookAt(dir)
    book.remember(pg())
    const fromBook = book.list()[0]?.config
    assert.ok(fromBook)

    book.remember(fromBook)
    assert.equal(book.list()[0]?.hasSecret, true)
    assert.equal((book.hydrate(fromBook) as Record<string, unknown>)['password'], 'hunter2')
  })
})

describe('when the keychain is not there', () => {
  test('the connection is still saved, and the password is simply not', () => {
    const dir = tempConfigDir()
    const book = bookAt(dir, fakeVault(false))
    book.remember(pg())

    assert.equal(book.secretsAvailable, false)
    assert.equal(fileText(dir).includes('hunter2'), false, 'no keychain must never mean plaintext')
    const [entry] = book.list()
    assert.equal(entry?.hasSecret, false)
    assert.equal(entry?.label, 'orders', 'the connection itself is still worth remembering')
  })

  test('a secret sealed by another machine reads as no secret, not as an error', () => {
    const dir = tempConfigDir()
    bookAt(dir).remember(pg())
    // A keychain reset, a different OS user, a copied dotfile: all land here.
    const reader = bookAt(dir, {
      available: true,
      seal: () => null,
      open: () => null,
    })
    assert.equal((reader.hydrate(pg({ password: undefined })) as Record<string, unknown>)['password'], undefined)
  })
})

describe('the file is hand-editable, so it is also breakable', () => {
  test('a corrupt file reads as an empty book rather than taking the app down', () => {
    const dir = tempConfigDir()
    writeFileSync(join(dir, CONNECTIONS_FILE_NAME), '{ not json at all')
    assert.deepEqual(bookAt(dir).list(), [])
  })

  test('one unusable row does not cost the others', () => {
    const dir = tempConfigDir()
    writeFileSync(
      join(dir, CONNECTIONS_FILE_NAME),
      JSON.stringify({
        version: 1,
        entries: [
          { id: 'x', label: 'broken', config: { driverId: 'nope' } },
          { id: 'y', label: 'fine', config: { driverId: 'sqlite', file: '/tmp/a.db' } },
        ],
      }),
    )
    const entries = bookAt(dir).list()
    assert.equal(entries.length, 1)
    // The name comes from the config, not from the `label` key next to it: the
    // display name is derived, and a copy on disk would freeze it at whatever
    // the version that wrote the file happened to derive.
    assert.equal(entries[0]?.label, 'a.db')
  })

  test('a name is only the user’s when it is in the config', () => {
    const dir = tempConfigDir()
    writeFileSync(
      join(dir, CONNECTIONS_FILE_NAME),
      JSON.stringify({
        version: 1,
        entries: [
          { id: 'x', label: 'written by an older version', config: { driverId: 'sqlite', file: '/tmp/a.db' } },
          { id: 'y', config: { driverId: 'sqlite', file: '/tmp/b.db', label: 'scratch' } },
        ],
      }),
    )
    assert.deepEqual(
      bookAt(dir)
        .list()
        .map((entry) => entry.label),
      ['a.db', 'scratch'],
    )
  })

  test('an id edited to point at another host does not inherit that host password', () => {
    // The id *is* the identity, so it is recomputed on read rather than trusted.
    // Trusting it would be a way to ask for someone else's stored credential by
    // editing a text file.
    const dir = tempConfigDir()
    const book = bookAt(dir)
    book.remember(pg())
    const saved = JSON.parse(fileText(dir)) as { entries: Record<string, unknown>[] }
    const stolen = saved.entries[0]
    assert.ok(stolen)
    stolen['config'] = { driverId: 'postgres', host: 'evil.example.com', port: 5432, database: 'x', user: 'app' }
    writeFileSync(join(dir, CONNECTIONS_FILE_NAME), JSON.stringify(saved))

    const reloaded = bookAt(dir)
    const entry = reloaded.list()[0]
    assert.ok(entry)
    const hydrated = reloaded.hydrate(entry.config) as Record<string, unknown>
    assert.equal(hydrated['password'], undefined, 'a rewritten host was handed the previous host password')
  })

  test('the book is capped, oldest use first out', () => {
    const dir = tempConfigDir()
    const book = bookAt(dir)
    for (let i = 0; i < MAX_BOOK_ENTRIES + 5; i += 1) {
      book.remember({ driverId: 'sqlite', file: `/tmp/peek-${String(i)}.db` })
    }
    const entries = book.list()
    assert.equal(entries.length, MAX_BOOK_ENTRIES)
    // Newest first, so the survivors are the last MAX_BOOK_ENTRIES written.
    assert.equal((entries[0]?.config as Record<string, unknown>)['file'], `/tmp/peek-${String(MAX_BOOK_ENTRIES + 4)}.db`)
  })
})

/* ------------------------------------------------------------------ */
/* Through the real bus                                                */
/* ------------------------------------------------------------------ */

const inertDeps: CommandDeps = {
  connections: { open: async () => ({ capabilities: [] }), close: async () => {} },
  results: {
    runQuery: async () => {},
    scanCollection: async () => {},
    vectorSearch: async () => {},
    cancel: async () => true,
  },
  notify: () => {},
}

function busWith(dir: string): { bus: CommandBus; book: ReturnType<typeof createConnectionBook> } {
  const store = new WorkspaceStore(createEmptyWorkspace())
  const bus = new CommandBus({ store, deps: inertDeps })
  bus.registerAll(coreHandlers)
  const book = bookAt(dir)
  // One store for both, as in main: two would each cache the file and the second
  // write would drop the first.
  const settings = createSettingsStore(dir)
  const mcp = createMcpController({
    configDir: dir,
    settings,
    create: () => {
      throw new Error('not started in this test')
    },
    notify: () => {},
    log: () => {},
    onEndpoint: () => {},
  })
  bus.registerAll(createConfigHandlers({ book, mcp, settings, vault: fakeVault(), configDir: dir, version: '0.0.0-test' }))
  return { bus, book }
}

describe('conn.book.* over the Command Bus', () => {
  test('list answers the file, and never the credential', async () => {
    const dir = tempConfigDir()
    const { bus, book } = busWith(dir)
    book.remember(pg())

    const res = await bus.dispatch('conn.book.list', {}, 'ui')
    assert.ok(res.ok)
    assert.equal(res.data.entries.length, 1)
    assert.equal(res.data.secretsAvailable, true)
    assert.equal(JSON.stringify(res.data).includes('hunter2'), false)
  })

  test('forget removes the entry and hands back what is left', async () => {
    const dir = tempConfigDir()
    const { bus, book } = busWith(dir)
    book.remember(pg())
    book.remember({ driverId: 'sqlite', file: '/tmp/keep.db' })
    const target = book.list().find((entry) => entry.driverId === 'postgres')
    assert.ok(target)

    const res = await bus.dispatch('conn.book.forget', { id: target.id }, 'ui')
    assert.ok(res.ok)
    assert.equal(res.data.removed, true)
    assert.deepEqual(
      res.data.entries.map((entry) => entry.driverId),
      ['sqlite'],
    )
  })

  test('forgetting something already gone is a no-op, not a failure', async () => {
    const { bus } = busWith(tempConfigDir())
    const res = await bus.dispatch('conn.book.forget', { id: 'never-existed' }, 'ui')
    assert.ok(res.ok)
    assert.equal(res.data.removed, false)
  })

  test('reading the book bumps no revision — it is not Workspace state', async () => {
    const dir = tempConfigDir()
    const { bus, book } = busWith(dir)
    book.remember(pg())
    const before = bus.store.rev
    await bus.dispatch('conn.book.list', {}, 'ui')
    await bus.dispatch('conn.book.forget', { id: book.list()[0]?.id ?? 'x' }, 'ui')
    assert.equal(bus.store.rev, before)
  })

  test('a malformed id is refused by the schema, before any handler runs', async () => {
    const { bus } = busWith(tempConfigDir())
    const res = await bus.dispatch('conn.book.forget', { id: '' }, 'ui')
    assert.equal(res.ok, false)
  })
})
