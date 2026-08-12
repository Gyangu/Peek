import assert from 'node:assert/strict'
import { test } from 'node:test'
import '../../../drivers/__tests__/in-repo-registry'
import {
  createEmptyWorkspace,
  asPanelId,
  peekError,
  type Capability,
  type ConnId,
  type PostgresConnectionConfig,
} from '@peek/core'
import { WorkspaceStore } from '../../store/workspace-store'
import { CommandBus } from '../command-bus'
import { coreHandlers } from '../handlers'
import { createSeqIdFactory } from '../ids'
import type { CommandDeps, ConnectionDisplayService } from '../deps'

/* ==================================================================
 * Naming a connection is asynchronous now. These are the four things that
 * has to keep being true.
 *
 * The strings come from the package that owns the driver, which runs in its own
 * process (design 2026-08-07 §2.4bis), while a Command reduction is synchronous
 * and stays that way. §2.3(b) prescribes the split — seed in the reducer, patch
 * the answer in from an effect — and every failure mode of that split is a name
 * on screen that is wrong rather than an error anyone sees: blank, or stuck at
 * what the config used to say, or a connection that refuses to open because a
 * host was slow.
 *
 * Deliberately not tested here: what the strings *are*. That is the package's
 * own answer, covered by `drivers/__tests__/connection-label.test.ts`; this file
 * only cares that whatever it answers arrives.
 * ================================================================== */

const PG_CONFIG: PostgresConnectionConfig = {
  driverId: 'postgres',
  url: 'postgresql://postgres:example-password@localhost:5432/postgres',
  password: 'example-password',
}

const PG_CAPS: Capability[] = ['tabularQuery']

interface Harness {
  bus: CommandBus
  store: WorkspaceStore
  /** The driver of every config the display service was asked about, in order. */
  asked: string[]
  /** What each connection was called at the moment the connect effect ran. */
  namedAtConnect: (string | undefined)[]
}

function harness(display: ConnectionDisplayService | null): Harness {
  const asked: string[] = []
  const namedAtConnect: (string | undefined)[] = []
  const store = new WorkspaceStore(createEmptyWorkspace(asPanelId('panel_root')))
  const deps: CommandDeps = {
    connections: {
      async open(req) {
        // Read at the one moment the connection book cares about: `main/index.ts`
        // calls `book.remember` right here, with the pair it reads off the store.
        namedAtConnect.push(store.getState().connections[req.connId]?.label)
        return { capabilities: PG_CAPS }
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
    ...(display === null
      ? {}
      : {
          display: {
            async describe(req) {
              asked.push(req.config.driverId)
              return await display.describe(req)
            },
          },
        }),
  }
  const bus = new CommandBus({ store, deps, ids: createSeqIdFactory(), now: () => 1_000 })
  bus.registerAll(coreHandlers)
  return { bus, store, asked, namedAtConnect }
}

function fixedDisplay(label: string): ConnectionDisplayService {
  return {
    async describe() {
      return { label, detail: `detail:${label}`, endpoint: `endpoint:${label}` }
    },
  }
}

function connOf(h: Harness, connId: ConnId): { label: string; detail: string; endpoint: string } {
  const conn = h.store.getState().connections[connId]
  assert.ok(conn, `connection ${connId} is gone`)
  return { label: conn.label, detail: conn.detail, endpoint: conn.endpoint }
}

async function open(h: Harness, connId?: ConnId): Promise<ConnId> {
  const res = await h.bus.dispatch(
    'conn.open',
    { config: PG_CONFIG, ...(connId === undefined ? {} : { connId }) },
    'ui',
  )
  assert.equal(res.ok, true, `conn.open failed: ${res.ok ? '' : res.error.message}`)
  assert.ok(res.ok)
  return res.data.connId
}

/* ------------------------------------------------------------------ */
/* The three ways in                                                   */
/* ------------------------------------------------------------------ */

test('a new connection is named by the package, not by the reducer', async () => {
  const h = harness(fixedDisplay('shop'))
  const connId = await open(h)
  assert.deepEqual(connOf(h, connId), {
    label: 'shop',
    detail: 'detail:shop',
    endpoint: 'endpoint:shop',
  })
  assert.deepEqual(h.asked, ['postgres'], 'exactly one round trip per connection')
})

test('reopening the same connection re-asks, so a name never sticks at what a config used to say', async () => {
  const h = harness(fixedDisplay('first'))
  const connId = await open(h)
  assert.equal(connOf(h, connId).label, 'first')

  // The same connId, which is what the sidebar's saved rows and every reconnect
  // send. A build that skipped the round trip for connections it had already
  // named would still pass the test above and fail here.
  const renamed = harness(fixedDisplay('second'))
  const first = await open(renamed)
  const again = await open(renamed, first)
  assert.equal(again, first, 'reopening reuses the id')
  assert.equal(connOf(renamed, first).label, 'second')
  assert.equal(renamed.asked.length, 2, 'the second open asked again')
})

test('while the answer is in flight the row keeps its old name rather than blinking empty', async () => {
  // What the reducer left behind, read at the one moment it is observable: the
  // describe call happens after the reduction and before the connect effect.
  let seededLabel: string | undefined
  let answer = 'first'
  const h: Harness = harness({
    async describe() {
      seededLabel = Object.values(h.store.getState().connections)[0]?.label
      return { label: answer, detail: 'd', endpoint: 'e' }
    },
  })

  const connId = await open(h)
  assert.equal(seededLabel, '', 'a connection nobody has named yet starts blank')

  answer = 'second'
  await open(h, connId)
  assert.equal(
    seededLabel,
    'first',
    'reopening seeds the name it already had, so the sidebar does not flash empty',
  )
  assert.equal(connOf(h, connId).label, 'second', 'and the fresh answer still wins')
})

/* ------------------------------------------------------------------ */
/* Failing to name something is not failing to connect                 */
/* ------------------------------------------------------------------ */

test('a package host that will not answer does not stop the connection opening', async () => {
  const h = harness({
    async describe() {
      throw peekError('TIMEOUT', 'the package host did not answer in time')
    },
  })
  const res = await h.bus.dispatch('conn.open', { config: PG_CONFIG }, 'ui')
  assert.equal(res.ok, true, 'a missing name must not read as a broken database')
  assert.ok(res.ok)
  const conn = h.store.getState().connections[res.data.connId]
  assert.ok(conn)
  assert.equal(conn.status, 'ready', 'the connect effect still ran')
  assert.equal(conn.label, '', 'and the name is simply absent')
})

test('with no display service at all the connection still opens', async () => {
  const h = harness(null)
  const connId = await open(h)
  assert.equal(h.store.getState().connections[connId]?.status, 'ready')
})

/* ------------------------------------------------------------------ */
/* And the order the two effects run in                                */
/* ------------------------------------------------------------------ */

test('the name has landed before the connect effect runs', async () => {
  /*
   * `describeConnection` is planned **before** `connect` and intents run in
   * order, which until §2.3(b-2) was only a matter of the row being named while
   * it still says "connecting". It is a contract now: `main/index.ts` writes the
   * connection book from inside the connect effect and reads the pair off the
   * source of truth to do it, so swapping the two `ctx.plan` calls in
   * `handlers/conn.ts` would archive every connection unnamed — with the sidebar
   * still looking right, because the live row gets its name a moment later.
   */
  const h = harness(fixedDisplay('shop'))
  await open(h)
  assert.deepEqual(h.namedAtConnect, ['shop'])
})
