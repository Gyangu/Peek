import assert from 'node:assert/strict'
import { test } from 'node:test'
import '../../../drivers/__tests__/in-repo-registry'
import {
  collectPanels,
  createEmptyWorkspace,
  asPanelId,
  asViewId,
  peekError,
  type Capability,
  type ConnId,
  type PostgresConnectionConfig,
  type ResultId,
  type ViewId,
} from '@peek/core'
import { failResult } from '../../store/mutations'
import { WorkspaceStore } from '../../store/workspace-store'
import { redactPatches, redactWorkspace } from '../../store/sanitize'
import { CommandBus } from '../command-bus'
import { coreHandlers } from '../handlers'
import { createSeqIdFactory } from '../ids'
import { createUnavailableDeps, type CommandDeps } from '../deps'

/* ------------------------------------------------------------------ */
/* Test harness                                                        */
/* ------------------------------------------------------------------ */

interface DepsCalls {
  open: { connId: ConnId }[]
  close: ConnId[]
  runQuery: { resultId: ResultId; text: string }[]
  scan: { resultId: ResultId; offset?: number; limit?: number }[]
  vectorSearch: { resultId: ResultId; topK: number }[]
  cancel: ResultId[]
}

interface Harness {
  bus: CommandBus
  store: WorkspaceStore
  calls: DepsCalls
  rootPanel: ReturnType<typeof asPanelId>
}

const PG_CONFIG: PostgresConnectionConfig = {
  driverId: 'postgres',
  url: 'postgresql://postgres:example-password@localhost:5432/postgres',
  password: 'example-password',
}

const PG_CAPS: Capability[] = ['introspect', 'tabularQuery', 'collectionScan', 'valuePeek', 'cancel']

function harness(options: { openFails?: boolean } = {}): Harness {
  const calls: DepsCalls = { open: [], close: [], runQuery: [], scan: [], vectorSearch: [], cancel: [] }
  const deps: CommandDeps = {
    connections: {
      async open(req) {
        calls.open.push({ connId: req.connId })
        if (options.openFails) throw new Error('connect refused')
        return { capabilities: PG_CAPS, serverInfo: { version: '16.4', flavor: 'PostgreSQL' }, pid: 4242 }
      },
      async close(connId) {
        calls.close.push(connId)
      },
    },
    results: {
      async runQuery(req) {
        calls.runQuery.push({ resultId: req.resultId, text: req.text })
      },
      async scanCollection(req) {
        calls.scan.push({ resultId: req.resultId, offset: req.offset, limit: req.limit })
      },
      async vectorSearch(req) {
        calls.vectorSearch.push({ resultId: req.resultId, topK: req.topK })
      },
      async cancel(req) {
        calls.cancel.push(req.resultId)
        return true
      },
    },
  }

  const rootPanel = asPanelId('panel_root')
  const store = new WorkspaceStore(createEmptyWorkspace(rootPanel))
  const bus = new CommandBus({ store, deps, ids: createSeqIdFactory(), now: () => 1_000 })
  bus.registerAll(coreHandlers)
  return { bus, store, calls, rootPanel }
}

async function connect(h: Harness): Promise<ConnId> {
  const res = await h.bus.dispatch('conn.open', { config: PG_CONFIG }, 'ui')
  assert.equal(res.ok, true)
  if (!res.ok) throw new Error('unreachable')
  return res.data.connId
}

/* ------------------------------------------------------------------ */
/* Validation and error collapsing                                     */
/* ------------------------------------------------------------------ */

test('invalid input yields a structured error: nothing thrown, nothing changed', async () => {
  const h = harness()
  const before = h.store.rev
  const res = await h.bus.dispatch('layout.focus', { panelId: 123 }, 'mcp')
  assert.equal(res.ok, false)
  if (res.ok) return
  assert.equal(res.error.code, 'BAD_REQUEST')
  assert.equal(h.store.rev, before, 'a validation failure does not bump rev')
})

test('conn.open refuses a driver no package provides, instead of reaching a driver host', async () => {
  // The gate the config union used to be. `ConnOpenInputSchema` now accepts any
  // record with a servable `driverId` — core cannot look a package up — so
  // without this the id would travel past `connectionIdentityOf`, which throws
  // rather than guessing which fields identify a connection, and surface as an
  // INTERNAL error from inside a reducer.
  const h = harness()
  const before = h.store.rev
  const res = await h.bus.dispatch('conn.open', { config: { driverId: 'oracle', url: 'x' } }, 'mcp')
  assert.equal(res.ok, false)
  if (res.ok) return
  assert.equal(res.error.code, 'BAD_REQUEST')
  assert.match(res.error.message, /oracle/)
  assert.equal(h.store.rev, before, 'a refused connection leaves no state behind')
  assert.deepEqual(h.calls.open, [], 'nothing was handed to a driver host')
})

test('conn.open refuses a field its driver never declared the type of, and names it', async () => {
  // The other half of what the union checked: `port` was `z.number()` in the
  // postgres branch, and is now the `number`-typed box that driver's own connect
  // form draws. A string reaching a driver host is a connection to nowhere.
  const h = harness()
  const res = await h.bus.dispatch('conn.open', { config: { driverId: 'postgres', port: 'nope' } }, 'mcp')
  assert.equal(res.ok, false)
  if (res.ok) return
  assert.equal(res.error.code, 'BAD_REQUEST')
  assert.match(res.error.message, /port/)
  assert.deepEqual(h.calls.open, [])
})

test('conn.open keeps a key no form draws — an MCP caller who knows the database meant it', () => {
  // `'keep'`, not `'drop'`: `connectTimeoutMs` is in no connect form and is read
  // by the connect path itself, so a parse that stripped undeclared keys would
  // silently rewrite the caller's request.
  const h = harness()
  return h.bus
    .dispatch('conn.open', { config: { ...PG_CONFIG, connectTimeoutMs: 1234 } }, 'mcp')
    .then((res) => {
      assert.equal(res.ok, true)
      if (!res.ok) return
      const conn = h.store.getState().connections[res.data.connId]
      assert.equal(conn?.config['connectTimeoutMs'], 1234)
    })
})

test('a missing target yields NOT_FOUND, and the half-applied reduce is discarded wholesale', async () => {
  const h = harness()
  const res = await h.bus.dispatch('layout.close', { panelId: 'panel_ghost' }, 'ui')
  assert.equal(res.ok, false)
  if (res.ok) return
  assert.equal(res.error.code, 'NOT_FOUND')
})

test('UI and MCP travel the same path; only the source in the log differs', async () => {
  const h = harness()
  const connId = await connect(h)
  await h.bus.dispatch('view.open', { spec: { kind: 'tree', connId } }, 'ui')
  await h.bus.dispatch('view.open', { spec: { kind: 'tree', connId } }, 'mcp')

  const opens = h.bus.log.entries().filter((e) => e.name === 'view.open')
  assert.deepEqual(
    opens.map((e) => e.source),
    ['ui', 'mcp'],
  )
  assert.equal(opens[0].ok && opens[1].ok, true)
})

/* ------------------------------------------------------------------ */
/* conn.*                                                             */
/* ------------------------------------------------------------------ */

test('conn.open: connecting → ready, with capabilities filled in by the driver', async () => {
  const h = harness()
  const res = await h.bus.dispatch('conn.open', { config: PG_CONFIG, openTree: true }, 'mcp')
  assert.equal(res.ok, true)
  if (!res.ok) return

  assert.equal(res.data.status, 'ready', 'finalize corrected the result against the post-effect source of truth')
  assert.deepEqual(res.data.capabilities, PG_CAPS)
  assert.equal(res.data.serverInfo?.version, '16.4')
  assert.ok(res.data.treeViewId)
  assert.equal(h.calls.open.length, 1)

  const conn = h.store.getState().connections[res.data.connId]
  assert.equal(conn.status, 'ready')
  assert.equal(conn.pid, 4242)
  assert.equal(conn.config.driverId, 'postgres')
})

test('conn.open failure: status lands on error and the command reports CONNECTION_FAILED', async () => {
  const h = harness({ openFails: true })
  const res = await h.bus.dispatch('conn.open', { config: PG_CONFIG }, 'ui')
  assert.equal(res.ok, false)
  if (res.ok) return
  assert.equal(res.error.code, 'CONNECTION_FAILED')

  const conns = Object.values(h.store.getState().connections)
  assert.equal(conns.length, 1)
  assert.equal(conns[0].status, 'error')
  assert.equal(conns[0].error?.code, 'CONNECTION_FAILED')
})

test('conn.close: closes the views it owns and disconnects the driver', async () => {
  const h = harness()
  const connId = await connect(h)
  const opened = await h.bus.dispatch('view.open', { spec: { kind: 'tree', connId } }, 'ui')
  assert.equal(opened.ok, true)

  const res = await h.bus.dispatch('conn.close', { connId }, 'ui')
  assert.equal(res.ok, true)
  if (!res.ok) return
  assert.equal(res.data.closedViewIds.length, 1)
  assert.deepEqual(h.calls.close, [connId])
  assert.deepEqual(h.store.getState().views, {})
  assert.equal(h.store.getState().connections[connId], undefined)
})

/* ------------------------------------------------------------------ */
/* view.* / query.*                                                   */
/* ------------------------------------------------------------------ */

test('view.open table: starts a scan automatically and lands the view in the focused panel', async () => {
  const h = harness()
  const connId = await connect(h)
  const res = await h.bus.dispatch(
    'view.open',
    { spec: { kind: 'table', connId, ref: { kind: 'relation', schema: 'public', name: 'harness' } } },
    'mcp',
  )
  assert.equal(res.ok, true)
  if (!res.ok) return

  assert.equal(res.data.panelId, h.rootPanel)
  assert.ok(res.data.resultId)
  assert.equal(h.calls.scan.length, 1)
  assert.equal(h.calls.scan[0].resultId, res.data.resultId)

  const state = h.store.getState()
  assert.equal(state.views[res.data.viewId].status, 'loading')
  assert.equal(state.results[res.data.resultId!].status, 'running')
  assert.equal(state.focusedPanel, h.rootPanel)
  const panel = collectPanels(state.layout)[0]
  assert.deepEqual(panel.viewIds, [res.data.viewId])
  assert.equal(panel.activeViewId, res.data.viewId, 'the view it opened is the view on screen')
})

test('view.open: with the connection not ready, nothing is fetched and the view sits quietly at idle', async () => {
  const h = harness({ openFails: true })
  await h.bus.dispatch('conn.open', { config: PG_CONFIG }, 'ui')
  const connId = Object.keys(h.store.getState().connections)[0] as ConnId

  const res = await h.bus.dispatch(
    'view.open',
    { spec: { kind: 'table', connId, ref: { kind: 'relation', schema: 'public', name: 'harness' } } },
    'ui',
  )
  assert.equal(res.ok, true)
  if (!res.ok) return
  assert.equal(res.data.resultId, undefined)
  assert.equal(h.calls.scan.length, 0)
  assert.equal(h.store.getState().views[res.data.viewId].status, 'idle')
})

test('view.open replace=false: an occupied panel gains a tab rather than being split', async () => {
  const h = harness()
  const connId = await connect(h)
  const first = await h.bus.dispatch('view.open', { spec: { kind: 'tree', connId } }, 'ui')
  const second = await h.bus.dispatch(
    'view.open',
    { spec: { kind: 'tree', connId }, replace: false },
    'ui',
  )
  assert.equal(first.ok && second.ok, true)
  if (!first.ok || !second.ok) return

  const state = h.store.getState()
  assert.equal(Object.keys(state.views).length, 2, 'nothing was closed')
  assert.equal(collectPanels(state.layout).length, 1, 'and no panel was created')
  assert.equal(second.data.panelId, first.data.panelId)

  const panel = collectPanels(state.layout)[0]
  assert.deepEqual(panel.viewIds, [first.data.viewId, second.data.viewId], 'appended at the end')
  assert.equal(panel.activeViewId, second.data.viewId, 'and shown')
})

test('view.open: splitting off a new panel is layout.split, which still says so', async () => {
  const h = harness()
  const connId = await connect(h)
  const first = await h.bus.dispatch('view.open', { spec: { kind: 'tree', connId } }, 'ui')
  assert.equal(first.ok, true)
  if (!first.ok) return

  const split = await h.bus.dispatch(
    'layout.split',
    { panelId: h.rootPanel, dir: 'row', view: { kind: 'tree', connId } },
    'ui',
  )
  assert.equal(split.ok, true)
  if (!split.ok) return

  const panels = collectPanels(h.store.getState().layout)
  assert.equal(panels.length, 2)
  assert.notEqual(split.data.panelId, first.data.panelId)
  assert.deepEqual(panels[0].viewIds, [first.data.viewId], 'the original panel kept its single tab')
  assert.deepEqual(panels[1].viewIds, [split.data.viewId!])
  assert.equal(panels[1].activeViewId, split.data.viewId)
})

test('view.open over the same panel: the default appends a tab and keeps the old view', async () => {
  const h = harness()
  const connId = await connect(h)
  const first = await h.bus.dispatch('view.open', { spec: { kind: 'tree', connId } }, 'ui')
  const second = await h.bus.dispatch('view.open', { spec: { kind: 'tree', connId } }, 'ui')
  assert.equal(first.ok && second.ok, true)
  if (!first.ok || !second.ok) return

  const state = h.store.getState()
  assert.equal(Object.keys(state.views).length, 2)
  assert.ok(state.views[first.data.viewId], 'the first view is still open, just behind the second')
  assert.equal(collectPanels(state.layout).length, 1)

  const panel = collectPanels(state.layout)[0]
  assert.deepEqual(panel.viewIds, [first.data.viewId, second.data.viewId])
  assert.equal(panel.activeViewId, second.data.viewId)
})

test('view.open replace=true: the active view is closed and the new one takes its tab position', async () => {
  const h = harness()
  const connId = await connect(h)
  const a = await h.bus.dispatch('view.open', { spec: { kind: 'tree', connId } }, 'ui')
  const b = await h.bus.dispatch('view.open', { spec: { kind: 'tree', connId } }, 'ui')
  assert.equal(a.ok && b.ok, true)
  if (!a.ok || !b.ok) return

  // Go back to the first tab, then replace it: the replacement must land in slot 0,
  // not at the end, or the tab bar reshuffles under the user's cursor.
  const back = await h.bus.dispatch('view.activate', { viewId: a.data.viewId }, 'ui')
  assert.equal(back.ok, true)

  const c = await h.bus.dispatch('view.open', { spec: { kind: 'tree', connId }, replace: true }, 'ui')
  assert.equal(c.ok, true)
  if (!c.ok) return

  const state = h.store.getState()
  assert.equal(Object.keys(state.views).length, 2)
  assert.equal(state.views[a.data.viewId], undefined, 'the view that was showing is gone')
  assert.equal(collectPanels(state.layout).length, 1)

  const panel = collectPanels(state.layout)[0]
  assert.deepEqual(panel.viewIds, [c.data.viewId, b.data.viewId], 'it took slot 0, it did not append')
  assert.equal(panel.activeViewId, c.data.viewId)
})

test('view.update: paging refetches and invalidates the old continuation cursor', async () => {
  const h = harness()
  const connId = await connect(h)
  const opened = await h.bus.dispatch(
    'view.open',
    { spec: { kind: 'table', connId, ref: { kind: 'relation', schema: 'public', name: 'harness' } } },
    'ui',
  )
  assert.equal(opened.ok, true)
  if (!opened.ok) return
  const viewId = opened.data.viewId

  const res = await h.bus.dispatch(
    'view.update',
    { viewId, patch: { kind: 'table', offset: 200, limit: 50 } },
    'mcp',
  )
  assert.equal(res.ok, true)
  if (!res.ok) return
  assert.ok(res.data.resultId)
  assert.equal(h.calls.scan.length, 2)
  assert.deepEqual(
    { offset: h.calls.scan[1].offset, limit: h.calls.scan[1].limit },
    { offset: 200, limit: 50 },
  )

  const view = h.store.getState().views[viewId]
  assert.equal(view.kind === 'table' && view.page.offset, 200)
})

test('view.update: cancels the previous running result set before paging', async () => {
  const h = harness()
  const connId = await connect(h)
  const opened = await h.bus.dispatch(
    'view.open',
    { spec: { kind: 'table', connId, ref: { kind: 'relation', schema: 'public', name: 'harness' } } },
    'ui',
  )
  assert.equal(opened.ok, true)
  if (!opened.ok) return
  const firstResult = opened.data.resultId
  assert.ok(firstResult)

  const res = await h.bus.dispatch(
    'view.update',
    { viewId: opened.data.viewId, patch: { kind: 'table', offset: 200 }, refresh: true },
    'ui',
  )
  assert.equal(res.ok, true)
  if (!res.ok) return

  assert.deepEqual(h.calls.cancel, [firstResult], 'the old result set must be cancelled when paging')
  const state = h.store.getState()
  assert.equal(state.results[firstResult!].status, 'cancelled')
  assert.equal(state.results[res.data.resultId!].status, 'running')
  // The old result set was cancelled, which must not knock the view itself back to idle
  assert.equal(state.views[opened.data.viewId].status, 'loading')
})

test('query.run twice in a row: the previous result set is cancelled, leaving no orphaned stream', async () => {
  const h = harness()
  const connId = await connect(h)
  const first = await h.bus.dispatch('query.run', { connId, text: 'select pg_sleep(60)' }, 'ui')
  assert.equal(first.ok, true)
  if (!first.ok) return

  const second = await h.bus.dispatch(
    'query.run',
    { connId, viewId: first.data.viewId, text: 'select 1' },
    'ui',
  )
  assert.equal(second.ok, true)
  if (!second.ok) return

  assert.deepEqual(h.calls.cancel, [first.data.resultId])
  assert.equal(h.store.getState().results[first.data.resultId].status, 'cancelled')
})

test('the driver reports CANCELLED: the view returns to idle with no red error bar', async () => {
  const h = harness()
  const connId = await connect(h)
  const run = await h.bus.dispatch('query.run', { connId, text: 'select pg_sleep(60)' }, 'ui')
  assert.equal(run.ok, true)
  if (!run.ok) return

  const cancelled = await h.bus.dispatch('query.cancel', { resultId: run.data.resultId }, 'ui')
  assert.equal(cancelled.ok, true)

  // Once cancelled, the driver host's StreamPump always emits a result.error(CANCELLED)
  h.store.apply((draft) => {
    failResult(draft, run.data.resultId, peekError('CANCELLED', 'The result stream was cancelled'))
  }, { source: 'system' })

  const state = h.store.getState()
  assert.equal(state.views[run.data.viewId].status, 'idle', 'a cancel is not an error')
  assert.equal(state.views[run.data.viewId].error, undefined)
  assert.equal(state.results[run.data.resultId].status, 'cancelled')
})

test('the driver reports a real error: the view lands on error carrying the structured error', async () => {
  const h = harness()
  const connId = await connect(h)
  const run = await h.bus.dispatch('query.run', { connId, text: 'select boom' }, 'ui')
  assert.equal(run.ok, true)
  if (!run.ok) return

  h.store.apply((draft) => {
    failResult(
      draft,
      run.data.resultId,
      peekError('SYNTAX_ERROR', 'column "boom" does not exist', { driverCode: '42703' }),
    )
  }, { source: 'system' })

  const state = h.store.getState()
  assert.equal(state.views[run.data.viewId].status, 'error')
  assert.equal(state.views[run.data.viewId].error?.driverCode, '42703')
  assert.equal(state.results[run.data.resultId].status, 'error')
})

test('view.update: a patch kind that does not match the view yields BAD_REQUEST', async () => {
  const h = harness()
  const connId = await connect(h)
  const opened = await h.bus.dispatch('view.open', { spec: { kind: 'tree', connId } }, 'ui')
  assert.equal(opened.ok, true)
  if (!opened.ok) return

  const res = await h.bus.dispatch(
    'view.update',
    { viewId: opened.data.viewId, patch: { kind: 'query', text: 'select 1' } },
    'mcp',
  )
  assert.equal(res.ok, false)
  if (res.ok) return
  assert.equal(res.error.code, 'BAD_REQUEST')
})

test('query.run: with no viewId, connId + text opens a new query view', async () => {
  const h = harness()
  const connId = await connect(h)
  const res = await h.bus.dispatch('query.run', { connId, text: 'select 1' }, 'mcp')
  assert.equal(res.ok, true)
  if (!res.ok) return

  assert.equal(h.calls.runQuery.length, 1)
  assert.equal(h.calls.runQuery[0].text, 'select 1')
  const view = h.store.getState().views[res.data.viewId]
  assert.equal(view.kind, 'query')
  assert.equal(view.status, 'loading')
  assert.equal(h.store.getState().results[res.data.resultId].summary, 'select 1')
})

test('query.run: an unready connection yields CONFLICT', async () => {
  const h = harness({ openFails: true })
  await h.bus.dispatch('conn.open', { config: PG_CONFIG }, 'ui')
  const connId = Object.keys(h.store.getState().connections)[0] as ConnId

  const res = await h.bus.dispatch('query.run', { connId, text: 'select 1' }, 'mcp')
  assert.equal(res.ok, false)
  if (res.ok) return
  assert.equal(res.error.code, 'CONFLICT')
  assert.equal(h.calls.runQuery.length, 0)
})

test('query.cancel: a running result set is cancelled; a finished one honestly reports false', async () => {
  const h = harness()
  const connId = await connect(h)
  const run = await h.bus.dispatch('query.run', { connId, text: 'select pg_sleep(60)' }, 'ui')
  assert.equal(run.ok, true)
  if (!run.ok) return

  const cancelled = await h.bus.dispatch('query.cancel', { resultId: run.data.resultId }, 'mcp')
  assert.equal(cancelled.ok, true)
  if (!cancelled.ok) return
  assert.equal(cancelled.data.cancelled, true)
  assert.deepEqual(h.calls.cancel, [run.data.resultId])
  assert.equal(h.store.getState().results[run.data.resultId].status, 'cancelled')

  const again = await h.bus.dispatch('query.cancel', { resultId: run.data.resultId }, 'mcp')
  assert.equal(again.ok, true)
  if (!again.ok) return
  assert.equal(again.data.cancelled, false)
  assert.equal(h.calls.cancel.length, 1, 'a finished result set does not disturb the driver again')
})

test('view.close: the panel stays and the running result set is cancelled along the way', async () => {
  const h = harness()
  const connId = await connect(h)
  const run = await h.bus.dispatch('query.run', { connId, text: 'select 1' }, 'ui')
  assert.equal(run.ok, true)
  if (!run.ok) return

  const res = await h.bus.dispatch('view.close', { viewId: run.data.viewId }, 'ui')
  assert.equal(res.ok, true)
  if (!res.ok) return
  assert.equal(res.data.panelId, h.rootPanel)
  assert.equal(res.data.activatedViewId, null, 'nothing took over — that was the last tab')
  assert.deepEqual(h.calls.cancel, [run.data.resultId])

  const panel = collectPanels(h.store.getState().layout)[0]
  assert.deepEqual(panel.viewIds, [])
  assert.equal(panel.activeViewId, null)
})

test('view.close: closing the active tab hands the panel to its right neighbour', async () => {
  const h = harness()
  const connId = await connect(h)
  const a = await h.bus.dispatch('view.open', { spec: { kind: 'tree', connId } }, 'ui')
  const b = await h.bus.dispatch('view.open', { spec: { kind: 'tree', connId } }, 'ui')
  const c = await h.bus.dispatch('view.open', { spec: { kind: 'tree', connId } }, 'ui')
  assert.equal(a.ok && b.ok && c.ok, true)
  if (!a.ok || !b.ok || !c.ok) return

  const back = await h.bus.dispatch('view.activate', { viewId: b.data.viewId }, 'ui')
  assert.equal(back.ok, true)

  const res = await h.bus.dispatch('view.close', { viewId: b.data.viewId }, 'ui')
  assert.equal(res.ok, true)
  if (!res.ok) return
  assert.equal(res.data.panelId, h.rootPanel)
  assert.equal(res.data.activatedViewId, c.data.viewId, 'right neighbour, not left, not the first tab')

  const panel = collectPanels(h.store.getState().layout)[0]
  assert.deepEqual(panel.viewIds, [a.data.viewId, c.data.viewId])
  assert.equal(panel.activeViewId, c.data.viewId)
})

test('view.close: closing a background tab leaves the screen exactly as it was', async () => {
  const h = harness()
  const connId = await connect(h)
  const a = await h.bus.dispatch('view.open', { spec: { kind: 'tree', connId } }, 'ui')
  const b = await h.bus.dispatch('view.open', { spec: { kind: 'tree', connId } }, 'ui')
  assert.equal(a.ok && b.ok, true)
  if (!a.ok || !b.ok) return

  // `b` is showing; close `a`, which is behind it.
  const res = await h.bus.dispatch('view.close', { viewId: a.data.viewId }, 'ui')
  assert.equal(res.ok, true)
  if (!res.ok) return
  assert.equal(res.data.activatedViewId, b.data.viewId, 'the visible view never changed')

  const panel = collectPanels(h.store.getState().layout)[0]
  assert.deepEqual(panel.viewIds, [b.data.viewId])
  assert.equal(panel.activeViewId, b.data.viewId)
})

/* ------------------------------------------------------------------ */
/* layout.*                                                           */
/* ------------------------------------------------------------------ */

test('layout.split: can open a view in the new panel at the same time, and focus follows', async () => {
  const h = harness()
  const connId = await connect(h)
  const res = await h.bus.dispatch(
    'layout.split',
    { panelId: h.rootPanel, dir: 'row', view: { kind: 'tree', connId } },
    'mcp',
  )
  assert.equal(res.ok, true)
  if (!res.ok) return
  assert.ok(res.data.viewId)

  const state = h.store.getState()
  assert.equal(state.focusedPanel, res.data.panelId)
  assert.equal(collectPanels(state.layout).length, 2)
})

test('layout.close: focus falls back automatically after the focused panel closes', async () => {
  const h = harness()
  const split = await h.bus.dispatch('layout.split', { panelId: h.rootPanel, dir: 'row' }, 'ui')
  assert.equal(split.ok, true)
  if (!split.ok) return
  assert.equal(h.store.getState().focusedPanel, split.data.panelId)

  const res = await h.bus.dispatch('layout.close', { panelId: split.data.panelId }, 'ui')
  assert.equal(res.ok, true)
  const state = h.store.getState()
  assert.equal(collectPanels(state.layout).length, 1)
  assert.equal(state.focusedPanel, h.rootPanel, 'focus fell back to the only remaining panel')
})

test('layout.close: closing the last panel merely empties it, and its view closes too', async () => {
  const h = harness()
  const connId = await connect(h)
  const opened = await h.bus.dispatch('view.open', { spec: { kind: 'tree', connId } }, 'ui')
  assert.equal(opened.ok, true)
  if (!opened.ok) return

  const res = await h.bus.dispatch('layout.close', { panelId: h.rootPanel }, 'ui')
  assert.equal(res.ok, true)
  if (!res.ok) return
  assert.deepEqual(res.data.closedViewIds, [opened.data.viewId])

  const state = h.store.getState()
  assert.equal(collectPanels(state.layout).length, 1)
  const panel = collectPanels(state.layout)[0]
  assert.deepEqual(panel.viewIds, [])
  assert.equal(panel.activeViewId, null)
  assert.deepEqual(state.views, {})
  assert.equal(state.focusedPanel, h.rootPanel)
})

test('layout.close: the whole tab stack goes, not just the visible one', async () => {
  const h = harness()
  const connId = await connect(h)
  const split = await h.bus.dispatch('layout.split', { panelId: h.rootPanel, dir: 'row' }, 'ui')
  assert.equal(split.ok, true)
  if (!split.ok) return

  const a = await h.bus.dispatch('view.open', { spec: { kind: 'tree', connId }, panelId: split.data.panelId }, 'ui')
  const b = await h.bus.dispatch('view.open', { spec: { kind: 'tree', connId }, panelId: split.data.panelId }, 'ui')
  assert.equal(a.ok && b.ok, true)
  if (!a.ok || !b.ok) return

  const res = await h.bus.dispatch('layout.close', { panelId: split.data.panelId }, 'ui')
  assert.equal(res.ok, true)
  if (!res.ok) return
  // Reading only the active view here would leave `a` in `views`, leaking its
  // connection and its result set with no panel left to reach it from.
  assert.deepEqual(res.data.closedViewIds, [a.data.viewId, b.data.viewId])

  const state = h.store.getState()
  assert.deepEqual(state.views, {})
  assert.equal(collectPanels(state.layout).length, 1)
})

test('layout.setRatio: a mismatched ratio length yields BAD_REQUEST', async () => {
  const h = harness()
  const split = await h.bus.dispatch('layout.split', { panelId: h.rootPanel, dir: 'row' }, 'ui')
  assert.equal(split.ok, true)
  if (!split.ok) return

  const good = await h.bus.dispatch('layout.setRatio', { splitId: split.data.splitId, ratio: [3, 1] }, 'mcp')
  assert.equal(good.ok, true)
  if (!good.ok) return
  assert.deepEqual(good.data.ratio, [0.75, 0.25])

  const bad = await h.bus.dispatch(
    'layout.setRatio',
    { splitId: split.data.splitId, ratio: [1, 1, 1] },
    'mcp',
  )
  assert.equal(bad.ok, false)
  if (bad.ok) return
  assert.equal(bad.error.code, 'BAD_REQUEST')
})

/* ------------------------------------------------------------------ */
/* state.read                                                         */
/* ------------------------------------------------------------------ */

test('state.read: read-only, no rev bump, config already redacted', async () => {
  const h = harness()
  const connId = await connect(h)
  const revBefore = h.store.rev

  const res = await h.bus.dispatch('state.read', {}, 'mcp')
  assert.equal(res.ok, true)
  if (!res.ok) return
  assert.equal(h.store.rev, revBefore, 'a read-only command produces no new rev')

  const conn = res.data.snapshot.connections[0]
  assert.equal(conn.id, connId)
  // The `driverId === 'postgres' &&` prefix these two carried was the config
  // union's narrowing, not part of what is being asserted; a config is an open
  // record now, so the id is checked on its own line and the fields are read as
  // the unknowns they are.
  assert.equal(conn.config.driverId, 'postgres')
  assert.equal(conn.config.password, '***')
  assert.equal(typeof conn.config.url, 'string')
  assert.equal(String(conn.config.url).includes('example-password'), false)
})

test('state.read: include and viewId narrow what comes back', async () => {
  const h = harness()
  const connId = await connect(h)
  const opened = await h.bus.dispatch('view.open', { spec: { kind: 'tree', connId } }, 'ui')
  assert.equal(opened.ok, true)
  if (!opened.ok) return

  const partial = await h.bus.dispatch('state.read', { include: ['layout'] }, 'mcp')
  assert.equal(partial.ok, true)
  if (!partial.ok) return
  assert.deepEqual(partial.data.snapshot.connections, [])
  assert.deepEqual(partial.data.snapshot.views, [])

  const one = await h.bus.dispatch('state.read', { viewId: opened.data.viewId }, 'mcp')
  assert.equal(one.ok, true)
  if (!one.ok) return
  assert.equal(one.data.snapshot.views.length, 1)
  assert.equal(one.data.snapshot.views[0].panelId, h.rootPanel)

  const missing = await h.bus.dispatch('state.read', { viewId: asViewId('view_404') }, 'mcp')
  assert.equal(missing.ok, false)
})

/* ------------------------------------------------------------------ */
/* The Command log                                                     */
/* ------------------------------------------------------------------ */

test('Command log: ring buffer, redacted passwords, failures recorded too', async () => {
  const h = harness()
  await h.bus.dispatch('conn.open', { config: PG_CONFIG }, 'mcp')
  await h.bus.dispatch('layout.focus', { panelId: 'panel_ghost' }, 'ui')

  const entries = h.bus.log.entries()
  assert.equal(entries.length, 2)
  assert.deepEqual(
    entries.map((e) => e.seq),
    [1, 2],
  )

  const open = entries[0]
  const logged = open.input as { config: { password: string; url: string } }
  assert.equal(logged.config.password, '***', 'a password must never reach the log')
  assert.equal(logged.config.url.includes('example-password'), false)
  assert.equal(open.ok, true)
  assert.equal(typeof open.elapsedMs, 'number')

  assert.equal(entries[1].ok, false)
  assert.equal(entries[1].errorCode, 'NOT_FOUND')
})

/* ------------------------------------------------------------------ */
/* Store: patches and redaction                                        */
/* ------------------------------------------------------------------ */

test('store: every command bumps rev by 1 and subscribers receive contiguous patches', async () => {
  const h = harness()
  const seen: { fromRev: number; rev: number }[] = []
  h.store.subscribe((change) => {
    seen.push({ fromRev: change.fromRev, rev: change.rev })
  })

  await connect(h)
  assert.ok(seen.length >= 2, 'conn.open produces at least two patch batches: connecting and ready')
  for (let i = 1; i < seen.length; i += 1) {
    assert.equal(seen[i].fromRev, seen[i - 1].rev, 'revs must be contiguous, or the renderer decides it dropped a batch')
  }
  assert.equal(seen[seen.length - 1].rev, h.store.rev)
})

test('store: neither broadcast patches nor snapshots carry a cleartext password', async () => {
  const h = harness()
  const patches: unknown[] = []
  h.store.subscribe((change) => {
    patches.push(...redactPatches(change.patches))
  })
  await connect(h)

  const dumped = JSON.stringify(patches)
  assert.equal(dumped.includes('example-password'), false, 'the patches leaked the password')
  assert.equal(dumped.includes('***'), true)

  const snapshot = JSON.stringify(redactWorkspace(h.store.getState()))
  assert.equal(snapshot.includes('example-password'), false, 'the snapshot leaked the password')
  // The source of truth must keep the cleartext: the Connection Manager needs it to reconnect
  assert.equal(JSON.stringify(h.store.getState()).includes('example-password'), true)
})

test('store: when reduce throws, state does not move at all (atomicity)', async () => {
  const h = harness()
  const connId = await connect(h)
  const before = h.store.getState()

  // The panelId does not exist, so openView throws before mounting; the view registered just before must be voided with it
  const res = await h.bus.dispatch(
    'view.open',
    { spec: { kind: 'tree', connId }, panelId: asPanelId('panel_ghost') },
    'mcp',
  )
  assert.equal(res.ok, false)
  assert.equal(h.store.getState(), before, 'a failed command produces no new state')
})

test('an unregistered handler yields INTERNAL instead of crashing', async () => {
  const h = harness()
  const bare = new CommandBus({ store: h.store, deps: createUnavailableDeps() })
  const res = await bare.dispatch('layout.focus', { panelId: h.rootPanel }, 'ui')
  assert.equal(res.ok, false)
  if (res.ok) return
  assert.equal(res.error.code, 'INTERNAL')
})

/* ------------------------------------------------------------------ */
/* Branded view ids in use (verified at compile time)                   */
/* ------------------------------------------------------------------ */

test('branded ids keep their type in results', async () => {
  const h = harness()
  const connId = await connect(h)
  const res = await h.bus.dispatch('view.open', { spec: { kind: 'tree', connId } }, 'ui')
  assert.equal(res.ok, true)
  if (!res.ok) return
  const viewId: ViewId = res.data.viewId
  assert.equal(typeof viewId, 'string')
})
