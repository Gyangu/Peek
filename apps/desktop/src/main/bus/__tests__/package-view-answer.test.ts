import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import '../../../drivers/__tests__/in-repo-registry'
import { produce } from 'immer'
import {
  asPanelId,
  asViewId,
  createEmptyWorkspace,
  type Capability,
  type ConnId,
  type PackageViewAnswer,
  type PackageViewState,
  type PackageViewStateShape,
  type PostgresConnectionConfig,
  type ViewId,
} from '@peek/core'
import { WorkspaceStore } from '../../store/workspace-store'
import { CommandBus } from '../command-bus'
import { coreHandlers, createViewHandlers, type PackageViewQuestion, type PackageViewSource } from '../handlers'
import { createSeqIdFactory } from '../ids'
import type { CommandDeps } from '../deps'
import type { EffectIntent } from '../intents'
import type { ReduceCtx } from '../types'

/* ==================================================================
 * The package view's fetch plan is fetched *before* the reduction.
 *
 * `autoFetch` used to be called inside the reducer, on package code compiled
 * into main. It now lives in that package's host process, so the answer has to
 * arrive first — design 2026-08-07 §2.4bis(e). What these tests pin is the part
 * of that move which has no compiler behind it:
 *
 *   - the reducer stays **synchronous** (acceptance item 30);
 *   - the question describes the state the patch is *about to* produce, not the
 *     one on screen — the difference between fetching the page the user asked
 *     for and the one they were already looking at;
 *   - `title` / `describe` land on the view, because `snapshotWorkspace` reads
 *     them on every patch broadcast and cannot ask another process;
 *   - a package that says nothing produces a view that opens and does not fetch,
 *     never a Command that fails.
 * ================================================================== */

const PG_CONFIG: PostgresConnectionConfig = {
  driverId: 'postgres',
  url: 'postgresql://postgres@localhost:5432/postgres',
}
const CAPS: Capability[] = ['introspect', 'collectionScan', 'tabularQuery']

const ANSWER: PackageViewAnswer = {
  fetch: { capability: 'tabularQuery', text: 'MATCH (n) RETURN n LIMIT 25' },
  title: 'orders · 25',
  describe: 'Graph of orders, 25 nodes',
}

interface Harness {
  bus: CommandBus
  store: WorkspaceStore
  /** Every question the handlers asked, in order. */
  asked: PackageViewQuestion[]
  queries: string[]
}

function harness(answer: PackageViewAnswer | null = ANSWER): Harness {
  const asked: PackageViewQuestion[] = []
  const queries: string[] = []
  const deps: CommandDeps = {
    connections: {
      async open() {
        return { capabilities: CAPS, pid: 1 }
      },
      async close() {},
    },
    results: {
      async runQuery(req) {
        queries.push(req.text)
      },
      async scanCollection() {},
      async vectorSearch() {},
      async cancel() {
        return true
      },
    },
  }
  const source: PackageViewSource = {
    async answer(question) {
      asked.push(question)
      return answer
    },
  }
  const store = new WorkspaceStore(createEmptyWorkspace(asPanelId('panel_root')))
  const bus = new CommandBus({ store, deps, ids: createSeqIdFactory(), now: () => 1_000 })
  bus.registerAll(coreHandlers)
  bus.registerAll(createViewHandlers(source))
  return { bus, store, asked, queries }
}

async function connect(h: Harness): Promise<ConnId> {
  const res = await h.bus.dispatch('conn.open', { config: PG_CONFIG }, 'ui')
  assert.equal(res.ok, true)
  if (!res.ok) throw new Error('unreachable')
  return res.data.connId
}

async function openGraph(h: Harness, connId: ConnId, state: Record<string, unknown>): Promise<ViewId> {
  const res = await h.bus.dispatch('view.open', { spec: { kind: 'package', packageKind: 'graph', connId, state } }, 'ui')
  assert.equal(res.ok, true)
  if (!res.ok) throw new Error('unreachable')
  return res.data.viewId
}

function graphView(h: Harness, viewId: ViewId): PackageViewState {
  const view = h.store.getState().views[viewId]
  assert.ok(view && view.kind === 'package')
  if (!view || view.kind !== 'package') throw new Error('unreachable')
  return view
}

describe('view.open asks the package before it reduces', () => {
  it('asks about the view it is about to create, and starts the fetch it was told to', async () => {
    const h = harness()
    const connId = await connect(h)
    const viewId = await openGraph(h, connId, { collection: 'orders' })

    assert.equal(h.asked.length, 1)
    assert.equal(h.asked[0]?.driverId, 'postgres', 'the package is routed to by the connection’s driver')
    assert.deepEqual(h.asked[0]?.view.state, { collection: 'orders' })
    assert.deepEqual(h.queries, [ANSWER.fetch?.capability === 'tabularQuery' ? ANSWER.fetch.text : ''])
    assert.equal(graphView(h, viewId).status, 'loading')
  })

  it('stores the two strings, because the snapshot cannot ask for them', async () => {
    const h = harness()
    const connId = await connect(h)
    const viewId = await openGraph(h, connId, { collection: 'orders' })

    assert.deepEqual(graphView(h, viewId).packageText, { title: ANSWER.title, describe: ANSWER.describe })
  })

  it('opens a view with no answer rather than failing the command', async () => {
    // The package is not installed, its host crashed, or it ran out of time.
    // All three are a view that does not fetch — never a refused `view.open`.
    const h = harness(null)
    const connId = await connect(h)
    const viewId = await openGraph(h, connId, { collection: 'orders' })

    assert.deepEqual(h.queries, [])
    assert.equal(graphView(h, viewId).packageText, undefined)
    assert.equal(graphView(h, viewId).status, 'idle')
  })

  it('does not ask about a built-in view', async () => {
    const h = harness()
    const connId = await connect(h)
    await h.bus.dispatch(
      'view.open',
      { spec: { kind: 'table', connId, ref: { kind: 'relation', schema: 'public', name: 'orders' } } },
      'ui',
    )
    assert.deepEqual(h.asked, [], 'nothing about a table is a package’s business')
  })
})

describe('view.update asks about the state the patch will produce', () => {
  it('merges first, then asks — asking first would fetch the page being left', async () => {
    const h = harness()
    const connId = await connect(h)
    const viewId = await openGraph(h, connId, { collection: 'orders', page: 1 })

    await h.bus.dispatch('view.update', { viewId, patch: { kind: 'package', state: { page: 2 } } }, 'ui')

    assert.equal(h.asked.length, 2)
    assert.deepEqual(h.asked[1]?.view.state, { collection: 'orders', page: 2 })
  })

  it('honours the same null-deletes rule the reducer applies, so both see one state', async () => {
    const h = harness()
    const connId = await connect(h)
    const viewId = await openGraph(h, connId, { collection: 'orders', filter: 'x>1' })

    await h.bus.dispatch('view.update', { viewId, patch: { kind: 'package', state: { filter: null } } }, 'ui')

    assert.deepEqual(h.asked[1]?.view.state, { collection: 'orders' })
    assert.deepEqual(graphView(h, viewId).state, h.asked[1]?.view.state)
  })

  it('sends only the shape the contract declares, not the kernel’s own fields', async () => {
    // A package that started reading `resultId` or `status` would be depending on
    // fields `PackageViewStateShape` never promised it.
    const h = harness()
    const connId = await connect(h)
    const viewId = await openGraph(h, connId, { collection: 'orders' })
    await h.bus.dispatch('view.update', { viewId, patch: { kind: 'package', state: { page: 2 } } }, 'ui')

    const shape: PackageViewStateShape | undefined = h.asked[1]?.view
    assert.deepEqual(Object.keys(shape ?? {}).sort(), ['connId', 'kind', 'packageKind', 'state'])
  })

  it('a title-only patch still refreshes the text, so it cannot drift from the state', async () => {
    const h = harness()
    const connId = await connect(h)
    const viewId = await openGraph(h, connId, { collection: 'orders' })

    await h.bus.dispatch('view.update', { viewId, patch: { kind: 'package', title: 'Pinned' } }, 'ui')
    const view = graphView(h, viewId)
    assert.equal(view.title, 'Pinned', 'the caller’s title is still the caller’s')
    assert.deepEqual(view.packageText, { title: ANSWER.title, describe: ANSWER.describe })
  })

  it('keeps the last answer when a later one does not arrive', async () => {
    // Blanking a tab because a host was slow is worse than a title one patch old.
    const h = harness()
    const connId = await connect(h)
    const viewId = await openGraph(h, connId, { collection: 'orders' })
    const source: PackageViewSource = { answer: async () => null }
    h.bus.registerAll(createViewHandlers(source))

    await h.bus.dispatch('view.update', { viewId, patch: { kind: 'package', state: { page: 2 } } }, 'ui')
    assert.deepEqual(graphView(h, viewId).packageText, { title: ANSWER.title, describe: ANSWER.describe })
  })
})

describe('the reduction itself is still synchronous', () => {
  /**
   * Acceptance item 30, asserted the only way it can be: the whole design of
   * §2.4bis(e) exists so that these two functions never became `async`, and if
   * one ever did nothing would fail — the bus awaits its result either way, and
   * the Command would simply stop being atomic.
   */
  it('view.open and view.update return a result, not a promise', async () => {
    const h = harness()
    const connId = await connect(h)
    const handlers = createViewHandlers({ answer: async () => ANSWER })
    const ctx: ReduceCtx = {
      source: 'ui',
      commandId: 'cmd_test',
      now: 1_000,
      ids: createSeqIdFactory('sync'),
      plan: (_intent: EffectIntent) => {},
      prepared: { packageView: ANSWER },
    }

    let opened: unknown
    const after = produce(h.store.getState(), (draft) => {
      opened = handlers['view.open'].reduce(
        draft,
        { spec: { kind: 'package', packageKind: 'graph', connId, state: {} } },
        ctx,
      )
    })
    assert.equal(opened instanceof Promise, false, 'view.open must reduce in the tick it was called in')

    const [viewId] = Object.keys(after.views)
    assert.ok(viewId !== undefined)
    let updated: unknown
    produce(after, (draft) => {
      updated = handlers['view.update'].reduce(
        draft,
        { viewId: asViewId(viewId), patch: { kind: 'package', state: { a: 1 } } },
        ctx,
      )
    })
    assert.equal(updated instanceof Promise, false, 'view.update must reduce in the tick it was called in')
  })
})
