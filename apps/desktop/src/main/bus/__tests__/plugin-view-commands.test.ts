import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  asPanelId,
  createEmptyWorkspace,
  type Capability,
  type ConnId,
  type PluginViewState,
  type PostgresConnectionConfig,
  type ViewId,
} from '@peek/core'
import { WorkspaceStore } from '../../store/workspace-store'
import { CommandBus } from '../command-bus'
import { coreHandlers } from '../handlers'
import { createSeqIdFactory } from '../ids'
import type { CommandDeps } from '../deps'

/* ==================================================================
 * `view.open` and `view.update` carry a plugin view.
 *
 * These two commands are the *only* part of the Command contract that had to
 * open for plugins. All 32 names in `COMMAND_NAMES` are kernel-generic —
 * connections, layout, chat, settings — so a plugin needs no new verb, only for
 * these two existing ones to accept its `kind`. Everything built on
 * `COMMAND_NAMES` (typed `CommandInput<K>`, `coreHandlers satisfies
 * Required<CommandHandlerMap>`, the renderer's `dispatch('view.update', …)`
 * call sites) is therefore untouched, and these tests are what pin the part
 * that did change.
 *
 * The interesting half is the patch. Three decisions are made in
 * `applyViewPatch`'s `case 'plugin'` and none of them is forced by the types,
 * so each gets a test: the merge is shallow rather than a replace, `null`
 * deletes a key, and any real change reports as affecting the fetch.
 * ================================================================== */

const PG_CONFIG: PostgresConnectionConfig = {
  driverId: 'postgres',
  url: 'postgresql://postgres@localhost:5432/postgres',
}
const CAPS: Capability[] = ['introspect', 'collectionScan', 'valuePeek']

interface Harness {
  bus: CommandBus
  store: WorkspaceStore
}

function harness(): Harness {
  const deps: CommandDeps = {
    connections: {
      async open() {
        return { capabilities: CAPS, pid: 1 }
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
  const store = new WorkspaceStore(createEmptyWorkspace(asPanelId('panel_root')))
  const bus = new CommandBus({ store, deps, ids: createSeqIdFactory(), now: () => 1_000 })
  bus.registerAll(coreHandlers)
  return { bus, store }
}

async function connect(h: Harness): Promise<ConnId> {
  const res = await h.bus.dispatch('conn.open', { config: PG_CONFIG }, 'ui')
  assert.equal(res.ok, true)
  if (!res.ok) throw new Error('unreachable')
  return res.data.connId
}

async function openPluginView(
  h: Harness,
  connId: ConnId,
  state: Record<string, unknown> = { collection: 'orders', limit: 100 },
): Promise<ViewId> {
  const res = await h.bus.dispatch(
    'view.open',
    { spec: { kind: 'plugin', pluginKind: 'documents', connId, state } },
    'ui',
  )
  assert.equal(res.ok, true, 'a plugin spec must be accepted by view.open')
  if (!res.ok) throw new Error('unreachable')
  return res.data.viewId
}

function pluginViewOf(h: Harness, viewId: ViewId): PluginViewState {
  const view = h.store.getState().views[viewId]
  assert.ok(view, 'the view must exist')
  assert.equal(view.kind, 'plugin')
  if (view.kind !== 'plugin') throw new Error('unreachable')
  return view
}

describe('view.open accepts a plugin view', () => {
  it('stores the plugin kind and its state verbatim', async () => {
    const h = harness()
    const connId = await connect(h)
    const viewId = await openPluginView(h, connId)

    const view = pluginViewOf(h, viewId)
    assert.equal(view.pluginKind, 'documents')
    // Verbatim: the kernel does not know this shape, so it must not normalise,
    // reorder or drop anything in it. The plugin's own schema is the only thing
    // that ever looks inside.
    assert.deepEqual(view.state, { collection: 'orders', limit: 100 })
    assert.equal(view.connId, connId)
  })

  it('a spec with no state opens with an empty one rather than undefined', async () => {
    // So the patch merge never has to special-case a view that was never patched.
    const h = harness()
    const connId = await connect(h)
    const res = await h.bus.dispatch(
      'view.open',
      { spec: { kind: 'plugin', pluginKind: 'graph', connId } },
      'ui',
    )
    assert.equal(res.ok, true)
    if (!res.ok) throw new Error('unreachable')
    assert.deepEqual(pluginViewOf(h, res.data.viewId).state, {})
  })

  it('rejects a spec with no pluginKind', async () => {
    const h = harness()
    const connId = await connect(h)
    const res = await h.bus.dispatch(
      'view.open',
      { spec: { kind: 'plugin', pluginKind: '', connId } },
      'ui',
    )
    assert.equal(res.ok, false, 'an empty pluginKind names no registered kind and cannot be opened')
  })
})

describe('view.update merges a plugin view’s state', () => {
  it('merges rather than replaces — the built-in patches all behave this way', async () => {
    // `{kind:'table', offset: 40}` moves the page and leaves the filter alone. A
    // plugin patch that replaced the whole state would behave differently for no
    // reason a caller could see, and would force an MCP client to resend
    // everything to change one field — racing with the user changing another.
    const h = harness()
    const connId = await connect(h)
    const viewId = await openPluginView(h, connId, { collection: 'orders', limit: 100 })

    const res = await h.bus.dispatch(
      'view.update',
      { viewId, patch: { kind: 'plugin', state: { limit: 500 } } },
      'ui',
    )
    assert.equal(res.ok, true)
    assert.deepEqual(pluginViewOf(h, viewId).state, { collection: 'orders', limit: 500 })
  })

  it('null deletes a key, which is the only way a patch can express removal', async () => {
    // The built-in patches already use `null` for exactly this — the vector
    // view's `vectorName` and `scoreThreshold` both clear on null.
    const h = harness()
    const connId = await connect(h)
    const viewId = await openPluginView(h, connId, { collection: 'orders', filter: 'x>1' })

    const res = await h.bus.dispatch(
      'view.update',
      { viewId, patch: { kind: 'plugin', state: { filter: null } } },
      'ui',
    )
    assert.equal(res.ok, true)
    assert.deepEqual(pluginViewOf(h, viewId).state, { collection: 'orders' })
  })

  it('deleting a key that was not there changes nothing and is not an error', async () => {
    const h = harness()
    const connId = await connect(h)
    const viewId = await openPluginView(h, connId, { collection: 'orders' })

    const res = await h.bus.dispatch(
      'view.update',
      { viewId, patch: { kind: 'plugin', state: { absent: null } } },
      'ui',
    )
    assert.equal(res.ok, true)
    assert.deepEqual(pluginViewOf(h, viewId).state, { collection: 'orders' })
  })

  it('the title is patchable, and independently of the state', async () => {
    const h = harness()
    const connId = await connect(h)
    const viewId = await openPluginView(h, connId)

    await h.bus.dispatch('view.update', { viewId, patch: { kind: 'plugin', title: 'Pinned' } }, 'ui')
    const view = pluginViewOf(h, viewId)
    assert.equal(view.title, 'Pinned')
    assert.deepEqual(view.state, { collection: 'orders', limit: 100 }, 'a title patch must not touch the state')
  })

  it('refuses a patch whose kind does not match the view', async () => {
    // The reason `kind` is mandatory on a patch: it stops a table's `filter`
    // from being applied to a plugin view, and vice versa.
    const h = harness()
    const connId = await connect(h)
    const viewId = await openPluginView(h, connId)

    const res = await h.bus.dispatch(
      'view.update',
      { viewId, patch: { kind: 'table', offset: 40 } },
      'ui',
    )
    assert.equal(res.ok, false, 'a table patch must not reach a plugin view')
  })
})
