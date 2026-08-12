import assert from 'node:assert/strict'
import { test } from 'node:test'
import '../../../drivers/__tests__/in-repo-registry'
import {
  CommandSourceSchema,
  createEmptyWorkspace,
  asPanelId,
  type Capability,
  type CommandSource,
  type ConnId,
  type PostgresConnectionConfig,
} from '@peek/core'
import { WorkspaceStore } from '../../store/workspace-store'
import { CommandBus } from '../command-bus'
import { coreHandlers } from '../handlers'
import { createSeqIdFactory } from '../ids'
import type { CommandDeps } from '../deps'

/* ==================================================================
 * `origin`: who asked for a connection or a result set.
 *
 * The error centre used to guess this — "no command in flight for 1.5s, so it
 * must have been MCP" — which was wrong in exactly the case it existed for: a
 * query that dies thirty seconds in has nothing in flight no matter who started
 * it, so a person's own timed-out query was reported as an agent's.
 *
 * The field is optional in `@peek/core` so that hand-built state literals in
 * tests keep compiling. That makes the invariant unenforceable by the type
 * system, so it is enforced here instead: dispatch through the real bus, with
 * every source, and check what lands in the source of truth.
 *
 * See docs/design/2026-08-02-failure-attribution-and-degraded-boot.md.
 * ================================================================== */

/**
 * Derived from the schema rather than listed here, so a fifth source is covered
 * the day it is added instead of the day somebody remembers this file.
 */
const SOURCES: readonly CommandSource[] = CommandSourceSchema.options

const PG_CONFIG: PostgresConnectionConfig = {
  driverId: 'postgres',
  url: 'postgresql://postgres@localhost:5432/postgres',
}

const PG_CAPS: Capability[] = ['introspect', 'tabularQuery', 'collectionScan', 'valuePeek', 'cancel']

/** Every side effect is a no-op: this suite is about the pure state phase. */
const deps: CommandDeps = {
  connections: {
    async open() {
      return { capabilities: PG_CAPS, serverInfo: { version: '16.4', flavor: 'PostgreSQL' }, pid: 1 }
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
}

function bus(): { bus: CommandBus; store: WorkspaceStore } {
  const store = new WorkspaceStore(createEmptyWorkspace(asPanelId('panel_root')))
  const b = new CommandBus({ store, deps, ids: createSeqIdFactory(), now: () => 1_000 })
  b.registerAll(coreHandlers)
  return { bus: b, store }
}

async function openConn(b: CommandBus, source: CommandSource): Promise<ConnId> {
  const res = await b.dispatch('conn.open', { config: PG_CONFIG }, source)
  assert.equal(res.ok, true, `conn.open should succeed for source ${source}`)
  if (!res.ok) throw new Error('unreachable')
  return res.data.connId
}

test('conn.open records the source that asked for it, for every source', async () => {
  for (const source of SOURCES) {
    const h = bus()
    const connId = await openConn(h.bus, source)
    assert.equal(h.store.getState().connections[connId]?.origin, source)
  }
})

test('reopening a connection re-attributes it to whoever asked most recently', async () => {
  const h = bus()
  const connId = await openConn(h.bus, 'ui')
  assert.equal(h.store.getState().connections[connId]?.origin, 'ui')

  const again = await h.bus.dispatch('conn.open', { connId, config: PG_CONFIG }, 'mcp')
  assert.equal(again.ok, true)
  assert.equal(
    h.store.getState().connections[connId]?.origin,
    'mcp',
    'the next failure belongs to the caller that asked last, not the one that asked first',
  )
})

test('a result set records the source that started it, for every source', async () => {
  for (const source of SOURCES) {
    const h = bus()
    const connId = await openConn(h.bus, source)
    const view = await h.bus.dispatch(
      'view.open',
      { spec: { kind: 'query', connId, text: 'SELECT 1' } },
      source,
    )
    assert.equal(view.ok, true)
    if (!view.ok) return
    const run = await h.bus.dispatch('query.run', { viewId: view.data.viewId }, source)
    assert.equal(run.ok, true)

    const results = Object.values(h.store.getState().results)
    assert.equal(results.length, 1, 'query.run should have created exactly one result set')
    assert.equal(results[0]?.origin, source)
  }
})

test('the source that opened a connection and the one that queried it are recorded separately', async () => {
  const h = bus()
  // A person opens the connection; the embedded chat panel runs a query on it.
  const connId = await openConn(h.bus, 'ui')
  const view = await h.bus.dispatch(
    'view.open',
    { spec: { kind: 'query', connId, text: 'SELECT 1' } },
    'agent',
  )
  assert.equal(view.ok, true)
  if (!view.ok) return
  await h.bus.dispatch('query.run', { viewId: view.data.viewId }, 'agent')

  const state = h.store.getState()
  assert.equal(state.connections[connId]?.origin, 'ui')
  assert.equal(Object.values(state.results)[0]?.origin, 'agent')
})
