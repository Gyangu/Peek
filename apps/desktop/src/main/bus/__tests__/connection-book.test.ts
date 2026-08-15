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
import '../../../drivers/__tests__/in-repo-registry'
import { createEmptyWorkspace, type ConnectionConfig } from '@peek/core'
import { connectionIdentityOf } from '../../../drivers/manifests'
import { DRIVER_DISPLAYS } from '../../../drivers/__tests__/in-repo-displays'
import { labelOf } from '../../packages/display'
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

/**
 * The package host's answer, which the book is handed rather than deriving.
 *
 * These tests stand in for it by producing the same pair synchronously — the
 * strings a real `describeConnection` produces for this config, so every
 * expectation below still reads as "the name this connection has". Main itself
 * may not do this (design §2.3(b-2): naming is package code, and package code
 * does not run in main); a test that is not the main bundle may, and the
 * alternative is hand-written names that agree with nothing.
 *
 * Assembled from its two halves rather than from one function, because that is
 * what the answer *is* (§4nonies): the package derives, and the kernel's
 * `config.label ||` rule sits on top — which is why `label` here is `labelOf`
 * itself, the same one `main/packages/display.ts` applies to a host's reply, and
 * not a copy of it. Two cases below turn on that rule (`a label is not part of
 * the identity`, and the `ssl: true` reconnect), so a copy that drifted from the
 * kernel would keep them green while the shipped path had changed.
 */
function named(config: ConnectionConfig): { label: string; detail: string } {
  const display = DRIVER_DISPLAYS[config.driverId]
  assert.ok(display, `no display is collected for driverId=${config.driverId}`)
  return { label: labelOf(config, () => display.label(config)), detail: display.detail(config) }
}

/** `book.remember` as `main/index.ts` calls it: the config, plus what it is called. */
function remember(book: ReturnType<typeof createConnectionBook>, config: ConnectionConfig): void {
  book.remember(config, named(config))
}

/* ------------------------------------------------------------------ */

describe('what reaches the disk', () => {
  test('a saved connection keeps its shape but loses its password', () => {
    const dir = tempConfigDir()
    const book = bookAt(dir)
    remember(book, pg())

    const text = fileText(dir)
    assert.equal(text.includes('hunter2'), false, 'the password reached the file in the clear')
    assert.ok(text.includes('orders'), 'the database name should be readable — the file exists to be read')

    const [entry] = book.list()
    assert.ok(entry)
    assert.equal(entry.driverId, 'postgres')
    assert.equal(entry.hasSecret, true)
    assert.equal(
      'password' in entry.config,
      false,
      'the listed config must not carry a password field at all',
    )
  })

  test('a password hidden inside a URL is stripped, and the user part survives', () => {
    // The failure this prevents: `redactConnectionConfig` masks a URL password
    // as `***`, which is fine to *show* and fatal to *store* — the stored config
    // is sent back as a config to open, and `***` is a password a driver sends.
    const dir = tempConfigDir()
    const book = bookAt(dir)
    remember(book, { driverId: 'postgres', url: 'postgresql://app:hunter2@localhost:5432/orders' })

    const text = fileText(dir)
    assert.equal(text.includes('hunter2'), false)
    assert.ok(text.includes('postgresql://app@localhost:5432/orders'))

    /*
     * The mask is checked against the **config**, and no longer against the whole
     * file, because since §2.3(b-2) the file also holds the row's tooltip — and a
     * tooltip is a thing being *displayed*, which is exactly what `***` is for.
     * The claim has not moved: what a driver dials is `config`, and `config` has
     * no mask anywhere in it.
     *
     * The two spellings sitting side by side is the point rather than an
     * oversight, so it is asserted rather than tolerated: removal for the copy
     * that will be re-opened, substitution for the copy that will be read.
     */
    const stored = JSON.parse(text) as { entries: { config: unknown; display: { detail: string } }[] }
    const entry = stored.entries[0]
    assert.ok(entry)
    assert.equal(JSON.stringify(entry.config).includes('***'), false, 'a mask would be dialled as a password')
    assert.equal(entry.display.detail, 'postgresql://app:***@localhost:5432/orders')
  })

  test('the file is 0600 inside a 0700 directory', () => {
    const dir = tempConfigDir()
    remember(bookAt(dir), pg())
    assert.equal(statSync(join(dir, CONNECTIONS_FILE_NAME)).mode & 0o777, 0o600)
  })

  test('qdrant stores its API key the same way a password is stored', () => {
    const dir = tempConfigDir()
    const book = bookAt(dir)
    remember(book, { driverId: 'qdrant', url: 'http://localhost:6333', apiKey: 'peek-test-key' })
    assert.equal(fileText(dir).includes('peek-test-key'), false)
    assert.equal(book.list()[0]?.hasSecret, true)
  })

  test('a connection with nothing to hide is stored without a secret', () => {
    const dir = tempConfigDir()
    const book = bookAt(dir)
    remember(book, { driverId: 'sqlite', file: '/tmp/peek.sqlite', readOnly: true })
    assert.equal(book.list()[0]?.hasSecret, false)
  })
})

/* ------------------------------------------------------------------ */
/* What the row is called                                              */
/* ------------------------------------------------------------------ */

/*
 * Design §2.3(b-2). The two strings are *stored* rather than derived on read,
 * because deriving them means running the owning package's code, that code runs
 * in a host process of its own, and `list()` answers on the launch path with the
 * sidebar waiting and no host started.
 *
 * Everything below is about the consequence: a name now has to survive a file,
 * and a name that never arrived must not overwrite one that did.
 */
describe('the name a saved connection carries', () => {
  test('it is written to the file and read back, not recomputed', () => {
    const dir = tempConfigDir()
    remember(bookAt(dir), pg())

    // A string the config cannot produce by being read: the fields are stored
    // separately, so finding this assembled form proves it was written down.
    assert.ok(fileText(dir).includes('postgres://app@localhost:5432/orders'))
    const reloaded = bookAt(dir).list()[0]
    assert.equal(reloaded?.label, 'orders')
    assert.equal(reloaded?.detail, 'postgres://app@localhost:5432/orders')
  })

  test('a connection that could not be named keeps the name it already had', () => {
    // `describeConnection` is a soft intent: a package host that was slow leaves
    // a working connection unnamed, and the connect it was planned in front of
    // succeeds anyway. Writing that blank through would make a display hiccup a
    // permanent downgrade of a row that outlives the process.
    const dir = tempConfigDir()
    const book = bookAt(dir)
    remember(book, pg())
    book.remember(pg(), { label: '', detail: '' })

    const entry = book.list()[0]
    assert.equal(entry?.label, 'orders')
    assert.equal(entry?.detail, 'postgres://app@localhost:5432/orders')
  })

  test('a name that never arrived falls back rather than showing an empty row', () => {
    const dir = tempConfigDir()
    const book = bookAt(dir)
    book.remember(pg(), { label: '', detail: '' })
    book.remember(pg({ database: 'ledger', label: 'the user typed this' }), { label: '', detail: '' })

    const [ledger, orders] = book.list()
    assert.equal(orders?.label, 'postgres', 'with nothing else to go on, the driver id names the row')
    assert.equal(
      orders?.detail,
      '',
      'inventing a long form for a guessed short form would look authoritative',
    )
    assert.equal(ledger?.label, 'the user typed this', 'a name the user typed needs nothing computed')
  })

  test('editing the connection renames the row, through the same one write path', () => {
    // Rule 3: there is no separate "rename" — a changed config is a changed
    // connection, and it goes through `remember` like every other one.
    const dir = tempConfigDir()
    const book = bookAt(dir)
    remember(book, pg({ port: 5433 }))
    assert.equal(book.list()[0]?.detail, 'postgres://app@localhost:5433/orders')

    remember(book, pg({ port: 5433, label: 'staging' }))
    assert.equal(book.list().length, 1, 'a label is not part of the identity')
    assert.equal(book.list()[0]?.label, 'staging')
  })
})

describe('putting the credential back', () => {
  test('a config that arrives without a password gets the saved one', () => {
    const dir = tempConfigDir()
    const book = bookAt(dir)
    remember(book, pg())

    const fromBook = book.list()[0]?.config
    assert.ok(fromBook)
    const hydrated = book.hydrate(fromBook) as Record<string, unknown>
    assert.equal(hydrated['password'], 'hunter2')
  })

  test('a URL connection is dialable again after a round trip through the file', () => {
    const dir = tempConfigDir()
    const book = bookAt(dir)
    remember(book, { driverId: 'postgres', url: 'postgresql://app:hunter2@localhost:5432/orders' })

    const reloaded = bookAt(dir)
    const fromBook = reloaded.list()[0]?.config
    assert.ok(fromBook)
    const hydrated = reloaded.hydrate(fromBook) as Record<string, unknown>
    assert.equal(hydrated['url'], 'postgresql://app:hunter2@localhost:5432/orders')
  })

  test('a typed password wins over the stored one', () => {
    const dir = tempConfigDir()
    const book = bookAt(dir)
    remember(book, pg())
    const hydrated = book.hydrate(pg({ password: 'typed-instead' })) as Record<string, unknown>
    assert.equal(hydrated['password'], 'typed-instead')
  })

  test('a stored password is never sent to a server it was not stored for', () => {
    // Identity is (driver, host, port, database, user). Change any of them and
    // the credential stays behind — which is the whole reason the book is keyed
    // by identity rather than by a row number.
    const dir = tempConfigDir()
    const book = bookAt(dir)
    remember(book, pg())

    for (const elsewhere of [
      pg({ password: undefined, host: 'db.example.com' }),
      pg({ password: undefined, port: 5433 }),
      pg({ password: undefined, user: 'someone-else' }),
      pg({ password: undefined, database: 'other' }),
    ]) {
      const hydrated = book.hydrate(elsewhere) as Record<string, unknown>
      assert.equal(
        hydrated['password'],
        undefined,
        `${connectionIdentityOf(elsewhere)} was handed a saved password`,
      )
    }
  })

  test('settings that are not identity update the entry instead of duplicating it', () => {
    // Ticking TLS is editing a saved connection, not describing a new one.
    const dir = tempConfigDir()
    const book = bookAt(dir)
    remember(book, pg())
    remember(book, pg({ ssl: true, label: 'prod' }))

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
    remember(book, pg())
    const fromBook = book.list()[0]?.config
    assert.ok(fromBook)

    remember(book, fromBook)
    assert.equal(book.list()[0]?.hasSecret, true)
    assert.equal((book.hydrate(fromBook) as Record<string, unknown>)['password'], 'hunter2')
  })
})

describe('when the keychain is not there', () => {
  test('the connection is still saved, and the password is simply not', () => {
    const dir = tempConfigDir()
    const book = bookAt(dir, fakeVault(false))
    remember(book, pg())

    assert.equal(book.secretsAvailable, false)
    assert.equal(fileText(dir).includes('hunter2'), false, 'no keychain must never mean plaintext')
    const [entry] = book.list()
    assert.equal(entry?.hasSecret, false)
    assert.equal(entry?.label, 'orders', 'the connection itself is still worth remembering')
  })

  test('a secret sealed by another machine reads as no secret, not as an error', () => {
    const dir = tempConfigDir()
    remember(bookAt(dir), pg())
    // A keychain reset, a different OS user, a copied dotfile: all land here.
    const reader = bookAt(dir, {
      available: true,
      seal: () => null,
      open: () => null,
    })
    assert.equal(
      (reader.hydrate(pg({ password: undefined })) as Record<string, unknown>)['password'],
      undefined,
    )
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
    assert.equal(
      (entries[0]?.config as Record<string, unknown>)['file'],
      '/tmp/a.db',
      'the wrong row survived',
    )
    // And not `fine`: a top-level `label` next to a row is a key an older peek
    // may have written, and this file has always ignored it. The name it stores
    // now lives under `display` — see `StoredEntry`.
    assert.equal(entries[0]?.label, 'sqlite')
  })

  test('a name is only the user’s when it is in the config', () => {
    const dir = tempConfigDir()
    writeFileSync(
      join(dir, CONNECTIONS_FILE_NAME),
      JSON.stringify({
        version: 1,
        entries: [
          {
            id: 'x',
            label: 'written by an older version',
            config: { driverId: 'sqlite', file: '/tmp/a.db' },
          },
          { id: 'y', config: { driverId: 'sqlite', file: '/tmp/b.db', label: 'scratch' } },
        ],
      }),
    )
    // Neither row has ever been named — `display` is what a name is written
    // under, and no version that wrote these had one. So the first falls all the
    // way back to its driver id (§2.3(b-2) rule 2: no migration pass, no naming
    // at launch, it is named the next time it connects) and the second shows what
    // the user typed, which was never derived and needs nothing computed.
    assert.deepEqual(
      bookAt(dir)
        .list()
        .map((entry) => entry.label),
      ['sqlite', 'scratch'],
    )
  })

  test('a display written into the file is what the row shows', () => {
    const dir = tempConfigDir()
    writeFileSync(
      join(dir, CONNECTIONS_FILE_NAME),
      JSON.stringify({
        version: 1,
        entries: [
          {
            id: 'x',
            config: { driverId: 'sqlite', file: '/tmp/a.db' },
            display: { label: 'named when it last connected', detail: '/tmp/a.db' },
          },
          { id: 'y', config: { driverId: 'sqlite', file: '/tmp/b.db' }, display: { label: 42 } },
        ],
      }),
    )
    const entries = bookAt(dir).list()
    assert.equal(entries[0]?.label, 'named when it last connected')
    assert.equal(entries[0]?.detail, '/tmp/a.db')
    // Half a display is still hand-editable: a non-string is dropped and the
    // fallback takes over, one field at a time, the way one bad row does not
    // cost the other ninety-nine.
    assert.equal(entries[1]?.label, 'sqlite')
    assert.equal(entries[1]?.detail, '')
  })

  test('an id edited to point at another host does not inherit that host password', () => {
    // The id *is* the identity, so it is recomputed on read rather than trusted.
    // Trusting it would be a way to ask for someone else's stored credential by
    // editing a text file.
    const dir = tempConfigDir()
    const book = bookAt(dir)
    remember(book, pg())
    const saved = JSON.parse(fileText(dir)) as { entries: Record<string, unknown>[] }
    const stolen = saved.entries[0]
    assert.ok(stolen)
    stolen['config'] = {
      driverId: 'postgres',
      host: 'evil.example.com',
      port: 5432,
      database: 'x',
      user: 'app',
    }
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
      remember(book, { driverId: 'sqlite', file: `/tmp/peek-${String(i)}.db` })
    }
    const entries = book.list()
    assert.equal(entries.length, MAX_BOOK_ENTRIES)
    // Newest first, so the survivors are the last MAX_BOOK_ENTRIES written.
    assert.equal(
      (entries[0]?.config as Record<string, unknown>)['file'],
      `/tmp/peek-${String(MAX_BOOK_ENTRIES + 4)}.db`,
    )
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
  bus.registerAll(
    createConfigHandlers({ book, mcp, settings, vault: fakeVault(), configDir: dir, version: '0.0.0-test' }),
  )
  return { bus, book }
}

describe('conn.book.* over the Command Bus', () => {
  test('list answers the file, and never the credential', async () => {
    const dir = tempConfigDir()
    const { bus, book } = busWith(dir)
    remember(book, pg())

    const res = await bus.dispatch('conn.book.list', {}, 'ui')
    assert.ok(res.ok)
    assert.equal(res.data.entries.length, 1)
    assert.equal(res.data.secretsAvailable, true)
    assert.equal(JSON.stringify(res.data).includes('hunter2'), false)
  })

  test('forget removes the entry and hands back what is left', async () => {
    const dir = tempConfigDir()
    const { bus, book } = busWith(dir)
    remember(book, pg())
    remember(book, { driverId: 'sqlite', file: '/tmp/keep.db' })
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
    remember(book, pg())
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
